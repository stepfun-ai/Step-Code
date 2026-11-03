/**
 * Multi-line editor component for extensions.
 * Supports Ctrl+G for external editor.
 */

import type { KeybindingsManager } from "@step-harness/coding-agent";
import { DynamicBorder, getEditorTheme, keyHint, theme } from "@step-harness/coding-agent";
import {
	Container,
	Editor,
	type EditorOptions,
	type Focusable,
	getKeybindings,
	Spacer,
	Text,
	type TUI,
} from "@step-harness/pi-tui";
import { editInExternalEditor } from "../../external-editor.ts";
import { renderStepDialogFrame, splitStepDialogTitle } from "./step-dialog.ts";

export class ExtensionEditorComponent extends Container implements Focusable {
	private editor: Editor;
	private onSubmitCallback: (value: string) => void;
	private onCancelCallback: () => void;
	private tui: TUI;
	private keybindings: KeybindingsManager;
	private externalEditorCommand: string;
	private readonly presentation: "native" | "step";
	private readonly title: string;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value;
	}

	constructor(
		tui: TUI,
		keybindings: KeybindingsManager,
		title: string,
		prefill: string | undefined,
		onSubmit: (value: string) => void,
		onCancel: () => void,
		options?: EditorOptions,
		externalEditorCommand?: string,
		presentation: "native" | "step" = "native",
	) {
		super();

		this.tui = tui;
		this.keybindings = keybindings;
		this.externalEditorCommand =
			externalEditorCommand ||
			process.env.VISUAL ||
			process.env.EDITOR ||
			(process.platform === "win32" ? "notepad" : "nano");
		this.onSubmitCallback = onSubmit;
		this.onCancelCallback = onCancel;
		this.presentation = presentation;
		this.title = title;

		// Add top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Add title
		this.addChild(new Text(theme.fg("accent", title), 1, 0));
		this.addChild(new Spacer(1));

		// Create editor
		this.editor = new Editor(tui, getEditorTheme(), options);
		if (prefill) {
			this.editor.setText(prefill);
		}
		// Wire up Enter to submit (Shift+Enter for newlines, like the main editor)
		this.editor.onSubmit = (text: string) => {
			this.onSubmitCallback(text);
		};
		this.addChild(this.editor);

		this.addChild(new Spacer(1));

		// Add hint
		const hint =
			keyHint("tui.select.confirm", "submit") +
			"  " +
			keyHint("tui.input.newLine", "newline") +
			"  " +
			keyHint("tui.select.cancel", "cancel") +
			`  ${keyHint("app.editor.external", "external editor")}`;
		this.addChild(new Text(hint, 1, 0));

		this.addChild(new Spacer(1));

		// Add bottom border
		this.addChild(new DynamicBorder());
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		// Escape or Ctrl+C to cancel
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
			return;
		}

		// External editor (app keybinding)
		if (this.keybindings.matches(keyData, "app.editor.external")) {
			void this.handleOpenExternalEditor();
			return;
		}

		// Forward to editor
		this.editor.handleInput(keyData);
	}

	private async handleOpenExternalEditor(): Promise<void> {
		const content = this.editor.getText();
		this.tui.stop();
		try {
			const result = await editInExternalEditor({
				command: this.externalEditorCommand,
				content,
			});
			if (result.status === "complete") {
				this.editor.setText(result.content);
			}
		} finally {
			this.tui.start();
			this.tui.requestRender(true);
		}
	}

	override render(width: number): string[] {
		if (this.presentation !== "step") return super.render(width);

		const safeWidth = Math.max(1, Math.floor(width));
		if (safeWidth < 8) return super.render(safeWidth);
		const contentWidth = Math.max(1, safeWidth - 4);
		const { heading, body } = splitStepDialogTitle(this.title);
		const rows: string[] = [];
		if (heading.length > 0) rows.push(theme.fg("accent", theme.bold(`● ${heading}`)));
		for (const line of body) rows.push(theme.fg("muted", line));
		if (rows.length > 0) rows.push("");

		// Render the native editor once and remove only its horizontal rules. The
		// cursor marker and all editing output remain on Pi's native path.
		for (const row of this.editor.render(contentWidth)) {
			if (/^\s*─+\s*$/u.test(stripSgr(row))) continue;
			rows.push(row);
		}
		rows.push("");
		rows.push(
			theme.fg(
				"muted",
				`${keyHint("tui.select.confirm", "submit")}  ${keyHint("tui.input.newLine", "newline")}  ${keyHint("tui.select.cancel", "cancel")}  ${keyHint("app.editor.external", "external editor")}`,
			),
		);
		return renderStepDialogFrame(rows, safeWidth);
	}
}

function stripSgr(value: string): string {
	// eslint-disable-next-line no-control-regex
	return value.replaceAll(/\x1b\[[0-9;]*m/g, "");
}
