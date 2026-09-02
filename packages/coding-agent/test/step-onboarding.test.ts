import { describe, expect, it } from "vitest";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { INITIAL_STEP_LOGIN_STEP, reduceStepLogin, resolveStepLoginProfiles } from "../src/step/onboarding.ts";
import { StepOnboardingView } from "../src/step/onboarding-view.ts";

describe("Step login onboarding", () => {
	it("offers the three Step login profiles in step-cli order", () => {
		expect(resolveStepLoginProfiles().map((profile) => profile.id)).toEqual([
			"step_plan",
			"platform_cn",
			"platform_oversea",
		]);
	});

	it("keeps each platform profile paired with its own endpoint", () => {
		const profiles = resolveStepLoginProfiles();
		expect(profiles.find((profile) => profile.id === "step_plan")?.baseUrl).toBe("https://api.stepfun.com/step_plan");
		expect(profiles.find((profile) => profile.id === "platform_cn")?.baseUrl).toBe("https://api.stepfun.com/v1");
		expect(profiles.find((profile) => profile.id === "platform_oversea")?.baseUrl).toBe("https://api.stepfun.ai/v1");
	});

	it("routes browser and API-key choices through one reducer", () => {
		const browser = reduceStepLogin(INITIAL_STEP_LOGIN_STEP, {
			type: "choose",
			choice: "step_plan",
		});
		const apiKey = reduceStepLogin(INITIAL_STEP_LOGIN_STEP, {
			type: "choose",
			choice: "platform_cn",
		});

		expect(browser).toEqual({ kind: "continueInBrowser", choice: "step_plan", authUrl: "" });
		expect(apiKey).toEqual({ kind: "apiKeyEntry", choice: "platform_cn", value: "", error: null });
		expect(reduceStepLogin(apiKey, { type: "credential", apiKey: "platform-key" })).toEqual({
			kind: "saving",
			choice: "platform_cn",
		});
	});

	it("renders the same three choices used by every login entry point", () => {
		initTheme("dark");
		const view = new StepOnboardingView(resolveStepLoginProfiles(), {
			onChoose: () => {},
			onSubmitApiKey: () => {},
			onType: () => {},
			onBackspace: () => {},
			onBack: () => {},
			onQuit: () => {},
			requestRender: () => {},
		});

		const rendered = view.render(100).join("\n");
		expect(rendered).toContain("1. Step Plan");
		expect(rendered).toContain("2. Step Platform");
		expect(rendered).toContain("3. Step Platform Oversea");
		expect(rendered).toContain("Usage included with Mini, Plus, Pro, and Max plans");
	});
});
