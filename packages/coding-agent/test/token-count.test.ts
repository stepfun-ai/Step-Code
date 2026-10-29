import type { Api, Model } from "@step-harness/providers";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ToolInfo } from "../src/core/extensions/types.ts";
import {
	buildContextTokenCountSegments,
	type ContextReportInput,
	type ContextTokenCountSegment,
	countContextTokenCounts,
} from "../src/step/context-report.ts";
import { countStepTokens, resolveStepTokenCountModel, supportsStepTokenCount } from "../src/step/token-count.ts";

function model(api: Api, baseUrl: string, provider = "step", id = "step-5-preview"): Model<Api> {
	return {
		id,
		name: provider === "step" ? "Step 5 Preview" : "Other model",
		api,
		provider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 64_000,
	};
}

const auth = { ok: true, apiKey: "test-key" } as const;

function tool(name: string): ToolInfo {
	return {
		name,
		description: `${name} description`,
		parameters: { type: "object", properties: {} },
		sourceInfo: { path: `<builtin:${name}>`, source: "builtin", scope: "temporary", origin: "top-level" },
	};
}

function input(): ContextReportInput {
	return {
		systemPrompt: "system prompt",
		systemPromptOptions: { cwd: "/repo" },
		tools: [tool("read")],
		messages: [
			{ role: "user", content: "hello", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
				api: "openai-completions",
				provider: "step",
				model: "step-5-preview",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			},
		],
		contextWindow: 1_000_000,
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("step token count endpoint", () => {
	test("only counts Step endpoints for supported provider APIs", () => {
		expect(supportsStepTokenCount(model("openai-completions", "https://api.stepfun.com/v1"))).toBe(true);
		expect(supportsStepTokenCount(model("anthropic-messages", "https://api.stepfun.ai/v1"))).toBe(true);
		expect(supportsStepTokenCount(model("openai-completions", "https://api.openai.com/v1"))).toBe(false);
		expect(supportsStepTokenCount(model("openai-responses", "https://api.stepfun.com/v1"))).toBe(false);
		expect(supportsStepTokenCount(undefined)).toBe(false);
	});

	test("borrows the Step tokenizer for non-Step providers", () => {
		const registry = {
			getAll: () => [
				model("openai-completions", "https://api.openai.com/v1", "openai", "gpt-5"),
				model("openai-completions", "https://api.stepfun.com/v1", "step", "step-5-preview"),
			],
		} as unknown as Parameters<typeof resolveStepTokenCountModel>[0];

		const active = model("openai-completions", "https://api.openai.com/v1", "openai", "gpt-5");
		const resolved = resolveStepTokenCountModel(registry, active);

		expect(resolved?.id).toBe("step-3.7-flash");
		expect(resolved?.baseUrl).toBe("https://api.stepfun.com/v1");
		expect(
			resolveStepTokenCountModel(
				{ getAll: () => [] } as unknown as Parameters<typeof resolveStepTokenCountModel>[0],
				active,
			),
		).toBeUndefined();
	});

	test("parses the OpenAI-compatible token count response", async () => {
		const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ data: { total_tokens: 42 } }) }));
		vi.stubGlobal("fetch", fetchMock);

		const tokens = await countStepTokens({
			model: model("openai-completions", "https://api.stepfun.com/v1"),
			auth,
			request: { messages: [{ role: "user", content: "hello" }] },
		});

		expect(tokens).toBe(42);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.stepfun.com/v1/token/count",
			expect.objectContaining({ method: "POST" }),
		);
	});

	test("parses the Anthropic messages count response", async () => {
		const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ input_tokens: 17 }) }));
		vi.stubGlobal("fetch", fetchMock);

		const tokens = await countStepTokens({
			model: model("anthropic-messages", "https://api.stepfun.ai/v1"),
			auth,
			request: { messages: [{ role: "user", content: "hello" }], system: "system" },
		});

		expect(tokens).toBe(17);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.stepfun.ai/v1/messages/count_tokens",
			expect.objectContaining({ method: "POST" }),
		);
	});

	test("returns null instead of throwing when the endpoint fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: false, json: async () => ({}) })),
		);
		await expect(
			countStepTokens({
				model: model("openai-completions", "https://api.stepfun.com/v1"),
				auth,
				request: { messages: [] },
			}),
		).resolves.toBeNull();
	});
});

describe("context token-count segments", () => {
	test("builds segmented requests for instructions, tools, and conversation categories", () => {
		const segments = buildContextTokenCountSegments(input(), "openai-completions");
		expect(segments.map((segment) => segment.id)).toEqual([
			"instructions",
			"empty",
			"tools-field",
			"tools-json",
			"conversation",
			"user",
			"assistant",
		]);
	});

	test("prefers the tools field and subtracts the empty-request baseline", async () => {
		const segments: ContextTokenCountSegment[] = [
			{ id: "empty", request: { messages: [] } },
			{ id: "tools-field", request: { messages: [], tools: [{ type: "function" }] } },
			{ id: "tools-json", request: { messages: [{ role: "system", content: "tools" }] } },
			{ id: "conversation", request: { messages: [{ role: "user", content: "hello" }] } },
			{ id: "user", request: { messages: [{ role: "user", content: "hello" }] } },
		];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init: { body: string }) => {
				const body = JSON.parse(init.body) as { messages: unknown[]; tools?: unknown[] };
				if (body.tools) return { ok: true, json: async () => ({ data: { total_tokens: 102 } }) };
				if (body.messages.length === 0) return { ok: true, json: async () => ({ data: { total_tokens: 2 } }) };
				return { ok: true, json: async () => ({ data: { total_tokens: body.messages.length > 1 ? 500 : 100 } }) };
			}),
		);

		const counts = await countContextTokenCounts({
			model: model("openai-completions", "https://api.stepfun.com/v1"),
			auth,
			segments,
		});

		expect(counts.groups).toMatchObject({ instructions: 0, tools: 100, conversation: 100 });
		expect(counts.rows).toMatchObject({ user: 100 });
	});

	test("falls back to local estimation when any segment fails", async () => {
		const segments: ContextTokenCountSegment[] = [
			{ id: "empty", request: { messages: [] } },
			{ id: "instructions", request: { messages: [{ role: "system", content: "system" }] } },
			{ id: "conversation", request: { messages: [{ role: "user", content: "hello" }] } },
			{ id: "user", request: { messages: [{ role: "user", content: "hello" }] } },
		];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init: { body: string }) => {
				const body = JSON.parse(init.body) as { messages: Array<{ content?: string }> };
				if (body.messages[0]?.content === "system") return { ok: false, json: async () => ({}) };
				return { ok: true, json: async () => ({ data: { total_tokens: 10 } }) };
			}),
		);

		const counts = await countContextTokenCounts({
			model: model("openai-completions", "https://api.stepfun.com/v1"),
			auth,
			segments,
		});

		expect(counts).toEqual({});
	});
});
