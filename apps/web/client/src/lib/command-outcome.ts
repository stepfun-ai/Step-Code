/**
 * Whether a finished tool call reported a command outcome that is not a success.
 *
 * A command's exit code, deadline and signal are execution facts, not an
 * invocation failure: the tool result carries them in `details.execution` while
 * `isError` stays false. A row that rendered only `isError` therefore showed a
 * failing command as a completed one.
 *
 * See `CommandExecutionOutcome` in `state/types.ts` for the mirrored wire shape.
 */

import type { CommandExecutionOutcome } from "../state/types";

const STATUSES: ReadonlySet<string> = new Set(["exited", "timed_out", "signaled", "canceled", "unknown"]);

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/**
 * Accept only a well-formed observation.
 *
 * This mirrors `readCommandExecutionOutcome` in
 * `packages/agent-core/src/harness/command-outcome.ts`, which is what the CLI
 * renders: a record that cannot describe itself — an `exited` status without a
 * code, `signaled` without a signal, a status outside the closed set — is
 * dropped by both sides, so the two hosts reach the same conclusion instead of
 * one of them inventing a failure from a broken field.
 */
function readOutcome(value: unknown): CommandExecutionOutcome | undefined {
	const candidate = record(value);
	if (!candidate) return undefined;
	const { status } = candidate;
	if (typeof status !== "string" || !STATUSES.has(status)) return undefined;
	const signal = candidate.signal ?? null;
	if (signal !== null && typeof signal !== "string") return undefined;
	const timeoutSeconds = candidate.timeoutSeconds;
	if (timeoutSeconds !== undefined && typeof timeoutSeconds !== "number") return undefined;
	const exitCode = candidate.exitCode ?? null;
	if (exitCode !== null && (typeof exitCode !== "number" || !Number.isInteger(exitCode))) return undefined;
	if (status === "exited" && exitCode === null) return undefined;
	if (status === "signaled" && !signal) return undefined;
	return {
		status: status as CommandExecutionOutcome["status"],
		exitCode,
		signal,
		timedOut: status === "timed_out",
		aborted: status === "canceled",
		...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
	};
}

/**
 * The observation a result declares for itself.
 *
 * A plain command reports it at the top level. An embedded `then_run` check
 * reports it under `thenRun`, and an applied edit whose check failed must not
 * read as a clean success either.
 */
function declaredOutcome(details: unknown): CommandExecutionOutcome | undefined {
	const top = record(details);
	if (!top) return undefined;
	const direct = readOutcome(top.execution);
	if (direct) return direct;
	return readOutcome(record(top.thenRun)?.execution);
}

/**
 * A clean exit is the only success. Every other observation — a nonzero exit, a
 * deadline that coexists with exit code zero, a signal, cancellation, or an
 * unknown exit — is reported as a failure.
 *
 * A record without a usable observation answers `false`, so an older or
 * malformed record keeps whatever `isError` said instead of claiming a failure
 * the record does not actually describe.
 */
export function commandOutcomeFailed(details: unknown): boolean {
	const outcome = declaredOutcome(details);
	if (!outcome) return false;
	if (outcome.status === "exited") return outcome.exitCode !== 0;
	return true;
}

/**
 * Whether a tool result should read as failed: the invocation itself failed, or
 * it succeeded but reported a non-success command outcome.
 *
 * The two facts are separate parameters on purpose. A live `tool_execution_end`
 * carries them as `isError` and `result.details`, a recorded message as
 * `isError` and `details`; passing the event object whole would silently read
 * the wrong level.
 *
 * This is presentation only. Whether the call produced a usable file change is
 * read from `details.changed` / `details.patch` by `fileChange`, not here.
 */
export function toolResultFailed(isError: boolean | undefined, details: unknown): boolean {
	return isError === true || commandOutcomeFailed(details);
}
