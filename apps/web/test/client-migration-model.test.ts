import assert from "node:assert/strict";
import test from "node:test";
import type { MigrationCandidate, MigrationItemResult, MigrationJob, MigrationPlan, MigrationPreview } from "../client/src/state/types.ts";
import {
	acceptJob, adoptMigrationPlan, backoffDelay, collectSelections, draftReady, hasConsent, initialPreviewRequest, invalidateDraft,
	isActionable, isActiveJob, isIndependentCopy, type MigrationDraft, planReady, resultCounts,
} from "../client/src/features/migration/model.ts";
import { migrationMessages } from "../client/src/i18n/migration-messages.ts";
import { isJob, isJobs, isPreview, isScan } from "../client/src/features/migration/transport.ts";

const candidate: MigrationCandidate = {
	id: "fixture-rule", kind: "rules", source: "claude-code", name: "fixture-rule", sourcePath: "/fixture/source/CLAUDE.md",
	sourceScope: { kind: "global" }, holding: "external", readiness: "ready", needsMigration: true, diagnostics: [],
};
function preview(patch: Partial<MigrationPreview> = {}): MigrationPreview {
	return {
		id: "fixture-preview", candidate, fingerprint: "fixture-hash", expiresAt: "2100-01-01T00:00:00Z",
		target: { scope: { kind: "global" }, path: "/fixture/target/AGENTS.md", name: "AGENTS.md" },
		action: "create", allowedActions: ["create", "skip"], sourceText: "Fixture rule", resultText: "Fixture rule",
		ruleImpact: { before: [], after: ["/fixture/target/AGENTS.md"], shadowed: [], fingerprint: "fixture-impact", backupRequired: false },
		requiredAcknowledgements: ["rules-impact"], warnings: [], blockers: [], activation: "next-resource-load", ...patch,
	};
}
function draft(p: MigrationPreview = preview()): MigrationDraft {
	return { request: { candidateId: candidate.id }, selected: true, preview: p, acknowledged: [], ruleChecked: false, loading: false };
}
function job(status: MigrationJob["status"], revision = 1): MigrationJob {
	return { id: "fixture-job", createdAt: "2026-01-01T00:00:00Z", revision, status, items: [] };
}
test("session previews let the backend resolve original cwd before validating explicit targets", () => {
	const session: MigrationCandidate = { ...candidate, kind: "sessions", sourceScope: { kind: "project", cwd: "/fixture/native-project" } };
	assert.deepEqual(initialPreviewRequest(session, ["/fixture/native-project"]), { candidateId: session.id });
	assert.deepEqual(initialPreviewRequest(session, ["/fixture/other-project"]), { candidateId: session.id });
	assert.deepEqual(initialPreviewRequest({ ...session, sourceScope: { kind: "global" } }, ["/fixture/other-project"]), { candidateId: session.id });
	assert.deepEqual(initialPreviewRequest({ ...candidate, sourceScope: session.sourceScope }, ["/fixture/native-project"]), { candidateId: candidate.id });
});

test("rule writes need a clean preview, not a separate consent step", () => {
	for (const action of ["create", "append", "replace"] as const) {
		const p = preview({ action, requiredAcknowledgements: [] });
		assert.equal(hasConsent(p, []), true);
		assert.equal(draftReady(draft(p)), true);
	}
});
test("target/action/input changes invalidate preview and consent without mutating selection", () => {
	const original = { ...draft(), acknowledged: ["rules-impact" as const], ruleChecked: true };
	const changed = invalidateDraft(original, { candidateId: candidate.id, target: { kind: "project", cwd: "/fixture/project" }, action: "append" });
	assert.equal(changed.selected, true);
	assert.equal(changed.preview, undefined);
	assert.deepEqual(changed.acknowledged, []);
	assert.equal(changed.ruleChecked, false);
	assert.equal(original.preview?.id, "fixture-preview");
	assert.deepEqual(original.acknowledged, ["rules-impact"]);
});
test("readiness and holding are authoritative, directory names never imply migration", () => {
	assert.equal(isActionable(candidate), true);
	assert.equal(isActionable({ ...candidate, needsMigration: false }), false);
	for (const readiness of ["disabled", "shadowed", "untrusted", "unsupported", "unknown"] as const) assert.equal(isActionable({ ...candidate, readiness }), false);
	assert.equal(isActionable({ ...candidate, holding: "plugin" }), false);
	const reference = { ...candidate, kind: "skills" as const, holding: "reference" as const, needsMigration: false };
	assert.equal(isIndependentCopy(reference), true);
	assert.equal(isActionable(reference), false);
});
test("final plan exactly matches ready selections and cannot bypass blockers or expiry", () => {
	const p = preview();
	const confirmed = { ...draft(p), ruleChecked: true, acknowledged: ["rules-impact" as const] };
	const drafts = { [candidate.id]: confirmed };
	const plan: MigrationPlan = { id: "fixture-plan", digest: "fixture-digest", expiresAt: p.expiresAt, items: [p] };
	assert.deepEqual(collectSelections(drafts), [{ previewId: p.id, acknowledged: ["rules-impact"] }]);
	assert.equal(planReady(plan, drafts), true);
	assert.equal(planReady({ ...plan, items: [preview({ id: "different-preview" })] }, drafts), false);
	assert.equal(planReady({ ...plan, items: [preview({ fingerprint: "changed-content" })] }, drafts), false);
	const other = preview({ id: "other-preview", candidate: { ...candidate, id: "other-candidate" } });
	assert.equal(planReady({ ...plan, items: [p, p] }, { ...drafts, "other-candidate": { ...confirmed, preview: other } }), false);
	assert.equal(planReady({ ...plan, expiresAt: "2000-01-01T00:00:00Z" }, drafts), false);
	assert.equal(collectSelections({ [candidate.id]: { ...confirmed, preview: preview({ blockers: [{ code: "target-conflict" }] }) } }), null);
	assert.equal(collectSelections({ [candidate.id]: { ...confirmed, loading: true } }), null);
	assert.equal(collectSelections({ [candidate.id]: { ...confirmed, error: "network-error" } }), null);
});
test("skip-blocked requires explicit opt-in and never grants missing rule or credential consent", () => {
	const p = preview();
	const ready = { ...draft(p), ruleChecked: true, acknowledged: ["rules-impact" as const] };
	const pending = { ...draft(), request: { candidateId: "pending" }, preview: undefined, loading: true };
	const failed = { ...pending, request: { candidateId: "failed" }, loading: false, error: "network-error" };
	const all = { [candidate.id]: ready, pending, failed };
	assert.equal(collectSelections(all), null);
	assert.deepEqual(collectSelections(all, true), [{ previewId: p.id, acknowledged: ["rules-impact"] }]);
	const plan: MigrationPlan = { id: "ready-only", digest: "digest", expiresAt: p.expiresAt, items: [p] };
	assert.equal(adoptMigrationPlan(plan, all), null);
	const adopted = adoptMigrationPlan(plan, all, true);
	assert.ok(adopted);
	assert.equal(adopted.pending.selected, true, "Omitted rows remain visible as requested choices");
	assert.equal(planReady(plan, adopted), false);
	assert.equal(planReady(plan, adopted, Date.now(), true), true);
	assert.deepEqual(collectSelections({ rule: draft() }, true), []);
});

test("scope, independent-copy and sensitive acknowledgements stay independent", () => {
	const p = preview({ candidate: { ...candidate, kind: "mcp" }, action: "import", requiredAcknowledgements: ["scope-expansion", "sensitive-values"] });
	assert.equal(hasConsent(p, ["scope-expansion"]), false);
	assert.equal(hasConsent(p, ["sensitive-values"]), false);
	assert.equal(hasConsent(p, ["scope-expansion", "sensitive-values"]), true);
});
test("job completion is not all-success and read backoff is capped", () => {
	const statuses: MigrationItemResult["status"][] = ["imported", "skipped", "failed", "not-run", "pending", "running"];
	const items = statuses.map((status, index): MigrationItemResult => ({ id: `fixture-${index}`, candidateId: candidate.id,
		kind: "rules", source: candidate.source, name: "fixture", sourceScope: candidate.sourceScope,
		requestedTarget: preview().target, action: "create", status, diagnostics: [], activation: "next-resource-load" }));
	assert.deepEqual(resultCounts(items), { imported: 1, skipped: 1, failed: 1, notRun: 1, pending: 2 });
	assert.equal(isActiveJob(job("completed")), false);
	assert.equal(isActiveJob(job("stopping")), true);
	assert.equal(acceptJob(job("completed", 5), job("running", 4)).status, "completed");
	assert.equal(backoffDelay(0), 1000);
	assert.equal(backoffDelay(100), 30_000);
});
test("historical prompt results remain readable but cannot enter current scans or previews", () => {
	const old = { ...job("completed"), items: [{ id: "old", candidateId: "old-candidate", kind: "prompts", source: "codex",
		name: "old-template", sourceScope: { kind: "global" }, requestedTarget: preview().target, action: "copy",
		status: "imported", diagnostics: [], activation: "next-resource-load" }] };
	assert.equal(isJob(old), true);
	assert.equal(isJobs({ jobs: [job("completed"), old] }), true);
	assert.equal(isPreview({ ...preview(), candidate: { ...candidate, kind: "prompts" } }), false);
	assert.equal(isScan({ candidates: [{ ...candidate, kind: "prompts" }], sources: [], truncated: false }), false);
});

test("MCP final allocation updates preview bindings without granting new consent", () => {
	const c = { ...candidate, kind: "mcp" as const };
	const before = preview({ candidate: c, action: "import", allowedActions: ["import", "skip"], requiredAcknowledgements: [], ruleImpact: undefined, activation: "disabled" });
	const drafts = { [c.id]: draft(before) };
	const allocated = { ...before, id: "allocated", fingerprint: "allocated-hash", target: { ...before.target, name: "docs-codex" } };
	const p: MigrationPlan = { id: "plan", digest: "digest", expiresAt: allocated.expiresAt, items: [allocated] };
	const next = adoptMigrationPlan(p, drafts);
	assert.ok(next);
	assert.equal(planReady(p, next), true);
	assert.equal(next[c.id].request.targetName, undefined);
	assert.equal(adoptMigrationPlan({ ...p, items: [{ ...allocated, requiredAcknowledgements: ["sensitive-values"] }] }, drafts), null);
	assert.equal(adoptMigrationPlan({ ...p, items: [] }, drafts), null);
});

test("wire guards reject malformed states and preserve actual source names", () => {
	assert.equal(isPreview(preview()), true);
	assert.equal(isPreview(preview({ candidate: { ...candidate, source: "claude-code" } })), true);
	assert.equal(isPreview({ ...preview(), blockers: "none" }), false);
	assert.equal(isPreview({ ...preview(), requiredAcknowledgements: ["unknown-consent"] }), false);
	assert.equal(isJob(job("completed")), true);
	assert.equal(isJob({ ...job("completed"), revision: 1.5 }), false);
	assert.equal(isScan({ candidates: [{ ...candidate, readiness: "connected" }], sources: [], truncated: false }), false);
});
test("migration dictionaries have bilingual parity and neutral design names", () => {
	assert.deepEqual(Object.keys(migrationMessages.zh).sort(), Object.keys(migrationMessages.en).sort());
	for (const dictionary of Object.values(migrationMessages)) {
		for (const value of Object.values(dictionary)) assert.equal(/zcode|inspired|[\w]+-style/i.test(value), false);
	}
	assert.match(migrationMessages.zh["migrationJobStatus.completed"], /逐项/);
	assert.match(migrationMessages.en.migrationRuleGlobalScope, /Desktop, Web, CLI/);
});
