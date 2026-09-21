import { describe, expect, it } from "vitest";
import { INITIAL_STEP_LOGIN_STEP, reduceStepLogin, resolveStepLoginProfiles } from "../src/step/onboarding.ts";
import { StepOnboardingView } from "../src/step/onboarding-view.ts";
import { initTheme } from "../src/theme/theme.ts";

describe("Step login onboarding", () => {
	it("offers the four Step login profiles in StepCode order", () => {
		expect(resolveStepLoginProfiles().map((profile) => profile.id)).toEqual([
			"step_plan",
			"step_plan_oversea",
			"platform_cn",
			"platform_oversea",
		]);
	});

	it("keeps each platform profile paired with its own endpoint", () => {
		const profiles = resolveStepLoginProfiles();
		expect(profiles.find((profile) => profile.id === "step_plan")?.baseUrl).toBe("https://api.stepfun.com/step_plan");
		expect(profiles.find((profile) => profile.id === "step_plan_oversea")?.baseUrl).toBe(
			"https://api.stepfun.ai/step_plan",
		);
		expect(profiles.find((profile) => profile.id === "platform_cn")?.baseUrl).toBe("https://api.stepfun.com/v1");
		expect(profiles.find((profile) => profile.id === "platform_oversea")?.baseUrl).toBe("https://api.stepfun.ai/v1");
	});

	it("points each Step Plan profile at its own developer-center login page", () => {
		const profiles = resolveStepLoginProfiles();
		const mainland = profiles.find((profile) => profile.id === "step_plan");
		const oversea = profiles.find((profile) => profile.id === "step_plan_oversea");
		expect(mainland?.authBaseUrl).toBe("https://platform.stepfun.com");
		expect(oversea?.authBaseUrl).toBe("https://platform.stepfun.ai");
		expect(oversea?.credentialSource).toBe("browser");
	});

	it("reads each profile endpoint from its own environment override", () => {
		const profiles = resolveStepLoginProfiles({
			STEPCODE_STEP_PLAN_API_OVERSEA_URL: "https://api.oversea.test/step_plan/",
			STEPCODE_DEVCENTER_AUTH_OVERSEA_URL: "https://platform.oversea.test",
		});
		const oversea = profiles.find((profile) => profile.id === "step_plan_oversea");
		expect(oversea?.baseUrl).toBe("https://api.oversea.test/step_plan");
		expect(oversea?.authBaseUrl).toBe("https://platform.oversea.test");
		expect(profiles.find((profile) => profile.id === "step_plan")?.baseUrl).toBe("https://api.stepfun.com/step_plan");
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

		const overseaBrowser = reduceStepLogin(INITIAL_STEP_LOGIN_STEP, {
			type: "choose",
			choice: "step_plan_oversea",
		});

		expect(browser).toEqual({ kind: "continueInBrowser", choice: "step_plan", authUrl: "" });
		expect(overseaBrowser).toEqual({ kind: "continueInBrowser", choice: "step_plan_oversea", authUrl: "" });
		expect(apiKey).toEqual({ kind: "apiKeyEntry", choice: "platform_cn", value: "", error: null });
		expect(reduceStepLogin(apiKey, { type: "credential", apiKey: "platform-key" })).toEqual({
			kind: "saving",
			choice: "platform_cn",
		});
	});

	it("renders the same four choices used by every login entry point", () => {
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
		expect(rendered).toContain("2. Step Plan Oversea");
		expect(rendered).toContain("3. Step Platform (API key");
		expect(rendered).toContain("4. Step Platform Oversea");
		expect(rendered).toContain("Usage included with Mini, Plus, Pro, and Max plans");
	});
});
