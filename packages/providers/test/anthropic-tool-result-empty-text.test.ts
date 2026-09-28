import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/compat.ts";
import type { AssistantMessage, Context, ImageContent, TextContent } from "../src/types.ts";
import { anthropicModel } from "./helpers/step-fixtures.ts";

interface AnthropicBlock {
	type: string;
	text?: string;
	content?: string | AnthropicBlock[];
}

interface AnthropicPayload {
	messages: Array<{ content: string | AnthropicBlock[] }>;
}

class PayloadCaptured extends Error {}

const toolCall: AssistantMessage = {
	role: "assistant",
	content: [{ type: "toolCall", id: "call_1", name: "screenshot", arguments: {} }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-opus-4-6",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
	timestamp: 2,
};

async function toolResultContent(content: (TextContent | ImageContent)[]): Promise<AnthropicBlock[]> {
	const context: Context = {
		messages: [
			{ role: "user", content: "Look", timestamp: 1 },
			toolCall,
			{ role: "toolResult", toolCallId: "call_1", toolName: "screenshot", content, isError: false, timestamp: 3 },
		],
	};
	let captured: AnthropicPayload | undefined;
	const stream = streamSimple(anthropicModel({ input: ["text", "image"], baseUrl: "http://127.0.0.1:9" }), context, {
		apiKey: "fake-key",
		onPayload: (payload) => {
			captured = payload as AnthropicPayload;
			throw new PayloadCaptured();
		},
	});
	await stream.result();
	for (const message of captured?.messages ?? []) {
		if (typeof message.content === "string") continue;
		const result = message.content.find((block) => block.type === "tool_result");
		if (result && Array.isArray(result.content)) return result.content;
	}
	throw new Error("No block-form tool result in payload");
}

describe("Anthropic tool results with images", () => {
	const image: ImageContent = { type: "image", data: "AAAA", mimeType: "image/png" };

	it("drops whitespace-only text blocks the API would reject", async () => {
		const content = await toolResultContent([
			{ type: "text", text: "head" },
			{ type: "text", text: "" },
			{ type: "text", text: " \n" },
			{ type: "text", text: "[notice]" },
			image,
		]);
		expect(content.map((block) => block.type)).toEqual(["text", "text", "image"]);
		expect(content.filter((block) => block.type === "text").map((block) => block.text)).toEqual(["head", "[notice]"]);
	});

	it("keeps the image placeholder when every text block is empty", async () => {
		const content = await toolResultContent([{ type: "text", text: "" }, image]);
		expect(content).toEqual([
			{ type: "text", text: "(see attached image)" },
			expect.objectContaining({ type: "image" }),
		]);
	});
});
