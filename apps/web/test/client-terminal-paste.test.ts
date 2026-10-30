import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	pasteExceedsLimit,
	PASTE_LIMIT_BYTES,
	type TerminalKeyInput,
	terminalKeyAction,
} from "../client/src/features/terminal/input.ts";

function key(overrides: Partial<TerminalKeyInput> = {}): TerminalKeyInput {
	return {
		type: "keydown",
		key: "v",
		code: "KeyV",
		ctrlKey: false,
		metaKey: false,
		altKey: false,
		shiftKey: false,
		...overrides,
	};
}

test("the paste shortcut is handed to the browser instead of being cancelled", () => {
	// "forward" would be wrong: xterm maps Ctrl+V to ^V and cancels the event,
	// which also cancels the browser's native paste. "paste" means "do not cancel".
	assert.equal(terminalKeyAction(key({ metaKey: true }), false), "paste");
	assert.equal(terminalKeyAction(key({ ctrlKey: true }), false), "paste");
	assert.equal(terminalKeyAction(key({ ctrlKey: true, shiftKey: true }), false), "paste");
	assert.equal(terminalKeyAction(key({ key: "V", metaKey: true, shiftKey: true }), false), "paste");
	assert.equal(terminalKeyAction(key({ metaKey: true, altKey: true }), false), "forward");
	assert.equal(terminalKeyAction(key({ type: "keyup", metaKey: true }), false), "forward");
	assert.equal(terminalKeyAction(key(), false), "forward");
});

test("copy is intercepted only when it has a selection or the explicit shift chord", () => {
	assert.equal(terminalKeyAction(key({ key: "c", code: "KeyC", metaKey: true }), true), "copy");
	assert.equal(terminalKeyAction(key({ key: "c", code: "KeyC", metaKey: true }), false), "forward");
	assert.equal(terminalKeyAction(key({ key: "c", code: "KeyC", metaKey: true, shiftKey: true }), false), "copy");
	assert.equal(terminalKeyAction(key({ key: "c", code: "KeyC" }), true), "forward");
	assert.equal(terminalKeyAction(key({ key: "c", code: "KeyC", ctrlKey: true, altKey: true }), true), "forward");
});

test("the dock chord and ordinary keys keep their existing owners", () => {
	assert.equal(terminalKeyAction(key({ key: "`", code: "Backquote", ctrlKey: true }), false), "dock");
	assert.equal(terminalKeyAction(key({ key: "`", code: "Backquote" }), false), "forward");
	assert.equal(terminalKeyAction(key({ key: "a", code: "KeyA" }), false), "forward");
	assert.equal(terminalKeyAction(key({ key: "Enter", code: "Enter" }), false), "forward");
});

test("an oversized paste is refused before it can close the terminal stream", () => {
	// The Host's 64 KiB request limit, less the bracketed-paste markers xterm adds.
	assert.equal(PASTE_LIMIT_BYTES, 65536 - 12);
	assert.equal(pasteExceedsLimit(""), false);
	assert.equal(pasteExceedsLimit("a".repeat(PASTE_LIMIT_BYTES)), false);
	assert.equal(pasteExceedsLimit("a".repeat(PASTE_LIMIT_BYTES + 1)), true);
	// UTF-8 bytes, not UTF-16 units: three bytes per CJK character.
	assert.equal(pasteExceedsLimit("中".repeat(21841)), false);
	assert.equal(pasteExceedsLimit("中".repeat(21842)), true);
});

test("the dock never reads the clipboard and leaves the paste event to xterm", () => {
	const dock = readFileSync(new URL("../client/src/features/terminal/TerminalDock.tsx", import.meta.url), "utf8");
	assert.doesNotMatch(dock, /clipboard\.readText/);
	assert.doesNotMatch(dock, /terminal\.paste\(/);
	// Capture listener: it must run before xterm's own handler on the textarea.
	assert.match(dock, /addEventListener\("paste", \(event\) => actions\.current\.guardPaste\(event\), true\)/);
});
