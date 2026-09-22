import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import type { AssistantMessageEvent, Context, Model } from "../src/types.ts";
import { anthropicModel } from "./helpers/step-fixtures.ts";

// Feedback: in `--mode json` the `message_start` event already carried streamed
// content (e.g. thinking="The") that then repeated in the following
// thinking_delta. Root cause: every stream event aliased the same mutable
// `output`, so the empty `start` snapshot was mutated in place before a consumer
// serialized it. The `start` event must expose an empty content array that stays
// empty regardless of when it is read.

const mockState = vi.hoisted(() => ({ chunks: [] as unknown[], responseEvents: [] as unknown[] }));

function makeStreamResult(items: unknown[]) {
	const stream = {
		async *[Symbol.asyncIterator]() {
			for (const item of items) yield item;
		},
	};
	const result = Promise.resolve(stream) as Promise<typeof stream> & {
		withResponse: () => Promise<{ data: typeof stream; response: { status: number; headers: Headers } }>;
	};
	result.withResponse = async () => ({
		data: stream,
		response: { status: 200, headers: new Headers() },
	});
	return result;
}

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = { completions: { create: () => makeStreamResult(mockState.chunks) } };
		responses = { create: () => makeStreamResult(mockState.responseEvents) };
	}
	return { default: FakeOpenAI };
});

async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function findStart(events: AssistantMessageEvent[]): Extract<AssistantMessageEvent, { type: "start" }> {
	const start = events.find(
		(event): event is Extract<AssistantMessageEvent, { type: "start" }> => event.type === "start",
	);
	if (!start) throw new Error("no start event");
	return start;
}

describe("provider start event content snapshot", () => {
	it("anthropic: start event content stays empty after thinking deltas mutate the message", async () => {
		const model = anthropicModel();
		const context: Context = {
			messages: [{ role: "user", content: "OK", timestamp: 1 }],
		};
		const body = [
			{
				event: "message_start",
				data: JSON.stringify({
					type: "message_start",
					message: {
						id: "m",
						usage: {
							input_tokens: 1,
							output_tokens: 0,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					},
				}),
			},
			{
				event: "content_block_start",
				data: JSON.stringify({
					type: "content_block_start",
					index: 0,
					content_block: { type: "thinking", thinking: "", signature: "sig" },
				}),
			},
			{
				event: "content_block_delta",
				data: JSON.stringify({
					type: "content_block_delta",
					index: 0,
					delta: { type: "thinking_delta", thinking: "The" },
				}),
			},
			{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
			{
				event: "message_delta",
				data: JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "end_turn" },
					usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
				}),
			},
			{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
		]
			.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`)
			.join("\n");
		const response = new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
		const client = {
			messages: { create: () => ({ asResponse: async () => response }) },
		} as unknown as Anthropic;

		const events = await collectEvents(streamAnthropic(model, context, { client }));

		// Deltas still built the final content...
		expect(events.some((event) => event.type === "thinking_delta" && event.delta === "The")).toBe(true);
		// ...but the start event must remain the empty initial snapshot.
		expect(findStart(events).partial.content).toEqual([]);
	});

	it("openai-completions: start event content stays empty after reasoning deltas mutate the message", async () => {
		const model: Model<"openai-completions"> = {
			id: "test-model",
			name: "Test",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 4096,
		};
		mockState.chunks = [
			{ id: "c", model: "test-model", choices: [{ index: 0, delta: { reasoning: "The" }, finish_reason: null }] },
			{ id: "c", model: "test-model", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] },
			{ id: "c", model: "test-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
		];

		const events = await collectEvents(
			streamOpenAICompletions(model, { messages: [], tools: [] }, { apiKey: "test" }),
		);

		expect(events.some((event) => event.type === "thinking_delta" && event.delta === "The")).toBe(true);
		expect(findStart(events).partial.content).toEqual([]);
	});

	it("openai-responses: start event content stays empty after reasoning deltas mutate the message", async () => {
		const model: Model<"openai-responses"> = {
			id: "gpt-5-mini",
			name: "GPT-5 Mini",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400_000,
			maxTokens: 128_000,
		};
		mockState.responseEvents = [
			{ type: "response.created", sequence_number: 0, response: { id: "r" } },
			{
				type: "response.output_item.added",
				sequence_number: 1,
				output_index: 0,
				item: { type: "reasoning", id: "rs", summary: [] },
			},
			{
				type: "response.reasoning_text.delta",
				sequence_number: 2,
				output_index: 0,
				content_index: 0,
				item_id: "rs",
				delta: "The",
			},
			{
				type: "response.completed",
				sequence_number: 3,
				response: {
					id: "r",
					status: "completed",
					usage: {
						input_tokens: 1,
						output_tokens: 1,
						total_tokens: 2,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		];
		const context: Context = {
			systemPrompt: "",
			messages: [{ role: "user", content: [{ type: "text", text: "OK" }], timestamp: 0 }],
			tools: [],
		};

		const stream = streamOpenAIResponses(model, context, { apiKey: "test" });
		const events = await collectEvents(stream);
		const result = await stream.result();

		// Deltas built content...
		expect(result.content.length).toBeGreaterThan(0);
		// ...but the start event must remain the empty initial snapshot.
		expect(findStart(events).partial.content).toEqual([]);
	});
});
