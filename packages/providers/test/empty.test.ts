import { describe, expect, it } from "vitest";
import { complete, getModel } from "../src/compat.ts";
import type { Api, AssistantMessage, Context, Model, StreamOptions, UserMessage } from "../src/types.ts";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

import { resolveApiKey } from "./oauth.ts";

// Resolve OAuth tokens at module level (async, runs before tests)
const anthropicOAuthToken = await resolveApiKey("anthropic");

async function testEmptyMessage<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	// Test with completely empty content array
	const emptyMessage: UserMessage = {
		role: "user",
		content: [],
		timestamp: Date.now(),
	};

	const context: Context = {
		messages: [emptyMessage],
	};

	const response = await complete(llm, context, options);

	// Should either handle gracefully or return an error
	expect(response).toBeDefined();
	expect(response.role).toBe("assistant");
	// Should handle empty string gracefully
	if (response.stopReason === "error") {
		expect(response.errorMessage).toBeDefined();
	} else {
		expect(response.content).toBeDefined();
	}
}

async function testEmptyStringMessage<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	// Test with empty string content
	const context: Context = {
		messages: [
			{
				role: "user",
				content: "",
				timestamp: Date.now(),
			},
		],
	};

	const response = await complete(llm, context, options);

	expect(response).toBeDefined();
	expect(response.role).toBe("assistant");

	// Should handle empty string gracefully
	if (response.stopReason === "error") {
		expect(response.errorMessage).toBeDefined();
	} else {
		expect(response.content).toBeDefined();
	}
}

async function testWhitespaceOnlyMessage<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	// Test with whitespace-only content
	const context: Context = {
		messages: [
			{
				role: "user",
				content: "   \n\t  ",
				timestamp: Date.now(),
			},
		],
	};

	const response = await complete(llm, context, options);

	expect(response).toBeDefined();
	expect(response.role).toBe("assistant");

	// Should handle whitespace-only gracefully
	if (response.stopReason === "error") {
		expect(response.errorMessage).toBeDefined();
	} else {
		expect(response.content).toBeDefined();
	}
}

async function testEmptyAssistantMessage<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	// Test with empty assistant message in conversation flow
	// User -> Empty Assistant -> User
	const emptyAssistant: AssistantMessage = {
		role: "assistant",
		content: [],
		api: llm.api,
		provider: llm.provider,
		model: llm.id,
		usage: {
			input: 10,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	const context: Context = {
		messages: [
			{
				role: "user",
				content: "Hello, how are you?",
				timestamp: Date.now(),
			},
			emptyAssistant,
			{
				role: "user",
				content: "Please respond this time.",
				timestamp: Date.now(),
			},
		],
	};

	const response = await complete(llm, context, options);

	expect(response).toBeDefined();
	expect(response.role).toBe("assistant");

	// Should handle empty assistant message in context gracefully
	if (response.stopReason === "error") {
		expect(response.errorMessage).toBeDefined();
	} else {
		expect(response.content).toBeDefined();
		expect(response.content.length).toBeGreaterThan(0);
	}
}

describe("AI Providers Empty Message Tests", () => {
	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Completions Provider Empty Messages", () => {
		const llm = getModel("openai", "gpt-4o-mini");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Responses Provider Empty Messages", () => {
		const llm = getModel("openai", "gpt-5-mini");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic Provider Empty Messages", () => {
		const llm = getModel("anthropic", "claude-haiku-4-5");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	// =========================================================================
	// OAuth-based providers (credentials from ~/.pi/agent/oauth.json)
	// =========================================================================

	describe("Anthropic OAuth Provider Empty Messages", () => {
		const llm = getModel("anthropic", "claude-haiku-4-5");

		it.skipIf(!anthropicOAuthToken)("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm, { apiKey: anthropicOAuthToken });
		});

		it.skipIf(!anthropicOAuthToken)("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm, { apiKey: anthropicOAuthToken });
		});

		it.skipIf(!anthropicOAuthToken)(
			"should handle whitespace-only content",
			{ retry: 3, timeout: 30000 },
			async () => {
				await testWhitespaceOnlyMessage(llm, { apiKey: anthropicOAuthToken });
			},
		);

		it.skipIf(!anthropicOAuthToken)(
			"should handle empty assistant message in conversation",
			{ retry: 3, timeout: 30000 },
			async () => {
				await testEmptyAssistantMessage(llm, { apiKey: anthropicOAuthToken });
			},
		);
	});
});
