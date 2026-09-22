// Conformance fixtures for the `openai-completions` dialect (design §5.13).
//
// Covers all three fixture kinds — request snapshot, stream events, error
// normalization — plus the cross-profile reuse invariant: the SAME adapter,
// resolved by dialect through the shared registry, serves two different
// provider/baseUrl identities with an identical wire shape.
//
// openai-completions talks to the `openai` SDK, so we mock that module (the
// established pattern in openai-completions-*.test.ts) to both capture the
// outgoing request params and feed a canned chunk stream / throw a wire error.

import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context, Model } from "../../src/types.ts";
import { collectEventTypes, expectSharedDispatch, resolveAdapter } from "./harness.ts";

interface CapturedParams {
	model: string;
	stream?: boolean;
	messages: Array<{ role: string; content: unknown }>;
	tools?: Array<{ type: string; function: { name: string; description?: string; parameters?: unknown } }>;
}

// openai SDK APIError shape: "<status> status code (no body)" message, parsed
// body kept on `.error` (mirrors provider-error-body-regression.test.ts).
class FakeAPIError extends Error {
	status: number;
	error: unknown;
	constructor(status: number, parsedBody: unknown) {
		super(`${status} status code (no body)`);
		this.name = "RateLimitError";
		this.status = status;
		this.error = parsedBody;
	}
}

const mockState = vi.hoisted(() => ({
	lastParams: undefined as CapturedParams | undefined,
	chunks: [] as unknown[],
	error: undefined as unknown,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: CapturedParams) => {
					mockState.lastParams = params;
					const chunks = mockState.chunks;
					const streamObj = {
						async *[Symbol.asyncIterator]() {
							for (const chunk of chunks) yield chunk;
						},
					};
					const promise = Promise.resolve(streamObj) as Promise<typeof streamObj> & {
						withResponse: () => Promise<{
							data: typeof streamObj;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => {
						if (mockState.error) throw mockState.error;
						return { data: streamObj, response: { status: 200, headers: new Headers() } };
					};
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

// Two DIFFERENT provider identities that share the openai-completions dialect:
// canonical OpenAI vs a compat gateway (Groq's OpenAI-compatible endpoint).
const openAiModel: Model<"openai-completions"> = {
	id: "gpt-4o-mini",
	name: "GPT-4o mini",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
};

const gatewayModel: Model<"openai-completions"> = {
	...openAiModel,
	id: "llama-3.3-70b-versatile",
	name: "Llama 3.3 70B (Groq compat gateway)",
	provider: "groq",
	baseUrl: "https://api.groq.com/openai/v1",
};

const context: Context = {
	systemPrompt: "You are a helpful assistant.",
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	tools: [
		{
			name: "read",
			description: "Read a file",
			parameters: Type.Object({ path: Type.String() }),
		},
	],
};

function textThenStopChunks(): unknown[] {
	return [
		{
			id: "chatcmpl-conf",
			choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }],
		},
		{
			id: "chatcmpl-conf",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: {
				prompt_tokens: 1,
				completion_tokens: 1,
				prompt_tokens_details: { cached_tokens: 0 },
				completion_tokens_details: { reasoning_tokens: 0 },
			},
		},
	];
}

describe("openai-completions conformance", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
		mockState.chunks = [];
		mockState.error = undefined;
	});

	it("dispatches by dialect through the shared registry (adapter self-reports openai-completions)", () => {
		const adapter = resolveAdapter(openAiModel.api);
		expect(adapter.api).toBe("openai-completions");
	});

	it("request snapshot: canonical request -> openai chat-completions wire body", async () => {
		mockState.chunks = textThenStopChunks();
		const adapter = resolveAdapter(openAiModel.api);

		await adapter.stream(openAiModel, context, { apiKey: "test-key" }).result();

		const params = mockState.lastParams;
		expect(params).toBeDefined();
		// Protocol shape: model + stream flag.
		expect(params?.model).toBe("gpt-4o-mini");
		expect(params?.stream).toBe(true);
		// messages[].role — an instruction message (system/developer) plus the user turn.
		const roles = params?.messages.map((m) => m.role) ?? [];
		expect(roles).toContain("user");
		expect(roles.some((r) => r === "system" || r === "developer")).toBe(true);
		// tools[].function.name — chat-completions nests the tool under `.function`.
		expect(params?.tools).toHaveLength(1);
		expect(params?.tools?.[0].type).toBe("function");
		expect(params?.tools?.[0].function.name).toBe("read");
	});

	it("stream events: canned chunk stream -> stable canonical event order", async () => {
		mockState.chunks = textThenStopChunks();
		const adapter = resolveAdapter(openAiModel.api);

		const stream = adapter.stream(openAiModel, context, { apiKey: "test-key" });
		const events = await collectEventTypes(stream);
		const result = await stream.result();

		expect(events).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
		expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
		expect(result.stopReason).toBe("stop");
		expect(result.rawStopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
	});

	it("error normalization: wire 429 error -> normalized error model", async () => {
		mockState.error = new FakeAPIError(429, { message: "gateway WAF blocked request", type: "rate_limit_error" });
		const adapter = resolveAdapter(openAiModel.api);

		const stream = adapter.stream(openAiModel, context, { apiKey: "test-key", maxRetries: 0 });
		const events = await collectEventTypes(stream);
		const result = await stream.result();

		expect(events.at(-1)).toBe("error");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("429");
		expect(result.errorMessage).toContain("gateway WAF blocked request");
		// Normalization surfaces the body, not the opaque SDK placeholder message.
		expect(result.errorMessage).not.toBe("429 status code (no body)");
	});

	it("cross-profile reuse: same adapter serves OpenAI and a compat gateway with the same wire shape", async () => {
		// Identity-independent dispatch: both provider identities resolve to one adapter.
		const adapter = expectSharedDispatch(openAiModel, gatewayModel);
		expect(openAiModel.provider).not.toBe(gatewayModel.provider);
		expect(openAiModel.baseUrl).not.toBe(gatewayModel.baseUrl);

		mockState.chunks = textThenStopChunks();
		await adapter.stream(openAiModel, context, { apiKey: "openai-key" }).result();
		const openAiParams = mockState.lastParams;

		mockState.chunks = textThenStopChunks();
		await adapter.stream(gatewayModel, context, { apiKey: "gateway-key" }).result();
		const gatewayParams = mockState.lastParams;

		// Same protocol serialization for both providers: the model id differs, the
		// wire shape (chat-completions messages + function tools) does not.
		expect(openAiParams?.model).toBe("gpt-4o-mini");
		expect(gatewayParams?.model).toBe("llama-3.3-70b-versatile");
		expect(openAiParams?.tools?.[0].function.name).toBe("read");
		expect(gatewayParams?.tools?.[0].function.name).toBe("read");
		expect(gatewayParams?.stream).toBe(true);
		expect(openAiParams?.messages.map((m) => m.role)).toEqual(gatewayParams?.messages.map((m) => m.role));
	});
});
