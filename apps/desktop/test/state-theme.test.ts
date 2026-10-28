import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DesktopStateStore, isDesktopThemeChoice } from "../src/state.ts";

for (const theme of ["system", "light", "dark", "violet"] as const) {
	test(`profile restores ${theme} after reopening the state store`, () => {
		const directory = mkdtempSync(join(tmpdir(), "stepcode-theme-"));
		try {
			const path = join(directory, "desktop-state.json");
			const store = new DesktopStateStore(path);
			assert.equal(store.update({ lastWorkspace: directory, theme }), true);
			assert.equal(new DesktopStateStore(path).theme(), theme);
			assert.equal(new DesktopStateStore(path).lastWorkspace(), directory);
			assert.equal(JSON.parse(readFileSync(path, "utf8")).theme, theme);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
}

test("invalid persisted choices are ignored without losing other profile state", () => {
	const directory = mkdtempSync(join(tmpdir(), "stepcode-theme-"));
	try {
		const path = join(directory, "desktop-state.json");
		writeFileSync(path, JSON.stringify({ theme: "invalid", lastWorkspace: directory }));
		const store = new DesktopStateStore(path);
		assert.equal(store.theme(), null);
		assert.equal(store.lastWorkspace(), directory);
		for (const value of [null, undefined, {}, 1, "invalid", "DARK"]) {
			assert.equal(isDesktopThemeChoice(value), false);
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("missing profiles are empty, but unreadable and malformed files reject theme restoration", () => {
	const directory = mkdtempSync(join(tmpdir(), "stepcode-theme-"));
	try {
		const path = join(directory, "desktop-state.json");
		assert.equal(new DesktopStateStore(path).theme(), null);
		assert.throws(() => new DesktopStateStore(directory).theme(), /Could not read desktop theme/);
		for (const text of ["{broken", "null", "[]", ""]) {
			writeFileSync(path, text);
			const store = new DesktopStateStore(path);
			assert.throws(() => store.theme(), /Could not read desktop theme/);
			for (const patch of [
				{ window: { width: 900, height: 700, maximized: false } },
				{ lastWorkspace: directory },
				{ theme: "violet" as const },
			]) {
				assert.equal(store.update(patch), false);
				assert.equal(readFileSync(path, "utf8"), text, "a failed load must preserve the original file");
				assert.throws(() => store.theme(), /Could not read desktop theme/);
			}
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("unreadable profiles survive autosaves and recover only after a successful reload", (context) => {
	if (process.platform === "win32" || process.getuid?.() === 0) {
		context.skip("requires unprivileged POSIX file permissions");
		return;
	}
	const directory = mkdtempSync(join(tmpdir(), "stepcode-theme-"));
	const path = join(directory, "desktop-state.json");
	try {
		const window = { width: 1280, height: 840, maximized: true };
		const original = JSON.stringify({ window, lastWorkspace: directory, theme: "violet" });
		writeFileSync(path, original);
		chmodSync(path, 0);
		const store = new DesktopStateStore(path);
		assert.throws(() => store.theme(), /Could not read desktop theme/);
		assert.equal(store.update({ window: { ...window, width: 900 } }), false);
		chmodSync(path, 0o600);
		assert.equal(readFileSync(path, "utf8"), original);
		assert.equal(store.update({ lastWorkspace: "/another-workspace" }), false);
		assert.equal(store.update({ theme: "dark" }), false);
		assert.equal(readFileSync(path, "utf8"), original, "restored permissions do not make an empty cache safe to save");

		const reopened = new DesktopStateStore(path);
		assert.equal(reopened.theme(), "violet");
		assert.equal(reopened.lastWorkspace(), directory);
		assert.deepEqual(reopened.get().window, window);
		assert.equal(reopened.update({ theme: "dark" }), true);
		const saved = new DesktopStateStore(path);
		assert.equal(saved.theme(), "dark");
		assert.equal(saved.lastWorkspace(), directory);
		assert.deepEqual(saved.get().window, window);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a write failure after successful loading preserves disk state and allows a later retry", (context) => {
	const directory = mkdtempSync(join(tmpdir(), "stepcode-theme-"));
	try {
		const warning = context.mock.method(console, "warn", () => {});
		const path = join(directory, "desktop-state.json");
		const window = { width: 1280, height: 840, maximized: true };
		const original = JSON.stringify({ window, lastWorkspace: directory, theme: "violet" });
		writeFileSync(path, original);
		const store = new DesktopStateStore(path);
		assert.equal(store.theme(), "violet");

		// Block creation of the writer's temporary file, without preventing profile loading.
		const temporary = `${path}.${process.pid}.tmp`;
		mkdirSync(temporary);
		assert.equal(store.update({ theme: "dark" }), false);
		assert.equal(warning.mock.callCount(), 1);
		assert.equal(store.theme(), "dark", "the current choice remains usable in memory");
		assert.equal(readFileSync(path, "utf8"), original);

		rmSync(temporary, { recursive: true });
		assert.equal(store.update({ window: { ...window, width: 900 } }), true);
		const saved = new DesktopStateStore(path);
		assert.equal(saved.theme(), "dark");
		assert.equal(saved.lastWorkspace(), directory);
		assert.deepEqual(saved.get().window, { ...window, width: 900 });
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
