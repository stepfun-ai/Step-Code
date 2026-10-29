import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as persistence from "../client/src/state/tag-group-persistence.ts";
import { watchTagGroupUnload } from "../client/src/features/shell/ShellEffects.tsx";
let beforeUnload: ((event: Pick<BeforeUnloadEvent, "preventDefault" | "returnValue">) => void) | undefined;
let stopWatching: (() => void) | undefined;
import { createGroupAndTag, renameGroup } from "../client/src/features/sidebar/actions.ts";
import { createInitialState, getState, setState } from "../client/src/state/store.ts";
import type { StepcodeDesktopBridge, TagGroupData } from "../client/src/platform/desktop-bridge.ts";

const original = Object.getOwnPropertyDescriptor(globalThis, "window");
afterEach(() => {
	stopWatching?.();
	assert.equal(beforeUnload, undefined, "shell teardown removes the exact unload listener");
	if (original) Object.defineProperty(globalThis, "window", original);
	else Reflect.deleteProperty(globalThis, "window");
	setState(createInitialState());
});
const saved: TagGroupData = { version: 1, groups: [{ key: "blue", name: "Saved" }], tags: [["old", "blue"]] };
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}
function setup(overrides: Partial<StepcodeDesktopBridge> = {}) {
	const completed: unknown[] = [];
	const bridge: StepcodeDesktopBridge = {
		platform: "darwin", version: "test", pickDirectory: async () => null,
		openExternal: async () => {}, revealPath: async () => {}, defaultBrowser: async () => null,
		getTheme: async () => null, setTheme: async () => {},
		readTagGroups: async () => saved, saveTagGroups: async () => {},
		beginTagGroupClose: async () => ({ attemptId: "attempt", expiresAt: Date.now() + 10000 }),
		completeTagGroupClose: async (id, outcome) => { completed.push([id, outcome]); return true; },
		...overrides,
	};
	Object.defineProperty(globalThis, "window", { configurable: true, value: {
		stepcodeDesktop: bridge,
		addEventListener: (name: string, listener: typeof beforeUnload) => { assert.equal(name, "beforeunload"); beforeUnload = listener; },
		removeEventListener: (name: string, listener: typeof beforeUnload) => { assert.equal(name, "beforeunload"); assert.equal(listener, beforeUnload); beforeUnload = undefined; },
	} });
	stopWatching = watchTagGroupUnload();
	setState(createInitialState());
	return { completed };
}
function unload() {
	let veto = false;
	const event = { preventDefault: () => { veto = true; }, returnValue: "" };
	assert.ok(beforeUnload, "the actual shell-owned listener must be installed");
	beforeUnload(event);
	return veto;
}

test("beforeunload clean page never starts group loading or IPC", () => {
	let reads = 0;
	setup({ readTagGroups: async () => { reads++; return saved; }, beginTagGroupClose: async () => { throw new Error("unexpected invoke"); } });
	assert.equal(unload(), false);
	assert.equal(reads, 0);
});

test("beforeunload drains pending read and ordered writes, freezes edits, then completes exactly once", async () => {
	const read = deferred<TagGroupData | null>();
	const ack = deferred<void>();
	const started = deferred<void>();
	const writes: TagGroupData[] = [];
	const { completed } = setup({ readTagGroups: () => read.promise,
		saveTagGroups: async (data) => { writes.push(data); started.resolve(); await ack.promise; } });
	createGroupAndTag("new", "red", "New");
	assert.equal(unload(), true);
	assert.equal(unload(), true);
	renameGroup("red", "Must not enter frozen queue");
	read.resolve(saved);
	await started.promise;
	assert.equal(completed.length, 0);
	ack.resolve();
	await persistence.waitForTagGroupClose();
	assert.equal(writes.length, 1);
	assert.equal(writes[0]?.groups[1]?.name, "New");
	assert.deepEqual(completed, [["attempt", "saved"]]);
	renameGroup("red", "Edit in scheduled-unload gap");
	await persistence.flushTagGroups();
	assert.equal(writes.length, 1, "completion must not unfreeze edits before the scheduled native unload");
	assert.equal(unload(), false);
});

test("save failure cancels close, preserves earlier failed operation in subsequent full edit", async () => {
	let fail = true;
	const writes: TagGroupData[] = [];
	const { completed } = setup({ saveTagGroups: async (data) => { writes.push(data); if (fail) throw new Error("disk full"); } });
	await persistence.restoreTagGroups();
	createGroupAndTag("new", "red", "Retained");
	await assert.rejects(persistence.flushTagGroups(), /disk full/);
	assert.equal(unload(), true);
	await persistence.waitForTagGroupClose();
	assert.deepEqual(completed, [["attempt", "failed"]]);
	assert.deepEqual(getState().groups, saved.groups);
	fail = false;
	renameGroup("blue", "Later edit");
	await persistence.flushTagGroups();
	assert.equal(writes.at(-1)?.tags.some(([id]) => id === "new"), true, "new edit cannot erase failed creation");
	assert.equal(getState().groups[1]?.name, "Retained");
	assert.equal(unload(), false);
});

test("rejected validation is unaccepted and cannot trap a later clean close", async () => {
	setup();
	await persistence.restoreTagGroups();
	createGroupAndTag("new", "blue", "Collision");
	await assert.rejects(persistence.flushTagGroups());
	assert.equal(unload(), false);
});

test("close timeout unfreezes edits, retry joins in-flight save, late acknowledgement cannot use expired token", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const ack = deferred<void>();
	const started = deferred<void>();
	const claimed = deferred<void>();
	let count = 0;
	let begins = 0;
	const completed: unknown[] = [];
	setup({ saveTagGroups: async () => { count++; started.resolve(); await ack.promise; },
		beginTagGroupClose: async () => { begins++; claimed.resolve(); return { attemptId: String(begins), expiresAt: Date.now() + 10000 }; },
		completeTagGroupClose: async (id, result) => { completed.push([id, result]); return id !== "1"; } });
	await persistence.restoreTagGroups();
	renameGroup("blue", "Delayed");
	await started.promise;
	assert.equal(unload(), true);
	await claimed.promise;
	// Cross the promise turn so the drain's bounded waiter is installed before advancing its clock.
	await new Promise<void>((resolve) => setImmediate(resolve));
	context.mock.timers.tick(10000);
	await persistence.waitForTagGroupClose();
	assert.deepEqual(completed, [["1", "failed"]]);
	assert.equal(unload(), true);
	ack.resolve();
	await persistence.waitForTagGroupClose();
	assert.equal(count, 1, "retry joins the outstanding invoke");
	assert.deepEqual(completed, [["1", "failed"], ["2", "saved"]]);
});

test("a second close joins a retained-failure retry already in flight", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const ack = deferred<void>();
	const retryStarted = deferred<void>();
	let writes = 0;
	let begins = 0;
	setup({
		saveTagGroups: async () => {
			writes++;
			if (writes === 1) throw new Error("first write failed");
			retryStarted.resolve();
			await ack.promise;
		},
		beginTagGroupClose: async () => ({ attemptId: String(++begins), expiresAt: Date.now() + 10000 }),
	});
	await persistence.restoreTagGroups();
	renameGroup("blue", "Retained");
	await assert.rejects(persistence.flushTagGroups());
	assert.equal(unload(), true);
	await retryStarted.promise;
	await new Promise<void>((resolve) => setImmediate(resolve));
	context.mock.timers.tick(10000);
	await persistence.waitForTagGroupClose();
	assert.equal(unload(), true);
	ack.resolve();
	await persistence.waitForTagGroupClose();
	assert.equal(writes, 2, "timed-out retry must stay joinable without a duplicate side effect");
});

test("timed-out group read ignores late recovery and a later read can retry", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	const read = deferred<TagGroupData | null>();
	let reads = 0;
	setup({ readTagGroups: () => ++reads === 1 ? read.promise : Promise.resolve(saved) });
	const loading = persistence.restoreTagGroups();
	context.mock.timers.tick(10000);
	assert.equal(await loading, false);
	read.resolve(saved);
	await read.promise;
	assert.deepEqual(getState().groups, [], "expired raw response must never commit");
	assert.ok(getState().tagGroupsLoadError);
	assert.equal(unload(), false, "load-only failure is clean");
	assert.equal(await persistence.restoreTagGroups(), true);
	assert.deepEqual(getState().groups, saved.groups);
	assert.equal(getState().tagGroupsLoadError, null);
});

test("reload has no native token, drains without closing and permits a later manual reload", async () => {
	const { completed } = setup({ beginTagGroupClose: async () => null });
	await persistence.restoreTagGroups();
	renameGroup("blue", "Reload saved");
	assert.equal(unload(), true);
	await persistence.waitForTagGroupClose();
	assert.deepEqual(completed, []);
	assert.equal(unload(), false);
	assert.equal(getState().groups[0]?.name, "Reload saved");
});
