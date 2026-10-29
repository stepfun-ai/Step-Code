import type {
	MigrationAcknowledgement,
	MigrationCandidate,
	MigrationItemResult,
	MigrationJob,
	MigrationKind,
	MigrationPlan,
	MigrationPreview,
	MigrationPreviewRequest,
	MigrationSelection,
} from "../../state/types";

export const MIGRATION_KINDS: readonly MigrationKind[] = ["sessions", "mcp", "rules"];
export interface MigrationDraft {
	readonly request: MigrationPreviewRequest;
	readonly selected: boolean;
	readonly preview?: MigrationPreview;
	readonly acknowledged: readonly MigrationAcknowledgement[];
	readonly ruleChecked: boolean;
	readonly loading: boolean;
	readonly error?: string;
}

export function initialPreviewRequest(
	candidate: MigrationCandidate,
	_offeredProjects: readonly string[],
): MigrationPreviewRequest {
	return { candidateId: candidate.id, ...(candidate.kind === "mcp" ? { target: { kind: "global" as const } } : {}) };
}

export function isActionable(candidate: MigrationCandidate): boolean {
	return candidate.needsMigration && candidate.readiness === "ready" && candidate.holding !== "plugin";
}
export function isIndependentCopy(candidate: MigrationCandidate): boolean {
	return candidate.kind === "skills" && candidate.holding === "reference" && candidate.readiness === "ready";
}
export function hasConsent(preview: MigrationPreview, acknowledged: readonly MigrationAcknowledgement[]): boolean {
	return (
		preview.requiredAcknowledgements.every((ack) => acknowledged.includes(ack)) &&
		(preview.candidate.kind !== "rules" || preview.action === "skip" || acknowledged.includes("rules-impact"))
	);
}
export function draftReady(draft: MigrationDraft, now = Date.now()): boolean {
	return (
		!!draft.preview &&
		!draft.loading &&
		!draft.error &&
		draft.preview.blockers.length === 0 &&
		(draft.preview.candidate.kind !== "rules" ||
			draft.preview.action === "skip" ||
			(draft.ruleChecked && !!draft.preview.ruleImpact && draft.preview.resultText !== undefined)) &&
		Date.parse(draft.preview.expiresAt) > now &&
		hasConsent(draft.preview, draft.acknowledged)
	);
}
export function invalidateDraft(draft: MigrationDraft, request: MigrationPreviewRequest): MigrationDraft {
	return { request, selected: draft.selected, acknowledged: [], ruleChecked: false, loading: false };
}
export function collectSelections(
	drafts: Readonly<Record<string, MigrationDraft>>,
	skipBlocked = false,
): MigrationSelection[] | null {
	const selected = Object.values(drafts).filter((draft) => draft.selected);
	if (!selected.length || (!skipBlocked && selected.some((draft) => !draftReady(draft)))) return null;
	return selected
		.filter((draft) => draftReady(draft))
		.flatMap((draft) =>
			draft.preview ? [{ previewId: draft.preview.id, acknowledged: [...draft.acknowledged] }] : [],
		);
}
export function adoptMigrationPlan(
	plan: MigrationPlan,
	drafts: Readonly<Record<string, MigrationDraft>>,
	skipBlocked = false,
): Readonly<Record<string, MigrationDraft>> | null {
	const selected = Object.entries(drafts).filter(([, draft]) => draft.selected && (!skipBlocked || draftReady(draft)));
	if (selected.length !== plan.items.length || new Set(plan.items.map((p) => p.candidate.id)).size !== selected.length)
		return null;
	const next = { ...drafts };
	for (const preview of plan.items) {
		const draft = drafts[preview.candidate.id];
		if (!draft?.selected || !draftReady(draft) || !draft.preview) return null;
		if (preview.candidate.kind !== "mcp") {
			if (preview.id !== draft.preview.id || preview.fingerprint !== draft.preview.fingerprint) return null;
		} else if (
			preview.target.path !== draft.preview.target.path ||
			preview.target.scope.kind !== "global" ||
			!hasConsent(preview, draft.acknowledged) ||
			preview.blockers.length ||
			!["import", "skip"].includes(preview.action)
		)
			return null;
		next[preview.candidate.id] = { ...draft, preview };
	}
	return next;
}

export function planReady(
	plan: MigrationPlan,
	drafts: Readonly<Record<string, MigrationDraft>>,
	now = Date.now(),
	skipBlocked = false,
): boolean {
	const selected = Object.values(drafts).filter((draft) => draft.selected && (!skipBlocked || draftReady(draft, now)));
	return (
		Date.parse(plan.expiresAt) > now &&
		plan.items.length > 0 &&
		selected.length === plan.items.length &&
		new Set(plan.items.map((preview) => preview.candidate.id)).size === selected.length &&
		plan.items.every((preview) => {
			const draft = drafts[preview.candidate.id];
			return (
				!!draft?.selected &&
				draft.preview?.id === preview.id &&
				draft.preview.fingerprint === preview.fingerprint &&
				draftReady(draft, now) &&
				preview.blockers.length === 0 &&
				hasConsent(preview, draft.acknowledged)
			);
		})
	);
}
export function isActiveJob(job: MigrationJob | null): boolean {
	return !!job && ["queued", "running", "stopping"].includes(job.status);
}
export function acceptJob(current: MigrationJob | null, incoming: MigrationJob): MigrationJob {
	return current?.id === incoming.id && current.revision > incoming.revision ? current : incoming;
}
export function resultCounts(items: readonly MigrationItemResult[]) {
	return {
		imported: items.filter((item) => item.status === "imported").length,
		skipped: items.filter((item) => item.status === "skipped").length,
		failed: items.filter((item) => item.status === "failed").length,
		notRun: items.filter((item) => item.status === "not-run").length,
		pending: items.filter((item) => item.status === "pending" || item.status === "running").length,
	};
}
export function backoffDelay(failures: number): number {
	return Math.min(30_000, 1000 * 2 ** Math.min(Math.max(failures, 0), 5));
}
