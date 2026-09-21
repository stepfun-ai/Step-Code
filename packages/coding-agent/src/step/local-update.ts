import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import lockfile from "proper-lockfile";
import type { ExtensionUIContext } from "../core/extensions/types.ts";
import { spawnProcess, waitForChildProcess } from "../utils/child-process.ts";
import { STEPCODE_VERSION, type StepCodeVersion } from "./version.ts";

/** Public release bucket used by the Step installer when no override is set. */
export const DEFAULT_STEP_RELEASE_BASE_URL = "https://static-openapi.stepfun.com/stepcode";

const UPDATE_CHECK_TIMEOUT_MS = 1_500;
const UPDATE_INSTALL_TIMEOUT_MS = 120_000;
const UPDATE_STATE_FILE = "tui-update-state.json";
const DISABLE_UPDATE_ENV_NAMES = ["STEPCODE_DISABLE_UPDATE_CHECK", "STEPCODE_DISABLE_TUI_UPDATE_CHECK"] as const;
const FORCE_UPDATE_ENV_NAMES = ["STEPCODE_ENABLE_UPDATE_CHECK", "STEPCODE_ENABLE_TUI_UPDATE_CHECK"] as const;
const USER_AGENT_UNSAFE = /[^A-Za-z0-9._+-]/g;

interface ReleaseManifest {
	version?: unknown;
	packages?: Record<string, unknown>;
	checksums?: Record<string, unknown>;
}

const STEP_UPDATE_TARGETS = [
	"native",
	"theme",
	"assets",
	"export-html",
	"docs",
	"examples",
	"node_modules",
	"package.json",
	"README.md",
	"photon_rs_bg.wasm",
] as const;

export interface StepUpdateCommandInput {
	version?: string;
	env?: NodeJS.ProcessEnv;
	executablePath?: string;
	fetchImpl?: typeof fetch;
}

export async function runStepUpdateCommand(input: StepUpdateCommandInput = {}): Promise<number> {
	const env = input.env ?? process.env;
	const executablePath = await resolveUpdateExecutablePath(input.executablePath, env);
	if (!executablePath) {
		process.stderr.write("This installation is not a standalone Step binary and cannot self-update.\n");
		process.stderr.write("Re-run the Step installer or update the package/source that provides this command.\n");
		return 1;
	}
	const currentVersion = normalizeStepStableVersion(STEPCODE_VERSION.value);
	if (!currentVersion) {
		process.stderr.write(`Cannot determine the current Step version (${STEPCODE_VERSION.value}).\n`);
		return 1;
	}
	const releaseBaseUrl = resolveStepReleaseBaseUrl(env);
	const target = input.version ? normalizeStepStableVersion(input.version) : undefined;
	if (input.version && !target) {
		process.stderr.write(`Invalid Step release version "${input.version}". Expected MAJOR.MINOR.PATCH.\n`);
		return 1;
	}
	const targetVersion =
		target ?? (await fetchManifest(`${releaseBaseUrl}/latest.json`, input.fetchImpl ?? fetch))?.version;
	if (!targetVersion) {
		process.stderr.write("Could not resolve the latest Step release.\n");
		return 1;
	}
	if (!target && compareStepReleaseVersions(targetVersion, `v${currentVersion}`) <= 0) {
		process.stdout.write(`Step is already up to date (${currentVersion}).\n`);
		return 0;
	}
	if (target === currentVersion) {
		process.stdout.write(`Step is already at version ${currentVersion}.\n`);
		return 0;
	}

	const manifestUrl = `${releaseBaseUrl}/${targetVersion}/manifest.json`;
	const manifest = await fetchManifest(manifestUrl, input.fetchImpl ?? fetch);
	if (!manifest) {
		process.stderr.write(`Could not fetch Step release ${targetVersion}.\n`);
		return 1;
	}
	const artifact = resolveReleaseArtifact(manifest, targetVersion);
	if (!artifact) {
		process.stderr.write(`Step release ${targetVersion} has no package for ${resolveStepTargetId()}.\n`);
		return 1;
	}
	const installDir = path.dirname(executablePath);
	await mkdir(installDir, { recursive: true });
	let releaseLock: () => Promise<void>;
	try {
		releaseLock = await lockfile.lock(executablePath, { realpath: false });
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ELOCKED") {
			process.stderr.write("Another Step update is already running.\n");
			return 1;
		}
		process.stderr.write(
			`Could not lock the Step installation: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		return 1;
	}
	let tempRoot: string | undefined;
	try {
		tempRoot = await mkdtemp(path.join(os.tmpdir(), "stepcode-update-"));
		const archivePath = path.join(tempRoot, artifact.fileName);
		const archiveResponse = await fetchWithTimeout(artifact.url, input.fetchImpl ?? fetch);
		if (!archiveResponse.ok) throw new Error(`archive download failed (HTTP ${archiveResponse.status})`);
		await writeFile(archivePath, Buffer.from(await archiveResponse.arrayBuffer()));
		const actualChecksum = createHash("sha256")
			.update(await readFile(archivePath))
			.digest("hex");
		if (actualChecksum !== artifact.checksum) throw new Error("archive checksum verification failed");
		const extractDir = path.join(tempRoot, "extract");
		await mkdir(extractDir);
		const extractCode = await extractArchive(archivePath, extractDir);
		if (extractCode !== 0) throw new Error("could not extract the release archive");
		const archiveRoot = await findArchiveRoot(extractDir);
		const binaryName = process.platform === "win32" ? "step.exe" : "step";
		const stagedBinary = await findFile(archiveRoot, binaryName);
		if (!stagedBinary) throw new Error("release archive does not contain the Step binary");
		const smoke = await verifyBinary(stagedBinary, targetVersion);
		if (!smoke.ok) throw new Error(smoke.message);
		await replaceInstallation(installDir, stagedBinary, archiveRoot, binaryName, tempRoot);
		process.stdout.write(`Updated Step from ${currentVersion} to ${targetVersion}.\n`);
		return 0;
	} catch (error) {
		process.stderr.write(`Step update failed: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	} finally {
		// Best-effort cleanup: on Windows the backup dir holds the still-running
		// old binary, so deleting it throws EBUSY (which force:true does not
		// suppress). Never let cleanup override the update result or skip the
		// lock release.
		if (tempRoot) await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
		await releaseLock().catch(() => {});
	}
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
	version: StepCodeVersion;
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
		env.STEP_RELEASE_BASE_URL?.trim() ||
		env.STEPCODE_RELEASE_BASE_URL?.trim() ||
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
	const channel = env.STEPCODE_BUILD_CHANNEL ?? "unknown";
	return `stepcode/${clean(version, "unknown")} (${clean(channel, "unknown")}; ${clean(process.platform, "unknown")}; ${clean(process.arch, "unknown")})`;
}

export function resolveStepExecutablePath(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const override = env.STEPCODE_BINARY_PATH?.trim();
	if (override) return path.resolve(override);
	const candidates = [process.execPath, process.argv[1]];
	for (const candidate of candidates) {
		if (!candidate) continue;
		const name = path.basename(candidate).toLowerCase();
		if (name === "step" || name === "step.exe") {
			return path.resolve(candidate);
		}
	}
	return undefined;
}

function resolveStepAgentDirForUpdate(env: NodeJS.ProcessEnv): string | undefined {
	return env.STEP_CODING_AGENT_DIR?.trim();
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
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "stepcode-update-"));
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
			...(input.agentDir ? { STEP_CODING_AGENT_DIR: input.agentDir } : {}),
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

export function normalizeStepStableVersion(value: string): string | null {
	const normalized = normalizeStepReleaseVersion(value);
	return normalized && /^v\d+\.\d+\.\d+$/u.test(normalized) ? normalized.slice(1) : null;
}

async function resolveUpdateExecutablePath(
	explicit: string | undefined,
	env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
	const candidate = explicit ?? resolveStepExecutablePath(env);
	if (!candidate) return undefined;
	try {
		await access(candidate);
		return await realpath(candidate);
	} catch {
		return undefined;
	}
}

async function fetchWithTimeout(url: string, fetchImpl: typeof fetch): Promise<Response> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const response = await fetchImpl(url, { signal: AbortSignal.timeout(UPDATE_INSTALL_TIMEOUT_MS) });
			if (response.ok || response.status < 500 || attempt === 1) return response;
		} catch (error) {
			lastError = error;
			if (attempt === 1) throw error;
		}
	}
	throw lastError instanceof Error ? lastError : new Error("request failed");
}

async function fetchManifest(
	url: string,
	fetchImpl: typeof fetch,
): Promise<{ version: string; manifest: ReleaseManifest } | null> {
	try {
		const response = await fetchWithTimeout(url, fetchImpl);
		if (!response.ok) return null;
		const manifest = (await response.json()) as ReleaseManifest;
		const version = typeof manifest.version === "string" ? normalizeStepStableVersion(manifest.version) : null;
		return version ? { version, manifest } : null;
	} catch {
		return null;
	}
}

function resolveStepTargetId(): string {
	const osName =
		process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : process.platform;
	const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : process.arch;
	return `${osName}-${arch}`;
}

function resolveReleaseArtifact(
	result: { version: string; manifest: ReleaseManifest },
	targetVersion: string,
): { url: string; checksum: string; fileName: string } | null {
	const targetId = resolveStepTargetId();
	const packages = result.manifest.packages;
	const checksums = result.manifest.checksums;
	const url = packages && typeof packages[targetId] === "string" ? packages[targetId] : undefined;
	const checksum = checksums && typeof checksums[targetId] === "string" ? checksums[targetId] : undefined;
	if (!url || !checksum || !/^[a-f0-9]{64}$/iu.test(checksum) || result.version !== targetVersion) return null;
	try {
		return { url, checksum: checksum.toLowerCase(), fileName: path.basename(new URL(url).pathname) };
	} catch {
		return null;
	}
}

async function extractArchive(archivePath: string, extractDir: string): Promise<number | null> {
	if (archivePath.endsWith(".zip")) {
		return waitForChildProcess(
			spawnProcess(
				"powershell",
				[
					"-NoProfile",
					"-Command",
					`Expand-Archive -LiteralPath '${archivePath.replaceAll("'", "''")}' -DestinationPath '${extractDir.replaceAll("'", "''")}' -Force`,
				],
				{ stdio: "inherit" },
			),
		);
	}
	return waitForChildProcess(spawnProcess("tar", ["-xzf", archivePath, "-C", extractDir], { stdio: "inherit" }));
}

async function findArchiveRoot(extractDir: string): Promise<string> {
	const entries = await readdir(extractDir, { withFileTypes: true });
	const directory = entries.find((entry) => entry.isDirectory());
	return directory ? path.join(extractDir, directory.name) : extractDir;
}

async function findFile(root: string, fileName: string): Promise<string | undefined> {
	const entries = await readdir(root, { withFileTypes: true });
	for (const entry of entries) {
		const candidate = path.join(root, entry.name);
		if (entry.isFile() && entry.name === fileName) return candidate;
		if (entry.isDirectory()) {
			const nested = await findFile(candidate, fileName);
			if (nested) return nested;
		}
	}
	return undefined;
}

async function verifyBinary(binaryPath: string, expectedVersion: string): Promise<{ ok: boolean; message: string }> {
	const result = await new Promise<{ code: number | null; stderr: string; stdout: string }>((resolve, reject) => {
		const child = spawn(binaryPath, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.once("error", reject);
		child.once("exit", (code) => resolve({ code, stderr, stdout }));
	});
	if (result.code !== 0)
		return { ok: false, message: `new Step binary failed smoke test: ${result.stderr.trim() || result.code}` };
	if (normalizeStepStableVersion(result.stdout.trim()) !== expectedVersion) {
		return {
			ok: false,
			message: `new Step binary reported version ${result.stdout.trim()}; expected ${expectedVersion}`,
		};
	}
	return { ok: true, message: "ok" };
}

async function replaceInstallation(
	installDir: string,
	stagedBinary: string,
	archiveRoot: string,
	binaryName: string,
	tempRoot: string,
): Promise<void> {
	const backupDir = path.join(tempRoot, "backup");
	await mkdir(backupDir);
	const names = [binaryName, ...STEP_UPDATE_TARGETS];
	const backedUp: string[] = [];
	const installed: string[] = [];
	try {
		for (const name of names) {
			const target = path.join(installDir, name);
			const source = name === binaryName ? stagedBinary : path.join(archiveRoot, name);
			try {
				await access(source);
			} catch {
				continue;
			}
			try {
				await rename(target, path.join(backupDir, name));
				backedUp.push(name);
			} catch {
				// Target may not exist on a first install/update.
			}
			await cp(source, target, { recursive: true, force: true });
			installed.push(name);
		}
	} catch (error) {
		for (const name of installed) await rm(path.join(installDir, name), { recursive: true, force: true });
		for (const name of backedUp) await rename(path.join(backupDir, name), path.join(installDir, name));
		throw error;
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
