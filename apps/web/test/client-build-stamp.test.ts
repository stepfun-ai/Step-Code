import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createInitialState, getState, setState } from "../client/src/state/store.ts";
import type { BootstrapPayload } from "../client/src/state/types.ts";

/**
 * The build a window is running.
 *
 * An installed copy, a stale installed copy and a source checkout render the
 * same UI, so "did the update take?" needs the host's own answer in the page.
 * The bootstrap payload carries it; the store keeps only what the host actually
 * reported, so the page never invents a build time from its own bundle.
 */

afterEach(() => setState(createInitialState()));

/** Only the projection the store applies; the HTTP call itself is covered by the bootstrap test. */
function applyBuild(boot: BootstrapPayload): void {
	setState({
		build: {
			...(typeof boot.version === "string" && boot.version ? { version: boot.version } : {}),
			...(typeof boot.buildTime === "string" && !Number.isNaN(Date.parse(boot.buildTime))
				? { madeAt: boot.buildTime }
				: {}),
		},
	});
}

test("an installed build reports both its version and when it was made", () => {
	applyBuild({ cwd: "/work", version: "0.1.0", buildTime: "2026-10-26T09:02:22.531Z" });
	assert.deepEqual(getState().build, { version: "0.1.0", madeAt: "2026-10-26T09:02:22.531Z" });
});

test("a source checkout reports a version and no build time", () => {
	applyBuild({ cwd: "/work", version: "0.1.0" });
	assert.deepEqual(getState().build, { version: "0.1.0" });
});

test("an unparseable build time is dropped instead of shown as a wrong date", () => {
	applyBuild({ cwd: "/work", version: "0.1.0", buildTime: "not-a-date" });
	assert.deepEqual(getState().build, { version: "0.1.0" });
});
