import { type Mock, vi } from "vitest";
import { InteractiveMode } from "../../src/ui/interactive-mode.ts";

/**
 * Chrome / rendering stubs shared by the many unit tests that drive
 * `InteractiveMode.prototype` methods against a hand-rolled `this`.
 *
 * These are the members the S4-1 seam refactor (`this.ui` -> `this.redraw`)
 * turned into a rejection trap: a method that awaits inside a redraw path will
 * throw an *unhandled* rejection when the fake `this` is missing `redraw`,
 * which vitest swallows. Presetting every render/chrome collaborator as a
 * `vi.fn()` removes that trap in one place, so a future seam change touches one
 * helper instead of ~25 hand-built contexts.
 *
 * Deliberately NOT preset: domain members (`session`, `sessionManager`,
 * `runtimeHost`, `options`). If a method reaches for domain state the test did
 * not provide, it should fail loudly rather than run against a silent stub —
 * the helper covers chrome, never business state.
 */
export type FakeInteractiveContext = {
	redraw: { requestRender: Mock; forceRender: Mock; renderNow: Mock };
	ui: { requestRender: Mock };
	footer: { invalidate: Mock };
	editor: { setText: Mock };
	showStatus: Mock;
	showError: Mock;
	showWarning: Mock;
	updateEditorBorderColor: Mock;
	updateAvailableProviderCount: Mock;
	maybeWarnAboutAnthropicSubscriptionAuth: Mock;
	renderCurrentSessionState: Mock;
};

/**
 * Build a fake `InteractiveMode` `this` with the chrome/render collaborators
 * preset as spies. `overrides` are merged one level deep: a top-level key you
 * pass replaces the default wholesale (e.g. pass a full `redraw` object if you
 * need it shaped differently). Use it to inject domain members
 * (`session`/`runtimeHost`/...) and any collaborator you want to assert on.
 */
export function createFakeInteractiveContext<T extends Record<string, unknown>>(
	overrides: T = {} as T,
): FakeInteractiveContext & T {
	return {
		redraw: { requestRender: vi.fn(), forceRender: vi.fn(), renderNow: vi.fn() },
		ui: { requestRender: vi.fn() },
		footer: { invalidate: vi.fn() },
		editor: { setText: vi.fn() },
		showStatus: vi.fn(),
		showError: vi.fn(),
		showWarning: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		updateAvailableProviderCount: vi.fn(),
		maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(),
		renderCurrentSessionState: vi.fn(),
		...overrides,
	} as FakeInteractiveContext & T;
}

/**
 * Fetch a (typically private) method off `InteractiveMode.prototype` so it can
 * be `.call(...)`-ed against a fake context. Collects the
 * `Reflect.get(InteractiveMode.prototype, name)` /
 * `InteractiveMode.prototype as unknown` idiom into one place.
 */
export function getPrototypeMethod<T = (this: unknown, ...args: unknown[]) => unknown>(name: string): T {
	return Reflect.get(InteractiveMode.prototype, name) as T;
}
