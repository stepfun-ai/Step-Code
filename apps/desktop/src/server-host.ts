/**
 * Runs the StepCode web server (apps/web dist/server.js) as a child process.
 *
 * The desktop does not reimplement the server: it starts the exact program
 * `pnpm web:serve` runs, on a free loopback port, under Electron's bundled
 * Node (ELECTRON_RUN_AS_NODE=1), so no system Node.js is required. The child
 * prints a startup banner containing `#token=<launch token>`; that token is
 * what the window exchanges for its auth cookie.
 *
 *   Electron main ──spawn──▶ <electron> dist/server.js
 *        ▲                      │ stdout: "Local: http://127.0.0.1:<port>/#token=…"
 *        └──── parse token ─────┘ stdout/stderr ─▶ <logs>/web-server.log
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { readReleaseEnvelope, withReleaseIdentity } from "./release-envelope.ts";

const LOOPBACK = "127.0.0.1";
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 5_000;
const TAIL_CHARS = 8 * 1024;
const TOKEN_PATTERN = /#token=([A-Za-z0-9_-]+)/;

export interface NodeExecutable {
	readonly command: string;
	/** True when `command` is the Electron binary and must run in Node mode. */
	readonly electron: boolean;
}

export interface WebServerLaunchOptions {
	readonly entry: string;
	readonly node: NodeExecutable;
	/** Default workspace for the server (STEPCODE_WEB_CWD) and the child's working directory. */
	readonly workspace: string;
	readonly environment: NodeJS.ProcessEnv;
	readonly logPath: string;
	/** Fixed port; a free loopback port is chosen when undefined. */
	readonly port?: number;
	readonly readyTimeoutMs?: number;
	/** Mirror the (redacted) server output to this process's stdout, for development. */
	readonly echo?: boolean;
}

/** A started server. `exited` resolves once the child is gone, for any reason. */
export interface RunningWebServer {
	readonly origin: string;
	/** Authenticated launch URL. The token is single-use: load it once. */
	readonly launchUrl: string;
	readonly port: number;
	readonly pid: number | undefined;
	readonly exited: Promise<WebServerExit>;
	stop(): Promise<void>;
}

export interface WebServerExit {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	/** True when the exit was requested through stop(). */
	readonly requested: boolean;
	/** Last stderr output, for error reporting. */
	readonly stderr: string;
}

/**
 * Locate apps/web's compiled server through the workspace dependency, so the
 * desktop runs whatever `@step-harness/web` build is installed beside it.
 * `STEPCODE_DESKTOP_SERVER_ENTRY` points at another build (e.g. a temp outDir).
 *
 * A packaged app passes `bundledServerDir` (`<resources>/server`): the
 * installer ships the server and its production dependencies there, outside
 * the app archive, because the server runs from its own directory and spawns
 * helper processes from real files.
 */
export function resolveWebServerEntry(env: NodeJS.ProcessEnv, bundledServerDir?: string): string {
	const override = env.STEPCODE_DESKTOP_SERVER_ENTRY?.trim();
	if (override) return resolve(override);
	const base = bundledServerDir === undefined ? import.meta.url : join(bundledServerDir, "package.json");
	return createRequire(base).resolve("@step-harness/web/server");
}

/**
 * Electron's own binary in Node mode by default. `STEPCODE_DESKTOP_NODE`
 * selects another Node.js executable, for example when a native module in the
 * agent's dependency graph was built for a different ABI than Electron's.
 */
export function resolveNodeExecutable(env: NodeJS.ProcessEnv): NodeExecutable {
	const override = env.STEPCODE_DESKTOP_NODE?.trim();
	if (override) return { command: override, electron: false };
	return { command: process.execPath, electron: true };
}

/** Ask the OS for a free loopback port. */
export function findFreePort(): Promise<number> {
	return new Promise((resolvePort, reject) => {
		const probe = createServer();
		probe.unref();
		probe.once("error", reject);
		probe.listen(0, LOOPBACK, () => {
			const address = probe.address();
			const port = typeof address === "object" && address !== null ? address.port : undefined;
			probe.close(() => {
				if (port === undefined) reject(new Error("Could not allocate a loopback port"));
				else resolvePort(port);
			});
		});
	});
}

/** The launch token from the server's startup banner, if this text contains it. */
export function parseLaunchToken(text: string): string | undefined {
	return TOKEN_PATTERN.exec(text)?.[1];
}

/** Hide the single-use launch token from logs. */
export function redactLaunchToken(text: string): string {
	return text.replace(/(#token=)[A-Za-z0-9_-]+/g, "$1<redacted>").replace(/(Token:\s+)\S+/g, "$1<redacted>");
}

function openLog(path: string): WriteStream | undefined {
	try {
		mkdirSync(dirname(path), { recursive: true });
		return createWriteStream(path, { flags: "a" });
	} catch {
		return undefined;
	}
}

function waitForExit(exited: Promise<unknown>, milliseconds: number): Promise<boolean> {
	return new Promise((resolveWait) => {
		const timer = setTimeout(() => resolveWait(false), milliseconds);
		void exited.then(() => {
			clearTimeout(timer);
			resolveWait(true);
		});
	});
}

/** Start the server and resolve once its banner reports the launch token. */
export async function launchWebServer(options: WebServerLaunchOptions): Promise<RunningWebServer> {
	const port = options.port ?? (await findFreePort());
	const origin = `http://${LOOPBACK}:${port}`;
	const log = openLog(options.logPath);
	log?.write(
		`\n--- ${new Date().toISOString()} starting ${options.entry} on ${origin} (node: ${options.node.command}${options.node.electron ? " as node" : ""}) ---\n`,
	);

	// Installers place the release envelope beside the server entry. It replaces
	// identity variables inherited from the login shell; a source run has none
	// and keeps whatever the developer exported.
	const release = readReleaseEnvelope(dirname(options.entry), (warning) => {
		log?.write(`--- ${warning} ---\n`);
	});
	const environment: NodeJS.ProcessEnv = withReleaseIdentity(
		{
			...options.environment,
			STEPCODE_WEB_PORT: String(port),
			STEPCODE_WEB_CWD: options.workspace,
			// This shell shows the client in its own window, so a browser tab would be a
			// second copy. Forced off rather than left unset: the command that launched
			// the app may have exported it.
			STEPCODE_WEB_OPEN: "0",
		},
		release,
	);
	if (options.node.electron) environment.ELECTRON_RUN_AS_NODE = "1";
	else delete environment.ELECTRON_RUN_AS_NODE;

	// The workspace travels in STEPCODE_WEB_CWD, not as the process cwd: on macOS a folder under
	// ~/Documents or ~/Desktop may not be readable yet, and Node aborts at startup when it cannot
	// read its own cwd (EPERM uv_cwd). The server's folder is always readable.
	const child: ChildProcess = spawn(options.node.command, [options.entry], {
		cwd: dirname(options.entry),
		env: environment,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});

	let stdout = "";
	let stderr = "";
	let requested = false;
	const write = (chunk: string): void => {
		const redacted = redactLaunchToken(chunk);
		log?.write(redacted);
		if (options.echo) process.stdout.write(redacted);
	};

	const exited = new Promise<WebServerExit>((resolveExit) => {
		child.once("exit", (code, signal) => {
			log?.write(`--- web server exited (code ${String(code)}, signal ${String(signal)}) ---\n`);
			log?.end();
			resolveExit({ code, signal, requested, stderr: stderr.trim() });
		});
	});
	// A crashed or killed Electron main must not leave the server running.
	const killOnExit = (): void => {
		child.kill("SIGKILL");
	};
	process.once("exit", killOnExit);
	void exited.then(() => process.off("exit", killOnExit));

	const stop = async (): Promise<void> => {
		// No pid: the spawn itself failed and there is nothing to stop.
		if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
		requested = true;
		child.kill("SIGTERM");
		if (await waitForExit(exited, STOP_GRACE_MS)) return;
		child.kill("SIGKILL");
		await waitForExit(exited, STOP_GRACE_MS);
	};

	const token = await new Promise<string>((resolveToken, reject) => {
		const timeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
		const timer = setTimeout(() => {
			reject(new Error(`The web server did not report ready within ${timeoutMs} ms.\n${stderr.trim()}`));
		}, timeoutMs);
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			write(chunk);
			stdout = (stdout + chunk).slice(-TAIL_CHARS);
			const found = parseLaunchToken(stdout);
			if (found !== undefined) {
				clearTimeout(timer);
				stdout = "";
				resolveToken(found);
			}
		});
		child.stderr?.on("data", (chunk: string) => {
			write(chunk);
			stderr = (stderr + chunk).slice(-TAIL_CHARS);
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(new Error(`Could not start ${options.node.command}: ${error.message}`));
		});
		void exited.then((exit) => {
			clearTimeout(timer);
			const status = exit.signal === null ? `code ${String(exit.code)}` : `signal ${exit.signal}`;
			reject(new Error(`The web server exited (${status}) before it was ready.\n${exit.stderr}`.trim()));
		});
	}).catch(async (error: unknown) => {
		await stop();
		throw error;
	});

	return {
		origin,
		launchUrl: `${origin}/#token=${token}`,
		port,
		pid: child.pid,
		exited,
		stop,
	};
}
