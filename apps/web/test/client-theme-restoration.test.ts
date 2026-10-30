import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { STORAGE_KEYS } from "../client/src/lib/storage.ts";
import { createInitialState } from "../client/src/state/store.ts";

const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let choice: string | null = null;
before(() => {
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: { getItem: (key: string) => key === STORAGE_KEYS.theme ? choice : null },
	});
});
after(() => {
	if (previous) Object.defineProperty(globalThis, "localStorage", previous);
	else Reflect.deleteProperty(globalThis, "localStorage");
});

for (const theme of ["system", "light", "dark", "violet"] as const) {
	test(`initial state preserves the ${theme} theme for every feature`, () => {
		choice = theme;
		assert.equal(createInitialState().theme, theme);
	});
}
test("an absent or unrecognized theme keeps following the system", () => {
	for (const value of [null, "unexpected-theme", ""]) {
		choice = value;
		assert.equal(createInitialState().theme, "system");
	}
});
