import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { ExtensionUIContext } from "../core/extensions/types.ts";
import type { StepHarnessVersion } from "./version.ts";

/** Public release bucket used by the Step installer when no override is set. */
export const DEFAULT_STEP_RELEASE_BASE_URL = "https://capy-public-dev.tos-cn-shanghai.volces.com/stepcli";

const UPDATE_CHECK_TIMEOUT_MS = 1_500;
const UPDATE_INSTALL_TIMEOUT_MS = 120_000;
const UPDATE_STATE_FILE = "tui-update-state.json";
const DISABLE_UPDATE_ENV_NAMES = ["STEP_HARNESS_DISABLE_UPDATE_CHECK", "STEP_CLI_DISABLE_TUI_UPDATE_CHECK"] as const;
const FORCE_UPDATE_ENV_NAMES = ["STEP_HARNESS_ENABLE_UPDATE_CHECK", "STEP_CLI_ENABLE_TUI_UPDATE_CHECK"] as const;
const USER_AGENT_UNSAFE = /[^A-Za-z0-9._+-]/g;

interface ReleaseManifest {
	version?: unknown;
}

export type StepUpdateOutcome =
	| "disabled"
	| "up-to-date"
	| "skipped-version"
	| "skipped"
	| "deferred"
	| "restarted"
	| "update-failed";

export type StepUpdateChoice = "update-now" | "skip" | "skip-until-next-version";

export interface StepUpdateInput {
	version: StepHarnessVersion;
	storageRootDir: string;
	updateCheckEnabled?: boolean;
	executablePath?: string;
	argv?: readonly string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	/** The native Pi UI facade. Supplying it avoids a second stdin decoder. */
	ui?: Pick<ExtensionUIContext, "select" | "notify">;
	/** Called after installation and before replacing/restarting the process. */
	beforeRelaunch?: () => Promise<void>;
	fetchLatestVersion?: (manifestUrl: string, userAgent: string) => Promise<string | null>;
	installUpdate?: (input: StepUpdateInstallInput) => Promise<StepUpdateInstallResult>;
	relaunchBinary?: (input: StepUpdateRelaunchInput) => Promise<void>;
	/** Test/embedding seam for callers without a TTY. */
	interactive?: boolean;
}

export interface StepUpdateInstallInput {
	executablePath: string;
	installDir: string;
	agentDir?: string;
	releaseBaseUrl: string;
	userAgent?: string;
}

export interface StepUpdateInstallResult {
	ok: boolean;
	message: string;
	relaunchedBinaryPath?: string;
}

export interface StepUpdateRelaunchInput {
	binaryPath: string;
	argv: readonly string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
}

/** Resolve the release bucket while retaining old launcher variable aliases. */
export function resolveStepReleaseBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
	return (
		env.STEP_HARNESS_RELEASE_BASE_URL?.trim() ||
		env.STEP_RELEASE_BASE_URL?.trim() ||
		env.STEP_CLI_RELEASE_BASE_URL?.trim() ||
		DEFAULT_STEP_RELEASE_BASE_URL
	).replace(/\/+$/u, "");
}

export function normalizeStepReleaseVersion(value: string): string | null {
	let normalized = value.trim().replace(/^refs\/tags\//iu, "");
	normalized = normalized.replace(/^(?:step(?:-harness)?|pi)-v/iu, "");
	normalized = normalized.replace(/^v(?=\d)/iu, "");
	return normalized ? `v${normalized}` : null;
}

export function compareStepReleaseVersions(left: string, right: string): number {
	const parsedLeft = parseReleaseVersion(left);
	const parsedRight = parseReleaseVersion(right);
	if (!parsedLeft || !parsedRight) return left.localeCompare(right);
	const length = Math.max(parsedLeft.numbers.length, parsedRight.numbers.length);
	for (let index = 0; index < length; index += 1) {
		const leftValue = parsedLeft.numbers[index] ?? 0;
		const rightValue = parsedRight.numbers[index] ?? 0;
		if (leftValue !== rightValue) return leftValue > rightValue ? 1 : -1;
	}
	if (parsedLeft.suffix === parsedRight.suffix) return 0;
	if (!parsedLeft.suffix) return 1;
	if (!parsedRight.suffix) return -1;
	return parsedLeft.suffix.localeCompare(parsedRight.suffix);
}

export function resolveStepUpdateStatePath(storageRootDir: string): string {
	return path.join(storageRootDir, UPDATE_STATE_FILE);
}

export async function readStepSkippedUpdateVersion(storageRootDir: string): Promise<string | undefined> {
	try {
		const value = JSON.parse(await readFile(resolveStepUpdateStatePath(storageRootDir), "utf8")) as {
			skippedVersion?: unknown;
		};
		return typeof value.skippedVersion === "string" && value.skippedVersion.trim()
			? value.skippedVersion.trim()
			: undefined;
	} catch {
		return undefined;
	}
}

export async function writeStepSkippedUpdateVersion(storageRootDir: string, version: string | null): Promise<void> {
	const statePath = resolveStepUpdateStatePath(storageRootDir);
	if (!version?.trim()) {
		await rm(statePath, { force: true });
		return;
	}
	await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
	await writeFile(statePath, `${JSON.stringify({ skippedVersion: version.trim() }, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
}

/**
 * Check for and optionally install a newer Step binary.
 *
 * This function is intentionally UI-agnostic. The Step interactive mode passes
 * Pi's native selector facade, while headless callers simply receive a
 * disabled outcome. No readline or terminal data listener is installed here.
 */
export async function maybeUpdateStep(input: StepUpdateInput): Promise<StepUpdateOutcome> {
	const env = input.env ?? process.env;
	if (!shouldCheckStepUpdate(input, env)) return "disabled";

	const currentVersion = normalizeStepReleaseVersion(input.version.value);
	if (!currentVersion) return "disabled";
	const executablePath = input.executablePath ?? resolveStepExecutablePath(env);
	if (!executablePath) return "disabled";

	const releaseBaseUrl = resolveStepReleaseBaseUrl(env);
	const userAgent = buildStepUpdateUserAgent(currentVersion, env);
	const latestVersion =
		(await (input.fetchLatestVersion ?? fetchLatestStepVersion)(`${releaseBaseUrl}/latest.json`, userAgent)) ?? null;
	if (!latestVersion || compareStepReleaseVersions(latestVersion, currentVersion) <= 0) return "up-to-date";

	const skippedVersion = await readStepSkippedUpdateVersion(input.storageRootDir);
	if (skippedVersion === latestVersion) return "skipped-version";

	const installDir = path.dirname(executablePath);
	const choice = await chooseStepUpdate(input, currentVersion, latestVersion, installDir);
	if (choice === "skip") return "skipped";
	if (choice === "skip-until-next-version") {
		await writeStepSkippedUpdateVersion(input.storageRootDir, latestVersion);
		return "deferred";
	}

	await writeStepSkippedUpdateVersion(input.storageRootDir, null);
	const result = await (input.installUpdate ?? installLatestStepRelease)({
		executablePath,
		installDir,
		agentDir: resolveStepAgentDirForUpdate(env),
		releaseBaseUrl,
		userAgent,
	});
	input.ui?.notify(result.ok ? result.message : `Step update failed: ${result.message}`, result.ok ? "info" : "error");
	if (!result.ok) return "update-failed";

	await input.beforeRelaunch?.();
	const binaryPath =
		result.relaunchedBinaryPath ?? path.join(installDir, process.platform === "win32" ? "step.exe" : "step");
	await (input.relaunchBinary ?? relaunchStepBinary)({
		binaryPath,
		argv: input.argv ?? process.argv.slice(2),
		cwd: input.cwd ?? process.cwd(),
		env,
	});
	return "restarted";
}

function shouldCheckStepUpdate(input: StepUpdateInput, env: NodeJS.ProcessEnv): boolean {
	if (input.updateCheckEnabled === false) return false;
	if (DISABLE_UPDATE_ENV_NAMES.some((name) => readBooleanEnv(env[name]))) return false;
	const interactive = input.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
	if (!interactive || !input.ui) return false;
	if (FORCE_UPDATE_ENV_NAMES.some((name) => readBooleanEnv(env[name]))) return true;
	return input.version.source !== "fallback";
}

async function chooseStepUpdate(
	input: StepUpdateInput,
	currentVersion: string,
	latestVersion: string,
	installDir: string,
): Promise<StepUpdateChoice> {
	const options = [`Update now (${formatHomeRelativePath(installDir)})`, "Skip", "Skip until next version"] as const;
	const selected = await input.ui!.select(`Update available\n${currentVersion} -> ${latestVersion}`, [...options]);
	if (selected === options[0]) return "update-now";
	if (selected === options[2]) return "skip-until-next-version";
	return "skip";
}

async function fetchLatestStepVersion(manifestUrl: string, userAgent: string): Promise<string | null> {
	try {
		const response = await fetch(manifestUrl, {
			signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
			headers: { "user-agent": userAgent },
		});
		if (!response.ok) return null;
		const payload = (await response.json()) as ReleaseManifest;
		return typeof payload.version === "string" ? normalizeStepReleaseVersion(payload.version) : null;
	} catch {
		return null;
	}
}

export function buildStepUpdateUserAgent(version: string, env: NodeJS.ProcessEnv = process.env): string {
	const clean = (value: string, fallback: string): string =>
		value.replace(USER_AGENT_UNSAFE, "").slice(0, 32) || fallback;
	const channel = env.STEP_HARNESS_BUILD_CHANNEL ?? env.STEP_CLI_BUILD_CHANNEL ?? "unknown";
	return `step-harness/${clean(version, "unknown")} (${clean(channel, "unknown")}; ${clean(process.platform, "unknown")}; ${clean(process.arch, "unknown")})`;
}

export function resolveStepExecutablePath(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const override = env.STEP_HARNESS_BINARY_PATH?.trim() || env.STEP_CLI_BINARY_PATH?.trim();
	if (override) return path.resolve(override);
	const candidates = [process.execPath, process.argv[1]];
	for (const candidate of candidates) {
		if (!candidate) continue;
		const name = path.basename(candidate).toLowerCase();
		if (name === "step" || name === "step.exe" || name === "step-harness" || name === "step-harness.exe") {
			return path.resolve(candidate);
		}
	}
	return undefined;
}

function resolveStepAgentDirForUpdate(env: NodeJS.ProcessEnv): string | undefined {
	return env.STEP_HARNESS_CODING_AGENT_DIR?.trim() || env.STEP_CODING_AGENT_DIR?.trim();
}

export function resolveStepUpdateInstallerSpec(platform: NodeJS.Platform = process.platform): {
	scriptName: "install.sh" | "install.ps1";
	command: string;
	buildArgs: (scriptPath: string, installDir: string) => string[];
} {
	if (platform === "win32") {
		return {
			scriptName: "install.ps1",
			command: "powershell",
			buildArgs: (scriptPath, installDir) => [
				"-NoProfile",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				scriptPath,
				"-Version",
				"latest",
				"-InstallDir",
				installDir,
			],
		};
	}
	return {
		scriptName: "install.sh",
		command: "bash",
		buildArgs: (scriptPath, installDir) => [scriptPath, "--version", "latest", "--install-dir", installDir],
	};
}

async function installLatestStepRelease(input: StepUpdateInstallInput): Promise<StepUpdateInstallResult> {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "step-harness-update-"));
	const installer = resolveStepUpdateInstallerSpec();
	const scriptPath = path.join(tempRoot, installer.scriptName);
	try {
		const response = await fetch(`${input.releaseBaseUrl}/${installer.scriptName}`, {
			signal: AbortSignal.timeout(UPDATE_INSTALL_TIMEOUT_MS),
			headers: input.userAgent ? { "user-agent": input.userAgent } : undefined,
		});
		if (!response.ok)
			return { ok: false, message: `failed to download ${installer.scriptName} (${response.status})` };
		await writeFile(scriptPath, await response.text(), { encoding: "utf8", mode: 0o755 });
		const code = await runCommand(installer.command, installer.buildArgs(scriptPath, input.installDir), {
			...process.env,
			STEP_RELEASE_BASE_URL: input.releaseBaseUrl,
			STEP_VERSION: "latest",
			STEP_INSTALL_DIR: input.installDir,
			...(input.agentDir ? { STEP_HARNESS_CODING_AGENT_DIR: input.agentDir } : {}),
		});
		if (code !== 0) return { ok: false, message: `${installer.scriptName} exited with code ${code}` };
		return {
			ok: true,
			message: `Updated Step in ${formatHomeRelativePath(input.installDir)}; restarting.`,
			relaunchedBinaryPath: path.join(input.installDir, process.platform === "win32" ? "step.exe" : "step"),
		};
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
}

function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { env, stdio: "inherit" });
		child.once("error", reject);
		child.once("exit", (code) => resolve(code ?? 1));
	});
}

async function relaunchStepBinary(input: StepUpdateRelaunchInput): Promise<void> {
	const processWithExecve = process as NodeJS.Process & {
		execve?: (file: string, args: string[], env: NodeJS.ProcessEnv) => void;
	};
	if (typeof processWithExecve.execve === "function") {
		processWithExecve.execve(input.binaryPath, [input.binaryPath, ...input.argv], input.env);
		return;
	}
	await new Promise<void>((resolve, reject) => {
		const child = spawn(input.binaryPath, [...input.argv], { cwd: input.cwd, env: input.env, stdio: "inherit" });
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (signal) reject(new Error(`updated Step exited with signal ${signal}`));
			else if ((code ?? 0) !== 0) reject(new Error(`updated Step exited with code ${code ?? 1}`));
			else resolve();
		});
	});
}

function formatHomeRelativePath(value: string): string {
	const home = os.homedir();
	if (value === home) return "~";
	if (value.startsWith(`${home}${path.sep}`)) return `~${path.sep}${value.slice(home.length + 1)}`;
	return value;
}

function parseReleaseVersion(value: string): { numbers: number[]; suffix: string } | null {
	const normalized = normalizeStepReleaseVersion(value);
	if (!normalized) return null;
	const match = /^v(\d+(?:\.\d+)*)(.*)$/u.exec(normalized);
	if (!match) return null;
	return {
		numbers: match[1].split(".").map((part) => Number.parseInt(part, 10)),
		suffix: match[2] ?? "",
	};
}

function readBooleanEnv(value: string | undefined): boolean {
	return value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
