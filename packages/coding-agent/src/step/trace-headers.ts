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
	/** High-sensitivity fields permitted by the host observability policy. */
	readonly highSensitivityFields?: readonly string[];
}

const PRINTABLE_ASCII_HEADER_VALUE = /^[\x20-\x7e]*$/u;
const TRACE_HEADER_ENVELOPE_PREFIX = "~";
const MAX_TRACE_HEADER_VALUE_LENGTH = 512;

const TRACE_HEADER_ENV_NAMES = [
	"STEPCODE_CLOUD_TRACE_ENDPOINT",
	"STEPCODE_CLOUD_TRACE_ORIGIN",
	"STEP_TRACE_HEADER_BASE_URLS",
] as const;

/**
 * Providers whose model endpoint IS the ObservableServer cloud-trace detour.
 * Used only by the cloud-trace URL allowlist below (telemetry's
 * `routed_via_cloud_trace` and trusted-prefix resolution) — NOT by the
 * attribution-header gate, which keys on the request URL allowlist and the
 * host-provided high-sensitivity field list (see {@link applyStepTraceHeaders}).
 * The native Step provider is absent here because its `/step_plan/v1` is a
 * direct model endpoint, not the cloud-trace collector, so its requests must
 * not be marked `routed_via_cloud_trace`.
 */
const STEP_TRACE_PRODUCT_PROVIDERS = new Set(["stepfunModelProxy", "neocodex"]);

/**
 * Add Step attribution headers in place.
 *
 * `x-step-client` is sent on every request. The high-sensitivity fields
 * (session/workspace/goal/...) are sent only when the request URL matches
 * `options.allowedBaseUrls` AND the field appears in
 * `options.highSensitivityFields`; an omitted or empty field list sends none of
 * them (fail closed), so the local cwd and session id never egress to a
 * third-party model endpoint. Values are size-bounded and header-safe via
 * {@link encodeStepTraceHeaderValue}.
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

	const fields = options.highSensitivityFields;
	// Fail closed: a policy that omits the field list (undefined) must not leak
	// every high-sensitivity header — treat it the same as an empty allowance.
	if (!fields || fields.length === 0) return;
	const allowed = new Set(fields);
	const setIfAllowed = (field: string, value: string | undefined): void => {
		if (allowed.has(field)) setHeader(headers, `x-step-${field}`, value);
	};
	setIfAllowed("session-id", trace.sessionId);
	setIfAllowed("goal-id", trace.goalId);
	setIfAllowed("attempt-id", trace.attemptId);
	setIfAllowed("harness-id", trace.harnessId);
	setIfAllowed("span-id", trace.spanId);
	setIfAllowed("workspace-id", trace.workspaceId);
	setIfAllowed("provider-id", trace.provider);
	setIfAllowed("model", trace.model);
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
 * the old StepCode more strictly: only explicit prefixes and the
 * provider-specific ObservableServer origin are trusted.  In particular, a
 * user supplied model URL is never promoted to a trace destination merely
 * because the model uses the `step` provider id.
 */
export function resolveStepTraceRuntimeAllowlist(
	provider: string | undefined,
	env: Record<string, string | undefined> = process.env,
): string[] {
	void provider;
	return resolveStepTraceHeaderBaseUrls(undefined, env);
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
