import { describe, expect, it } from "vitest";
import { classifyStepEndpoint } from "../src/step/telemetry-contract.ts";

describe("telemetry endpoint classes", () => {
	it("keeps every platform endpoint it recognized from the environment", () => {
		const env = {
			STEP_BASE_URL: "https://one.example.test/step_plan, https://two.example.test/step_plan",
			STEP_MODELS_PROXY_BASE_URL: "https://proxy.example.test",
			STEPFUN_MESSAGES_ENDPOINT: "https://legacy.example.test/v1/messages",
		};
		for (const url of [
			"https://api.stepfun.com/step_plan/v1",
			"https://one.example.test/v1",
			"https://two.example.test/v1",
			"https://proxy.example.test/v1/chat/completions",
			"https://legacy.example.test/v1/messages",
		]) {
			expect(classifyStepEndpoint(url, env), url).toBe("platform");
		}
	});

	it("keeps local and custom endpoints apart from the platform", () => {
		expect(classifyStepEndpoint("http://localhost:8080/v1", {})).toBe("local");
		expect(classifyStepEndpoint("http://127.0.0.1:8080/v1", {})).toBe("local");
		expect(classifyStepEndpoint("https://gateway.example.test/v1", {})).toBe("custom");
		expect(classifyStepEndpoint("not a url", {})).toBe("custom");
	});
});
