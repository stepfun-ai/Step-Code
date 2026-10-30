/**
 * The sidebar's own arrangement: pinning a conversation and the order a drag
 * gives it.
 *
 * Both are page preferences, so they live apart from the host's session list:
 * the list stays in the host's order (newest first) and the sidebar arranges a
 * copy of it. These cases hold what a reader would notice — the row pinned last
 * leading its list, a drag moving a row in and out of the pinned block, a new
 * conversation still arriving on top, a drag in one project leaving another
 * alone, and a deleted session taking its pin and its place with it. The pointer
 * and keyboard wiring itself is covered by the sidebar e2e case in
 * `e2e/web.e2e.mjs`.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { reorderSession, toggleSessionPin } from "../client/src/features/sidebar/actions.ts";
import * as drag from "../client/src/features/sidebar/drag.ts";
import { forgetDeletedSession, refreshSessions } from "../client/src/state/session.ts";
import {
	moveSession,
	orderedSessions,
	pruneSessionPreferences,
	readSessionPreferences,
	type SessionPreferences,
	writeSessionPreferences,
} from "../client/src/state/session-order.ts";
import { createInitialState, getState, setState } from "../client/src/state/store.ts";
import type { SessionSummary } from "../client/src/state/types.ts";

afterEach(() => {
	// biome-ignore lint/performance/noDelete: a test-only stub must not outlive the test.
	delete (globalThis as { localStorage?: unknown }).localStorage;
	setState(createInitialState());
});

function session(id: string, extra: Partial<SessionSummary> = {}): SessionSummary {
	return { id, cwd: "/work/project", ...extra } as SessionSummary;
}

function ids(sessions: readonly SessionSummary[]): string[] {
	return sessions.map((entry) => entry.id);
}

function prefs(pinnedSessions: readonly string[] = [], sessionOrder: readonly string[] = []): SessionPreferences {
	return { pinnedSessions, sessionOrder };
}

/** A minimal localStorage, so the storage contract can be observed in Node. */
function fakeStorage(): Map<string, string> {
	const store = new Map<string, string>();
	(globalThis as { localStorage?: unknown }).localStorage = {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => void store.set(key, value),
		removeItem: (key: string) => void store.delete(key),
	};
	return store;
}

test("the host's order is kept while nothing is arranged", () => {
	const sessions = [session("newest"), session("middle"), session("oldest")];
	assert.deepEqual(ids(orderedSessions(sessions, [], [])), ["newest", "middle", "oldest"]);
});

test("the row pinned last leads the list, and pinning keeps the list intact", () => {
	const sessions = [session("a"), session("b"), session("c")];
	// Pinning c, then b: b is the more recent pin, so it comes first.
	const ordered = orderedSessions(sessions, ["b", "c"], []);
	assert.deepEqual(ids(ordered), ["b", "c", "a"], "the newest pin leads, then the older one");
	assert.equal(ordered.length, sessions.length, "pinning duplicates no row");
});

test("only a pin floats: an unpinned row stays where it was dragged", () => {
	const sessions = [session("a"), session("b"), session("c")];
	assert.deepEqual(ids(orderedSessions(sessions, [], ["c", "a", "b"])), ["c", "a", "b"]);
	assert.deepEqual(ids(orderedSessions(sessions, ["b"], ["c", "a", "b"])), ["b", "c", "a"]);
});

test("a pin is display-only: it never writes the unpinned order", () => {
	// The bug this covers: pinning used to store the pinned position in the order,
	// so unpinning left the row at the top and the click looked like it did
	// nothing. A drag next to a pinned row now only rewrites the unpinned rows.
	assert.deepEqual(moveSession(["c", "a", "b"], prefs(["b"]), "c", "a", "before"), prefs(["b"], ["c", "a"]));
	// A row that already had a place keeps it while pinned, so unpinning returns it.
	assert.deepEqual(ids(orderedSessions([session("a"), session("b"), session("c")], [], ["b", "a", "c"])), [
		"b",
		"a",
		"c",
	]);
});

test("a dragged row lands on the side it was dropped", () => {
	const list = ["a", "b", "c"];
	assert.deepEqual(moveSession(list, prefs(), "c", "a", "before").sessionOrder, ["c", "a", "b"]);
	assert.deepEqual(moveSession(list, prefs(), "a", "c", "after").sessionOrder, ["b", "c", "a"]);
});

test("the pinned block is fixed: a drag onto a pinned row changes nothing", () => {
	// The reported bug: dropping a row on a pinned row used to pin it there, so a
	// dragged row ended up above the pinned ones. The block is not a drop target.
	const before = prefs(["b", "c"], ["a"]);
	for (const place of ["before", "after"] as const) {
		assert.equal(moveSession(["b", "c", "a"], before, "a", "c", place), before, `dropped ${place} a pin`);
	}
	// And a pinned row cannot be dragged out either: its order is the pin order.
	assert.equal(moveSession(["b", "c", "a"], before, "b", "a", "after"), before);
	assert.equal(moveSession(["b", "c", "a"], before, "c", "b", "before"), before);
});

test("a drag that changes nothing keeps the same arrangement object", () => {
	// Dropped where it already sat inside the unpinned rows: same reference, so
	// nothing repaints (so does any drop on the fixed pinned block, above).
	const before = prefs(["b"], ["b", "a", "c"]);
	assert.equal(
		moveSession(["b", "a", "c"], before, "c", "a", "after"),
		before,
		"the same reference, so nothing repaints",
	);
	// A row that is not in this list (deleted mid-drag, another project) moves nothing.
	assert.equal(moveSession(["a", "b"], before, "gone", "a", "before"), before);
	assert.equal(moveSession(["a", "b"], before, "a", "a", "before"), before);
});

test("a drag in one list leaves every other list on the host's order", () => {
	// The stored order covers the list the reader arranged; a project they never
	// touched must keep following the host instead of freezing at the moment of
	// somebody else's drag.
	const moved = moveSession(["a1", "a2"], prefs(), "a2", "a1", "before");
	assert.deepEqual(moved.sessionOrder, ["a2", "a1"]);
	const neighbour = [session("b1"), session("b2")];
	assert.deepEqual(ids(orderedSessions(neighbour, moved.pinnedSessions, moved.sessionOrder)), ["b1", "b2"]);
});

test("a session retagged into another list keeps the place it was given", () => {
	// A place belongs to the session, not to the list it was arranged in: joining
	// a list that was never arranged leaves it after the list's own rows. Recorded
	// here so the behaviour is a contract rather than an accident.
	const tagged = [session("t1"), session("t2"), session("moved")];
	assert.deepEqual(ids(orderedSessions(tagged, [], ["moved"])), ["t1", "t2", "moved"]);
});

test("a conversation the host lists for the first time arrives on top", () => {
	const withNew = [session("fresh"), session("a"), session("b")];
	assert.deepEqual(ids(orderedSessions(withNew, [], ["b", "a"])), ["fresh", "b", "a"]);
});

test("a drag needs one unpinned row of the same list on both ends", () => {
	setState({ sessions: [session("a"), session("b")] });
	drag.beginSessionDrag("a", "/work/project", false);
	try {
		const source = drag.draggedSession();
		assert.equal(drag.canReorder(source, "/work/project", "b", false), true);
		assert.equal(drag.canReorder(source, "/work/project", "a", false), false, "a row cannot be dropped on itself");
		assert.equal(drag.canReorder(source, "/work/other", "b", false), false, "another project's rows do not reorder");
		assert.equal(drag.canReorder(source, "/work/project", "b", true), false, "the pinned block is not a drop target");
		assert.equal(drag.canReorder(null, "/work/project", "b", false), false);
	} finally {
		drag.endSessionDrag();
	}
	assert.equal(drag.draggedSession(), null);

	// A pinned row is never grabbed, and a stale state from one cannot land either.
	drag.beginSessionDrag("b", "/work/project", true);
	try {
		assert.equal(drag.canReorder(drag.draggedSession(), "/work/project", "a", false), false);
	} finally {
		drag.endSessionDrag();
	}
});

test("a drop asks for the half of the row the pointer is over", () => {
	const rect = { top: 100, height: 36 };
	const element = { getBoundingClientRect: () => rect } as unknown as Element;
	assert.equal(drag.dropPlaceAt(element, 102), "before");
	assert.equal(drag.dropPlaceAt(element, 130), "after");
});

test("pinning through the sidebar actions put the newest pin first", () => {
	setState({ sessions: [session("a"), session("b"), session("c")] });
	toggleSessionPin("c");
	toggleSessionPin("b");
	assert.deepEqual(getState().pinnedSessions, ["b", "c"], "the row pinned last leads");
	assert.equal(getState().sessionOrder.length, 0, "a pin does not arrange anything");
	assert.deepEqual(ids(orderedSessions(getState().sessions, getState().pinnedSessions, getState().sessionOrder)), [
		"b",
		"c",
		"a",
	]);
	toggleSessionPin("b");
	assert.deepEqual(getState().pinnedSessions, ["c"]);

	reorderSession("a", "a", "before", ["c", "b", "a"]);
	assert.deepEqual(getState().sessionOrder, [], "dropping a row on itself changes nothing");
	reorderSession("a", "c", "before", ["c", "b", "a"]);
	assert.deepEqual(getState().sessionOrder, [], "a pinned row is not a drop target");
	assert.deepEqual(getState().pinnedSessions, ["c"], "and a drag never pins");
});

test("pinning and dragging reach localStorage, not just the store", () => {
	// The one regression only a reload would show, so the write itself is checked:
	// an arrangement that never lands in storage is lost on refresh.
	const store = fakeStorage();
	setState({ sessions: [session("a"), session("b"), session("c")] });
	toggleSessionPin("b");
	assert.deepEqual(JSON.parse(store.get("stepcode.pinnedSessions") ?? "null"), ["b"]);
	reorderSession("c", "a", "before", ["b", "c", "a"]);
	assert.deepEqual(JSON.parse(store.get("stepcode.sessionOrder") ?? "null"), ["c", "a"]);
	assert.deepEqual(JSON.parse(store.get("stepcode.pinnedSessions") ?? "null"), ["b"], "a drag keeps the pins");
});

test("the preferences survive a storage round trip, and a corrupt record is ignored", () => {
	const store = fakeStorage();
	writeSessionPreferences(prefs(["b", "a"], ["b", "a", "c"]));
	assert.deepEqual(readSessionPreferences().sessionOrder, ["b", "a", "c"]);
	assert.deepEqual(readSessionPreferences().pinnedSessions, ["b", "a"], "the pin order is stored, not just membership");
	assert.deepEqual(JSON.parse(store.get("stepcode.sessionOrder") ?? "null"), ["b", "a", "c"]);

	// A repeated id would otherwise become two pins.
	store.set("stepcode.pinnedSessions", JSON.stringify(["a", "a", "b"]));
	assert.deepEqual(readSessionPreferences().pinnedSessions, ["a", "b"]);

	store.set("stepcode.sessionOrder", "{not json");
	store.set("stepcode.pinnedSessions", JSON.stringify({ not: "a list" }));
	assert.deepEqual(readSessionPreferences(), prefs());
});

test("a session the list dropped takes its pin and its place with it", () => {
	const state = prefs(["gone", "kept"], ["gone", "kept"]);
	const pruned = pruneSessionPreferences(state, new Set(["kept"]));
	assert.deepEqual(pruned.pinnedSessions, ["kept"]);
	assert.deepEqual(pruned.sessionOrder, ["kept"]);
	// Nothing removed: the same object comes back, and no write is needed.
	assert.equal(pruneSessionPreferences(state, new Set(["gone", "kept"])), state);
});

test("a refreshed list drops the arrangement of a session it no longer holds", async () => {
	const store = fakeStorage();
	setState({
		sessions: [session("gone"), session("kept")],
		pinnedSessions: ["gone"],
		sessionOrder: ["gone", "kept"],
	});
	writeSessionPreferences(prefs(["gone"], ["gone", "kept"]));
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ sessions: [session("kept")] }))) as typeof fetch;
	try {
		await refreshSessions();
	} finally {
		// biome-ignore lint/performance/noDelete: the test must not leave a stub behind.
		delete (globalThis as { fetch?: unknown }).fetch;
	}
	assert.deepEqual(getState().pinnedSessions, []);
	assert.deepEqual(getState().sessionOrder, ["kept"]);
	// The pruned arrangement reached storage, not only the store: a reload must not resurrect it.
	assert.deepEqual(JSON.parse(store.get("stepcode.sessionOrder") ?? "null"), ["kept"]);
	assert.deepEqual(JSON.parse(store.get("stepcode.pinnedSessions") ?? "null"), []);
});

test("deleting a session forgets its pin and its place, in storage too", () => {
	const store = fakeStorage();
	setState({
		sessions: [session("gone"), session("kept")],
		pinnedSessions: ["gone"],
		sessionOrder: ["gone", "kept"],
	});
	writeSessionPreferences(prefs(["gone"], ["gone", "kept"]));
	forgetDeletedSession("gone");
	assert.deepEqual(getState().pinnedSessions, []);
	assert.deepEqual(getState().sessionOrder, ["kept"]);
	assert.deepEqual(JSON.parse(store.get("stepcode.sessionOrder") ?? "null"), ["kept"]);
	assert.deepEqual(JSON.parse(store.get("stepcode.pinnedSessions") ?? "null"), []);
});
