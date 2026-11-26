import { describe, expect, it } from "vitest";
import { isStepPlatformUrl, isStepProvider, stepPlatformHosts } from "../src/step-provider/index.ts";

describe("Step identity", () => {
	it("tells the Step provider by its id, never by its URL", () => {
		expect(isStepProvider({ provider: "step" })).toBe(true);
		expect(isStepProvider("step")).toBe(true);
		expect(isStepProvider({ provider: "my-gateway" })).toBe(false);
		expect(isStepProvider(undefined)).toBe(false);
	});

	it("knows the platform hosts from the provider default and its endpoint overrides", () => {
		expect([...stepPlatformHosts({})]).toEqual(["api.stepfun.com"]);
		expect(
			stepPlatformHosts({
				STEP_BASE_URL: "https://staging.example.test/step_plan",
				STEP_LOGIN_PROFILE_API_URL: "https://api.stepfun.ai/step_plan",
				STEP_API_URL: "not a url",
			}),
		).toEqual(new Set(["api.stepfun.com", "staging.example.test", "api.stepfun.ai"]));
		expect(isStepPlatformUrl("https://api.stepfun.com/v1/chat/completions", {})).toBe(true);
		// Exact host match: a sibling subdomain is not the platform.
		expect(isStepPlatformUrl("https://evil.stepfun.com/v1", {})).toBe(false);
		expect(isStepPlatformUrl("garbage", {})).toBe(false);
	});

	it("still recognizes every endpoint the telemetry classification recognized before", () => {
		// A declared models proxy is the platform.
		expect(
			isStepPlatformUrl("https://proxy.example.test/v1", {
				STEP_MODELS_PROXY_BASE_URL: "https://proxy.example.test",
			}),
		).toBe(true);
		// Comma-separated lists, in any of the variables, each name a host.
		const env = {
			STEP_BASE_URL: "https://one.example.test/step_plan, https://two.example.test/step_plan",
			STEP_MODELS_PROXY_BASE_URL: "https://proxy-a.example.test,https://proxy-b.example.test",
			STEPFUN_MESSAGES_ENDPOINT: "https://legacy.example.test/v1/messages, not a url",
		};
		for (const host of [
			"one.example.test",
			"two.example.test",
			"proxy-a.example.test",
			"proxy-b.example.test",
			"legacy.example.test",
		]) {
			expect(isStepPlatformUrl(`https://${host}/v1`, env)).toBe(true);
		}
		expect(isStepPlatformUrl("https://other.example.test/v1", env)).toBe(false);
	});
});
