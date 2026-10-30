/**
 * Feedback collector routes.
 *
 * A report is user-initiated, so a build may ship the production collector
 * route as its default: there is no unattended-egress concern, and a source
 * checkout that never ran the release pipeline can still file feedback.
 * Precedence, highest first: runtime environment, build-time inlined value
 * (the bundle build substitutes `STEPCODE_FEEDBACK_ENDPOINT`), built-in route.
 *
 * The origin carries a path segment (`/stepcliobserserver`): it is a gateway
 * route, not a bare host. Never normalize it through `URL().origin`, which
 * would drop the segment and break every route.
 */
const BUILT_IN_ORIGIN = "https://api.stepfun.com/stepcliobserserver";

/** Route suffixes appended to the origin by string concatenation. */
const ROUTE_PATHS = {
	feedback: "/api/v1/feedback",
	feedbackBundle: "/api/v1/feedback/bundle",
} as const;

type FeedbackRouteName = keyof typeof ROUTE_PATHS;

const INLINED_FEEDBACK_ENDPOINT = process.env.STEPCODE_FEEDBACK_ENDPOINT;
const INLINED_FEEDBACK_BUNDLE_ENDPOINT = process.env.STEPCODE_FEEDBACK_BUNDLE_ENDPOINT;

function routeName(bundle: boolean): FeedbackRouteName {
	return bundle ? "feedbackBundle" : "feedback";
}

/** Built-in route for a report body or its session archive. */
export function readBuiltInFeedbackEndpoint(bundle = false): string {
	return `${BUILT_IN_ORIGIN}${ROUTE_PATHS[routeName(bundle)]}`;
}

/**
 * Whether `endpoint` names one of this client's built-in collector routes.
 *
 * Test delivery uses this to refuse a run that would post to the real
 * collector: tests must inject a local endpoint instead. Match the authority and
 * the decoded path, not the raw string — otherwise `/feedback`,`/feedback/`,
 * an encoded `%66eedback` or a trailing DNS root dot would slip past.
 */
export function isBuiltInFeedbackEndpoint(endpoint: string, bundle = false): boolean {
	return equivalentEndpoint(endpoint, readBuiltInFeedbackEndpoint(bundle));
}

function equivalentEndpoint(endpoint: string, expected: string): boolean {
	try {
		const actualUrl = new URL(endpoint);
		const expectedUrl = new URL(expected);
		return (
			equivalentAuthority(actualUrl, expectedUrl) &&
			normalizedPathname(actualUrl) === normalizedPathname(expectedUrl)
		);
	} catch {
		return false;
	}
}

function equivalentAuthority(actual: URL, expected: URL): boolean {
	return (
		actual.protocol === expected.protocol &&
		actual.port === expected.port &&
		actual.hostname.replace(/\.+$/u, "") === expected.hostname.replace(/\.+$/u, "")
	);
}

function normalizedPathname(url: URL): string {
	return decodeURIComponent(url.pathname).replace(/\/+$/u, "") || "/";
}

/**
 * Resolve the collector route for a report body or its session archive.
 *
 * Release configuration and operators still override it through the
 * environment (or the value inlined at bundle time), so a dev collector or a
 * private deployment keeps working without a code change.
 */
export function resolveFeedbackEndpoint(env: NodeJS.ProcessEnv = process.env, bundle = false): string {
	const configured = bundle
		? env.STEPCODE_FEEDBACK_BUNDLE_ENDPOINT?.trim() || env.STEP_HARNESS_FEEDBACK_BUNDLE_ENDPOINT?.trim()
		: env.STEPCODE_FEEDBACK_ENDPOINT?.trim() || env.STEP_HARNESS_FEEDBACK_ENDPOINT?.trim();
	if (configured) return configured;
	// An explicitly supplied env object describes one call, not the process, so
	// build-time inlining must not leak into it.
	if (env === process.env) {
		const inlined = (bundle ? INLINED_FEEDBACK_BUNDLE_ENDPOINT : INLINED_FEEDBACK_ENDPOINT)?.trim();
		if (inlined) return inlined;
	}
	return readBuiltInFeedbackEndpoint(bundle);
}
