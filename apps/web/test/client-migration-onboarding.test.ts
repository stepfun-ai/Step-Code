import assert from "node:assert/strict";
import { after, test } from "node:test";
import { finishMigrationOnboarding, recordMigrationOnboardingJob } from "../client/src/state/session.ts";
import { createInitialState, getState, setState, setUi } from "../client/src/state/store.ts";
import type { DesktopOnboardingState } from "../client/src/state/types.ts";

const fetchBefore = globalThis.fetch;
after(() => { globalThis.fetch = fetchBefore; });
const offered: DesktopOnboardingState = {
	schemaVersion: 1, flowVersion: 1, revision: 1, status: "offered", updatedAt: "2026-10-27T00:00:00.000Z",
};

test("a job pointer and a fast Finish serialize against fresh onboarding revisions", async () => {
	setState({ ...createInitialState(), desktopOnboarding: offered });
	setUi({ migrationInvitation: true });
	const revisions: number[] = [];
	let allowFirst!: () => void;
	const firstWrite = new Promise<void>((resolve) => { allowFirst = resolve; });
	globalThis.fetch = async (input, init) => {
		const url = String(input);
		if (url === "/api/v1/desktop-onboarding") {
			const patch = JSON.parse(String(init?.body));
			revisions.push(patch.expectedRevision);
			if (revisions.length === 1) await firstWrite;
			return Response.json({ ...offered, ...patch, revision: patch.expectedRevision + 1 });
		}
		if (url.startsWith("/api/v1/workspaces")) return Response.json({ workspaces: [] });
		if (url.startsWith("/api/v1/sessions")) return Response.json({ sessions: [] });
		return Response.json({});
	};
	const started = recordMigrationOnboardingJob("fixture-job");
	const finished = finishMigrationOnboarding("completed", "fixture-job");
	await Promise.resolve();
	assert.deepEqual(revisions, [1]);
	allowFirst();
	await Promise.all([started, finished]);
	assert.deepEqual(revisions, [1, 2]);
	assert.equal(getState().desktopOnboarding?.status, "completed");
	assert.equal(getState().desktopOnboarding?.lastJobId, "fixture-job");
	assert.equal(getState().ui.migrationInvitation, false);
});

test("a late job pointer cannot reopen completed onboarding", async () => {
	let reads = 0;
	globalThis.fetch = async () => { reads++; throw new Error("No request expected"); };
	await recordMigrationOnboardingJob("late-job");
	assert.equal(reads, 0);
	assert.equal(getState().desktopOnboarding?.status, "completed");
});
