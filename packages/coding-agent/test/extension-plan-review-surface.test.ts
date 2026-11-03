import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { initTheme } from "../src/theme/theme.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const harnesses: Harness[] = [];

beforeEach(() => {
	initTheme("dark");
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.restoreAllMocks();
});

async function readSurface(bindings: { planReviewSurface?: boolean }): Promise<boolean | undefined> {
	let seen: boolean | undefined;
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("session_start", (_event, ctx: ExtensionContext) => {
					seen = ctx.planReviewSurface;
				});
			},
		],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions(bindings);
	return seen;
}

test("the host binding reaches the extension context", async () => {
	// `mode` and `hasUI` cannot say which host this is: every rpc host has a dialog
	// bridge, including clients with no review surface. The capability is declared
	// where the host binds the session, and read from every handler's ctx.
	expect(await readSurface({ planReviewSurface: true })).toBe(true);
});

test("a host that declares no review surface reads false", async () => {
	expect(await readSurface({})).toBe(false);
});
