import assert from "node:assert/strict";
import test from "node:test";
import { displayableImportCandidates, pendingImportCandidates } from "../client/src/features/settings/session-import-history.ts";
import type { ImportCandidate, ImportJob, ImportPreview } from "../client/src/state/types.ts";

function candidate(overrides: Partial<ImportCandidate> = {}): ImportCandidate {
	return {
		id: "current-candidate",
		source: "codex",
		sessionId: "source-session",
		title: "Source conversation",
		cwd: "/project",
		modified: "2026-10-27T00:00:00.000Z",
		archived: false,
		version: "test",
		sourcePath: "/source/rollout.jsonl",
		...overrides,
	};
}

function job(
	results: ImportJob["results"],
	status: ImportJob["status"] = "completed",
): ImportJob {
	return { id: "job", createdAt: "2026-10-27T00:00:00.000Z", status, total: results.length, results };
}

const result = {
	candidateId: "previous-scan-candidate",
	source: "codex" as const,
	sourcePath: "/source/rollout.jsonl",
	status: "imported" as const,
	sessionId: "target-session",
};

test("successful and already-existing imports leave only unimported candidates", () => {
	const imported = candidate();
	const pending = candidate({ id: "pending", sourcePath: "/source/pending.jsonl" });
	for (const status of ["imported", "skipped"] as const) {
		assert.deepEqual(pendingImportCandidates([imported, pending], [job([{ ...result, status }])]), [pending]);
	}
});

test("persistent source identity hides imports after rescan, reopen, and source append", () => {
	const rescanned = candidate({ id: "new-scan-id", modified: "2026-10-28T00:00:00.000Z" });
	const restoredJobs = JSON.parse(JSON.stringify([job([result])])) as ImportJob[];
	assert.deepEqual(pendingImportCandidates([rescanned], restoredJobs), []);
});

test("failed results and unprocessed cancelled selections remain retryable", () => {
	const pending = candidate();
	assert.deepEqual(pendingImportCandidates([pending], [job([{ ...result, status: "failed" }])]), [pending]);
	assert.deepEqual(pendingImportCandidates([pending], [job([], "cancelled")]), [pending]);
});

test("successful results leave the list before their running batch settles", () => {
	for (const status of ["running", "cancelled", "interrupted"] as const) {
		assert.deepEqual(pendingImportCandidates([candidate()], [job([result], status)]), []);
	}
});

test("matching titles, other applications, and other source paths are not hidden", () => {
	const otherSource = candidate({ id: "other-app", source: "qoder" });
	const otherPath = candidate({ id: "other-file", sourcePath: "/source/other.jsonl" });
	assert.deepEqual(pendingImportCandidates([otherSource, otherPath], [job([result])]), [otherSource, otherPath]);
});

test("legacy results without stable paths match only the current candidate ID", () => {
	const current = candidate();
	assert.deepEqual(pendingImportCandidates([current], [job([{ candidateId: current.id, status: "imported" }])]), []);
	assert.deepEqual(pendingImportCandidates([current], [job([{ candidateId: "old-id", status: "imported" }])]), [current]);
});

function preview(value: ImportCandidate): ImportPreview {
	return { ...value, fingerprint: "fixture", messageCount: 1, toolCount: 0, warnings: [], excerpt: value.title };
}

test("discovery only displays successfully previewed candidates", () => {
	const healthy = candidate();
	const failed = candidate({ id: "failed", sourcePath: "/source/bad.jsonl" });
	const previews = new Map([[healthy.id, preview(healthy)]]);
	assert.deepEqual(displayableImportCandidates([healthy, failed], [], previews), [healthy]);
	assert.deepEqual(displayableImportCandidates([healthy, failed], [], new Map()), []);
});

test("search without matches is empty and only matches reviewed candidate metadata", () => {
	const healthy = candidate();
	const previews = new Map([[healthy.id, preview(healthy)]]);
	assert.deepEqual(displayableImportCandidates([healthy], [], previews, "not-present"), []);
	assert.deepEqual(displayableImportCandidates([healthy], [], previews, " ROLLOUT.JSONL "), [healthy]);
	assert.deepEqual(displayableImportCandidates([healthy], [job([result])], previews), []);
});

test("removing a stale preview quietly removes the candidate", () => {
	const healthy = candidate();
	const previews = new Map([[healthy.id, preview(healthy)]]);
	previews.delete(healthy.id);
	assert.deepEqual(displayableImportCandidates([healthy], [], previews), []);
});

test("a later failed retry does not restore an already imported source", () => {
	const jobs = [job([{ ...result, status: "failed" }]), job([result])];
	assert.deepEqual(pendingImportCandidates([candidate()], jobs), []);
});
