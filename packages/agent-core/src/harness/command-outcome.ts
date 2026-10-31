/** Command facts returned by an execution adapter, independent of invocation errors. */
export interface CommandExecutionResult {
	exitCode: number | null;
	signal?: string | null;
	timedOut?: boolean;
	aborted?: boolean;
	timeoutSeconds?: number;
}

export interface CommandExecutionOutcome {
	status: "exited" | "timed_out" | "signaled" | "canceled" | "unknown";
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
	aborted: boolean;
	timeoutSeconds?: number;
}

/** Render execution observations without treating an exit code as invocation failure. */
export function formatCommandExecutionOutcome(observed: CommandExecutionOutcome): string {
	if (observed.aborted) return "Command aborted";
	if (observed.timedOut) {
		return `Command timed out after ${observed.timeoutSeconds ?? "the configured"} seconds${observed.signal ? ` (signal ${observed.signal})` : ""}`;
	}
	if (observed.signal) return `Command terminated by signal ${observed.signal}`;
	if (observed.status === "exited") return `Command exited with code ${observed.exitCode}`;
	return "Command returned no exit code; check its effects before repeating it.";
}
