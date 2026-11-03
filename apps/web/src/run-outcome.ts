/**
 * What one run leaves the host with.
 *
 * The kernel reports a run's failure in two places: an empty turn on
 * `agent_settled.failure`, and a provider error on the assistant message, which
 * only `agent_end` can see. A host that reads just one of them gets the outcome
 * wrong — reading only the settled event silently turns a failed request into
 * "completed" one event later. This keeps both facts until the run settles, then
 * answers once.
 */
export interface RunOutcome {
	/**
	 * Whether this run failed: the settled event reported an empty turn, or
	 * `agent_end` saw a provider error the kernel was not going to retry.
	 */
	readonly failed: boolean;
}

export interface RunOutcomeState {
	/** `agent_end` saw a provider error the kernel was not going to retry. */
	readonly errored: boolean;
}

export const EMPTY_RUN_OUTCOME_STATE: RunOutcomeState = { errored: false };

/** Record what `agent_end` proved about the run. */
export function recordRunEnd(stops: readonly string[], willRetry: boolean): RunOutcomeState {
	return { errored: stops.includes("error") && !willRetry };
}

/**
 * The run's outcome, once it has settled.
 *
 * `cleared` is the state to carry forward: it drops what this run recorded, so the
 * next run cannot inherit a failure this one already reported — including a run
 * that settles without an `agent_end` of its own (an abort before the first
 * request).
 */
export function settleRunOutcome(
	state: RunOutcomeState,
	event: { failure?: unknown },
): { outcome: RunOutcome; cleared: RunOutcomeState } {
	const failed = event.failure !== undefined || state.errored;
	return { outcome: { failed }, cleared: EMPTY_RUN_OUTCOME_STATE };
}
