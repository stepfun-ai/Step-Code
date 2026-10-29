import type { Api, Model } from "@step-harness/providers";
import type { ModelRegistry, ResolvedRequestAuth } from "../core/model-registry.ts";

/** Provider wire formats whose Step token-count contract is known. */
export type StepTokenCountApi = "openai-completions" | "anthropic-messages";

/**
 * Tokenizer model used when the active model belongs to another provider. Step
 * exposes one tokenizer contract for these models, so `/context` can still count
 * third-party prompts without a provider-specific tokenizer.
 */
export const STEP_TOKENIZER_MODEL_ID = "step-3.7-flash";

export interface StepTokenCountRequest {
	messages: readonly unknown[];
	system?: string;
	tools?: readonly unknown[];
}

export interface StepTokenCountParams {
	model: Model<Api>;
	auth: ResolvedRequestAuth;
	request: StepTokenCountRequest;
	signal?: AbortSignal;
}

const STEP_TOKEN_COUNT_HOSTS = new Set(["api.stepfun.com", "api.stepfun.ai"]);

/**
 * Token counting sends the current request shape to the Step tokenizer endpoint.
 * The active provider may be a third-party model, but tokenization still uses a
 * Step tokenizer model so `/context` does not need a provider-specific counter.
 * Local estimation remains the fallback when Step auth or the endpoint is
 * unavailable.
 */
export function supportsStepTokenCount(model: Model<Api> | undefined): model is Model<StepTokenCountApi> {
	if (!model) return false;
	if (model.api !== "openai-completions" && model.api !== "anthropic-messages") return false;
	try {
		return STEP_TOKEN_COUNT_HOSTS.has(new URL(model.baseUrl).hostname);
	} catch {
		return false;
	}
}

/**
 * Pick the model whose tokenizer endpoint should count the report.
 *
 * A Step model keeps its own tokenizer. Any other active model borrows a Step
 * tokenizer model, reusing the discovered Step endpoint and auth. When no Step
 * model is registered, callers fall back to the local structural estimator.
 */
export function resolveStepTokenCountModel(
	registry: ModelRegistry,
	activeModel: Model<Api> | undefined,
): Model<StepTokenCountApi> | undefined {
	if (activeModel && supportsStepTokenCount(activeModel)) return activeModel;
	const stepModel = registry
		.getAll()
		.find((model): model is Model<StepTokenCountApi> => model.provider === "step" && supportsStepTokenCount(model));
	if (!stepModel) return undefined;
	return { ...stepModel, id: STEP_TOKENIZER_MODEL_ID, name: STEP_TOKENIZER_MODEL_ID };
}

function joinUrl(baseUrl: string, path: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function readPositiveInt(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

/**
 * Count tokens for one request payload through the Step platform tokenizer.
 *
 * Returns null for any transport, auth, or shape failure so callers can fall
 * back to local estimates without turning `/context` into a failing command.
 */
export async function countStepTokens(params: StepTokenCountParams): Promise<number | null> {
	const { model, auth, request, signal } = params;
	if (!supportsStepTokenCount(model)) return null;
	if (!auth.ok) return null;

	const url =
		model.api === "openai-completions"
			? joinUrl(model.baseUrl, "token/count")
			: joinUrl(model.baseUrl, "messages/count_tokens");
	const body =
		model.api === "openai-completions"
			? {
					model: model.id,
					messages: request.messages,
					...(request.tools ? { tools: request.tools } : {}),
				}
			: {
					model: model.id,
					messages: request.messages,
					...(request.system ? { system: request.system } : {}),
					...(request.tools ? { tools: request.tools } : {}),
				};

	const headers = new Headers({
		"Content-Type": "application/json",
		...model.headers,
		...auth.headers,
	});
	if (auth.apiKey && !headers.has("Authorization")) {
		headers.set("Authorization", `Bearer ${auth.apiKey}`);
	}

	try {
		const response = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: signal ?? AbortSignal.timeout(10_000),
		});
		if (!response.ok) return null;
		const payload: unknown = await response.json();
		if (model.api === "openai-completions") {
			const data = (payload as { data?: { total_tokens?: unknown } }).data;
			return readPositiveInt(data?.total_tokens);
		}
		return readPositiveInt((payload as { input_tokens?: unknown }).input_tokens);
	} catch {
		return null;
	}
}
