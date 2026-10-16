import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import { classifyProviderError, ProviderStreamError } from "../src/utils/error-kind.ts";
import { retryProviderRequest } from "../src/utils/provider-retry.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";

function httpError(status: number | undefined, error?: unknown, extra: Record<string, unknown> = {}): Error {
	return Object.assign(new Error(`${status ?? "no"} status`), { status, headers: new Headers(), error, ...extra });
}

describe("classifyProviderError", () => {
	it("derives the kind from the HTTP status", () => {
		expect(classifyProviderError(httpError(429))).toBe("rate_limit");
		expect(classifyProviderError(httpError(402))).toBe("quota");
		expect(classifyProviderError(httpError(401))).toBe("auth");
		expect(classifyProviderError(httpError(403))).toBe("auth");
		expect(classifyProviderError(httpError(503))).toBe("transient");
		expect(classifyProviderError(httpError(408))).toBe("transient");
		expect(classifyProviderError(httpError(400))).toBe("invalid_request");
	});

	it("separates an exhausted quota from a temporary 429 by its error code", () => {
		expect(
			classifyProviderError(httpError(429, { code: "insufficient_quota" }, { code: "insufficient_quota" })),
		).toBe("quota");
		expect(classifyProviderError(httpError(429, { type: "GoUsageLimitError", message: "limit" }))).toBe("quota");
		expect(classifyProviderError(httpError(429, { code: "rate_limit_exceeded" }))).toBe("rate_limit");
	});

	it("does not classify wording: a 400 that mentions 429 or quota stays a rejected request", () => {
		expect(classifyProviderError(httpError(400, { message: "429 rate limit quota exceeded" }))).toBe(
			"invalid_request",
		);
		expect(classifyProviderError(new Error("429 Too Many Requests"))).toBeUndefined();
	});

	it("reads typed mid-stream errors that carry no status", () => {
		const anthropicSse = '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
		expect(classifyProviderError(new ProviderStreamError(anthropicSse, undefined, anthropicSse))).toBe("transient");
		expect(
			classifyProviderError(new ProviderStreamError("Error Code rate_limit_exceeded", "rate_limit_exceeded")),
		).toBe("rate_limit");
		expect(classifyProviderError(httpError(undefined, { type: "rate_limit_error" }))).toBe("rate_limit");
	});

	it("treats connection failures as transient through the error cause", () => {
		expect(classifyProviderError(Object.assign(new Error("Connection error."), { name: "APIConnectionError" }))).toBe(
			"transient",
		);
		const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
		expect(classifyProviderError(new TypeError("fetch failed", { cause: reset }))).toBe("transient");
	});

	it("keeps a 429 classifiable after the retry helper refuses an oversized Retry-After", async () => {
		const throttled = Object.assign(new Error("slow down"), {
			status: 429,
			headers: new Headers({ "retry-after": "3600" }),
		});
		const failure = await retryProviderRequest(() => Promise.reject(throttled), { maxRetries: 1 }).catch(
			(error: unknown) => error,
		);
		expect(classifyProviderError(failure)).toBe("rate_limit");
	});
});

describe("isRetryableAssistantError with a structured kind", () => {
	it("trusts the kind over the error text", () => {
		const quota = fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" });
		expect(isRetryableAssistantError({ ...quota, errorKind: "quota" })).toBe(false);
		const throttled = fauxAssistantMessage("", { stopReason: "error", errorMessage: "opaque" });
		expect(isRetryableAssistantError({ ...throttled, errorKind: "rate_limit" })).toBe(true);
		expect(isRetryableAssistantError({ ...throttled, errorKind: "invalid_request" })).toBe(false);
	});
});
