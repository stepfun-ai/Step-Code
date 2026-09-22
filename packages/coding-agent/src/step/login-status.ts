import { readStoredCredential } from "../core/auth-storage.ts";
import { createStepProviderConfig } from "../features/step-provider/index.ts";
import { resolveStepLoginProfiles, type StepLoginProfileId } from "./onboarding.ts";

export type StepLoginMethod = "step_plan" | "step_plan_oversea" | "api_key" | null;
export type StepCredentialValidity = "missing" | "valid" | "invalid" | "unavailable";

export interface StepLoginStatus {
	readonly loggedIn: boolean;
	readonly loginMethod: StepLoginMethod;
	/** Stored login profile, when the credential came from a known one. */
	readonly profile?: StepLoginProfileId;
	readonly account?: string;
	readonly validity: StepCredentialValidity;
	readonly error?: string;
}

export interface StepLoginStatusOptions {
	readonly authPath: string;
	readonly env?: Record<string, string | undefined>;
	readonly fetch?: typeof fetch;
	readonly apiBaseUrl?: string;
}

export async function getStepLoginStatus(options: StepLoginStatusOptions): Promise<StepLoginStatus> {
	const env = options.env ?? process.env;
	const stored = readStoredCredential("step", options.authPath) as
		| { type?: string; access?: unknown; refresh?: unknown; uid?: unknown; profile?: unknown }
		| undefined;
	const envKey = env.STEP_API_KEY?.trim();
	const storedAccess = stored?.type === "oauth" && typeof stored.access === "string" ? stored.access.trim() : "";
	const storedProfileId = typeof stored?.profile === "string" ? stored.profile.trim() : "";
	const storedApiKey = storedProfileId === "platform_cn" || storedProfileId === "platform_oversea";
	const access = envKey ?? storedAccess;
	const loginMethod: StepLoginMethod =
		envKey || storedApiKey ? "api_key" : access ? planLoginMethod(storedProfileId) : null;
	if (!access || !loginMethod) return { loggedIn: false, loginMethod: null, validity: "missing" };

	const accountValue = envKey ? undefined : (stored?.uid ?? stored?.profile);
	const account = typeof accountValue === "string" && accountValue.trim() ? accountValue.trim() : undefined;
	// The stored profile also decides which region's endpoint validates the
	// credential: an oversea plan token is rejected by the mainland endpoint.
	const profile = storedProfileId
		? resolveStepLoginProfiles(env).find((candidate) => candidate.id === storedProfileId)
		: undefined;
	const identity = {
		loggedIn: true,
		loginMethod,
		...(profile ? { profile: profile.id } : {}),
		...(account ? { account } : {}),
	} as const;
	const baseUrl =
		options.apiBaseUrl ??
		profile?.baseUrl ??
		createStepProviderConfig().baseUrl ??
		"https://api.stepfun.com/step_plan";
	try {
		const fetchFn = options.fetch ?? fetch;
		const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
		const modelsUrl = normalizedBaseUrl.endsWith("/v1")
			? `${normalizedBaseUrl}/models`
			: `${normalizedBaseUrl}/v1/models`;
		const response = await fetchFn(modelsUrl, {
			method: "GET",
			headers: { accept: "application/json", authorization: `Bearer ${access}` },
			signal: AbortSignal.timeout(10_000),
		});
		if (response.status === 401 || response.status === 403) {
			return { ...identity, validity: "invalid" };
		}
		if (!response.ok) {
			return { ...identity, validity: "unavailable", error: `HTTP ${response.status}` };
		}
		return { ...identity, validity: "valid" };
	} catch {
		return { ...identity, validity: "unavailable", error: "network_error" };
	}
}

/** Browser-login profiles differ only by region; an unknown profile is mainland. */
function planLoginMethod(profileId: string): StepLoginMethod {
	return profileId === "step_plan_oversea" ? "step_plan_oversea" : "step_plan";
}
