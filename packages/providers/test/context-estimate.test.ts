import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { buildBaseOptions } from "../src/api/simple-options.ts";
import type { AssistantMessage, Context, Model, Usage } from "../src/types.ts";
import { estimateContextTokens } from "../src/utils/estimate.ts";

function createUsage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(timestamp: number, totalTokens: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "kept" }],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: createUsage(totalTokens),
		stopReason: "stop",
		timestamp,
	};
}

const model: Model<"openai-responses"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 8_000,
};

describe("context token estimation", () => {
	it("uses the request estimate to clamp output despite stale historical usage without mutating it", () => {
		const assistant = createAssistant(100, 9_500);
		assistant.usage.cost.input = 9.5;
		assistant.usage.cost.total = 9.5;
		const originalUsage = assistant.usage;
		const context: Context = {
			estimatedInputTokens: 1_000,
			messages: [assistant, { role: "user", content: "tail", timestamp: 200 }],
		};
		const original = structuredClone(context);

		expect(estimateContextTokens(context)).toEqual({
			tokens: 1_000,
			usageTokens: 0,
			trailingTokens: 1_000,
			lastUsageIndex: null,
		});
		expect(buildBaseOptions(model, context).maxTokens).toBe(4_904);
		expect(context).toEqual(original);
		expect(assistant.usage).toBe(originalUsage);
	});

	it("treats the request estimate as already including system and tools", () => {
		const context: Context = {
			estimatedInputTokens: 1_000,
			systemPrompt: "system".repeat(100),
			tools: [{ name: "test", description: "tool".repeat(100), parameters: Type.Object({}) }],
			messages: [{ role: "user", content: "prompt", timestamp: 100 }],
		};

		expect(estimateContextTokens(context)).toEqual({
			tokens: 1_000,
			usageTokens: 0,
			trailingTokens: 1_000,
			lastUsageIndex: null,
		});
		expect(buildBaseOptions(model, context).maxTokens).toBe(4_904);
	});

	it.each([
		[0, 0],
		[1_000.1, 1_001],
	])("accepts request estimate %s and rounds it up to %s tokens", (estimatedInputTokens, tokens) => {
		const context: Context = { estimatedInputTokens, messages: [createAssistant(100, 9_500)] };

		expect(estimateContextTokens(context)).toEqual({
			tokens,
			usageTokens: 0,
			trailingTokens: tokens,
			lastUsageIndex: null,
		});
		expect(buildBaseOptions(model, context).maxTokens).toBe(10_000 - tokens - 4_096);
	});

	it.each([undefined, Number.NaN, -1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
		"preserves usage-based estimation for missing or invalid request estimate %s",
		(estimatedInputTokens) => {
			const context: Context = {
				estimatedInputTokens,
				messages: [createAssistant(100, 9_500), { role: "user", content: "tail", timestamp: 200 }],
			};

			expect(estimateContextTokens(context)).toEqual({
				tokens: 9_501,
				usageTokens: 9_500,
				trailingTokens: 1,
				lastUsageIndex: 0,
			});
			expect(buildBaseOptions(model, context).maxTokens).toBe(1);
		},
	);

	it("preserves usage-based estimation for message arrays", () => {
		const context: Context = {
			estimatedInputTokens: 1_000,
			messages: [createAssistant(100, 9_500), { role: "user", content: "tail", timestamp: 200 }],
		};

		expect(estimateContextTokens(context.messages)).toEqual({
			tokens: 9_501,
			usageTokens: 9_500,
			trailingTokens: 1,
			lastUsageIndex: 0,
		});
	});

	it("ignores stale assistant usage after a newer message is inserted before it", () => {
		const context: Context = {
			systemPrompt: "system",
			messages: [
				{ role: "user", content: "summary", timestamp: 200 },
				createAssistant(100, 9_500),
				{ role: "user", content: "x".repeat(4_000), timestamp: 300 },
			],
		};

		expect(estimateContextTokens(context)).toEqual({
			tokens: 1_005,
			usageTokens: 0,
			trailingTokens: 1_005,
			lastUsageIndex: null,
		});
		expect(buildBaseOptions(model, context).maxTokens).toBe(4_899);
	});

	it("uses assistant usage again after a response to the inserted context", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "summary", timestamp: 200 },
				createAssistant(100, 9_500),
				{ role: "user", content: "new prompt", timestamp: 300 },
				createAssistant(400, 2_000),
				{ role: "user", content: "tail", timestamp: 500 },
			],
		};

		expect(estimateContextTokens(context)).toEqual({
			tokens: 2_001,
			usageTokens: 2_000,
			trailingTokens: 1,
			lastUsageIndex: 3,
		});
	});
});
