/**
 * Accepted ranges for the `[subagent]` settings.
 *
 * Kept apart from the settings manager so the editor schema and the runtime
 * validators read the same numbers without importing the whole manager.
 */

export const SUBAGENT_BACKGROUND_TIMEOUT_MIN_SECONDS = 60;
export const SUBAGENT_BACKGROUND_TIMEOUT_MAX_SECONDS = 7_200;
export const SUBAGENT_BACKGROUND_TIMEOUT_DEFAULT_SECONDS = 3_600;

/** Whether `value` is an accepted `[subagent] background_timeout_seconds`: an integer within the bounds. */
export function isValidSubagentBackgroundTimeout(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= SUBAGENT_BACKGROUND_TIMEOUT_MIN_SECONDS &&
		value <= SUBAGENT_BACKGROUND_TIMEOUT_MAX_SECONDS
	);
}

/** Message for a configured timeout that is ignored because it is out of bounds or not an integer. */
export function invalidSubagentBackgroundTimeoutMessage(
	value: unknown,
	keyPath = "[subagent] background_timeout_seconds",
): string {
	return `${keyPath} must be an integer from ${SUBAGENT_BACKGROUND_TIMEOUT_MIN_SECONDS} to ${SUBAGENT_BACKGROUND_TIMEOUT_MAX_SECONDS}; ignoring ${JSON.stringify(value)} and using ${SUBAGENT_BACKGROUND_TIMEOUT_DEFAULT_SECONDS}`;
}

/** Default number of child processes a parallel subagent batch runs at once. */
export const SUBAGENT_MAX_CONCURRENCY_DEFAULT = 8;

/**
 * Whether `value` is an accepted `[subagent] max_concurrency`: a positive
 * integer. There is deliberately no upper bound — raising the limit above the
 * default is the point of the setting.
 */
export function isValidSubagentMaxConcurrency(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** Message for a configured concurrency that is ignored because it is not a positive integer. */
export function invalidSubagentMaxConcurrencyMessage(value: unknown, keyPath = "[subagent] max_concurrency"): string {
	// The effective fallback (option, then default) is resolved per call, so the
	// load-time warning only states that the value is ignored.
	return `${keyPath} must be a positive integer; ignoring ${JSON.stringify(value)}`;
}
