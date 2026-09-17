import { setKeybindings, TuiMainScreen } from "@step-harness/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { CustomEditor } from "@step-harness/coding-agent";
import { KeybindingsManager } from "../../../packages/coding-agent/src/core/keybindings.ts";
import { defaultEditorTheme } from "../../../packages/tui/test/test-themes.ts";
import { VirtualTerminal } from "../../../packages/tui/test/virtual-terminal.ts";

// Feature: pasting a clipboard image. macOS Cmd+V of an image-only clipboard
// arrives as an EMPTY bracketed paste; CustomEditor routes it to onEmptyPaste
// (which reads the clipboard image), instead of inserting nothing.
const EMPTY_PASTE = "\x1b[200~\x1b[201~";

afterEach(() => {
	setKeybindings(new KeybindingsManager());
});

function makeEditor(): CustomEditor {
	const keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
	return new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
}

describe("CustomEditor empty bracketed paste", () => {
	it("routes an empty bracketed paste to onEmptyPaste and inserts no text", () => {
		const editor = makeEditor();
		let calls = 0;
		editor.onEmptyPaste = () => {
			calls++;
		};

		editor.handleInput(EMPTY_PASTE);

		expect(calls).toBe(1);
		expect(editor.getText()).toBe("");
	});

	it("stays a no-op when onEmptyPaste is not wired", () => {
		const editor = makeEditor();

		editor.handleInput(EMPTY_PASTE);

		expect(editor.getText()).toBe("");
	});

	it("does not fire onEmptyPaste for a non-empty paste (normal text still inserts)", () => {
		const editor = makeEditor();
		let calls = 0;
		editor.onEmptyPaste = () => {
			calls++;
		};

		editor.handleInput("\x1b[200~hello\x1b[201~");

		expect(calls).toBe(0);
		expect(editor.getText()).toBe("hello");
	});
});
