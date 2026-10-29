import assert from "node:assert/strict";
import { after, test } from "node:test";
import { changeMigrationBatchTarget, closeMigration, openMigration, selectMigrationGroup, startNewMigration } from "../client/src/features/migration/actions.ts";
import { getMigrationState, updateMigration } from "../client/src/features/migration/store.ts";
import type { MigrationCandidate, MigrationPreview, MigrationPreviewRequest } from "../client/src/state/types.ts";

const beforeFetch = globalThis.fetch;
after(() => { globalThis.fetch = beforeFetch; });
const skill: MigrationCandidate = { id: "one", kind: "skills", source: "codex", name: "one",
	sourcePath: "/fixture/skills/one/SKILL.md", sourceScope: { kind: "global" }, holding: "external",
	readiness: "ready", needsMigration: true, diagnostics: [] };
const second = { ...skill, id: "two", name: "two" };
const rule = { ...skill, id: "rule", kind: "rules" as const };
const reference = { ...skill, id: "reference", holding: "reference" as const, needsMigration: false };
function reset(rows: MigrationCandidate[]) {
	updateMigration({ open: true, job: null, busy: null, scanning: false, kind: "skills", focusedId: null,
		scan: { candidates: rows, sources: [], truncated: false }, drafts: {}, defaultTargets: {}, plan: null, startKey: null });
}
function mockPreview(rows: MigrationCandidate[], requests: MigrationPreviewRequest[]) {
	globalThis.fetch = async (_input, init) => {
		const request: MigrationPreviewRequest = JSON.parse(String(init?.body));
		requests.push(request);
		const candidate = rows.find((row) => row.id === request.candidateId)!;
		const target = request.target ?? { kind: "global" as const };
		const preview: MigrationPreview = { id: "preview-" + requests.length, candidate, fingerprint: "hash",
			expiresAt: "2100-01-01T00:00:00Z", target: { scope: target, name: candidate.name, path: "/fixture/target" },
			action: "copy", allowedActions: ["copy", "skip"], sourceText: "fixture", blockers: [], warnings: [],
			requiredAcknowledgements: [], activation: "next-resource-load" };
		return Response.json(preview);
	};
}

test("select-all performs bounded sequential reviews and never selects rules or already available references", async () => {
	const rows = [skill, second, rule, reference], requests: MigrationPreviewRequest[] = [];
	reset(rows); mockPreview(rows, requests);
	await selectMigrationGroup(rows, true);
	assert.deepEqual(requests.map((request) => request.candidateId), ["one", "two"]);
	assert.deepEqual(Object.values(getMigrationState().drafts).filter((draft) => draft.selected).map((draft) => draft.request.candidateId), ["one", "two"]);
	assert.equal(getMigrationState().busy, null);
	await selectMigrationGroup(rows, false);
	assert.equal(Object.values(getMigrationState().drafts).some((draft) => draft.selected), false);
	assert.equal(requests.length, 2, "Deselecting makes no new requests");
});

test("hiding during a batch target update cannot leave ready selections at old destinations", async () => {
	const rows = [skill, second], requests: MigrationPreviewRequest[] = [];
	reset(rows); mockPreview(rows, requests);
	await selectMigrationGroup(rows, true);
	const underlying = globalThis.fetch;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let first = true;
	globalThis.fetch = async (...args) => {
		const response = await underlying(...args);
		if (first) { first = false; await gate; }
		return response;
	};
	updateMigration({ stage: "select" });
	const changed = changeMigrationBatchTarget("skills", { kind: "project", cwd: "/fixture/new-target" });
	await Promise.resolve();
	closeMigration();
	startNewMigration();
	assert.equal(getMigrationState().stage, "select", "Pending preview work is not a running migration job");
	assert.equal(getMigrationState().drafts.two?.preview, undefined, "All old ready previews are invalidated immediately");
	release();
	await changed;
	openMigration("settings");
	for (const id of ["one", "two"]) {
		assert.deepEqual(getMigrationState().drafts[id]?.preview?.target.scope, { kind: "project", cwd: "/fixture/new-target" });
		assert.equal(getMigrationState().drafts[id]?.loading, false);
	}
	assert.equal(getMigrationState().busy, null);
});

test("a category target change clears old consent and affects later selections, not unrelated categories", async () => {
	const rows = [skill, second, rule], requests: MigrationPreviewRequest[] = [];
	reset(rows); mockPreview(rows, requests);
	await selectMigrationGroup([skill], true);
	const state = getMigrationState();
	updateMigration({ drafts: { ...state.drafts, one: { ...state.drafts.one!, acknowledged: ["sensitive-values"] } } });
	await changeMigrationBatchTarget("skills", { kind: "project", cwd: "/fixture/project" });
	assert.deepEqual(getMigrationState().drafts.one?.acknowledged, []);
	assert.equal(getMigrationState().drafts.one?.selected, true);
	assert.deepEqual(requests.at(-1)?.target, { kind: "project", cwd: "/fixture/project" });
	await selectMigrationGroup([second], true);
	assert.deepEqual(requests.at(-1)?.target, { kind: "project", cwd: "/fixture/project" });
	assert.equal(getMigrationState().defaultTargets.rules, undefined);
	await changeMigrationBatchTarget("mcp", { kind: "project", cwd: "/fixture/project" });
	await changeMigrationBatchTarget("rules", { kind: "global" });
	assert.equal(requests.length, 3);
	await changeMigrationBatchTarget("skills");
	assert.equal(getMigrationState().defaultTargets.skills, undefined);
	assert.deepEqual(getMigrationState().drafts.one?.request.target, { kind: "project", cwd: "/fixture/project" }, "Reset never silently remaps existing explicit targets");
});
