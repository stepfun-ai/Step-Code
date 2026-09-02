import { readFeedbackBuildEnv } from "./build-env.ts";

const DEV_FEEDBACK_ENDPOINT = "https://test-openapi-stepcliobserserver.c.stepfun-inc.net/api/v1/feedback";
const RELEASE_FEEDBACK_ENDPOINT = "https://api.stepfun.com/stepcliobserserver/api/v1/feedback";
const DEV_BUNDLE_ENDPOINT = "https://test-openapi-stepcliobserserver.c.stepfun-inc.net/api/v1/feedback/bundle";
const RELEASE_BUNDLE_ENDPOINT = "https://api.stepfun.com/stepcliobserserver/api/v1/feedback/bundle";

export function isBuiltInFeedbackEndpoint(endpoint: string, bundle = false): boolean {
	return bundle
		? equivalentEndpoint(endpoint, DEV_BUNDLE_ENDPOINT) || equivalentEndpoint(endpoint, RELEASE_BUNDLE_ENDPOINT)
		: equivalentEndpoint(endpoint, DEV_FEEDBACK_ENDPOINT) || equivalentEndpoint(endpoint, RELEASE_FEEDBACK_ENDPOINT);
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

/** Environment override first, then the default for the current build channel. */
export function resolveFeedbackEndpoint(env: NodeJS.ProcessEnv = process.env, bundle = false): string | undefined {
	const configured = bundle
		? env.STEP_CLI_FEEDBACK_BUNDLE_ENDPOINT?.trim() ||
			env.STEPCLI_FEEDBACK_BUNDLE_ENDPOINT?.trim() ||
			env.STEP_HARNESS_FEEDBACK_BUNDLE_ENDPOINT?.trim()
		: env.STEP_CLI_FEEDBACK_ENDPOINT?.trim() ||
			env.STEPCLI_FEEDBACK_ENDPOINT?.trim() ||
			env.STEP_HARNESS_FEEDBACK_ENDPOINT?.trim();
	if (configured) return configured;
	const { channel } = readFeedbackBuildEnv(env);
	if (bundle) return channel === "release" ? RELEASE_BUNDLE_ENDPOINT : DEV_BUNDLE_ENDPOINT;
	return channel === "release" ? RELEASE_FEEDBACK_ENDPOINT : DEV_FEEDBACK_ENDPOINT;
}
