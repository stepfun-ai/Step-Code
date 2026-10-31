import type { CommandExecutionOutcome, CommandExecutionResult } from "@step-harness/agent-core";

export type BashExecutionResult = CommandExecutionResult;
export type BashExecutionOutcome = CommandExecutionOutcome;
export { formatCommandExecutionOutcome as formatCommandOutcome } from "@step-harness/agent-core";

export interface CommandOutputFooter {
	notice: string;
	status: string;
}

/** Validate display framing restored from tool results or session history. */
export function readCommandOutputFooter(value: unknown): CommandOutputFooter | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Record<string, unknown>;
	return typeof candidate.notice === "string" && typeof candidate.status === "string"
		? { notice: candidate.notice, status: candidate.status }
		: undefined;
}

/** Normalize executor facts while retaining simultaneous deadline and cancellation observations. */
export function commandOutcome(
	result: BashExecutionResult,
	timeout: number | undefined,
	aborted: boolean,
): BashExecutionOutcome {
	const timedOut = result.timedOut === true;
	const canceled = aborted || result.aborted === true;
	const signal = result.signal ?? null;
	const timeoutSeconds = result.timeoutSeconds ?? timeout;
	return {
		status: canceled
			? "canceled"
			: timedOut
				? "timed_out"
				: signal
					? "signaled"
					: result.exitCode === null
						? "unknown"
						: "exited",
		exitCode: result.exitCode,
		signal,
		timedOut,
		aborted: canceled,
		...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
	};
}
