import { setKeybindings, TuiMainScreen } from "@step-harness/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { defaultEditorTheme } from "../../../packages/tui/test/test-themes.ts";
import { VirtualTerminal } from "../../../packages/tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../../../packages/coding-agent/src/core/keybindings.ts";
import { CustomEditor } from "@step-harness/coding-agent";

afterEach(() => {
	setKeybindings(new KeybindingsManager());
});

describe("CustomEditor prompt history keybindings", () => {
	it("gives an explicit history binding precedence over model cycling", () => {
		const keybindings = new KeybindingsManager({
			"tui.editor.historyPrevious": "ctrl+p",
			"tui.editor.historyNext": "ctrl+n",
		});
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
		let modelCycles = 0;
		editor.onAction("app.model.cycleForward", () => {
			modelCycles++;
		});
		editor.addToHistory("previous prompt");
		editor.setText("draft");

		editor.handleInput("\x10"); // Ctrl+P
		expect(editor.getText()).toBe("previous prompt");
		expect(modelCycles).toBe(0);

		editor.handleInput("\x0e"); // Ctrl+N
		expect(editor.getText()).toBe("draft");
	});
});

describe("CustomEditor newline keybindings", () => {
	it("inserts a newline for Alt+Enter instead of queueing a follow-up", () => {
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
		let followUps = 0;
		editor.onAction("app.message.followUp", () => {
			followUps++;
		});
		editor.setText("first line");

		editor.handleInput("\x1b[13;3u");

		expect(editor.getText()).toBe("first line\n");
		expect(followUps).toBe(0);
	});
});
