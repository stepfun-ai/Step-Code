/** Feedback routes are supplied by the host environment; source builds have no default route. */
export function resolveFeedbackEndpoint(env: NodeJS.ProcessEnv = process.env, bundle = false): string | undefined {
	return bundle
		? env.STEP_CLI_FEEDBACK_BUNDLE_ENDPOINT?.trim() ||
				env.STEPCLI_FEEDBACK_BUNDLE_ENDPOINT?.trim() ||
				env.STEP_HARNESS_FEEDBACK_BUNDLE_ENDPOINT?.trim()
		: env.STEP_CLI_FEEDBACK_ENDPOINT?.trim() ||
				env.STEPCLI_FEEDBACK_ENDPOINT?.trim() ||
				env.STEP_HARNESS_FEEDBACK_ENDPOINT?.trim();
}

/** Kept as a compatibility predicate; public builds have no built-in routes. */
export function isBuiltInFeedbackEndpoint(_endpoint: string, _bundle = false): boolean {
	return false;
}
