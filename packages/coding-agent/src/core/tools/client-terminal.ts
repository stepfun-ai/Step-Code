import type { ShellConfig } from "../../utils/shell.ts";
import type { BashOperations } from "./bash.ts";

/** What a protocol host must provide for the agent to run commands in its terminal. */
export interface ClientTerminalHost {
	create(params: {
		command: string;
		args: string[];
		cwd?: string;
		env?: Record<string, string>;
		outputByteLimit?: number;
	}): Promise<{ terminalId: string }>;
	output(terminalId: string): Promise<{
		output: string;
		truncated: boolean;
		exitStatus?: { exitCode?: number | null; signal?: string | null };
	}>;
	waitForExit(terminalId: string): Promise<{ exitCode?: number | null; signal?: string | null }>;
	kill(terminalId: string): Promise<void>;
	release(terminalId: string): Promise<void>;
}

/**
 * The host installed by the current protocol mode, if any.
 *
 * Process-scoped for the same reason the filesystem bridge is: a host that
 * supports one active session at a time installs it before that session starts
 * and clears it when the session ends, so at most one is live. Tools read it at
 * call time, which is what lets the profile be built once per process.
 */
let clientTerminalHost: ClientTerminalHost | undefined;

export function setClientTerminalHost(host: ClientTerminalHost | undefined): void {
	clientTerminalHost = host;
}

export function getClientTerminalHost(): ClientTerminalHost | undefined {
	return clientTerminalHost;
}

/**
 * How often `terminal/output` is polled while a command runs.
 *
 * ACP has no push channel for terminal output, so the agent asks. 120ms is fast
 * enough that a progress line appears near when it is printed, and slow enough
 * that a long build does not turn into a request storm.
 */
const OUTPUT_POLL_INTERVAL_MS = 120;

/**
 * Output the agent asks the client to retain.
 *
 * The diff below depends on the client returning the output accumulated so far,
 * and the protocol lets a client truncate from the front once this limit is
 * passed. Asking for a generous limit keeps that from happening in practice;
 * when it does happen anyway the diff stands down rather than re-emitting bytes
 * the accumulator already has.
 */
const OUTPUT_BYTE_LIMIT = 16 * 1024 * 1024;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Raised when the client refused to create a terminal.
 *
 * A distinct type so the caller can tell "the command never started" from "the
 * command started and then something went wrong". Only an explicit missing-method
 * answer is safe to re-run locally; every other failure remains authoritative.
 */
export class ClientTerminalCreateError extends Error {
	readonly clientCause: unknown;

	constructor(cause: unknown) {
		super(`terminal/create failed: ${cause instanceof Error ? cause.message : String(cause)}`);
		this.name = "ClientTerminalCreateError";
		this.clientCause = cause;
	}
}

/** The protocol may hide a method even after advertising it; every other refusal is authoritative. */
function isMethodNotFound(error: ClientTerminalCreateError): boolean {
	if (typeof error.clientCause !== "object" || error.clientCause === null) return false;
	return (error.clientCause as { code?: unknown }).code === -32601;
}

/**
 * `ProcessEnv` is `Record<string, string | undefined>`; ACP wants values that are
 * always strings. An unset variable is dropped rather than sent as "undefined",
 * which the client would set as the literal string.
 */
function toEnvRecord(env: NodeJS.ProcessEnv): Record<string, string> {
	const record: Record<string, string> = {};
	for (const [name, value] of Object.entries(env)) {
		if (value !== undefined) record[name] = value;
	}
	return record;
}

/**
 * Run one command in the client's terminal, streaming its output back.
 *
 * The command arrives as a shell string, because that is what the agent's
 * pipeline produces. ACP takes a program plus arguments, so the resolved shell
 * config supplies the program and its flags and the string rides as the final
 * argument. Using the same config the local path uses is what keeps the two
 * paths behaving alike.
 */
async function execInClientTerminal(
	host: ClientTerminalHost,
	shell: ShellConfig,
	command: string,
	cwd: string,
	options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv },
): Promise<{ exitCode: number | null }> {
	let terminalId: string;
	try {
		const created = await host.create({
			command: shell.shell,
			args: [...shell.args, command],
			cwd,
			...(options.env === undefined ? {} : { env: toEnvRecord(options.env) }),
			outputByteLimit: OUTPUT_BYTE_LIMIT,
		});
		terminalId = created.terminalId;
	} catch (error) {
		throw new ClientTerminalCreateError(error);
	}

	let emitted = "";
	let timedOut = false;
	let aborted = false;
	const timeoutHandle =
		options.timeout === undefined
			? undefined
			: setTimeout(() => {
					timedOut = true;
					void host.kill(terminalId).catch(() => undefined);
				}, options.timeout * 1000);
	const onAbort = () => {
		aborted = true;
		void host.kill(terminalId).catch(() => undefined);
	};
	if (options.signal) {
		if (options.signal.aborted) onAbort();
		else options.signal.addEventListener("abort", onAbort, { once: true });
	}

	try {
		for (;;) {
			const snapshot = await host.output(terminalId);
			// Only the suffix is new. When the client truncated from the front the
			// string no longer starts with what was already emitted, and re-emitting
			// the whole buffer would duplicate output the accumulator holds.
			if (snapshot.output.startsWith(emitted)) {
				const fresh = snapshot.output.slice(emitted.length);
				if (fresh.length > 0) {
					emitted = snapshot.output;
					options.onData(Buffer.from(fresh, "utf-8"));
				}
			}
			if (snapshot.exitStatus !== undefined) {
				if (aborted) throw new Error("aborted");
				if (timedOut) throw new Error(`timeout:${options.timeout}`);
				return { exitCode: snapshot.exitStatus.exitCode ?? null };
			}
			// A kill was requested but the client has not reported the exit yet.
			// Without this the loop would poll forever, because a killed command
			// that never reaches an exit status has nothing else to end it.
			if (aborted || timedOut) {
				await host.waitForExit(terminalId).catch(() => undefined);
				if (aborted) throw new Error("aborted");
				throw new Error(`timeout:${options.timeout}`);
			}
			await delay(OUTPUT_POLL_INTERVAL_MS);
		}
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
		if (options.signal) options.signal.removeEventListener("abort", onAbort);
		// Release is mandatory once a terminal is no longer needed, and this runs
		// on the abort, timeout, and error paths too.
		await host.release(terminalId).catch(() => undefined);
	}
}

/**
 * Route command execution through the client's terminal when one is installed.
 *
 * Falls back to the local shell only before the command starts:
 *
 * - No host is installed, which is every non-ACP run and every ACP client that
 *   did not advertise `terminal`.
 * - The resolved shell feeds the command over stdin. ACP has no channel for
 *   that, so expressing it is impossible rather than merely awkward.
 * - The client explicitly answers `methodNotFound` to `terminal/create`. Any
 *   other refusal or transport failure propagates instead of running a side
 *   effect somewhere the client did not approve or observe.
 *
 * Once `terminal/create` has been answered the command is running, and a later
 * failure is never retried locally: re-running a command that already deleted a
 * file or pushed a commit is not a fallback, it is a second side effect. That
 * asymmetry with the filesystem bridge is deliberate. A failed read has a local
 * file to fall back to; a half-finished command has nothing safe to fall back
 * to.
 */
export function withClientTerminalOperations(
	fallback: BashOperations,
	resolveShell: () => ShellConfig,
): BashOperations {
	return {
		exec: async (command, cwd, executionOptions) => {
			const host = clientTerminalHost;
			const shell = resolveShell();
			if (host === undefined || shell.commandTransport === "stdin") {
				return fallback.exec(command, cwd, executionOptions);
			}
			try {
				return await execInClientTerminal(host, shell, command, cwd, executionOptions);
			} catch (error) {
				// A missing method can use the local shell because the command never
				// started. Refusal, resource exhaustion, and transport failures are
				// not permission to execute the same side effect locally.
				if (error instanceof ClientTerminalCreateError && isMethodNotFound(error)) {
					process.stderr.write(`[acp] terminal/create failed, running locally: ${error.message}
`);
					return fallback.exec(command, cwd, executionOptions);
				}
				throw error;
			}
		},
	};
}
