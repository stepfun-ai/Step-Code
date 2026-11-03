import assert from "node:assert/strict";
import test from "node:test";
import { applyPreviewWidth, defaultPreviewWidth, PREVIEW_MIN, previewMaxWidth } from "../client/src/features/files/actions.ts";

/**
 * The rail docks beside the conversation. Nothing has been decided on a first
 * open, so it splits the pane evenly instead of guessing one fixed width; a
 * width the user dragged wins and stays.
 */

/** A window of `width`, with a `.app` that reports the sidebar's default width. */
function withLayout(width: number, options: { sidebarHidden?: boolean } = {}): void {
	const app = {
		classList: { contains: (name: string) => name === "sidebar-hidden" && options.sidebarHidden === true },
		querySelector: (selector: string) =>
			selector === ".sidebar" ? { getBoundingClientRect: () => ({ width: 260 }) } : null,
	};
	Object.assign(globalThis, {
		window: { innerWidth: width },
		document: { querySelector: (selector: string) => (selector === ".app" ? app : null) },
		getComputedStyle: () => ({ getPropertyValue: (name: string) => (name === "--rail-width" ? "44px" : "") }),
	});
}

test("a first open splits the pane evenly with the conversation", () => {
	// 1600 window − 260 sidebar − 44 rail = 1296, half each way.
	withLayout(1600);
	assert.equal(defaultPreviewWidth(), 648);
});

test("hiding the sidebar gives that space back to the split", () => {
	// 1600 window − 0 sidebar − 44 rail = 1556.
	withLayout(1600, { sidebarHidden: true });
	assert.equal(defaultPreviewWidth(), 778);
});

test("a narrow window still opens at the minimum rather than a sliver", () => {
	withLayout(700);
	// 700 − 260 − 44 = 396, half is 198, below the minimum.
	assert.equal(applyPreviewWidth(defaultPreviewWidth(), false), PREVIEW_MIN);
});

test("an even split never exceeds what the divider can be dragged to", () => {
	withLayout(1200);
	const applied = applyPreviewWidth(defaultPreviewWidth(), false);
	assert.ok(applied <= previewMaxWidth());
	assert.ok(applied >= PREVIEW_MIN);
});
