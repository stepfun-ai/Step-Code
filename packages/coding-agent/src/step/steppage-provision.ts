import { spawn } from "node:child_process";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { execFileText, spawnProcess } from "../utils/child-process.ts";
import { resolveStepHomeDir } from "./environment.ts";
import type { StepPluginProvision } from "./plugins.ts";

export const DEFAULT_STEPPAGE_INSTALLER_URL = "https://dl.stepfun.com/steppage-mcp/p/install.sh";

/**
 * `%~dp0` is the wrapper's own directory, so the bundle is found relative to
 * `<home>\.local\bin` without embedding a home path that cmd.exe would read in
 * the OEM code page.
 */
const WINDOWS_WRAPPER_SOURCE = '@echo off\r\nnode "%~dp0..\\..\\.steppage-mcp\\bin\\steppage-mcp.mjs" %*\r\n';

export interface StepPageReadiness {
	command?: string;
	error?: string;
	installed: boolean;
}

export function stepPageInstallerUrl(env: NodeJS.ProcessEnv = process.env): string {
	return env.STEPCODE_STEPPAGE_INSTALLER_URL?.trim() || DEFAULT_STEPPAGE_INSTALLER_URL;
}

/**
 * Windows cannot run the POSIX installer, so it downloads the same bundle the
 * installer fetches: `latest/steppage-mcp.mjs` beside `install.sh`.
 */
export function stepPageBundleUrl(env: NodeJS.ProcessEnv = process.env): string {
	return new URL("latest/steppage-mcp.mjs", stepPageInstallerUrl(env)).href;
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

/** Only probes executables; never starts an MCP session or requires login. */
async function findHealthyStepPage(
	env: NodeJS.ProcessEnv,
	signal: AbortSignal | undefined,
	platform: NodeJS.Platform,
): Promise<string | undefined> {
	if (platform === "win32") return findHealthyWindowsStepPage(env, signal);
	const managed = join(resolveStepHomeDir(env), ".local", "bin", "steppage-mcp");
	for (const command of ["steppage-mcp", managed]) {
		signal?.throwIfAborted();
		try {
			const result = await execFileText(command, ["--version"], { env, signal, timeout: 5_000, maxBuffer: 8_192 });
			if (/^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(result.stdout.trim())) return command;
		} catch {
			// A missing or broken executable is the expected "not healthy" answer.
			signal?.throwIfAborted();
		}
	}
	return undefined;
}

function windowsStepPagePaths(env: NodeJS.ProcessEnv): { bundle: string; wrapper: string } {
	const home = resolveStepHomeDir(env);
	return {
		bundle: join(home, ".steppage-mcp", "bin", "steppage-mcp.mjs"),
		wrapper: join(home, ".local", "bin", "steppage-mcp.cmd"),
	};
}

/**
 * `execFile` cannot run `.cmd` wrappers (npm shims or the managed wrapper), so
 * Windows probes through cross-spawn — the same launcher the MCP stdio
 * transport uses — and a passing probe means the transport can start it too.
 */
async function findHealthyWindowsStepPage(
	env: NodeJS.ProcessEnv,
	signal: AbortSignal | undefined,
): Promise<string | undefined> {
	for (const command of ["steppage-mcp", windowsStepPagePaths(env).wrapper]) {
		signal?.throwIfAborted();
		try {
			const stdout = await readWindowsVersion(command, env, signal);
			if (/^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(stdout.trim())) return command;
		} catch {
			// A missing or broken executable is the expected "not healthy" answer.
			signal?.throwIfAborted();
		}
	}
	return undefined;
}

function readWindowsVersion(command: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		signal?.throwIfAborted();
		const child = spawnProcess(command, ["--version"], {
			env,
			stdio: ["ignore", "pipe", "ignore"],
			windowsHide: true,
		});
		let stdout = "";
		let settled = false;
		const finish = (error?: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			if (error === undefined) resolve(stdout);
			else reject(error);
		};
		// Killing the cmd.exe wrapper may leave a hung node child; settling here
		// rather than on `close` keeps such a child from stalling readiness.
		const stop = (error: unknown) => {
			child.kill();
			finish(error);
		};
		const abort = () => stop(signal?.reason);
		const timer = setTimeout(() => stop(new Error(`${command} --version timed out.`)), 5_000);
		signal?.addEventListener("abort", abort, { once: true });
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = `${stdout}${chunk.toString()}`.slice(0, 8_192);
		});
		child.on("error", finish);
		child.on("close", (code) =>
			finish(code === 0 ? undefined : new Error(`${command} --version exited with ${code}.`)),
		);
	});
}

/**
 * Download the bundle to a private file and rename it into place, so a failed
 * or cancelled download never replaces a previously working bundle.
 */
async function installWindowsStepPage(env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
	const { bundle, wrapper } = windowsStepPagePaths(env);
	await mkdir(dirname(bundle), { recursive: true });
	await mkdir(dirname(wrapper), { recursive: true });
	const download = `${bundle}.${process.pid}.download`;
	try {
		await execFileText("curl", ["-fsSL", "--max-time", "120", "-o", download, stepPageBundleUrl(env)], {
			env,
			signal,
			timeout: 125_000,
			maxBuffer: 64_000,
		});
		if ((await stat(download)).size === 0) throw new Error("The StepPage download was empty.");
		signal.throwIfAborted();
		await rename(download, bundle);
	} finally {
		await rm(download, { force: true });
	}
	const pendingWrapper = `${wrapper}.${process.pid}.tmp`;
	try {
		await writeFile(pendingWrapper, WINDOWS_WRAPPER_SOURCE);
		await rename(pendingWrapper, wrapper);
	} finally {
		await rm(pendingWrapper, { force: true });
	}
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
		let nodeVersion: string;
		try {
			nodeVersion = (await execFileText("node", ["--version"], { env, signal, timeout: 5_000 })).stdout.trim();
		} catch (error) {
			signal?.throwIfAborted();
			// Keep the cause: "Node is missing" and "Node could not be run" need
			// different fixes, and a guessed reason sends the user the wrong way.
			const cause = isRecord(error) && error.code === "ENOENT" ? "node was not found on PATH" : describe(error);
			throw new Error(`Node.js >= 20 is required for StepPage; ${cause}. Install Node.js and retry.`);
		}
		const major = /^v(\d+)\./u.exec(nodeVersion)?.[1];
		if (!major || Number(major) < 20)
			throw new Error(`Node.js >= 20 is required for StepPage; found ${nodeVersion || "no version"}.`);
		if (platform === "win32") {
			await installWindowsStepPage(env, signal);
			const command = await findHealthyStepPage(env, signal, platform);
			if (!command) throw new Error("The StepPage bundle was installed, but steppage-mcp failed its version check.");
			return { command, installed: true };
		}
		// Download before executing so a failed curl cannot be hidden by `| sh`.
		const script = await execFileText("curl", ["-fsSL", "--max-time", "30", stepPageInstallerUrl(env)], {
			env,
			signal,
			timeout: 35_000,
			maxBuffer: 1_000_000,
		});
		if (!script.stdout.trim()) throw new Error("The StepPage installer download was empty.");
		await runInstaller(script.stdout, env, signal);
		const command = await findHealthyStepPage(env, signal, platform);
		if (!command) throw new Error("The StepPage installer completed, but steppage-mcp failed its version check.");
		return { command, installed: true };
	} catch (error) {
		input.signal?.throwIfAborted();
		let detail = error instanceof Error ? error.message : String(error);
		for (const [key, value] of Object.entries(env)) {
			if (value && value.length >= 4 && /key|token|secret|password|authorization/iu.test(key))
				detail = detail.replaceAll(value, "[redacted]");
		}
		// The POSIX one-liner cannot set up Windows; `step mcp prepare` runs the Windows installation.
		const remedy =
			platform === "win32"
				? "Run: step mcp prepare, then restart Step."
				: `Install it with: curl -fsSL '${stepPageInstallerUrl(env).replace(/'/gu, "'\\''")}' | sh, then restart Step. You can also run: step mcp prepare, then restart Step.`;
		return {
			installed: false,
			error: `StepPage is not ready: ${detail.slice(-2_000)} Step remains usable; StepPage setup will retry on the next launch. ${remedy}`,
		};
	} finally {
		await release?.().catch(() => undefined);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
