import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/compat.ts";
import type { Api, Context, Model, SimpleStreamOptions } from "../src/types.ts";
import { anthropicModel, responsesModel, stepModel } from "./helpers/step-fixtures.ts";

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

/**
 * A user message as the coding agent records it: the text carries the rendered
 * skill instructions, and `skills` locates each body inside that text. The
 * field is transcript metadata, so a provider request must carry the text only.
 */
function makeContext(): Context {
	const text =
		'<skill name="a" location="/skills/a.md">\nReferences are relative to /skills.\n\nBODY_A\n</skill>\n\ndo it';
	return {
		messages: [
			{
				role: "user",
				content: [{ type: "text", text }],
				skills: [{ name: "a", location: "/skills/a.md", start: 23, end: 66, digest: "digest" }],
				timestamp: Date.now(),
			},
		],
	};
}

async function capturePayload(model: Model<Api>, options?: SimpleStreamOptions): Promise<string> {
	let captured: unknown;
	const stream = streamSimple(model, makeContext(), {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			captured = payload;
			throw new PayloadCaptured();
		},
	});

	await stream.result();
	if (captured === undefined) throw new Error("Expected payload to be captured before request failure");
	return JSON.stringify(captured);
}

describe("recorded skill spans stay out of provider requests", () => {
	for (const [dialect, model] of [
		["anthropic-messages", anthropicModel()],
		["openai-completions", stepModel()],
		["openai-responses", responsesModel()],
	] as const) {
		it(`sends the recorded text and no spans through ${dialect}`, async () => {
			const payload = await capturePayload(model);

			expect(payload).toContain("BODY_A");
			expect(payload).toContain("do it");
			expect(payload).not.toContain('"skills"');
			expect(payload).not.toContain("digest");
		});
	}
});
