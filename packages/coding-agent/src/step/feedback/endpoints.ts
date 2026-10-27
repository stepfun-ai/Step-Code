import { type ObserverEndpointName, readEndpointChannelDefault, resolveEndpoint } from "../observer-endpoints.ts";
import { readFeedbackBuildEnv } from "./build-env.ts";

function endpointName(bundle: boolean): ObserverEndpointName {
	return bundle ? "feedbackBundle" : "feedback";
}

export function isBuiltInFeedbackEndpoint(endpoint: string, bundle = false): boolean {
	const name = endpointName(bundle);
	return (
		equivalentEndpoint(endpoint, readEndpointChannelDefault(name, "dev")) ||
		equivalentEndpoint(endpoint, readEndpointChannelDefault(name, "release"))
	);
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

export function resolveFeedbackEndpoint(env: NodeJS.ProcessEnv = process.env, bundle = false): string {
	// Unlike telemetry, feedback adopts the built-in default on both channels:
	// a report is user-initiated, so there is no unattended-egress concern.
	return resolveEndpoint(endpointName(bundle), { channel: readFeedbackBuildEnv(env).channel, env });
}
