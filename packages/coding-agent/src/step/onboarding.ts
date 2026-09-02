/** Shared Step login profiles and the side-effect-free onboarding reducer. */

export const STEP_LOGIN_PROFILE_IDS = ["step_plan", "platform_cn", "platform_oversea"] as const;

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

const PROFILE_ENDPOINTS: Record<
	StepLoginProfileId,
	{
		baseUrl: string;
		authBaseUrl: string;
		keyPageUrl: string;
	}
> = {
	step_plan: {
		baseUrl: "https://api.stepfun.com/step_plan",
		authBaseUrl: "https://platform.stepfun.com",
		keyPageUrl: "https://platform.stepfun.com/interface-key",
	},
	platform_cn: {
		baseUrl: "https://api.stepfun.com/v1",
		authBaseUrl: "https://platform.stepfun.com",
		keyPageUrl: "https://platform.stepfun.com/interface-key",
	},
	platform_oversea: {
		baseUrl: "https://api.stepfun.ai/v1",
		authBaseUrl: "https://platform.stepfun.ai",
		keyPageUrl: "https://platform.stepfun.ai/interface-key",
	},
};

export function resolveStepLoginProfiles(env: Record<string, string | undefined> = process.env): StepLoginProfile[] {
	return STEP_LOGIN_PROFILE_IDS.map((id) => {
		const endpoints = PROFILE_ENDPOINTS[id];
		const baseUrl = readEndpointOverride(env, id, endpoints.baseUrl);
		const authBaseUrl = readEndpointOverride(env, `${id}_auth`, endpoints.authBaseUrl);
		return {
			id,
			title:
				id === "step_plan"
					? "Step Plan"
					: id === "platform_cn"
						? `Step Platform (API key · ${endpoints.keyPageUrl})`
						: `Step Platform Oversea(API key · ${endpoints.keyPageUrl})`,
			description:
				id === "step_plan" ? "Usage included with Mini, Plus, Pro, and Max plans" : "Pay for what you use.",
			credentialSource: id === "step_plan" ? "browser" : "apiKey",
			baseUrl,
			authBaseUrl,
			keyPageUrl: endpoints.keyPageUrl,
		};
	});
}

function readEndpointOverride(
	env: Record<string, string | undefined>,
	key: StepLoginProfileId | `${StepLoginProfileId}_auth`,
	fallback: string,
): string {
	const names =
		key === "step_plan"
			? ["STEP_CLI_STEP_PLAN_API_URL"]
			: key === "platform_cn"
				? ["STEP_CLI_PLATFORM_API_URL"]
				: key === "platform_oversea"
					? ["STEP_CLI_PLATFORM_API_OVERSEA_URL"]
					: key === "step_plan_auth"
						? ["STEP_CLI_DEVCENTER_AUTH_CN_URL"]
						: key === "platform_cn_auth"
							? ["STEP_CLI_PLATFORM_AUTH_URL"]
							: ["STEP_CLI_DEVCENTER_AUTH_OVERSEA_URL"];
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
	| { readonly kind: "continueInBrowser"; readonly choice: StepLoginChoice; readonly authUrl: string }
	| { readonly kind: "saving"; readonly choice: StepLoginChoice }
	| { readonly kind: "done" }
	| { readonly kind: "exit" };

export type StepLoginEvent =
	| { readonly type: "choose"; readonly choice: StepLoginChoice }
	| { readonly type: "browserOpened"; readonly authUrl: string }
	| { readonly type: "credential"; readonly apiKey: string; readonly uid?: string }
	| { readonly type: "type"; readonly text: string }
	| { readonly type: "backspace" }
	| { readonly type: "back" }
	| { readonly type: "saved" }
	| { readonly type: "fail"; readonly message: string }
	| { readonly type: "quit" };

export const INITIAL_STEP_LOGIN_STEP: StepLoginStep = { kind: "pickMode", error: null };

export function reduceStepLogin(step: StepLoginStep, event: StepLoginEvent): StepLoginStep {
	if (event.type === "quit") return { kind: "exit" };
	switch (step.kind) {
		case "pickMode":
			if (event.type !== "choose") return step;
			return event.choice === "step_plan"
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
