import { expect, test } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { isEphemeralSessionEvent, sessionEventDurability } from "../src/core/session-event-durability.ts";

/**
 * The root cause of the subagent log amplification was that a live progress
 * frame and a fact worth persisting travelled on the same stream, so a host that
 * redirected the stream to a file kept every frame. The classification below is
 * what separates them; these tests pin the rule and its allowlist bias.
 */

const durable: AgentSessionEvent["type"][] = [
	"agent_start",
	"agent_end",
	"agent_settled",
	"turn_start",
	"turn_end",
	"message_start",
	"message_end",
	"tool_execution_start",
	"tool_execution_end",
	"queue_update",
	"compaction_start",
	"compaction_end",
];

test.each(durable)("%s is durable", (type) => {
	expect(sessionEventDurability({ type } as AgentSessionEvent)).toBe("durable");
	expect(isEphemeralSessionEvent({ type } as AgentSessionEvent)).toBe(false);
});

test.each(["message_update", "tool_execution_update"] as const)("%s is ephemeral", (type) => {
	expect(sessionEventDurability({ type } as AgentSessionEvent)).toBe("ephemeral");
	expect(isEphemeralSessionEvent({ type } as AgentSessionEvent)).toBe(true);
});

test("the rule is an allowlist, so a new event type is durable by default", () => {
	// Forgetting to classify a future streaming event must not silently opt it
	// into a persisted log; it must land on the safe side instead.
	const future = { type: "some_future_streaming_event" } as unknown as AgentSessionEvent;
	expect(sessionEventDurability(future)).toBe("durable");
});

test("every ephemeral event has a durable successor carrying its value", () => {
	// The property that makes dropping these safe: a reader that skips them can
	// still reconstruct the run from the successor event alone.
	const successors: Record<string, string> = {
		message_update: "message_end",
		tool_execution_update: "tool_execution_end",
	};
	for (const successor of Object.values(successors)) {
		expect(durable).toContain(successor);
	}
});
