import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeMigration, confirmCloseMigration, createMigrationPlan, handleMigrationEscape, previewCandidate, scanMigration, selectMigrationGroup } from "../client/src/features/migration/actions.ts";
import { getMigrationState, updateMigration } from "../client/src/features/migration/store.ts";
import type { MigrationCandidate, MigrationJob, MigrationPreview, MigrationScanRequest } from "../client/src/state/types.ts";

const fetchBefore = globalThis.fetch;
after(() => { globalThis.fetch = fetchBefore; });
const session: MigrationCandidate = { id: "session", kind: "sessions", source: "codex", name: "Fixture history", sourcePath: "/fixture/history", sourceScope: { kind: "project", cwd: "/fixture/original" }, holding: "external", readiness: "ready", needsMigration: true, diagnostics: [] };
function reset() {
	updateMigration({ open: true, stage: "select", kind: "sessions", scan: { candidates: [session], sources: [], truncated: false }, scannedKinds: [], drafts: {}, job: null, busy: null, scanning: false, plan: null, startKey: null, closeRequested: false, closeWhenSettled: false, skipBlocked: false });
}
function preview(): MigrationPreview {
	return { id: "preview", candidate: session, fingerprint: "fixture", expiresAt: "2100-01-01T00:00:00Z", target: { scope: session.sourceScope, path: "/fixture/target", name: "Fixture history" }, action: "import", allowedActions: ["import", "skip"], sourceText: "Fixture history", requiredAcknowledgements: [], warnings: [], blockers: [], activation: "history" };
}
test("all range and global limit choices are sent to the scan contract without local slicing", async () => {
	reset();
	const requests: MigrationScanRequest[] = [];
	globalThis.fetch = async (_input, init) => { requests.push(JSON.parse(String(init?.body))); return Response.json({ candidates: [session], sources: [], truncated: true }); };
	for (const range of ["all", "7", "30", "90"] as const) {
		for (const limit of [30, 50, 100, null] as const) {
			updateMigration({ sessionOptions: { range, limit, includeArchived: true } });
			await scanMigration("sessions");
			assert.deepEqual(requests.at(-1)?.sessionOptions, { range, limit, includeArchived: true });
			assert.equal(getMigrationState().scan?.truncated, true);
		}
	}
});
test("history clicks do not select and checkbox/group checks do not focus a preview", async () => {
	reset();
	globalThis.fetch = async (_input, init) => {
		assert.deepEqual(JSON.parse(String(init?.body)), { candidateId: session.id });
		return Response.json(preview());
	};
	await previewCandidate(session.id);
	assert.equal(getMigrationState().focusedId, session.id);
	assert.equal(getMigrationState().drafts.session?.selected, false);
	updateMigration({ focusedId: null });
	await selectMigrationGroup([session], true);
	assert.equal(getMigrationState().drafts.session?.selected, true);
	assert.equal(getMigrationState().focusedId, null);
});
test("review stays reachable with pending and failed choices without sending them to plans", async () => {
	reset();
	let requests = 0;
	globalThis.fetch = async () => { requests++; throw new Error("Unexpected request"); };
	updateMigration({ drafts: { session: { request: { candidateId: session.id }, selected: true, acknowledged: [], ruleChecked: false, loading: true } } });
	await createMigrationPlan();
	assert.equal(getMigrationState().stage, "review");
	assert.equal(requests, 0);
	const state = getMigrationState();
	updateMigration({ drafts: { ...state.drafts, session: { ...state.drafts.session!, loading: false, error: "network-error" } } });
	assert.equal(getMigrationState().stage, "review", "A failed choice stays out of the plan and out of the way");
});
test("dirty close requires confirmation; Escape cancels only the confirmation", async () => {
	reset();
	updateMigration({ drafts: { session: { request: { candidateId: session.id }, selected: true, acknowledged: [], ruleChecked: false, loading: false } } });
	closeMigration();
	assert.equal(getMigrationState().open, true);
	assert.equal(getMigrationState().closeRequested, true);
	assert.equal(handleMigrationEscape(), true);
	assert.equal(getMigrationState().closeRequested, false);
	assert.equal(getMigrationState().open, true);
	closeMigration();
	await confirmCloseMigration();
	assert.equal(getMigrationState().open, false);
	assert.deepEqual(getMigrationState().drafts, {});
});
test("running close stays visible while stopping and closes only after settled cancellation", async () => {
	reset();
	const job: MigrationJob = { id: "job", revision: 1, createdAt: "2026-01-01T00:00:00Z", status: "running", items: [] };
	updateMigration({ job, stage: "job" });
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	globalThis.fetch = async () => { await gate; return Response.json({ ...job, revision: 2, status: "cancelled" }); };
	closeMigration();
	const closing = confirmCloseMigration();
	assert.equal(getMigrationState().open, true);
	assert.equal(getMigrationState().closeWhenSettled, true);
	release(); await closing;
	assert.equal(getMigrationState().open, false);
	assert.equal(getMigrationState().job?.status, "cancelled");
});
