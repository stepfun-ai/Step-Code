import type { AgentMessage, StreamFn } from "@step-harness/agent-core";
import {
	type AssistantMessage,
	contentText,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type RetryCallbacks,
	type RetryPolicy,
} from "@step-harness/providers";
import type { Context, Model, SimpleStreamOptions, Usage } from "@step-harness/providers/compat";
import { describe, expect, it, vi } from "vitest";
import {
	type CompactionPreparation,
	compact,
	generateBranchSummary,
	generateSummaryWithUsage,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversation,
} from "../src/core/compaction/index.ts";
import { convertToLlm } from "../src/core/messages.ts";

const model: Model<"anthropic-messages"> = {
	id: "summary-overflow-test",
	name: "Summary overflow test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 128000,
};

const latestRequest = "LATEST REQUEST: finish the parser fix; keep the user's exact wording.";
const previousSummary = "## User Goal\nCarry forward `src/parser.ts` and exit code 17.\n\n  Preserve this spacing.\n";
const customInstructions = "Preserve the failing command verbatim and explain what remains unfinished.";
const overflowMessage = "prompt is too long: 234567 tokens > 200000 maximum";
const retryPolicy: RetryPolicy = { enabled: true, maxRetries: 2, baseDelayMs: 0 };

type SummaryPath = "history" | "prefix";
interface Request {
	context: Context;
	options: SimpleStreamOptions | undefined;
}

function usage(amount: number): Usage {
	return {
		input: amount * 2,
		output: amount * 3,
		cacheRead: amount * 4,
		cacheWrite: amount * 5,
		cacheWrite1h: amount,
		reasoning: amount * 2,
		totalTokens: amount * 14,
		cost: {
			input: amount,
			output: amount * 2,
			cacheRead: amount * 3,
			cacheWrite: amount * 4,
			total: amount * 10,
		},
	};
}

function reply(text = "recovered summary", amount = 1): AssistantMessage {
	return { ...fauxAssistantMessage(text), usage: usage(amount) };
}

function failure(errorMessage = overflowMessage, amount = 1): AssistantMessage {
	return { ...reply("", amount), stopReason: "error", errorMessage };
}

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 1 };
}

const imageRequestCases = [
	{ name: "image-only", text: undefined },
	{ name: "whitespace-plus-image", text: " \n\t " },
	{ name: "captioned-image", text: "Inspect this screenshot." },
];

function imageUser(text?: string): AgentMessage {
	return {
		role: "user",
		content: [
			...(text === undefined ? [] : [{ type: "text" as const, text }]),
			{ type: "image", data: "test-image-data", mimeType: "image/png" },
		],
		timestamp: 1,
	};
}

/** Parallel tool results deliberately arrive in the opposite order from their calls. */
function toolGroup(name: string, outputSize = 1200): AgentMessage[] {
	return [
		{
			...reply(),
			content: [
				{ type: "text", text: `${name} assistant context` },
				{ type: "thinking", thinking: `${name} reasoning` },
				{ type: "toolCall", id: `${name}-a`, name: "read", arguments: { path: `${name}-a.ts` } },
				{ type: "toolCall", id: `${name}-b`, name: "read", arguments: { path: `${name}-b.ts` } },
			],
			stopReason: "toolUse",
		},
		...["b", "a"].map((suffix) => ({
			role: "toolResult" as const,
			toolCallId: `${name}-${suffix}`,
			toolName: "read",
			content: [{ type: "text" as const, text: `${name}-${suffix} RESULT ${"x".repeat(outputSize)}` }],
			isError: false,
			timestamp: 1,
		})),
	];
}

function history(path: SummaryPath = "history"): AgentMessage[] {
	return [
		user(path === "prefix" ? latestRequest : "An older, resolved request."),
		...Array.from({ length: 16 }, (_, index) => toolGroup(`older-${index}`)).flat(),
		...(path === "history" ? [user(latestRequest)] : []),
		{
			role: "custom",
			customType: "status",
			content: "Synthetic status is not a replacement for the real user request.",
			display: false,
			timestamp: 1,
		},
		...toolGroup("newest", 100),
	];
}

function scriptedStream(responses: AssistantMessage[], afterResponse?: (call: number) => void) {
	const requests: Request[] = [];
	const streamFn: StreamFn = (_model, context, options) => {
		requests.push({ context: structuredClone(context), options });
		const call = requests.length;
		const response = responses[call - 1] ?? responses[responses.length - 1]!;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			afterResponse?.(call);
			if (response.stopReason === "error" || response.stopReason === "aborted") {
				stream.push({ type: "error", reason: response.stopReason, error: response });
			} else if (response.stopReason !== "pending") {
				stream.push({ type: "done", reason: response.stopReason, message: response });
			}
		});
		return stream;
	};
	return { streamFn, requests };
}

function prompt(request: Request): string {
	return contentText(request.context.messages[0]!.content);
}

function requestTokens(request: Request): number {
	return Math.ceil((request.context.systemPrompt?.length ?? 0) / 4) + Math.ceil(prompt(request).length / 4);
}

function preparation(messages: AgentMessage[], isSplitTurn: boolean): CompactionPreparation {
	return {
		firstKeptEntryId: "retained-suffix",
		messagesToSummarize: isSplitTurn ? [] : messages,
		turnPrefixMessages: isSplitTurn ? messages : [],
		isSplitTurn,
		tokensBefore: 123456,
		previousSummary,
		fileOps: { read: new Set(), written: new Set(), edited: new Set() },
		settings: { enabled: true, reserveTokens: 24576, keepRecentTokens: 20 },
	};
}

interface RunOptions {
	messages?: AgentMessage[];
	signal?: AbortSignal;
	previous?: string;
	retry?: RetryPolicy;
	callbacks?: RetryCallbacks;
}

async function summarize(path: SummaryPath, streamFn: StreamFn, options: RunOptions = {}) {
	const messages = options.messages ?? history(path);
	if (path === "history") {
		return generateSummaryWithUsage(
			messages,
			model,
			24576,
			"test-key",
			{ "x-test": "summary" },
			options.signal,
			customInstructions,
			options.previous ?? previousSummary,
			"medium",
			streamFn,
			{ TEST_SUMMARY_ENV: "value" },
			options.retry,
			options.callbacks,
			"summary-session",
		);
	}
	const result = await compact(
		preparation(messages, true),
		model,
		"test-key",
		{ "x-test": "summary" },
		customInstructions,
		options.signal,
		"medium",
		streamFn,
		{ TEST_SUMMARY_ENV: "value" },
		options.retry,
		options.callbacks,
		"summary-session",
	);
	return { text: result.summary, usage: result.usage };
}

function expectProtectedContent(request: Request): void {
	const text = prompt(request);
	expect(text).toContain(latestRequest);
	for (const message of toolGroup("newest", 100)) {
		expect(text).toContain(serializeConversation(convertToLlm([message])));
	}
	for (let index = 0; index < 16; index++) {
		const present = text.includes(`read(path="older-${index}-a.ts")`);
		expect(text.includes(`read(path="older-${index}-b.ts")`)).toBe(present);
		expect(text.includes(`older-${index}-a RESULT`)).toBe(present);
		expect(text.includes(`older-${index}-b RESULT`)).toBe(present);
	}
}

describe.each<SummaryPath>(["history", "prefix"])("%s summary context overflow recovery", (path) => {
	it("recovers with less history while preserving instructions, user request, tool pairs and usage", async () => {
		const messages = history(path);
		const original = structuredClone(messages);
		const { streamFn, requests } = scriptedStream([failure(overflowMessage, 2), reply("  exact summary\n", 3)]);

		const result = await summarize(path, streamFn, { messages });

		expect(result.text).toContain("  exact summary\n");
		expect(result.usage).toEqual(usage(5));
		expect(requests).toHaveLength(2);
		expect(requestTokens(requests[1]!)).toBeLessThanOrEqual(Math.floor(requestTokens(requests[0]!) * 0.7));
		expect(prompt(requests[1]!)).not.toContain('read(path="older-0-a.ts")');
		for (const request of requests) {
			expectProtectedContent(request);
			expect(request.context.systemPrompt).toBe(SUMMARIZATION_SYSTEM_PROMPT);
			expect(request.options).toMatchObject({
				maxTokens: 32000,
				cacheRetention: "none",
				sessionId: "summary-session",
				apiKey: "test-key",
				headers: { "x-test": "summary" },
				env: { TEST_SUMMARY_ENV: "value" },
				reasoning: "medium",
			});
		}
		// Everything after the source conversation is fixed, including previous-summary whitespace.
		expect(prompt(requests[1]!).split("</conversation>")[1]).toBe(prompt(requests[0]!).split("</conversation>")[1]);
		if (path === "history") {
			expect(prompt(requests[1]!)).toContain(`<previous-summary>\n${previousSummary}\n</previous-summary>`);
			expect(prompt(requests[1]!)).toContain(`Additional focus: ${customInstructions}`);
		} else {
			expect(prompt(requests[1]!)).toContain("the PREFIX of a single turn that was too large to keep in context");
		}
		expect(messages).toEqual(original);
	});

	it.each(imageRequestCases)(
		"protects a complete older tool batch containing an interleaved $name request",
		async ({ text }) => {
			const batch = toolGroup("image-request", 100);
			const requestGroup = [batch[0]!, batch[1]!, imageUser(text), batch[2]!];
			const messages = [
				user("An older, resolved request."),
				...requestGroup,
				...Array.from({ length: 16 }, (_, index) => toolGroup(`older-${index}`)).flat(),
				...toolGroup("newest", 100),
			];
			const original = structuredClone(messages);
			const { streamFn, requests } = scriptedStream([failure(), reply("image request summary")]);

			const result = await summarize(path, streamFn, { messages });

			expect(result.text).toContain("image request summary");
			expect(requests).toHaveLength(2);
			expect(requestTokens(requests[1]!)).toBeLessThanOrEqual(Math.floor(requestTokens(requests[0]!) * 0.7));
			// Image serialization is unchanged; the enclosing tool batch makes protection observable.
			const serializedGroup = serializeConversation(convertToLlm(requestGroup));
			expect(prompt(requests[0]!).includes(serializedGroup)).toBe(true);
			expect(
				prompt(requests[1]!).includes(serializedGroup),
				"the latest user's complete tool batch must survive",
			).toBe(true);
			expect(prompt(requests[1]!)).toContain(serializeConversation(convertToLlm(toolGroup("newest", 100))));
			expect(messages).toEqual(original);
		},
	);

	it.each(imageRequestCases)(
		"lets a newer $name request supersede an older large textual request",
		async ({ text }) => {
			const olderRequest = "OLDER TEXTUAL REQUEST: investigate the legacy parser. ".repeat(3000);
			const messages = [user(olderRequest), imageUser(text), ...toolGroup("newest", 100)];
			const original = structuredClone(messages);
			const { streamFn, requests } = scriptedStream([failure(), reply("image follow-up summary")]);

			const result = await summarize(path, streamFn, { messages });

			expect(result.text).toContain("image follow-up summary");
			expect(requests).toHaveLength(2);
			expect(requestTokens(requests[1]!)).toBeLessThanOrEqual(Math.floor(requestTokens(requests[0]!) * 0.7));
			expect(prompt(requests[0]!).includes(olderRequest)).toBe(true);
			expect(prompt(requests[1]!)).not.toContain("OLDER TEXTUAL REQUEST:");
			expect(prompt(requests[1]!)).toContain(serializeConversation(convertToLlm(messages.slice(1))));
			expect(messages).toEqual(original);
		},
	);

	it("bounds reductions to 70%, 50% and 35% of the original rejected request", async () => {
		const { streamFn, requests } = scriptedStream([failure()]);

		await expect(summarize(path, streamFn)).rejects.toThrow(/context overflow/i);

		expect(requests).toHaveLength(4);
		for (const [index, fraction] of [0.7, 0.5, 0.35].entries()) {
			expect(requestTokens(requests[index + 1]!)).toBeLessThanOrEqual(
				Math.floor(requestTokens(requests[0]!) * fraction),
			);
			expect(requestTokens(requests[index + 1]!)).toBeLessThan(requestTokens(requests[index]!));
			expectProtectedContent(requests[index + 1]!);
		}
	});

	it("fails explicitly when there is no removable complete group", async () => {
		const { streamFn, requests } = scriptedStream([failure()]);

		await expect(
			summarize(path, streamFn, { messages: [user(latestRequest), ...toolGroup("newest", 100)] }),
		).rejects.toThrow(/cannot reduce.*(protected|user|tool)/i);
		expect(requests).toHaveLength(1);
	});

	it.each(["401 invalid_api_key", "403 permission denied", "insufficient_quota", "400 invalid tool schema"])(
		"does not reduce or retry permanent error %s",
		async (errorMessage) => {
			const { streamFn, requests } = scriptedStream([failure(errorMessage), reply()]);

			await expect(summarize(path, streamFn, { retry: retryPolicy })).rejects.toThrow(errorMessage);
			expect(requests).toHaveLength(1);
			expect(prompt(requests[0]!)).toContain(serializeConversation(convertToLlm(history(path))));
		},
	);

	it.each([
		{ name: "empty", response: reply("") },
		{ name: "whitespace-only", response: reply(" \n\t") },
		{ name: "length-limited", response: { ...reply("partial summary"), stopReason: "length" as const } },
		{
			name: "length-limited with zero output and a full input window",
			response: {
				...reply(""),
				stopReason: "length" as const,
				usage: { ...usage(0), input: model.contextWindow, totalTokens: model.contextWindow },
			},
		},
	])("does not discard more input for $name output", async ({ response }) => {
		const { streamFn, requests } = scriptedStream([response, reply()]);
		// Output integrity has separate coverage; here acceptance/rejection must never cause source reduction.
		await summarize(path, streamFn, { retry: retryPolicy }).catch(() => undefined);
		expect(requests).toHaveLength(1);
		expect(prompt(requests[0]!)).toContain(serializeConversation(convertToLlm(history(path))));
	});

	it("sends the unchanged standalone request when the first attempt succeeds", async () => {
		const messages = history(path);
		const { streamFn, requests } = scriptedStream([reply("  normal summary\n", 7)]);

		const result = await summarize(path, streamFn, { messages });

		expect(result.text).toContain("  normal summary\n");
		expect(result.usage).toEqual(usage(7));
		expect(requests).toHaveLength(1);
		expect(requests[0]!.context.messages).toHaveLength(1);
		expect(requests[0]!.context.messages[0]!.role).toBe("user");
		expect(
			prompt(requests[0]!).startsWith(
				`<conversation>\n${serializeConversation(convertToLlm(messages))}\n</conversation>\n\n`,
			),
		).toBe(true);
		expect(requests[0]!.context.systemPrompt).toBe(SUMMARIZATION_SYSTEM_PROMPT);
		expect(requests[0]!.context.tools).toBeUndefined();
	});

	it("retains transient retries and aggregates usage across transient and overflow failures", async () => {
		const callbacks = { onRetryScheduled: vi.fn(), onRetryFinished: vi.fn() };
		const { streamFn, requests } = scriptedStream([
			failure("terminated", 2),
			failure(overflowMessage, 3),
			failure("socket hang up", 5),
			reply("recovered", 7),
		]);

		const result = await summarize(path, streamFn, { retry: retryPolicy, callbacks });

		expect(result.usage).toEqual(usage(17));
		expect(requests).toHaveLength(4);
		expect(requests[0]!.context).toEqual(requests[1]!.context);
		expect(requestTokens(requests[2]!)).toBeLessThan(requestTokens(requests[1]!));
		expect(requests[2]!.context).toEqual(requests[3]!.context);
		expect(callbacks.onRetryScheduled.mock.calls).toEqual([
			[1, 2, 0, "terminated"],
			[2, 2, 0, "socket hang up"],
		]);
		expect(callbacks.onRetryFinished).toHaveBeenCalledExactlyOnceWith(true, 2);
	});

	it("does not spend transient retries on an overflow error that also contains retryable wording", async () => {
		const callbacks = { onRetryScheduled: vi.fn() };
		const { streamFn, requests } = scriptedStream([
			failure("maximum context length is 500 tokens; please retry your request"),
			reply(),
		]);

		await summarize(path, streamFn, { retry: retryPolicy, callbacks });

		expect(requests).toHaveLength(2);
		expect(requestTokens(requests[1]!)).toBeLessThan(requestTokens(requests[0]!));
		expect(callbacks.onRetryScheduled).not.toHaveBeenCalled();
	});

	it("does not reset the transient retry budget after reducing history", async () => {
		const { streamFn, requests } = scriptedStream([failure("terminated"), failure(), failure("terminated"), reply()]);

		await expect(summarize(path, streamFn, { retry: { ...retryPolicy, maxRetries: 1 } })).rejects.toThrow(
			"terminated",
		);
		expect(requests).toHaveLength(3);
	});

	it("stops after an overflow if cancellation arrives with the rejection", async () => {
		const controller = new AbortController();
		const { streamFn, requests } = scriptedStream([failure(), reply()], () => controller.abort());

		await expect(summarize(path, streamFn, { signal: controller.signal })).rejects.toThrow(/cancelled|aborted/i);
		expect(requests).toHaveLength(1);
	});

	it("makes no request when already cancelled", async () => {
		const { streamFn, requests } = scriptedStream([reply()]);
		await expect(summarize(path, streamFn, { signal: AbortSignal.abort() })).rejects.toThrow(/cancelled|aborted/i);
		expect(requests).toHaveLength(0);
	});

	it.each([
		{
			name: "aborted",
			response: { ...reply(""), stopReason: "aborted" as const },
		},
		{ name: "empty", response: reply("") },
		{ name: "whitespace-only", response: reply(" \n\t ") },
		{
			name: "thinking-only",
			response: { ...reply(""), content: [{ type: "thinking" as const, thinking: "internal reasoning" }] },
		},
	])("rejects an invalid reduced $name response without another request", async ({ response }) => {
		const { streamFn, requests } = scriptedStream([failure(), response, reply()]);

		await expect(summarize(path, streamFn)).rejects.toThrow(/aborted|no summary text/i);
		expect(requests).toHaveLength(2);
	});

	it("stops when cancellation arrives immediately before a transient retry", async () => {
		const controller = new AbortController();
		const { streamFn, requests } = scriptedStream([failure("terminated"), reply()]);
		const callbacks = { onRetryAttemptStart: () => controller.abort(), onRetryFinished: vi.fn() };

		await summarize(path, streamFn, { signal: controller.signal, retry: retryPolicy, callbacks }).catch(
			() => undefined,
		);
		expect(requests).toHaveLength(1);
		expect(callbacks.onRetryFinished).toHaveBeenCalledExactlyOnceWith(false, 1, expect.any(String));
	});

	it("finishes transient retry reporting if a later overflow cannot be reduced", async () => {
		const { streamFn, requests } = scriptedStream([failure("terminated"), failure()]);
		const callbacks = { onRetryFinished: vi.fn() };

		await expect(
			summarize(path, streamFn, {
				messages: [user(latestRequest), ...toolGroup("newest", 100)],
				retry: retryPolicy,
				callbacks,
			}),
		).rejects.toThrow(/cannot reduce/i);
		expect(requests).toHaveLength(2);
		expect(callbacks.onRetryFinished).toHaveBeenCalledExactlyOnceWith(
			false,
			1,
			expect.stringMatching(/cannot reduce/i),
		);
	});

	it("stops when cancellation interrupts transient backoff", async () => {
		const controller = new AbortController();
		const { streamFn, requests } = scriptedStream([failure("terminated"), reply()]);
		const callbacks = {
			onRetryScheduled: () => controller.abort(),
			onRetryFinished: vi.fn(),
		};

		await summarize(path, streamFn, { signal: controller.signal, retry: retryPolicy, callbacks }).catch(
			() => undefined,
		);
		expect(requests).toHaveLength(1);
		expect(callbacks.onRetryFinished).toHaveBeenCalledExactlyOnceWith(false, 1, "terminated");
	});
});

describe("compaction overflow protection and accounting", () => {
	it("fails without changing a previous summary that dominates the protected minimum", async () => {
		const previous = previousSummary.repeat(2000);
		const { streamFn, requests } = scriptedStream([failure()]);

		await expect(summarize("history", streamFn, { previous })).rejects.toThrow(/cannot reduce.*protected/i);
		expect(requests).toHaveLength(1);
		expect(prompt(requests[0]!)).toContain(`<previous-summary>\n${previous}\n</previous-summary>`);
	});

	it("fails on no further progress after a large group was removed", async () => {
		const messages = [user(latestRequest), reply("old bulk history ".repeat(10000)), ...toolGroup("newest", 100)];
		const { streamFn, requests } = scriptedStream([failure()]);

		await expect(summarize("history", streamFn, { messages })).rejects.toThrow(/cannot reduce/i);
		expect(requests).toHaveLength(2);
		expectProtectedContent(requests[1]!);
	});

	it("requires progress even when a previous removal already undershot the next target", async () => {
		const messages = [
			user(latestRequest),
			reply("old bulk history ".repeat(10000)),
			...Array.from({ length: 4 }, (_, index) => toolGroup(`older-${index}`, 100)).flat(),
			...toolGroup("newest", 100),
		];
		const { streamFn, requests } = scriptedStream([failure(), failure(), failure(), reply()]);

		await summarize("history", streamFn, { messages });

		expect(requests).toHaveLength(4);
		for (let index = 1; index < requests.length; index++) {
			expect(requestTokens(requests[index]!)).toBeLessThan(requestTokens(requests[index - 1]!));
		}
	});

	it("keeps a user request interleaved with a parallel tool batch and all its results", async () => {
		const newest = toolGroup("newest", 100);
		const messages = [...history().slice(0, -3), newest[0]!, user(latestRequest), newest[1]!, newest[2]!];
		const { streamFn, requests } = scriptedStream([failure(), reply()]);

		await summarize("history", streamFn, { messages });

		expectProtectedContent(requests[1]!);
		expect(prompt(requests[1]!)).toContain(serializeConversation(convertToLlm(messages.slice(-4))));
	});

	it.each(["missing result", "orphan result"])("fails safely with a %s in the source history", async (kind) => {
		const broken = toolGroup("broken", 100);
		const messages = [...(kind === "missing result" ? broken.slice(0, 2) : broken.slice(1)), ...history()];
		const { streamFn, requests } = scriptedStream([failure(), reply()]);

		await expect(summarize("history", streamFn, { messages })).rejects.toThrow(/cannot reduce.*tool/i);
		expect(requests).toHaveLength(1);
	});

	it("preserves the newest tool batch when an assistant conclusion follows it", async () => {
		const messages = [...history(), reply("The newest assistant conclusion.")];
		const { streamFn, requests } = scriptedStream([failure(), reply()]);

		await summarize("history", streamFn, { messages });

		expectProtectedContent(requests[1]!);
		expect(prompt(requests[1]!)).toContain("The newest assistant conclusion.");
	});

	it("can remove older assistant groups between the newest tool batch and final reply", async () => {
		const messages = [
			user(latestRequest),
			...toolGroup("newest", 100),
			reply("Older completed analysis. ".repeat(5000)),
			reply("The newest assistant conclusion."),
		];
		const { streamFn, requests } = scriptedStream([failure(), reply()]);

		await summarize("history", streamFn, { messages });

		expect(requests).toHaveLength(2);
		expectProtectedContent(requests[1]!);
		expect(prompt(requests[1]!)).toContain("The newest assistant conclusion.");
		expect(prompt(requests[1]!)).not.toContain("Older completed analysis.");
	});

	it("preserves branch summaries while removing older source groups", async () => {
		const branchSummary: AgentMessage = {
			role: "branchSummary",
			summary: "BRANCH CHECKPOINT: the abandoned migration investigation found a schema mismatch.",
			fromId: "branch-entry",
			timestamp: 1,
		};
		const messages = [
			branchSummary,
			user("An older request that can be omitted."),
			reply("Older analysis. ".repeat(5000)),
			user(latestRequest),
			...toolGroup("newest", 100),
		];
		const { streamFn, requests } = scriptedStream([failure(), reply("summary with branch context")]);

		await summarize("history", streamFn, { messages });

		expect(requests).toHaveLength(2);
		expect(prompt(requests[1]!)).toContain(branchSummary.summary);
	});

	it("does not infer overflow from a successful response's reported input usage", async () => {
		const response = reply("successful summary");
		response.usage = { ...usage(0), input: model.contextWindow + 1, totalTokens: model.contextWindow + 1 };
		const { streamFn, requests } = scriptedStream([response]);

		const result = await summarize("history", streamFn);

		expect(result.text).toBe("successful summary");
		expect(result.usage).toEqual(response.usage);
		expect(requests).toHaveLength(1);
	});

	it("adds failed and successful usage from both history and prefix summary requests", async () => {
		const input = preparation(history(), false);
		input.isSplitTurn = true;
		input.turnPrefixMessages = history("prefix");
		const { streamFn, requests } = scriptedStream([
			failure(overflowMessage, 2),
			reply("history summary", 3),
			failure(overflowMessage, 5),
			reply("prefix summary", 7),
		]);

		const result = await compact(
			input,
			model,
			"test-key",
			undefined,
			customInstructions,
			undefined,
			"medium",
			streamFn,
		);

		expect(result.summary).toBe("history summary\n\n---\n\n**Turn Context (split turn):**\n\nprefix summary");
		expect(result.usage).toEqual(usage(17));
		expect(result.firstKeptEntryId).toBe("retained-suffix");
		expect(result.tokensBefore).toBe(123456);
		expect(requests).toHaveLength(4);
		expect(requests[0]!.options?.sessionId).toBe(requests[1]!.options?.sessionId);
		expect(requests[2]!.options?.sessionId).toBe(requests[3]!.options?.sessionId);
		expect(requests[0]!.options?.sessionId).not.toBe(requests[2]!.options?.sessionId);
	});

	it("preserves branch-summary overflow behavior", async () => {
		const { streamFn, requests } = scriptedStream([failure(), reply()]);
		const result = await generateBranchSummary(
			history().map((message, index) => ({
				type: "message" as const,
				id: `message-${index}`,
				parentId: index === 0 ? null : `message-${index - 1}`,
				timestamp: new Date(1).toISOString(),
				message,
			})),
			{ model, signal: new AbortController().signal, streamFn },
		);

		expect(result.error).toBe(`Branch summarization failed: ${overflowMessage}`);
		expect(requests).toHaveLength(1);
	});
});
