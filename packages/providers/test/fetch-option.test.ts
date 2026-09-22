import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimple as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { streamSimple as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { streamSimple as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import type { Api, Context, FetchFunction, Model } from "../src/types.ts";

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

function createModel<TApi extends Api>(api: TApi): Model<TApi> {
	return {
		id: "test-model",
		name: "Test Model",
		api,
		provider: "test-provider",
		baseUrl: "https://upstream.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10_000,
		maxTokens: 1_000,
	};
}

function mockFetches() {
	const fallback = vi.fn<FetchFunction>(async () => {
		throw new Error("ambient fetch must not be called");
	});
	const custom = vi.fn<FetchFunction>(
		async () =>
			new Response(JSON.stringify({ error: { message: "upstream rejected request" } }), {
				status: 401,
				headers: { "content-type": "application/json" },
			}),
	);
	vi.stubGlobal("fetch", fallback);
	return { custom, fallback };
}

function expectOnlyCustomFetch(
	custom: ReturnType<typeof vi.fn<FetchFunction>>,
	fallback: ReturnType<typeof vi.fn<FetchFunction>>,
) {
	expect(custom).toHaveBeenCalled();
	expect(fallback).not.toHaveBeenCalled();
	expect(globalThis.fetch).toBe(fallback);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("fetch stream option", () => {
	it("passes fetch through streamSimple to the Anthropic SDK", async () => {
		const { custom, fallback } = mockFetches();
		await streamAnthropic(createModel("anthropic-messages"), context, {
			apiKey: "test-key",
			fetch: custom,
			maxRetries: 0,
		}).result();
		expectOnlyCustomFetch(custom, fallback);
	});

	it("passes fetch through streamSimple to OpenAI SDK adapters", async () => {
		const { custom, fallback } = mockFetches();
		const adapters = [
			() =>
				streamOpenAICompletions(createModel("openai-completions"), context, {
					apiKey: "test-key",
					fetch: custom,
					maxRetries: 0,
				}).result(),
			() =>
				streamOpenAIResponses(createModel("openai-responses"), context, {
					apiKey: "test-key",
					fetch: custom,
					maxRetries: 0,
				}).result(),
		];
		for (const run of adapters) {
			await run();
		}
		expect(custom).toHaveBeenCalledTimes(adapters.length);
		expect(fallback).not.toHaveBeenCalled();
		expect(globalThis.fetch).toBe(fallback);
	});
});
