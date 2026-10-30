/**
 * Keyboard and paste policy for the terminal dock.
 *
 * Pasting must not read the clipboard from script: `navigator.clipboard.readText()`
 * needs a `clipboard-read` permission that the Desktop denies, and a denied read
 * only produced a transient error. The paste shortcut is therefore handed to the
 * browser instead: its native `paste` event carries the text and xterm's own
 * listener in `CoreBrowserTerminal` forwards it to the PTY.
 */

/** The parts of a `KeyboardEvent` the terminal policy reads. */
export interface TerminalKeyInput {
	readonly type: string;
	readonly key: string;
	readonly code: string;
	readonly ctrlKey: boolean;
	readonly metaKey: boolean;
	readonly altKey: boolean;
	readonly shiftKey: boolean;
}

export type TerminalKeyAction =
	/** The dock toggle belongs to the shell's shortcut table, not to the PTY. */
	| "dock"
	/** Copy the current selection through the clipboard API. */
	| "copy"
	/** Leave the key uncancelled so the browser fires its `paste` event and xterm receives the text. */
	| "paste"
	/** Let xterm handle the key as terminal input. */
	| "forward";

/**
 * xterm maps Ctrl+V to a `^V` control character and cancels the event, so
 * forwarding it would swallow the browser's paste. Both Cmd+V and Ctrl+V are
 * routed to "paste" so the shortcut behaves the same in every host and platform.
 */
export function terminalKeyAction(event: TerminalKeyInput, hasSelection: boolean): TerminalKeyAction {
	if (event.type !== "keydown") return "forward";
	if (event.ctrlKey && event.code === "Backquote") return "dock";
	if (event.altKey || !(event.ctrlKey || event.metaKey)) return "forward";
	const key = event.key.toLowerCase();
	if (key === "c") return event.shiftKey || hasSelection ? "copy" : "forward";
	if (key === "v") return "paste";
	return "forward";
}

/** The Host rejects one terminal input request above this and closes the stream. */
const HOST_INPUT_LIMIT_BYTES = 65536;
/**
 * Bracketed paste wraps the text in `ESC[200~` … `ESC[201~` (6 bytes each) before
 * xterm sends it, and those markers count against the Host's per-request limit.
 */
const BRACKETED_PASTE_MARKER_BYTES = 12;
/** Largest pasted text that still fits one terminal input request. */
export const PASTE_LIMIT_BYTES = HOST_INPUT_LIMIT_BYTES - BRACKETED_PASTE_MARKER_BYTES;

/** True when pasted text, with its bracketed-paste markers, exceeds one input request. */
export function pasteExceedsLimit(text: string): boolean {
	return new TextEncoder().encode(text).byteLength > PASTE_LIMIT_BYTES;
}
