import type { Api, Model, ProviderHeaders } from "@step-harness/providers";
import { APP_NAME } from "../config.ts";

const OPENCODE_HOST = "opencode.ai";

const OPENROUTER_ATTRIBUTION_HEADERS: ProviderHeaders = {
	"HTTP-Referer": "https://github.com/stepfun-ai/Step-Code",
	"X-OpenRouter-Title": "StepCode",
	"X-OpenRouter-Categories": "cli-agent",
};

function matchesHost(baseUrl: string, expectedHost: string): boolean {
	try {
		return new URL(baseUrl).hostname === expectedHost;
	} catch {
		return false;
	}
}

function getSessionHeaders(model: Model<Api>, sessionId: string | undefined): Record<string, string> | undefined {
	if (!sessionId) return undefined;
	if (
		model.provider !== "opencode" &&
		model.provider !== "opencode-go" &&
		!matchesHost(model.baseUrl, OPENCODE_HOST)
	) {
		return undefined;
	}
	return { "x-opencode-session": sessionId, "x-opencode-client": APP_NAME };
}

export function mergeProviderAttributionHeaders(
	model: Model<Api>,
	sessionId: string | undefined,
	...headerSources: Array<ProviderHeaders | undefined>
): ProviderHeaders | undefined {
	const merged: ProviderHeaders = {
		...OPENROUTER_ATTRIBUTION_HEADERS,
		...getSessionHeaders(model, sessionId),
	};

	for (const headers of headerSources) {
		if (headers) {
			Object.assign(merged, headers);
		}
	}

	return Object.keys(merged).length > 0 ? merged : undefined;
}
