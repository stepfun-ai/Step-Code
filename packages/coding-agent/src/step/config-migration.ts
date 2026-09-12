/**
 * Compatibility migration from the pre-Pi Step CLI layout.
 *
 * The old launcher kept one rich `config.json` under `.step-cli`. Pi splits
 * that state into `settings.json`, `models.json`, and `auth.json`. This module
 * performs a conservative projection into that shape. Legacy files are kept
 * intact and copied to a sibling `.bak` archive after a successful projection.
 */

import type { Dirent } from "node:fs";
import { chmod, copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Credential } from "@step-harness/providers";
import { parse as parseYaml } from "yaml";
import {
	normalizeStepAnthropicBaseUrl,
	STEP_MODELS,
	STEP_PROVIDER_DEFAULTS,
	STEP_PROVIDER_ID,
	STEP_STATIC_REFRESH_TOKEN,
} from "../features/step-provider/index.ts";
import { stripJsonComments } from "../utils/json.ts";
import { stripBom } from "../utils/text.ts";
import {
	LEGACY_RENAMED_CONFIG_DIR,
	resolveStepAgentDir,
	resolveStepConfigDir,
	resolveStepHomeDir,
	STEP_CLI_CONFIG_DIR,
} from "./environment.ts";

/** Internal conversion markers. They are removed before models.json is written. */
const LEGACY_MODEL_ID_MARKER = "__stepLegacyId";
const LEGACY_DEFAULT_MARKER = "__stepDefault";

type JsonObject = Record<string, unknown>;

export interface StepConfigMigrationOptions {
	/** Home directory override used by tests and embedded hosts. */
	homeDir?: string;
	/** Explicit Step agent directory used by an embedded host. */
	agentDir?: string;
	/** Current workspace override used by tests and embedded hosts. */
	cwd?: string;
	env?: Record<string, string | undefined>;
}

export interface StepConfigMigrationRootReport {
	scope: "global" | "project";
	source: string;
	target: string;
	migrated: boolean;
	warnings: string[];
}

export interface StepConfigMigrationReport {
	migrated: boolean;
	warnings: string[];
	roots: StepConfigMigrationRootReport[];
	/** Effective model defaults found in the old config, if any. */
	defaultProvider?: string;
	defaultModel?: string;
}

/** Read only the global Pi defaults used by the early argv normalizer. */
export async function readStepGlobalDefaults(
	agentDir?: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<{
	provider?: string;
	model?: string;
	telemetry?: {
		enabled?: boolean;
		spool?: boolean;
		endpoint?: string;
	};
}> {
	try {
		// Use the same resolver as the runtime. In particular, a caller-provided
		// The explicit Step agent directory must not be silently ignored here: these
		// defaults are injected into argv before the normal SettingsManager loads.
		const effectiveAgentDir = agentDir ?? resolveStepAgentDir(env);
		const parsed = JSON.parse(await readFile(join(effectiveAgentDir, "settings.json"), "utf8")) as unknown;
		const root = asObject(parsed);
		const telemetry = asObject(root?.telemetry);
		return {
			provider: asString(root?.defaultProvider),
			model: asString(root?.defaultModel),
			...(telemetry ? { telemetry: readTelemetrySettings(telemetry) } : undefined),
		};
	} catch {
		return {};
	}
}

function readTelemetrySettings(value: JsonObject): {
	enabled?: boolean;
	spool?: boolean;
	endpoint?: string;
} {
	const result: { enabled?: boolean; spool?: boolean; endpoint?: string } = {};
	if (typeof value.enabled === "boolean") result.enabled = value.enabled;
	if (typeof value.spool === "boolean") result.spool = value.spool;
	const endpoint = asString(value.endpoint)?.trim();
	if (endpoint) result.endpoint = endpoint;
	return result;
}

interface ConvertedConfig {
	settings: JsonObject;
	models: JsonObject;
	credentials: Map<string, Credential>;
	warnings: string[];
	hasModelConfig: boolean;
	/** A custom catalog is needed only when the old config declared definitions. */
	hasExplicitModelDefinitions: boolean;
	defaultProvider?: string;
	defaultModel?: string;
}

interface RootConversion {
	settings: JsonObject;
	models: JsonObject;
	credentials: Map<string, Credential>;
	warnings: string[];
	/** Whether the legacy config contained a model/default worth projecting. */
	hasModelConfig: boolean;
	hasExplicitModelDefinitions: boolean;
	defaultProvider?: string;
	defaultModel?: string;
}

const CONFIG_CANDIDATES = ["config.json", "config.yaml", "config.yml"] as const;

/** Marker for the one-time legacy projection. The source directory is never removed. */
export const STEP_LEGACY_MIGRATION_MARKER = ".legacy-step-cli-migration.json";
/** Marker used when importing the pre-rename Pi-shaped directory. */
const RETIRED_NAMESPACE_MIGRATION_MARKER = ".legacy-step-harness-migration.json";
/** Bump when the projection gains a new source field or merge phase. */
const STEP_LEGACY_MIGRATION_VERSION = 4;

function migrationMarkerPath(targetRoot: string, markerName = STEP_LEGACY_MIGRATION_MARKER): string {
	return join(targetRoot, markerName);
}

async function hasMigrationMarker(
	targetRoot: string,
	sourceRoot: string,
	markerName = STEP_LEGACY_MIGRATION_MARKER,
): Promise<boolean> {
	try {
		const parsed = asObject(JSON.parse(await readFile(migrationMarkerPath(targetRoot, markerName), "utf8")));
		if (parsed?.version !== STEP_LEGACY_MIGRATION_VERSION) return false;
		const source = asString(parsed.source);
		return source === undefined || resolve(source) === resolve(sourceRoot);
	} catch {
		return false;
	}
}

async function writeMigrationMarker(
	targetRoot: string,
	sourceRoot: string,
	warnings: string[],
	markerName = STEP_LEGACY_MIGRATION_MARKER,
): Promise<void> {
	try {
		await mkdir(targetRoot, { recursive: true, mode: 0o700 });
		await writeFile(
			migrationMarkerPath(targetRoot, markerName),
			`${JSON.stringify(
				{ version: STEP_LEGACY_MIGRATION_VERSION, source: sourceRoot, completedAt: new Date().toISOString() },
				null,
				2,
			)}\n`,
			{ encoding: "utf8", mode: 0o600 },
		);
	} catch (error) {
		warnings.push(
			`${migrationMarkerPath(targetRoot, markerName)}: could not persist migration marker (${error instanceof Error ? error.message : String(error)}).`,
		);
	}
}

function asObject(value: unknown): JsonObject | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function mergeObjects(base: JsonObject, override: JsonObject): JsonObject {
	const result: JsonObject = { ...base };
	for (const [key, value] of Object.entries(override)) {
		const oldValue = result[key];
		const oldObject = asObject(oldValue);
		const newObject = asObject(value);
		if (oldObject && newObject) {
			result[key] = mergeObjects(oldObject, newObject);
		} else {
			result[key] = structuredClone(value);
		}
	}
	return result;
}

/** Merge two provider catalogs while letting the legacy active provider win. */
function mergeProviderCatalog(base: JsonObject, override: JsonObject): JsonObject {
	const merged = mergeObjects(base, override);
	const baseModels = Array.isArray(base.models) ? base.models.filter((entry) => asObject(entry)) : [];
	const overrideModels = Array.isArray(override.models) ? override.models.filter((entry) => asObject(entry)) : [];
	if (baseModels.length === 0 && overrideModels.length === 0) return merged;
	const models = baseModels.map((entry) => structuredClone(entry as JsonObject));
	for (const entry of overrideModels) {
		const model = entry as JsonObject;
		const id = asString(model.id);
		const index = id ? models.findIndex((candidate) => asString(candidate.id) === id) : -1;
		if (index >= 0) models[index] = structuredClone(model);
		else models.push(structuredClone(model));
	}
	merged.models = models;
	return merged;
}

function compact(value: JsonObject): JsonObject {
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function hasMeaningfulValue(value: unknown): boolean {
	if (value === undefined || value === null) return false;
	if (typeof value === "string") return value.trim().length > 0;
	if (Array.isArray(value)) return value.length > 0;
	if (typeof value === "object") return Object.values(value as JsonObject).some((entry) => hasMeaningfulValue(entry));
	return true;
}

function splitModelReference(value: string | undefined): { provider?: string; model?: string } {
	if (!value) return {};
	const separator = value.indexOf("/");
	if (separator <= 0 || separator === value.length - 1) return { model: value };
	return { provider: value.slice(0, separator), model: value.slice(separator + 1) };
}

function providerIdFor(baseUrl: string | undefined, explicit: string | undefined): string {
	if (explicit) return explicit;
	if (baseUrl) {
		try {
			const host = new URL(baseUrl).hostname;
			const label = host.split(".").find((part) => part && part !== "www");
			if (label) return label;
		} catch {
			// Keep the stable fallback below for malformed legacy URLs. Pi will report
			// the URL error when the provider is actually selected.
		}
	}
	return "step";
}

function usesCloudTrace(provider: string | undefined): boolean {
	return provider === "stepfunModelProxy" || provider === "neocodex";
}

/** Read a legacy models-proxy dialect, which may be a string or provider map. */
function readLegacyApi(value: unknown, provider: string | undefined): string | undefined {
	if (typeof value === "string") return asString(value);
	const byProvider = asObject(value);
	if (!byProvider || !provider) return undefined;
	const exact = asString(byProvider[provider]);
	if (exact) return exact;
	const normalizedProvider = provider.toLowerCase().replaceAll("_", "-");
	for (const [key, raw] of Object.entries(byProvider)) {
		if (key.toLowerCase().replaceAll("_", "-") === normalizedProvider) return asString(raw);
	}
	return undefined;
}

/**
 * The old `provider` field bundled a vendor label and the wire protocol. Keep
 * the old dispatch table when `api` was omitted so an upgrade does not change
 * which client Pi uses for an existing account.
 */
function deriveLegacyApi(
	provider: string | undefined,
	proxyApi: string | undefined,
	declaredApi: string | undefined,
): string | undefined {
	if (declaredApi && declaredApi !== "openai-compatible") return normalizeApi(declaredApi, [], "api");
	const trace = usesCloudTrace(provider);
	if (declaredApi === "openai-compatible" || proxyApi === "openai-compatible") {
		return trace ? "openai-responses" : "openai-completions";
	}
	if (proxyApi === "anthropic-messages") return "anthropic-messages";
	if (provider === "anthropic") return "anthropic-messages";
	if (provider === "response" || provider === "neocodex") return "openai-responses";
	return declaredApi ? normalizeApi(declaredApi, [], "api") : "openai-completions";
}

function normalizeApi(value: string | undefined, warnings: string[], path: string): string | undefined {
	if (!value) return undefined;
	switch (value) {
		case "openai-compatible":
		case "openai-chat-completions":
			warnings.push(`${path}: mapped legacy API "${value}" to Pi "openai-completions".`);
			return "openai-completions";
		case "gemini-generate-content":
			warnings.push(`${path}: mapped legacy API "${value}" to Pi "google-generative-ai".`);
			return "google-generative-ai";
		default:
			return value;
	}
}

/**
 * Legacy Step accepted a fully-qualified operation URL in `baseUrl` (for
 * example `/v1/messages`). Pi's adapters receive the API root and append their
 * operation path themselves. Strip only the suffix that is unambiguous for
 * the selected API; arbitrary proxy paths must remain untouched.
 */
function normalizeBaseUrlForPiApi(
	value: string | undefined,
	api: string | undefined,
	warnings: string[],
	path: string,
): string | undefined {
	if (!value || !api) return value;
	const suffixes: Record<string, string> = {
		"anthropic-messages": "/messages",
		"openai-completions": "/chat/completions",
		"openai-responses": "/responses",
	};
	const suffix = suffixes[api];
	if (!suffix) return value;
	try {
		const url = new URL(value);
		const pathname = url.pathname.replace(/\/+$/u, "");
		if (!pathname.toLowerCase().endsWith(suffix)) {
			// Anthropic's Pi adapter appends `/v1/messages`, whereas the old Step
			// config often stored the `/v1` root. Remove that version segment too
			// so a migrated URL never becomes `/v1/v1/messages`.
			if (api !== "anthropic-messages" || !pathname.toLowerCase().endsWith("/v1")) return value;
			const nextPath = pathname.slice(0, -"/v1".length).replace(/\/+$/u, "") || "/";
			url.pathname = nextPath;
			const normalized = url.toString().replace(/\/$/u, "");
			warnings.push(`${path}: stripped legacy version suffix "/v1" for Pi "${api}".`);
			return normalized;
		}
		let nextPath = pathname.slice(0, -suffix.length).replace(/\/+$/u, "") || "/";
		// `/v1/messages` is the complete operation path used by the Anthropic
		// SDK. A bare `/messages` suffix may leave `/v1`; normalize both forms to
		// the host root because the adapter adds the version itself.
		if (api === "anthropic-messages" && nextPath.toLowerCase().endsWith("/v1")) {
			nextPath = nextPath.slice(0, -"/v1".length).replace(/\/+$/u, "") || "/";
		}
		url.pathname = nextPath;
		const normalized = url.toString().replace(/\/$/u, "");
		if (normalized !== value) {
			warnings.push(`${path}: stripped legacy operation suffix "${suffix}" for Pi "${api}".`);
		}
		return normalized;
	} catch {
		// Keep malformed URLs intact. The normal models.json/provider validation
		// will report the actionable error when the model is selected.
		return value;
	}
}

function isConfigReference(value: string): boolean {
	return value.startsWith("$") || value.startsWith("!");
}

function migrateHeaders(value: unknown, warnings: string[], path: string): JsonObject | undefined {
	const source = asObject(value);
	if (!source) return undefined;
	const headers: JsonObject = {};
	for (const [name, raw] of Object.entries(source)) {
		if (typeof raw !== "string") {
			warnings.push(`${path}.${name}: dropped because header values must be strings.`);
			continue;
		}
		if (/authorization|api.?key|token|secret|password|cookie/iu.test(name)) {
			warnings.push(`${path}.${name}: dropped because it may contain a credential.`);
			continue;
		}
		headers[name] = raw;
	}
	return Object.keys(headers).length > 0 ? headers : undefined;
}

function readTokenLimit(source: JsonObject | undefined, canonical: string, alias: string): number | undefined {
	const tokens = asObject(source?.tokens);
	const legacyAlias = canonical === "maxContext" ? "maxContextTokens" : "maxOutputTokens";
	return asNumber(tokens?.[canonical]) ?? asNumber(source?.[alias]) ?? asNumber(source?.[legacyAlias]);
}

function addCredential(
	credentials: Map<string, Credential>,
	providerId: string,
	value: string | undefined,
	warnings: string[],
	path: string,
): string | undefined {
	if (!value) return undefined;
	if (isConfigReference(value)) return value;
	if (value === "<your_api_key>") return undefined;
	if (!credentials.has(providerId)) {
		credentials.set(providerId, { type: "api_key", key: value });
	} else {
		warnings.push(`${path}: multiple literal API keys found for provider "${providerId}"; kept the first one.`);
	}
	return undefined;
}

function convertModel(
	raw: JsonObject,
	provider: JsonObject,
	providerId: string,
	warnings: string[],
	credentials: Map<string, Credential>,
	path: string,
	outputProvider: JsonObject = provider,
): JsonObject | undefined {
	// In the old Step schema `id` was a selectable profile alias while `model`
	// was the name sent over the wire. Pi has one identifier and sends it as the
	// API model name, so prefer the latter whenever both fields are present. The
	// alias is retained as a display name/internal marker so activeModel pointers
	// from the old config continue to resolve.
	const legacyId = asString(raw.id);
	const wireModel = asString(raw.model);
	const id = wireModel ?? legacyId;
	if (!id) {
		warnings.push(`${path}: skipped model without an id or model name.`);
		return undefined;
	}
	if (legacyId && wireModel && legacyId !== wireModel) {
		warnings.push(
			`${path}.model: using "${wireModel}" as the Pi model id; legacy id "${legacyId}" is a display alias.`,
		);
	}

	const providerApi = readLegacyApi(provider.api, providerId);
	const apiValue = asString(raw.api) ?? providerApi;
	const api = deriveLegacyApi(providerId, providerApi, apiValue);
	if (apiValue && apiValue !== api) {
		warnings.push(`${path}.api: mapped legacy API "${apiValue}" to Pi "${api}".`);
	}
	const rawParams =
		asObject(raw.samplingParams) ??
		asObject(raw.params) ??
		asObject(provider.samplingParams) ??
		asObject(provider.params);
	const model: JsonObject = {
		id,
		name: asString(raw.name) ?? asString(raw.description) ?? (legacyId !== id ? legacyId : undefined),
		api,
		baseUrl: normalizeBaseUrlForPiApi(
			asString(raw.baseUrl) ?? asString(provider.baseUrl),
			api,
			warnings,
			`${path}.baseUrl`,
		),
		reasoning: asBoolean(raw.reasoning) ?? (asObject(raw.reasoning)?.effort !== undefined ? true : undefined),
		input: Array.isArray(raw.input) ? structuredClone(raw.input) : undefined,
		cost: asObject(raw.cost) ? structuredClone(raw.cost) : undefined,
		contextWindow:
			asNumber(raw.contextWindow) ??
			readTokenLimit(raw, "maxContext", "contextWindow") ??
			readTokenLimit(provider, "maxContext", "contextWindow"),
		maxTokens:
			asNumber(raw.maxTokens) ??
			readTokenLimit(raw, "maxOutput", "maxTokens") ??
			readTokenLimit(provider, "maxOutput", "maxTokens"),
		samplingParams:
			rawParams && api && (api === "openai-completions" || api === "openai-responses")
				? structuredClone(rawParams)
				: undefined,
		thinkingLevelMap: asObject(raw.thinkingLevelMap) ? structuredClone(raw.thinkingLevelMap) : undefined,
		headers: migrateHeaders(raw.headers, warnings, `${path}.headers`),
	};

	const key = addCredential(credentials, providerId, asString(raw.apiKey), warnings, `${path}.apiKey`);
	if (key) {
		// Pi has no per-model apiKey field. A reference is safe to retain at the
		// enclosing provider level; literal values were moved to auth.json above.
		// `provider` is often a source/inherited copy, so write to the provider
		// object that will actually be emitted into models.json.
		if (outputProvider.apiKey === undefined) outputProvider.apiKey = key;
		else warnings.push(`${path}.apiKey: dropped because the provider already has an API key.`);
	}
	if (rawParams && api && api !== "openai-completions" && api !== "openai-responses") {
		warnings.push(`${path}.params: dropped; Pi only applies samplingParams to OpenAI APIs.`);
	}
	if (raw.reasoning !== undefined && typeof raw.reasoning !== "boolean" && !asObject(raw.reasoning)?.effort) {
		warnings.push(`${path}.reasoning: unsupported legacy shape; preserved only as a reasoning capability flag.`);
	}
	if (raw.provider !== undefined) {
		warnings.push(`${path}.provider: moved to the enclosing Pi provider "${providerId}".`);
	}
	if (legacyId && legacyId !== id) model[LEGACY_MODEL_ID_MARKER] = legacyId;
	if (raw.default === true) model[LEGACY_DEFAULT_MARKER] = true;
	return compact(model);
}

function convertProvider(
	providerId: string,
	raw: JsonObject,
	warnings: string[],
	credentials: Map<string, Credential>,
	path: string,
): JsonObject {
	const providerApi = readLegacyApi(raw.api, providerId);
	const provider: JsonObject = {
		name: asString(raw.name),
		baseUrl: normalizeBaseUrlForPiApi(
			asString(raw.baseUrl),
			deriveLegacyApi(providerId, undefined, providerApi),
			warnings,
			`${path}.baseUrl`,
		),
		api: deriveLegacyApi(providerId, undefined, providerApi),
		authHeader: asBoolean(raw.authHeader),
		headers: migrateHeaders(raw.headers, warnings, `${path}.headers`),
	};
	const configuredKey = addCredential(credentials, providerId, asString(raw.apiKey), warnings, `${path}.apiKey`);
	if (configuredKey) provider.apiKey = configuredKey;
	if (raw.routeViaCloudTrace !== undefined) {
		warnings.push(`${path}.routeViaCloudTrace: dropped; Pi uses the Step provider trace adapter.`);
	}
	if (raw.oauth !== undefined) {
		warnings.push(`${path}.oauth: dropped; only Pi's supported OAuth providers can be registered.`);
	}

	const rawModels = Array.isArray(raw.models) ? raw.models : [];
	const models = rawModels
		.map((entry, index) => {
			const object = asObject(entry);
			return object
				? convertModel(object, raw, providerId, warnings, credentials, `${path}.models[${index}]`, provider)
				: undefined;
		})
		.filter((entry): entry is JsonObject => entry !== undefined);
	if (models.length > 0) provider.models = models;
	return compact(provider);
}

/** Add a converted model to a provider without replacing its existing catalog. */
function appendConvertedModel(provider: JsonObject, model: JsonObject): JsonObject {
	const current = Array.isArray(provider.models)
		? provider.models
				.map((entry) => (asObject(entry) ? structuredClone(entry) : undefined))
				.filter((entry): entry is JsonObject => entry !== undefined)
		: [];
	const id = asString(model.id);
	const existingIndex = id ? current.findIndex((entry) => asString(entry.id) === id) : -1;
	if (existingIndex >= 0) current[existingIndex] = model;
	else current.push(model);
	return compact({ ...provider, models: current });
}

function readLegacyRoot(root: JsonObject): {
	defaults: JsonObject;
	model: JsonObject;
	models: JsonObject[];
	providers: JsonObject;
} {
	const nestedDefaults = asObject(root.defaults);
	const defaults = mergeObjects(root, nestedDefaults ?? {});
	const rawModel = root.model;
	const model = asObject(rawModel) ?? (asString(rawModel) ? { model: asString(rawModel) } : {});
	const tokenValues = compact({
		maxContext: asNumber(model.maxContextTokens) ?? asNumber(defaults.maxContextTokens),
		maxOutput: asNumber(model.maxOutputTokens) ?? asNumber(defaults.maxOutputTokens),
	});
	const flatModel = compact({
		model: asString(model.model) ?? asString(defaults.model),
		provider: asString(model.provider) ?? asString(defaults.provider),
		api: asString(model.api) ?? asString(defaults.api),
		baseUrl: asString(model.baseUrl) ?? asString(defaults.baseUrl),
		apiKey: asString(model.apiKey) ?? asString(defaults.apiKey),
		reasoning:
			asObject(model.reasoning) ??
			(asString(defaults.reasoningEffort) ? { effort: asString(defaults.reasoningEffort) } : undefined),
		tokens: asObject(model.tokens) ?? (Object.keys(tokenValues).length > 0 ? tokenValues : undefined),
		params: asObject(model.params),
	});

	const providers: JsonObject = {};
	const rootProviders = asObject(root.providers);
	if (rootProviders) {
		for (const [id, value] of Object.entries(rootProviders)) {
			const provider = asObject(value);
			if (provider) providers[id] = provider;
		}
	}
	const nestedModelsProviders = asObject(asObject(root.models)?.providers);
	if (nestedModelsProviders) {
		for (const [id, value] of Object.entries(nestedModelsProviders)) {
			const provider = asObject(value);
			if (provider && !providers[id]) providers[id] = provider;
		}
	}

	const models = Array.isArray(root.models)
		? root.models.map(asObject).filter((entry): entry is JsonObject => entry !== undefined)
		: [];
	return { defaults, model: flatModel, models, providers };
}

function convertConfig(root: JsonObject): ConvertedConfig {
	const warnings: string[] = [];
	const credentials = new Map<string, Credential>();
	const parsed = readLegacyRoot(root);
	const legacyProxy =
		asObject(asObject(root.integrations)?.modelsProxy) ?? asObject(root.modelsProxy) ?? asObject(root.modelsproxy);
	const model = parsed.model;
	const hasLegacyModelInput =
		Object.keys(parsed.providers).length > 0 ||
		parsed.models.length > 0 ||
		hasMeaningfulValue(model) ||
		hasMeaningfulValue(legacyProxy) ||
		asString(root.activeModel) !== undefined;
	if (!hasLegacyModelInput) {
		for (const [key, value] of [
			["session", root.session],
			["tools", root.tools],
			["agent", root.agent],
			["clients", root.clients],
			["storage", root.storage],
			["telemetry", root.telemetry],
			["feedback", root.feedback],
			["voice", root.voice],
		] as const) {
			if (value !== undefined)
				warnings.push(`${key}: no direct Pi settings equivalent; kept in the source config only.`);
		}
		return {
			settings: {},
			models: { providers: {} },
			credentials,
			warnings,
			hasModelConfig: false,
			hasExplicitModelDefinitions: false,
		};
	}
	const modelsJson: JsonObject = { providers: {} };
	const outputProviders = modelsJson.providers as JsonObject;

	for (const [id, raw] of Object.entries(parsed.providers)) {
		const provider = asObject(raw);
		if (provider) outputProviders[id] = convertProvider(id, provider, warnings, credentials, `providers.${id}`);
	}

	const activeReference = splitModelReference(asString(root.activeModel));
	const modelReference = splitModelReference(asString(model.model));
	const activeModelName = activeReference.model ?? modelReference.model;
	const providerWithActive = activeModelName
		? Object.entries(outputProviders).find(
				([, provider]) =>
					Array.isArray(asObject(provider)?.models) &&
					(asObject(provider)?.models as unknown[]).some(
						(entry) =>
							asString(asObject(entry)?.id) === activeModelName ||
							asString(asObject(entry)?.model) === activeModelName ||
							asString(asObject(entry)?.[LEGACY_MODEL_ID_MARKER]) === activeModelName,
					),
			)?.[0]
		: undefined;
	const providerId =
		asString(model.provider) ??
		activeReference.provider ??
		modelReference.provider ??
		providerWithActive ??
		(Object.keys(outputProviders).length > 0
			? Object.keys(outputProviders)[0]
			: providerIdFor(asString(model.baseUrl) ?? asString(legacyProxy?.baseUrl), undefined));
	const existing = asObject(outputProviders[providerId]) ?? {};
	const proxyApiValue = readLegacyApi(legacyProxy?.api, providerId);
	const endpointApiValue = asString(model.api) ?? proxyApiValue ?? asString(existing.api);
	const endpointApi = deriveLegacyApi(providerId, proxyApiValue, endpointApiValue);
	const endpoint = compact({
		...existing,
		baseUrl: normalizeBaseUrlForPiApi(
			asString(model.baseUrl) ?? asString(legacyProxy?.baseUrl) ?? asString(existing.baseUrl),
			endpointApi,
			warnings,
			"model.baseUrl",
		),
		api: endpointApi,
	});
	if (endpointApiValue && endpoint.api !== endpointApiValue) {
		warnings.push(`model.api: mapped legacy API "${endpointApiValue}" to Pi "${endpoint.api}".`);
	}
	const singularApiKey = asString(model.apiKey) ?? asString(legacyProxy?.apiKey);
	const singularReference = addCredential(credentials, providerId, singularApiKey, warnings, "model.apiKey");
	if (singularReference) endpoint.apiKey = singularReference;

	// `integrations.modelsProxy.models` was shadowed by the singular model block
	// in the old resolver. Keep it only when there is no real models[] list and
	// no singular model to preserve, and report the otherwise dead values.
	const proxyModels = Array.isArray(legacyProxy?.models)
		? legacyProxy.models
				.map((entry) => (typeof entry === "string" ? { id: entry, model: entry } : asObject(entry)))
				.filter((entry): entry is JsonObject => entry !== undefined)
		: [];
	if (proxyModels.length > 0 && (parsed.models.length > 0 || activeModelName)) {
		warnings.push("integrations.modelsProxy.models: dropped because the legacy model selection outranked it.");
	}
	// Provider declarations are already converted above. Keep that catalog intact
	// when the legacy `activeModel` points at one of its profile aliases. Older
	// code replaced the whole list with a synthetic `{ id: activeModel }` entry,
	// which changed the wire model name (for example `opus-5` -> `opus-5` instead
	// of the declared `claude-opus-5`) and made every other model disappear.
	//
	// A top-level `models[]` entry may override `provider`. Pi stores models under
	// that provider, so group entries before converting them. Entries without a
	// provider continue to inherit the singular model's provider and endpoint,
	// matching the old Step resolver.
	const inheritedProvider = { ...existing, ...endpoint, ...model };
	const explicitModelEntries = parsed.models.length > 0 || proxyModels.length > 0;
	const modelEntries = explicitModelEntries ? (parsed.models.length > 0 ? [...parsed.models] : proxyModels) : [];
	const hadDeclaredPrimaryProvider = Object.hasOwn(outputProviders, providerId);
	outputProviders[providerId] = compact({ ...existing, ...endpoint });

	const providerForEntry = (entry: JsonObject, index: number): { id: string; provider: JsonObject } => {
		const declaredProvider = asString(entry.provider);
		const targetId = declaredProvider ?? providerId;
		if (targetId === providerId) {
			return { id: targetId, provider: outputProviders[targetId] as JsonObject };
		}

		const targetExisting = asObject(outputProviders[targetId]) ?? {};
		const targetProxyApiValue = readLegacyApi(legacyProxy?.api, targetId);
		// An explicitly qualified legacy provider carried its own wire dialect.
		// Do not fall back to the singular model's API here: e.g. an `openai`
		// profile under an Anthropic default must remain OpenAI-compatible.
		const targetApiValue = asString(entry.api) ?? targetProxyApiValue ?? asString(targetExisting.api);
		const targetApi = deriveLegacyApi(targetId, targetProxyApiValue, targetApiValue);
		const targetBaseUrl =
			asString(entry.baseUrl) ??
			asString(targetExisting.baseUrl) ??
			asString(model.baseUrl) ??
			asString(legacyProxy?.baseUrl) ??
			asString(endpoint.baseUrl);
		const targetProvider = compact({
			...targetExisting,
			baseUrl: normalizeBaseUrlForPiApi(targetBaseUrl, targetApi, warnings, `models[${index}].baseUrl`),
			api: targetApi,
		});
		// A legacy named model inherited the active model's key. Duplicate that
		// credential for an explicitly qualified provider when the entry does not
		// provide its own key; otherwise the migrated model would be unavailable.
		if (entry.apiKey === undefined && targetExisting.apiKey === undefined) {
			const inheritedKey = asString(model.apiKey) ?? asString(legacyProxy?.apiKey);
			const keyReference = addCredential(credentials, targetId, inheritedKey, warnings, `models[${index}].apiKey`);
			if (keyReference && targetProvider.apiKey === undefined) targetProvider.apiKey = keyReference;
		}
		outputProviders[targetId] = targetProvider;
		return { id: targetId, provider: targetProvider };
	};

	for (const [index, entry] of modelEntries.entries()) {
		const target = providerForEntry(entry, index);
		const inherited = target.id === providerId ? inheritedProvider : { ...model, ...target.provider };
		const converted = convertModel(
			entry,
			inherited,
			target.id,
			warnings,
			credentials,
			`models[${index}]`,
			target.provider,
		);
		if (converted) outputProviders[target.id] = appendConvertedModel(target.provider, converted);
	}

	const hasModels = (provider: JsonObject | undefined): boolean =>
		Array.isArray(provider?.models) && provider.models.length > 0;
	// Do not leave a synthetic provider with only a derived `api` field when every
	// named model belongs to another provider. Such a config would make Pi reject
	// the empty provider before it can use the real catalog.
	if (
		!hadDeclaredPrimaryProvider &&
		!hasModels(asObject(outputProviders[providerId])) &&
		!asString(model.model) &&
		!asString(model.baseUrl) &&
		!asString(model.api) &&
		!asString(model.apiKey) &&
		!asString(legacyProxy?.baseUrl) &&
		!asString(legacyProxy?.apiKey) &&
		!asString(activeReference.provider) &&
		parsed.providers[providerId] === undefined
	) {
		delete outputProviders[providerId];
	}

	const findModelForLegacyHandle = (
		handle: string | undefined,
		preferredProvider?: string,
	): { providerId: string; model: JsonObject } | undefined => {
		if (!handle) return undefined;
		const providers = Object.entries(outputProviders);
		const ordered = preferredProvider
			? [
					...providers.filter(([id]) => id === preferredProvider),
					...providers.filter(([id]) => id !== preferredProvider),
				]
			: providers;
		for (const [id, provider] of ordered) {
			const entries = asObject(provider)?.models;
			if (!Array.isArray(entries)) continue;
			const modelEntry = entries.find(
				(entry) =>
					asString(asObject(entry)?.id) === handle ||
					asString(asObject(entry)?.model) === handle ||
					asString(asObject(entry)?.[LEGACY_MODEL_ID_MARKER]) === handle ||
					asString(asObject(entry)?.name) === handle,
			);
			if (asObject(modelEntry)) return { providerId: id, model: modelEntry as JsonObject };
		}
		return undefined;
	};

	let matching = findModelForLegacyHandle(activeModelName, activeReference.provider);
	if (activeModelName && !matching) {
		// Preserve the old singular/active model when no provider catalog entry can
		// satisfy it. This is the only case where the alias itself is a wire id.
		const targetId = activeReference.provider ?? providerId;
		const target = providerForEntry(
			{ provider: targetId, id: activeModelName, model: activeModelName },
			modelEntries.length,
		);
		const inherited = target.id === providerId ? inheritedProvider : { ...model, ...target.provider };
		const synthetic = convertModel(
			{ id: activeModelName, model: activeModelName },
			inherited,
			target.id,
			warnings,
			credentials,
			"model",
			target.provider,
		);
		if (synthetic) {
			outputProviders[target.id] = appendConvertedModel(target.provider, synthetic);
			matching = { providerId: target.id, model: synthetic };
		}
	}

	const defaultMatch =
		matching ??
		Object.entries(outputProviders)
			.flatMap(([id, provider]) =>
				(Array.isArray(asObject(provider)?.models) ? (asObject(provider)?.models as unknown[]) : [])
					.map((entry) => ({ providerId: id, model: asObject(entry) }))
					.filter((entry): entry is { providerId: string; model: JsonObject } => entry.model !== undefined),
			)
			.find((entry) => entry.model[LEGACY_DEFAULT_MARKER] === true) ??
		Object.entries(outputProviders)
			.flatMap(([id, provider]) =>
				(Array.isArray(asObject(provider)?.models) ? (asObject(provider)?.models as unknown[]) : [])
					.map((entry) => ({ providerId: id, model: asObject(entry) }))
					.filter((entry): entry is { providerId: string; model: JsonObject } => entry.model !== undefined),
			)
			.at(0);
	const activeModel = asString(defaultMatch?.model.id) ?? activeModelName;
	const defaultProvider = activeModel
		? (defaultMatch?.providerId ?? activeReference.provider ?? providerId)
		: undefined;
	const settings: JsonObject = compact({
		defaultProvider,
		defaultModel: activeModel,
	});
	const effort = asString(asObject(model.reasoning)?.effort) ?? asString(parsed.defaults.reasoningEffort);
	if (effort && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(effort)) {
		settings.defaultThinkingLevel = effort;
	} else if (effort) {
		warnings.push(`model.reasoning.effort: unsupported Pi thinking level "${effort}"; omitted.`);
	}
	const retries =
		asNumber(asObject(asObject(root.agent)?.retries)?.modelRequest) ?? asNumber(parsed.defaults.modelRequestRetries);
	if (retries !== undefined) settings.retry = { provider: { maxRetries: Math.max(0, Math.floor(retries)) } };

	for (const [key, value] of [
		["session", root.session],
		["tools", root.tools],
		["agent", root.agent],
		["clients", root.clients],
		["storage", root.storage],
		["telemetry", root.telemetry],
		["feedback", root.feedback],
		["voice", root.voice],
	] as const) {
		if (value !== undefined)
			warnings.push(`${key}: no direct Pi settings equivalent; kept in the source config only.`);
	}
	if (asObject(root.extensions)?.surface !== undefined)
		warnings.push("extensions.surface: no direct Pi settings equivalent; kept in the source config only.");

	// Remove the internal marker before writing the Pi file. It is used only to
	// choose the active profile during conversion.
	for (const provider of Object.values(outputProviders)) {
		const entries = asObject(provider)?.models;
		if (!Array.isArray(entries)) continue;
		for (const entry of entries) {
			if (!asObject(entry)) continue;
			delete entry[LEGACY_MODEL_ID_MARKER];
			delete entry[LEGACY_DEFAULT_MARKER];
		}
	}

	return {
		settings,
		models: modelsJson,
		credentials,
		warnings,
		hasModelConfig:
			Object.keys(settings).length > 0 || Object.keys(outputProviders).length > 0 || credentials.size > 0,
		hasExplicitModelDefinitions:
			parsed.models.length > 0 ||
			proxyModels.length > 0 ||
			Object.keys(parsed.providers).length > 0 ||
			Boolean(
				asString(model.model) ||
					asString(model.api) ||
					asString(model.baseUrl) ||
					asObject(model.tokens) ||
					asObject(model.params),
			),
		defaultProvider,
		defaultModel: activeModel,
	};
}

function hasConfiguredProviderKey(conversion: RootConversion, providerId: string): boolean {
	if (conversion.credentials.has(providerId)) return true;
	const providers = asObject(conversion.models.providers);
	const provider = asObject(providers?.[providerId]);
	const configured = asString(provider?.apiKey);
	return configured !== undefined && configured !== "<your_api_key>";
}

function hasStepCredential(value: unknown): boolean {
	const credential = asObject(value);
	return credential?.type === "oauth" || credential?.type === "api_key";
}

const STEP_BUILTIN_MODEL_IDS = new Set(STEP_MODELS.map((model) => model.id.toLowerCase()));

function isStepBuiltinModel(value: string | undefined): boolean {
	return value !== undefined && STEP_BUILTIN_MODEL_IDS.has(value.toLowerCase());
}

/**
 * Repair a built-in Step model that was written by the legacy provider
 * projection. The old config treated `provider` as a vendor/route alias and
 * could therefore leave `step-3.7-flash` with an OpenAI API or a complete
 * operation URL. Pi's Step provider owns these ids and always speaks the
 * Anthropic Messages dialect from its canonical route prefix.
 */
function normalizeStepBuiltinProvider(
	provider: JsonObject,
	canonicalBaseUrl: string,
	warnings: string[],
	path: string,
): boolean {
	const entries = Array.isArray(provider.models)
		? provider.models.map((entry) => asObject(entry)).filter((entry): entry is JsonObject => entry !== undefined)
		: [];
	const builtinEntries = entries.filter((entry) => isStepBuiltinModel(asString(entry.id)));
	if (builtinEntries.length === 0) return false;

	let changed = false;
	if (asString(provider.api) !== "anthropic-messages") {
		provider.api = "anthropic-messages";
		changed = true;
		warnings.push(`${path}.api: normalized the built-in Step catalog to Pi "anthropic-messages".`);
	}
	const providerBaseUrl = asString(provider.baseUrl);
	if (!providerBaseUrl || (!isConfigReference(providerBaseUrl) && providerBaseUrl !== canonicalBaseUrl)) {
		provider.baseUrl = canonicalBaseUrl;
		changed = true;
		warnings.push(`${path}.baseUrl: normalized the built-in Step catalog endpoint.`);
	}
	for (const [index, entry] of entries.entries()) {
		if (!isStepBuiltinModel(asString(entry.id))) continue;
		if (asString(entry.api) !== "anthropic-messages") {
			entry.api = "anthropic-messages";
			changed = true;
			warnings.push(`${path}.models[${index}].api: normalized the built-in Step model API.`);
		}
		const modelBaseUrl = asString(entry.baseUrl);
		if (!modelBaseUrl) {
			entry.baseUrl = canonicalBaseUrl;
			changed = true;
		} else if (!isConfigReference(modelBaseUrl) && modelBaseUrl !== canonicalBaseUrl) {
			entry.baseUrl = canonicalBaseUrl;
			changed = true;
		}
	}
	return changed;
}

/** Providers that were commonly used as a wire/endpoint alias by legacy Step. */
function isLegacyStepProvider(value: string | undefined): boolean {
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return (
		normalized === "models-proxy" ||
		normalized.startsWith("models-proxy-") ||
		normalized === "modelsproxy" ||
		// `providerIdFor()` derives the first host label when a legacy config
		// omits `provider`; Step's public endpoint therefore becomes `api`.
		normalized === "api" ||
		normalized === "stepfunmodelproxy" ||
		normalized === "stepfun-model-proxy" ||
		normalized === "neocodex" ||
		normalized === "anthropic" ||
		normalized === "openai" ||
		normalized === "response"
	);
}

function hasConfiguredProviderApiKey(provider: JsonObject | undefined): boolean {
	const key = asString(provider?.apiKey);
	return key !== undefined && key !== "<your_api_key>";
}

function canonicalStepBaseUrl(env: Record<string, string | undefined>): string {
	// Keep an explicit endpoint override effective while repairing old files. If
	// an override is malformed, leave it to the provider resolver's normal
	// diagnostics rather than persisting a malformed repair target.
	const configured =
		env.STEP_PROVIDER_API_URL?.trim() ||
		env.STEP_API_URL?.trim() ||
		env.STEP_BASE_URL?.trim() ||
		env.STEPFUN_MESSAGES_ENDPOINT?.trim() ||
		env.STEP_CLI_STEP_PLAN_API_URL?.trim();
	if (!configured) return STEP_PROVIDER_DEFAULTS.apiBaseUrl;
	const normalized = normalizeStepAnthropicBaseUrl(configured);
	try {
		const parsed = new URL(normalized);
		if (parsed.protocol === "http:" || parsed.protocol === "https:") return normalized;
	} catch {
		// Fall through to the production default.
	}
	return STEP_PROVIDER_DEFAULTS.apiBaseUrl;
}

interface StepBindingRepairOptions {
	settingsPath: string;
	modelsPath: string;
	authPath: string;
	stepApiKey?: string;
	canonicalBaseUrl: string;
	warnings: string[];
}

/**
 * Repair a late-imported Step login without replaying the whole legacy config.
 *
 * A first launch can write the migration marker before the user completes
 * browser login. On the next launch Pi would otherwise keep a legacy
 * `models-proxy` provider as the default and send the Step credential to that
 * endpoint. Only built-in Step model ids and providers without an explicit
 * configured key are eligible; deliberate proxy configurations remain intact.
 */
async function repairStepLoginBinding(options: StepBindingRepairOptions): Promise<boolean> {
	const auth = await readJson(options.authPath);
	if (!hasStepCredential(auth.value?.[STEP_PROVIDER_ID]) && !options.stepApiKey?.trim()) return false;

	const settings = await readJson(options.settingsPath);
	if (settings.error || !settings.value) return false;
	const defaultModel = asString(settings.value.defaultModel);
	const defaultProvider = asString(settings.value.defaultProvider);
	if (!isStepBuiltinModel(defaultModel)) return false;

	let changed = false;
	let modelsChanged = false;
	if (defaultProvider && defaultProvider !== STEP_PROVIDER_ID && isLegacyStepProvider(defaultProvider)) {
		const models = await readJson(options.modelsPath);
		const provider = asObject(asObject(models.value?.providers)?.[defaultProvider]);
		if (!hasConfiguredProviderApiKey(provider)) {
			settings.value.defaultProvider = STEP_PROVIDER_ID;
			changed = true;
			options.warnings.push(
				`${options.settingsPath}: rebound default model "${defaultModel}" from legacy provider "${defaultProvider}" to "${STEP_PROVIDER_ID}" for the stored Step login.`,
			);
		}
	}

	// If an earlier migration already projected the provider to `step`, its
	// provider/model entries may still carry the old proxy host. Make those
	// entries inherit the same canonical endpoint as the native Step extension.
	const models = await readJson(options.modelsPath);
	const providers = asObject(models.value?.providers);
	const stepProvider = asObject(providers?.[STEP_PROVIDER_ID]);
	if (models.value && providers && stepProvider && !hasConfiguredProviderApiKey(stepProvider)) {
		const currentBaseUrl = asString(stepProvider.baseUrl);
		if (currentBaseUrl && !isConfigReference(currentBaseUrl) && currentBaseUrl !== options.canonicalBaseUrl) {
			stepProvider.baseUrl = options.canonicalBaseUrl;
			changed = true;
			modelsChanged = true;
			options.warnings.push(
				`${options.modelsPath}: normalized the Step provider endpoint for the stored Step login.`,
			);
		}
		if (
			normalizeStepBuiltinProvider(
				stepProvider,
				options.canonicalBaseUrl,
				options.warnings,
				`${options.modelsPath}.providers.step`,
			)
		) {
			changed = true;
			modelsChanged = true;
		}
	}

	if (changed && settings.value.defaultProvider !== defaultProvider) {
		try {
			await writeFile(options.settingsPath, `${JSON.stringify(settings.value, null, 2)}\n`, { encoding: "utf8" });
		} catch (error) {
			options.warnings.push(
				`${options.settingsPath}: could not persist the Step provider repair (${error instanceof Error ? error.message : String(error)}).`,
			);
		}
	}
	if (modelsChanged && models.value && providers && stepProvider) {
		// Only write models.json when the endpoint repair changed it. A
		// settings-only repair must not clobber concurrent catalog edits.
		try {
			await writeFile(options.modelsPath, `${JSON.stringify(models.value, null, 2)}\n`, { encoding: "utf8" });
		} catch (error) {
			options.warnings.push(
				`${options.modelsPath}: could not persist the Step endpoint repair (${error instanceof Error ? error.message : String(error)}).`,
			);
		}
	}
	return changed;
}

/**
 * A legacy Step login was keyed by the product profile, while config.json
 * called the wire dialect's provider `anthropic`, `openai`, or `response`.
 * Pi treats that value as the credential owner, so project the active catalog
 * onto Step when the old provider did not carry its own explicit key.
 */
function projectStepCredentialProvider(
	conversion: RootConversion,
	stepCredentialAvailable: boolean,
	warnings: string[],
): void {
	if (!stepCredentialAvailable) return;
	const providerId = conversion.defaultProvider;
	if (!providerId || providerId === STEP_PROVIDER_ID || hasConfiguredProviderKey(conversion, providerId)) return;
	const providers = asObject(conversion.models.providers);
	if (!providers) return;
	const source = asObject(providers[providerId]);
	if (!source) return;
	const target = asObject(providers[STEP_PROVIDER_ID]);
	providers[STEP_PROVIDER_ID] = target ? mergeProviderCatalog(target, source) : structuredClone(source);
	delete providers[providerId];
	conversion.defaultProvider = STEP_PROVIDER_ID;
	conversion.settings.defaultProvider = STEP_PROVIDER_ID;
	warnings.push(
		`legacy Step credential: projected provider "${providerId}" as "${STEP_PROVIDER_ID}" so the migrated model and login use the same provider.`,
	);
}

/**
 * The legacy resolver applied the active model's credential to model profiles
 * that omitted their own `apiKey`, even when a profile selected another wire
 * provider. Pi keys credentials by provider, so preserve that inheritance by
 * adding the same credential for those providers. Explicit profile/provider
 * keys always win and are never replaced.
 */
function copyInheritedLegacyCredential(
	conversion: RootConversion,
	sourceCredentials: Map<string, Credential>,
	warnings: string[],
): void {
	const providers = asObject(conversion.models.providers);
	if (!providers) return;

	const inherited =
		sourceCredentials.get(STEP_PROVIDER_ID) ??
		(conversion.defaultProvider ? sourceCredentials.get(conversion.defaultProvider) : undefined);
	if (!inherited) return;

	for (const [providerId, rawProvider] of Object.entries(providers)) {
		if (
			providerId === STEP_PROVIDER_ID ||
			sourceCredentials.has(providerId) ||
			conversion.credentials.has(providerId)
		) {
			continue;
		}
		const provider = asObject(rawProvider);
		if (!provider || !Array.isArray(provider.models) || provider.models.length === 0) continue;
		if (hasConfiguredProviderKey(conversion, providerId)) continue;
		// Step's product login is represented as OAuth for the Step provider, but
		// Pi's built-in wire providers expose API-key auth only. Re-encode the
		// shared access token in the credential shape those providers can resolve.
		const providerCredential: Credential =
			inherited.type === "oauth" ? { type: "api_key", key: inherited.access } : structuredClone(inherited);
		sourceCredentials.set(providerId, providerCredential);
		warnings.push(
			`legacy credential inheritance: copied the default credential to provider "${providerId}" because its models did not declare an API key.`,
		);
	}
}

interface ReadJsonResult {
	exists: boolean;
	value?: JsonObject;
	error?: Error;
}

async function readJson(filePath: string): Promise<ReadJsonResult> {
	try {
		const content = await readFile(filePath, "utf8");
		const parsed = JSON.parse(content) as unknown;
		const value = asObject(parsed);
		return value ? { exists: true, value } : { exists: true, error: new Error("expected a JSON object") };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
		return { exists: true, error: error instanceof Error ? error : new Error(String(error)) };
	}
}

/**
 * Repair endpoint spellings left by older Step releases.
 *
 * Pi's Anthropic adapter appends `/v1/messages` to every model base URL. A
 * models.json written before the Step provider wrapper was introduced can
 * therefore keep `/v1` (or the complete `/v1/messages` operation URL) and
 * override the corrected provider default at runtime. Built-in Step ids are
 * also repaired when an older projection recorded them as OpenAI models;
 * custom providers and non-Step model ids retain their original semantics.
 */
export async function normalizeStepModelsFile(
	targetPath: string,
	warnings: string[] = [],
	canonicalBaseUrl: string = STEP_PROVIDER_DEFAULTS.apiBaseUrl,
): Promise<boolean> {
	let content: string;
	try {
		content = await readFile(targetPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		return false;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(stripJsonComments(stripBom(content)));
	} catch {
		// ModelConfig will surface the regular parse diagnostic. Do not make a
		// repair pass turn a launch into a second, less useful error.
		return false;
	}
	const root = asObject(parsed);
	const providers = asObject(root?.providers);
	const provider = asObject(providers?.[STEP_PROVIDER_ID]);
	if (!root || !providers || !provider) return false;

	const entries = Array.isArray(provider.models)
		? provider.models.map((entry) => asObject(entry)).filter((entry): entry is JsonObject => entry !== undefined)
		: [];
	const declaredApi = asString(provider.api);
	// Built-in Step ids are product-owned even when a prior migration copied the
	// old `models-proxy` wire metadata into this provider. Normalize the provider
	// and those entries before applying the more general URL-only repair below.
	const builtinChanged = normalizeStepBuiltinProvider(
		provider,
		canonicalBaseUrl,
		warnings,
		`${targetPath}.providers.${STEP_PROVIDER_ID}`,
	);
	// The Step extension supplies Anthropic as the provider default when the
	// user file omits `api`. Mirror that composition rule even if the catalog
	// also contains an explicitly configured OpenAI model.
	const inferredAnthropic = declaredApi === "anthropic-messages" || declaredApi === undefined;
	let changed = builtinChanged;
	const normalizeField = (entry: JsonObject, path: string, api: string | undefined): void => {
		if (api !== "anthropic-messages") return;
		const value = asString(entry.baseUrl);
		if (!value) return;
		const normalized = normalizeStepAnthropicBaseUrl(value);
		if (normalized === value) return;
		entry.baseUrl = normalized;
		changed = true;
		warnings.push(`${path}: normalized the Step Anthropic endpoint for Pi.`);
	};

	if (inferredAnthropic)
		normalizeField(provider, `${targetPath}.providers.${STEP_PROVIDER_ID}.baseUrl`, "anthropic-messages");
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		const api = asString(entry.api) ?? (inferredAnthropic ? "anthropic-messages" : declaredApi);
		normalizeField(entry, `${targetPath}.providers.${STEP_PROVIDER_ID}.models[${index}].baseUrl`, api);
	}

	if (!changed) return false;
	try {
		await writeFile(targetPath, `${JSON.stringify(root, null, 2)}\n`, { encoding: "utf8" });
		return true;
	} catch (error) {
		warnings.push(
			`${targetPath}: could not persist the normalized Step endpoint (${error instanceof Error ? error.message : String(error)}).`,
		);
		return false;
	}
}

function asCredential(value: JsonObject): Credential | undefined {
	if (value.type === "api_key") {
		const key = value.key;
		return key === undefined || typeof key === "string" ? (structuredClone(value) as Credential) : undefined;
	}
	if (
		value.type === "oauth" &&
		typeof value.access === "string" &&
		typeof value.refresh === "string" &&
		typeof value.expires === "number" &&
		Number.isFinite(value.expires)
	) {
		return structuredClone(value) as Credential;
	}
	return undefined;
}

function addLegacyCredential(
	credentials: Map<string, Credential>,
	providerId: string,
	credential: Credential,
	warnings: string[],
	path: string,
): void {
	if (!credentials.has(providerId)) {
		credentials.set(providerId, credential);
		return;
	}
	warnings.push(`${path}: multiple credentials found for provider "${providerId}"; kept the first one.`);
}

/** Convert both old `{ apiKey }` files and Pi-shaped credential maps. */
function collectLegacyCredentials(
	value: JsonObject,
	defaultProvider: string,
	credentials: Map<string, Credential>,
	warnings: string[],
	path: string,
): boolean {
	let found = false;
	const topLevelKey = asString(value.apiKey);
	if (topLevelKey && topLevelKey !== "<your_api_key>") {
		// The product-owned auth format carried `version`/`profile` alongside the
		// key. That is an OAuth-shaped Step account credential in the new runtime,
		// even though the old file called it an API key. Keep the account id and use
		// the non-expiring static refresh marker understood by the Step provider.
		// Files containing only `{ apiKey }` predate that format and are treated as
		// generic API-key config for the provider selected by the model.
		const isProductCredential = value.version !== undefined || asString(value.profile) !== undefined;
		const providerId = isProductCredential ? STEP_PROVIDER_ID : defaultProvider;
		const uid = asString(value.uid);
		const credential: Credential = isProductCredential
			? {
					type: "oauth",
					access: topLevelKey,
					refresh: STEP_STATIC_REFRESH_TOKEN,
					expires: Number.MAX_SAFE_INTEGER,
					...(uid ? { uid } : undefined),
				}
			: { type: "api_key", key: topLevelKey };
		addLegacyCredential(credentials, providerId, credential, warnings, `${path}.apiKey`);
		found = true;
	}
	for (const [providerId, raw] of Object.entries(value)) {
		if (["version", "profile", "apiKey", "obtainedAt", "uid"].includes(providerId)) continue;
		const object = asObject(raw);
		if (!object) continue;
		const credential = asCredential(object);
		if (!credential) continue;
		addLegacyCredential(credentials, providerId, credential, warnings, `${path}.${providerId}`);
		found = true;
	}
	return found;
}

async function readConfigFile(root: string): Promise<{ path: string; value: JsonObject } | undefined> {
	for (const name of CONFIG_CANDIDATES) {
		const path = join(root, name);
		try {
			const content = await readFile(path, "utf8");
			const parsed = name.endsWith("json") ? JSON.parse(content) : parseYaml(content);
			const value = asObject(parsed);
			if (value) return { path, value };
			return undefined;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return undefined;
}

/** Return whether a path exists without turning permission errors into throws. */
async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Preserve legacy input files in a sibling archive. The archive is additive:
 * an existing copy is never overwritten, so a second launch cannot destroy a
 * recoverable first-launch snapshot.
 */
async function archiveSelectedFiles(
	sourceRoot: string,
	relativePaths: readonly string[],
	warnings: string[],
): Promise<void> {
	const archiveRoot = `${sourceRoot}.bak`;
	const copied: string[] = [];
	try {
		for (const relativePath of relativePaths) {
			const sourcePath = join(sourceRoot, relativePath);
			if (!(await pathExists(sourcePath))) continue;
			const destination = join(archiveRoot, relativePath);
			if (await pathExists(destination)) continue;
			await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
			await copyFile(sourcePath, destination);
			await chmod(destination, 0o600);
			copied.push(relativePath);
		}
		if (copied.length > 0) {
			await mkdir(archiveRoot, { recursive: true, mode: 0o700 });
			const manifestPath = join(archiveRoot, "backup.json");
			if (!(await pathExists(manifestPath))) {
				await writeFile(
					manifestPath,
					`${JSON.stringify({ source: sourceRoot, createdAt: new Date().toISOString(), files: copied }, null, 2)}\n`,
					{ encoding: "utf8", mode: 0o600 },
				);
			}
		}
	} catch (error) {
		warnings.push(
			`${archiveRoot}: could not preserve legacy files (${error instanceof Error ? error.message : String(error)}).`,
		);
	}
}

/** Copy a retired namespace for rollback while deliberately excluding sessions. */
async function archiveLegacyDirectory(sourceRoot: string, warnings: string[]): Promise<void> {
	const archiveRoot = `${sourceRoot}.bak`;
	const copied: string[] = [];
	const walk = async (current: string, relativeDirectory: string): Promise<void> => {
		let entries: Dirent[];
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const relativePath = relativeDirectory ? join(relativeDirectory, entry.name) : entry.name;
			if (entry.name === "sessions" || entry.name.endsWith(".bak")) continue;
			const sourcePath = join(current, entry.name);
			if (entry.isDirectory()) {
				await walk(sourcePath, relativePath);
				continue;
			}
			if (!entry.isFile()) continue;
			const destination = join(archiveRoot, relativePath);
			if (await pathExists(destination)) continue;
			try {
				await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
				await copyFile(sourcePath, destination);
				await chmod(destination, 0o600);
				copied.push(relativePath);
			} catch (error) {
				warnings.push(
					`${sourcePath}: could not preserve legacy file (${error instanceof Error ? error.message : String(error)}).`,
				);
			}
		}
	};
	await walk(sourceRoot, "");
	if (copied.length === 0) return;
	try {
		await mkdir(archiveRoot, { recursive: true, mode: 0o700 });
		const manifestPath = join(archiveRoot, "backup.json");
		if (!(await pathExists(manifestPath))) {
			await writeFile(
				manifestPath,
				`${JSON.stringify({ source: sourceRoot, createdAt: new Date().toISOString(), files: copied, excluded: ["sessions"] }, null, 2)}\n`,
				{ encoding: "utf8", mode: 0o600 },
			);
		}
	} catch (error) {
		warnings.push(
			`${archiveRoot}: could not persist backup manifest (${error instanceof Error ? error.message : String(error)}).`,
		);
	}
}

async function mergeAuthFile(
	targetPath: string,
	sourceRoots: Array<{ path: string; provider: string }>,
	converted: Map<string, Credential>,
	warnings: string[],
): Promise<boolean> {
	const target = await readJson(targetPath);
	if (target.error) {
		warnings.push(`${targetPath}: existing auth.json was not valid JSON; left untouched.`);
		return false;
	}
	const merged: JsonObject = target.value ? structuredClone(target.value) : {};
	let changed = false;
	const add = (provider: string, credential: Credential): void => {
		if (merged[provider] !== undefined) return;
		merged[provider] = structuredClone(credential);
		changed = true;
	};
	for (const source of sourceRoots) {
		const result = await readJson(join(source.path, "auth.json"));
		if (!result.exists) continue;
		if (result.error || !result.value) {
			warnings.push(`${join(source.path, "auth.json")}: could not parse legacy credentials; skipped.`);
			continue;
		}
		const sourceCredentials = new Map<string, Credential>();
		collectLegacyCredentials(
			result.value,
			source.provider,
			sourceCredentials,
			warnings,
			join(source.path, "auth.json"),
		);
		for (const [provider, credential] of sourceCredentials) add(provider, credential);
	}
	for (const [provider, credential] of converted) add(provider, credential);
	if (!changed) return false;
	try {
		await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
		await writeFile(targetPath, `${JSON.stringify(merged, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		return true;
	} catch (error) {
		warnings.push(
			`${targetPath}: could not persist migrated credentials (${error instanceof Error ? error.message : String(error)}).`,
		);
		return false;
	}
}

/**
 * Complete a credential-only migration after the model projection marker was
 * written. Login can happen in a separate process (or be restored from a
 * backup) after the first launch, so a completed model marker must not make an
 * old auth.json permanently invisible. No config/model files are read or
 * rewritten in this path.
 */
async function migrateMarkedAuth(
	sourceRoot: string,
	targetRoot: string,
	scope: "global" | "project",
	globalAuthPath: string | undefined,
	env: Record<string, string | undefined> = process.env,
): Promise<{ migrated: boolean; warnings: string[] }> {
	const warnings: string[] = [];

	const targetSettingsPath =
		scope === "global" ? join(targetRoot, "agent", "settings.json") : join(targetRoot, "settings.json");
	const targetSettings = await readJson(targetSettingsPath);
	const defaultProvider = asString(targetSettings.value?.defaultProvider) ?? STEP_PROVIDER_ID;
	const sourceRoots = [
		{ path: sourceRoot, provider: defaultProvider },
		{ path: join(sourceRoot, "agent"), provider: defaultProvider },
	];
	const credentials = new Map<string, Credential>();
	for (const source of sourceRoots) {
		const path = join(source.path, "auth.json");
		const result = await readJson(path);
		if (!result.exists) continue;
		if (result.error || !result.value) {
			warnings.push(`${path}: could not parse legacy credentials; skipped.`);
			continue;
		}
		collectLegacyCredentials(result.value, source.provider, credentials, warnings, path);
	}
	const targetAuthPath =
		globalAuthPath ?? join(scope === "global" ? join(targetRoot, "agent") : targetRoot, "auth.json");
	const migrated = credentials.size > 0 ? await mergeAuthFile(targetAuthPath, [], credentials, warnings) : false;
	const targetAgentRoot = scope === "global" ? join(targetRoot, "agent") : dirname(targetAuthPath);
	const repaired = await repairStepLoginBinding({
		settingsPath: targetSettingsPath,
		modelsPath: join(dirname(globalAuthPath ?? join(targetAgentRoot, "auth.json")), "models.json"),
		authPath: targetAuthPath,
		stepApiKey: env.STEP_API_KEY,
		canonicalBaseUrl: canonicalStepBaseUrl(env),
		warnings,
	});
	return { migrated: migrated || repaired, warnings };
}

/** Add only missing model defaults to an existing Pi settings file. */
async function mergeSettingsFile(targetPath: string, settings: JsonObject, warnings: string[]): Promise<boolean> {
	if (Object.keys(settings).length === 0) return false;
	const target = await readJson(targetPath);
	if (target.error) {
		warnings.push(`${targetPath}: existing settings.json was not valid JSON; left untouched.`);
		return false;
	}
	const current = target.value ?? {};
	const merged = mergeObjects(settings, current);
	if (target.value && JSON.stringify(current) === JSON.stringify(merged)) return false;
	try {
		await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
		await writeFile(targetPath, `${JSON.stringify(merged, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		return true;
	} catch (error) {
		warnings.push(
			`${targetPath}: could not persist migrated defaults (${error instanceof Error ? error.message : String(error)}).`,
		);
		return false;
	}
}

/** Add legacy providers/models without overwriting an existing Pi catalog. */
async function writeModelsFile(targetPath: string, models: JsonObject, warnings: string[]): Promise<boolean> {
	const providers = asObject(models.providers);
	if (!providers || Object.keys(providers).length === 0) return false;
	const target = await readJson(targetPath);
	if (target.error) {
		if (target.exists) warnings.push(`${targetPath}: existing models.json was not valid JSON; left untouched.`);
		return false;
	}
	const merged = target.value ? structuredClone(target.value) : {};
	const existingProviders = asObject(merged.providers) ?? {};
	let changed = false;
	for (const [providerId, rawProvider] of Object.entries(providers)) {
		const provider = asObject(rawProvider);
		if (!provider) continue;
		const existing = asObject(existingProviders[providerId]);
		if (!existing) {
			existingProviders[providerId] = structuredClone(provider);
			changed = true;
			continue;
		}
		for (const [key, value] of Object.entries(provider)) {
			if (existing[key] !== undefined || key === "models") continue;
			existing[key] = structuredClone(value);
			changed = true;
		}
		const sourceModels = Array.isArray(provider.models) ? provider.models : [];
		const targetModels = Array.isArray(existing.models) ? existing.models : [];
		const knownIds = new Set(
			targetModels.map((entry) => asString(asObject(entry)?.id)).filter((id): id is string => id !== undefined),
		);
		for (const model of sourceModels) {
			const id = asString(asObject(model)?.id);
			if (!id || knownIds.has(id)) continue;
			targetModels.push(structuredClone(model));
			knownIds.add(id);
			changed = true;
		}
		if (targetModels.length > 0 && !Array.isArray(existing.models)) {
			existing.models = targetModels;
			changed = true;
		}
		for (const key of ["modelOverrides"] as const) {
			const sourceOverrides = asObject(provider[key]);
			if (!sourceOverrides) continue;
			const targetOverrides = asObject(existing[key]) ?? {};
			for (const [modelId, override] of Object.entries(sourceOverrides)) {
				if (targetOverrides[modelId] === undefined) {
					targetOverrides[modelId] = structuredClone(override);
					changed = true;
				}
			}
			if (Object.keys(targetOverrides).length > 0 && !existing[key]) {
				existing[key] = targetOverrides;
				changed = true;
			}
		}
	}
	if (!changed) return false;
	merged.providers = existingProviders;
	try {
		await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
		await writeFile(targetPath, `${JSON.stringify(merged, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		return true;
	} catch (error) {
		warnings.push(
			`${targetPath}: could not persist migrated models (${error instanceof Error ? error.message : String(error)}).`,
		);
		return false;
	}
}

async function migrateRoot(
	sourceRoot: string,
	targetRoot: string,
	scope: "global" | "project",
	targetAgentRoot?: string,
	/** Pi's model catalog is global even when the source config is project-local. */
	modelsAgentRoot?: string,
	globalAuthPath?: string,
	env: Record<string, string | undefined> = process.env,
	markerName = STEP_LEGACY_MIGRATION_MARKER,
): Promise<StepConfigMigrationRootReport & { defaults?: { provider?: string; model?: string } }> {
	const warnings: string[] = [];
	const report = {
		scope,
		source: sourceRoot,
		target: targetRoot,
		migrated: false,
		warnings,
	} as StepConfigMigrationRootReport & {
		defaults?: { provider?: string; model?: string };
	};
	const sameRoot = resolve(sourceRoot) === resolve(targetRoot);
	// Once the model/settings projection completed, do not replay those files over
	// user edits. Credentials are different: an old login file may be created or
	// restored later, so perform a small idempotent auth-only pass in that case.
	// A malformed/older marker is ignored so an interrupted migration can retry in
	// full.
	if (await hasMigrationMarker(targetRoot, sourceRoot, markerName)) {
		const authOnly = await migrateMarkedAuth(sourceRoot, targetRoot, scope, globalAuthPath, env);
		report.migrated = authOnly.migrated;
		report.warnings.push(...authOnly.warnings);
		if (sameRoot && authOnly.migrated) await archiveSelectedFiles(sourceRoot, ["auth.json"], warnings);
		return report;
	}
	try {
		const sourceInfo = await stat(sourceRoot);
		if (!sourceInfo.isDirectory()) return report;
	} catch {
		return report;
	}

	let configInfo: { path: string; value: JsonObject } | undefined;
	try {
		configInfo = await readConfigFile(sourceRoot);
	} catch (error) {
		warnings.push(`Could not parse legacy config: ${error instanceof Error ? error.message : String(error)}`);
	}
	const sourceAgentRoot = join(sourceRoot, "agent");
	const conversion: RootConversion = configInfo
		? { ...convertConfig(configInfo.value) }
		: {
				settings: {},
				models: { providers: {} },
				credentials: new Map(),
				warnings: [],
				hasModelConfig: false,
				hasExplicitModelDefinitions: false,
			};
	warnings.push(...conversion.warnings);
	const sourceRoots = [
		{ path: sourceRoot, provider: conversion.defaultProvider ?? "step" },
		{ path: sourceAgentRoot, provider: conversion.defaultProvider ?? "step" },
	];
	// Credentials are a separate legacy surface and may exist without a config.
	// Read them even when the target directory already exists (for example, a
	// device-id or session created by an earlier Step launch).
	const sourceCredentialMap = new Map<string, Credential>();
	for (const source of sourceRoots) {
		const result = await readJson(join(source.path, "auth.json"));
		if (!result.exists) continue;
		if (result.error || !result.value) {
			warnings.push(`${join(source.path, "auth.json")}: could not parse legacy credentials; skipped.`);
			continue;
		}
		collectLegacyCredentials(
			result.value,
			source.provider,
			sourceCredentialMap,
			warnings,
			join(source.path, "auth.json"),
		);
	}
	if (!conversion.hasModelConfig && sourceCredentialMap.size === 0) {
		// Keep unsupported/approval-only legacy input recoverable even though it
		// has no direct Pi projection. The source remains untouched for callers
		// that still inspect it, while the sibling archive captures a snapshot.
		if (sameRoot && (configInfo || (await pathExists(join(sourceRoot, "auth.json"))))) {
			await archiveSelectedFiles(sourceRoot, [...CONFIG_CANDIDATES, "auth.json"], warnings);
		}
		return report;
	}
	let stepCredentialAvailable = hasStepCredential(sourceCredentialMap.get(STEP_PROVIDER_ID));
	if (!stepCredentialAvailable && globalAuthPath) {
		const targetAuth = await readJson(globalAuthPath);
		stepCredentialAvailable = hasStepCredential(targetAuth.value?.[STEP_PROVIDER_ID]);
	}
	projectStepCredentialProvider(conversion, stepCredentialAvailable, warnings);
	copyInheritedLegacyCredential(conversion, sourceCredentialMap, warnings);

	const outputAgentRoot = targetAgentRoot ?? (scope === "global" ? join(targetRoot, "agent") : targetRoot);
	try {
		const projectionWarningStart = warnings.length;
		const settingsChanged =
			Object.keys(conversion.settings).length > 0
				? await mergeSettingsFile(join(outputAgentRoot, "settings.json"), conversion.settings, warnings)
				: false;
		const modelsTargetRoot = modelsAgentRoot ?? (scope === "global" ? outputAgentRoot : undefined);
		const modelsChanged =
			conversion.hasExplicitModelDefinitions && modelsTargetRoot
				? await writeModelsFile(join(modelsTargetRoot, "models.json"), conversion.models, warnings)
				: false;
		if (scope === "project" && conversion.hasExplicitModelDefinitions) {
			warnings.push(
				modelsTargetRoot
					? `${sourceRoot}: workspace model definitions were merged into the global Pi models.json; the default model selection remains project-local.`
					: `${sourceRoot}: workspace model definitions were not copied because no global models.json target is available.`,
			);
		}
		// Explicit keys in config.json historically outranked the login store. Keep
		// that rule, except when both values are the same legacy product key: in
		// that case retain the OAuth-shaped source credential so `uid` and the Step
		// provider's subscription semantics are not lost during projection.
		const credentialsToWrite = new Map(sourceCredentialMap);
		for (const [provider, credential] of conversion.credentials) {
			const existing = credentialsToWrite.get(provider);
			if (
				existing?.type === "oauth" &&
				credential.type === "api_key" &&
				typeof existing.access === "string" &&
				existing.access === credential.key
			) {
				continue;
			}
			credentialsToWrite.set(provider, credential);
		}
		const authChanged = await mergeAuthFile(
			globalAuthPath ?? join(outputAgentRoot, "auth.json"),
			[],
			credentialsToWrite,
			warnings,
		);
		const targetAuthPath = globalAuthPath ?? join(outputAgentRoot, "auth.json");
		const repaired = await repairStepLoginBinding({
			settingsPath: join(outputAgentRoot, "settings.json"),
			modelsPath: join(modelsAgentRoot ?? outputAgentRoot, "models.json"),
			authPath: targetAuthPath,
			stepApiKey: env.STEP_API_KEY,
			canonicalBaseUrl: canonicalStepBaseUrl(env),
			warnings,
		});
		report.migrated = settingsChanged || modelsChanged || authChanged || repaired;
		if (configInfo && conversion.hasModelConfig) {
			report.defaults = { provider: conversion.defaultProvider, model: conversion.defaultModel };
		}
		// Do not hide a failed write behind a completed marker. Conversion warnings
		// (for example dropped unsupported fields) are safe; persistence/parse errors
		// mean the old source must remain eligible for a later retry.
		const projectionFailed = warnings
			.slice(projectionWarningStart)
			.some((warning) => /(?:could not persist|not valid JSON|Migration failed)/iu.test(warning));
		if (!projectionFailed) {
			let backupFailed = false;
			if (sameRoot) {
				// Only the old root-level files are legacy in an in-place upgrade;
				// the generated Pi files under `agent/` must remain active.
				const backupWarningCount = warnings.length;
				await archiveSelectedFiles(sourceRoot, [...CONFIG_CANDIDATES, "auth.json"], warnings);
				backupFailed = warnings.length > backupWarningCount;
			}
			if (!backupFailed) await writeMigrationMarker(targetRoot, sourceRoot, warnings, markerName);
		}
	} catch (error) {
		warnings.push(`Migration failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	return report;
}

/**
 * Import a Pi-shaped tree written by the previous product namespace. This is
 * intentionally separate from the old rich-config projection: the source
 * already has Pi's schema, so only missing values are merged into `.step-cli`.
 */
async function migrateRetiredPiRoot(
	sourceRoot: string,
	targetRoot: string,
	scope: "global" | "project",
	targetAgentRoot?: string,
	modelsAgentRoot?: string,
	globalAuthPath?: string,
	env: Record<string, string | undefined> = process.env,
): Promise<StepConfigMigrationRootReport> {
	const warnings: string[] = [];
	const report: StepConfigMigrationRootReport = {
		scope,
		source: sourceRoot,
		target: targetRoot,
		migrated: false,
		warnings,
	};
	if (resolve(sourceRoot) === resolve(targetRoot)) return report;
	try {
		const sourceInfo = await stat(sourceRoot);
		if (!sourceInfo.isDirectory()) return report;
	} catch {
		return report;
	}

	if (await hasMigrationMarker(targetRoot, sourceRoot, RETIRED_NAMESPACE_MIGRATION_MARKER)) {
		const authOnly = await migrateMarkedAuth(sourceRoot, targetRoot, scope, globalAuthPath, env);
		report.migrated = authOnly.migrated;
		report.warnings.push(...authOnly.warnings);
		if (authOnly.migrated) await archiveLegacyDirectory(sourceRoot, warnings);
		return report;
	}

	const sourceAgentRoot = join(sourceRoot, "agent");
	const sourceSettingsCandidates =
		scope === "global"
			? [join(sourceAgentRoot, "settings.json"), join(sourceRoot, "settings.json")]
			: [join(sourceRoot, "settings.json"), join(sourceAgentRoot, "settings.json")];
	let sourceSettings: ReadJsonResult = { exists: false };
	let sourceSettingsPath: string | undefined;
	for (const candidate of sourceSettingsCandidates) {
		const result = await readJson(candidate);
		if (!result.exists) continue;
		sourceSettings = result;
		sourceSettingsPath = candidate;
		break;
	}
	const sourceModelsCandidates = [join(sourceAgentRoot, "models.json"), join(sourceRoot, "models.json")];
	let sourceModels: ReadJsonResult = { exists: false };
	let sourceModelsPath: string | undefined;
	for (const candidate of sourceModelsCandidates) {
		const result = await readJson(candidate);
		if (!result.exists) continue;
		sourceModels = result;
		sourceModelsPath = candidate;
		break;
	}
	const sourceAuthCandidates = [join(sourceAgentRoot, "auth.json"), join(sourceRoot, "auth.json")];
	let hasSourceAuth = false;
	for (const candidate of sourceAuthCandidates) {
		if (await pathExists(candidate)) {
			hasSourceAuth = true;
			break;
		}
	}
	if (!sourceSettings.value && !sourceModels.value && !hasSourceAuth) {
		await archiveLegacyDirectory(sourceRoot, warnings);
		return report;
	}

	const outputAgentRoot = targetAgentRoot ?? (scope === "global" ? join(targetRoot, "agent") : targetRoot);
	const targetSettingsPath = join(outputAgentRoot, "settings.json");
	const settingsChanged = sourceSettings.value
		? await mergeSettingsFile(targetSettingsPath, sourceSettings.value, warnings)
		: false;
	if (sourceSettings.error && sourceSettingsPath)
		warnings.push(`${sourceSettingsPath}: invalid Pi settings; skipped.`);

	const modelsTargetRoot = modelsAgentRoot ?? (scope === "global" ? outputAgentRoot : undefined);
	const modelsChanged =
		sourceModels.value && modelsTargetRoot
			? await writeModelsFile(join(modelsTargetRoot, "models.json"), sourceModels.value, warnings)
			: false;
	if (sourceModels.error && sourceModelsPath) warnings.push(`${sourceModelsPath}: invalid Pi models; skipped.`);

	const targetAuthPath = globalAuthPath ?? join(outputAgentRoot, "auth.json");
	const sourceRoots = sourceAuthCandidates.map((path) => ({ path: dirname(path), provider: STEP_PROVIDER_ID }));
	const authChanged = hasSourceAuth ? await mergeAuthFile(targetAuthPath, sourceRoots, new Map(), warnings) : false;
	const repaired = await repairStepLoginBinding({
		settingsPath: targetSettingsPath,
		modelsPath: join(modelsAgentRoot ?? outputAgentRoot, "models.json"),
		authPath: targetAuthPath,
		stepApiKey: env.STEP_API_KEY,
		canonicalBaseUrl: canonicalStepBaseUrl(env),
		warnings,
	});
	report.migrated = settingsChanged || modelsChanged || authChanged || repaired;
	const projectionFailed = warnings.some((warning) =>
		/(?:could not persist|invalid Pi|not valid JSON)/iu.test(warning),
	);
	if (!projectionFailed) {
		const backupWarningCount = warnings.length;
		await archiveLegacyDirectory(sourceRoot, warnings);
		if (warnings.length === backupWarningCount) {
			await writeMigrationMarker(targetRoot, sourceRoot, warnings, RETIRED_NAMESPACE_MIGRATION_MARKER);
		}
	}
	return report;
}

/** Migrate both global and workspace Step CLI state before Pi starts. */
export async function migrateStepConfig(options: StepConfigMigrationOptions = {}): Promise<StepConfigMigrationReport> {
	const env = options.env ?? process.env;
	const cwd = resolve(options.cwd ?? process.cwd());
	const home = resolve(options.homeDir ?? resolveStepHomeDir(env));
	const newConfigDir = resolveStepConfigDir(env);
	const configuredAgentDir = options.agentDir?.trim() || env.STEP_CODING_AGENT_DIR?.trim();
	const newAgentDir = configuredAgentDir ? resolve(configuredAgentDir) : join(home, newConfigDir, "agent");
	const globalTarget = configuredAgentDir ? dirname(newAgentDir) : join(home, newConfigDir);
	const globalAuthPath = env.STEP_CLI_AUTH_PATH?.trim() || join(newAgentDir, "auth.json");
	// The canonical `.step-cli` directory may contain the pre-Pi rich config,
	// while `.step-harness` is the Pi-shaped namespace used by older releases.
	// Both are read explicitly; no `.pi` directory is ever treated as a source.
	const globalSource = join(home, STEP_CLI_CONFIG_DIR);
	const retiredGlobalSource = join(home, LEGACY_RENAMED_CONFIG_DIR);
	const projectTarget = join(cwd, newConfigDir);
	const projectSource = join(cwd, STEP_CLI_CONFIG_DIR);
	const retiredProjectSource = join(cwd, LEGACY_RENAMED_CONFIG_DIR);
	// Run global first so project credentials can be folded into the same
	// Pi-compatible global auth store without two concurrent read/modify/writes.
	const globalLegacyReport = await migrateRoot(
		globalSource,
		globalTarget,
		"global",
		newAgentDir,
		newAgentDir,
		globalAuthPath,
		env,
	);
	const globalRetiredReport = await migrateRetiredPiRoot(
		retiredGlobalSource,
		globalTarget,
		"global",
		newAgentDir,
		newAgentDir,
		globalAuthPath,
		env,
	);
	const projectLegacyReport = await migrateRoot(
		projectSource,
		projectTarget,
		"project",
		undefined,
		newAgentDir,
		globalAuthPath,
		env,
	);
	const projectRetiredReport = await migrateRetiredPiRoot(
		retiredProjectSource,
		projectTarget,
		"project",
		undefined,
		newAgentDir,
		globalAuthPath,
		env,
	);
	const combineReports = (
		primary: StepConfigMigrationRootReport & { defaults?: { provider?: string; model?: string } },
		secondary: StepConfigMigrationRootReport,
	): StepConfigMigrationRootReport & { defaults?: { provider?: string; model?: string } } => ({
		...primary,
		migrated: primary.migrated || secondary.migrated,
		warnings: [...primary.warnings, ...secondary.warnings],
	});
	const globalReport = combineReports(globalLegacyReport, globalRetiredReport);
	const projectReport = combineReports(projectLegacyReport, projectRetiredReport);
	const reports = [globalReport, projectReport];
	const warnings = reports.flatMap((report) => report.warnings);
	// A completed legacy migration marker intentionally prevents replaying old
	// config files, but it must not freeze an endpoint written by a pre-fix
	// previous release. Normalize the active global catalog on every launch;
	// the pass is read-only when no stale Step URL is present.
	const endpointWarnings: string[] = [];
	const endpointsChanged = await normalizeStepModelsFile(
		join(newAgentDir, "models.json"),
		endpointWarnings,
		canonicalStepBaseUrl(env),
	);
	warnings.push(...endpointWarnings);
	// A canonical Step directory can predate the migration marker (for example,
	// when an earlier launch created settings/auth before the legacy projection
	// ran). In that case the marker-gated pass above is skipped, but a persisted
	// built-in Step model can still point at a legacy proxy provider. Re-run the
	// same narrow, idempotent repair against both settings scopes on every
	// launch. It only changes built-in Step ids and providers without an explicit
	// models.json API key, so intentional custom provider selections remain intact.
	const bindingWarnings: string[] = [];
	const canonicalBaseUrl = canonicalStepBaseUrl(env);
	const globalBindingChanged = await repairStepLoginBinding({
		settingsPath: join(newAgentDir, "settings.json"),
		modelsPath: join(newAgentDir, "models.json"),
		authPath: globalAuthPath,
		stepApiKey: env.STEP_API_KEY,
		canonicalBaseUrl,
		warnings: bindingWarnings,
	});
	const projectSettingsPath = join(projectTarget, "settings.json");
	const projectBindingChanged =
		resolve(projectSettingsPath) === resolve(join(newAgentDir, "settings.json"))
			? false
			: await repairStepLoginBinding({
					settingsPath: projectSettingsPath,
					modelsPath: join(newAgentDir, "models.json"),
					authPath: globalAuthPath,
					stepApiKey: env.STEP_API_KEY,
					canonicalBaseUrl,
					warnings: bindingWarnings,
				});
	warnings.push(...bindingWarnings);
	const defaults = globalReport.defaults;
	return {
		migrated:
			reports.some((report) => report.migrated) || endpointsChanged || globalBindingChanged || projectBindingChanged,
		warnings,
		roots: reports,
		defaultProvider: defaults?.provider,
		defaultModel: defaults?.model,
	};
}
