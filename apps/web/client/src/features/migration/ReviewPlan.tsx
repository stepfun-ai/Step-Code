import { useT } from "../../i18n";
import { Button, EmptyState, Spinner } from "../../ui";
import { createMigrationPlan, deselectCandidate, setMigrationKind } from "./actions";
import { DiagnosticList } from "./CandidateList";
import { draftReady, type MigrationDraft } from "./model";
import { updateMigration, useMigrationStore } from "./store";

const TARGET_BLOCKERS = [
	"session-workspace-not-recorded",
	"session-original-directory-missing",
	"session-target-unavailable",
	"session-target-required",
];
function blockedNeedsTarget(draft: MigrationDraft, kind: string | undefined): boolean {
	if (kind !== "sessions") return false;
	if (draft.preview) return draft.preview.blockers.some((item) => TARGET_BLOCKERS.includes(item.code));
	return draft.request.target?.kind !== "project";
}
/** Requested but blocked rows stay local; only explicitly approved ready items enter a server plan. */
export function FinalPlan() {
	const t = useT();
	const drafts = useMigrationStore((state) => state.drafts);
	const plan = useMigrationStore((state) => state.plan);
	const skipBlocked = useMigrationStore((state) => state.skipBlocked);
	const busy = useMigrationStore((state) => state.busy);
	const selected = Object.entries(drafts).filter(([, draft]) => draft.selected);
	const ready = selected.filter(([, draft]) => draftReady(draft));
	const blocked = selected.filter(([, draft]) => !draftReady(draft));
	const checking = selected.filter(([, draft]) => draft.loading || (!draft.preview && !draft.error));
	if (!selected.length)
		return (
			<section className="migration-final-plan">
				<EmptyState>
					<h3>{t("migrationNoSelectionTitle")}</h3>
					<p>{t("migrationNoSelectionBody")}</p>
					<Button variant="primary" onClick={() => setMigrationKind("sessions")}>
						{t("migrationGoSelect")}
					</Button>
				</EmptyState>
			</section>
		);
	return (
		<section className="migration-final-plan">
			<div className="migration-sectionhead">
				<h3>{t("migrationCheckPlan")}</h3>
				<span className="migration-pill">{t("migrationNotWrittenYet")}</span>
			</div>
			<div className="migration-plan-summary">
				<div>
					<b>{ready.length}</b>
					<span>{t("migrationSummaryReady")}</span>
				</div>
				<div className="migration-summary-blocked">
					<b>{blocked.length}</b>
					<span>{t("migrationSummaryBlocked")}</span>
				</div>
				<div>
					<b>{selected.length}</b>
					<span>{t("migrationSummaryTotal")}</span>
				</div>
			</div>
			{checking.length ? (
				<output className="migration-checking">
					<Spinner /> {t("migrationCheckingNotice", { count: checking.length })}
				</output>
			) : null}
			{ready.length ? <h4 className="migration-plan-section">{t("migrationReadySection")}</h4> : null}
			{ready.map(([id, draft]) => (
				<PlanRow key={id} id={id} draft={draft} ready />
			))}
			{blocked.length ? (
				<h4 className="migration-plan-section migration-plan-section-blocked">{t("migrationBlockedSection")}</h4>
			) : null}
			{blocked.map(([id, draft]) => (
				<PlanRow key={id} id={id} draft={draft} />
			))}
			{blocked.length ? (
				<label className="migration-check migration-skip-blocked">
					<input
						id="migrationSkipBlocked"
						type="checkbox"
						checked={skipBlocked}
						disabled={!!busy}
						onChange={(event) => {
							updateMigration({ skipBlocked: event.currentTarget.checked, plan: null, startKey: null });
							if (event.currentTarget.checked) void createMigrationPlan();
						}}
					/>
					{t("migrationSkipBlockedConsent", { count: blocked.length })}
				</label>
			) : null}
			{!plan && !blocked.length && selected.length ? (
				<Button variant="primary" disabled={!!busy} onClick={() => void createMigrationPlan()}>
					{t("migrationReviewPlan")}
				</Button>
			) : null}
			<p className="migration-plan-footnote">{t("migrationPlanFootnote")}</p>
		</section>
	);
}
function PlanRow({
	id,
	draft,
	ready,
}: {
	readonly id: string;
	readonly draft: MigrationDraft;
	readonly ready?: boolean;
}) {
	const t = useT();
	const scan = useMigrationStore((state) => state.scan);
	const plan = useMigrationStore((state) => state.plan);
	const busy = useMigrationStore((state) => state.busy);
	const fromPlan = plan?.items.find((item) => item.candidate.id === id);
	const preview = fromPlan ?? draft.preview;
	const candidate = preview?.candidate ?? scan?.candidates.find((item) => item.id === id);
	const reasons = draft.loading
		? [{ code: "preview-pending" }]
		: draft.error
			? [{ code: draft.error }]
			: !preview
				? [{ code: "preview-required" }]
				: preview.blockers.length
					? preview.blockers
					: ready
						? []
						: [{ code: "consent-required" }];
	return (
		<article className="migration-plan-item" data-review-state={ready ? "ready" : "blocked"}>
			<span className={`migration-pill${ready ? " migration-pill-success" : " migration-pill-attention"}`}>
				{ready ? "✓" : "!"}
			</span>
			<div className="migration-plan-info">
				<strong>{candidate?.name ?? id}</strong>
				<span className="migration-meta">
					{candidate ? `${t(`migrationSource.${candidate.source}`)} · ` : ""}
					{preview ? t(`migrationAction.${preview.action}`) : ""}
				</span>
				{preview ? (
					<code>{preview.target.scope.kind === "project" ? preview.target.scope.cwd : preview.target.path}</code>
				) : null}
				{preview?.candidate.kind === "mcp" ? (
					<p className="migration-meta">
						{t("migrationMcpTargetName")}: {preview.target.name}
					</p>
				) : null}
				<DiagnosticList diagnostics={reasons} />
			</div>
			<Button
				disabled={!!busy}
				onClick={() => {
					if (candidate) {
						setMigrationKind(candidate.kind);
						updateMigration({ focusedId: id });
					}
				}}
			>
				{t(
					!ready && blockedNeedsTarget(draft, candidate?.kind)
						? "migrationPickTargetShort"
						: ready
							? "migrationAdjustItem"
							: "migrationGoEdit",
				)}
			</Button>
			<Button disabled={!!busy} onClick={() => deselectCandidate(id)}>
				{t("migrationRemove")}
			</Button>
		</article>
	);
}
