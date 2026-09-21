import { describe, expect, it } from "vitest";
import {
	readEndpointChannelDefault,
	readEndpointEnvOverride,
	resolveEndpoint,
} from "../src/step/observer-endpoints.ts";

const DEV_ORIGIN = "https://test-openapi-stepcliobserserver.c.stepfun-inc.net";
const RELEASE_ORIGIN = "https://api.stepfun.com/stepcliobserserver";

describe("observer endpoint registry", () => {
	// These strings are the cross-repo contract with stepcliobserserver. The
	// collector is write-only, so a typo degrades to a silent local spool rather
	// than an error — spell each route out here instead of rebuilding it.
	it("builds the exact collector routes for both channels", () => {
		expect(readEndpointChannelDefault("telemetry", "dev")).toBe(`${DEV_ORIGIN}/api/v1/events`);
		expect(readEndpointChannelDefault("telemetry", "release")).toBe(`${RELEASE_ORIGIN}/api/v1/events`);
		expect(readEndpointChannelDefault("feedback", "dev")).toBe(`${DEV_ORIGIN}/api/v1/feedback`);
		expect(readEndpointChannelDefault("feedback", "release")).toBe(`${RELEASE_ORIGIN}/api/v1/feedback`);
		expect(readEndpointChannelDefault("feedbackBundle", "dev")).toBe(`${DEV_ORIGIN}/api/v1/feedback/bundle`);
		expect(readEndpointChannelDefault("feedbackBundle", "release")).toBe(`${RELEASE_ORIGIN}/api/v1/feedback/bundle`);
	});

	// The release origin is a gateway route, not a host. Normalizing it through
	// `URL().origin` would drop `/stepcliobserserver`, breaking every route and
	// widening any prefix match to the whole of api.stepfun.com.
	it("keeps the release path segment", () => {
		const endpoint = readEndpointChannelDefault("telemetry", "release");
		expect(endpoint.startsWith(`${RELEASE_ORIGIN}/`)).toBe(true);
		expect(new URL(endpoint).origin).toBe("https://api.stepfun.com");
		expect(new URL(endpoint).pathname).toBe("/stepcliobserserver/api/v1/events");
	});

	it("reads environment overrides in declared precedence", () => {
		expect(
			readEndpointEnvOverride("telemetry", {
				STEPCODE_TELEMETRY_ENDPOINT: "https://first.test/events",
				STEP_CLI_TELEMETRY_ENDPOINT: "https://second.test/events",
				STEPCLI_TELEMETRY_ENDPOINT: "https://third.test/events",
			}),
		).toBe("https://first.test/events");
		expect(
			readEndpointEnvOverride("telemetry", {
				STEP_CLI_TELEMETRY_ENDPOINT: "https://second.test/events",
				STEPCLI_TELEMETRY_ENDPOINT: "https://third.test/events",
			}),
		).toBe("https://second.test/events");
		// A blank value is not an override; it must fall through to the next name.
		expect(
			readEndpointEnvOverride("telemetry", {
				STEPCODE_TELEMETRY_ENDPOINT: "   ",
				STEPCLI_TELEMETRY_ENDPOINT: "https://third.test/events",
			}),
		).toBe("https://third.test/events");
		expect(readEndpointEnvOverride("feedbackBundle", {})).toBeUndefined();
	});

	it("prefers an override over the channel default", () => {
		expect(resolveEndpoint("feedback", { channel: "release", env: {} })).toBe(`${RELEASE_ORIGIN}/api/v1/feedback`);
		expect(
			resolveEndpoint("feedback", { channel: "release", env: { STEPCODE_FEEDBACK_ENDPOINT: "https://x.test/f" } }),
		).toBe("https://x.test/f");
		expect(resolveEndpoint("feedback", { env: {} })).toBe(`${DEV_ORIGIN}/api/v1/feedback`);
		expect(resolveEndpoint("feedback", { env: { STEP_HARNESS_BUILD_CHANNEL: "release" } })).toBe(
			`${RELEASE_ORIGIN}/api/v1/feedback`,
		);
	});
});
