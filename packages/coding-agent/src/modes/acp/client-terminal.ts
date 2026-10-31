import type {
	TerminalCreateParams,
	TerminalCreateResult,
	TerminalEnvVariable,
	TerminalKillParams,
	TerminalOutputParams,
	TerminalOutputResult,
	TerminalReleaseParams,
	TerminalWaitForExitParams,
	TerminalWaitForExitResult,
} from "./acp-types.ts";

/** Sends one request to the client and waits for its response. */
export type ClientRequest = (method: string, params: unknown) => Promise<unknown>;

/** Raised for a terminal id this agent never handed out, or handed out elsewhere. */
export class UnknownTerminalError extends Error {
	readonly terminalId: string;

	constructor(terminalId: string) {
		super(`Unknown terminalId: ${terminalId}`);
		this.name = "UnknownTerminalError";
		this.terminalId = terminalId;
	}
}

export interface ClientTerminalRecord {
	terminalId: string;
	/** Session the terminal was created in, so a later session cannot touch it. */
	sessionId: string;
	command: string;
	cwd?: string;
	createdAt: number;
}

/**
 * Owns the terminals this agent asked the client to create.
 *
 * This is a forwarding layer, not an execution engine. `terminal/create` asks
 * the client to run a program and the client owns the process from then on, so
 * the only state worth keeping locally is which ids were handed out and to which
 * session. Everything else is passed through, because a second copy of the
 * output or the exit status would be a copy that can disagree with the client's.
 *
 * The bash tool uses this registry only when the client advertises `terminal`.
 * ACP's `terminal/create` takes a program plus arguments, while the agent's
 * command pipeline is a shell string, so the installed host supplies the shell,
 * environment, and polling cadence explicitly. Clients that do not advertise
 * the capability keep local execution.
 */
export class ClientTerminalRegistry {
	private readonly terminals = new Map<string, ClientTerminalRecord>();
	private readonly request: ClientRequest;
	/** Read per call, because the active session changes underneath a live mode. */
	private readonly currentSessionId: () => string;

	constructor(request: ClientRequest, currentSessionId: () => string) {
		this.request = request;
		this.currentSessionId = currentSessionId;
	}

	get size(): number {
		return this.terminals.size;
	}

	async create(params: Omit<TerminalCreateParams, "sessionId">): Promise<ClientTerminalRecord> {
		const sessionId = this.currentSessionId();
		const result = (await this.request("terminal/create", { ...params, sessionId })) as TerminalCreateResult;
		const terminalId = typeof result?.terminalId === "string" ? result.terminalId : "";
		if (!terminalId) throw new Error("Client returned no terminalId for terminal/create");
		const record: ClientTerminalRecord = {
			terminalId,
			sessionId,
			command: params.command,
			...(params.cwd === undefined ? {} : { cwd: params.cwd }),
			createdAt: Date.now(),
		};
		this.terminals.set(terminalId, record);
		return record;
	}

	async output(terminalId: string): Promise<TerminalOutputResult> {
		const params = this.paramsFor(terminalId);
		return (await this.request("terminal/output", params)) as TerminalOutputResult;
	}

	async waitForExit(terminalId: string): Promise<TerminalWaitForExitResult> {
		const params = this.paramsFor(terminalId);
		return (await this.request("terminal/wait_for_exit", params)) as TerminalWaitForExitResult;
	}

	async kill(terminalId: string): Promise<void> {
		const params = this.paramsFor(terminalId);
		await this.request("terminal/kill", params);
	}

	async release(terminalId: string): Promise<void> {
		const params = this.paramsFor(terminalId);
		this.terminals.delete(terminalId);
		await this.request("terminal/release", params);
	}

	/**
	 * Release every terminal still held, on shutdown.
	 *
	 * The spec makes release mandatory once a terminal is no longer needed, and a
	 * mode that exits without releasing leaks the client's terminals for the life
	 * of the client process. Failures are swallowed because this runs on the way
	 * out, where there is nobody left to report them to.
	 */
	async releaseAll(): Promise<void> {
		for (const terminalId of [...this.terminals.keys()]) {
			try {
				await this.release(terminalId);
			} catch {
				// Already gone, or the client is gone with it.
			}
		}
	}

	private paramsFor(terminalId: string): TerminalOutputParams | TerminalWaitForExitParams {
		const record = this.terminals.get(terminalId);
		if (!record) throw new UnknownTerminalError(terminalId);
		const sessionId = this.currentSessionId();
		if (record.sessionId !== sessionId) throw new UnknownTerminalError(terminalId);
		return { sessionId, terminalId };
	}
}

/** ACP sends environment variables as name/value pairs; the reverse of a record. */
export function envRecordToPairs(env: Record<string, string>): TerminalEnvVariable[] {
	return Object.entries(env).map(([name, value]) => ({ name, value }));
}

export type { TerminalCreateParams, TerminalKillParams, TerminalReleaseParams };
