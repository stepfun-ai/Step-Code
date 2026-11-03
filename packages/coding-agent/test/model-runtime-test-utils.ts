import { readFileSync, writeFileSync } from "node:fs";
import type { CredentialStore } from "@step-harness/providers";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../src/core/models-store.ts";

const runtimes = new WeakMap<ModelRegistry, ModelRuntime>();

function wrap(runtime: ModelRuntime): ModelRegistry {
	const registry = new ModelRegistry(runtime);
	runtimes.set(registry, runtime);
	return registry;
}

/**
 * Register the product-owned Step provider for tests that construct a raw
 * ModelRuntime. Production Step sessions register this provider through the
 * Step extension; the neutral runtime intentionally ships with no built-ins.
 */
export function registerTestStepProvider(runtime: ModelRuntime): void {
	runtime.registerProvider("step", {
		name: "Step",
		baseUrl: "https://api.stepfun.com/v1",
		api: "openai-completions",
		apiKey: "$STEP_API_KEY",
		models: [
			{
				id: "step-5-preview",
				name: "Step 5 Preview",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 8192,
			},
		],
	});
}

/** Legacy catalog fixture used by ModelRegistry merge tests only. */
function registerLegacyCatalogFixtures(runtime: ModelRuntime): void {
	runtime.registerProvider("anthropic", {
		name: "Anthropic",
		baseUrl: "https://api.anthropic.com",
		api: "anthropic-messages",
		apiKey: "test-key",
		mergeModelsJson: true,
		models: [
			{
				id: "claude-sonnet-4-5",
				name: "Claude Sonnet 4.5",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				contextWindow: 200_000,
				maxTokens: 8192,
			},
			{
				id: "claude-opus-4-6",
				name: "Claude Opus 4.6",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
				contextWindow: 200_000,
				maxTokens: 8192,
			},
		],
	});
	runtime.registerProvider("openai", {
		name: "OpenAI",
		baseUrl: "https://api.openai.com/v1",
		api: "openai-responses",
		apiKey: "test-key",
		mergeModelsJson: true,
		models: [
			{
				id: "gpt-5",
				name: "GPT-5",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
				contextWindow: 200_000,
				maxTokens: 8192,
				compat: {},
			},
			{
				id: "gpt-5-mini",
				name: "GPT-5 Mini",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0.2, output: 0.8, cacheRead: 0.02, cacheWrite: 0.04 },
				contextWindow: 128_000,
				maxTokens: 8192,
				compat: {},
			},
		],
	});
}

/**
 * models.json model entries historically inherited api/baseUrl from built-ins.
 * The Step-only catalog no longer provides those built-ins, so the isolated
 * legacy fixtures supply the provider-level api explicitly for those tests.
 */
function seedLegacyProviderApis(modelsPath: string | undefined): void {
	if (!modelsPath) return;
	try {
		const parsed = JSON.parse(readFileSync(modelsPath, "utf8")) as {
			providers?: Record<string, Record<string, unknown>>;
		};
		let changed = false;
		for (const [providerId, api, baseUrl] of [
			["anthropic", "anthropic-messages", "https://api.anthropic.com"],
			["openai", "openai-responses", "https://api.openai.com/v1"],
		] as const) {
			const provider = parsed.providers?.[providerId];
			if (provider) {
				if (provider.api === undefined) {
					provider.api = api;
					changed = true;
				}
				if (provider.baseUrl === undefined) {
					provider.baseUrl = baseUrl;
					changed = true;
				}
			}
		}
		if (changed) writeFileSync(modelsPath, JSON.stringify(parsed));
	} catch {
		// ModelConfig reports malformed or unreadable files through its normal path.
	}
}

/** Load optional models.json configuration without introducing file-backed catalog locks into unit tests. */
export async function createModelRegistry(credentials: CredentialStore, modelsPath?: string): Promise<ModelRegistry> {
	seedLegacyProviderApis(modelsPath);
	const runtime = await ModelRuntime.create({
		credentials,
		modelsPath,
		modelsStore: new InMemoryCodingAgentModelsStore(),
		allowModelNetwork: false,
	});
	registerTestStepProvider(runtime);
	registerLegacyCatalogFixtures(runtime);
	return wrap(runtime);
}

export async function createInMemoryModelRegistry(credentials: CredentialStore): Promise<ModelRegistry> {
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
	return wrap(runtime);
}

export function getModelRuntime(modelRegistry: ModelRegistry): ModelRuntime {
	const runtime = runtimes.get(modelRegistry);
	if (!runtime) throw new Error("ModelRegistry was not created by the test helper");
	return runtime;
}
