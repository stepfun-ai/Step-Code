import { type AssistantMessage, type AssistantMessageEvent, EventStream, type Message } from "@step-harness/providers";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type {
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	ToolExecutionStartedContext,
} from "../src/types.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function assistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

const model: AgentLoopConfig["model"] = {
	id: "mock",
	name: "mock",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 2048,
};

const convertToLlm = (messages: AgentMessage[]): Message[] =>
	messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];

function tool(name: string, run: () => Promise<void> = async () => {}, extra: Partial<AgentTool> = {}): AgentTool {
	const base: AgentTool = {
		name,
		label: name,
		description: name,
		parameters: Type.Object({ value: Type.Optional(Type.String()) }),
		async execute() {
			await run();
			return { content: [{ type: "text", text: name }], details: {} };
		},
	};
	return { ...base, ...extra };
}

function call(id: string, name: string, args: Record<string, unknown> = {}): AgentToolCall {
	return { type: "toolCall", id, name, arguments: args };
}

/** Run one turn that issues `calls`, then a closing text turn; collect events and start notifications. */
async function runBatch(
	calls: AgentToolCall[],
	tools: AgentTool<any>[],
	config: Partial<AgentLoopConfig> = {},
	options: { stopReason?: AssistantMessage["stopReason"]; signal?: AbortSignal } = {},
): Promise<{ events: AgentEvent[]; started: ToolExecutionStartedContext[] }> {
	const started: ToolExecutionStartedContext[] = [];
	let requests = 0;
	const stream = agentLoop(
		[{ role: "user", content: "go", timestamp: Date.now() }],
		{ systemPrompt: "", messages: [], tools },
		{
			model,
			convertToLlm,
			onToolExecutionStarted: (context) => started.push(context),
			...config,
		},
		options.signal,
		() => {
			const output = new MockAssistantStream();
			const first = requests++ === 0;
			queueMicrotask(() => {
				const stopReason = first ? (options.stopReason ?? "toolUse") : "stop";
				const message = first ? assistant(calls, stopReason) : assistant([{ type: "text", text: "done" }]);
				output.push({
					type: "done",
					reason: stopReason === "length" ? "length" : first ? "toolUse" : "stop",
					message,
				});
			});
			return output;
		},
	);
	const events: AgentEvent[] = [];
	for await (const event of stream) events.push(event);
	return { events, started };
}

function ends(events: AgentEvent[]): Extract<AgentEvent, { type: "tool_execution_end" }>[] {
	return events.filter((event): event is Extract<AgentEvent, { type: "tool_execution_end" }> => {
		return event.type === "tool_execution_end";
	});
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("tool execution lifecycle", () => {
	it("timestamps start and end events and reports when each parallel call actually starts", async () => {
		const { events, started } = await runBatch(
			[call("slow", "slow"), call("fast", "fast")],
			[tool("slow", () => wait(30)), tool("fast", () => wait(1))],
			{ toolExecution: "parallel" },
		);
		const startEvents = events.filter((event) => event.type === "tool_execution_start");
		expect(startEvents.every((event) => typeof event.at === "number")).toBe(true);
		expect(started.map((context) => context.toolCall.id)).toEqual(["slow", "fast"]);
		expect(started.every((context) => context.assistantMessage.stopReason === "toolUse")).toBe(true);

		const [first, second] = ends(events);
		expect(first?.toolCallId).toBe("fast");
		expect(second?.toolCallId).toBe("slow");
		expect(first?.executed).toBe(true);
		expect(first?.notExecuted).toBeUndefined();
		// Parallel calls finish at their own time, not when the batch is written.
		expect((second?.at ?? 0) - (first?.at ?? 0)).toBeGreaterThanOrEqual(15);
	});

	it("starts a sequential call only after the previous one ended", async () => {
		const { events, started } = await runBatch(
			[call("a", "a"), call("b", "b")],
			[tool("a", () => wait(10)), tool("b")],
			{ toolExecution: "sequential" },
		);
		const endOfA = ends(events).find((event) => event.toolCallId === "a")?.at ?? Number.POSITIVE_INFINITY;
		const startOfB = started.find((context) => context.toolCall.id === "b")?.at ?? 0;
		expect(startOfB).toBeGreaterThanOrEqual(endOfA);
	});

	it("forwards the blocker of a call that beforeToolCall refused, without starting it", async () => {
		let ran = false;
		const { events, started } = await runBatch(
			[call("w", "write")],
			[
				tool("write", async () => {
					ran = true;
				}),
			],
			{ beforeToolCall: async () => ({ block: true, reason: "plan mode", blockedBy: "plan_mode" }) },
		);
		expect(ran).toBe(false);
		expect(started).toHaveLength(0);
		expect(ends(events)[0]).toMatchObject({
			executed: false,
			isError: true,
			notExecuted: { kind: "blocked", by: "plan_mode" },
		});
	});

	it("reports a block without a blocker code as blocked with no `by`", async () => {
		const { events } = await runBatch([call("w", "write")], [tool("write")], {
			beforeToolCall: async () => ({ block: true }),
		});
		expect(ends(events)[0]?.notExecuted).toEqual({ kind: "blocked" });
	});

	it("treats a throwing beforeToolCall as a hook_error block and keeps its message", async () => {
		const { events } = await runBatch([call("w", "write")], [tool("write")], {
			beforeToolCall: async () => {
				throw new Error("extension crashed");
			},
		});
		const end = ends(events)[0];
		expect(end?.notExecuted).toEqual({ kind: "blocked", by: "hook_error" });
		expect(JSON.stringify(end?.result.content)).toContain("extension crashed");
	});

	it("classifies calls that never ran", async () => {
		const missing = await runBatch([call("m", "missing")], [tool("present")]);
		expect(ends(missing.events)[0]?.notExecuted).toEqual({ kind: "not_run", reason: "tool_not_found" });

		const strict: AgentTool = { ...tool("strict"), parameters: Type.Object({ value: Type.String() }) };
		const invalid = await runBatch([call("i", "strict", {})], [strict]);
		expect(ends(invalid.events)[0]?.notExecuted).toEqual({ kind: "not_run", reason: "invalid_arguments" });

		const truncated = await runBatch([call("t", "typed")], [tool("typed")], {}, { stopReason: "length" });
		expect(ends(truncated.events)[0]?.notExecuted).toEqual({ kind: "not_run", reason: "output_truncated" });
		expect(truncated.started).toHaveLength(0);
	});

	it("marks calls after a sequential turn barrier as skipped", async () => {
		const barrier: AgentTool = {
			...tool("barrier"),
			executionMode: "sequential",
			async execute() {
				return { content: [{ type: "text", text: "stop" }], details: {}, stopTurn: true };
			},
		};
		const { events, started } = await runBatch(
			[call("b", "barrier"), call("later", "later")],
			[barrier, tool("later")],
		);
		expect(started.map((context) => context.toolCall.id)).toEqual(["b"]);
		expect(ends(events).find((event) => event.toolCallId === "later")?.notExecuted).toEqual({
			kind: "not_run",
			reason: "skipped_after_stop",
		});
	});

	it("reports an abort during approval as aborted_before_start", async () => {
		const controller = new AbortController();
		const { events, started } = await runBatch(
			[call("w", "write")],
			[tool("write")],
			{
				beforeToolCall: async () => {
					controller.abort();
					return undefined;
				},
			},
			{ signal: controller.signal },
		);
		expect(started).toHaveLength(0);
		expect(ends(events)[0]?.notExecuted).toEqual({ kind: "not_run", reason: "aborted_before_start" });
	});

	it("keeps executing when onToolExecutionStarted throws", async () => {
		let ran = false;
		const { events } = await runBatch(
			[call("a", "a")],
			[
				tool("a", async () => {
					ran = true;
				}),
			],
			{
				onToolExecutionStarted: () => {
					throw new Error("recorder failed");
				},
			},
		);
		expect(ran).toBe(true);
		expect(ends(events)[0]).toMatchObject({ executed: true, isError: false });
	});
});
