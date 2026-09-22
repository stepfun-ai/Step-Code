/**
 * interrupt.ts — turn/bash/mode abort + the double-tap Esc and Ctrl+C machines (S4-1 STEP 2).
 *
 * These bodies are relocated BYTE-FOR-BYTE from InteractiveMode (only `this.` → `ctx.`); the
 * save/restore-slot escape mechanism is deliberately NOT redesigned into a keyed
 * arm/disarm arbiter. The compaction/retry escape swaps stay as plain
 * `ctx.defaultEditor.onEscape` save/restore assignments at their call sites
 * (session-events, STEP 4) so the nested save-restore semantics (retry armed while
 * compaction active saves and restores the compaction handler) are preserved by
 * construction.
 *
 * Load-bearing asymmetry kept verbatim:
 *   - double-Esc window `now - lastEscapeTime < 500` with `lastEscapeTime = 0` reset on fire;
 *   - double-Ctrl+C window `now - lastSigintTime < 500` with lastSigintTime NEVER reset.
 * The two machines are separate on purpose — do not merge them.
 *
 * handleCtrlZ (TUI suspend / process signal) is NOT here — it stays with the lifecycle owner
 * (interrupt only ever binds `app.suspend`). Guarded shutdown also stays on the host; these
 * handlers call it through `ctx.shutdown`.
 */

import type { RuntimeContext } from "./context.ts";

/** The defaultEditor.onEscape body: streaming-abort / bash-abort / bash-mode-exit / double-Esc. */
export function handleEscape(ctx: RuntimeContext): void {
	if (ctx.session.isStreaming) {
		ctx.restoreQueuedMessagesToEditor({ abort: true });
	} else if (ctx.session.isBashRunning) {
		ctx.session.abortBash();
	} else if (ctx.isBashMode) {
		ctx.editor.setText("");
		ctx.isBashMode = false;
		ctx.isBashExcluded = false;
		ctx.updateEditorBorderColor();
	} else if (!ctx.editor.getText().trim()) {
		// Double-escape with empty editor triggers /tree, /fork, or nothing based on setting
		const action = ctx.settingsManager.getDoubleEscapeAction();
		if (action !== "none") {
			const now = Date.now();
			if (now - ctx.lastEscapeTime < 500) {
				if (action === "tree") {
					ctx.showTreeSelector();
				} else {
					ctx.showUserMessageSelector();
				}
				ctx.lastEscapeTime = 0;
			} else {
				ctx.lastEscapeTime = now;
			}
		}
	}
}

export function handleCtrlC(ctx: RuntimeContext): void {
	const now = Date.now();
	if (now - ctx.lastSigintTime < 500) {
		void ctx.shutdown();
	} else {
		ctx.clearEditor();
		ctx.lastSigintTime = now;
	}
}

export function handleCtrlD(ctx: RuntimeContext): void {
	// Only called when editor is empty (enforced by CustomEditor)
	void ctx.shutdown();
}
