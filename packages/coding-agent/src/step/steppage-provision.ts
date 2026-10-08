import { execFile, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
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
async function findHealthyStepPage(env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string | undefined> {
	const managed = join(resolveStepHomeDir(env), ".local", "bin", "steppage-mcp");
	for (const command of ["steppage-mcp", managed]) {
		signal?.throwIfAborted();
		try {
			const result = await execFileAsync(command, ["--version"], { env, signal, timeout: 5_000, maxBuffer: 8_192 });
			if (/^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(result.stdout.trim())) return command;
		} catch {
			signal?.throwIfAborted();
		}
	}
	return undefined;
}

/** Repair the managed executable without changing plugin manifests or credentials. */
export async function ensureStepPageReady(
	input: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; platform?: NodeJS.Platform } = {},
): Promise<StepPageReadiness> {
	const env = input.env ?? process.env;
	const compromised = new AbortController();
	const signal = AbortSignal.any([compromised.signal, ...(input.signal ? [input.signal] : [])]);
	signal?.throwIfAborted();
	const healthy = await findHealthyStepPage(env, signal);
	if (healthy) return { command: healthy, installed: false };
	if ((input.platform ?? process.platform) === "win32") {
		return {
			installed: false,
			error: "StepPage is not ready: automatic installation is currently supported on macOS and Linux. Step remains usable.",
		};
	}
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
		const available = await findHealthyStepPage(env, signal);
		if (available) return { command: available, installed: false };
		let nodeVersion: string;
		try {
			nodeVersion = (await execFileAsync("node", ["--version"], { env, signal, timeout: 5_000 })).stdout.trim();
		} catch {
			signal?.throwIfAborted();
			throw new Error("Node.js >= 20 is required for StepPage; install Node.js and retry.");
		}
		const major = /^v(\d+)\./u.exec(nodeVersion)?.[1];
		if (!major || Number(major) < 20)
			throw new Error(`Node.js >= 20 is required for StepPage; found ${nodeVersion}.`);
		// Download before executing so a failed curl cannot be hidden by `| sh`.
		const script = await execFileAsync("curl", ["-fsSL", "--max-time", "30", stepPageInstallerUrl(env)], {
			env,
			signal,
			timeout: 35_000,
			maxBuffer: 1_000_000,
		});
		if (!script.stdout.trim()) throw new Error("The StepPage installer download was empty.");
		await runInstaller(script.stdout, env, signal);
		const command = await findHealthyStepPage(env, signal);
		if (!command) throw new Error("The StepPage installer completed, but steppage-mcp failed its version check.");
		return { command, installed: true };
	} catch (error) {
		input.signal?.throwIfAborted();
		let detail = error instanceof Error ? error.message : String(error);
		for (const [key, value] of Object.entries(env)) {
			if (value && value.length >= 4 && /key|token|secret|password|authorization/iu.test(key))
				detail = detail.replaceAll(value, "[redacted]");
		}
		const installer = `curl -fsSL '${stepPageInstallerUrl(env).replace(/'/gu, "'\\''")}' | sh`;
		return {
			installed: false,
			error: `StepPage is not ready: ${detail.slice(-2_000)} Step remains usable; StepPage setup will retry on the next launch. Install it with: ${installer}, then restart Step. You can also run: step mcp prepare, then restart Step.`,
		};
	} finally {
		await release?.().catch(() => undefined);
	}
}
