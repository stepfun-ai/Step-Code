import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/compat.ts";
import type { Context, Model, SimpleStreamOptions } from "../src/types.ts";
import { anthropicModel } from "./helpers/step-fixtures.ts";

interface AnthropicTemperaturePayload {
	temperature?: number;
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function makeContext(): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

function makeCustomModel(compat?: Model<"anthropic-messages">["compat"]): Model<"anthropic-messages"> {
	return {
		id: "vendor--claude-opus-4-7",
		name: "Vendor Proxy Opus 4.7",
		api: "anthropic-messages",
		provider: "vendor-proxy",
		baseUrl: "http://127.0.0.1:9",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
		compat,
	};
}

async function capturePayload(
	model: Model<"anthropic-messages">,
	options?: SimpleStreamOptions,
): Promise<AnthropicTemperaturePayload> {
	let capturedPayload: AnthropicTemperaturePayload | undefined;

	const payloadCaptureModel: Model<"anthropic-messages"> = {
		...model,
		baseUrl: "http://127.0.0.1:9",
	};

	const s = streamSimple(payloadCaptureModel, makeContext(), {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as AnthropicTemperaturePayload;
			throw new PayloadCaptured();
		},
	});

	await s.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}

	return capturedPayload;
}

describe("Anthropic temperature compatibility", () => {
	it("forwards temperature when the model does not disable it", async () => {
		// Bare model: compat.supportsTemperature defaults to true.
		const payload = await capturePayload(anthropicModel(), { temperature: 0 });

		expect(payload.temperature).toBe(0);
	});

	it("omits temperature when compat.supportsTemperature is false", async () => {
		// The adapter drops temperature regardless of the requested value once the
		// model declares supportsTemperature:false (real metadata for e.g. Opus 4.7/4.8).
		const payload = await capturePayload(makeCustomModel({ supportsTemperature: false }), { temperature: 1 });

		expect(payload.temperature).toBeUndefined();
	});
});
