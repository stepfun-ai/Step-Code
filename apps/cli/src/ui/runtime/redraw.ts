/**
 * redraw.ts — the single render funnel for the interactive runtime (S4-1 STEP 1).
 *
 * A THIN pass-through facade over the TUI's existing scheduler. It does NOT own a
 * dirty-region model (that is S4-2) and it does NOT re-implement the 16ms
 * `MIN_RENDER_INTERVAL_MS` throttle — that stays in packages/tui (TuiBase). Every
 * method here forwards synchronously to the same `ui` call the monolith used, with no
 * added Promise/microtask hop, so `process.nextTick` immediate-preempt ordering in the
 * TUI is preserved byte-for-byte:
 *
 *   requestRender()  -> ui.requestRender()      (throttled ~60fps repaint)
 *   forceRender()    -> ui.requestRender(true)  (immediate-preempt repaint)
 *   renderNow()      -> ui.renderNow()          (synchronous flush)
 *
 * The concrete post-switchTuiMode `renderer.renderNow()` teardown stays bound to the
 * concrete renderer at its call site — it is intentionally NOT routed through this proxy
 * facade.
 *
 * redraw also owns the animation-clock lifetime: the StepToolSpinnerClock is constructed
 * here with its `() => requestRender()` callback wired through this same funnel, so the
 * host reads it back as `redraw.spinner`. It must therefore be constructed BEFORE any
 * component that captures a redraw callback (welcome, spinner, extension mount host).
 */

import type { TUI } from "@step-harness/pi-tui";
import { StepToolSpinnerClock } from "../view/index.ts";

export interface Redraw {
	/** Throttled repaint (the ~112 default `requestRender()` sites). */
	requestRender(): void;
	/** Immediate-preempt repaint (the `requestRender(true)` sites: SIGCONT, external-editor return, reload-box). */
	forceRender(): void;
	/** Synchronous render flush (the startup `renderNow()` site). */
	renderNow(): void;
	/** The animation clock, constructed here so its callback funnels through this facade. */
	readonly spinner: StepToolSpinnerClock | undefined;
}

export function createRedraw(ui: TUI, options?: { withSpinner?: boolean }): Redraw {
	const requestRender = (): void => ui.requestRender();
	const forceRender = (): void => ui.requestRender(true);
	const renderNow = (): void => ui.renderNow();
	const spinner = options?.withSpinner ? new StepToolSpinnerClock(() => requestRender()) : undefined;
	return { requestRender, forceRender, renderNow, spinner };
}
