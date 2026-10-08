import { randomBytes } from "node:crypto";
import process from "node:process";
import type { Credential, OAuthCredentials } from "../auth/types.ts";
import type { OAuthLoginCallbacks } from "../compat/extension-oauth-types.ts";
import type { RefreshModelsContext } from "../models.ts";
import type { Api, Model, ModelThinkingLevel, ThinkingLevel, ThinkingLevelMap } from "../types.ts";

/**
 * Model catalog entry for the Step provider. Structurally identical to coding-agent's
 * ProviderModelConfig (which stays in coding-agent for the extension registerProvider
 * API); the coding-agent glue assigns these into that config by structural typing, so no
 * shared type has to move down into the providers layer.
 */
export interface StepModelConfig {
	id: string;
	name: string;
	api?: Api;
	baseUrl?: string;
	reasoning: boolean;
	thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
	input: ("text" | "image")[];
	cost: Model<Api>["cost"];
	contextWindow: number;
	maxTokens: number;
	headers?: Record<string, string>;
	compat?: Model<Api>["compat"];
}

import {
	defaultStepCliClientInfo,
	initStepCliLogin,
	type StepCliClientInfo,
	withStepCliLoginTimeout,
} from "./login-client.ts";
import { waitForStepCliLogin } from "./login-polling.ts";

export type {
	InitStepCliLoginInput,
	PollStepCliLoginInput,
	StepCliClientInfo,
	StepCliLoginErrorKind,
	StepCliLoginFailureReason,
	StepCliLoginInit,
	StepCliLoginPoll,
} from "./login-client.ts";
export {
	defaultStepCliClientInfo,
	initStepCliLogin,
	isRetryableStepCliLoginError,
	pollStepCliLogin,
	STEP_CLI_LOGIN_PATH_PREFIX,
	StepCliLoginRequestError,
} from "./login-client.ts";
export type { StepCliLoginReady, WaitForStepCliLoginInput } from "./login-polling.ts";
export { MIN_STEP_POLL_INTERVAL_MS, waitForStepCliLogin } from "./login-polling.ts";

/** Provider id used by the default Step extension. */
export const STEP_PROVIDER_ID = "step";

/** Environment variables understood by the Step provider extension. */
export const STEP_PROVIDER_ENV = {
	apiBaseUrl: "STEP_BASE_URL",
	authBaseUrl: "STEPCODE_DEVCENTER_AUTH_CN_URL",
	apiKey: "STEP_API_KEY",
	timeoutMs: "STEP_OAUTH_TIMEOUT_MS",
} as const;

/** Maximum time for a cloud sign-in, including init and polling. */
export const DEFAULT_STEP_CLI_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

/** Production defaults; every endpoint can be replaced through the options/env. */
export const STEP_PROVIDER_DEFAULTS = {
	// The OpenAI adapter appends `/chat/completions` to `{baseUrl}/v1`, so this
	// must be the route prefix rather than a versioned operation URL.
	apiBaseUrl: "https://api.stepfun.com/step_plan",
	authBaseUrl: "https://platform.stepfun.com",
	timeoutMs: DEFAULT_STEP_CLI_LOGIN_TIMEOUT_MS,
} as const;

/** Marker used for credentials that contain a non-expiring Step API key. */
export const STEP_STATIC_REFRESH_TOKEN = "step-static-credential";

/**
 * Wire dialect for every Step model. All Step profile URLs speak the OpenAI
 * Chat Completions API (`{baseUrl}/chat/completions`), so both the built-in
 * baseline and the models discovered from `{baseUrl}/models` use it.
 */
const STEP_MODEL_API: Api = "openai-completions";

/**
 * `{base}/v1/models` tags each entry with a `model_type`. Step is a coding
 * agent, so only chat-capable types are usable — large-language models and
 * routers; other types (web search, TTS, ASR, realtime voice, text-to-image)
 * are filtered out. Endpoints that do not yet return `model_type` are left
 * unfiltered for backward compatibility.
 */
const STEP_USABLE_MODEL_TYPES = new Set(["大语言模型", "路由模型"]);

/** Metadata `{base}/v1/models` does not always return; used as fallbacks. */
const STEP_MODEL_DEFAULTS = {
	reasoning: false,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 256_000,
} as const;

/** Per-model capabilities parsed from `{base}/v1/models` (any field may be absent). */
interface StepModelMeta {
	/** `max_input_tokens` -> context window. */
	contextWindow?: number;
	/** `enable_reason` -> extended-thinking support. */
	reasoning?: boolean;
	/** `enable_vision_input` -> image input support. */
	vision?: boolean;
	/** `reasoning_effort_support_list` -> thinkingLevelMap (present on some endpoints). */
	efforts?: readonly string[];
}

/** Build a Step model entry, using discovered metadata where present. */
function stepModelConfig(id: string, name: string, baseUrl?: string, meta?: StepModelMeta): StepModelConfig {
	const contextWindow = meta?.contextWindow ?? STEP_MODEL_DEFAULTS.contextWindow;
	const hasEfforts = (meta?.efforts?.length ?? 0) > 0;
	return {
		id,
		name,
		api: STEP_MODEL_API,
		...(baseUrl ? { baseUrl } : {}),
		// Default to no thinking and text-only unless the endpoint reports otherwise.
		// A non-empty effort list implies the model reasons.
		reasoning: meta?.reasoning ?? (hasEfforts ? true : STEP_MODEL_DEFAULTS.reasoning),
		input: meta?.vision ? ["text", "image"] : ["text"],
		cost: { ...STEP_MODEL_DEFAULTS.cost },
		contextWindow,
		// The endpoint reports no max-output; default it to the input window.
		maxTokens: contextWindow,
		// When the list endpoint reports supported efforts (e.g. step_plan), carry
		// them so `/effort` is correct without a per-model lookup.
		...(hasEfforts ? { thinkingLevelMap: stepThinkingLevelMap(meta!.efforts!) } : {}),
	};
}

/**
 * No built-in baseline: the Step catalog is discovered entirely from
 * `{base}/v1/models` after login (see `fetchStepModels`). When discovery is
 * unavailable (offline / logged out / request failure) the list stays empty.
 */
export const STEP_MODELS: readonly StepModelConfig[] = [];

const API_BASE_URL_ENV_NAMES = [
	"STEP_PROVIDER_API_URL",
	"STEP_API_URL",
	STEP_PROVIDER_ENV.apiBaseUrl,
	// Kept for compatibility with the endpoint override used by the legacy
	// StepCode. It may contain the full `/v1/messages` URL.
	"STEPFUN_MESSAGES_ENDPOINT",
	// Set by the shared Step login flow after reading the stored profile. It is
	// intentionally below explicit user overrides so manual endpoint settings win.
	"STEP_LOGIN_PROFILE_API_URL",
	"STEPCODE_STEP_PLAN_API_URL",
] as const;
const AUTH_BASE_URL_ENV_NAMES = [
	"STEP_PROVIDER_AUTH_URL",
	"STEP_AUTH_URL",
	// Set by the shared Step login flow from the stored profile, so a provider-side
	// re-login opens the region's own developer center. Below the explicit user
	// overrides, like its API counterpart.
	"STEP_LOGIN_PROFILE_AUTH_URL",
	STEP_PROVIDER_ENV.authBaseUrl,
] as const;

export interface StepProviderOptions {
	readonly providerId?: string;
	readonly name?: string;
	readonly apiBaseUrl?: string;
	readonly authBaseUrl?: string;
	readonly apiKeyEnv?: string;
	readonly timeoutMs?: number;
	readonly env?: Record<string, string | undefined>;
	readonly models?: readonly StepModelConfig[];
	readonly fetch?: typeof fetch;
	/** Login profile metadata recorded by the backend. */
	readonly loginProfile?: string;
	/** Terminal metadata for server audit logs. Never used for auth. */
	readonly client?: StepCliClientInfo;
}

export interface ResolvedStepProviderOptions {
	readonly providerId: string;
	readonly name: string;
	readonly apiBaseUrl: string;
	readonly authBaseUrl: string;
	readonly apiKeyEnv: string;
	readonly timeoutMs: number;
	readonly env: Record<string, string | undefined>;
	readonly models: readonly StepModelConfig[];
	readonly fetch?: typeof fetch;
	readonly loginProfile: string;
	readonly client: StepCliClientInfo;
}

/** Resolve provider settings at registration time, after environment setup. */
export function resolveStepProviderOptions(options: StepProviderOptions = {}): ResolvedStepProviderOptions {
	const env = options.env ?? process.env;
	const apiBaseUrl = normalizeStepApiBaseUrl(
		validateHttpEndpoint(
			options.apiBaseUrl ?? readFirstEnv(env, API_BASE_URL_ENV_NAMES) ?? STEP_PROVIDER_DEFAULTS.apiBaseUrl,
			"Step API base URL",
		),
	);
	const authBaseUrl = validateHttpEndpoint(
		options.authBaseUrl ?? readFirstEnv(env, AUTH_BASE_URL_ENV_NAMES) ?? STEP_PROVIDER_DEFAULTS.authBaseUrl,
		"Step OAuth authorization URL",
	);
	const providerId = nonEmpty(options.providerId ?? STEP_PROVIDER_ID, "Step provider id");
	const name = nonEmpty(options.name ?? "Step", "Step provider name");
	const apiKeyEnv = nonEmpty(options.apiKeyEnv ?? STEP_PROVIDER_ENV.apiKey, "Step API key environment variable");
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(apiKeyEnv)) {
		throw new Error(`Invalid Step API key environment variable name: ${apiKeyEnv}`);
	}

	const timeoutMs =
		options.timeoutMs ?? readPositiveInteger(env[STEP_PROVIDER_ENV.timeoutMs]) ?? STEP_PROVIDER_DEFAULTS.timeoutMs;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
		throw new Error("Step login timeout must be finite and greater than zero");

	// Empty is allowed: the Step catalog is discovered dynamically from
	// `{base}/v1/models`; there is no built-in baseline.
	const models = options.models ?? STEP_MODELS;

	return {
		providerId,
		name,
		apiBaseUrl,
		authBaseUrl,
		apiKeyEnv,
		timeoutMs,
		env,
		models,
		fetch: options.fetch,
		loginProfile:
			options.loginProfile?.trim() ||
			(new URL(authBaseUrl).hostname.endsWith(".ai") ? "step_plan_oversea" : "step_plan"),
		client: options.client ?? defaultStepCliClientInfo("unknown"),
	};
}

/**
 * A model entry may omit its dialect. Default it to the shared Step wire
 * dialect (OpenAI Chat Completions) so a bare custom entry streams correctly.
 */
export function normalizeStepModelConfig(model: StepModelConfig): StepModelConfig {
	return {
		...model,
		api: model.api ?? STEP_MODEL_API,
		input: [...model.input],
	};
}

/**
 * Every Step model uses the active profile's OpenAI endpoint and dialect.
 * Restore both so a stale models.json overlay (e.g. an old proxy host or the
 * legacy Anthropic dialect) cannot misroute a Step model.
 */
export function normalizeStepModel(model: Model<Api>, openaiBaseUrl: string): Model<Api> {
	return { ...model, api: STEP_MODEL_API, baseUrl: openaiBaseUrl };
}

/** Cloud login has one path: init, open the supplied URL, poll, store the existing API key. */
export async function loginStepOAuth(
	callbacks: OAuthLoginCallbacks,
	options: ResolvedStepProviderOptions | StepOAuthLoginOptions,
): Promise<OAuthCredentials> {
	const resolved = resolveStepProviderOptions(options);
	return withStepCliLoginTimeout(
		resolved.timeoutMs,
		callbacks.signal,
		() => new Error("Step sign-in timed out. Run `step login` again."),
		async (signal) => {
			const pollToken = randomBytes(32).toString("hex");
			const init = await initStepCliLogin({
				authBaseUrl: resolved.authBaseUrl,
				pollToken,
				profile: resolved.loginProfile,
				client: resolved.client,
				signal,
				fetch: resolved.fetch,
			});
			signal.throwIfAborted();
			callbacks.onAuth({
				url: init.authorizeUrl,
				instructions: "Open this URL in any browser and approve the sign-in.",
			});
			callbacks.onProgress?.("Waiting for browser confirmation...");
			const ready = await waitForStepCliLogin({
				init,
				authBaseUrl: resolved.authBaseUrl,
				pollToken,
				signal,
				fetch: resolved.fetch,
			});
			signal.throwIfAborted();
			return {
				access: ready.apiKey,
				refresh: STEP_STATIC_REFRESH_TOKEN,
				expires: Number.MAX_SAFE_INTEGER,
				...(ready.uid ? { uid: ready.uid } : {}),
			};
		},
	);
}

export interface StepOAuthLoginOptions extends StepProviderOptions {
	readonly authBaseUrl: string;
}

// The provider interface calls this for expired credentials; current Step keys do not expire locally.
export async function refreshStepOAuth(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	if (credentials.refresh !== STEP_STATIC_REFRESH_TOKEN) {
		throw new Error("This Step credential cannot be refreshed. Run `step login` again.");
	}
	return { ...credentials, expires: Number.MAX_SAFE_INTEGER };
}

export function getStepOAuthApiKey(credentials: OAuthCredentials): string {
	const access = credentials.access.trim();
	if (!access) throw new Error("Step OAuth credentials do not contain an access token");
	return access;
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
	let value: unknown;
	try {
		value = await response.json();
	} catch {
		return {};
	}
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function resolveFetch(fetchFn: typeof fetch | undefined): typeof fetch {
	if (fetchFn) return fetchFn;
	if (typeof globalThis.fetch !== "function") throw new Error("Step OAuth requires a fetch implementation");
	return globalThis.fetch.bind(globalThis);
}

function readFirstEnv(env: Record<string, string | undefined>, names: readonly string[]): string | undefined {
	for (const name of names) {
		const value = env[name]?.trim();
		if (value) return value;
	}
	return undefined;
}

function readPositiveInteger(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function validateHttpEndpoint(value: string, label: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${label} must be a valid URL`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${label} must use http or https`);
	if (url.username || url.password) throw new Error(`${label} must not contain credentials`);
	return url.toString().replace(/\/$/u, "");
}

/**
 * Reduce a Step endpoint to its route prefix. Step's configuration (and older
 * models.json files) accepted the versioned operation URL (`/v1/messages`),
 * the `/messages` operation, or the `/v1` parent; strip any of those trailing
 * segments so callers can append the correct suffix for the active dialect
 * (`stepOpenAiBaseUrl` re-appends `/v1`).
 */
export function normalizeStepApiBaseUrl(value: string): string {
	try {
		const url = new URL(value);
		let pathname = url.pathname.replace(/\/+$/u, "");
		// Be tolerant of files produced by an intermediate release that already
		// contained one duplicated suffix (for example `/v1/v1/messages`).
		// Repeating the operation keeps the repair idempotent for any number of
		// stale version/operation segments.
		while (pathname) {
			const lowerPathname = pathname.toLowerCase();
			const suffix = ["/v1/messages", "/messages", "/v1"].find((candidate) => lowerPathname.endsWith(candidate));
			if (!suffix) break;
			pathname = pathname.slice(0, -suffix.length).replace(/\/+$/u, "");
		}
		url.pathname = pathname || "/";
		return url.toString().replace(/\/$/u, "");
	} catch {
		// The provider resolver validates its own endpoint. This exported helper is
		// also used while repairing an existing models.json, where malformed custom
		// entries must remain intact for normal validation diagnostics.
		return value;
	}
}

/**
 * OpenAI-style base (`.../v1`) for the active profile. `resolved.apiBaseUrl` is
 * already normalized (trailing `/v1` stripped), so appending `/v1` yields the
 * OpenAI base for every profile:
 *   step_plan   -> https://api.stepfun.com/step_plan/v1
 *   platform_cn -> https://api.stepfun.com/v1
 * The OpenAI adapter appends `/chat/completions`; discovery uses `/models`.
 */
export function stepOpenAiBaseUrl(apiBaseUrl: string): string {
	return `${normalizeStepApiBaseUrl(apiBaseUrl)}/v1`;
}

/**
 * Base for per-model detail lookups (`{base}/models/{id}`). The detail endpoint
 * lives at the domain-root `/v1` (e.g. `https://api.stepfun.com/v1`), even for
 * the `step_plan` profile whose chat/list base is `.../step_plan/v1` — the
 * subpath variant 404s. Falls back to the input if it is not a valid URL.
 */
export function stepModelsDetailBaseUrl(baseUrl: string): string {
	try {
		return `${new URL(baseUrl).origin}/v1`;
	} catch {
		return baseUrl;
	}
}

/**
 * Discover the chat-capable models the current credential can use from
 * `{base}/v1/models`, filtered by the endpoint's `model_type` (see
 * {@link STEP_USABLE_MODEL_TYPES}). Per-model capabilities are taken from the
 * response where present: `max_input_tokens` -> context window, `enable_reason`
 * -> thinking support, `enable_vision_input` -> image input; missing fields use
 * the metadata defaults.
 *
 * When discovery is unavailable — offline, unauthenticated, on any
 * transport/parse failure, or when the endpoint returns no usable models — it
 * returns the configured baseline (empty by default), so the Step catalog is
 * simply empty until a successful fetch.
 */
export async function fetchStepModels(
	context: RefreshModelsContext,
	resolved: ResolvedStepProviderOptions,
): Promise<StepModelConfig[]> {
	const baseline = (): StepModelConfig[] => resolved.models.map((model) => ({ ...model, input: [...model.input] }));
	if (!context.allowNetwork || context.signal.aborted) return baseline();
	const token = readStepBearerToken(context.credential);
	if (!token) return baseline();
	const baseUrl = stepOpenAiBaseUrl(resolved.apiBaseUrl);
	const fetchFn = resolveFetch(resolved.fetch);
	let response: Response;
	try {
		response = await fetchFn(`${baseUrl}/models`, {
			method: "GET",
			headers: { accept: "application/json", authorization: `Bearer ${token}` },
			signal: context.signal,
		});
	} catch {
		return baseline();
	}
	if (!response.ok) return baseline();
	const payload = await readJsonObject(response);
	const data = Array.isArray(payload.data) ? payload.data : [];
	const entries: { id: string; modelType?: string; meta: StepModelMeta }[] = [];
	for (const entry of data) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		const id = readString(record, "id");
		if (!id) continue;
		entries.push({
			id,
			modelType: readString(record, "model_type"),
			meta: {
				contextWindow: readPositiveNumber(record, "max_input_tokens"),
				reasoning: readBoolean(record, "enable_reason"),
				vision: readBoolean(record, "enable_vision_input"),
				efforts: readStringArray(record, "reasoning_effort_support_list"),
			},
		});
	}
	// Keep only large-language models when the endpoint tags model types; if no
	// entry carries a type (older/other endpoints), leave the list unfiltered.
	const typed = entries.some((entry) => entry.modelType !== undefined);
	const usable = typed
		? entries.filter((entry) => entry.modelType !== undefined && STEP_USABLE_MODEL_TYPES.has(entry.modelType))
		: entries;
	const seen = new Set<string>();
	const models: StepModelConfig[] = [];
	for (const entry of usable) {
		if (seen.has(entry.id)) continue;
		seen.add(entry.id);
		models.push(stepModelConfig(entry.id, entry.id, baseUrl, entry.meta));
	}
	return models.length > 0 ? models : baseline();
}

/** Reasoning-effort levels the Step endpoint may report, in ascending order. */
const STEP_EFFORT_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** All selectable thinking levels, including the "off" (no reasoning) option. */
const STEP_THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", ...STEP_EFFORT_LEVELS];

/**
 * Convert a `reasoning_effort_support_list` into a `thinkingLevelMap`: listed
 * levels map to their own effort value; every other level (including `off` when
 * the list omits it) is marked `null` (unsupported), so the `/effort` picker
 * shows exactly what the endpoint reports.
 */
export function stepThinkingLevelMap(efforts: readonly string[]): ThinkingLevelMap {
	const supported = new Set(efforts.map((effort) => effort.trim().toLowerCase()));
	const map: ThinkingLevelMap = {};
	for (const level of STEP_THINKING_LEVELS) {
		map[level] = supported.has(level) ? level : null;
	}
	return map;
}

export interface FetchStepModelEffortsInput {
	/** OpenAI-style base (`.../v1`); the request targets `{baseUrl}/models/{modelId}`. */
	readonly baseUrl: string;
	readonly modelId: string;
	readonly apiKey: string;
	readonly fetch?: typeof fetch;
	readonly signal?: AbortSignal;
}

/**
 * Fetch a single model's supported reasoning efforts from
 * `{baseUrl}/models/{modelId}` (`reasoning_effort_support_list`). Returns
 * `undefined` on any transport/parse failure or when the field is absent.
 */
export async function fetchStepModelEfforts(input: FetchStepModelEffortsInput): Promise<string[] | undefined> {
	if (!input.apiKey.trim()) return undefined;
	const base = input.baseUrl.replace(/\/+$/u, "");
	const fetchFn = resolveFetch(input.fetch);
	let response: Response;
	try {
		response = await fetchFn(`${base}/models/${encodeURIComponent(input.modelId)}`, {
			method: "GET",
			headers: { accept: "application/json", authorization: `Bearer ${input.apiKey}` },
			signal: input.signal,
		});
	} catch {
		return undefined;
	}
	if (!response.ok) return undefined;
	const payload = await readJsonObject(response);
	const list = payload.reasoning_effort_support_list;
	if (!Array.isArray(list)) return undefined;
	const efforts = list.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
	return efforts.length > 0 ? efforts : undefined;
}

function readStepBearerToken(credential: Credential | undefined): string | undefined {
	if (!credential) return undefined;
	if (credential.type === "oauth") return credential.access.trim() || undefined;
	if (credential.type === "api_key") return credential.key?.trim() || undefined;
	return undefined;
}

function nonEmpty(value: string, label: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${label} must not be empty`);
	return trimmed;
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
	const result = value[key];
	return typeof result === "string" && result.trim() ? result.trim() : undefined;
}

function readPositiveNumber(value: Record<string, unknown>, key: string): number | undefined {
	const result = value[key];
	if (typeof result !== "number" || !Number.isFinite(result) || result <= 0) return undefined;
	return result;
}

function readBoolean(value: Record<string, unknown>, key: string): boolean | undefined {
	const result = value[key];
	return typeof result === "boolean" ? result : undefined;
}

function readStringArray(value: Record<string, unknown>, key: string): string[] | undefined {
	const result = value[key];
	if (!Array.isArray(result)) return undefined;
	const items = result.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
	return items.length > 0 ? items : undefined;
}
