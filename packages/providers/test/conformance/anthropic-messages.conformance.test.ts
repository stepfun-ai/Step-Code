// Conformance fixtures for the `anthropic-messages` dialect (design §5.13).
//
// Covers all three fixture kinds. anthropic-messages talks through the
// `@anthropic-ai/sdk` client; the adapter accepts an injected `client`
// (options.client), which the existing anthropic-sse-parsing.test.ts uses. We
// inject a fake client that (a) captures the request params for the snapshot
// and (b) returns a canned SSE Response (success or an `event: error` wire
// frame) via `asResponse()`.

import type Anthropic from "@anthropic-ai/sdk";
import { Type } from "typebox";
import { beforeEach, describe, expect, it } from "vitest";
import type { AnthropicOptions } from "../../src/api/anthropic-messages.ts";
import type { Context, Model } from "../../src/types.ts";
import { anthropicModel } from "../helpers/step-fixtures.ts";
import { anthropicEventSse, collectEventTypes, resolveAdapter, sseResponse } from "./harness.ts";

interface CapturedParams {
	model: string;
	stream?: boolean;
	max_tokens?: number;
	system?: Array<{ type: string; text: string }>;
	messages: Array<{ role: string; content: unknown }>;
	tools?: Array<{ name: string; description?: string; input_schema?: unknown }>;
}

let captured: CapturedParams | undefined;

// A fresh Response per call: response bodies are single-use, so the factory
// must mint a new one each time the adapter reads it.
function fakeClient(makeResponse: () => Response): Anthropic {
	return {
		messages: {
			create: (params: CapturedParams) => {
				captured = params;
				return { asResponse: async () => makeResponse() };
			},
		},
	} as unknown as Anthropic;
}

const successSseBody = anthropicEventSse([
	{
		event: "message_start",
		data: {
			type: "message_start",
			message: {
				id: "msg_conf",
				usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		},
	},
	{
		event: "content_block_start",
		data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	},
	{
		event: "content_block_delta",
		data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
	},
	{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
	{
		event: "message_delta",
		data: {
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
	},
	{ event: "message_stop", data: { type: "message_stop" } },
]);

const successSse = () => sseResponse(successSseBody);

const model: Model<"anthropic-messages"> = anthropicModel();

const context: Context = {
	systemPrompt: "You are a helpful assistant.",
	messages: [{ role: "user", content: "Use the edit tool.", timestamp: Date.now() }],
	tools: [
		{
			name: "edit",
			description: "Edit a file",
			parameters: Type.Object({ path: Type.String(), text: Type.String() }),
		},
	],
};

describe("anthropic-messages conformance", () => {
	beforeEach(() => {
		captured = undefined;
	});

	it("dispatches by dialect through the shared registry (adapter self-reports anthropic-messages)", () => {
		const adapter = resolveAdapter(model.api);
		expect(adapter.api).toBe("anthropic-messages");
	});

	it("request snapshot: canonical request -> anthropic messages wire body", async () => {
		const adapter = resolveAdapter(model.api);
		const options: AnthropicOptions = { client: fakeClient(successSse) };
		await adapter.stream(model, context, options).result();

		expect(captured).toBeDefined();
		// Protocol shape: model + streaming flag + max_tokens.
		expect(captured?.model).toBe("step-5-preview");
		expect(captured?.stream).toBe(true);
		expect(typeof captured?.max_tokens).toBe("number");
		// system is a typed text-block array carrying the system prompt.
		expect(captured?.system?.[0]).toMatchObject({ type: "text", text: "You are a helpful assistant." });
		// messages[].role — the user turn.
		expect(captured?.messages.some((m) => m.role === "user")).toBe(true);
		// Anthropic tools carry `name` + `input_schema` (not `parameters`).
		expect(captured?.tools?.[0]?.name).toBe("edit");
		expect(captured?.tools?.[0]?.input_schema).toMatchObject({ type: "object" });
	});

	it("stream events: canned Anthropic SSE -> stable canonical event order", async () => {
		const adapter = resolveAdapter(model.api);
		const options: AnthropicOptions = { client: fakeClient(successSse) };
		const stream = adapter.stream(model, context, options);
		const events = await collectEventTypes(stream);
		const result = await stream.result();

		expect(events).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
		expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
		expect(result.stopReason).toBe("stop");
		expect(result.rawStopReason).toBe("end_turn");
		expect(result.errorMessage).toBeUndefined();
	});

	it("error normalization: wire error SSE frame -> normalized error model", async () => {
		const errorSse = () =>
			sseResponse(
				anthropicEventSse([
					{
						event: "error",
						data: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
					},
				]),
			);
		const adapter = resolveAdapter(model.api);
		const options: AnthropicOptions = { client: fakeClient(errorSse) };
		const stream = adapter.stream(model, context, options);
		const events = await collectEventTypes(stream);
		const result = await stream.result();

		expect(events.at(-1)).toBe("error");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("overloaded_error");
		expect(result.errorMessage).toContain("Overloaded");
	});
});
