import type { AgentTool } from "@step-harness/agent-core";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@step-harness/providers";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	TOOL_EXECUTION_ENTRY_TYPE,
	type ToolExecutionEndData,
	type ToolExecutionStartData,
	TURN_ENTRY_TYPE,
	type TurnEndData,
	TurnRecorder,
	type TurnStartData,
} from "../../src/core/execution-trace.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import { THINKING_TIMING_ENTRY_TYPE } from "../../src/core/thinking-timing.ts";
import { createHarness, type Harness } from "./harness.ts";

type TraceData = ToolExecutionStartData | ToolExecutionEndData;

function traceEntries(harness: Harness): TraceData[] {
	return harness.sessionManager
		.getEntries()
		.filter(
			(entry): entry is Extract<SessionEntry, { type: "custom" }> =>
				entry.type === "custom" && entry.customType === TOOL_EXECUTION_ENTRY_TYPE,
		)
		.map((entry) => entry.data as TraceData);
}

function starts(harness: Harness): ToolExecutionStartData[] {
	return traceEntries(harness).filter((data): data is ToolExecutionStartData => data.phase === "start");
}

function endOf(harness: Harness, toolCallId: string): ToolExecutionEndData | undefined {
	return traceEntries(harness).find(
		(data): data is ToolExecutionEndData => data.phase === "end" && data.toolCallId === toolCallId,
	);
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function delayTool(name: string, ms: number, details: Record<string, unknown> = {}, isError = false): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: Type.Object({}),
		execute: async () => {
			await wait(ms);
			return { content: [{ type: "text", text: name }], details, ...(isError ? { isError: true } : {}) };
		},
	};
}

describe("step.tool_execution", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function runOneBatch(harness: Harness, calls: ReturnType<typeof fauxToolCall>[]): Promise<void> {
		harness.setResponses([fauxAssistantMessage(calls, { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
		await harness.session.prompt("go");
	}

	it("writes a start and an end for each executed call, with each call's own end time", async () => {
		const harness = await createHarness({ tools: [delayTool("slow", 40), delayTool("fast", 1)] });
		harnesses.push(harness);
		await runOneBatch(harness, [fauxToolCall("slow", {}, { id: "s" }), fauxToolCall("fast", {}, { id: "f" })]);

		const assistantEntry = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		expect(starts(harness).map((data) => data.toolCallId)).toEqual(["s", "f"]);
		for (const data of starts(harness)) {
			expect(data).toMatchObject({ version: 1, assistantEntryId: assistantEntry?.id });
			expect(typeof data.startedAt).toBe("number");
		}
		const slowEnd = endOf(harness, "s");
		const fastEnd = endOf(harness, "f");
		expect(slowEnd?.outcome).toBe("ok");
		expect(fastEnd?.outcome).toBe("ok");
		// A parallel batch: each call ends at its own time, not when the batch is written.
		expect((slowEnd?.endedAt ?? 0) - (fastEnd?.endedAt ?? 0)).toBeGreaterThanOrEqual(20);
	});

	it("starts a sequential call no earlier than the previous call ended", async () => {
		const harness = await createHarness({
			tools: [
				{ ...delayTool("a", 10), executionMode: "sequential" },
				{ ...delayTool("b", 1), executionMode: "sequential" },
			],
		});
		harnesses.push(harness);
		await runOneBatch(harness, [fauxToolCall("a", {}, { id: "a1" }), fauxToolCall("b", {}, { id: "b1" })]);
		const startOfB = starts(harness).find((data) => data.toolCallId === "b1")?.startedAt ?? 0;
		expect(startOfB).toBeGreaterThanOrEqual(endOf(harness, "a1")?.endedAt ?? Number.POSITIVE_INFINITY);
	});

	it("records a policy block with its blocker and a refused prompt as denied, both without a start", async () => {
		const harness = await createHarness({
			tools: [delayTool("write_it", 0), delayTool("ask_it", 0), delayTool("other", 0)],
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", async (event) => {
						if (event.toolName === "write_it") return { block: true, reason: "plan", blockedBy: "plan_mode" };
						if (event.toolName === "ask_it") return { block: true, reason: "no", blockedBy: "user" };
						if (event.toolName === "other") return { block: true, reason: "nope" };
						return undefined;
					});
				},
			],
		});
		harnesses.push(harness);
		await runOneBatch(harness, [
			fauxToolCall("write_it", {}, { id: "w" }),
			fauxToolCall("ask_it", {}, { id: "q" }),
			fauxToolCall("other", {}, { id: "o" }),
		]);
		expect(starts(harness)).toHaveLength(0);
		expect(endOf(harness, "w")).toMatchObject({ outcome: "blocked", blockedBy: "plan_mode" });
		expect(endOf(harness, "q")).toMatchObject({ outcome: "denied" });
		expect(endOf(harness, "q")?.blockedBy).toBeUndefined();
		expect(endOf(harness, "o")).toMatchObject({ outcome: "blocked", blockedBy: "extension" });
		expect(typeof endOf(harness, "w")?.queuedAt).toBe("number");
	});

	it("records calls that never ran with their reason", async () => {
		const harness = await createHarness({ tools: [delayTool("present", 0)] });
		harnesses.push(harness);
		await runOneBatch(harness, [fauxToolCall("missing", {}, { id: "m" })]);
		expect(endOf(harness, "m")).toMatchObject({ outcome: "not_run", notRunReason: "tool_not_found" });
	});

	it("classifies timeouts, failures and the wait for a person", async () => {
		const harness = await createHarness({
			tools: [
				delayTool("slow_cmd", 0, { timedOut: true }, true),
				delayTool("broken", 0, {}, true),
				delayTool("ask", 0, { waitingForUserMs: 1234 }),
			],
		});
		harnesses.push(harness);
		await runOneBatch(harness, [
			fauxToolCall("slow_cmd", {}, { id: "t" }),
			fauxToolCall("broken", {}, { id: "e" }),
			fauxToolCall("ask", {}, { id: "a" }),
		]);
		expect(endOf(harness, "t")?.outcome).toBe("timeout");
		expect(endOf(harness, "e")?.outcome).toBe("error");
		expect(endOf(harness, "a")).toMatchObject({ outcome: "ok", waitingForUserMs: 1234 });
	});

	it("closes a call still running when the session is disposed as aborted", async () => {
		let started: () => void = () => {};
		const running = new Promise<void>((resolve) => {
			started = resolve;
		});
		const hanging: AgentTool = {
			name: "hang",
			label: "hang",
			description: "hang",
			parameters: Type.Object({}),
			execute: (_id, _params, signal) => {
				started();
				return new Promise((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				});
			},
		};
		const harness = await createHarness({ tools: [hanging] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("hang", {}, { id: "h" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const prompt = harness.session.prompt("go").catch(() => undefined);
		await running;
		harness.session.dispose();
		await prompt;
		const ends = traceEntries(harness).filter((data) => data.phase === "end" && data.toolCallId === "h");
		expect(ends).toEqual([expect.objectContaining({ outcome: "aborted" })]);
	});
});

describe("step.thinking_timing", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("is written once per reply by the session, naming the reply's entry", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage([fauxThinking("let me think"), fauxText("answer")])]);
		await harness.session.prompt("go");

		const entries = harness.sessionManager.getEntries();
		const assistant = entries.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		const timings = entries.filter(
			(entry): entry is Extract<SessionEntry, { type: "custom" }> =>
				entry.type === "custom" && entry.customType === THINKING_TIMING_ENTRY_TYPE,
		);
		expect(timings).toHaveLength(1);
		const data = timings[0]?.data as {
			assistantEntryId?: string;
			messageTimestamp?: number;
			thinkingTimings?: Record<string, { startedAt: number; endedAt: number }>;
		};
		expect(data.assistantEntryId).toBe(assistant?.id);
		expect(data.messageTimestamp).toBe(assistant?.type === "message" ? assistant.message.timestamp : undefined);
		const block = data.thinkingTimings?.["0"];
		expect(block && block.endedAt >= block.startedAt).toBe(true);
	});
});

describe("step.turn", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	type TurnData = TurnStartData | TurnEndData;
	function turns(harness: Harness): TurnData[] {
		return harness.sessionManager
			.getEntries()
			.filter(
				(entry): entry is Extract<SessionEntry, { type: "custom" }> =>
					entry.type === "custom" && entry.customType === TURN_ENTRY_TYPE,
			)
			.map((entry) => entry.data as TurnData);
	}

	it("opens a turn on the user's message and closes it when the run settles", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		const users = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message" && entry.message.role === "user");
		const records = turns(harness);
		expect(records.map((data) => data.phase)).toEqual(["start", "end", "start", "end"]);
		const [firstStart, firstEnd, secondStart] = records as [TurnStartData, TurnEndData, TurnStartData];
		expect(firstStart).toMatchObject({ version: 1, userEntryId: users[0]?.id, trigger: "user" });
		expect(firstEnd).toMatchObject({ turnId: firstStart.turnId, outcome: "completed" });
		expect(secondStart.turnId).not.toBe(firstStart.turnId);
		expect(firstEnd.at).toBeGreaterThanOrEqual(firstStart.at);
	});

	it("records a failed run as error", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid request" })]);
		await harness.session.prompt("go");
		expect(turns(harness).at(-1)).toMatchObject({ phase: "end", outcome: "error" });
	});

	it("records a stopped run as aborted even when its last reply finished normally", () => {
		// A stop during a tool call, a retry wait or a compaction leaves the last reply
		// as `toolUse` or `error`; the run's own cancellation decides the outcome.
		const written: Array<TurnStartData | TurnEndData> = [];
		const recorder = new TurnRecorder(
			(_type, data) => {
				written.push(data);
				return "entry";
			},
			() => "turn-1",
		);
		recorder.start("user-entry", "user", 1);
		recorder.observeReply("toolUse");
		recorder.end(false, 2, true);
		recorder.start("user-entry-2", "user", 3);
		recorder.observeReply("error");
		recorder.end(true, 4, true);
		expect(written.filter((data) => data.phase === "end").map((data) => (data as TurnEndData).outcome)).toEqual([
			"aborted",
			"aborted",
		]);
	});

	it("starts a turn for a scheduled task's message with its trigger", async () => {
		let api: ExtensionAPI | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					api = pi;
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("did it")]);
		api?.sendMessage({ customType: "step-cron", content: "[cron] report", display: true }, { triggerTurn: true });
		await harness.session.agent.waitForIdle();
		await new Promise((resolve) => setTimeout(resolve, 20));
		const records = turns(harness);
		expect(records[0]).toMatchObject({ phase: "start", trigger: "cron" });
		expect(records[1]).toMatchObject({ phase: "end", outcome: "completed" });
	});
});
