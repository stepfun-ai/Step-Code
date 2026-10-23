import assert from "node:assert/strict";
import test from "node:test";
import { timelineFromEntries } from "../client/src/state/session.ts";
import type { SessionEntry } from "../client/src/state/types.ts";

function message(id: string, role: "user" | "assistant", content = id): SessionEntry {
	return { id, type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role, content } };
}

test("a compaction entry becomes a collapsed row at its chronological position", () => {
	const entries: SessionEntry[] = [
		message("u1", "user"),
		message("a1", "assistant"),
		{
			id: "c1",
			type: "compaction",
			timestamp: "2026-01-01T00:00:01.000Z",
			summary: "## Summary\n\nThe user asked about compaction.",
			tokensBefore: 34053,
			firstKeptEntryId: "a2",
		},
		message("u2", "user"),
		message("a2", "assistant"),
	];
	const items = timelineFromEntries(entries);
	assert.deepEqual(
		items.map((item) => item.kind),
		["message", "message", "compaction", "message", "message"],
	);
	const row = items[2];
	assert.equal(row?.kind, "compaction");
	if (row?.kind !== "compaction") return;
	assert.equal(row.summary, "## Summary\n\nThe user asked about compaction.");
	assert.equal(row.tokensBefore, 34053);
	// The two messages before the kept entry are what the summary replaced.
	assert.equal(row.removedMessages, 2);
});

test("without a first-kept entry the row counts everything before it", () => {
	const entries: SessionEntry[] = [
		message("u1", "user"),
		message("a1", "assistant"),
		{ id: "c1", type: "compaction", summary: "s", tokensBefore: 900 },
		message("u2", "user"),
	];
	const row = timelineFromEntries(entries)[2];
	assert.equal(row?.kind, "compaction");
	if (row?.kind !== "compaction") return;
	assert.equal(row.removedMessages, 2);
});

test("a second compaction counts only the messages it replaced", () => {
	const entries: SessionEntry[] = [
		message("u1", "user"),
		{ id: "c1", type: "compaction", summary: "one", tokensBefore: 100, firstKeptEntryId: "u2" },
		message("u2", "user"),
		message("a2", "assistant"),
		{ id: "c2", type: "compaction", summary: "two", tokensBefore: 200, firstKeptEntryId: "u3" },
		message("u3", "user"),
	];
	const rows = timelineFromEntries(entries).filter((item) => item.kind === "compaction");
	assert.equal(rows.length, 2);
	if (rows[0]?.kind !== "compaction" || rows[1]?.kind !== "compaction") return;
	assert.equal(rows[0].removedMessages, 1);
	// The earlier summary already accounts for u1; the second compaction replaced u2 and a2.
	assert.equal(rows[1].removedMessages, 2);
});
