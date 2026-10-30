import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { TagGroupData } from "@step-harness/web/desktop-bridge";
import { DesktopStateStore } from "../src/state.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true }); });
function stateFile(): string {
	const directory = mkdtempSync(join(tmpdir(), "desktop-groups-"));
	directories.push(directory);
	return join(directory, "desktop-state.json");
}
const groups: TagGroupData = { version: 1, groups: [{ key: "teal", name: "Work" }], tags: [["session", "teal"]] };
const bounds = { x: 10, y: 20, width: 900, height: 700, maximized: true };

test("group metadata survives store reconstruction and window/workspace updates", () => {
	const path = stateFile();
	const store = new DesktopStateStore(path);
	assert.equal(store.readTagGroups(), null);
	store.update({ window: bounds, lastWorkspace: tmpdir() });
	store.saveTagGroups(groups);
	store.update({ window: { ...bounds, width: 1000 } });
	const reopened = new DesktopStateStore(path);
	assert.deepEqual(reopened.readTagGroups(), groups);
	assert.deepEqual(reopened.get().window, { ...bounds, width: 1000 });
	assert.equal(reopened.lastWorkspace(), tmpdir());
	reopened.saveTagGroups({ version: 1, groups: [], tags: [] });
	assert.deepEqual(new DesktopStateStore(path).readTagGroups(), { version: 1, groups: [], tags: [] });
});

test("accepted near-limit Unicode group data remains readable after an acknowledged profile save", () => {
	const path = stateFile();
	const store = new DesktopStateStore(path);
	const data: TagGroupData = {
		version: 1,
		groups: [{ key: "teal", name: "Large" }],
		tags: Array.from({ length: 10000 }, (_, index) => [`${index}${"中".repeat(132)}`, "teal"] as const),
	};
	assert.ok(Buffer.byteLength(JSON.stringify(data)) < 4 * 1024 * 1024);
	store.update({ theme: "violet", window: bounds, lastWorkspace: tmpdir() });
	store.saveTagGroups(data);
	const reopened = new DesktopStateStore(path);
	assert.deepEqual(reopened.readTagGroups(), data);
	assert.equal(reopened.theme(), "violet");
	assert.deepEqual(reopened.get().window, bounds);
});

test("legacy window-only files load without inventing group metadata", () => {
	const path = stateFile();
	writeFileSync(path, JSON.stringify({ window: bounds, lastWorkspace: tmpdir() }));
	const store = new DesktopStateStore(path);
	assert.equal(store.readTagGroups(), null);
	store.saveTagGroups(groups);
	assert.deepEqual(new DesktopStateStore(path).get().window, bounds);
});

test("corruption is reported and even window-close updates cannot wipe unreadable disk data", () => {
	const path = stateFile();
	for (const raw of ["{broken", "null", JSON.stringify({ window: bounds, tagGroups: { ...groups, tags: [] } })]) {
		writeFileSync(path, raw);
		const store = new DesktopStateStore(path);
		assert.throws(() => store.readTagGroups());
		assert.throws(() => store.saveTagGroups(groups));
		const warn = console.warn;
		try { console.warn = () => {}; store.update({ window: bounds }); }
		finally { console.warn = warn; }
		assert.equal(readFileSync(path, "utf8"), raw);
		writeFileSync(path, JSON.stringify({ tagGroups: groups, window: bounds }));
		assert.deepEqual(store.readTagGroups(), groups, "a repaired file can be retried in the same process");
	}
});

test("invalid groups retain independent window/workspace fields while blocking writes until repair", () => {
	const path = stateFile();
	const raw = JSON.stringify({ window: bounds, lastWorkspace: tmpdir(), tagGroups: { ...groups, tags: [] } });
	writeFileSync(path, raw);
	const store = new DesktopStateStore(path);
	assert.deepEqual(store.get().window, bounds);
	assert.equal(store.lastWorkspace(), tmpdir());
	assert.throws(() => store.readTagGroups());
	assert.throws(() => store.saveTagGroups(groups));
	assert.equal(readFileSync(path, "utf8"), raw);
	writeFileSync(path, JSON.stringify({ window: bounds, lastWorkspace: tmpdir(), tagGroups: groups }));
	assert.deepEqual(store.readTagGroups(), groups);
});

test("invalid IPC payloads cannot replace confirmed state", () => {
	const path = stateFile();
	const store = new DesktopStateStore(path);
	store.saveTagGroups(groups);
	for (const raw of [null, { ...groups, tags: [["session", "unknown"]] }, { ...groups, groups: [...groups.groups, ...groups.groups] }]) {
		assert.throws(() => store.saveTagGroups(raw));
		assert.deepEqual(new DesktopStateStore(path).readTagGroups(), groups);
	}
});

test("atomic replacement failure rejects and retains the last confirmed memory and disk state", () => {
	const path = stateFile();
	const store = new DesktopStateStore(path);
	store.saveTagGroups(groups);
	mkdirSync(`${path}.${process.pid}.tmp`);
	assert.throws(() => store.saveTagGroups({ version: 1, groups: [], tags: [] }));
	assert.deepEqual(store.readTagGroups(), groups);
	assert.deepEqual(new DesktopStateStore(path).readTagGroups(), groups);
});

test("independent preferences remain effective in memory when their disk write fails", () => {
	const path = stateFile();
	const store = new DesktopStateStore(path);
	const workspace = join(directories.at(-1)!, "chosen");
	mkdirSync(workspace);
	store.update({ window: bounds, lastWorkspace: tmpdir() });
	store.saveTagGroups(groups);
	const confirmedDisk = readFileSync(path, "utf8");
	mkdirSync(`${path}.${process.pid}.tmp`);
	const warn = console.warn;
	try {
		console.warn = () => {};
		store.update({ window: { ...bounds, width: 1200 }, lastWorkspace: workspace });
	} finally {
		console.warn = warn;
	}
	assert.equal(store.get().window?.width, 1200);
	assert.equal(store.lastWorkspace(), workspace);
	assert.deepEqual(store.readTagGroups(), groups);
	assert.equal(readFileSync(path, "utf8"), confirmedDisk);
});

test("repairing group data does not replace independent preferences updated while writes were blocked", () => {
	const path = stateFile();
	writeFileSync(path, JSON.stringify({ window: bounds, tagGroups: { ...groups, tags: [] } }));
	const store = new DesktopStateStore(path);
	const warn = console.warn;
	try {
		console.warn = () => {};
		store.update({ window: { ...bounds, width: 1200 }, lastWorkspace: tmpdir() });
	} finally {
		console.warn = warn;
	}
	assert.equal(store.get().window?.width, 1200);
	assert.throws(() => store.readTagGroups());
	writeFileSync(path, JSON.stringify({ window: bounds, tagGroups: groups }));
	assert.deepEqual(store.readTagGroups(), groups);
	assert.equal(store.get().window?.width, 1200);
	assert.equal(store.lastWorkspace(), tmpdir());
	store.saveTagGroups(groups);
	assert.equal(new DesktopStateStore(path).get().window?.width, 1200);
});

test("theme and group writes preserve each other with independent window preferences", () => {
	const path = stateFile();
	const store = new DesktopStateStore(path);
	assert.equal(store.update({ theme: "violet", window: bounds, lastWorkspace: tmpdir() }), true);
	store.saveTagGroups(groups);
	assert.equal(new DesktopStateStore(path).theme(), "violet");
	assert.equal(store.update({ theme: "system" }), true);
	assert.deepEqual(new DesktopStateStore(path).readTagGroups(), groups);
	store.saveTagGroups({ ...groups, groups: [{ key: "teal", name: "Renamed" }] });
	const reopened = new DesktopStateStore(path);
	assert.equal(reopened.theme(), "system");
	assert.equal(reopened.readTagGroups()?.groups[0]?.name, "Renamed");
	assert.deepEqual(reopened.get().window, bounds);
	assert.equal(reopened.lastWorkspace(), tmpdir());
});

test("group corruption retains saved theme and all independent edits through full recovery", () => {
	const path = stateFile();
	const raw = JSON.stringify({ theme: "violet", window: bounds, tagGroups: { ...groups, tags: [] } });
	writeFileSync(path, raw);
	const store = new DesktopStateStore(path);
	assert.equal(store.theme(), "violet");
	assert.equal(store.update({ theme: "dark", window: { ...bounds, width: 1200 }, lastWorkspace: tmpdir() }), false);
	assert.throws(() => store.readTagGroups());
	assert.equal(store.theme(), "dark", "a retry cannot replace a current independent preference");
	assert.equal(readFileSync(path, "utf8"), raw);
	writeFileSync(path, JSON.stringify({ theme: "light", window: bounds, tagGroups: groups }));
	assert.deepEqual(store.readTagGroups(), groups);
	assert.equal(store.theme(), "dark");
	store.saveTagGroups(groups);
	const reopened = new DesktopStateStore(path);
	assert.equal(reopened.theme(), "dark");
	assert.deepEqual(reopened.get().window, { ...bounds, width: 1200 });
	assert.equal(reopened.lastWorkspace(), tmpdir());
});

test("whole-profile corruption blocks theme and group writes until an explicit complete reread", () => {
	const path = stateFile();
	writeFileSync(path, "{broken");
	const store = new DesktopStateStore(path);
	assert.throws(() => store.theme(), /Could not read desktop theme/);
	assert.equal(store.update({ window: { ...bounds, width: 1200 } }), false);
	const repaired = JSON.stringify({ theme: "violet", window: bounds, lastWorkspace: tmpdir(), tagGroups: groups });
	writeFileSync(path, repaired);
	assert.equal(store.update({ lastWorkspace: tmpdir() }), false);
	assert.throws(() => store.saveTagGroups(groups));
	assert.equal(readFileSync(path, "utf8"), repaired, "repair alone cannot make an incomplete cache safe to write");
	assert.deepEqual(store.readTagGroups(), groups);
	assert.equal(store.theme(), "violet", "complete reload must restore the previously unreadable theme");
	assert.equal(store.update({ theme: "system" }), true);
	const reopened = new DesktopStateStore(path);
	assert.deepEqual(reopened.readTagGroups(), groups);
	assert.equal(reopened.theme(), "system");
	assert.equal(reopened.get().window?.width, 1200);
});

test("failed theme write remains in memory and a later group save preserves it", (context) => {
	const path = stateFile();
	const store = new DesktopStateStore(path);
	store.update({ theme: "violet", window: bounds });
	store.saveTagGroups(groups);
	const original = readFileSync(path, "utf8");
	const temporary = `${path}.${process.pid}.tmp`;
	mkdirSync(temporary);
	context.mock.method(console, "warn", () => {});
	assert.equal(store.update({ theme: "dark" }), false);
	assert.equal(store.theme(), "dark");
	assert.deepEqual(store.readTagGroups(), groups);
	assert.equal(readFileSync(path, "utf8"), original);
	rmSync(temporary, { recursive: true });
	store.saveTagGroups({ ...groups, groups: [{ key: "teal", name: "Recovered" }] });
	const reopened = new DesktopStateStore(path);
	assert.equal(reopened.theme(), "dark");
	assert.equal(reopened.readTagGroups()?.groups[0]?.name, "Recovered");
	assert.deepEqual(reopened.get().window, bounds);
});

test("normal process close immediately after a confirmed save leaves a complete stable snapshot", () => {
	const path = stateFile();
	const source = new URL("../src/state.ts", import.meta.url).href;
	execFileSync(process.execPath, ["--input-type=module", "-e", `
		import { DesktopStateStore } from ${JSON.stringify(source)};
		const store = new DesktopStateStore(${JSON.stringify(path)});
		store.update({ window: ${JSON.stringify(bounds)}, lastWorkspace: ${JSON.stringify(tmpdir())} });
		store.saveTagGroups(${JSON.stringify(groups)});
		process.exit(0);
	`]);
	const reopened = new DesktopStateStore(path);
	assert.deepEqual(reopened.readTagGroups(), groups);
	assert.deepEqual(reopened.get().window, bounds);
});
