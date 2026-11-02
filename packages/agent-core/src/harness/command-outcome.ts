/** Command facts returned by an execution adapter, independent of invocation errors. */
export interface CommandExecutionResult {
	exitCode: number | null;
	signal?: string | null;
	timedOut?: boolean;
	aborted?: boolean;
	timeoutSeconds?: number;
}

/** Caller-side facts that are known even when the adapter cannot report them. */
export interface CommandExecutionOptions {
	/** Deadline the caller applied, in seconds. */
	timeoutSeconds?: number;
	/** Whether the caller aborted the invocation. */
	aborted?: boolean;
}

export interface CommandExecutionOutcome {
	status: "exited" | "timed_out" | "signaled" | "canceled" | "unknown";
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
	aborted: boolean;
	timeoutSeconds?: number;
}

/**
 * Normalize executor facts into one observation.
 *
 * Deadline, signal, and cancellation stay independent of the exit code: a
 * command that traps the deadline signal and exits with zero still timed out.
 * An adapter that omits or misreports the exit code yields `unknown`, never a
 * fabricated zero or a non-integer that later formats as `code NaN`.
 */
export function normalizeCommandExecution(
	result: CommandExecutionResult,
	options?: CommandExecutionOptions,
): CommandExecutionOutcome {
	const canceled = options?.aborted === true || result.aborted === true;
	const signal = result.signal ?? null;
	const timeoutSeconds = result.timeoutSeconds ?? options?.timeoutSeconds;
	const exitCode = typeof result.exitCode === "number" && Number.isInteger(result.exitCode) ? result.exitCode : null;
	const status: CommandExecutionOutcome["status"] = canceled
		? "canceled"
		: result.timedOut === true
			? "timed_out"
			: signal
				? "signaled"
				: exitCode === null
					? "unknown"
					: "exited";
	return {
		status,
		exitCode,
		signal,
		// These are projections of `status`, so a live observation and the same
		// observation read back from a session record cannot disagree.
		timedOut: status === "timed_out",
		aborted: status === "canceled",
		...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
	};
}

const EXECUTION_STATUSES = new Set(["exited", "timed_out", "signaled", "canceled", "unknown"]);

/**
 * Validate a persisted or caller-supplied outcome before it reaches a model view
 * or a renderer.
 *
 * `status` is authoritative: the redundant booleans are derived from it rather
 * than trusted, so a record cannot claim `exited` while also claiming a
 * deadline, or `canceled` while claiming `aborted: false`. Malformed records are
 * dropped instead of being projected as facts.
 */
export function readCommandExecutionOutcome(value: unknown): CommandExecutionOutcome | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Record<string, unknown>;
	const status = candidate.status;
	if (typeof status !== "string" || !EXECUTION_STATUSES.has(status)) return undefined;
	const signal = candidate.signal ?? null;
	if (signal !== null && typeof signal !== "string") return undefined;
	const timeoutSeconds = candidate.timeoutSeconds;
	if (timeoutSeconds !== undefined && typeof timeoutSeconds !== "number") return undefined;
	const rawExitCode = candidate.exitCode ?? null;
	if (rawExitCode !== null && (typeof rawExitCode !== "number" || !Number.isInteger(rawExitCode))) return undefined;
	switch (status) {
		case "exited":
			// A clean or failing exit without a code is not an `exited` observation.
			if (rawExitCode === null) return undefined;
			break;
		case "signaled":
			if (!signal) return undefined;
			break;
		default:
			break;
	}
	return {
		status: status as CommandExecutionOutcome["status"],
		exitCode: rawExitCode,
		signal,
		timedOut: status === "timed_out",
		aborted: status === "canceled",
		...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
	};
}

/** Describe an observation for diagnostics, logs, and storage failures. */
export function formatCommandExecutionOutcome(observed: CommandExecutionOutcome): string {
	switch (observed.status) {
		case "canceled":
			return "Command aborted";
		case "timed_out": {
			const duration = observed.timeoutSeconds === undefined ? "" : ` after ${observed.timeoutSeconds} seconds`;
			return `Command timed out${duration}${observed.signal ? ` (signal ${observed.signal})` : ""}`;
		}
		case "signaled":
			return `Command terminated by signal ${observed.signal}`;
		case "exited":
			return `Command exited with code ${observed.exitCode}`;
		default:
			return "Command returned no exit code; check its effects before repeating it.";
	}
}

/**
 * Report an observation only when it is worth stating.
 *
 * A clean exit needs no trailing status: the absence of a notice already says
 * the command completed. Deadlines, signals, cancellation, unknown exits, and
 * nonzero codes stay explicit because the exit code alone cannot express them.
 */
export function commandExecutionNotice(observed: CommandExecutionOutcome): string | undefined {
	if (observed.status === "exited" && observed.exitCode === 0) return undefined;
	return formatCommandExecutionOutcome(observed);
}
