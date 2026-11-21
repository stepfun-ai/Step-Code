import type { SearchFailure, SearchFailureKind } from "./types.ts";

/**
 * Everything a transport can observe about one failed call. Providers disagree
 * on how they report failure, so classification never relies on a single field:
 * - some answer HTTP 200 with `isError: true` and the reason in the text,
 * - some answer a non-2xx status with a JSON body,
 * - some answer a JSON-RPC error object.
 *
 * Treating only the HTTP status as the signal would report those `isError`
 * answers as "no results", which also stops the fallback chain from advancing.
 */
export interface FailureInput {
	status?: number;
	/** JSON-RPC error code and message, when the body carried one. */
	jsonrpcError?: { code: number; message: string };
	/** MCP tool result flag. */
	isError?: boolean;
	/** Response text, used for both `isError` reasons and status-code fallbacks. */
	text?: string;
	/** Transport-level error (DNS, TLS, reset) rather than a response. */
	networkError?: string;
	/** The caller's own signal fired; this is a user cancellation, not a timeout. */
	cancelled?: boolean;
	/** `Retry-After` in milliseconds, when a response carried one. */
	retryAfterMs?: number;
}

/** Patterns are matched against the provider's own text; order matters. */
const AUTH_PATTERN = /unauthori[sz]ed|forbidden|invalid[^.]{0,20}key|api key is invalid|authentication failed/iu;
const RATE_LIMIT_PATTERN = /rate limit|too many requests|throttl/iu;
// Providers spell the daily ceiling several ways: `daily_cap_reached`,
// `daily limit`, `reached the daily ... limit`.
const QUOTA_PATTERN =
	/quota|credits?\b|daily[_\s-]?cap|daily[_\s-]?limit|usage limit|out of credits|reached (?:the|your) daily/iu;
const SERVER_PATTERN = /internal server error|bad gateway|service unavailable|gateway timeout/iu;

function kindFromStatus(status: number): SearchFailureKind | undefined {
	if (status === 401 || status === 403) return "auth";
	if (status === 402) return "quota";
	if (status === 429) return "rate_limit";
	if (status >= 500) return "server";
	return undefined;
}

function kindFromText(text: string): SearchFailureKind | undefined {
	if (AUTH_PATTERN.test(text)) return "auth";
	if (QUOTA_PATTERN.test(text)) return "quota";
	if (RATE_LIMIT_PATTERN.test(text)) return "rate_limit";
	if (SERVER_PATTERN.test(text)) return "server";
	return undefined;
}

/**
 * Classify one failure. Precedence is `isError` text, then HTTP status, then
 * status-shaped text, then unknown.
 *
 * The text first order matters: a provider that answers 200 with an `isError`
 * body reports the same conditions (auth, quota, rate limit) that others report
 * through a status code, and the chain must treat both identically.
 */
export function classifyFailure(input: FailureInput): SearchFailure {
	if (input.cancelled) {
		return { kind: "cancelled", detail: "search cancelled" };
	}
	if (input.networkError) {
		return { kind: "network", detail: input.networkError, ...retryAfter(input.retryAfterMs) };
	}

	const text = input.text?.trim();
	const fromText = text ? kindFromText(text) : undefined;
	const fromStatus = input.status === undefined ? undefined : kindFromStatus(input.status);
	// An `isError` body is the provider's own verdict, so its text outranks the
	// status code it was delivered with.
	let kind: SearchFailureKind = input.isError
		? (fromText ?? fromStatus ?? "unknown")
		: (fromStatus ?? fromText ?? "unknown");
	// A daily ceiling arrives under the generic 429 code. It is a quota, not a
	// burst limit: naming it correctly matters for diagnostics, and the same
	// call would otherwise look like a transient spike.
	if (kind === "rate_limit" && fromText === "quota") kind = "quota";

	if (input.jsonrpcError && kind === "unknown") {
		return {
			kind: "unsupported",
			detail: `JSON-RPC ${input.jsonrpcError.code}: ${input.jsonrpcError.message}`,
			...(input.status === undefined ? {} : { status: input.status }),
		};
	}

	return {
		kind,
		detail: text || `HTTP ${input.status ?? "?"}`,
		...(input.status === undefined ? {} : { status: input.status }),
		...retryAfter(input.retryAfterMs),
	};
}

function retryAfter(retryAfterMs: number | undefined): { retryAfterMs?: number } {
	return retryAfterMs === undefined ? {} : { retryAfterMs };
}

/** Parse a `Retry-After` header as milliseconds; both the seconds and date forms are allowed. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	const seconds = Number(trimmed);
	if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : undefined;
	const at = Date.parse(trimmed);
	return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}
