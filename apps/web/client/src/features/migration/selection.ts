import type { MigrationCandidate } from "../../state/types";
import type { MigrationDraft } from "./model";
import { isActionable } from "./model";

export interface MigrationCandidateGroup {
	readonly id: string;
	readonly source: MigrationCandidate["source"];
	readonly scope: MigrationCandidate["sourceScope"];
	readonly root: string;
	readonly candidates: readonly MigrationCandidate[];
}

function parentPath(path: string): string {
	const normalized = path.replaceAll("\\", "/").replace(/\/+$/u, "");
	const index = normalized.lastIndexOf("/");
	return index > 0 ? normalized.slice(0, index) : normalized;
}

/** The grouping names real resource roots, not every source path as an unrelated card. */
export function candidateRoot(candidate: MigrationCandidate): string {
	if (candidate.kind === "sessions" && candidate.sourceScope.kind === "project") return candidate.sourceScope.cwd;
	if (candidate.kind === "mcp") return candidate.sourcePath;
	if (candidate.kind === "skills") {
		const path = /(?:^|[/\\])SKILL\.md$/iu.test(candidate.sourcePath)
			? parentPath(candidate.sourcePath)
			: candidate.sourcePath;
		return parentPath(path);
	}
	return parentPath(candidate.sourcePath);
}

export function groupMigrationCandidates(candidates: readonly MigrationCandidate[]): MigrationCandidateGroup[] {
	const groups = new Map<string, MigrationCandidateGroup>();
	for (const candidate of candidates) {
		const root = candidateRoot(candidate);
		const id =
			candidate.kind === "sessions"
				? JSON.stringify(["sessions", candidate.sourceScope.kind === "project" ? root : ""])
				: JSON.stringify([candidate.source, candidate.sourceScope, root]);
		const current = groups.get(id);
		groups.set(
			id,
			current
				? { ...current, candidates: [...current.candidates, candidate] }
				: { id, source: candidate.source, scope: candidate.sourceScope, root, candidates: [candidate] },
		);
	}
	return [...groups.values()];
}

export function groupSelectionState(
	candidates: readonly MigrationCandidate[],
	drafts: Readonly<Record<string, MigrationDraft>>,
) {
	const eligible = candidates.filter(isActionable);
	const selected = eligible.filter((candidate) => drafts[candidate.id]?.selected).length;
	return {
		eligible: eligible.length,
		selected,
		checked: eligible.length > 0 && selected === eligible.length,
		indeterminate: selected > 0 && selected < eligible.length,
	};
}
