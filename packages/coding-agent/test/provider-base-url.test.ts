import { describe, expect, it } from "vitest";
import { normalizeProviderBaseUrl } from "../src/core/provider-base-url.ts";

describe("normalizeProviderBaseUrl", () => {
	it("strips the version root for anthropic-messages", () => {
		// The Anthropic SDK appends the complete `/v1/messages` operation path, so a
		// configured `/v1` root would produce `/v1/v1/messages`.
		expect(normalizeProviderBaseUrl("https://proxy.example.com/v1", "anthropic-messages")).toBe(
			"https://proxy.example.com",
		);
		expect(normalizeProviderBaseUrl("https://proxy.example.com/v1/", "anthropic-messages")).toBe(
			"https://proxy.example.com",
		);
	});

	it("strips a fully qualified operation path", () => {
		expect(normalizeProviderBaseUrl("https://proxy.example.com/v1/messages", "anthropic-messages")).toBe(
			"https://proxy.example.com",
		);
		expect(normalizeProviderBaseUrl("https://proxy.example.com/v1/chat/completions", "openai-completions")).toBe(
			"https://proxy.example.com/v1",
		);
		expect(normalizeProviderBaseUrl("https://proxy.example.com/v1/responses", "openai-responses")).toBe(
			"https://proxy.example.com/v1",
		);
	});

	it("keeps the version root for OpenAI shaped APIs", () => {
		// These SDKs append only the operation segment, so `/v1` is required.
		expect(normalizeProviderBaseUrl("https://proxy.example.com/v1", "openai-completions")).toBe(
			"https://proxy.example.com/v1",
		);
		expect(normalizeProviderBaseUrl("https://proxy.example.com/v1", "openai-responses")).toBe(
			"https://proxy.example.com/v1",
		);
	});

	it("leaves unrelated paths untouched", () => {
		expect(normalizeProviderBaseUrl("https://gateway.example.com/v1/acct/anthropic", "anthropic-messages")).toBe(
			"https://gateway.example.com/v1/acct/anthropic",
		);
		expect(normalizeProviderBaseUrl("https://proxy.example.com/v1beta", "anthropic-messages")).toBe(
			"https://proxy.example.com/v1beta",
		);
		expect(normalizeProviderBaseUrl("https://api.anthropic.com", "anthropic-messages")).toBe(
			"https://api.anthropic.com",
		);
		expect(normalizeProviderBaseUrl("https://proxy.example.com/openai/v1", "google-generative-ai")).toBe(
			"https://proxy.example.com/openai/v1",
		);
	});

	it("keeps malformed and empty values intact", () => {
		expect(normalizeProviderBaseUrl("not a url/v1", "anthropic-messages")).toBe("not a url/v1");
		expect(normalizeProviderBaseUrl(undefined, "anthropic-messages")).toBeUndefined();
	});
});
