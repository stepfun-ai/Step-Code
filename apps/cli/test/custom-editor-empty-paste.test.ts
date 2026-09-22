import { setKeybindings, TuiMainScreen } from "@step-harness/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { CustomEditor } from "@step-harness/coding-agent";
import { KeybindingsManager } from "../../../packages/coding-agent/src/core/keybindings.ts";
import { defaultEditorTheme } from "../../../packages/tui/test/test-themes.ts";
import { VirtualTerminal } from "../../../packages/tui/test/virtual-terminal.ts";

// Feature: pasting a clipboard image. macOS Cmd+V of an image-only clipboard
// arrives as an EMPTY bracketed paste -> onEmptyPaste (reads the clipboard image).
// A copied image FILE is pasted as its name (non-empty) -> onPasteImagePath, which
// resolves it to an `[Image #N]` placeholder; returning false lets it paste as
// normal text.
const EMPTY_PASTE = "\x1b[200~\x1b[201~";
const bracket = (content: string): string => `\x1b[200~${content}\x1b[201~`;

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
});

describe("CustomEditor image-file paste", () => {
	it("routes a non-empty paste to onPasteImagePath and consumes it when handled", () => {
		const editor = makeEditor();
		const seen: string[] = [];
		editor.onPasteImagePath = (content) => {
			seen.push(content);
			return true; // claimed
		};

		editor.handleInput(bracket("1280X1280 (1).PNG"));

		expect(seen).toEqual(["1280X1280 (1).PNG"]);
		expect(editor.getText()).toBe(""); // consumed, not inserted as raw text
	});

	it("pastes normally when onPasteImagePath declines (returns false)", () => {
		const editor = makeEditor();
		editor.onPasteImagePath = () => false;

		editor.handleInput(bracket("just some text"));

		expect(editor.getText()).toBe("just some text");
	});

	it("pastes normally when onPasteImagePath is not wired", () => {
		const editor = makeEditor();

		editor.handleInput(bracket("hello"));

		expect(editor.getText()).toBe("hello");
	});
});
