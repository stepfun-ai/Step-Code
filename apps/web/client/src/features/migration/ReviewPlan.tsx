import { useT } from "../../i18n";
import { Button, EmptyState, Spinner } from "../../ui";
import { createMigrationPlan, deselectCandidate, setMigrationKind } from "./actions";
import { draftReady, type MigrationDraft } from "./model";
import { updateMigration, useMigrationStore } from "./store";

/** The checklist lists migratable selections only; anything not ready stays in the wizard. */
export function FinalPlan() {
	const t = useT();
	const drafts = useMigrationStore((state) => state.drafts);
	const plan = useMigrationStore((state) => state.plan);
	const busy = useMigrationStore((state) => state.busy);
	const selected = Object.entries(drafts).filter(([, draft]) => draft.selected);
	const ready = selected.filter(([, draft]) => draftReady(draft));
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
			{checking.length ? (
				<p className="migration-checking" role="status">
					<Spinner /> {t("migrationCheckingNotice", { count: checking.length })}
				</p>
			) : null}
			{ready.map(([id, draft]) => (
				<PlanRow key={id} id={id} draft={draft} ready />
			))}
			{!plan && selected.length && ready.length ? (
				<Button variant="primary" disabled={!!busy} onClick={() => void createMigrationPlan()}>
					{t("migrationReviewPlan")}
				</Button>
			) : null}
		</section>
	);
}
function PlanRow({ id, draft }: { readonly id: string; readonly draft: MigrationDraft; ready?: boolean }) {
	const t = useT();
	const scan = useMigrationStore((state) => state.scan);
	const plan = useMigrationStore((state) => state.plan);
	const busy = useMigrationStore((state) => state.busy);
	const fromPlan = plan?.items.find((item) => item.candidate.id === id);
	const preview = fromPlan ?? draft.preview;
	const candidate = preview?.candidate ?? scan?.candidates.find((item) => item.id === id);
	return (
		<article className="migration-plan-item" data-review-state="ready">
			<span className="migration-pill migration-pill-success">✓</span>
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
				{t("migrationGoEdit")}
			</Button>
			<Button disabled={!!busy} onClick={() => deselectCandidate(id)}>
				{t("migrationRemove")}
			</Button>
		</article>
	);
}
