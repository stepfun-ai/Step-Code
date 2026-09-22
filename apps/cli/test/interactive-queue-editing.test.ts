import {
	CombinedAutocompleteProvider,
	Container,
	setKeybindings,
	TuiAltScreen,
	TuiMainScreen,
} from "@step-harness/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../packages/tui/test/virtual-terminal.ts";
import type { EditorFactory } from "../../../packages/coding-agent/src/core/extensions/index.ts";
import { type KeybindingsConfig, KeybindingsManager } from "../../../packages/coding-agent/src/core/keybindings.ts";
import { StepEditor } from "../src/ui/view/editor/step-editor.ts";
import { StepQueuedMessagesComponent } from "../src/ui/view/transcript/step-queued-messages.ts";
import { InteractiveMode } from "../src/ui/interactive-mode.ts";
import { getEditorTheme, initTheme } from "../../../packages/coding-agent/src/theme/theme.ts";

interface QueueModeFixture {
	editor: StepEditor;
	compactionQueuedMessages: { text: string; mode: "steer" | "followUp" }[];
	setupKeyHandlers(): void;
	setCustomEditorComponent(factory: EditorFactory): void;
	updatePendingMessagesDisplay(): void;
}

function createQueueEditor(bindings: KeybindingsConfig = {}, fullscreen = false) {
	initTheme("step-blue");
	const keybindings = new KeybindingsManager(bindings);
	setKeybindings(keybindings);
	const terminal = new VirtualTerminal();
	const ui = fullscreen ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
	const editor = new StepEditor(ui, getEditorTheme(), keybindings);
	const queues = { steering: [] as string[], followUp: [] as string[] };
	const clearQueue = vi.fn(() => ({ steering: queues.steering.splice(0), followUp: queues.followUp.splice(0) }));
	const abort = vi.fn();
	const showStatus = vi.fn();
	const queueComponent = new StepQueuedMessagesComponent();
	const mode = Object.create(InteractiveMode.prototype) as QueueModeFixture;
	Object.assign(mode, {
		runtimeHost: {
			session: {
				getSteeringMessages: () => queues.steering,
				getFollowUpMessages: () => queues.followUp,
				clearQueue,
				agent: { abort },
			},
		},
		options: { tuiStyle: "step" },
		ui,
		// `redraw` on InteractiveMode is a getter-only accessor backed by the
		// private `_redraw` field (see interactive-mode.ts). The fixture bypasses
		// the constructor via Object.create, so seed the backing field directly
		// instead of assigning the getter (which would throw).
		_redraw: { requestRender: () => ui.requestRender(), forceRender: () => ui.requestRender(true), renderNow: () => ui.renderNow() },
		keybindings,
		defaultEditor: editor,
		editor,
		editorContainer: new Container(),
		pendingMessagesContainer: new Container(),
		stepQueuedMessages: queueComponent,
		compactionQueuedMessages: [],
		isBashMode: false,
		showStatus,
	});
	mode.setupKeyHandlers();
	return { mode, editor, ui, terminal, queues, clearQueue, abort, showStatus, queueComponent };
}

afterEach(() => {
	setKeybindings(new KeybindingsManager());
	initTheme("dark");
});

describe("interactive queue editing", () => {
	it.each([false, true])("restores all queues through terminal Up input (fullscreen=%s)", (fullscreen) => {
		const { mode, editor, ui, terminal, queues, clearQueue, abort, queueComponent } = createQueueEditor(
			{},
			fullscreen,
		);
		queues.steering.push("first", "second\ncontinued");
		queues.followUp.push("follow-up");
		mode.compactionQueuedMessages.push({ text: "compaction", mode: "steer" });
		mode.compactionQueuedMessages.push({ text: "compaction follow-up", mode: "followUp" });
		editor.setText("draft");
		mode.updatePendingMessagesDisplay();
		ui.addChild(editor);
		ui.setFocus(editor);
		ui.start();
		try {
			terminal.sendInput("\x1b[A");
			expect(editor.getText()).toBe("first\nsecond\ncontinued\ncompaction\nfollow-up\ncompaction follow-up\ndraft");
			expect(queues).toEqual({ steering: [], followUp: [] });
			expect(mode.compactionQueuedMessages).toEqual([]);
			expect(queueComponent.render(80)).toEqual([]);
			expect(clearQueue).toHaveBeenCalledTimes(1);
			expect(abort).not.toHaveBeenCalled();

			terminal.sendInput("\x1b[A");
			expect(clearQueue).toHaveBeenCalledTimes(1);
		} finally {
			ui.stop();
		}
	});

	it.each(["\x1b[A", "\x1bOA", "\x1b[1;1A"])("restores a single queued message for %j", (input) => {
		const { editor, queues } = createQueueEditor();
		queues.steering.push("queued");
		editor.handleInput(input);
		expect(editor.getText()).toBe("queued");
	});

	it("preserves prompt history and multiline cursor movement with an empty queue", () => {
		const { editor, clearQueue, showStatus } = createQueueEditor();
		editor.addToHistory("previous prompt");
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("previous prompt");

		editor.setText("first\nsecond");
		editor.render(80);
		editor.handleInput("\x1b[A");
		editor.handleInput("!");
		expect(editor.getText()).toBe("first!\nsecond");
		expect(clearQueue).not.toHaveBeenCalled();
		expect(showStatus).not.toHaveBeenCalled();
	});

	it("restores messages queued only during compaction", () => {
		const { mode, editor } = createQueueEditor();
		mode.compactionQueuedMessages.push({ text: "queued during compaction", mode: "steer" });
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("queued during compaction");
		expect(mode.compactionQueuedMessages).toEqual([]);
	});

	it("prioritizes queued messages over an explicit Up history binding", () => {
		const { editor, queues } = createQueueEditor({ "tui.editor.historyPrevious": "up" });
		editor.addToHistory("history");
		queues.steering.push("queued");
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("queued");
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("history");
	});

	it("respects remapped and disabled dequeue bindings", () => {
		const { editor, queues } = createQueueEditor({ "app.message.dequeue": "ctrl+r" });
		queues.steering.push("queued");
		editor.handleInput("\x1b[A");
		expect(queues.steering).toEqual(["queued"]);
		editor.handleInput("\x12");
		expect(editor.getText()).toBe("queued");

		const disabled = createQueueEditor({ "app.message.dequeue": [] });
		disabled.queues.steering.push("queued");
		disabled.editor.handleInput("\x1b[A");
		expect(disabled.queues.steering).toEqual(["queued"]);
	});

	it("preserves expanded paste contents in the current draft", () => {
		const { editor, queues } = createQueueEditor();
		const paste = "pasted text\n".repeat(15);
		editor.handleInput(`\x1b[200~${paste}\x1b[201~`);
		expect(editor.getText()).toContain("[paste #");
		queues.followUp.push("queued");
		editor.handleInput("\x1b[A");
		expect(editor.getExpandedText()).toBe(`queued\n${paste}`);
	});

	it("takes queued messages before autocomplete, then restores autocomplete navigation when empty", async () => {
		const { editor, queues, clearQueue } = createQueueEditor();
		editor.setAutocompleteProvider(
			new CombinedAutocompleteProvider(
				[
					{ name: "alpha", description: "Alpha" },
					{ name: "beta", description: "Beta" },
				],
				process.cwd(),
			),
		);
		editor.setText("/");
		editor.handleInput("\t");
		await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
		queues.steering.push("queued");
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("queued\n/");

		editor.setText("/");
		editor.handleInput("\t");
		await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
		editor.handleInput("\x1b[A");
		expect(editor.isShowingAutocomplete()).toBe(true);
		expect(clearQueue).toHaveBeenCalledTimes(1);
		editor.setText("");
	});

	it("carries queue availability into a replacement CustomEditor", () => {
		const { mode, queues } = createQueueEditor();
		mode.setCustomEditorComponent((ui, editorTheme, keybindings) => new StepEditor(ui, editorTheme, keybindings));
		queues.steering.push("queued");
		mode.editor.handleInput("\x1b[A");
		expect(mode.editor.getText()).toBe("queued");
		expect(mode.editor.canDequeue?.()).toBe(false);
	});
});
