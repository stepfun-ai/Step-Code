import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { createGroupAndTag, setSessionTag } from "../client/src/features/sidebar/actions.ts";
import { createInitialState, getState, setState } from "../client/src/state/store.ts";
import { forgetDeletedSession, refreshSessions } from "../client/src/state/session.ts";
import type { SessionSummary, TagGroup } from "../client/src/state/types.ts";

/**
 * Deleting a group has to remove it everywhere it is offered.
 *
 * The grouped view never draws a group with no sessions, so a group whose last
 * session was deleted or untagged looks deleted there — while the session's
 * "set group" picker kept offering it, and its colour stayed taken, so the
 * group could neither be reused nor replaced. Groups are derived state: they
 * live exactly as long as a listed session carries their tag.
 */

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalFetch = globalThis.fetch;
beforeEach(() => {
	const values = new Map<string, string>();
	Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => void values.set(key, value),
	} });
	setState(createInitialState());
});
afterEach(() => {
	if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
	else Reflect.deleteProperty(globalThis, "localStorage");
	globalThis.fetch = originalFetch;
	setState(createInitialState());
});

function session(id: string, extra: Partial<SessionSummary> = {}): SessionSummary {
	return { id, cwd: "/work/project", ...extra } as SessionSummary;
}

function group(key: TagGroup["key"], name: string): TagGroup {
	return { key, name };
}

/** Simulates the host answering the session list, without a real HTTP round trip. */
function listSessions(sessions: readonly SessionSummary[]): void {
	setState({ sessions });
}

test("untagging the last session of a group removes the group, not just the tag", () => {
	setState({ sessions: [session("s1")] });
	createGroupAndTag("s1", "red", "Audit");
	assert.deepEqual(getState().groups, [group("red", "Audit")]);
	assert.equal(getState().tags.get("s1"), "red");

	setSessionTag("s1", null);
	assert.equal(getState().tags.has("s1"), false);
	assert.deepEqual(getState().groups, [], "an empty group is still offered in the picker");
});

test("a group stays while another listed session still carries its tag", () => {
	setState({ sessions: [session("s1"), session("s2")] });
	createGroupAndTag("s1", "red", "Audit");
	setSessionTag("s2", "red");

	setSessionTag("s1", null);
	assert.deepEqual(getState().groups, [group("red", "Audit")]);
	assert.equal(getState().tags.get("s2"), "red");
});

test("deleting a session drops its tag and the group it emptied", () => {
	setState({ sessions: [session("s1"), session("s2")] });
	createGroupAndTag("s1", "teal", "Review");

	// What the delete action does: the row leaves the host's list, the client forgets it.
	forgetDeletedSession("s1");
	listSessions([session("s2")]);
	assert.equal(getState().tags.has("s1"), false, "the deleted session keeps its tag");
	assert.deepEqual(getState().groups, [], "the group of a deleted session is still offered");
});

test("the freed colour can be used for a new group without a stale duplicate", () => {
	setState({ sessions: [session("s1")] });
	createGroupAndTag("s1", "red", "Audit");
	setSessionTag("s1", null);
	setSessionTag("s1", "red");
	createGroupAndTag("s1", "red", "Second");
	assert.deepEqual(getState().groups, [group("red", "Second")]);
});

test("removing the group being filtered clears the filter instead of hiding every row", () => {
	setState({ sessions: [session("s1")], currentFilter: "red" });
	createGroupAndTag("s1", "red", "Audit");
	assert.equal(getState().currentFilter, "red");
	setSessionTag("s1", null);
	assert.equal(getState().currentFilter, null, "the sidebar stays filtered by a group that no longer exists");
});

test("a tag whose session is gone cannot keep a group selectable after a refresh", async () => {
	localStorage.setItem("stepcode.tagGroups", JSON.stringify({
		version: 1, groups: [group("purple", "Ghost")], tags: [["gone", "purple"]],
	}));
	setState({ sessions: [], tags: new Map([["gone", "purple"]]), groups: [group("purple", "Ghost")] });
	// Persisted metadata survives recovery, so only successful list pruning can remove this group.
	globalThis.fetch = (async () => new Response(JSON.stringify({ sessions: [] }))) as typeof fetch;
	try {
		await refreshSessions();
	} finally {
		// biome-ignore lint/performance/noDelete: the test must not leave a stub behind.
		delete (globalThis as { fetch?: unknown }).fetch;
	}
	assert.deepEqual(getState().groups, [], "a group with no listed session is still offered");
	assert.equal(getState().tags.has("gone"), false);
});
