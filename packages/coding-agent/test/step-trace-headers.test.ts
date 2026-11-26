import { describe, expect, it } from "vitest";
import {
	applyStepTraceHeaders,
	encodeStepTraceHeaderValue,
	isStepFirstPartyTraceUrl,
	isStepTraceRequestAllowed,
	matchesStepTraceBaseUrl,
	resolveStepTraceAllowlist,
	resolveStepTraceHeaderBaseUrls,
} from "../src/step/trace-headers.ts";

function decode(value: string): string {
	const mode = value.slice(0, 3);
	const payload = value.slice(3);
	switch (mode) {
		case "~a:":
		case "~b:":
			return Buffer.from(payload, "base64url").toString("utf8");
		case "~p:":
			return decodeURI(payload);
		case "~w:":
			return Buffer.from(payload, "base64url").toString("utf16le");
		default:
			return value;
	}
}

const trace = {
	sessionId: "session-1",
	goalId: "goal-1",
	attemptId: "attempt-1",
	harnessId: "harness-1",
	spanId: "span-1",
	workspaceId: "/tmp/工作区",
	provider: "step",
	model: "step-3.7-flash",
} as const;

describe("Step trace headers", () => {
	it("encodes non-ASCII values without losing the original text", () => {
		const value = encodeStepTraceHeaderValue(trace.workspaceId);
		expect(value).toMatch(/^~[bp]:/u);
		expect(decode(value)).toBe(trace.workspaceId);
	});

	it("keeps literal envelope-looking ASCII values unambiguous", () => {
		const value = encodeStepTraceHeaderValue("~a:already-encoded");
		expect(value).toMatch(/^~a:/u);
		expect(decode(value)).toBe("~a:already-encoded");
	});

	it("preserves lone UTF-16 surrogates", () => {
		const value = encodeStepTraceHeaderValue("/tmp/\ud800");
		expect(value).toMatch(/^~w:/u);
		expect(decode(value)).toBe("/tmp/\ud800");
	});

	it("hashes values whose encoded representation exceeds the collector budget", () => {
		const value = encodeStepTraceHeaderValue(`/tmp/${"中".repeat(200)}`);
		expect(value).toMatch(/^~h:[A-Za-z0-9_-]{43}$/u);
		expect(value.length).toBeLessThanOrEqual(512);
		expect(value).toBe(encodeStepTraceHeaderValue(`/tmp/${"中".repeat(200)}`));
	});

	it("replaces client case variants without adding trace fields for untrusted URLs", () => {
		const headers: Record<string, string | null> = {
			"X-Step-Client": "stale",
			"x-step-session-id": "stale-session",
			accept: "application/json",
		};
		applyStepTraceHeaders(headers, trace, {
			clientType: " cli ",
			requestUrl: "https://other.example/v1/messages",
			allowedBaseUrls: ["https://allowed.example/v1"],
		});

		expect(headers).toEqual({
			"x-step-client": "cli",
			"x-step-session-id": "stale-session",
			accept: "application/json",
		});
	});

	it("treats an explicitly empty allowlist as untrusted", () => {
		const headers: Record<string, string | null> = {};
		applyStepTraceHeaders(headers, trace, {
			requestUrl: "https://collector.example/v1/messages",
			allowedBaseUrls: [],
		});
		expect(headers).toEqual({ "x-step-client": "cli" });
	});

	it("sends the session id as x-session-id on Step's first-party hosts", () => {
		for (const requestUrl of [
			"https://api.stepfun.com/step_plan/v1/chat/completions",
			"https://api.stepfun.com/v1/messages",
			"https://api.stepfun.ai/v1/responses",
		]) {
			const headers: Record<string, string | null> = {};
			// No allowlist and no field policy: the first-party host still gets the
			// session id, and nothing else, under the vendor-neutral name.
			applyStepTraceHeaders(headers, trace, { requestUrl, allowedBaseUrls: [] });
			expect(headers).toEqual({ "x-step-client": "cli", "x-session-id": "session-1" });
		}
	});

	it("keeps the session id off every other host", () => {
		const headers: Record<string, string | null> = {};
		applyStepTraceHeaders(headers, trace, {
			requestUrl: "https://api.stepfun.com.example/v1",
			allowedBaseUrls: [],
		});
		expect(headers).toEqual({ "x-step-client": "cli" });
	});

	it("omits x-session-id on a first-party host when the session id is absent", () => {
		const headers: Record<string, string | null> = {};
		applyStepTraceHeaders(headers, {}, { requestUrl: "https://api.stepfun.com/step_plan/v1", allowedBaseUrls: [] });
		expect(headers).toEqual({ "x-step-client": "cli" });
	});

	it("recognizes only https first-party hosts", () => {
		expect(isStepFirstPartyTraceUrl("https://api.stepfun.com/step_plan/v1")).toBe(true);
		expect(isStepFirstPartyTraceUrl("https://API.Stepfun.Com/v1")).toBe(true);
		expect(isStepFirstPartyTraceUrl("https://api.stepfun.ai/v1")).toBe(true);
		expect(isStepFirstPartyTraceUrl("http://api.stepfun.com/v1")).toBe(false);
		expect(isStepFirstPartyTraceUrl("https://api.stepfun.com.evil/v1")).toBe(false);
		expect(isStepFirstPartyTraceUrl(undefined)).toBe(false);
	});

	it("does not duplicate the session id when the first-party host is also allowlisted", () => {
		const headers: Record<string, string | null> = {};
		applyStepTraceHeaders(headers, trace, {
			requestUrl: "https://api.stepfun.com/step_plan/v1",
			allowedBaseUrls: ["https://api.stepfun.com/step_plan/v1"],
			highSensitivityFields: ["session-id"],
		});
		expect(headers).toEqual({ "x-step-client": "cli", "x-session-id": "session-1" });
	});

	it("matches only a complete URL prefix", () => {
		const allowed = ["https://collector.example/v1/"];
		expect(matchesStepTraceBaseUrl("https://collector.example/v1/messages", allowed)).toBe(true);
		expect(matchesStepTraceBaseUrl("https://collector.example/v1?x=1", allowed)).toBe(true);
		expect(matchesStepTraceBaseUrl("https://collector.example/v10/messages", allowed)).toBe(false);
		expect(matchesStepTraceBaseUrl("https://collector.example/v1.evil/messages", allowed)).toBe(false);
	});

	it("combines the model endpoint with configured trace prefixes", () => {
		expect(
			resolveStepTraceHeaderBaseUrls("https://model.example/v1", {
				STEPCODE_CLOUD_TRACE_ENDPOINT: "https://collector.example/v1, https://model.example/v1/",
				STEPCODE_CLOUD_TRACE_ORIGIN: "https://origin.example",
			}),
		).toEqual(["https://model.example/v1", "https://collector.example/v1", "https://origin.example"]);
	});

	it("uses the same allowlist predicate for Step/MP and configured providers", () => {
		expect(resolveStepTraceAllowlist("stepfunModelProxy", "https://mp.example/v1", {})).toEqual([
			"https://mp.example/v1",
		]);
		expect(isStepTraceRequestAllowed("stepfunModelProxy", "https://mp.example/v1/chat", {})).toBe(true);
		expect(isStepTraceRequestAllowed("openai", "https://mp.example/v1/chat", {})).toBe(false);
		expect(
			isStepTraceRequestAllowed("openai", "https://trace.example/v1/chat", {
				STEPCODE_CLOUD_TRACE_ORIGIN: "https://trace.example/v1",
			}),
		).toBe(true);
	});
});
