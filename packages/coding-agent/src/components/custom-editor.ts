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
	/**
	 * Called for a NON-empty bracketed paste with the pasted text. Lets the product
	 * layer claim a paste that is a single image file path/name (copied in
	 * Finder/Explorer) and turn it into an `@` file reference. Returns true if it
	 * handled the paste; false lets it paste as normal text. Kept a neutral callback
	 * so packages/tui pulls in no clipboard/product code.
	 */
	public onPasteImagePath?: (content: string) => boolean;
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

		// Bracketed paste. An EMPTY one is how macOS delivers Cmd+V of an image-only
		// clipboard; a non-empty one whose text is an image file path/name (a file
		// copied in Finder/Explorer) is routed to the product layer to become an `@`
		// reference. Anything else falls through to the normal text paste below.
		if (data.startsWith("\x1b[200~") && data.endsWith("\x1b[201~")) {
			const content = data.slice("\x1b[200~".length, data.length - "\x1b[201~".length);
			if (content.length === 0) {
				if (this.onEmptyPaste) {
					this.onEmptyPaste();
					return;
				}
			} else if (this.onPasteImagePath?.(content)) {
				return;
			}
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
