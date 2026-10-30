import assert from "node:assert/strict";
import test from "node:test";
import { candidateRoot, groupMigrationCandidates, groupSelectionState } from "../client/src/features/migration/selection.ts";
import type { MigrationCandidate } from "../client/src/state/types.ts";
import type { MigrationDraft } from "../client/src/features/migration/model.ts";

const skill: MigrationCandidate = {
	id: "one", kind: "skills", source: "claude-code", name: "one", sourcePath: "/fixture/.claude/skills/one/SKILL.md",
	sourceScope: { kind: "global" }, holding: "external", readiness: "ready", needsMigration: true, diagnostics: [],
};
const second = { ...skill, id: "two", name: "two", sourcePath: "/fixture/.claude/skills/two/SKILL.md" };
const draft: MigrationDraft = {
	request: { candidateId: skill.id }, selected: true, acknowledged: [], ruleChecked: false, loading: false,
};

test("source groups join siblings under their actual skill root and distinguish source and scope", () => {
	const groups = groupMigrationCandidates([skill, second, { ...second, id: "codex", source: "codex" },
		{ ...second, id: "project", sourceScope: { kind: "project", cwd: "/fixture/project" } }]);
	assert.equal(groups.length, 3);
	assert.equal(groups[0]?.root, "/fixture/.claude/skills");
	assert.deepEqual(groups[0]?.candidates.map((c) => c.id), ["one", "two"]);
});
test("root grouping supports directory candidates and Windows path separators", () => {
	assert.equal(candidateRoot({ ...skill, sourcePath: "/fixture/.claude/skills/one" }), "/fixture/.claude/skills");
	assert.equal(candidateRoot({ ...skill, sourcePath: "C:\\fixture\\.claude\\skills\\one\\SKILL.md" }), "C:/fixture/.claude/skills");
	assert.equal(candidateRoot({ ...skill, kind: "mcp", sourcePath: "/fixture/.claude.json" }), "/fixture/.claude.json");
	assert.equal(candidateRoot({ ...skill, kind: "sessions", sourceScope: { kind: "project", cwd: "/fixture/project" } }), "/fixture/project");
});
test("sessions group by original cwd across products, and unrecorded cwd forms one placeholder group", () => {
	const session: MigrationCandidate = { ...skill, kind: "sessions", sourceScope: { kind: "project", cwd: "/fixture/store" } };
	const groups = groupMigrationCandidates([session, { ...session, id: "codex", source: "codex" },
		{ ...session, id: "unknown-one", sourceScope: { kind: "global" } },
		{ ...session, id: "unknown-two", source: "qoder", sourceScope: { kind: "global" }, sourcePath: "/different/root" }]);
	assert.equal(groups.length, 2);
	assert.equal(groups[0]?.candidates.length, 2);
	assert.equal(groups[1]?.candidates.length, 2);
	assert.deepEqual(groupSelectionState(groups[0]!.candidates, { one: draft }), { eligible: 2, selected: 1, checked: false, indeterminate: true });
});

test("select-all reflects partial selection without counting already usable or disabled resources", () => {
	const rows = [skill, second, { ...skill, id: "disabled", readiness: "disabled" as const },
		{ ...skill, id: "reference", holding: "reference" as const, needsMigration: false }];
	assert.deepEqual(groupSelectionState(rows, {}), { eligible: 2, selected: 0, checked: false, indeterminate: false });
	assert.deepEqual(groupSelectionState(rows, { one: draft }), { eligible: 2, selected: 1, checked: false, indeterminate: true });
	assert.deepEqual(groupSelectionState(rows, { one: draft, two: draft }), { eligible: 2, selected: 2, checked: true, indeterminate: false });
	assert.equal(groupSelectionState(rows.slice(2), {}).checked, false);
});
