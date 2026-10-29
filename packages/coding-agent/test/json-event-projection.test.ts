import { fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { Type } from "typebox";
import { expect, test } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { sessionEventDurability } from "../src/core/session-event-durability.ts";
import { toJsonEvent } from "../src/modes/json-event.ts";
import { createHarness } from "./suite/harness.ts";

/**
 * The stdout projection is the only place that decides what a serialized
 * transport writes. Two properties matter, and they are separate:
 *
 *   1. a frame is never written unless the caller opts in;
 *   2. a boundary event (`turn_end`, `agent_end`) reports where it fell instead
 *      of re-sending the messages it closes over.
 *
 * What the projection deliberately keeps is also pinned here: a message is
 * written on its `message_start`/`message_end` pair, and a tool result also on
 * `tool_execution_end`. Those are sequence semantics, not duplicates.
 */

const assistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "done" }],
	api: "anthropic-messages",
	provider: "step",
	model: "m",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 1,
};

const toolResultMessage = {
	role: "toolResult",
	toolCallId: "call_1",
	toolName: "run_command",
	content: [{ type: "text", text: "x".repeat(20_000) }],
	isError: false,
	timestamp: 2,
};

const messageEnd = { type: "message_end", message: assistantMessage } as unknown as AgentSessionEvent;

const turnEnd = {
	type: "turn_end",
	message: assistantMessage,
	toolResults: [toolResultMessage],
} as unknown as AgentSessionEvent;

const agentEnd = {
	type: "agent_end",
	messages: [assistantMessage, toolResultMessage],
	willRetry: false,
} as unknown as AgentSessionEvent;

test("frames are absent from the record unless the caller opts in", () => {
	const messageUpdate = {
		type: "message_update",
		message: assistantMessage,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" },
	} as unknown as AgentSessionEvent;
	const toolUpdate = {
		type: "tool_execution_update",
		toolCallId: "call_1",
		toolName: "run_command",
		args: { command: "ls" },
		partialResult: { content: [{ type: "text", text: "partial" }] },
	} as unknown as AgentSessionEvent;

	for (const frame of [messageUpdate, toolUpdate]) {
		expect(toJsonEvent(frame)).toBeUndefined();
		expect(toJsonEvent(frame, { includeLiveEvents: false })).toBeUndefined();
		expect(toJsonEvent(frame, { includeLiveEvents: true })).toBeDefined();
	}
});

test("a fact is unchanged by the projection", () => {
	expect(toJsonEvent(messageEnd)).toBe(messageEnd);
	const start = { type: "turn_start" } as unknown as AgentSessionEvent;
	expect(toJsonEvent(start)).toBe(start);
	const settled = { type: "agent_settled" } as unknown as AgentSessionEvent;
	expect(toJsonEvent(settled)).toBe(settled);
});

test("turn_end drops the messages it closes over but keeps the boundary", () => {
	const projected = toJsonEvent(turnEnd);
	expect(projected).toEqual({ type: "turn_end", messageRole: "assistant", toolResultCount: 1 });
	// The 20 KB tool result is not re-sent here.
	expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThan(200);
});

test("agent_end drops the messages it re-sends but keeps the retry signal", () => {
	const projected = toJsonEvent({ ...agentEnd, willRetry: true } as unknown as AgentSessionEvent);
	expect(projected).toEqual({ type: "agent_end", willRetry: true, messageCount: 2 });
	expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThan(200);
});

test("a boundary with nothing to close over still projects", () => {
	// An aborted run emits turn_end with no tool results; an empty run emits
	// agent_end with no messages. Neither may throw or keep a stale payload.
	expect(
		toJsonEvent({ type: "turn_end", message: assistantMessage, toolResults: [] } as unknown as AgentSessionEvent),
	).toEqual({ type: "turn_end", messageRole: "assistant", toolResultCount: 0 });
	expect(toJsonEvent({ type: "agent_end", messages: [], willRetry: false } as unknown as AgentSessionEvent)).toEqual({
		type: "agent_end",
		willRetry: false,
		messageCount: 0,
	});
});

test("every durable type is either passed through or projected", () => {
	// The type union above must stay exhaustive: a new durable event that is
	// neither projected nor passed through would surface as a type error, and
	// this test names the current set so a removal is visible in review.
	const durableTypes = ["message_end", "tool_execution_end", "turn_end", "agent_end", "agent_settled"] as const;
	for (const type of durableTypes) {
		expect(sessionEventDurability({ type } as AgentSessionEvent)).toBe("durable");
	}
});

interface WireHit {
	type: string;
	bytes: number;
}

/**
 * Run one real prompt through a local tool and record every line a writer would
 * put on stdout, plus which of them carry a given marker.
 */
async function collectWire(
	marker: string,
	outputChars: number,
): Promise<{ hits: WireHit[]; totalBytes: number; types: string[] }> {
	const harness = await createHarness({
		extensionFactories: [
			{
				name: "probe-tool",
				factory: (pi) => {
					pi.registerTool({
						name: "probe",
						label: "Probe",
						description: "returns a sized payload",
						parameters: Type.Object({}),
						execute: async () => ({
							content: [{ type: "text", text: `${marker}${"y".repeat(outputChars)}` }],
							details: { marker },
						}),
					});
				},
			},
		],
	});
	try {
		const hits: WireHit[] = [];
		let totalBytes = 0;
		const types: string[] = [];
		harness.session.subscribe((event) => {
			const projected = toJsonEvent(event);
			if (!projected) return;
			const line = JSON.stringify(projected);
			const bytes = Buffer.byteLength(line, "utf8");
			totalBytes += bytes;
			types.push(String(projected.type));
			if (line.includes(marker)) hits.push({ type: String(projected.type), bytes });
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(`${marker}-assistant`),
		]);
		await harness.session.prompt("run probe");
		return { hits, totalBytes, types };
	} finally {
		harness.cleanup();
	}
}

test("a real run writes no frame and no boundary payload", async () => {
	const { hits, types } = await collectWire("FACT_MARKER", 40_000);

	// Frames never appear on the default channel.
	expect(types).not.toContain("message_update");
	expect(types).not.toContain("tool_execution_update");

	// The boundaries carry structure only, never the 40 KB payload.
	for (const type of ["turn_end", "agent_end"]) expect(types).toContain(type);
	expect(hits.map((hit) => hit.type)).not.toContain("turn_end");
	expect(hits.map((hit) => hit.type)).not.toContain("agent_end");

	// What the projection keeps, pinned so the docs cannot overclaim. A tool
	// result travels on `tool_execution_end` (its outcome) plus its own
	// `message_start`/`message_end` pair (framing) — three. The assistant answer
	// travels once, on `message_end`; its `message_start` is the empty partial
	// that streaming builds from.
	expect(hits.filter((hit) => hit.type === "tool_execution_end")).toHaveLength(1);
	expect(hits.filter((hit) => hit.type === "message_start")).toHaveLength(1);
	// Two `message_end`s: the tool result, and the assistant's final answer. Both
	// carry the marker, which is why the multiplier below is measured per added
	// character rather than per event.
	expect(hits.filter((hit) => hit.type === "message_end")).toHaveLength(2);
});

test("a payload is written a fixed number of times, whatever its size", async () => {
	const smallChars = 1_000;
	const largeChars = 40_000;
	const small = await collectWire("SIZE_MARKER", smallChars);
	const large = await collectWire("SIZE_MARKER", largeChars);

	// Exactly the same event sequence; only the payload inside it grew.
	expect(large.types).toEqual(small.types);

	// The marginal bytes per added character are the number of copies the
	// projection keeps — three: `tool_execution_end` plus the tool result's
	// `message_start`/`message_end` pair. A repeated transcript would make this
	// grow with the number of events instead of staying constant.
	const perChar = (large.totalBytes - small.totalBytes) / (largeChars - smallChars);
	expect(perChar).toBeGreaterThan(2.5);
	expect(perChar).toBeLessThan(3.5);
});

test("the record is bounded per line even with a large payload", async () => {
	const { hits } = await collectWire("BOUND_MARKER", 40_000);
	for (const hit of hits) expect(hit.bytes).toBeLessThan(1024 * 1024);
	// The payload is not replicated per event: one tool result, one assistant
	// message, one execution outcome.
	expect(hits.length).toBe(4);
});
