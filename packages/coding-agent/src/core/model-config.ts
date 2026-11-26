/** Immutable, credential-blind models.json snapshot. */

import { readFile } from "node:fs/promises";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { stripJsonComments } from "../utils/json.ts";
import { normalizePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";

const PercentileCutoffsSchema = Type.Object({
	p50: Type.Optional(Type.Number()),
	p75: Type.Optional(Type.Number()),
	p90: Type.Optional(Type.Number()),
	p99: Type.Optional(Type.Number()),
});

const OpenRouterRoutingSchema = Type.Object({
	allow_fallbacks: Type.Optional(Type.Boolean()),
	require_parameters: Type.Optional(Type.Boolean()),
	data_collection: Type.Optional(Type.Union([Type.Literal("deny"), Type.Literal("allow")])),
	zdr: Type.Optional(Type.Boolean()),
	enforce_distillable_text: Type.Optional(Type.Boolean()),
	order: Type.Optional(Type.Array(Type.String())),
	only: Type.Optional(Type.Array(Type.String())),
	ignore: Type.Optional(Type.Array(Type.String())),
	quantizations: Type.Optional(Type.Array(Type.String())),
	sort: Type.Optional(
		Type.Union([
			Type.String(),
			Type.Object({
				by: Type.Optional(Type.String()),
				partition: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			}),
		]),
	),
	max_price: Type.Optional(
		Type.Object({
			prompt: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			completion: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			image: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			audio: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			request: Type.Optional(Type.Union([Type.Number(), Type.String()])),
		}),
	),
	preferred_min_throughput: Type.Optional(Type.Union([Type.Number(), PercentileCutoffsSchema])),
	preferred_max_latency: Type.Optional(Type.Union([Type.Number(), PercentileCutoffsSchema])),
});

const VercelGatewayRoutingSchema = Type.Object({
	only: Type.Optional(Type.Array(Type.String())),
	order: Type.Optional(Type.Array(Type.String())),
});

const ThinkingLevelMapValueSchema = Type.Union([Type.String(), Type.Null()]);
const ThinkingLevelMapSchema = Type.Object(
	{
		off: Type.Optional(ThinkingLevelMapValueSchema),
		minimal: Type.Optional(ThinkingLevelMapValueSchema),
		low: Type.Optional(ThinkingLevelMapValueSchema),
		medium: Type.Optional(ThinkingLevelMapValueSchema),
		high: Type.Optional(ThinkingLevelMapValueSchema),
		xhigh: Type.Optional(ThinkingLevelMapValueSchema),
		max: Type.Optional(ThinkingLevelMapValueSchema),
	},
	{
		description:
			"Maps a Step thinking level onto the value this model expects. Omitted levels use the provider default.",
	},
);

const ChatTemplateKwargScalarSchema = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);
const ChatTemplateKwargVariableSchema = Type.Object({
	$var: Type.Union([Type.Literal("thinking.enabled"), Type.Literal("thinking.effort")]),
	omitWhenOff: Type.Optional(Type.Boolean()),
});
const ChatTemplateKwargSchema = Type.Union([ChatTemplateKwargScalarSchema, ChatTemplateKwargVariableSchema]);

const OpenAICompletionsCompatSchema = Type.Object({
	supportsStore: Type.Optional(Type.Boolean()),
	supportsDeveloperRole: Type.Optional(Type.Boolean()),
	supportsReasoningEffort: Type.Optional(Type.Boolean()),
	supportsUsageInStreaming: Type.Optional(Type.Boolean()),
	supportsFinishReason: Type.Optional(Type.Boolean()),
	maxTokensField: Type.Optional(Type.Union([Type.Literal("max_completion_tokens"), Type.Literal("max_tokens")])),
	requiresToolResultName: Type.Optional(Type.Boolean()),
	requiresAssistantAfterToolResult: Type.Optional(Type.Boolean()),
	requiresThinkingAsText: Type.Optional(Type.Boolean()),
	requiresReasoningContentOnAssistantMessages: Type.Optional(Type.Boolean()),
	thinkingFormat: Type.Optional(
		Type.Union([
			Type.Literal("openai"),
			Type.Literal("openrouter"),
			Type.Literal("together"),
			Type.Literal("baseten"),
			Type.Literal("deepseek"),
			Type.Literal("zai"),
			Type.Literal("qwen"),
			Type.Literal("chat-template"),
			Type.Literal("qwen-chat-template"),
			Type.Literal("string-thinking"),
			Type.Literal("ant-ling"),
		]),
	),
	chatTemplateKwargs: Type.Optional(Type.Record(Type.String(), ChatTemplateKwargSchema)),
	chatTemplateArgs: Type.Optional(Type.Record(Type.String(), ChatTemplateKwargSchema)),
	cacheControlFormat: Type.Optional(Type.Literal("anthropic")),
	openRouterRouting: Type.Optional(OpenRouterRoutingSchema),
	vercelGatewayRouting: Type.Optional(VercelGatewayRoutingSchema),
	supportsOpenAIGrammarTools: Type.Optional(Type.Boolean()),
	supportsStrictMode: Type.Optional(Type.Boolean()),
	sendSessionAffinityHeaders: Type.Optional(Type.Boolean()),
	deferredToolsMode: Type.Optional(Type.Literal("kimi")),
	sessionAffinityFormat: Type.Optional(
		Type.Union([Type.Literal("openai"), Type.Literal("openai-nosession"), Type.Literal("openrouter")]),
	),
	supportsLongCacheRetention: Type.Optional(Type.Boolean()),
});

const OpenAIResponsesCompatSchema = Type.Object({
	supportsDeveloperRole: Type.Optional(Type.Boolean()),
	sessionAffinityFormat: Type.Optional(
		Type.Union([Type.Literal("openai"), Type.Literal("openai-nosession"), Type.Literal("openrouter")]),
	),
	supportsLongCacheRetention: Type.Optional(Type.Boolean()),
	supportsStrictMode: Type.Optional(Type.Boolean()),
	supportsOpenAIGrammarTools: Type.Optional(Type.Boolean()),
	supportsAdditionalTools: Type.Optional(Type.Boolean()),
	supportsToolSearch: Type.Optional(Type.Boolean()),
});

const AnthropicMessagesCompatSchema = Type.Object({
	supportsEagerToolInputStreaming: Type.Optional(Type.Boolean()),
	supportsLongCacheRetention: Type.Optional(Type.Boolean()),
	sendSessionAffinityHeaders: Type.Optional(Type.Boolean()),
	supportsCacheControlOnTools: Type.Optional(Type.Boolean()),
	supportsTemperature: Type.Optional(Type.Boolean()),
	forceAdaptiveThinking: Type.Optional(Type.Boolean()),
	allowEmptySignature: Type.Optional(Type.Boolean()),
	supportsStrictTools: Type.Optional(Type.Boolean()),
	supportsToolReferences: Type.Optional(Type.Boolean()),
});

const ProviderCompatSchema = Type.Union([
	OpenAICompletionsCompatSchema,
	OpenAIResponsesCompatSchema,
	AnthropicMessagesCompatSchema,
]);

const ModelCostRatesSchema = {
	input: Type.Number(),
	output: Type.Number(),
	cacheRead: Type.Number(),
	cacheWrite: Type.Number(),
};
const ModelCostTierSchema = Type.Object(
	{
		inputTokensAbove: Type.Number({ description: "Input token count above which this tier's rates apply." }),
		...ModelCostRatesSchema,
	},
	{ description: "One pricing tier for long-context requests." },
);
const ModelCostSchema = Type.Object(
	{
		input: Type.Number({ description: "USD per million input tokens." }),
		output: Type.Number({ description: "USD per million output tokens." }),
		cacheRead: Type.Number({ description: "USD per million cached input tokens read back." }),
		cacheWrite: Type.Number({ description: "USD per million tokens written to the prompt cache." }),
		tiers: Type.Optional(
			Type.Array(ModelCostTierSchema, {
				description: "Long-context pricing; the base rates apply below the first tier.",
			}),
		),
	},
	{ description: "Cost per million tokens, used for usage and cache-miss reporting. Not used for billing." },
);

const ModelDefinitionSchema = Type.Object(
	{
		id: Type.String({ minLength: 1, description: "Model id as the endpoint expects it in the request body." }),
		name: Type.Optional(Type.String({ minLength: 1, description: "Display name in `/model`; defaults to `id`." })),
		api: Type.Optional(
			Type.String({
				minLength: 1,
				description:
					'Request dialect for this model, overriding the provider: "openai-completions", "openai-responses", or "anthropic-messages".',
			}),
		),
		baseUrl: Type.Optional(
			Type.String({ minLength: 1, description: "Endpoint for this model only; overrides the provider." }),
		),
		reasoning: Type.Optional(Type.Boolean({ description: "The model exposes a thinking/reasoning channel." })),
		thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
		input: Type.Optional(
			Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]), {
				description: 'Modalities this model accepts: "text" and/or "image". Defaults to text only.',
			}),
		),
		cost: Type.Optional(ModelCostSchema),
		contextWindow: Type.Optional(
			Type.Number({ minimum: 1, description: "Context window in tokens (default 128000). Drives compaction." }),
		),
		maxTokens: Type.Optional(
			Type.Number({ minimum: 1, description: "Output token limit per request (default 16384)." }),
		),
		samplingParams: Type.Optional(
			Type.Record(Type.String(), Type.Unknown(), {
				description: "Extra request fields, for example temperature, top_p, or a vendor-specific flag.",
			}),
		),
		headers: Type.Optional(
			Type.Record(Type.String(), Type.String(), { description: "Headers added to requests for this model." }),
		),
		compat: Type.Optional(ProviderCompatSchema),
	},
	{ description: "One model served by a provider." },
);

const ModelOverrideCostSchema = Type.Object(
	{
		input: Type.Optional(Type.Number({ description: "USD per million input tokens." })),
		output: Type.Optional(Type.Number({ description: "USD per million output tokens." })),
		cacheRead: Type.Optional(Type.Number({ description: "USD per million cached input tokens read back." })),
		cacheWrite: Type.Optional(Type.Number({ description: "USD per million tokens written to the cache." })),
		tiers: Type.Optional(Type.Array(ModelCostTierSchema, { description: "Long-context pricing tiers." })),
	},
	{ description: "Overrides for a built-in model's cost. Omitted rates keep the catalog value." },
);

const ModelOverrideSchema = Type.Object(
	{
		name: Type.Optional(Type.String({ minLength: 1, description: "Display name overriding the built-in catalog." })),
		reasoning: Type.Optional(Type.Boolean({ description: "Whether the model exposes a thinking channel." })),
		thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
		input: Type.Optional(
			Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]), {
				description: 'Modalities this model accepts: "text" and/or "image".',
			}),
		),
		cost: Type.Optional(ModelOverrideCostSchema),
		contextWindow: Type.Optional(Type.Number({ minimum: 1, description: "Context window in tokens." })),
		maxTokens: Type.Optional(Type.Number({ minimum: 1, description: "Output token limit per request." })),
		samplingParams: Type.Optional(
			Type.Record(Type.String(), Type.Unknown(), { description: "Extra request fields for this model." }),
		),
		headers: Type.Optional(
			Type.Record(Type.String(), Type.String(), { description: "Headers added to requests for this model." }),
		),
		compat: Type.Optional(ProviderCompatSchema),
	},
	{ description: "Edits applied to a built-in model, keyed by model id under `modelOverrides`." },
);

const ProviderConfigSchema = Type.Object(
	{
		name: Type.Optional(Type.String({ minLength: 1, description: "Display name for the provider." })),
		baseUrl: Type.Optional(
			Type.String({ minLength: 1, description: "Endpoint base URL, for example http://127.0.0.1:8000/v1." }),
		),
		apiKey: Type.Optional(
			Type.String({
				minLength: 1,
				description:
					"Credential or a reference to one: a literal key, `$ENV_VAR`, or `!command`. A keyless local server still needs a placeholder value to appear in `/model`.",
			}),
		),
		api: Type.Optional(
			Type.String({
				minLength: 1,
				description: 'Default request dialect: "openai-completions", "openai-responses", or "anthropic-messages".',
			}),
		),
		headers: Type.Optional(
			Type.Record(Type.String(), Type.String(), {
				description: "Headers sent with every request to this provider.",
			}),
		),
		compat: Type.Optional(ProviderCompatSchema),
		authHeader: Type.Optional(
			Type.Boolean({
				description: "Send the credential as an Authorization header (default true for most dialects).",
			}),
		),
		models: Type.Optional(Type.Array(ModelDefinitionSchema, { description: "Models this provider serves." })),
		modelOverrides: Type.Optional(
			Type.Record(Type.String(), ModelOverrideSchema, {
				description: "Edits to built-in models, keyed by model id.",
			}),
		),
	},
	{ description: "One provider entry, keyed by the id used in `/model` and `--model provider/id`." },
);

/**
 * The validated `models.json` shape. Exported so the editor schema is rendered
 * from the same object the loader compiles, instead of a copy that can drift.
 *
 * This is also what the loader compiles, so it stays permissive about unknown
 * fields: a newer Step may add one and an older binary must still load the
 * file. The editor schema adds the strictness; see `config-schema.ts`.
 */
export const ModelsConfigSchema = Type.Object({
	providers: Type.Record(Type.String(), ProviderConfigSchema, { description: "Providers keyed by provider id." }),
});
const validateModelsConfig = Compile(ModelsConfigSchema);

export type ModelsJsonModel = Static<typeof ModelDefinitionSchema>;
export type ModelsJsonModelOverride = Static<typeof ModelOverrideSchema>;
export type ModelsJsonProvider = Static<typeof ProviderConfigSchema>;
type ModelsJson = Static<typeof ModelsConfigSchema>;

function formatValidationPath(error: TLocalizedValidationError): string {
	if (error.keyword === "required") {
		const requiredProperties = (error.params as { requiredProperties?: string[] }).requiredProperties;
		const requiredProperty = requiredProperties?.[0];
		if (requiredProperty) {
			const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
			return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
		}
	}
	const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
	return path || "root";
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

/** One immutable load of models.json. */
export class ModelConfig {
	private readonly providers: ReadonlyMap<string, ModelsJsonProvider>;
	private readonly error: string | undefined;

	private constructor(providers: ReadonlyMap<string, ModelsJsonProvider>, error?: string) {
		this.providers = providers;
		this.error = error;
	}

	static async load(modelsJsonPath: string | undefined): Promise<ModelConfig> {
		if (!modelsJsonPath) return new ModelConfig(new Map());
		const path = normalizePath(modelsJsonPath);
		let content: string;
		try {
			content = await readFile(path, "utf-8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return new ModelConfig(new Map());
			return new ModelConfig(
				new Map(),
				`Failed to load models.json: ${error instanceof Error ? error.message : error}\n\nFile: ${path}`,
			);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(stripJsonComments(stripBom(content)));
		} catch (error) {
			return new ModelConfig(
				new Map(),
				`Failed to parse models.json: ${error instanceof Error ? error.message : error}\n\nFile: ${path}`,
			);
		}

		if (!validateModelsConfig.Check(parsed)) {
			const errors =
				validateModelsConfig
					.Errors(parsed)
					.map((error) => `  - ${formatValidationPath(error)}: ${error.message}`)
					.join("\n") || "Unknown schema error";
			return new ModelConfig(new Map(), `Invalid models.json schema:\n${errors}\n\nFile: ${path}`);
		}

		const config = parsed as ModelsJson;
		const providers = new Map<string, ModelsJsonProvider>();
		for (const [providerId, provider] of Object.entries(config.providers)) {
			providers.set(providerId, deepFreeze(structuredClone(provider)));
		}
		return new ModelConfig(providers);
	}

	getProvider(providerId: string): ModelsJsonProvider | undefined {
		return this.providers.get(providerId);
	}

	getProviderIds(): readonly string[] {
		return [...this.providers.keys()];
	}

	getError(): string | undefined {
		return this.error;
	}
}
