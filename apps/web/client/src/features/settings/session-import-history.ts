import type { ImportCandidate, ImportJob, ImportPreview } from "../../state/types";

/** Scan IDs change; persisted source paths keep migrated sessions in history across scans. */
export function pendingImportCandidates(
	candidates: readonly ImportCandidate[],
	jobs: readonly ImportJob[],
): ImportCandidate[] {
	const completedIds = new Set<string>();
	const completedPaths = new Set<string>();
	for (const job of jobs) {
		for (const result of job.results) {
			if (result.status !== "imported" && result.status !== "skipped") continue;
			if (result.candidateId) completedIds.add(result.candidateId);
			if (result.source && result.sourcePath) completedPaths.add(`${result.source}\0${result.sourcePath}`);
		}
	}
	return candidates.filter(
		(candidate) =>
			!completedIds.has(candidate.id) &&
			!(candidate.sourcePath && completedPaths.has(`${candidate.source}\0${candidate.sourcePath}`)),
	);
}

/** Discovery is best-effort: unreviewed, unavailable and unmatched candidates have no row. */
export function displayableImportCandidates(
	candidates: readonly ImportCandidate[],
	jobs: readonly ImportJob[],
	previews: ReadonlyMap<string, ImportPreview>,
	query = "",
): ImportCandidate[] {
	const needle = query.trim().toLowerCase();
	return pendingImportCandidates(candidates, jobs).filter((candidate) => {
		const reviewed = previews.get(candidate.id);
		return (
			!!reviewed &&
			`${reviewed.title || candidate.title} ${candidate.cwd} ${candidate.source} ${candidate.sourcePath ?? ""}`
				.toLowerCase()
				.includes(needle)
		);
	});
}
