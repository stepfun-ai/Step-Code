import { expect, test } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { MAX_LIVE_UPDATE_BYTES, toJsonEvent } from "../src/modes/json-event.ts";

function frame(text: string, details: unknown = {}): Extract<AgentSessionEvent, { type: "tool_execution_update" }> {
	return {
		type: "tool_execution_update",
		toolCallId: "call",
		toolName: "probe",
		args: { input: "start" },
		partialResult: { content: [{ type: "text", text }], details },
	};
}

test("under-budget tool frames pass through by identity", () => {
	const event = frame("short");
	expect(toJsonEvent(event, { includeLiveEvents: true })).toBe(event);
});

test.each([
	["ASCII", "r"],
	["control", "\u0001"],
	["quotes and backslashes", '"\\'],
	["CJK", "中"],
	["lone surrogate", "\ud800"],
])("bounds serialized bytes for 4 MiB %s text", (_label, character) => {
	const text = `${character.repeat(4 * 1024 * 1024)}TAIL`;
	const event = frame(text);
	const projected = toJsonEvent(event, { includeLiveEvents: true })!;
	expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThanOrEqual(MAX_LIVE_UPDATE_BYTES);
	expect(projected).not.toHaveProperty("args");
	expect(projected).not.toHaveProperty("partialResult.details");
	expect(projected).toHaveProperty("partialResult.content.0.text", expect.stringContaining("[live output truncated]"));
	expect(projected).toHaveProperty("partialResult.content.0.text", expect.stringMatching(/TAIL$/));
	expect(event.partialResult.content[0].text).toBe(text);
});

test("oversized identifiers cannot prevent reaching the floor", () => {
	const event = {
		...frame("x"),
		toolCallId: "\u0001".repeat(4 * 1024 * 1024),
		toolName: "中".repeat(4 * 1024 * 1024),
	};
	const projected = toJsonEvent(event, { includeLiveEvents: true })!;
	expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThanOrEqual(MAX_LIVE_UPDATE_BYTES);
	expect(projected).toHaveProperty("toolCallId", event.toolCallId.slice(0, 200));
	expect(projected).toHaveProperty("toolName", event.toolName.slice(0, 200));
});

test("one-character text with oversized details terminates without restoring details", () => {
	const event = frame("x", { huge: "r".repeat(4 * 1024 * 1024) });
	const projected = toJsonEvent(event, { includeLiveEvents: true })!;
	expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThanOrEqual(MAX_LIVE_UPDATE_BYTES);
	expect(projected).not.toHaveProperty("partialResult.details");
});

test("terminal tool results are never bounded", () => {
	const event: AgentSessionEvent = {
		type: "tool_execution_end",
		toolCallId: "call",
		toolName: "probe",
		result: frame("r".repeat(4 * 1024 * 1024)).partialResult,
		isError: false,
	};
	expect(toJsonEvent(event, { includeLiveEvents: true })).toBe(event);
	expect(Buffer.byteLength(JSON.stringify(toJsonEvent(event, { includeLiveEvents: true })))).toBeGreaterThan(
		MAX_LIVE_UPDATE_BYTES,
	);
});

test("an unserializable live payload does not throw out of the projection", () => {
	// `partialResult` is `any`: a tool can hand back a BigInt or a circular
	// reference. Measuring the frame with a bare `JSON.stringify` used to raise a
	// TypeError from inside the transport's subscribe callback, turning a healthy
	// tool call into an unrelated serialization failure. An unserializable frame is
	// treated as oversized instead, which still writes the progress marker.
	const bigint = frame("x");
	(bigint.partialResult as Record<string, unknown>).n = 1n;
	const circular = frame("y");
	(circular.partialResult as Record<string, unknown>).self = circular.partialResult;

	for (const event of [bigint, circular]) {
		const projected = toJsonEvent(event, { includeLiveEvents: true });
		expect(projected?.type).toBe("tool_execution_update");
	}
});
