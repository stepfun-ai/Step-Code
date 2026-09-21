/** Feedback routes are supplied by the host environment; source builds have no default route. */
const INLINED_FEEDBACK_ENDPOINT = process.env.STEP_CLI_FEEDBACK_ENDPOINT;
const INLINED_FEEDBACK_BUNDLE_ENDPOINT = process.env.STEP_CLI_FEEDBACK_BUNDLE_ENDPOINT;

export function resolveFeedbackEndpoint(env: NodeJS.ProcessEnv = process.env, bundle = false): string | undefined {
	const configured = bundle
		? env.STEP_CLI_FEEDBACK_BUNDLE_ENDPOINT?.trim() ||
			env.STEPCLI_FEEDBACK_BUNDLE_ENDPOINT?.trim() ||
			env.STEP_HARNESS_FEEDBACK_BUNDLE_ENDPOINT?.trim()
		: env.STEP_CLI_FEEDBACK_ENDPOINT?.trim() ||
			env.STEPCLI_FEEDBACK_ENDPOINT?.trim() ||
			env.STEP_HARNESS_FEEDBACK_ENDPOINT?.trim();
	if (configured) return configured;
	if (env !== process.env) return undefined;
	return (bundle ? INLINED_FEEDBACK_BUNDLE_ENDPOINT : INLINED_FEEDBACK_ENDPOINT)?.trim() || undefined;
}

/** Kept as a compatibility predicate; public builds have no built-in routes. */
export function isBuiltInFeedbackEndpoint(_endpoint: string, _bundle = false): boolean {
	return false;
}
