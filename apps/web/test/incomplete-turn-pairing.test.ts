import assert from "node:assert/strict";
import test from "node:test";
import { INCOMPLETE_TURN_RECOVERY_CUSTOM_TYPE, type SessionEntry } from "@step-harness/coding-agent";
import { projectEntries } from "../src/runtime.ts";

/**
 * Pairing an empty turn with the follow-up that recovered it.
 *
 * The recovery names the entry it answers, so the two are matched by identity on
 * the real entry order — a session writes usage provenance, a compaction, and
 * session-state entries between them, and none of that changes the pairing.
 */

function entry(id: string, value: Record<string, unknown>): SessionEntry {
	return { type: "message", id, timestamp: "2026-11-02T11:49:34.000Z", message: value } as SessionEntry;
}

function assistant(id: string, incomplete?: string): SessionEntry {
	return entry(id, {
		role: "assistant",
		content: [{ type: "thinking", thinking: "reasoning" }],
		stopReason: "stop",
		...(incomplete ? { incomplete } : {}),
	});
}

function recovery(id: string, recoversEntryId: string): SessionEntry {
	return {
		type: "custom_message",
		id,
		timestamp: "2026-11-02T11:49:35.000Z",
		customType: INCOMPLETE_TURN_RECOVERY_CUSTOM_TYPE,
		content: "…",
		display: false,
		details: { recoversEntryId },
	} as SessionEntry;
}

const provenance = (id: string) =>
	({ type: "custom", id, timestamp: "2026-11-02T11:49:34.500Z", customType: "step.usage_provenance", data: {} }) as SessionEntry;
const compaction = (id: string) =>
	({ type: "compaction", id, timestamp: "2026-11-02T11:49:34.700Z", summary: "…", tokensBefore: 1 }) as SessionEntry;
const user = (id: string) =>
	entry(id, { role: "user", content: [{ type: "text", text: "go" }] });

const recoveredIds = (entries: readonly SessionEntry[]) =>
	projectEntries(entries)
		.filter((projected) => projected.incompleteTurnRecovered === true)
		.map((projected) => projected.id);

test("a usage-provenance record between the turn and its follow-up does not break the pairing", () => {
	const entries = [user("u"), assistant("a", "no_visible_output"), provenance("p"), recovery("r", "a"), assistant("b")];
	assert.deepEqual(recoveredIds(entries), ["a"]);
});

test("an overflow recovery pairs across the compaction entry", () => {
	const entries = [
		user("u"),
		assistant("a", "no_visible_output"),
		provenance("p"),
		compaction("c"),
		recovery("r", "a"),
		assistant("b"),
	];
	assert.deepEqual(recoveredIds(entries), ["a"]);
});

test("a terminal empty turn is not marked recovered", () => {
	const entries = [user("u"), assistant("a", "no_visible_output"), provenance("p")];
	assert.deepEqual(recoveredIds(entries), []);
});

test("a completed turn is never marked", () => {
	const entries = [user("u"), assistant("a"), provenance("p"), recovery("r", "a")];
	assert.deepEqual(recoveredIds(entries), []);
});

test("the follow-up itself is not mistaken for a recovered turn", () => {
	const entries = [user("u"), assistant("a", "missing_tool_call"), recovery("r", "a")];
	const followUp = projectEntries(entries).find((projected) => projected.id === "r");
	assert.equal(followUp?.incompleteTurnRecovered, undefined);
	assert.deepEqual(recoveredIds(entries), ["a"]);
});

test("an entry written while the recovery is pending does not break the pairing", () => {
	// A model switch, a thinking-level change, or a session rename can be written
	// between the turn and its follow-up; identity does not care.
	const entries = [
		user("u"),
		assistant("a", "no_visible_output"),
		provenance("p"),
		{ type: "model_change", id: "m", timestamp: "2026-11-02T11:49:34.600Z", model: "x" } as SessionEntry,
		{ type: "thinking_level_change", id: "t", timestamp: "2026-11-02T11:49:34.650Z", level: "high" } as SessionEntry,
		{ type: "session_info", id: "s", timestamp: "2026-11-02T11:49:34.660Z", name: "title" } as SessionEntry,
		recovery("r", "a"),
		assistant("b"),
	];
	assert.deepEqual(recoveredIds(entries), ["a"]);
});

test("a recovery that names an unknown entry marks nothing", () => {
	assert.deepEqual(recoveredIds([user("u"), assistant("a", "no_visible_output"), recovery("r", "gone")]), []);
});
