// Per-tier provider regression for issues/provider-error-body-passthrough.
//
// Routes a 403-with-body error through the real provider catch path for one
// representative per tier (Success Criterion 7): a body-blind text provider
// (openai-completions) and a status-only provider (openai-responses). Each
// asserts the resulting errorMessage carries both the HTTP status and the body
// reason. The already-correct happy path (no double body / no duplicated
// status) is asserted via the shared helper in error-body.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import type { Context, Model } from "../src/types.ts";

// openai SDK APIError shape: "<status> status code (no body)" message, the
// parsed body kept on `.error`.
class FakeAPIError extends Error {
	status: number;
	error: unknown;
	constructor(status: number, parsedBody: unknown) {
		super(`${status} status code (no body)`);
		this.name = "PermissionDeniedError";
		this.status = status;
		this.error = parsedBody;
	}
}

const openaiMock = vi.hoisted(() => ({
	// Default parsed body; individual tests may override before invoking.
	parsedBody: { error: "blocked by gateway WAF" } as unknown,
}));

vi.mock("openai", () => {
	function throwingCreate() {
		const promise = Promise.resolve(undefined) as unknown as { withResponse: () => Promise<never> };
		promise.withResponse = async () => {
			throw new FakeAPIError(403, openaiMock.parsedBody);
		};
		return promise;
	}
	class FakeOpenAI {
		chat = { completions: { create: throwingCreate } };
		responses = { create: throwingCreate };
	}
	return { default: FakeOpenAI };
});

const context: Context = {
	systemPrompt: "",
	messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }],
	tools: [],
};

const completionsModel: Model<"openai-completions"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-completions",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

const responsesModel: Model<"openai-responses"> = {
	id: "gpt-test",
	name: "GPT Test",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

async function drainResult(stream: {
	[Symbol.asyncIterator](): AsyncIterator<unknown>;
	result(): Promise<{ errorMessage?: string; stopReason?: string }>;
}) {
	for await (const _event of stream) {
		void _event;
	}
	return stream.result();
}

describe("provider error body passthrough (per-tier regression)", () => {
	beforeEach(() => {
		openaiMock.parsedBody = { error: "blocked by gateway WAF" };
	});

	it("openai-completions (body-blind text) surfaces status + body", async () => {
		const output = await drainResult(streamOpenAICompletions(completionsModel, context, { apiKey: "test" }));

		expect(output.stopReason).toBe("error");
		expect(output.errorMessage).toContain("403");
		expect(output.errorMessage).toContain("blocked by gateway WAF");
		expect(output.errorMessage).not.toBe("403 status code (no body)");
	});

	it("openai-completions does not double-print the OpenRouter metadata.raw extra", async () => {
		// OpenRouter returns the extra reason under error.error.metadata.raw, which
		// is part of the parsed body normalizeProviderError already surfaces. The
		// manual append must not duplicate it.
		openaiMock.parsedBody = {
			message: "Provider returned error",
			code: 403,
			metadata: { raw: "upstream WAF blocked policy XYZ" },
		};

		const output = await drainResult(streamOpenAICompletions(completionsModel, context, { apiKey: "test" }));

		expect(output.errorMessage).toContain("upstream WAF blocked policy XYZ");
		const occurrences = output.errorMessage?.match(/upstream WAF blocked policy XYZ/g) ?? [];
		expect(occurrences).toHaveLength(1);
	});

	it("openai-responses (status-only) keeps the prefix and surfaces the body", async () => {
		const output = await drainResult(streamOpenAIResponses(responsesModel, context, { apiKey: "test" }));

		expect(output.stopReason).toBe("error");
		expect(output.errorMessage).toContain("OpenAI API error (403)");
		expect(output.errorMessage).toContain("blocked by gateway WAF");
	});
});
