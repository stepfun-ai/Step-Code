/** Shared Step login profiles and the side-effect-free onboarding reducer. */

export const STEP_LOGIN_PROFILE_IDS = ["step_plan", "step_plan_oversea", "platform_cn", "platform_oversea"] as const;

export type StepLoginProfileId = (typeof STEP_LOGIN_PROFILE_IDS)[number];
export type StepLoginChoice = StepLoginProfileId;

export interface StepLoginProfile {
	readonly id: StepLoginProfileId;
	readonly title: string;
	readonly description: string;
	readonly credentialSource: "browser" | "apiKey";
	readonly baseUrl: string;
	readonly authBaseUrl: string;
	readonly keyPageUrl: string;
}

const PLAN_DESCRIPTION = "Usage included with Mini, Plus, Pro, and Max plans";
const PLATFORM_DESCRIPTION = "Pay for what you use.";

/**
 * One row per login method. Each profile owns both its endpoints and the
 * environment variables that override them, so adding a region cannot silently
 * inherit another region's endpoint.
 */
const PROFILE_DEFINITIONS: Record<
	StepLoginProfileId,
	{
		readonly title: string;
		readonly description: string;
		readonly credentialSource: "browser" | "apiKey";
		readonly baseUrl: string;
		readonly authBaseUrl: string;
		readonly keyPageUrl: string;
		readonly baseUrlEnv: readonly string[];
		readonly authBaseUrlEnv: readonly string[];
	}
> = {
	step_plan: {
		title: "Step Plan (https://platform.stepfun.com/step-plan)",
		description: PLAN_DESCRIPTION,
		credentialSource: "browser",
		baseUrl: "https://api.stepfun.com/step_plan",
		authBaseUrl: "https://platform.stepfun.com",
		keyPageUrl: "https://platform.stepfun.com/interface-key",
		baseUrlEnv: ["STEPCODE_STEP_PLAN_API_URL"],
		authBaseUrlEnv: ["STEPCODE_DEVCENTER_AUTH_CN_URL"],
	},
	step_plan_oversea: {
		title: "Step Plan Oversea (https://platform.stepfun.ai/step-plan)",
		description: PLAN_DESCRIPTION,
		credentialSource: "browser",
		baseUrl: "https://api.stepfun.ai/step_plan",
		authBaseUrl: "https://platform.stepfun.ai",
		keyPageUrl: "https://platform.stepfun.ai/interface-key",
		baseUrlEnv: ["STEPCODE_STEP_PLAN_API_OVERSEA_URL"],
		authBaseUrlEnv: ["STEPCODE_DEVCENTER_AUTH_OVERSEA_URL"],
	},
	platform_cn: {
		title: "Step Platform (API key · https://platform.stepfun.com/interface-key)",
		description: PLATFORM_DESCRIPTION,
		credentialSource: "apiKey",
		baseUrl: "https://api.stepfun.com/v1",
		authBaseUrl: "https://platform.stepfun.com",
		keyPageUrl: "https://platform.stepfun.com/interface-key",
		baseUrlEnv: ["STEPCODE_PLATFORM_API_URL"],
		authBaseUrlEnv: ["STEPCODE_PLATFORM_AUTH_URL"],
	},
	platform_oversea: {
		title: "Step Platform Oversea(API key · https://platform.stepfun.ai/interface-key)",
		description: PLATFORM_DESCRIPTION,
		credentialSource: "apiKey",
		baseUrl: "https://api.stepfun.ai/v1",
		authBaseUrl: "https://platform.stepfun.ai",
		keyPageUrl: "https://platform.stepfun.ai/interface-key",
		baseUrlEnv: ["STEPCODE_PLATFORM_API_OVERSEA_URL"],
		authBaseUrlEnv: ["STEPCODE_DEVCENTER_AUTH_OVERSEA_URL"],
	},
};

export function resolveStepLoginProfiles(env: Record<string, string | undefined> = process.env): StepLoginProfile[] {
	return STEP_LOGIN_PROFILE_IDS.map((id) => {
		const definition = PROFILE_DEFINITIONS[id];
		return {
			id,
			title: definition.title,
			description: definition.description,
			credentialSource: definition.credentialSource,
			baseUrl: readEndpointOverride(env, definition.baseUrlEnv, definition.baseUrl),
			authBaseUrl: readEndpointOverride(env, definition.authBaseUrlEnv, definition.authBaseUrl),
			keyPageUrl: definition.keyPageUrl,
		};
	});
}

function readEndpointOverride(
	env: Record<string, string | undefined>,
	names: readonly string[],
	fallback: string,
): string {
	for (const name of names) {
		const value = env[name]?.trim();
		if (value) return value.replace(/\/+$/u, "");
	}
	return fallback;
}

export type StepLoginStep =
	| { readonly kind: "pickMode"; readonly error: string | null }
	| {
			readonly kind: "apiKeyEntry";
			readonly choice: StepLoginChoice;
			readonly value: string;
			readonly error: string | null;
	  }
	| {
			readonly kind: "continueInBrowser";
			readonly choice: StepLoginChoice;
			readonly authUrl: string;
	  }
	| { readonly kind: "saving"; readonly choice: StepLoginChoice }
	| { readonly kind: "done" }
	| { readonly kind: "exit" };

export type StepLoginEvent =
	| { readonly type: "choose"; readonly choice: StepLoginChoice }
	| { readonly type: "browserOpened"; readonly authUrl: string }
	| {
			readonly type: "credential";
			readonly apiKey: string;
			readonly uid?: string;
	  }
	| { readonly type: "type"; readonly text: string }
	| { readonly type: "backspace" }
	| { readonly type: "back" }
	| { readonly type: "saved" }
	| { readonly type: "fail"; readonly message: string }
	| { readonly type: "quit" };

export const INITIAL_STEP_LOGIN_STEP: StepLoginStep = {
	kind: "pickMode",
	error: null,
};

export function reduceStepLogin(step: StepLoginStep, event: StepLoginEvent): StepLoginStep {
	if (event.type === "quit") return { kind: "exit" };
	switch (step.kind) {
		case "pickMode":
			if (event.type !== "choose") return step;
			return PROFILE_DEFINITIONS[event.choice].credentialSource === "browser"
				? { kind: "continueInBrowser", choice: event.choice, authUrl: "" }
				: { kind: "apiKeyEntry", choice: event.choice, value: "", error: null };
		case "apiKeyEntry":
			switch (event.type) {
				case "type":
					return { ...step, value: step.value + event.text, error: null };
				case "backspace":
					return step.value.length > 0 ? { ...step, value: step.value.slice(0, -1), error: null } : step;
				case "credential":
					return event.apiKey.trim().length > 0
						? { kind: "saving", choice: step.choice }
						: { ...step, error: "API key cannot be empty" };
				case "back":
					return { kind: "pickMode", error: null };
				case "fail":
					return { ...step, error: event.message };
				default:
					return step;
			}
		case "continueInBrowser":
			if (event.type === "browserOpened") return { ...step, authUrl: event.authUrl };
			if (event.type === "credential") return { kind: "saving", choice: step.choice };
			if (event.type === "back") return { kind: "pickMode", error: null };
			if (event.type === "fail") return { kind: "pickMode", error: event.message };
			return step;
		case "saving":
			if (event.type === "saved") return { kind: "done" };
			if (event.type === "fail") return { kind: "pickMode", error: event.message };
			return step;
		case "done":
		case "exit":
			return step;
	}
}

export function isStepLoginSettled(step: StepLoginStep): boolean {
	return step.kind === "done" || step.kind === "exit";
}
