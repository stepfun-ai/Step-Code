// Conformance fixtures for the `google-generative-ai` dialect (design §5.13).
//
// Per the coverage matrix, Google needs at least request snapshot + stream
// events. google-generative-ai talks through the `@google/genai` SDK, so we
// mock that module (the pattern in google-raw-stop-reason.test.ts): the fake
// `generateContentStream` captures the outgoing params and yields canned chunks.

import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context, Model } from "../../src/types.ts";
import { collectEventTypes, resolveAdapter } from "./harness.ts";

interface CapturedParams {
	model: string;
	contents: unknown[];
	config?: {
		systemInstruction?: string;
		tools?: Array<{ functionDeclarations: Array<{ name: string; description?: string }> }>;
	};
}

const mockState = vi.hoisted(() => ({
	lastParams: undefined as CapturedParams | undefined,
	chunks: [] as unknown[],
}));

vi.mock("@google/genai", () => {
	class GoogleGenAI {
		constructor(_config: Record<string, unknown>) {}
		models = {
			generateContentStream: async function* (params: CapturedParams) {
				mockState.lastParams = params;
				for (const chunk of mockState.chunks) yield chunk;
			},
		};
	}
	return {
		FinishReason: {
			STOP: "STOP",
			MAX_TOKENS: "MAX_TOKENS",
			BLOCKLIST: "BLOCKLIST",
			PROHIBITED_CONTENT: "PROHIBITED_CONTENT",
			SPII: "SPII",
			SAFETY: "SAFETY",
			IMAGE_SAFETY: "IMAGE_SAFETY",
			IMAGE_PROHIBITED_CONTENT: "IMAGE_PROHIBITED_CONTENT",
			IMAGE_RECITATION: "IMAGE_RECITATION",
			IMAGE_OTHER: "IMAGE_OTHER",
			RECITATION: "RECITATION",
			FINISH_REASON_UNSPECIFIED: "FINISH_REASON_UNSPECIFIED",
			OTHER: "OTHER",
			LANGUAGE: "LANGUAGE",
			MALFORMED_FUNCTION_CALL: "MALFORMED_FUNCTION_CALL",
			UNEXPECTED_TOOL_CALL: "UNEXPECTED_TOOL_CALL",
			NO_IMAGE: "NO_IMAGE",
		},
		FunctionCallingConfigMode: { AUTO: "AUTO", NONE: "NONE", ANY: "ANY", VALIDATED: "VALIDATED" },
		GoogleGenAI,
		ResourceScope: { COLLECTION: "COLLECTION" },
		ThinkingLevel: {
			THINKING_LEVEL_UNSPECIFIED: "THINKING_LEVEL_UNSPECIFIED",
			MINIMAL: "MINIMAL",
			LOW: "LOW",
			MEDIUM: "MEDIUM",
			HIGH: "HIGH",
		},
	};
});

import { getModel } from "../../src/compat.ts";

const model: Model<"google-generative-ai"> = getModel("google", "gemini-2.5-flash");

const context: Context = {
	systemPrompt: "You are a helpful assistant.",
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	tools: [
		{
			name: "echo",
			description: "Echo a value",
			parameters: Type.Object({ value: Type.String() }),
		},
	],
};

function textChunk(): unknown {
	return {
		responseId: "g-conf-1",
		candidates: [{ content: { parts: [{ text: "Hello" }] }, finishReason: "STOP" }],
		usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
	};
}

describe("google-generative-ai conformance", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
		mockState.chunks = [];
	});

	it("dispatches by dialect through the shared registry (adapter self-reports google-generative-ai)", () => {
		const adapter = resolveAdapter(model.api);
		expect(adapter.api).toBe("google-generative-ai");
	});

	it("request snapshot: canonical request -> google generateContent wire body", async () => {
		mockState.chunks = [textChunk()];
		const adapter = resolveAdapter(model.api);
		await adapter.stream(model, context, { apiKey: "test-api-key" }).result();

		const params = mockState.lastParams;
		expect(params).toBeDefined();
		expect(params?.model).toBe("gemini-2.5-flash");
		expect(Array.isArray(params?.contents)).toBe(true);
		// systemInstruction carries the system prompt.
		expect(params?.config?.systemInstruction).toBe("You are a helpful assistant.");
		// Google tools nest declarations under tools[].functionDeclarations[].name.
		expect(params?.config?.tools?.[0]?.functionDeclarations?.[0]?.name).toBe("echo");
	});

	it("stream events: canned Gemini chunks -> stable canonical event order", async () => {
		mockState.chunks = [textChunk()];
		const adapter = resolveAdapter(model.api);
		const stream = adapter.stream(model, context, { apiKey: "test-api-key" });
		const events = await collectEventTypes(stream);
		const result = await stream.result();

		expect(events).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
		expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
		expect(result.stopReason).toBe("stop");
		expect(result.rawStopReason).toBe("STOP");
		expect(result.errorMessage).toBeUndefined();
	});
});
