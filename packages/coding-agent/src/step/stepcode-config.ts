/** Compatibility loader for the config file supplied by StepCode. */

import { readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { AnthropicMessagesCompat, Api } from "@step-harness/providers";
import lockfile from "proper-lockfile";
import type { ExtensionAPI, InlineExtension, ProviderConfig, ProviderModelConfig } from "../core/extensions/types.ts";
import { normalizeProviderBaseUrl } from "../core/provider-base-url.ts";
import { stripBom } from "../utils/text.ts";
import {
	getStepPermissionPreset,
	normalizeStepPermissionMode,
	type StepNonInteractiveApproval,
	type StepPermissionMode,
	type StepPermissionPresetId,
} from "./permissions.ts";
import type { StepSettings, StepSettingsManager, StepSettingsPaths } from "./settings-manager.ts";

export const STEPCODE_CONFIG_ENV_NAME = "STEPCODE_CONFIG_PATH";

const DEFAULT_PROVIDER_ID = "stepcode";
const DEFAULT_API_KEY_ENV = "STEP_API_KEY";
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const STEP_MAX_CONTEXT_TOKENS_ENV = "STEP_MAX_CONTEXT_TOKENS";
const STEP_MAX_OUTPUT_TOKENS_ENV = "STEP_MAX_OUTPUT_TOKENS";

export interface StepCodeProviderRegistration {
	readonly id: string;
	readonly config: ProviderConfig;
}

export interface StepCodeConfig {
	readonly path: string;
	readonly providers: readonly StepCodeProviderRegistration[];
	readonly defaultProvider?: string;
	readonly defaultModel?: string;
}

interface JsonObject {
	readonly [key: string]: unknown;
}

interface StepCodeTokenLimits {
	readonly contextWindow?: number;
	readonly maxTokens?: number;
}

/** Read and normalize the config path injected by StepCode. */
export async function loadStepCodeConfig(
	env: Record<string, string | undefined> = process.env,
	cwd = process.cwd(),
): Promise<StepCodeConfig | undefined> {
	const configuredPath = readString(env[STEPCODE_CONFIG_ENV_NAME]);
	if (!configuredPath) return undefined;

	const path = resolve(cwd, configuredPath);
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
	} catch (error) {
		throw new Error(
			`Failed to load StepCode config ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const root = asObject(parsed);
	if (!root) throw new Error(`Invalid StepCode config ${path}: expected a JSON object`);

	const sharedBaseUrl = readString(env.STEP_BASE_URL) ?? readString(root.baseUrl);
	const sharedApiKey = readString(root.apiKey);
	const limits = {
		contextWindow: readPositiveNumber(env[STEP_MAX_CONTEXT_TOKENS_ENV]),
		maxTokens: readPositiveNumber(env[STEP_MAX_OUTPUT_TOKENS_ENV]),
	};
	const providers = readProviders(root.providers, sharedBaseUrl, sharedApiKey, limits);
	const registrations =
		providers.length > 0 ? providers : readLegacyProvider(root, sharedBaseUrl, sharedApiKey, limits);
	if (registrations.length === 0) {
		throw new Error(`Invalid StepCode config ${path}: no usable providers or models found`);
	}

	const activeModel = readString(root.activeModel);
	const active = findActiveModel(registrations, activeModel);
	if (activeModel && !active) {
		throw new Error(`Invalid StepCode config ${path}: activeModel "${activeModel}" matches no configured model`);
	}
	const rootProvider = readString(root.defaultProvider) ?? readString(root.provider);
	const rootModel = readString(root.defaultModel) ?? readLegacyDefaultModel(root);
	const defaultProvider = active?.providerId ?? rootProvider ?? registrations[0]?.id;
	const defaultModel = active?.modelId ?? rootModel ?? registrations[0]?.config.models?.[0]?.id;

	return {
		path,
		providers: registrations,
		...(defaultProvider ? { defaultProvider } : {}),
		...(defaultModel ? { defaultModel } : {}),
	};
}

/** Return whether the external config can provide credentials without login UI. */
export function hasConfiguredStepCodeCredential(
	config: StepCodeConfig | undefined,
	env: Record<string, string | undefined> = process.env,
): boolean {
	if (readString(env.STEP_API_KEY)) return true;
	for (const provider of config?.providers ?? []) {
		const value = provider.config.apiKey?.trim();
		if (!value) continue;
		if (value.startsWith("$") && readString(env[value.slice(1)])) return true;
		if (value.startsWith("!")) return true;
		if (!value.startsWith("$")) return true;
	}
	return false;
}

/**
 * Route model and permission preferences to the explicit StepCode config.
 * Other Pi/Step settings keep using the wrapped manager unchanged.
 */
export function decorateStepCodeSettingsManager(
	manager: StepSettingsManager,
	config: StepCodeConfig,
): StepSettingsManager {
	const authority = new StepCodeSettingsAuthority(manager, config);
	const overrides = new Set<PropertyKey>([
		"getDefaultProvider",
		"getDefaultModel",
		"setDefaultProvider",
		"setDefaultModel",
		"setDefaultModelAndProvider",
		"getStepSettings",
		"getStepGlobalSettings",
		"getStepProjectSettings",
		"getStepSettingsPaths",
		"setStepSettings",
		"setProjectStepSettings",
		"setEffectiveStepSettings",
		"getStepPermissionPreset",
		"setStepPermissionPreset",
		"getStepApprovalMode",
		"setStepApprovalMode",
		"getStepNonInteractiveApproval",
		"setStepNonInteractiveApproval",
		"getStepAutoResume",
		"setStepAutoResume",
		"reload",
	]);
	return new Proxy(manager, {
		get(target, property) {
			if (overrides.has(property)) {
				const value = Reflect.get(authority, property, authority);
				return typeof value === "function" ? value.bind(authority) : value;
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
		has(target, property) {
			return overrides.has(property) || Reflect.has(target, property);
		},
	}) as StepSettingsManager;
}

class StepCodeSettingsAuthority {
	private readonly manager: StepSettingsManager;
	private readonly path: string;
	private defaultProvider: string | undefined;
	private defaultModel: string | undefined;
	private settings: StepSettings;

	constructor(manager: StepSettingsManager, config: StepCodeConfig) {
		this.manager = manager;
		this.path = config.path;
		const root = readConfigRoot(this.path);
		const storedDefault = findRawActiveModel(root);
		this.defaultProvider = storedDefault?.providerId ?? config.defaultProvider;
		this.defaultModel = storedDefault?.modelId ?? config.defaultModel;
		this.settings = readStepCodeSettings(root);
	}

	getDefaultProvider(): string | undefined {
		return this.defaultProvider;
	}

	getDefaultModel(): string | undefined {
		return this.defaultModel;
	}

	setDefaultProvider(provider: string): void {
		this.updateConfig((root) => {
			root.defaultProvider = provider;
		});
		this.defaultProvider = provider;
	}

	setDefaultModel(modelId: string): void {
		this.setDefaultModelAndProvider(this.defaultProvider ?? DEFAULT_PROVIDER_ID, modelId);
	}

	setDefaultModelAndProvider(provider: string, modelId: string): void {
		this.updateConfig((root) => {
			root.activeModel = findRawModelHandle(root, provider, modelId) ?? modelId;
			if (Object.hasOwn(root, "defaultProvider")) root.defaultProvider = provider;
			if (Object.hasOwn(root, "defaultModel")) root.defaultModel = modelId;
		});
		this.defaultProvider = provider;
		this.defaultModel = modelId;
	}

	getStepSettings(): StepSettings {
		return structuredClone(this.settings);
	}

	getStepGlobalSettings(): StepSettings {
		return this.getStepSettings();
	}

	getStepProjectSettings(): StepSettings {
		return {};
	}

	getStepSettingsPaths(): StepSettingsPaths {
		return { global: this.path, project: this.path };
	}

	setStepSettings(settings: Partial<StepSettings>): void {
		this.setEffectiveStepSettings(settings);
	}

	setProjectStepSettings(settings: Partial<StepSettings>): void {
		this.setEffectiveStepSettings(settings);
	}

	setEffectiveStepSettings(settings: Partial<StepSettings>): void {
		validateStepSettings(settings);
		this.updateConfig((root) => writeStepCodeSettings(root, settings));
		this.settings = { ...this.settings, ...settings };
		for (const [key, value] of Object.entries(settings)) {
			if (value === undefined) delete (this.settings as Record<string, unknown>)[key];
		}
	}

	getStepPermissionPreset(): StepPermissionPresetId | undefined {
		return this.settings.permissionPreset;
	}

	setStepPermissionPreset(preset: StepPermissionPresetId): void {
		this.setEffectiveStepSettings({ permissionPreset: preset });
	}

	getStepApprovalMode(): StepPermissionMode | undefined {
		return this.settings.approvalMode;
	}

	setStepApprovalMode(mode: StepPermissionMode | undefined): void {
		this.setEffectiveStepSettings({ approvalMode: mode });
	}

	getStepNonInteractiveApproval(): StepNonInteractiveApproval | undefined {
		return this.settings.nonInteractiveApproval;
	}

	setStepNonInteractiveApproval(mode: StepNonInteractiveApproval | undefined): void {
		this.setEffectiveStepSettings({ nonInteractiveApproval: mode });
	}

	getStepAutoResume(): boolean | undefined {
		return this.settings.autoResume;
	}

	setStepAutoResume(enabled: boolean | undefined): void {
		this.setEffectiveStepSettings({ autoResume: enabled });
	}

	async reload(): Promise<void> {
		await this.manager.reload();
		const config = await loadStepCodeConfig({ ...process.env, STEPCODE_CONFIG_PATH: this.path });
		this.defaultProvider = config?.defaultProvider;
		this.defaultModel = config?.defaultModel;
		this.settings = readStepCodeSettings(readConfigRoot(this.path));
	}

	private updateConfig(update: (root: Record<string, unknown>) => void): void {
		let release: (() => void) | undefined;
		try {
			release = acquireConfigLock(this.path);
			const root = readConfigRoot(this.path);
			update(root);
			writeFileSync(this.path, `${JSON.stringify(root, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		} finally {
			release?.();
		}
	}
}

function readConfigRoot(path: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(stripBom(readFileSync(path, "utf8"))) as unknown;
		const root = asMutableObject(parsed);
		if (root) return root;
		throw new Error("expected a JSON object");
	} catch (error) {
		throw new Error(
			`Failed to read StepCode config ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function acquireConfigLock(path: string): () => void {
	let lastError: unknown;
	for (let attempt = 1; attempt <= 10; attempt++) {
		try {
			return lockfile.lockSync(path, { realpath: false });
		} catch (error) {
			lastError = error;
			const code =
				typeof error === "object" && error !== null && "code" in error
					? String((error as { code?: unknown }).code)
					: undefined;
			if (code !== "ELOCKED" || attempt === 10) throw error;
			const startedAt = Date.now();
			while (Date.now() - startedAt < 20) {
				// Keep the SettingsManager persistence API synchronous.
			}
		}
	}
	throw (lastError as Error) ?? new Error(`Failed to lock StepCode config ${path}`);
}

function readStepCodeSettings(root: JsonObject): StepSettings {
	const approval = asObject(asObject(root.tools)?.approval) ?? asObject(root.approval);
	const preset = getStepPermissionPreset(readString(approval?.preset))?.id;
	const mode = normalizeStepPermissionMode(readString(approval?.mode));
	const rawNonInteractive = readString(approval?.nonInteractive ?? approval?.noninteractive)?.toLowerCase();
	const nonInteractiveApproval =
		rawNonInteractive === "allow" || rawNonInteractive === "deny" ? rawNonInteractive : undefined;
	const autoResume = readBoolean(approval?.autoResume ?? approval?.autopilot);
	const feedback = asObject(root.feedback);
	const feedbackEnabled = readBoolean(feedback?.enabled);
	return {
		...(preset ? { permissionPreset: preset } : {}),
		...(mode ? { approvalMode: mode } : {}),
		...(nonInteractiveApproval ? { nonInteractiveApproval } : {}),
		...(autoResume !== undefined ? { autoResume } : {}),
		...(feedbackEnabled !== undefined ? { feedbackEnabled } : {}),
	};
}

function writeStepCodeSettings(root: Record<string, unknown>, patch: Partial<StepSettings>): void {
	const tools = asMutableObject(root.tools) ?? {};
	const approval = asMutableObject(tools.approval) ?? {};
	writeOptionalField(approval, "preset", patch, "permissionPreset");
	writeOptionalField(approval, "mode", patch, "approvalMode");
	writeOptionalField(approval, "nonInteractive", patch, "nonInteractiveApproval");
	writeOptionalField(approval, "autoResume", patch, "autoResume");
	tools.approval = approval;
	root.tools = tools;
	if (Object.hasOwn(patch, "feedbackEnabled")) {
		const feedback = asMutableObject(root.feedback) ?? {};
		if (patch.feedbackEnabled === undefined) delete feedback.enabled;
		else feedback.enabled = patch.feedbackEnabled;
		root.feedback = feedback;
	}
}

function writeOptionalField(
	target: Record<string, unknown>,
	targetKey: string,
	patch: Partial<StepSettings>,
	patchKey: keyof StepSettings,
): void {
	if (!Object.hasOwn(patch, patchKey)) return;
	const value = patch[patchKey];
	if (value === undefined) delete target[targetKey];
	else target[targetKey] = value;
}

function validateStepSettings(settings: Partial<StepSettings>): void {
	if (settings.permissionPreset !== undefined && !getStepPermissionPreset(settings.permissionPreset)) {
		throw new Error(`Invalid Step permission preset: ${String(settings.permissionPreset)}`);
	}
	if (
		settings.approvalMode !== undefined &&
		settings.approvalMode !== "confirm" &&
		settings.approvalMode !== "strict" &&
		settings.approvalMode !== "auto"
	) {
		throw new Error(`Invalid Step approval mode: ${String(settings.approvalMode)}`);
	}
	if (
		settings.nonInteractiveApproval !== undefined &&
		settings.nonInteractiveApproval !== "allow" &&
		settings.nonInteractiveApproval !== "deny"
	) {
		throw new Error(`Invalid Step non-interactive approval: ${String(settings.nonInteractiveApproval)}`);
	}
	if (settings.autoResume !== undefined && typeof settings.autoResume !== "boolean") {
		throw new Error(`Invalid Step autoResume setting: ${String(settings.autoResume)}`);
	}
}

function findRawModelHandle(root: JsonObject, providerId: string, modelId: string): string | undefined {
	const provider = asObject(asObject(root.providers)?.[providerId]);
	if (!Array.isArray(provider?.models)) return undefined;
	for (const rawModel of provider.models) {
		const model = asObject(rawModel);
		const id = readString(model?.id);
		const wireModel = readString(model?.model) ?? id;
		if (id === modelId || wireModel === modelId) return id ?? wireModel;
	}
	return undefined;
}

function findRawActiveModel(root: JsonObject): { providerId: string; modelId: string } | undefined {
	const activeModel = readString(root.activeModel) ?? readString(root.defaultModel);
	if (!activeModel) return undefined;
	const separator = activeModel.indexOf("/");
	const requestedProvider = separator > 0 ? activeModel.slice(0, separator) : readString(root.defaultProvider);
	const requestedModel = separator > 0 ? activeModel.slice(separator + 1) : activeModel;
	const providers = asObject(root.providers);
	for (const [providerId, rawProvider] of Object.entries(providers ?? {})) {
		if (requestedProvider && providerId !== requestedProvider) continue;
		const provider = asObject(rawProvider);
		if (!Array.isArray(provider?.models)) continue;
		for (const rawModel of provider.models) {
			const model = asObject(rawModel);
			const id = readString(model?.id);
			const wireModel = readString(model?.model) ?? id;
			if ((id === requestedModel || wireModel === requestedModel) && wireModel)
				return { providerId, modelId: wireModel };
		}
	}
	return requestedProvider ? { providerId: requestedProvider, modelId: requestedModel } : undefined;
}

/** Register every provider from a loaded StepCode config with Pi. */
export function createStepCodeProviderInlineExtension(config: StepCodeConfig): InlineExtension {
	return {
		name: `StepCode config (${basename(config.path)})`,
		hidden: true,
		factory: (pi: ExtensionAPI): void => {
			for (const provider of config.providers) pi.registerProvider(provider.id, provider.config);
		},
	};
}

/** Make an external active model behave like an explicit StepCode selection. */
export function applyStepCodeConfigDefaults(
	args: readonly string[],
	config: StepCodeConfig | undefined,
	env: Record<string, string | undefined> = process.env,
): string[] {
	if (!config?.defaultModel) return [...args];
	if (hasOption(args, "--provider") || hasOption(args, "--model") || hasOption(args, "--models")) return [...args];
	if (readString(env.STEP_PROVIDER) || readString(env.STEP_MODEL) || readString(env.STEP_MODEL_PROVIDER))
		return [...args];

	const result = [...args];
	const insertionIndex = result.indexOf("--") === -1 ? result.length : result.indexOf("--");
	result.splice(
		insertionIndex,
		0,
		...(config.defaultProvider ? ["--provider", config.defaultProvider] : []),
		"--model",
		config.defaultModel,
	);
	return result;
}

function readProviders(
	value: unknown,
	sharedBaseUrl: string | undefined,
	sharedApiKey: string | undefined,
	limits: StepCodeTokenLimits,
): StepCodeProviderRegistration[] {
	const providers = asObject(value);
	if (!providers) return [];

	const result: StepCodeProviderRegistration[] = [];
	for (const [id, rawProvider] of Object.entries(providers)) {
		const provider = asObject(rawProvider);
		if (!provider) continue;
		const registration = normalizeProvider(id, provider, sharedBaseUrl, sharedApiKey, limits);
		if (registration) result.push(registration);
	}
	return result;
}

function readLegacyProvider(
	root: JsonObject,
	sharedBaseUrl: string | undefined,
	sharedApiKey: string | undefined,
	limits: StepCodeTokenLimits,
): StepCodeProviderRegistration[] {
	const agentModels = asObject(root.agentModels);
	const legacy = asObject(agentModels?.stepcode) ?? asObject(agentModels?.codex) ?? root;
	const model = readString(legacy.model) ?? readString(root.model);
	if (!model) return [];
	const api = normalizeApi(
		readString(legacy.api) ?? firstSupportedApi(legacy.modelSupportApis) ?? firstSupportedApi(root.modelSupportApis),
	);
	if (!api) return [];
	const providerId = readString(root.provider) ?? DEFAULT_PROVIDER_ID;
	const provider: JsonObject = {
		api,
		baseUrl: sharedBaseUrl,
		apiKey: sharedApiKey ?? `$${DEFAULT_API_KEY_ENV}`,
		models: [{ id: model, model, api }],
	};
	const registration = normalizeProvider(providerId, provider, sharedBaseUrl, sharedApiKey, limits);
	return registration ? [registration] : [];
}

function normalizeProvider(
	providerId: string,
	provider: JsonObject,
	sharedBaseUrl: string | undefined,
	sharedApiKey: string | undefined,
	limits: StepCodeTokenLimits,
): StepCodeProviderRegistration | undefined {
	const models = Array.isArray(provider.models)
		? provider.models
				.map((entry) => normalizeModel(asObject(entry), provider, sharedBaseUrl, limits))
				.filter((entry): entry is ProviderModelConfig => entry !== undefined)
		: [];
	const providerApi = normalizeApi(readString(provider.api) ?? (models[0]?.api as string | undefined));
	if (!providerApi || models.length === 0) return undefined;
	const baseUrl = normalizeBaseUrl(sharedBaseUrl ?? readString(provider.baseUrl), providerApi);
	if (!baseUrl) return undefined;
	const apiKey = readString(provider.apiKey) ?? sharedApiKey ?? `$${DEFAULT_API_KEY_ENV}`;
	const config: ProviderConfig = {
		name: readString(provider.name) ?? providerId,
		api: providerApi,
		baseUrl,
		apiKey,
		authHeader: readBoolean(provider.authHeader),
		models: models.map((model) => ({
			...model,
			api: model.api ?? providerApi,
			baseUrl: normalizeBaseUrl(model.baseUrl ?? baseUrl, model.api ?? providerApi),
		})),
	};
	const headers = readStringRecord(provider.headers);
	if (headers) config.headers = headers;
	return { id: providerId, config };
}

function normalizeModel(
	model: JsonObject | undefined,
	provider: JsonObject,
	sharedBaseUrl: string | undefined,
	limits: StepCodeTokenLimits,
): ProviderModelConfig | undefined {
	if (!model) return undefined;
	const alias = readString(model.id);
	const wireModel = readString(model.model) ?? alias;
	if (!wireModel) return undefined;
	const api = normalizeApi(readString(model.api) ?? readString(provider.api));
	if (!api) return undefined;
	const tokens = asObject(model.tokens);
	const contextWindow =
		limits.contextWindow ??
		readPositiveNumber(model.contextWindow) ??
		readPositiveNumber(tokens?.maxContext) ??
		DEFAULT_CONTEXT_WINDOW;
	const maxTokens =
		limits.maxTokens ??
		readPositiveNumber(model.maxTokens) ??
		readPositiveNumber(tokens?.maxOutput) ??
		DEFAULT_MAX_TOKENS;
	const input = readInputTypes(model.input, model.supportsVision);
	const cost = readCost(model.cost);
	const name = readString(model.name) ?? alias ?? wireModel;
	const baseUrl = normalizeBaseUrl(sharedBaseUrl ?? readString(model.baseUrl) ?? readString(provider.baseUrl), api);
	if (!baseUrl) return undefined;
	// StepCode aliases declare their own thinking contract; an `anthropic-messages`
	// entry that needs adaptive thinking must state `compat.forceAdaptiveThinking`
	// and `thinkingLevelMap` itself — there is no built-in catalog to inherit from.
	const effectiveThinkingLevelMap = readThinkingLevelMap(model.thinkingLevelMap);
	const compat = api === "anthropic-messages" ? readAnthropicCompat(model.compat) : undefined;
	return {
		id: wireModel,
		name,
		api,
		baseUrl,
		reasoning: hasReasoning(model),
		input,
		cost,
		contextWindow,
		maxTokens,
		...(effectiveThinkingLevelMap ? { thinkingLevelMap: effectiveThinkingLevelMap } : {}),
		...(compat ? { compat } : {}),
	};
}

function findActiveModel(
	providers: readonly StepCodeProviderRegistration[],
	activeModel: string | undefined,
): { providerId: string; modelId: string } | undefined {
	if (!activeModel) return undefined;
	const separator = activeModel.indexOf("/");
	const requestedProvider = separator > 0 ? activeModel.slice(0, separator) : undefined;
	const requestedModel = separator > 0 ? activeModel.slice(separator + 1) : activeModel;
	for (const provider of providers) {
		if (requestedProvider && provider.id !== requestedProvider) continue;
		const model = provider.config.models?.find(
			(entry) => entry.id === requestedModel || entry.name === requestedModel,
		);
		if (model) return { providerId: provider.id, modelId: model.id };
	}
	return undefined;
}

function readLegacyDefaultModel(root: JsonObject): string | undefined {
	const agentModels = asObject(root.agentModels);
	const stepCode = asObject(agentModels?.stepcode);
	const codex = asObject(agentModels?.codex);
	const modelObject = asObject(root.model);
	return (
		readString(stepCode?.model) ??
		readString(codex?.model) ??
		readString(root.model) ??
		readString(modelObject?.model)
	);
}

function normalizeApi(value: string | undefined): Api | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toLowerCase().replaceAll("_", "-");
	const aliases: Record<string, Api> = {
		chat: "openai-completions",
		completions: "openai-completions",
		"openai-chat-completions": "openai-completions",
		"openai-compatible": "openai-completions",
		responses: "openai-responses",
		"claude-native": "anthropic-messages",
		anthropic: "anthropic-messages",
		"claude-messages": "anthropic-messages",
	};
	return (
		aliases[normalized] ??
		(normalized === "openai-completions" || normalized === "openai-responses" || normalized === "anthropic-messages"
			? normalized
			: undefined)
	);
}

function normalizeBaseUrl(value: string | undefined, api: Api): string | undefined {
	const trimmed = value?.trim().replace(/\/+$/u, "");
	if (!trimmed) return undefined;
	return normalizeProviderBaseUrl(trimmed, api);
}

function hasOption(args: readonly string[], name: string): boolean {
	return args.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

function asObject(value: unknown): JsonObject | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function asMutableObject(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : undefined;
	if (typeof value === "string" && /^\d+(?:\.\d+)?$/u.test(value.trim())) {
		const parsed = Number(value);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
	}
	return undefined;
}

function readStringRecord(value: unknown): Record<string, string> | undefined {
	const object = asObject(value);
	if (!object) return undefined;
	const entries = Object.entries(object).filter((entry): entry is [string, string] => typeof entry[1] === "string");
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function readInputTypes(value: unknown, supportsVision: unknown): ("text" | "image")[] {
	// StepCode's managed catalog omits capability metadata for most models, so a
	// missing `input`/`supportsVision` used to register vision-capable models as
	// text-only and the read tool dropped every image. Mirror hasReasoning: honor
	// an explicit opt-out, but default an omitted capability to enabled.
	const input = Array.isArray(value)
		? value.filter((entry): entry is "text" | "image" => entry === "text" || entry === "image")
		: [];
	if (input.length > 0) return [...new Set(input)];
	return supportsVision === false ? ["text"] : ["text", "image"];
}

function readCost(value: unknown): ProviderModelConfig["cost"] {
	const cost = asObject(value);
	return {
		input: readNonNegativeNumber(cost?.input) ?? 0,
		output: readNonNegativeNumber(cost?.output) ?? 0,
		cacheRead: readNonNegativeNumber(cost?.cacheRead) ?? 0,
		cacheWrite: readNonNegativeNumber(cost?.cacheWrite) ?? 0,
	};
}

function readNonNegativeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function hasReasoning(model: JsonObject): boolean {
	// StepCode's managed catalog historically omitted capability metadata for
	// reasoning-capable models. Preserve an explicit opt-out, but default an
	// omitted capability to enabled so the Pi selector can expose its standard
	// thinking levels.
	if (model.reasoning === false) return false;
	if (model.reasoning === true) return true;
	const reasoning = asObject(model.reasoning);
	return (
		reasoning !== undefined ||
		model.thinking === true ||
		model.supportsThinking === true ||
		model.reasoning === undefined
	);
}

function readThinkingLevelMap(value: unknown): ProviderModelConfig["thinkingLevelMap"] {
	const map = asObject(value);
	if (!map) return undefined;
	const result: Record<string, string | null> = {};
	for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
		const entry = map[level];
		if (typeof entry === "string" || entry === null) result[level] = entry;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Boolean `compat` keys a StepCode entry may state for the Anthropic dialect.
 *
 * `allowedFallbackModels` is intentionally absent: it is a typed list rather than
 * a flag, and a non-empty value makes the adapter request the server-side
 * fallback beta, which is not something an injected config should switch on
 * implicitly. Nothing reads `compat` for the OpenAI dialects.
 */
const ANTHROPIC_COMPAT_FLAGS = [
	"supportsEagerToolInputStreaming",
	"supportsLongCacheRetention",
	"sendSessionAffinityHeaders",
	"supportsCacheControlOnTools",
	"supportsTemperature",
	"forceAdaptiveThinking",
	"allowEmptySignature",
	"supportsStrictTools",
	"supportsToolReferences",
] as const satisfies readonly (keyof AnthropicMessagesCompat)[];

function readAnthropicCompat(value: unknown): AnthropicMessagesCompat | undefined {
	const raw = asObject(value);
	if (!raw) return undefined;
	const compat: { [K in (typeof ANTHROPIC_COMPAT_FLAGS)[number]]?: boolean } = {};
	for (const flag of ANTHROPIC_COMPAT_FLAGS) {
		const declared = readBoolean(raw[flag]);
		if (declared !== undefined) compat[flag] = declared;
	}
	return Object.keys(compat).length > 0 ? compat : undefined;
}

function firstSupportedApi(value: unknown): string | undefined {
	if (!Array.isArray(value)) return undefined;
	for (const entry of value) {
		const object = asObject(entry);
		const api = readString(object?.id) ?? readString(entry);
		if (api) return api;
	}
	return undefined;
}
