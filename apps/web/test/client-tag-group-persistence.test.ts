import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createGroupAndTag, renameGroup, setSessionTag } from "../client/src/features/sidebar/actions.ts";
import { createInitialState, getState, setState } from "../client/src/state/store.ts";
import { forgetDeletedSession, refreshSessions, showError } from "../client/src/state/session.ts";
import { flushTagGroups, restoreTagGroups } from "../client/src/state/tag-group-persistence.ts";
import { parseTagGroupData, type StepcodeDesktopBridge, type TagGroupData } from "../client/src/platform/desktop-bridge.ts";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalFetch = globalThis.fetch;

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
	else Reflect.deleteProperty(globalThis, "window");
	if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
	else Reflect.deleteProperty(globalThis, "localStorage");
	setState(createInitialState());
});

function memoryStorage(): Map<string, string> {
	const values = new Map<string, string>();
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value),
		},
	});
	return values;
}

test("real group creation, rename and assignment survive initial state recreation", () => {
	const stored = memoryStorage();
	setState(createInitialState());
	createGroupAndTag("s1", "red", "Audit");
	renameGroup("red", "Work");
	setSessionTag("s2", "red");
	const restored = createInitialState();
	assert.deepEqual(restored.groups, [{ key: "red", name: "Work" }]);
	assert.deepEqual([...restored.tags], [["s1", "red"], ["s2", "red"]]);
	assert.ok(stored.size > 0, "mutations must save without an unload event");
});

test("group failures survive ordinary toast expiry and unrelated restore success", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	bridge({ saveTagGroups: async () => { throw new Error("durable disk failure"); } });
	await restoreTagGroups();
	renameGroup("blue", "Unsaved");
	await assert.rejects(flushTagGroups());
	showError("ordinary notice");
	context.mock.timers.tick(4199);
	assert.equal(getState().toast?.message, "ordinary notice");
	context.mock.timers.tick(1);
	assert.equal(getState().toast, null);
	assert.match(getState().tagGroupsSaveError ?? "", /durable disk failure/);
	await restoreTagGroups();
	assert.match(getState().tagGroupsSaveError ?? "", /durable disk failure/);
});

const saved: TagGroupData = { version: 1, groups: [{ key: "blue", name: "Saved" }], tags: [["old", "blue"]] };
function bridge(overrides: Partial<StepcodeDesktopBridge> = {}): StepcodeDesktopBridge {
	const value: StepcodeDesktopBridge = {
		platform: "darwin", version: "test", pickDirectory: async () => null,
		openExternal: async () => {}, revealPath: async () => {}, defaultBrowser: async () => null,
		beginTagGroupClose: async () => null, completeTagGroupClose: async () => false,
		getTheme: async () => null, setTheme: async () => {},
		readTagGroups: async () => saved, saveTagGroups: async () => {}, ...overrides,
	};
	Object.defineProperty(globalThis, "window", { configurable: true, value: { stepcodeDesktop: value } });
	setState(createInitialState());
	return value;
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

test("Desktop publishes the list before slow recovery but prunes only after recovery", async () => {
	const read = deferred<TagGroupData | null>();
	const writes: TagGroupData[] = [];
	bridge({ readTagGroups: () => read.promise, saveTagGroups: async (data) => { writes.push(data); } });
	let fetched = false;
	globalThis.fetch = async () => { fetched = true; return new Response(JSON.stringify({ sessions: [{ id: "old", archived: true }] })); };
	const refresh = refreshSessions();
	assert.equal(fetched, true);
	await refresh;
	assert.equal(getState().sessions[0]?.id, "old", "boot must not wait for unrelated group recovery");
	assert.deepEqual(writes, [], "pending recovery cannot prune");
	read.resolve(saved);
	await refresh;
	await flushTagGroups();
	assert.deepEqual(getState().groups, saved.groups);
	assert.deepEqual([...getState().tags], saved.tags);
	assert.deepEqual(writes, [], "unchanged archived-session groups must not be rewritten");
});

test("latest successful session list gates late recovery prune; older answers cannot restore deleted membership", async () => {
	const read = deferred<TagGroupData | null>();
	const first = deferred<Response>();
	const second = deferred<Response>();
	const writes: TagGroupData[] = [];
	bridge({ readTagGroups: () => read.promise, saveTagGroups: async (data) => { writes.push(data); } });
	let calls = 0;
	globalThis.fetch = () => ++calls === 1 ? first.promise : second.promise;
	const stale = refreshSessions();
	const latest = refreshSessions();
	second.resolve(new Response(JSON.stringify({ sessions: [{ id: "newest" }] })));
	await latest;
	first.resolve(new Response(JSON.stringify({ sessions: [{ id: "old" }] })));
	await stale;
	assert.equal(getState().sessions[0]?.id, "newest");
	read.resolve(saved);
	await restoreTagGroups();
	await flushTagGroups();
	assert.deepEqual(writes.at(-1), { version: 1, groups: [], tags: [] });
	assert.equal(getState().tags.has("old"), false, "late stale list must not retain the deleted tag");
});

test("in-flight list pruning retains assignments needed by a newer list or current selection", async () => {
	for (const changed of ["list", "selection"] as const) {
		const acknowledgement = deferred<void>();
		const started = deferred<void>();
		const writes: TagGroupData[] = [];
		bridge({ saveTagGroups: async (data) => {
			writes.push(data);
			if (writes.length === 1) {
				started.resolve();
				await acknowledgement.promise;
			}
		} });
		await restoreTagGroups();
		globalThis.fetch = async () => new Response(JSON.stringify({ sessions: [] }));
		await refreshSessions();
		await started.promise;
		if (changed === "list") {
			globalThis.fetch = async () => new Response(JSON.stringify({ sessions: [{ id: "old" }] }));
			await refreshSessions();
		} else {
			setState({ current: { id: "old", cwd: "/fixture", status: "idle", entries: [] } });
		}
		acknowledgement.resolve();
		await flushTagGroups();
		assert.deepEqual(writes.at(-1), saved, `${changed} must correct an outdated pruning snapshot`);
		assert.deepEqual([...getState().tags], saved.tags);
		assert.deepEqual(getState().groups, saved.groups);
	}
});

test("selection made while recovery is pending remains in the prune projection", async () => {
	const read = deferred<TagGroupData | null>();
	const writes: TagGroupData[] = [];
	bridge({ readTagGroups: () => read.promise, saveTagGroups: async (data) => { writes.push(data); } });
	globalThis.fetch = async () => new Response(JSON.stringify({ sessions: [] }));
	await refreshSessions();
	setState({ current: { id: "old", cwd: "/fixture", status: "idle", entries: [] }, currentFilter: "blue" });
	read.resolve(saved);
	await restoreTagGroups();
	await flushTagGroups();
	assert.deepEqual(writes, [], "current session counts even if latest successful list omits it");
	assert.deepEqual([...getState().tags], saved.tags);
	assert.equal(getState().currentFilter, "blue");
});

test("failed list during pending recovery cannot delete saved membership", async () => {
	const read = deferred<TagGroupData | null>();
	const writes: TagGroupData[] = [];
	bridge({ readTagGroups: () => read.promise, saveTagGroups: async (data) => { writes.push(data); } });
	globalThis.fetch = async () => new Response("unavailable", { status: 500 });
	await assert.rejects(refreshSessions());
	read.resolve(saved);
	await restoreTagGroups();
	await flushTagGroups();
	assert.deepEqual(writes, []);
	assert.deepEqual(getState().groups, saved.groups);
	assert.deepEqual([...getState().tags], saved.tags);
});

test("edits made during recovery replay over disk data without clobbering untouched groups", async () => {
	const read = deferred<TagGroupData | null>();
	const writes: TagGroupData[] = [];
	bridge({ readTagGroups: () => read.promise, saveTagGroups: async (data) => { writes.push(data); } });
	const loading = restoreTagGroups();
	createGroupAndTag("new", "red", "Draft");
	renameGroup("red", "Edited");
	read.resolve(saved);
	await loading;
	await flushTagGroups();
	assert.deepEqual(writes.at(-1)?.groups, [...saved.groups, { key: "red", name: "Edited" }]);
	assert.equal(getState().tags.get("old"), "blue");
});

test("failed recovery never writes empty data; a later refresh retries and replays edits", async () => {
	let failed = true;
	const writes: TagGroupData[] = [];
	bridge({ readTagGroups: async () => { if (failed) throw new Error("read denied"); return saved; },
		saveTagGroups: async (data) => { writes.push(data); } });
	createGroupAndTag("new", "red", "New");
	assert.equal(await restoreTagGroups(), false);
	assert.match(getState().toast?.message ?? "", /read denied/);
	globalThis.fetch = async () => new Response(JSON.stringify({ sessions: [{ id: "old" }, { id: "new" }] }));
	await refreshSessions();
	assert.equal(writes.length, 0);
	failed = false;
	await refreshSessions();
	await flushTagGroups();
	assert.equal(writes.at(-1)?.groups.length, 2);
});

test("successful deletion and full-list pruning persist, failed list requests do not prune", async () => {
	const writes: TagGroupData[] = [];
	bridge({ saveTagGroups: async (data) => { writes.push(data); } });
	await restoreTagGroups();
	globalThis.fetch = async () => new Response("unavailable", { status: 500 });
	await assert.rejects(refreshSessions());
	assert.equal(getState().tags.get("old"), "blue");
	assert.equal(writes.length, 0);
	forgetDeletedSession("old");
	await flushTagGroups();
	assert.deepEqual(writes.at(-1), { version: 1, groups: [], tags: [] });
	createGroupAndTag("gone", "purple", "Gone");
	await flushTagGroups();
	assert.equal(writes.at(-1)?.tags.some(([id]) => id === "gone"), true);
	globalThis.fetch = async () => new Response(JSON.stringify({ sessions: [] }));
	await refreshSessions();
	await flushTagGroups();
	assert.deepEqual(writes.at(-1), { version: 1, groups: [], tags: [] });
});

test("desktop snapshots are ordered, save failures are visible, and newer saves can recover", async () => {
	const firstWrite = deferred<void>();
	const writes: TagGroupData[] = [];
	let fail = false;
	bridge({ saveTagGroups: async (data) => {
		writes.push(data);
		if (writes.length === 1) await firstWrite.promise;
		if (fail) throw new Error("disk full");
	} });
	await restoreTagGroups();
	renameGroup("blue", "First");
	renameGroup("blue", "Last");
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(writes.length, 1, "second invoke must wait for first acknowledgement");
	firstWrite.resolve();
	await flushTagGroups();
	assert.deepEqual(writes.map((data) => data.groups[0]?.name), ["First", "Last"]);
	fail = true;
	renameGroup("blue", "Failed");
	await assert.rejects(flushTagGroups(), /disk full/);
	assert.match(getState().toast?.message ?? "", /disk full/);
	fail = false;
	renameGroup("blue", "Recovered");
	await flushTagGroups();
	assert.equal(writes.at(-1)?.groups[0]?.name, "Recovered");
});

test("browser reload retains removal of the last member and frees its colour", () => {
	memoryStorage();
	setState(createInitialState());
	createGroupAndTag("s1", "red", "One");
	setSessionTag("s1", null);
	assert.deepEqual(createInitialState().groups, []);
	assert.equal(createInitialState().tags.size, 0);
	createGroupAndTag("s2", "red", "Two");
	assert.deepEqual(createInitialState().groups, [{ key: "red", name: "Two" }]);
});

test("persisted and IPC data reject corrupt, duplicate, oversized and orphaned assignments", () => {
	for (const raw of [null, {}, { ...saved, version: 2 }, { ...saved, groups: [...saved.groups, ...saved.groups] },
		{ ...saved, tags: [["s", "red"]] }, { ...saved, tags: [...saved.tags, ...saved.tags] },
		{ ...saved, tags: [["x".repeat(257), "blue"]] }, { ...saved, groups: [{ key: "blue", name: "x".repeat(201) }] },
		{ ...saved, tags: [] }, { ...saved, groups: [...saved.groups, { key: "red", name: "sAvEd" }], tags: [...saved.tags, ["new", "red"]] },
		{ ...saved, tags: Array.from({ length: 10001 }, (_, index) => [String(index), "blue"]) }]) {
		assert.throws(() => parseTagGroupData(raw));
	}
	const stored = memoryStorage();
	stored.set("stepcode.tagGroups", "{broken");
	assert.deepEqual(createInitialState().groups, []);
	assert.equal(stored.get("stepcode.tagGroups"), "{broken");
});

test("early create rejects restored colour and case-insensitive name collisions, then accepts valid edits", async () => {
	for (const [color, name] of [["blue", "Replacement"], ["red", "sAvEd"]] as const) {
		const read = deferred<TagGroupData | null>();
		const writes: TagGroupData[] = [];
		bridge({ readTagGroups: () => read.promise, saveTagGroups: async (data) => { writes.push(data); } });
		createGroupAndTag("new", color, name);
		read.resolve(saved);
		await restoreTagGroups();
		await assert.rejects(flushTagGroups());
		assert.deepEqual(getState().groups, saved.groups);
		assert.deepEqual([...getState().tags], saved.tags);
		assert.ok(getState().toast?.message);
		assert.equal(writes.length, 0);
		createGroupAndTag("new", "red", "Valid");
		await flushTagGroups();
		assert.equal(getState().tags.get("old"), "blue");
		assert.equal(getState().tags.get("new"), "red");
	}
});

test("Desktop publishes only acknowledged state and preserves unrelated UI changes during save", async () => {
	const acknowledgement = deferred<void>();
	bridge({ saveTagGroups: () => acknowledgement.promise });
	await restoreTagGroups();
	renameGroup("blue", "Confirmed");
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(getState().groups, saved.groups);
	setState({ currentFilter: "blue", showArchived: true });
	acknowledgement.resolve();
	await flushTagGroups();
	assert.equal(getState().groups[0]?.name, "Confirmed");
	assert.equal(getState().currentFilter, "blue");
	assert.equal(getState().showArchived, true);
});

test("Desktop save and validation rejection leave confirmed state unchanged", async () => {
	bridge({ saveTagGroups: async () => { throw new Error("disk full"); } });
	await restoreTagGroups();
	renameGroup("blue", "Failed");
	await assert.rejects(flushTagGroups(), /disk full/);
	assert.deepEqual(getState().groups, saved.groups);
	renameGroup("blue", "x".repeat(201));
	await assert.rejects(flushTagGroups());
	assert.deepEqual(getState().groups, saved.groups);
});

test("Desktop no-op refresh cannot hide a rejected write; only a newer full write recovers", async () => {
	let failed = true;
	let writes = 0;
	bridge({ saveTagGroups: async () => { writes++; if (failed) throw new Error("disk full"); } });
	await restoreTagGroups();
	renameGroup("blue", "Failed");
	await assert.rejects(flushTagGroups(), /disk full/);
	failed = false;
	globalThis.fetch = async () => new Response(JSON.stringify({ sessions: [{ id: "old" }] }));
	await refreshSessions();
	await assert.rejects(flushTagGroups(), /disk full/);
	assert.match(getState().tagGroupsSaveError ?? "", /disk full/);
	assert.equal(writes, 1, "unchanged refresh must not write or acknowledge the earlier failure");
	renameGroup("blue", "Recovered");
	await flushTagGroups();
	assert.equal(getState().tagGroupsSaveError, null);
	assert.equal(writes, 2);
});

test("restoring changed browser groups reconciles the filter even when the session request fails", async () => {
	const stored = memoryStorage();
	stored.set("stepcode.tagGroups", JSON.stringify(saved));
	setState(createInitialState());
	setState({ currentFilter: "blue", showArchived: true });
	stored.set("stepcode.tagGroups", JSON.stringify({ version: 1, groups: [], tags: [] }));
	globalThis.fetch = async () => new Response("unavailable", { status: 500 });
	await assert.rejects(refreshSessions());
	assert.deepEqual(getState().groups, []);
	assert.equal(getState().currentFilter, null);
	assert.equal(getState().showArchived, true);
});

test("restoration keeps a valid group filter while replacing group metadata", async () => {
	const stored = memoryStorage();
	stored.set("stepcode.tagGroups", JSON.stringify(saved));
	setState(createInitialState());
	setState({ currentFilter: "blue" });
	stored.set("stepcode.tagGroups", JSON.stringify({ ...saved, groups: [{ key: "blue", name: "Updated" }] }));
	await restoreTagGroups();
	assert.equal(getState().currentFilter, "blue");
	assert.equal(getState().groups[0]?.name, "Updated");
});

test("Web corrupt recovery followed by real refresh preserves raw storage and reports failure", async () => {
	const stored = memoryStorage();
	stored.set("stepcode.tagGroups", "{broken");
	setState(createInitialState());
	globalThis.fetch = async () => new Response(JSON.stringify({ sessions: [] }));
	await refreshSessions();
	assert.equal(stored.get("stepcode.tagGroups"), "{broken");
	assert.ok(getState().toast?.message);
	await assert.rejects(flushTagGroups());
	createGroupAndTag("new", "red", "Unsafe");
	assert.equal(stored.get("stepcode.tagGroups"), "{broken");
	assert.deepEqual(getState().groups, []);
	stored.set("stepcode.tagGroups", JSON.stringify(saved));
	globalThis.fetch = async () => new Response(JSON.stringify({ sessions: [{ id: "old" }] }));
	await refreshSessions();
	await flushTagGroups();
	assert.deepEqual(getState().groups, saved.groups);
	assert.deepEqual([...getState().tags], saved.tags);
});

test("Web unchanged list refresh does not write, and unavailable storage cannot publish success", async () => {
	const stored = memoryStorage();
	stored.set("stepcode.tagGroups", JSON.stringify(saved));
	let writes = 0;
	Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
		getItem: (key: string) => stored.get(key) ?? null,
		setItem: () => { writes++; },
	} });
	setState(createInitialState());
	globalThis.fetch = async () => new Response(JSON.stringify({ sessions: [{ id: "old" }] }));
	await refreshSessions();
	await flushTagGroups();
	assert.equal(writes, 0);
	Reflect.deleteProperty(globalThis, "localStorage");
	renameGroup("blue", "Unsaved");
	assert.deepEqual(getState().groups, saved.groups);
	await assert.rejects(flushTagGroups());
});

test("Web write failure and invalid edits preserve confirmed state; a valid write recovers", async () => {
	const stored = memoryStorage();
	setState(createInitialState());
	createGroupAndTag("s1", "blue", "Saved");
	const confirmed = stored.get("stepcode.tagGroups");
	Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
		getItem: (key: string) => stored.get(key) ?? null,
		setItem: () => { throw new Error("quota exceeded"); },
	} });
	renameGroup("blue", "Failed");
	assert.deepEqual(getState().groups, saved.groups);
	assert.match(getState().toast?.message ?? "", /quota exceeded/);
	await assert.rejects(flushTagGroups(), /quota exceeded/);
	assert.equal(stored.get("stepcode.tagGroups"), confirmed);
	memoryStorage().set("stepcode.tagGroups", confirmed!);
	for (const name of ["x".repeat(201), " "]) {
		renameGroup("blue", name);
		await assert.rejects(flushTagGroups());
		assert.deepEqual(getState().groups, saved.groups);
		createGroupAndTag("invalid", "red", name);
		await assert.rejects(flushTagGroups());
		assert.deepEqual(getState().groups, saved.groups);
	}
	createGroupAndTag("duplicate", "red", "sAvEd");
	await assert.rejects(flushTagGroups());
	assert.deepEqual(getState().groups, saved.groups);
	createGroupAndTag("s2", "red", "Other");
	renameGroup("red", "sAvEd");
	await assert.rejects(flushTagGroups());
	assert.equal(getState().groups[1]?.name, "Other");
	renameGroup("red", "Recovered");
	await flushTagGroups();
	assert.equal(getState().groups[1]?.name, "Recovered");
});
