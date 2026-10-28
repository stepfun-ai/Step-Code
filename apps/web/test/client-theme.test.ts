import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { applyTheme, restoreDesktopTheme } from "../client/src/features/shell/actions.ts";
import { t } from "../client/src/i18n/index.ts";
import { STORAGE_KEYS } from "../client/src/lib/storage.ts";
import type { DesktopThemeChoice, StepcodeDesktopBridge } from "../client/src/platform/desktop-bridge.ts";
import { createInitialState, getState, setState } from "../client/src/state/store.ts";

const globals = ["window", "document", "localStorage"] as const;
let descriptors: Array<PropertyDescriptor | undefined>;
let storage: Map<string, string>;
let dataset: Record<string, string>;

beforeEach(() => {
	descriptors = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
	storage = new Map();
	dataset = {};
	Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
	Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { dataset } } });
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
		},
	});
	mock.timers.enable({ apis: ["setTimeout"] });
	setState(createInitialState());
});

afterEach(() => {
	mock.timers.reset();
	globals.forEach((name, index) => {
		const descriptor = descriptors[index];
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	});
	setState(createInitialState());
});

function bridge(saved: DesktopThemeChoice | null, writes: DesktopThemeChoice[] = []): StepcodeDesktopBridge {
	return {
		platform: "darwin",
		version: "test",
		getTheme: async () => saved,
		setTheme: async (theme) => { writes.push(theme); },
		pickDirectory: async () => null,
		openExternal: async () => {},
		revealPath: async () => {},
		defaultBrowser: async () => null,
	};
}

function desktop(value: StepcodeDesktopBridge): void {
	Object.defineProperty(globalThis, "window", { configurable: true, value: { stepcodeDesktop: value } });
}

test("all browser theme choices survive initial state recreation, including violet", () => {
	for (const theme of ["system", "light", "dark", "violet"] as const) {
		applyTheme(theme);
		assert.equal(createInitialState().theme, theme);
	}
	storage.set(STORAGE_KEYS.theme, "invalid");
	assert.equal(createInitialState().theme, "system");
});

test("desktop writes the selection, not the resolved system color", async () => {
	const writes: DesktopThemeChoice[] = [];
	desktop(bridge(null, writes));
	applyTheme("system");
	applyTheme("violet");
	applyTheme("dark", false);
	await Promise.resolve();
	assert.deepEqual(writes, ["system", "violet"]);
	assert.equal(storage.get(STORAGE_KEYS.theme), "violet");
});

test("profile theme restores even when the new page origin has no local storage", async () => {
	desktop(bridge("violet"));
	await restoreDesktopTheme();
	assert.equal(getState().theme, "violet");
	assert.equal(dataset.theme, "violet");
	assert.equal(storage.get(STORAGE_KEYS.theme), "violet");
});

test("a saved profile wins over a stale local choice without another write", async () => {
	const writes: DesktopThemeChoice[] = [];
	storage.set(STORAGE_KEYS.theme, "dark");
	desktop(bridge("light", writes));
	await restoreDesktopTheme();
	assert.equal(getState().theme, "light");
	assert.deepEqual(writes, []);
});

test("only a valid legacy local choice migrates into an empty desktop profile", async () => {
	const writes: DesktopThemeChoice[] = [];
	desktop(bridge(null, writes));
	storage.set(STORAGE_KEYS.theme, "violet");
	await restoreDesktopTheme();
	assert.deepEqual(writes, ["violet"]);
	storage.set(STORAGE_KEYS.theme, "invalid");
	await restoreDesktopTheme();
	assert.deepEqual(writes, ["violet"]);
});

test("IPC restoration failures keep the current choice and show a notice", async () => {
	applyTheme("dark");
	desktop({ ...bridge(null), getTheme: async () => { throw new Error("unavailable"); } });
	await restoreDesktopTheme();
	assert.equal(getState().theme, "dark");
	assert.equal(getState().toast?.message, t("themeRestoreFailed"));
});

test("a rejected desktop save is visible without breaking the current appearance", async () => {
	desktop({ ...bridge(null), setTheme: async () => { throw new Error("read-only profile"); } });
	applyTheme("violet");
	await Promise.resolve();
	assert.equal(getState().theme, "violet");
	assert.equal(getState().toast?.message, t("themeSaveFailed"));
});

test("browser startup does not depend on a desktop bridge", async () => {
	applyTheme("violet");
	await restoreDesktopTheme();
	assert.equal(getState().theme, "violet");
	assert.equal(getState().toast, null);
});
