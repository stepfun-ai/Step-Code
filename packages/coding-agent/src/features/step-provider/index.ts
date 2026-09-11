import { randomUUID } from "node:crypto";
import process from "node:process";
import type { Api, Model, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	InlineExtension,
	ProviderConfig,
	ProviderModelConfig,
} from "../../core/extensions/types.ts";
import {
	buildStepAuthorizationUrl,
	buildStepCallbackUrl,
	DEFAULT_STEP_OAUTH_TIMEOUT_MS,
	STEP_OAUTH_CALLBACK_PATH,
	type StartStepCallbackServerOptions,
	type StepCallbackResult,
	type StepCallbackServer,
	type StepOAuthErrorCode,
	startStepCallbackServer,
} from "./callback-server.ts";

export type {
	StartStepCallbackServerOptions,
	StepCallbackResult,
	StepCallbackServer,
	StepOAuthErrorCode,
} from "./callback-server.ts";
export {
	buildStepAuthorizationUrl,
	buildStepCallbackUrl,
	DEFAULT_STEP_OAUTH_TIMEOUT_MS,
	STEP_OAUTH_CALLBACK_PATH,
	STEP_OAUTH_CANCEL_PATH,
	STEP_OAUTH_ERROR_CODES,
	startStepCallbackServer,
} from "./callback-server.ts";

/** Provider id used by the default Step extension. */
export const STEP_PROVIDER_ID = "step";

/** Environment variables understood by the Step provider extension. */
export const STEP_PROVIDER_ENV = {
	apiBaseUrl: "STEP_BASE_URL",
	authBaseUrl: "STEP_CLI_DEVCENTER_AUTH_CN_URL",
	tokenUrl: "STEP_OAUTH_TOKEN_URL",
	apiKey: "STEP_API_KEY",
	callbackHost: "STEP_OAUTH_CALLBACK_HOST",
	callbackPort: "STEP_OAUTH_CALLBACK_PORT",
	timeoutMs: "STEP_OAUTH_TIMEOUT_MS",
	clientId: "STEP_OAUTH_CLIENT_ID",
	scope: "STEP_OAUTH_SCOPE",
} as const;

/** Production defaults; every endpoint can be replaced through the options/env. */
export const STEP_PROVIDER_DEFAULTS = {
	// Pi's Anthropic adapter appends `/v1/messages` itself, so this must be the
	// route prefix rather than the versioned operation URL.
	apiBaseUrl: "https://api.stepfun.com/step_plan",
	authBaseUrl: "https://platform.stepfun.com",
	callbackHost: "127.0.0.1",
	callbackPort: 0,
	timeoutMs: DEFAULT_STEP_OAUTH_TIMEOUT_MS,
} as const;

/** Marker used for credentials that contain a non-expiring Step API key. */
export const STEP_STATIC_REFRESH_TOKEN = "step-static-credential";

const STEP_MODEL_COMPAT = {
	forceAdaptiveThinking: true,
	supportsToolReferences: false,
} as const;

/** Models exposed by the Step Plan provider. */
export const STEP_MODELS: readonly ProviderModelConfig[] = [
	{
		id: "step-3.7-flash",
		name: "Step 3.7 Flash",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 256_000,
		maxTokens: 32_000,
		compat: STEP_MODEL_COMPAT,
	},
	{
		id: "step-3.5-flash-2603",
		name: "Step 3.5 Flash (2603)",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 256_000,
		maxTokens: 32_000,
		compat: STEP_MODEL_COMPAT,
	},
	{
		id: "step-3.5-flash",
		name: "Step 3.5 Flash",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 256_000,
		maxTokens: 32_000,
		compat: STEP_MODEL_COMPAT,
	},
	{
		id: "step-router-v1",
		name: "Step Router v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 256_000,
		maxTokens: 32_000,
		compat: STEP_MODEL_COMPAT,
	},
] as const;

// These ids are owned by the Step provider. A stale models.json can carry a
// legacy wire dialect for one of them, but Pi must still send the built-in
// Step catalog through the Anthropic Messages adapter.
const STEP_BUILTIN_MODEL_IDS = new Set(STEP_MODELS.map((model) => model.id.toLowerCase()));

const API_BASE_URL_ENV_NAMES = [
	"STEP_PROVIDER_API_URL",
	"STEP_API_URL",
	STEP_PROVIDER_ENV.apiBaseUrl,
	// Kept for compatibility with the endpoint override used by the legacy
	// Step CLI. It may contain the full `/v1/messages` URL.
	"STEPFUN_MESSAGES_ENDPOINT",
	// Set by the shared Step login flow after reading the stored profile. It is
	// intentionally below explicit user overrides so manual endpoint settings win.
	"STEP_LOGIN_PROFILE_API_URL",
	"STEP_CLI_STEP_PLAN_API_URL",
] as const;
const AUTH_BASE_URL_ENV_NAMES = ["STEP_PROVIDER_AUTH_URL", "STEP_AUTH_URL", STEP_PROVIDER_ENV.authBaseUrl] as const;
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const MAX_ERROR_DETAIL_LENGTH = 240;

export interface StepProviderOptions {
	readonly providerId?: string;
	readonly name?: string;
	readonly apiBaseUrl?: string;
	readonly authBaseUrl?: string;
	readonly tokenUrl?: string;
	readonly apiKeyEnv?: string;
	readonly callbackHost?: string;
	readonly callbackPort?: number;
	readonly timeoutMs?: number;
	readonly clientId?: string;
	readonly scope?: string;
	readonly env?: Record<string, string | undefined>;
	readonly models?: readonly ProviderModelConfig[];
	readonly createState?: () => string;
	readonly createCallbackServer?: CallbackServerFactory;
	readonly fetch?: typeof fetch;
	/** Enable a terminal prompt for hosts where the browser cannot reach loopback. */
	readonly allowManualCallback?: boolean;
}

export interface ResolvedStepProviderOptions {
	readonly providerId: string;
	readonly name: string;
	readonly apiBaseUrl: string;
	readonly authBaseUrl: string;
	readonly tokenUrl?: string;
	readonly apiKeyEnv: string;
	readonly callbackHost: string;
	readonly callbackPort: number;
	readonly timeoutMs: number;
	readonly clientId?: string;
	readonly scope?: string;
	readonly env: Record<string, string | undefined>;
	readonly models: readonly ProviderModelConfig[];
	readonly createState: () => string;
	readonly createCallbackServer: CallbackServerFactory;
	readonly fetch?: typeof fetch;
	readonly allowManualCallback: boolean;
}

export type CallbackServerFactory = (options: StartStepCallbackServerOptions) => Promise<StepCallbackServer>;

/** Resolve provider settings at registration time, after environment setup. */
export function resolveStepProviderOptions(options: StepProviderOptions = {}): ResolvedStepProviderOptions {
	const env = options.env ?? process.env;
	const apiBaseUrl = normalizeStepAnthropicBaseUrl(
		validateHttpEndpoint(
			options.apiBaseUrl ?? readFirstEnv(env, API_BASE_URL_ENV_NAMES) ?? STEP_PROVIDER_DEFAULTS.apiBaseUrl,
			"Step API base URL",
		),
	);
	const authBaseUrl = validateHttpEndpoint(
		options.authBaseUrl ?? readFirstEnv(env, AUTH_BASE_URL_ENV_NAMES) ?? STEP_PROVIDER_DEFAULTS.authBaseUrl,
		"Step OAuth authorization URL",
	);
	const tokenUrlValue = options.tokenUrl ?? readFirstEnv(env, [STEP_PROVIDER_ENV.tokenUrl]);
	const tokenUrl = tokenUrlValue ? validateHttpEndpoint(tokenUrlValue, "Step OAuth token URL") : undefined;
	const providerId = nonEmpty(options.providerId ?? STEP_PROVIDER_ID, "Step provider id");
	const name = nonEmpty(options.name ?? "Step", "Step provider name");
	const apiKeyEnv = nonEmpty(options.apiKeyEnv ?? STEP_PROVIDER_ENV.apiKey, "Step API key environment variable");
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(apiKeyEnv)) {
		throw new Error(`Invalid Step API key environment variable name: ${apiKeyEnv}`);
	}

	const callbackHost =
		options.callbackHost ??
		readFirstEnv(env, [STEP_PROVIDER_ENV.callbackHost]) ??
		STEP_PROVIDER_DEFAULTS.callbackHost;
	const callbackPort =
		options.callbackPort ?? readPortEnv(env[STEP_PROVIDER_ENV.callbackPort]) ?? STEP_PROVIDER_DEFAULTS.callbackPort;
	const timeoutMs =
		options.timeoutMs ?? readPositiveInteger(env[STEP_PROVIDER_ENV.timeoutMs]) ?? STEP_PROVIDER_DEFAULTS.timeoutMs;
	if (timeoutMs <= 0) throw new Error("Step OAuth timeout must be greater than zero");

	const clientId = options.clientId ?? readFirstEnv(env, [STEP_PROVIDER_ENV.clientId]);
	const scope = options.scope ?? readFirstEnv(env, [STEP_PROVIDER_ENV.scope]);
	const models = options.models ?? STEP_MODELS;
	if (models.length === 0) throw new Error("Step provider must expose at least one model");

	return {
		providerId,
		name,
		apiBaseUrl,
		authBaseUrl,
		tokenUrl,
		apiKeyEnv,
		callbackHost,
		callbackPort,
		timeoutMs,
		clientId,
		scope,
		env,
		models,
		createState: options.createState ?? randomUUID,
		createCallbackServer: options.createCallbackServer ?? startStepCallbackServer,
		fetch: options.fetch,
		allowManualCallback: options.allowManualCallback ?? false,
	};
}

/** Build the legacy provider config accepted by `pi.registerProvider()`. */
export function createStepProviderConfig(options: StepProviderOptions = {}): ProviderConfig {
	const resolved = resolveStepProviderOptions(options);
	return createStepProviderConfigFromResolved(resolved);
}

function createStepProviderConfigFromResolved(resolved: ResolvedStepProviderOptions): ProviderConfig {
	return {
		name: resolved.name,
		baseUrl: resolved.apiBaseUrl,
		apiKey: `$${resolved.apiKeyEnv}`,
		api: "anthropic-messages",
		// The built-in catalog is a default; keep custom models migrated from
		// the legacy Step CLI layout (and later user additions) in this provider.
		mergeModelsJson: true,
		// models.json is user-owned and can outlive the provider defaults. Normalize
		// the final composed list as a last line of defense for embedded hosts that
		// do not run Step's startup migration first.
		normalizeModels: (models) => models.map((model) => normalizeStepModel(model, resolved.apiBaseUrl)),
		models: resolved.models.map((model) => normalizeStepModelConfig(model)),
		oauth: {
			name: "Step Plan",
			isSubscription: true,
			login: (callbacks) => loginStepOAuth(callbacks, resolved),
			refreshToken: (credentials, signal) => refreshStepOAuth(credentials, resolved, signal),
			getApiKey: getStepOAuthApiKey,
		},
	};
}

/**
 * A model entry may override the provider URL. Keep that override compatible
 * with Pi's Anthropic adapter as well; otherwise a caller that supplies
 * `/v1/messages` at model level bypasses the provider-level repair.
 */
function normalizeStepModelConfig(model: ProviderModelConfig): ProviderModelConfig {
	const api = model.api ?? "anthropic-messages";
	return {
		...model,
		...(api === "anthropic-messages" && model.baseUrl
			? { baseUrl: normalizeStepAnthropicBaseUrl(model.baseUrl) }
			: {}),
		input: [...model.input],
	};
}

function normalizeStepModel(model: Model<Api>, canonicalBaseUrl: string): Model<Api> {
	if (STEP_BUILTIN_MODEL_IDS.has(model.id.toLowerCase())) {
		// Step owns these ids. Always restore both the wire dialect and endpoint,
		// including files that already say `anthropic-messages` but still point at
		// an old proxy host. Otherwise the models.json overlay can override the
		// provider default and recreate the 404 after a successful login.
		return { ...model, api: "anthropic-messages", baseUrl: canonicalBaseUrl };
	}
	if (model.api !== "anthropic-messages") return model;
	return { ...model, baseUrl: normalizeStepAnthropicBaseUrl(model.baseUrl) };
}

/** Register Step with pi's extension provider registry. */
export function registerStepProvider(
	pi: Pick<ExtensionAPI, "registerProvider">,
	options: StepProviderOptions = {},
): void {
	const resolved = resolveStepProviderOptions(options);
	pi.registerProvider(resolved.providerId, createStepProviderConfigFromResolved(resolved));
}

/** Default extension entry point, loadable with `pi -e`. */
export default function stepProviderExtension(pi: ExtensionAPI): void {
	registerStepProvider(pi);
}

/** Inline extension descriptor for applications that assemble pi's built-ins. */
export const stepProviderInlineExtension: InlineExtension = {
	name: "Step provider",
	factory: stepProviderExtension,
	hidden: true,
};

/** Create an inline extension with explicit provider settings (useful in tests/hosts). */
export function createStepProviderInlineExtension(options: StepProviderOptions = {}): InlineExtension {
	return {
		name: options.name ?? "Step provider",
		factory: (pi) => registerStepProvider(pi, options),
		hidden: true,
	};
}

export async function loginStepOAuth(
	callbacks: OAuthLoginCallbacks,
	options: ResolvedStepProviderOptions | StepOAuthLoginOptions,
): Promise<OAuthCredentials> {
	const resolved = isResolvedOptions(options) ? options : resolveStepProviderOptions(options);
	const state = nonEmpty(resolved.createState(), "Step OAuth state");
	const server = await resolved.createCallbackServer({
		state,
		host: resolved.callbackHost,
		port: resolved.callbackPort,
		timeoutMs: resolved.timeoutMs,
		signal: callbacks.signal,
	});

	try {
		const authUrl = buildStepAuthorizationUrl({
			authBaseUrl: resolved.authBaseUrl,
			port: server.port,
			state,
		});
		callbacks.onAuth({
			url: authUrl,
			instructions: "Complete sign-in in your browser. The terminal will continue automatically.",
		});

		const result = resolved.allowManualCallback
			? await waitForCallbackOrManualInput(server, callbacks, state)
			: await server.waitForResult();
		if (result.kind === "credential") return credentialFromCallback(result);
		if (result.kind === "code") {
			return exchangeAuthorizationCode(result.code, state, server.port, resolved, callbacks.signal);
		}
		if (result.kind === "error") {
			const detail = result.description ? `: ${result.description}` : "";
			throw new Error(`Step OAuth login failed (${result.code})${detail}`);
		}
		if (result.kind === "timeout") throw new Error("Step OAuth login timed out");
		throw new Error("Step OAuth login cancelled");
	} finally {
		await server.close();
	}
}

export interface StepOAuthLoginOptions extends StepProviderOptions {
	readonly authBaseUrl: string;
}

export async function refreshStepOAuth(
	credentials: OAuthCredentials,
	options: ResolvedStepProviderOptions | StepProviderOptions = {},
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	const resolved = isResolvedOptions(options) ? options : resolveStepProviderOptions(options);
	if (credentials.refresh === STEP_STATIC_REFRESH_TOKEN) {
		return { ...credentials, expires: Number.MAX_SAFE_INTEGER };
	}
	if (!credentials.refresh) throw new Error("Step OAuth credentials do not contain a refresh token");
	if (!resolved.tokenUrl) throw new Error("Step OAuth credentials have expired and no token endpoint is configured");
	const refreshed = await requestToken(
		resolved.tokenUrl,
		new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: credentials.refresh,
			...(resolved.clientId ? { client_id: resolved.clientId } : undefined),
		}),
		resolved,
		credentials.refresh,
		signal,
	);
	const uid = readBoundedUid(readString(credentials, "uid"));
	return uid && !readBoundedUid(readString(refreshed, "uid")) ? { ...refreshed, uid } : refreshed;
}

export function getStepOAuthApiKey(credentials: OAuthCredentials): string {
	const access = credentials.access.trim();
	if (!access) throw new Error("Step OAuth credentials do not contain an access token");
	return access;
}

function isResolvedOptions(
	options: StepProviderOptions | ResolvedStepProviderOptions,
): options is ResolvedStepProviderOptions {
	return (
		"providerId" in options &&
		"name" in options &&
		"apiBaseUrl" in options &&
		"authBaseUrl" in options &&
		"apiKeyEnv" in options &&
		"callbackHost" in options &&
		"callbackPort" in options &&
		"timeoutMs" in options &&
		"env" in options &&
		"models" in options &&
		"createState" in options &&
		"createCallbackServer" in options &&
		"allowManualCallback" in options
	);
}

async function exchangeAuthorizationCode(
	code: string,
	state: string,
	callbackPort: number,
	options: ResolvedStepProviderOptions,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	if (!options.tokenUrl) throw new Error("Step OAuth callback returned a code but no token endpoint is configured");
	const redirectUri = buildStepCallbackUrl({
		host: options.callbackHost,
		port: callbackPort,
		path: STEP_OAUTH_CALLBACK_PATH,
	});
	return requestToken(
		options.tokenUrl,
		new URLSearchParams({
			grant_type: "authorization_code",
			code,
			state,
			redirect_uri: redirectUri,
			...(options.clientId ? { client_id: options.clientId } : undefined),
			...(options.scope ? { scope: options.scope } : undefined),
		}),
		options,
		undefined,
		signal,
	);
}

async function requestToken(
	tokenUrl: string,
	body: URLSearchParams,
	options: ResolvedStepProviderOptions,
	previousRefreshToken?: string,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	const fetchFn = resolveFetch(options.fetch);
	let response: Response;
	try {
		response = await fetchFn(tokenUrl, {
			method: "POST",
			headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
			body,
			signal,
		});
	} catch (error) {
		if (signal?.aborted) throw new Error("Step OAuth login cancelled");
		throw new Error(`Step OAuth token request failed: ${describeError(error)}`);
	}

	const payload = await readJsonObject(response);
	if (!response.ok) {
		throw new Error(`Step OAuth token request failed (HTTP ${response.status})${tokenErrorDetail(payload)}`);
	}

	const access = readString(payload, "access_token") ?? readString(payload, "access");
	if (!access) throw new Error("Step OAuth token response did not contain an access token");
	const refresh = readString(payload, "refresh_token") ?? readString(payload, "refresh") ?? previousRefreshToken ?? "";
	const expiresIn = readPositiveNumber(payload, "expires_in") ?? readPositiveNumber(payload, "expires");
	const uid = readBoundedUid(readString(payload, "uid") ?? readString(payload, "user_id"));
	return {
		access,
		refresh,
		expires: expiresIn ? Date.now() + expiresIn * 1000 - REFRESH_SKEW_MS : Number.MAX_SAFE_INTEGER,
		...(uid ? { uid } : undefined),
	};
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

function readBoundedUid(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed || trimmed.length > 64 || !/^[\w.@:-]+$/u.test(trimmed)) return undefined;
	return trimmed;
}

function credentialFromCallback(result: Extract<StepCallbackResult, { kind: "credential" }>): OAuthCredentials {
	const expires = result.expiresInSeconds
		? Date.now() + result.expiresInSeconds * 1000 - REFRESH_SKEW_MS
		: Number.MAX_SAFE_INTEGER;
	return {
		access: result.apiKey,
		refresh: result.refreshToken ?? (result.expiresInSeconds ? "" : STEP_STATIC_REFRESH_TOKEN),
		expires,
		...(result.uid ? { uid: result.uid } : undefined),
	};
}

async function waitForCallbackOrManualInput(
	server: StepCallbackServer,
	callbacks: OAuthLoginCallbacks,
	expectedState: string,
): Promise<StepCallbackResult> {
	const callback = server.waitForResult();
	const manual = callbacks.onManualCodeInput
		? callbacks.onManualCodeInput()
		: callbacks.onPrompt({
				message: "Paste the Step callback URL (or API key) if the browser cannot reach this terminal:",
			});
	const manualResult = manual.then((value): StepCallbackResult => parseManualCallback(value, expectedState));
	return Promise.race([callback, manualResult]);
}

function parseManualCallback(value: string, expectedState: string): StepCallbackResult {
	const trimmed = value.trim();
	if (!trimmed) return { kind: "error", code: "unknown", description: "Empty callback input" };
	try {
		const url = new URL(trimmed);
		const state = url.searchParams.get("state")?.trim();
		if (state && state !== expectedState) {
			return { kind: "error", code: "unknown", description: "OAuth state mismatch" };
		}
		const error = url.searchParams.get("error")?.trim();
		if (error) {
			return {
				kind: "error",
				code: isKnownErrorCode(error) ? error : "unknown",
				description: url.searchParams.get("error_description")?.trim() || undefined,
			};
		}
		const apiKey = url.searchParams.get("api_key")?.trim() ?? url.searchParams.get("access_token")?.trim();
		if (apiKey) {
			const uid = readBoundedUid(url.searchParams.get("uid") ?? undefined);
			return { kind: "credential", apiKey, ...(uid ? { uid } : undefined) };
		}
		const code = url.searchParams.get("code")?.trim();
		return code ? { kind: "code", code } : { kind: "error", code: "unknown", description: "Missing callback result" };
	} catch {
		return { kind: "credential", apiKey: trimmed };
	}
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

function readPortEnv(value: string | undefined): number | undefined {
	if (value === undefined || value.trim() === "") return undefined;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
		throw new Error("STEP_OAUTH_CALLBACK_PORT must be an integer between 0 and 65535");
	}
	return parsed;
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
 * Pi's Anthropic SDK always appends `/v1/messages` to `baseUrl`. Step's older
 * configuration accepted either that operation URL or its `/v1` parent, so
 * normalize all three supported spellings to the route prefix before handing
 * the model to Pi.
 */
export function normalizeStepAnthropicBaseUrl(value: string): string {
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
		// entries must remain intact for Pi's normal validation diagnostics.
		return value;
	}
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

function tokenErrorDetail(value: Record<string, unknown>): string {
	const error = readString(value, "error");
	const description = readString(value, "error_description");
	const detail = [error, description].filter((part): part is string => Boolean(part)).join(": ");
	return detail ? `: ${detail.slice(0, MAX_ERROR_DETAIL_LENGTH)}` : "";
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isKnownErrorCode(value: string): value is StepOAuthErrorCode {
	return ["no_access_key", "access_denied", "bad_request", "server_error"].includes(value as StepOAuthErrorCode);
}
