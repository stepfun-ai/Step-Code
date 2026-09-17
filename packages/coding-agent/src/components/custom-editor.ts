import { Editor, type EditorOptions, type EditorTheme, type TUI } from "@step-harness/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../core/keybindings.ts";

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// Special handlers that can be dynamically replaced
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	/**
	 * Called when the terminal delivers an EMPTY bracketed paste. macOS emits this
	 * for `Cmd+V` when the clipboard holds only an image (no text), so it is the
	 * hook that lets a clipboard image be pasted without the app receiving Cmd+V as
	 * a keypress. The clipboard read itself lives in the product layer (apps/cli);
	 * this stays a neutral callback so packages/tui pulls in no clipboard code.
	 */
	public onEmptyPaste?: () => void;
	/** Whether queued messages can currently be restored ahead of editor navigation. */
	public canDequeue?: () => boolean;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: EditorOptions) {
		super(tui, theme, options);
		this.keybindings = keybindings;
	}

	/**
	 * Register a handler for an app action.
	 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	handleInput(data: string): void {
		// Check extension-registered shortcuts first
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		// An empty bracketed paste (the terminal pasted nothing textual) is how
		// macOS delivers Cmd+V of an image-only clipboard. Route it to the clipboard
		// image reader; when unwired, fall through so it stays a no-op as before.
		if (data === "\x1b[200~\x1b[201~" && this.onEmptyPaste) {
			this.onEmptyPaste();
			return;
		}

		// Check for clipboard paste keybinding
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		// Check app keybindings first

		// Escape/interrupt - only if autocomplete is NOT active
		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				// Use dynamic onEscape if set, otherwise registered handler
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			// Let parent handle escape for autocomplete cancellation
			super.handleInput(data);
			return;
		}

		// Exit (Ctrl+D) - only when editor is empty
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
			// Fall through to editor handling for delete-char-forward when not empty
		}

		// A nonempty queue takes precedence over cursor, history, and autocomplete navigation.
		if (this.keybindings.matches(data, "app.message.dequeue") && this.canDequeue?.()) {
			const handler = this.actionHandlers.get("app.message.dequeue");
			if (handler) {
				handler();
				return;
			}
		}

		// Explicit history bindings take precedence over other app actions while the editor is focused.
		// This lets users bind Ctrl+P even though it cycles models by default.
		if (
			this.keybindings.matches(data, "tui.editor.historyPrevious") ||
			this.keybindings.matches(data, "tui.editor.historyNext")
		) {
			super.handleInput(data);
			return;
		}

		// Check all other app actions
		for (const [action, handler] of this.actionHandlers) {
			if (action === "app.message.dequeue" && this.canDequeue) continue;
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return;
			}
		}

		// Pass to parent for editor handling
		super.handleInput(data);
	}
}
