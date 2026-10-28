import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
		for (const text of ["{broken", "null", "[]"]) {
			writeFileSync(path, text);
			const store = new DesktopStateStore(path);
			assert.throws(() => store.theme(), /Could not read desktop theme/);
			assert.equal(store.update({ lastWorkspace: directory }), true);
			assert.throws(() => store.theme(), /Could not read desktop theme/, "other writes must not hide the failure");
			assert.equal(store.update({ theme: "violet" }), true);
			assert.equal(store.theme(), "violet", "explicit successful selection repairs the profile");
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a failed state write cannot be reported as a successful save", (context) => {
	const directory = mkdtempSync(join(tmpdir(), "stepcode-theme-"));
	try {
		context.mock.method(console, "warn", () => {});
		const store = new DesktopStateStore(directory);
		assert.equal(store.update({ theme: "dark" }), false);
		assert.equal(store.get().theme, "dark", "the current choice remains usable in memory");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
