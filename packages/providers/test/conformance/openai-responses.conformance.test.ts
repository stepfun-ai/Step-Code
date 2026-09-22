// Conformance fixtures for the `openai-responses` dialect (design §5.13).
//
// Covers all three fixture kinds. openai-responses drives the `openai` SDK,
// which issues its HTTP request through `globalThis.fetch` — so, like the
// existing openai-responses-compat.test.ts, we spy on fetch to (a) capture the
// serialized wire body and (b) feed a canned Responses SSE stream or a wire
// error Response. The request payload the adapter builds is captured via its
// `onPayload` hook (the object serialized onto the wire).

import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context, Model } from "../../src/types.ts";
import { responsesModel } from "../helpers/step-fixtures.ts";
import { collectEventTypes, jsonErrorResponse, openAiDataSse, resolveAdapter, sseResponse } from "./harness.ts";

interface ResponsesPayload {
	model: string;
	stream?: boolean;
	store?: boolean;
	input: Array<{ role?: string; type?: string; content?: unknown }>;
	tools?: Array<{ type?: string; name?: string }>;
}

const model: Model<"openai-responses"> = responsesModel();

const context: Context = {
	systemPrompt: "You are a helpful assistant.",
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	tools: [
		{
			name: "ping",
			description: "Ping a host",
			parameters: Type.Object({ host: Type.String() }),
		},
	],
};

function textResponseSse(): string {
	return openAiDataSse([
		{ type: "response.created", response: { id: "resp_conf_1" } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: "msg_conf_1", status: "in_progress", role: "assistant", content: [] },
		},
		{ type: "response.output_text.delta", output_index: 0, item_id: "msg_conf_1", content_index: 0, delta: "Hello" },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "message",
				id: "msg_conf_1",
				status: "completed",
				role: "assistant",
				content: [{ type: "output_text", text: "Hello", annotations: [] }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: "resp_conf_1",
				status: "completed",
				usage: {
					input_tokens: 10,
					output_tokens: 2,
					total_tokens: 12,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		},
	]);
}

describe("openai-responses conformance", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("dispatches by dialect through the shared registry (adapter self-reports openai-responses)", () => {
		const adapter = resolveAdapter(model.api);
		expect(adapter.api).toBe("openai-responses");
	});

	it("request snapshot: canonical request -> openai responses wire body", async () => {
		let rawBody: string | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			rawBody = typeof init?.body === "string" ? init.body : undefined;
			return sseResponse(textResponseSse());
		});

		let payload: ResponsesPayload | undefined;
		const adapter = resolveAdapter(model.api);
		await adapter
			.stream(model, context, {
				apiKey: "test-key",
				onPayload: (p) => {
					payload = p as ResponsesPayload;
				},
			})
			.result();

		expect(payload).toBeDefined();
		// Responses protocol shape: model + `input` array (not `messages`) + stream/store flags.
		expect(payload?.model).toBe("step-5-preview");
		expect(payload?.stream).toBe(true);
		expect(payload?.store).toBe(false);
		expect(Array.isArray(payload?.input)).toBe(true);
		// A user turn is present in the `input` items.
		expect(payload?.input.some((item) => item.role === "user")).toBe(true);
		// Responses tools carry `name` at the top level (not nested under `.function`).
		expect(payload?.tools?.[0]?.name).toBe("ping");
		// The captured payload is what got serialized onto the wire.
		expect(rawBody).toBeDefined();
		expect(JSON.parse(rawBody as string).model).toBe("step-5-preview");
	});

	it("stream events: canned Responses SSE -> stable canonical event order", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse(textResponseSse()));

		const adapter = resolveAdapter(model.api);
		const stream = adapter.stream(model, context, { apiKey: "test-key" });
		const events = await collectEventTypes(stream);
		const result = await stream.result();

		expect(events).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
		expect(result.content).toEqual([{ type: "text", text: "Hello", textSignature: expect.any(String) }]);
		expect(result.stopReason).toBe("stop");
		expect(result.responseId).toBe("resp_conf_1");
		expect(result.errorMessage).toBeUndefined();
	});

	it("error normalization: wire 403 error Response -> normalized error model", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonErrorResponse(403, {
				error: { message: "gateway WAF blocked request", type: "forbidden", code: "forbidden" },
			}),
		);

		const adapter = resolveAdapter(model.api);
		const stream = adapter.stream(model, context, { apiKey: "test-key", maxRetries: 0 });
		const events = await collectEventTypes(stream);
		const result = await stream.result();

		expect(events.at(-1)).toBe("error");
		expect(result.stopReason).toBe("error");
		// openai-responses prefixes normalized errors with "OpenAI API error".
		expect(result.errorMessage).toContain("OpenAI API error");
		expect(result.errorMessage).toContain("403");
		expect(result.errorMessage).toContain("gateway WAF blocked request");
	});
});
