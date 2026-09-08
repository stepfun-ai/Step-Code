import { readStoredCredential } from "../core/auth-storage.ts";
import { createStepProviderConfig } from "../extensions/step-provider/index.ts";
import { resolveStepLoginProfiles } from "./onboarding.ts";

export type StepLoginMethod = "step_plan" | "api_key" | null;
export type StepCredentialValidity = "missing" | "valid" | "invalid" | "unavailable";

export interface StepLoginStatus {
	readonly loggedIn: boolean;
	readonly loginMethod: StepLoginMethod;
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
	const storedApiKey = stored?.profile === "platform_cn" || stored?.profile === "platform_oversea";
	const access = envKey ?? storedAccess;
	const loginMethod: StepLoginMethod = envKey || storedApiKey ? "api_key" : access ? "step_plan" : null;
	if (!access || !loginMethod) return { loggedIn: false, loginMethod: null, validity: "missing" };

	const accountValue = envKey ? undefined : (stored?.uid ?? stored?.profile);
	const account = typeof accountValue === "string" && accountValue.trim() ? accountValue.trim() : undefined;
	const profile = typeof stored?.profile === "string" ? stored.profile : undefined;
	const profileBaseUrl = profile
		? resolveStepLoginProfiles(env).find((candidate) => candidate.id === profile)?.baseUrl
		: undefined;
	const baseUrl =
		options.apiBaseUrl ?? profileBaseUrl ?? createStepProviderConfig().baseUrl ?? "https://api.stepfun.com/step_plan";
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
			return { loggedIn: true, loginMethod, ...(account ? { account } : {}), validity: "invalid" };
		}
		if (!response.ok) {
			return {
				loggedIn: true,
				loginMethod,
				...(account ? { account } : {}),
				validity: "unavailable",
				error: `HTTP ${response.status}`,
			};
		}
		return { loggedIn: true, loginMethod, ...(account ? { account } : {}), validity: "valid" };
	} catch {
		return {
			loggedIn: true,
			loginMethod,
			...(account ? { account } : {}),
			validity: "unavailable",
			error: "network_error",
		};
	}
}
