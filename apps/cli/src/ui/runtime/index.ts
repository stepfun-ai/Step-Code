/**
 * index.ts — the interactive runtime composition root (S4-1 STEP 6).
 *
 * This module owns the *wiring sequence* that binds the runtime surfaces (redraw,
 * interrupt, input-dispatch, session-events) onto the host. In S4-1 the host
 * (InteractiveMode) remains the living state-holder (option A: 界面瞬时态 + the
 * session-continuity invariants stay on it, true state extraction deferred to S4-3), so the
 * run() loop and the input pump stay on the host and reach the runtime through the
 * RuntimeContext. What lives here is the single place the two input phases are wired:
 *
 *   wireStartupInput      — the startup phase: accept text while startup completes but only
 *                           enable interrupt (Ctrl+C), exit (Ctrl+D), and submission feedback.
 *   wireInteractiveRuntime — the full phase: the complete key-binding table + submit router,
 *                           enabled only after managed-tool setup completes.
 *
 * Both register onto defaultEditor BEFORE any editor swap, so the swap path's
 * handler-copy picks up every handler.
 */

import type { RuntimeContext } from "./context.ts";
import { handleStartupSubmit, wireKeyHandlers, wireSubmitHandler } from "./input-dispatch.ts";

/** Startup-phase editor wiring: interrupt + exit + a "still starting" submit stub. */
export function wireStartupInput(ctx: RuntimeContext): void {
	// Accept text while startup completes, but only enable interrupt, exit, and submission feedback.
	ctx.defaultEditor.onAction("app.clear", () => ctx.handleCtrlC());
	ctx.defaultEditor.onCtrlD = () => ctx.handleCtrlD();
	ctx.defaultEditor.onSubmit = (text) => handleStartupSubmit(ctx, text);
}

/** Full-phase runtime wiring: the complete key-binding table + submit router. */
export function wireInteractiveRuntime(ctx: RuntimeContext): void {
	// Enable the remaining input handlers only after managed-tool setup completes.
	wireKeyHandlers(ctx);
	wireSubmitHandler(ctx);
}
