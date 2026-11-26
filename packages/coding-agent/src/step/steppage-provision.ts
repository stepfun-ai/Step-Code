import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import lockfile from "proper-lockfile";
import { resolveStepHomeDir } from "./environment.ts";
import type { StepPluginProvision } from "./plugins.ts";

const execFileAsync = promisify(execFile);
export const DEFAULT_STEPPAGE_INSTALLER_URL = "https://dl.stepfun.com/steppage-mcp/p/install.sh";

export interface StepPageReadiness {
	command?: string;
	error?: string;
	installed: boolean;
}

export function stepPageInstallerUrl(env: NodeJS.ProcessEnv = process.env): string {
	return env.STEPCODE_STEPPAGE_INSTALLER_URL?.trim() || DEFAULT_STEPPAGE_INSTALLER_URL;
}

/**
 * The published bundle the installer writes next to its wrapper. Derived from the
 * installer URL so a channel or mirror override covers both artifacts.
 */
export function stepPageBundleUrl(env: NodeJS.ProcessEnv = process.env): string {
	const url = new URL(stepPageInstallerUrl(env));
	url.pathname = `${url.pathname.replace(/\/[^/]*$/u, "")}/latest/steppage-mcp.mjs`;
	return url.href;
}

/**
 * Probe order for an existing executable: PATH first, then the managed install.
 * Windows probes the `.cmd` wrapper because the bundle is a bare ESM file.
 *
 * On Windows, `cmd` searches the current directory before PATH, so a bare name
 * could execute a project-controlled `steppage-mcp.cmd`. Windows candidates are
 * therefore resolved to absolute files from absolute PATH entries only.
 */
export function stepPageCommandCandidates(
	platform: NodeJS.Platform,
	homeDir: string,
	pathValue?: string,
	fileExists: (path: string) => boolean = existsSync,
): string[] {
	const managed = join(homeDir, ".local", "bin", "steppage-mcp");
	if (platform !== "win32") return ["steppage-mcp", managed];
	const candidates: string[] = [];
	for (const entry of absoluteWindowsPathEntries(pathValue)) {
		for (const extension of [".cmd", ".exe", ".bat"]) {
			const candidate = join(entry, `steppage-mcp${extension}`);
			if (!candidates.includes(candidate) && fileExists(candidate)) candidates.push(candidate);
		}
	}
	if (!candidates.includes(`${managed}.cmd`)) candidates.push(`${managed}.cmd`);
	return candidates;
}

/** Relative PATH entries (including ".") resolve against the working directory, so they are skipped. */
function absoluteWindowsPathEntries(pathValue: string | undefined): string[] {
	const entries: string[] = [];
	for (const rawEntry of (pathValue ?? "").split(";")) {
		const entry = rawEntry.trim().replace(/^"(.*)"$/u, "$1");
		if (entry && (win32.isAbsolute(entry) || isAbsolute(entry))) entries.push(entry);
	}
	return entries;
}

/** Resolve a Windows executable without letting the process search the working directory. */
function resolveWindowsExecutable(
	executable: string,
	pathValue: string | undefined,
	fileExists: (path: string) => boolean = existsSync,
): string | undefined {
	for (const entry of absoluteWindowsPathEntries(pathValue)) {
		const candidate = join(entry, executable);
		if (fileExists(candidate)) return candidate;
	}
	return undefined;
}

/**
 * The Node.js executable that checks the runtime and runs the bundle. On Windows
 * `cmd` searches the working directory before PATH, so a bare `node` in the
 * wrapper could run a project-controlled `node.cmd`; `node.exe` is resolved from
 * absolute PATH entries instead. `process.execPath` is deliberately not used: in
 * the standalone binary it is Step itself, not Node.js.
 */
export function resolveNodeExecutable(
	platform: NodeJS.Platform,
	pathValue?: string,
	fileExists: (path: string) => boolean = existsSync,
): string | undefined {
	if (platform !== "win32") return "node";
	return resolveWindowsExecutable("node.exe", pathValue, fileExists);
}

function pathValueOf(env: NodeJS.ProcessEnv): string | undefined {
	const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH");
	return key ? env[key] : undefined;
}

/**
 * The Windows wrapper installed next to the bundle; a bare ESM file must run via
 * node, named by the absolute path that passed the runtime check. `%` is doubled
 * so a path cannot expand a variable inside the batch file.
 */
export function renderStepPageWrapper(nodePath: string, bundlePath: string): string {
	const quote = (path: string) => `"${path.replaceAll("%", "%%")}"`;
	return `@echo off\r\n${quote(nodePath)} ${quote(bundlePath)} %*\r\n`;
}

const SECRET_PARAMETER = /token|key|secret|passw(?:or)?d|pwd|auth|credential|signature|sig$|session/iu;

function redactUrl(url: string): string {
	const trailingQuotes = /['"]*$/u.exec(url)?.[0] ?? "";
	const target = url.slice(0, url.length - trailingQuotes.length);
	return `${target
		.replace(/^([a-z][a-z\d+.-]*:\/\/)[^/?#\s]*@/iu, "$1[redacted]@")
		.replace(/([?&;#])([^=&;#]+)=([^&;#]*)/gu, (match, separator: string, name: string, value: string) => {
			let decoded = name;
			try {
				decoded = decodeURIComponent(name);
			} catch {}
			return value && SECRET_PARAMETER.test(decoded) ? `${separator}${name}=[redacted]` : match;
		})}${trailingQuotes}`;
}

/**
 * Remove credentials from text shown to the user: URL userinfo, secret-looking
 * query or fragment parameters, and the values of secret-named environment
 * variables. Applied to the complete message, so a mirror URL is covered whether
 * it came from a curl error or from the manual install hint.
 */
export function redactStepPageSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
	let redacted = text.replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s<>`]+/giu, redactUrl);
	for (const [key, value] of Object.entries(env)) {
		if (value && value.length >= 4 && /key|token|secret|password|authorization/iu.test(key))
			redacted = redacted.replaceAll(value, "[redacted]");
	}
	return redacted;
}

/** Default executable ownership may survive in an old global declaration. */
export function isManagedStepPageCommand(
	declaration: { command?: unknown; args?: unknown },
	provision?: StepPluginProvision,
): boolean {
	return (
		typeof declaration.command === "string" &&
		declaration.command.trim() === "steppage-mcp" &&
		(!Array.isArray(declaration.args) || declaration.args.length === 0) &&
		provision?.command === "steppage-mcp" &&
		provision.installer === "steppageInstaller"
	);
}

/** Keep the lock until the installer and its children stop writing files. */
async function runInstaller(script: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
	signal.throwIfAborted();
	await new Promise<void>((resolve, reject) => {
		const child = spawn("sh", ["-c", script], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		let failure: Error | undefined;
		let stderr = "";
		const stop = (error: Error) => {
			failure ??= error;
			if (child.pid) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			}
		};
		const abort = () => stop(new Error("StepPage installation was cancelled."));
		const timer = setTimeout(() => stop(new Error("StepPage installation timed out.")), 120_000);
		const cleanup = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
		};
		child.stdout.resume();
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = `${stderr}${chunk.toString()}`.slice(-8_192);
		});
		child.on("error", (error) => {
			cleanup();
			reject(error);
		});
		child.on("close", (code) => {
			cleanup();
			if (failure) reject(failure);
			else if (code !== 0) reject(new Error(`StepPage installer exited with ${code}: ${stderr.trim()}`));
			else resolve();
		});
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
	});
}

/** On Windows every candidate is an absolute file; `cmd /c` runs `.cmd` wrappers on every Node runtime. */
async function probeStepPageVersion(
	command: string,
	env: NodeJS.ProcessEnv,
	signal: AbortSignal | undefined,
	platform: NodeJS.Platform,
): Promise<string | undefined> {
	const file = platform === "win32" ? resolveWindowsExecutable("cmd.exe", pathValueOf(env)) : command;
	if (!file) return undefined;
	// Only the fixed wrapper basename enters cmd parsing; metacharacters in its directory stay in cwd.
	const args = platform === "win32" ? ["/d", "/c", basename(command), "--version"] : ["--version"];
	try {
		const result = await execFileAsync(file, args, {
			env,
			signal,
			timeout: 5_000,
			maxBuffer: 8_192,
			...(platform === "win32" ? { cwd: dirname(command) } : {}),
		});
		const version = result.stdout.trim();
		if (/^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(version)) return version;
	} catch {
		signal?.throwIfAborted();
	}
	return undefined;
}

/** Only probes executables; never starts an MCP session or requires login. */
async function findHealthyStepPage(
	env: NodeJS.ProcessEnv,
	signal?: AbortSignal,
	platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
	for (const command of stepPageCommandCandidates(platform, resolveStepHomeDir(env), pathValueOf(env))) {
		signal?.throwIfAborted();
		if (await probeStepPageVersion(command, env, signal, platform)) return command;
	}
	return undefined;
}

/** Returns the Node.js executable that passed the check, for the wrapper to reuse. */
async function assertNodeRuntime(
	env: NodeJS.ProcessEnv,
	signal: AbortSignal,
	platform: NodeJS.Platform,
): Promise<string> {
	const node = resolveNodeExecutable(platform, pathValueOf(env));
	if (!node) throw new Error("Node.js >= 20 is required for StepPage; node.exe was not found on PATH.");
	let nodeVersion: string;
	try {
		nodeVersion = (await execFileAsync(node, ["--version"], { env, signal, timeout: 5_000 })).stdout.trim();
	} catch {
		signal.throwIfAborted();
		throw new Error("Node.js >= 20 is required for StepPage; install Node.js and retry.");
	}
	const major = /^v(\d+)\./u.exec(nodeVersion)?.[1];
	if (!major || Number(major) < 20) throw new Error(`Node.js >= 20 is required for StepPage; found ${nodeVersion}.`);
	return node;
}

/**
 * Windows cannot run the POSIX installer script, so install the published bundle
 * directly: download it, then write the `cmd` wrapper the bundle needs to run.
 */
async function installStepPageOnWindows(env: NodeJS.ProcessEnv, signal: AbortSignal, nodePath: string): Promise<void> {
	const pathValue = pathValueOf(env);
	// The post-install probe needs cmd.exe. Check it and curl before downloading anything.
	if (!resolveWindowsExecutable("cmd.exe", pathValue)) {
		throw new Error("StepPage requires cmd.exe on an absolute PATH entry.");
	}
	const curl = resolveWindowsExecutable("curl.exe", pathValue);
	if (!curl) throw new Error("StepPage requires curl.exe on an absolute PATH entry.");
	const home = resolveStepHomeDir(env);
	const bundleDir = join(home, ".steppage-mcp", "bin");
	const bundlePath = join(bundleDir, "steppage-mcp.mjs");
	const wrapperPath = join(home, ".local", "bin", "steppage-mcp.cmd");
	await mkdir(bundleDir, { recursive: true, mode: 0o700 });
	await mkdir(join(home, ".local", "bin"), { recursive: true });
	// Download before writing the wrapper so a failed transfer cannot hide behind a stale one.
	await execFileAsync(curl, ["-fsSL", "--max-time", "30", stepPageBundleUrl(env), "-o", bundlePath], {
		env,
		signal,
		timeout: 35_000,
		maxBuffer: 8_192,
	});
	await writeFile(wrapperPath, renderStepPageWrapper(nodePath, bundlePath));
}

/** Repair the managed executable without changing plugin manifests or credentials. */
export async function ensureStepPageReady(
	input: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; platform?: NodeJS.Platform } = {},
): Promise<StepPageReadiness> {
	const env = input.env ?? process.env;
	const platform = input.platform ?? process.platform;
	const compromised = new AbortController();
	const signal = AbortSignal.any([compromised.signal, ...(input.signal ? [input.signal] : [])]);
	signal?.throwIfAborted();
	const healthy = await findHealthyStepPage(env, signal, platform);
	if (healthy) return { command: healthy, installed: false };
	let release: (() => Promise<void>) | undefined;
	try {
		const directory = join(resolveStepHomeDir(env), ".steppage-mcp");
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const deadline = Date.now() + 130_000;
		while (!release) {
			signal?.throwIfAborted();
			try {
				release = await lockfile.lock(join(directory, ".stepcode-provision"), {
					realpath: false,
					stale: 150_000,
					update: 10_000,
					onCompromised: (error) => compromised.abort(error),
				});
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ELOCKED") || Date.now() >= deadline)
					throw error;
				await delay(100, undefined, { signal });
			}
		}
		// Another Step process may have completed installation while we waited.
		const available = await findHealthyStepPage(env, signal, platform);
		if (available) return { command: available, installed: false };
		const nodePath = await assertNodeRuntime(env, signal, platform);
		if (platform === "win32") await installStepPageOnWindows(env, signal, nodePath);
		else {
			// Download before executing so a failed curl cannot be hidden by `| sh`.
			const script = await execFileAsync("curl", ["-fsSL", "--max-time", "30", stepPageInstallerUrl(env)], {
				env,
				signal,
				timeout: 35_000,
				maxBuffer: 1_000_000,
			});
			if (!script.stdout.trim()) throw new Error("The StepPage installer download was empty.");
			await runInstaller(script.stdout, env, signal);
		}
		const command = await findHealthyStepPage(env, signal, platform);
		if (!command) throw new Error("The StepPage installer completed, but steppage-mcp failed its version check.");
		return { command, installed: true };
	} catch (error) {
		input.signal?.throwIfAborted();
		// Redact before truncating: a cut could drop the scheme that marks a URL.
		const detail = redactStepPageSecrets(error instanceof Error ? error.message : String(error), env);
		const installer = `curl -fsSL '${stepPageInstallerUrl(env).replace(/'/gu, "'\\''")}' | sh`;
		const manual =
			platform === "win32"
				? "You can also run: step mcp prepare, then restart Step."
				: `Install it with: ${installer}, then restart Step. You can also run: step mcp prepare, then restart Step.`;
		return {
			installed: false,
			error: redactStepPageSecrets(
				`StepPage is not ready: ${detail.slice(-2_000)} Step remains usable; StepPage setup will retry on the next launch. ${manual}`,
				env,
			),
		};
	} finally {
		await release?.().catch(() => undefined);
	}
}
