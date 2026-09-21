/**
 * Single source of truth for the Step ObservableServer (collector) routes.
 *
 * Telemetry and feedback are separate domains that happen to post to the same
 * server. Before this registry each kept its own copy of the URLs, so a server
 * move had to be mirrored by hand in three files and a typo in one of them was
 * invisible — the collector is write-only, so a wrong URL degrades silently to
 * a local spool rather than failing loudly.
 *
 * Two rules the callers depend on:
 *
 * - The release origin carries a path segment (`/stepcliobserserver`): it is a
 *   gateway route, not a bare host. Never normalize it through `URL().origin`,
 *   which would drop the segment and, for prefix-matching callers, widen a
 *   match from one route to the whole of `api.stepfun.com`.
 * - Adoption policy stays in each domain's own resolver. This registry only
 *   answers "what is the URL for <route> on <channel>"; whether a channel
 *   actually adopts that default is the caller's decision. Telemetry adopts on
 *   release only, feedback adopts on both — see their resolvers.
 */

import type { StepBuildChannel } from "./build-identity.ts";
import { readStepBuildIdentity } from "./build-identity.ts";

/** Test collector, reachable from the corporate network only. */
const OBSERVER_ORIGIN_DEV = "https://test-openapi-stepcliobserserver.c.stepfun-inc.net";
/** Production collector. The path segment is part of the gateway route. */
const OBSERVER_ORIGIN_RELEASE = "https://api.stepfun.com/stepcliobserserver";

export type ObserverEndpointName = "telemetry" | "feedback" | "feedbackBundle";

interface ObserverEndpointEntry {
	/** Route suffix appended to the channel origin by string concatenation. */
	readonly path: string;
	/** Runtime overrides, highest precedence first. */
	readonly envNames: readonly string[];
}

const OBSERVER_ENDPOINTS: Readonly<Record<ObserverEndpointName, ObserverEndpointEntry>> = {
	telemetry: {
		path: "/api/v1/events",
		// `STEPCODE_` is this repository's current spelling; the two `STEP*CLI_`
		// names predate the rename and stay accepted so existing operator
		// runbooks keep working.
		envNames: ["STEPCODE_TELEMETRY_ENDPOINT", "STEP_CLI_TELEMETRY_ENDPOINT", "STEPCLI_TELEMETRY_ENDPOINT"],
	},
	feedback: {
		path: "/api/v1/feedback",
		envNames: ["STEPCODE_FEEDBACK_ENDPOINT", "STEP_HARNESS_FEEDBACK_ENDPOINT"],
	},
	feedbackBundle: {
		path: "/api/v1/feedback/bundle",
		envNames: ["STEPCODE_FEEDBACK_BUNDLE_ENDPOINT", "STEP_HARNESS_FEEDBACK_BUNDLE_ENDPOINT"],
	},
};

export interface ResolveObserverEndpointOptions {
	readonly channel?: StepBuildChannel;
	readonly env?: NodeJS.ProcessEnv;
}

/** Built-in URL for a route on a channel. Plain concatenation, never `URL`. */
export function readEndpointChannelDefault(name: ObserverEndpointName, channel: StepBuildChannel): string {
	const origin = channel === "release" ? OBSERVER_ORIGIN_RELEASE : OBSERVER_ORIGIN_DEV;
	return `${origin}${OBSERVER_ENDPOINTS[name].path}`;
}

/** First non-blank runtime override for a route, in declared precedence. */
export function readEndpointEnvOverride(
	name: ObserverEndpointName,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	for (const envName of OBSERVER_ENDPOINTS[name].envNames) {
		const value = env[envName]?.trim();
		if (value) return value;
	}
	return undefined;
}

/**
 * Resolve a route for callers that adopt the built-in default on every channel.
 *
 * Telemetry deliberately does not use this: it adopts the default on release
 * only, so it composes the two readers above instead.
 */
export function resolveEndpoint(name: ObserverEndpointName, options: ResolveObserverEndpointOptions = {}): string {
	const env = options.env ?? process.env;
	return (
		readEndpointEnvOverride(name, env) ??
		readEndpointChannelDefault(name, options.channel ?? readStepBuildIdentity(env).channel)
	);
}
