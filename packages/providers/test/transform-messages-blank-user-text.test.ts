import { describe, expect, it } from "vitest";
import { transformMessages } from "../src/api/transform-messages.ts";
import type { ImageContent, Message, Model } from "../src/types.ts";

function makeModel(input: Model<"openai-completions">["input"]): Model<"openai-completions"> {
	return {
		id: "fixture",
		name: "Fixture",
		api: "openai-completions",
		provider: "fixture",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16000,
	};
}

const image: ImageContent = { type: "image", data: "Zml4dHVyZQ==", mimeType: "image/png" };

function userMessage(content: Extract<Message, { role: "user" }>["content"]): Message {
	return { role: "user", content, timestamp: 0 };
}

describe("transformMessages blank user text", () => {
	it("drops the blank text block of an image-only prompt", () => {
		const [message] = transformMessages(
			[userMessage([{ type: "text", text: " \n" }, image])],
			makeModel(["text", "image"]),
		);
		expect(message?.content).toEqual([image]);
	});

	it("leaves only the placeholder for an image-only prompt on a non-vision model", () => {
		const [message] = transformMessages([userMessage([{ type: "text", text: "" }, image])], makeModel(["text"]));
		expect(message?.content).toEqual([{ type: "text", text: "(image omitted: model does not support images)" }]);
	});

	it("keeps text beside images and does not empty a text-only message", () => {
		const withText = userMessage([{ type: "text", text: "look" }, image]);
		const blankOnly = userMessage([{ type: "text", text: "" }]);
		expect(transformMessages([withText, blankOnly], makeModel(["text", "image"]))).toEqual([withText, blankOnly]);
	});
});
