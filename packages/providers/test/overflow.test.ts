import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../src/types.ts";
import { isContextOverflow, isRecoverableLength, isUnnamedOverflowRejection } from "../src/utils/overflow.ts";

function createErrorMessage(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "ollama",
		model: "qwen3.5:35b",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

describe("isContextOverflow", () => {
	it("detects explicit Ollama prompt-too-long errors", () => {
		const message = createErrorMessage("400 `prompt too long; exceeded max context length by 100918 tokens`");
		expect(isContextOverflow(message, 32768)).toBe(true);
	});

	it("detects Together AI context length errors", () => {
		const message = createErrorMessage(
			"400 The input (516368 tokens) is longer than the model's context length (262144 tokens).",
		);
		expect(isContextOverflow(message, 262144)).toBe(true);
	});

	it("detects LiteLLM-wrapped OpenAI maximum context length errors", () => {
		const message = createErrorMessage(
			"Error: 503 litellm.ServiceUnavailableError: litellm.MidStreamFallbackError: litellm.APIConnectionError: APIConnectionError: OpenAIException - Requested token count exceeds the model's maximum context length of 131072 tokens.",
		);
		expect(isContextOverflow(message, 131072)).toBe(true);
	});

	it("detects OpenAI-compatible parenthesized maximum context length errors", () => {
		const message = createErrorMessage(
			"Error: 400 Input length (265330) exceeds model's maximum context length (262144).",
		);
		expect(isContextOverflow(message, 262144)).toBe(true);
	});

	it("detects OpenRouter Poolside maximum allowed input length errors", () => {
		const message = createErrorMessage(
			"Provider returned error: Input length 131393 exceeds the maximum allowed input length of 131040 tokens.",
		);
		expect(isContextOverflow(message, 131072)).toBe(true);
	});

	it("detects DS4 configured context size errors", () => {
		const message = createErrorMessage(
			"400 Prompt has 256468 tokens, but the configured context size is 256000 tokens",
		);
		expect(isContextOverflow(message, 256000)).toBe(true);

		const commaMessage = createErrorMessage(
			"Prompt has 5,958,968 tokens, but the configured context size is 256,000 tokens",
		);
		expect(isContextOverflow(commaMessage, 256000)).toBe(true);
	});

	it("does not treat generic non-overflow Ollama errors as overflow", () => {
		const message = createErrorMessage("500 `model runner crashed unexpectedly`");
		expect(isContextOverflow(message, 32768)).toBe(false);
	});

	it("does not treat Bedrock throttling 'Too many tokens' as overflow", () => {
		// Bedrock returns this for HTTP 429 rate limiting, NOT context overflow.
		// formatBedrockError uses a human-readable prefix for ThrottlingException.
		const message = createErrorMessage("Throttling error: Too many tokens, please wait before trying again.");
		expect(isContextOverflow(message, 200000)).toBe(false);
	});

	it("does not treat Bedrock service unavailable as overflow", () => {
		const message = createErrorMessage("Service unavailable: The service is temporarily unavailable.");
		expect(isContextOverflow(message, 200000)).toBe(false);
	});

	it("does not treat generic rate limit errors as overflow", () => {
		const message = createErrorMessage("Rate limit exceeded, please retry after 30 seconds.");
		expect(isContextOverflow(message, 200000)).toBe(false);
	});

	it("does not treat HTTP 429 style errors as overflow", () => {
		const message = createErrorMessage("Too many requests. Please slow down.");
		expect(isContextOverflow(message, 200000)).toBe(false);
	});

	function createLengthStopMessage(options: {
		input: number;
		cacheRead: number;
		output: number;
		cacheWrite?: number;
		api?: AssistantMessage["api"];
		provider?: string;
		model?: string;
	}): AssistantMessage {
		const cacheWrite = options.cacheWrite ?? 0;
		return {
			role: "assistant",
			content: [],
			api: options.api ?? "openai-completions",
			provider: options.provider ?? "test-provider",
			model: options.model ?? "test-model",
			usage: {
				input: options.input,
				output: options.output,
				cacheRead: options.cacheRead,
				cacheWrite,
				totalTokens: options.input + options.cacheRead + cacheWrite + options.output,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "length",
			timestamp: Date.now(),
		};
	}

	it("detects Xiaomi-style overflow (length stop with zero output and filled context)", () => {
		const message = createLengthStopMessage({
			input: 58,
			cacheRead: 1048512,
			output: 0,
			provider: "xiaomi",
			model: "mimo-v2.5-pro",
		});
		expect(isContextOverflow(message, 1048576)).toBe(true);
	});

	it("treats a length stop below the desired output limit as recoverable", () => {
		const message = createLengthStopMessage({
			input: 3,
			cacheRead: 253584,
			cacheWrite: 25554,
			output: 16,
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.6-sol",
		});
		expect(isRecoverableLength(message, 128000)).toBe(true);
	});

	it("does not recover a length stop that reached the desired output limit", () => {
		const message = createLengthStopMessage({ input: 4062, cacheRead: 0, output: 1024 });
		expect(isRecoverableLength(message, 1024)).toBe(false);
	});

	it("treats zero-output length stops as recoverable without context metadata", () => {
		const message = createLengthStopMessage({ input: 100, cacheRead: 0, output: 0 });
		expect(isRecoverableLength(message, 128000)).toBe(true);
	});

	it("does not treat normal length stops with output as context overflow", () => {
		const message = createLengthStopMessage({ input: 1000, cacheRead: 0, output: 4096 });
		expect(isContextOverflow(message, 200000)).toBe(false);
	});

	it("does not treat zero-output length stops far below context as context overflow", () => {
		const message = createLengthStopMessage({ input: 100, cacheRead: 0, output: 0 });
		expect(isContextOverflow(message, 200000)).toBe(false);
	});
});

describe("unnamed overflow rejection", () => {
	const gateway = (message: string) => createErrorMessage(message);
	const unnamed =
		'400 {"type":"error","error":{"type":"invalid_request_error","message":"The input you provided is invalid [trace_id=abc code=30003]"}}';

	it("treats a near-window request as overflow", () => {
		const evidence = () => ({ inputTokens: 952_000, maxTokens: 128_000 });
		expect(isUnnamedOverflowRejection(gateway(unnamed), 1_000_000, evidence)).toBe(true);
	});

	it("does not treat the same wording on a small request as overflow", () => {
		const evidence = () => ({ inputTokens: 20_000, maxTokens: 128_000 });
		expect(isUnnamedOverflowRejection(gateway(unnamed), 1_000_000, evidence)).toBe(false);
	});

	it("does not measure unless the wording matches", () => {
		let measured = 0;
		const evidence = () => {
			measured++;
			return { inputTokens: 952_000, maxTokens: 128_000 };
		};
		expect(isUnnamedOverflowRejection(gateway("429 rate limit exceeded"), 1_000_000, evidence)).toBe(false);
		expect(measured).toBe(0);
	});

	it("leaves text-matched overflow to isContextOverflow", () => {
		const evidence = () => ({ inputTokens: 952_000, maxTokens: 128_000 });
		const message = gateway("prompt is too long: 213462 tokens > 200000 maximum");
		expect(isContextOverflow(message, 1_000_000)).toBe(true);
		expect(isUnnamedOverflowRejection(message, 1_000_000, evidence)).toBe(false);
	});

	it("needs the prompt alone to fill half the window", () => {
		// 70K + 128K = 198K passes the 95% check on a 200K window, but 70K of input is too
		// small a share to blame the rejection on size.
		const evidence = () => ({ inputTokens: 70_000, maxTokens: 128_000 });
		expect(isUnnamedOverflowRejection(gateway(unnamed), 200_000, evidence)).toBe(false);
		const nearFull = () => ({ inputTokens: 120_000, maxTokens: 128_000 });
		expect(isUnnamedOverflowRejection(gateway(unnamed), 200_000, nearFull)).toBe(true);
	});

	it("requires size evidence", () => {
		expect(isUnnamedOverflowRejection(gateway(unnamed), 1_000_000, () => undefined)).toBe(false);
	});
});
