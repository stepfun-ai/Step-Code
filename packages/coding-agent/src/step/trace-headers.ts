import { createHash } from "node:crypto";
import process from "node:process";

/** Values copied from the request context into Step's attribution headers. */
export interface StepTraceContext {
	readonly sessionId?: string;
	readonly goalId?: string;
	readonly attemptId?: string;
	readonly harnessId?: string;
	readonly spanId?: string;
	readonly workspaceId?: string;
	readonly provider?: string;
	readonly model?: string;
}

export interface StepTraceHeaderOptions {
	/** URL of the request being decorated, when the caller knows it. */
	readonly requestUrl?: string;
	/** Trusted URL prefixes allowed to receive the high-sensitivity headers. */
	readonly allowedBaseUrls?: readonly string[];
	/** Low-sensitivity client label sent to the provider. */
	readonly clientType?: string;
}

const PRINTABLE_ASCII_HEADER_VALUE = /^[\x20-\x7e]*$/u;
const TRACE_HEADER_ENVELOPE_PREFIX = "~";
const MAX_TRACE_HEADER_VALUE_LENGTH = 512;

const TRACE_HEADER_ENV_NAMES = [
	"STEP_CLI_CLOUD_TRACE_ENDPOINT",
	"STEPCLI_CLOUD_TRACE_ENDPOINT",
	"STEP_CLI_CLOUD_TRACE_ORIGIN",
	"STEPCLI_CLOUD_TRACE_ORIGIN",
	"STEP_TRACE_HEADER_BASE_URLS",
] as const;

/**
 * Providers whose requests are routed through the legacy ObservableServer
 * detour.  The native Step provider is deliberately absent: its
 * `/step_plan/v1` endpoint is a direct model endpoint, not the cloud-trace
 * collector.  Treating every `step` URL as trusted would both leak the
 * high-sensitivity headers to custom Step-compatible endpoints and mark every
 * direct request as `routed_via_cloud_trace`.
 */
const STEP_TRACE_PRODUCT_PROVIDERS = new Set(["stepfunModelProxy", "neocodex"]);

const BUILTIN_CLOUD_TRACE_ORIGINS = {
	dev: "https://test-openapi-stepcliobserserver.c.stepfun-inc.net",
	release: "https://api.stepfun.com/stepcliobserserver",
} as const;

/**
 * Add Step attribution headers in place.
 *
 * `x-step-client` is deliberately sent to every Step request. Session and
 * workspace identifiers are only added for a trusted URL prefix. A missing
 * request URL is treated as the legacy trusted-provider case; Pi's resolved
 * model always has a URL, while this fallback keeps extension hosts that only
 * expose the old event shape source-compatible.
 */
export function applyStepTraceHeaders(
	headers: Record<string, string | null>,
	trace: StepTraceContext,
	options: StepTraceHeaderOptions = {},
): void {
	setHeader(headers, "x-step-client", options.clientType ?? "cli");

	const traceAllowed =
		options.requestUrl === undefined ||
		options.allowedBaseUrls === undefined ||
		matchesStepTraceBaseUrl(options.requestUrl, options.allowedBaseUrls);
	if (!traceAllowed) return;

	setHeader(headers, "x-step-session-id", trace.sessionId);
	setHeader(headers, "x-step-goal-id", trace.goalId);
	setHeader(headers, "x-step-attempt-id", trace.attemptId);
	setHeader(headers, "x-step-harness-id", trace.harnessId);
	setHeader(headers, "x-step-span-id", trace.spanId);
	setHeader(headers, "x-step-workspace-id", trace.workspaceId);
	setHeader(headers, "x-step-provider-id", trace.provider);
	setHeader(headers, "x-step-model", trace.model);
}

/**
 * Resolve configured cloud-trace prefixes and optionally include the model's
 * own endpoint. Values are lexical prefixes, matching the old transport.
 */
export function resolveStepTraceHeaderBaseUrls(
	modelBaseUrl?: string,
	env: Record<string, string | undefined> = process.env,
): string[] {
	const values: string[] = [];
	if (modelBaseUrl) values.push(modelBaseUrl);
	for (const name of TRACE_HEADER_ENV_NAMES) {
		const value = env[name];
		if (!value) continue;
		values.push(...value.split(","));
	}
	return [...new Set(values.map(normalizeUrlPrefix).filter(Boolean))];
}

/** Whether a provider uses the product-owned endpoint trust rule. */
export function isStepTraceProductProvider(provider: string | undefined): boolean {
	return provider !== undefined && STEP_TRACE_PRODUCT_PROVIDERS.has(provider);
}

/**
 * Resolve the exact allowlist used by both header injection and telemetry.
 * Explicit environment prefixes apply to every provider; product/legacy MP
 * providers additionally trust their resolved model endpoint.
 */
export function resolveStepTraceAllowlist(
	provider: string | undefined,
	modelBaseUrl?: string,
	env: Record<string, string | undefined> = process.env,
): string[] {
	return resolveStepTraceHeaderBaseUrls(isStepTraceProductProvider(provider) ? modelBaseUrl : undefined, env);
}

/**
 * Resolve the allowlist used by the live Step entrypoint.
 *
 * The compatibility helper above intentionally keeps its historical
 * model-endpoint behaviour for extension hosts.  The live transport follows
 * the old Step CLI more strictly: only explicit prefixes and the
 * provider-specific ObservableServer origin are trusted.  In particular, a
 * user supplied model URL is never promoted to a trace destination merely
 * because the model uses the `step` provider id.
 */
export function resolveStepTraceRuntimeAllowlist(
	provider: string | undefined,
	env: Record<string, string | undefined> = process.env,
): string[] {
	const values = resolveStepTraceHeaderBaseUrls(undefined, env);
	if (isStepTraceProductProvider(provider)) {
		values.push(resolveBuiltinCloudTraceOrigin(env));
	}
	return [...new Set(values.map(normalizeUrlPrefix).filter(Boolean))];
}

/** Shared predicate for high-sensitivity trace headers and routed telemetry. */
export function isStepTraceRequestAllowed(
	provider: string | undefined,
	requestUrl: string,
	env: Record<string, string | undefined> = process.env,
): boolean {
	return matchesStepTraceBaseUrl(requestUrl, resolveStepTraceAllowlist(provider, requestUrl, env));
}

/** Predicate paired with {@link resolveStepTraceRuntimeAllowlist}. */
export function isStepTraceRequestAllowedForRuntime(
	provider: string | undefined,
	requestUrl: string,
	env: Record<string, string | undefined> = process.env,
): boolean {
	return matchesStepTraceBaseUrl(requestUrl, resolveStepTraceRuntimeAllowlist(provider, env));
}

/** Match a URL against a configured prefix without widening `/v1` to `/v10`. */
export function matchesStepTraceBaseUrl(requestUrl: string, allowedBaseUrls: readonly string[]): boolean {
	const normalizedRequestUrl = normalizeUrlPrefix(requestUrl);
	return allowedBaseUrls.some((baseUrl) => {
		const normalizedBaseUrl = normalizeUrlPrefix(baseUrl);
		return (
			normalizedBaseUrl.length > 0 &&
			(normalizedRequestUrl === normalizedBaseUrl ||
				normalizedRequestUrl.startsWith(`${normalizedBaseUrl}/`) ||
				normalizedRequestUrl.startsWith(`${normalizedBaseUrl}?`) ||
				normalizedRequestUrl.startsWith(`${normalizedBaseUrl}#`))
		);
	});
}

/** Encode a trace value so it is safe in an HTTP header and bounded in size. */
export function encodeStepTraceHeaderValue(value: string): string {
	let encodedValue: string;
	if (PRINTABLE_ASCII_HEADER_VALUE.test(value) && !value.startsWith(TRACE_HEADER_ENVELOPE_PREFIX)) {
		encodedValue = value;
	} else if (PRINTABLE_ASCII_HEADER_VALUE.test(value)) {
		// Reserve the envelope prefix so literal and encoded values stay distinct.
		encodedValue = `~a:${Buffer.from(value, "utf8").toString("base64url")}`;
	} else {
		const utf8Value = Buffer.from(value, "utf8");
		if (utf8Value.toString("utf8") === value) {
			const uriEncoded = `~p:${encodeURI(value)}`;
			const base64Encoded = `~b:${utf8Value.toString("base64url")}`;
			encodedValue = base64Encoded.length < uriEncoded.length ? base64Encoded : uriEncoded;
		} else {
			// Preserve lone UTF-16 surrogates instead of replacing them with U+FFFD.
			encodedValue = `~w:${Buffer.from(value, "utf16le").toString("base64url")}`;
		}
	}

	if (encodedValue.length <= MAX_TRACE_HEADER_VALUE_LENGTH) return encodedValue;

	// The collector stores these values in a varchar(512). Hash original UTF-16
	// code units so malformed surrogate sequences remain stable and distinct.
	const digest = createHash("sha256").update(Buffer.from(value, "utf16le")).digest("base64url");
	return `~h:${digest}`;
}

function setHeader(headers: Record<string, string | null>, name: string, value: string | undefined): void {
	const normalized = value?.trim();
	if (!normalized) return;

	// Remove case variants first so a caller cannot smuggle two values for the
	// same attribution field through a Headers implementation.
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === name) delete headers[key];
	}
	headers[name] = encodeStepTraceHeaderValue(normalized);
}

function normalizeUrlPrefix(value: string): string {
	return value.trim().replace(/\/+$/u, "");
}

function resolveBuiltinCloudTraceOrigin(env: Record<string, string | undefined>): string {
	const channel = env.STEP_CLI_BUILD_CHANNEL;
	return channel?.trim() === "release" ? BUILTIN_CLOUD_TRACE_ORIGINS.release : BUILTIN_CLOUD_TRACE_ORIGINS.dev;
}
