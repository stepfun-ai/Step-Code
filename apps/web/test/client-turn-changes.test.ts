import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry as HostEntry } from "@step-harness/coding-agent";
import { revertFailure } from "../client/src/features/conversation/actions.ts";
import { t } from "../client/src/i18n/index.ts";
import { ApiError } from "../client/src/lib/api.ts";
import { collectTurnChanges } from "../client/src/lib/turn-changes.ts";
import { timelineFromEntries } from "../client/src/state/session.ts";
import type { SessionEntry, TimelineItem } from "../client/src/state/types.ts";
import { turnChanges } from "../src/turn-changes.ts";

const patch = (path: string) => `--- ${path}\n+++ ${path}\n@@ -1,1 +1,1 @@\n-x\n+y\n`;

function message(id: string, value: Record<string, unknown>): SessionEntry {
	return { type: "message", id, timestamp: "2026-10-15T00:00:00.000Z", message: value } as SessionEntry;
}

function edit(id: string, path: string, details: Record<string, unknown> = { patch: patch(path) }): SessionEntry[] {
	return [
		message(`a-${id}`, { role: "assistant", content: [{ type: "toolCall", id, name: "edit", arguments: { path } }] }),
		message(`r-${id}`, { role: "toolResult", toolCallId: id, details }),
	];
}

test("the client splits turns at every user message, like the host's revert", () => {
	const entries = [
		message("u1", { role: "user", content: [{ type: "text", text: "first" }] }),
		...edit("c1", "a.ts"),
		// An image-only prompt still opens a turn.
		message("u2", { role: "user", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] }),
		...edit("c2", "b.ts"),
	];
	const items = timelineFromEntries(entries);
	assert.deepEqual(items[2], {
		itemId: "message-u2",
		entryId: "u2",
		kind: "message",
		role: "user",
		content: "",
		images: ["data:image/png;base64,AAAA"],
		usage: undefined,
		timestamp: "2026-10-15T00:00:00.000Z",
	});
	const client = collectTurnChanges(items, "/w").map((turn) => [turn.turnId, turn.files.map((file) => file.path)]);
	const host = ["u1", "u2"].map((turnId) => [
		turnId,
		turnChanges(entries as unknown as HostEntry[], turnId).changes.map((change) => change.path),
	]);
	assert.deepEqual(client, host);
	assert.deepEqual(client, [
		["u1", ["a.ts"]],
		["u2", ["b.ts"]],
	]);
});

test("collectTurnChanges marks files without a patch", () => {
	const entries = [
		message("u1", { role: "user", content: "go" }),
		...edit("c1", "big.txt", { untracked: "too_large" }),
		message("a-b", { role: "assistant", content: [{ type: "toolCall", id: "b1", name: "bash", arguments: {} }] }),
		message("r-b", { role: "toolResult", toolCallId: "b1", content: [] }),
	];
	const [turn] = collectTurnChanges(timelineFromEntries(entries), "/w");
	assert.deepEqual(turn?.files, [{ path: "big.txt", patches: [], untracked: "too_large", additions: 0, deletions: 0 }]);
});

test("collectTurnChanges keeps unchanged turns and files as the same objects", () => {
	const items = timelineFromEntries([
		message("u1", { role: "user", content: "one" }),
		...edit("c1", "a.ts"),
		message("u2", { role: "user", content: "two" }),
		...edit("c2", "b.ts"),
	]);
	const first = collectTurnChanges(items, "/w");
	// The next stream frame: a new row in the running turn.
	const running: TimelineItem = {
		itemId: "tool-live",
		kind: "tool",
		state: "pending",
		toolName: "read",
		inputSummary: "",
		outputSummary: "",
		inputDetail: "",
		outputDetail: "",
	};
	const next = collectTurnChanges([...items, running], "/w");
	assert.equal(next[0], first[0]);
	// The running turn's position moved, so the turn is new, but its file did not change.
	assert.notEqual(next[1], first[1]);
	assert.equal(next[1]?.files[0], first[1]?.files[0]);
});

test("a refused undo names its reason: later turns only for conflict", () => {
	const refusal = (code: string) => revertFailure(new ApiError(409, { error: "refused", code, path: "a.txt" }));
	assert.equal(refusal("modified"), t("turnRevertModified", { path: "a.txt" }));
	assert.equal(refusal("conflict"), t("turnRevertConflict", { path: "a.txt" }));
	assert.notEqual(refusal("modified"), refusal("conflict"));
	assert.match(refusal("modified"), /a\.txt/);
});

test("Step's edit_file and write_file count as turn changes on both sides; an unchanged write does not", () => {
	const call = (id: string, name: string, args: Record<string, unknown>, details: Record<string, unknown>) => [
		message(`a-${id}`, { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] }),
		message(`r-${id}`, { role: "toolResult", toolCallId: id, details }),
	];
	const entries = [
		message("u1", { role: "user", content: [{ type: "text", text: "write it" }] }),
		...call("w1", "write_file", { path: "index.html", content: "x\n" }, { path: "index.html", changed: true }),
		message("u2", { role: "user", content: [{ type: "text", text: "change it" }] }),
		...call("e2", "edit_file", { path: "index.html", search: "x", replace: "y" }, { patch: patch("index.html") }),
		message("u3", { role: "user", content: [{ type: "text", text: "write it again" }] }),
		...call("w3", "write_file", { path: "index.html", content: "y\n" }, { path: "index.html", changed: false }),
	];
	const turns = collectTurnChanges(timelineFromEntries(entries), "/work");
	assert.deepEqual(
		turns.map((turn) => [turn.turnId, turn.files.map((file) => [file.path, file.additions, file.deletions, file.untracked])]),
		[
			["u1", [["index.html", 0, 0, "unknown"]]],
			["u2", [["index.html", 1, 1, undefined]]],
		],
	);
	const host = entries as unknown as HostEntry[];
	assert.deepEqual(turnChanges(host, "u1").skipped, [{ path: "index.html", reason: "unknown" }]);
	assert.equal(turnChanges(host, "u2").changes.length, 1);
	assert.deepEqual(turnChanges(host, "u3"), { changes: [], skipped: [] });
});
