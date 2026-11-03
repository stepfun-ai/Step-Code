/**
 * Structured classification of provider failures.
 *
 * Retry and admission decisions must not depend on how a provider happens to
 * word its error text. The kind is derived from the HTTP status, the provider's
 * machine-readable error `type`/`code`, and transport error codes, at the point
 * where the SDK error object is still available. Errors that carry none of
 * these signals stay unclassified (`undefined`) and callers fall back to their
 * legacy heuristics.
 */
export type ProviderErrorKind =
	/** Temporary throttling (HTTP 429 or a provider rate-limit code). Retry after a delay. */
	| "rate_limit"
	/** Billing, plan, or quota exhaustion. Retrying cannot succeed. */
	| "quota"
	/** Missing, invalid, or insufficient credentials. */
	| "auth"
	/** Server overload, 5xx, timeouts, and dropped connections. Safe to retry. */
	| "transient"
	/** The request itself was rejected (4xx other than the above). */
	| "invalid_request";

/** Error thrown for an error event inside an otherwise successful stream. */
export class ProviderStreamError extends Error {
	readonly code: string | undefined;
	readonly error: unknown;

	constructor(message: string, code?: string, body?: unknown) {
		super(message);
		this.name = "ProviderStreamError";
		this.code = code;
		this.error = body;
	}
}

// Machine-readable error codes/types, compared exactly, never searched in text.
const QUOTA_CODES = new Set([
	"insufficient_quota",
	"billing_hard_limit_reached",
	"billing_not_active",
	"billing_error",
	"usage_limit_reached",
	"quota_exceeded",
	// OpenCode Zen returns these as 429 JSON error types for subscription limits.
	"GoUsageLimitError",
	"FreeUsageLimitError",
]);
const RATE_LIMIT_CODES = new Set(["rate_limit_exceeded", "rate_limit_error", "rate_limited", "too_many_requests"]);
const TRANSIENT_CODES = new Set([
	"overloaded_error",
	"api_error",
	"server_error",
	"service_unavailable",
	"internal_error",
	"timeout_error",
	"stream_incomplete",
]);
const AUTH_CODES = new Set(["authentication_error", "permission_error", "invalid_api_key"]);
const NETWORK_CODES = new Set([
	"ECONNRESET",
	"ECONNREFUSED",
	"ECONNABORTED",
	"ETIMEDOUT",
	"ENOTFOUND",
	"EAI_AGAIN",
	"EPIPE",
	"ENETUNREACH",
	"EHOSTUNREACH",
	"UND_ERR_SOCKET",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
]);
const CONNECTION_ERROR_NAMES = new Set(["APIConnectionError", "APIConnectionTimeoutError"]);

export function classifyProviderError(error: unknown): ProviderErrorKind | undefined {
	return classify(error, 0);
}

function classify(error: unknown, depth: number): ProviderErrorKind | undefined {
	if (!error || typeof error !== "object" || depth > 3) return undefined;
	const record = error as Record<string, unknown>;
	const codes = collectCodes(record);
	if (codes.some((code) => QUOTA_CODES.has(code))) return "quota";
	const status = statusOf(record);
	if (status === 402) return "quota";
	if (status === 429 || codes.some((code) => RATE_LIMIT_CODES.has(code))) return "rate_limit";
	if (status === 401 || status === 403 || codes.some((code) => AUTH_CODES.has(code))) return "auth";
	if (
		status === 408 ||
		status === 409 ||
		(status !== undefined && status >= 500) ||
		codes.some((code) => TRANSIENT_CODES.has(code))
	) {
		return "transient";
	}
	if (status !== undefined && status >= 400) return "invalid_request";
	if (typeof record.name === "string" && CONNECTION_ERROR_NAMES.has(record.name)) return "transient";
	if (typeof record.code === "string" && NETWORK_CODES.has(record.code)) return "transient";
	return classify(record.cause, depth + 1);
}

function statusOf(record: Record<string, unknown>): number | undefined {
	for (const value of [
		record.status,
		record.statusCode,
		(record.$metadata as Record<string, unknown> | undefined)?.httpStatusCode,
	]) {
		if (typeof value === "number" && Number.isInteger(value)) return value;
	}
	return undefined;
}

/** `code`/`type` fields from the SDK error and its parsed body, outermost first. */
function collectCodes(record: Record<string, unknown>): string[] {
	const codes: string[] = [];
	const visit = (value: unknown, depth: number): void => {
		if (depth > 3) return;
		if (typeof value === "string") {
			const parsed = parseJsonObject(value);
			if (parsed) visit(parsed, depth + 1);
			return;
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) return;
		const item = value as Record<string, unknown>;
		for (const key of ["code", "type"]) {
			const field = item[key];
			if (typeof field === "string" && field !== "error") codes.push(field);
		}
		visit(item.error, depth + 1);
	};
	visit(record, 0);
	visit(record.body, 1);
	return codes;
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
	const trimmed = value.trim();
	if (!trimmed.startsWith("{")) return undefined;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}
