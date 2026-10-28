import { useState } from "react";
import { useT } from "../../i18n";
import { Button, EmptyState, Spinner } from "../../ui";
import {
	acknowledgeRecovery,
	applyMigrationRecovery,
	attachMigrationJob,
	closeMigration,
	previewMigrationRecovery,
	refreshMigrationHistory,
	retryMigrationFailures,
	stopMigrationJob,
} from "./actions";
import { DiagnosticList } from "./CandidateList";
import { LegacyHistory } from "./LegacyHistory";
import { isActiveJob, resultCounts } from "./model";
import { type MigrationFeatureProps, PreviewText, ScopeLabel } from "./PreviewPanel";
import { updateMigration, useMigrationStore } from "./store";

export function MigrationHistory() {
	const t = useT();
	const jobs = useMigrationStore((state) => state.jobs);
	const loading = useMigrationStore((state) => state.historyLoading);
	return (
		<section className="migration-history">
			<header className="migration-toolbar">
				<h3>{t("migrationHistory")}</h3>
				<Button variant="secondary" disabled={loading} onClick={() => void refreshMigrationHistory()}>
					{t("migrationRefreshHistory")}
				</Button>
			</header>
			{loading ? (
				<output>
					<Spinner />
					{t("migrationLoadingHistory")}
				</output>
			) : null}
			{!jobs.length && !loading ? <EmptyState>{t("migrationNoHistory")}</EmptyState> : null}
			{jobs.map((job) => (
				<div className="migration-history-row" key={job.id}>
					<div>
						<code>{job.createdAt}</code>
						<p>
							{t(`migrationJobStatus.${job.status}`)} · {t("migrationItemCount", { count: job.items.length })}
						</p>
					</div>
					<Button variant="secondary" onClick={() => attachMigrationJob(job.id)}>
						{t("migrationViewJob")}
					</Button>
				</div>
			))}
			<LegacyHistory />
		</section>
	);
}
export function MigrationJobView({ onOpenSession }: MigrationFeatureProps) {
	const t = useT();
	const job = useMigrationStore((state) => state.job);
	const busy = useMigrationStore((state) => state.busy);
	const pollError = useMigrationStore((state) => state.pollError);
	const recovered = useMigrationStore((state) => state.recovered);
	const [opening, setOpening] = useState(false);
	if (!job) return <EmptyState>{t("migrationNoActiveJob")}</EmptyState>;
	const counts = resultCounts(job.items);
	const active = isActiveJob(job);
	return (
		<section className="migration-job" aria-label={t("migrationJob")}>
			<header className="migration-toolbar">
				<h3>{t(`migrationJobStatus.${job.status}`)}</h3>
				{active ? (
					<Button
						variant="secondary"
						disabled={!!busy || job.status === "stopping"}
						onClick={() => void stopMigrationJob()}
					>
						{t(job.status === "stopping" ? "migrationStopping" : "migrationStopRemaining")}
					</Button>
				) : null}
			</header>
			<p className="migration-meta">{t("migrationHideContinues")}</p>
			{pollError ? (
				<div role="alert" className="migration-attention">
					<p>{t("migrationPollFailed")}</p>
					<DiagnosticList diagnostics={[{ code: pollError }]} />
				</div>
			) : null}
			<dl className="migration-counts">
				{(["imported", "skipped", "failed", "notRun", "pending"] as const).map((status) => (
					<div key={status} data-result-count={status}>
						<dt>{t(`migrationCount.${status}`)}</dt>
						<dd>{counts[status]}</dd>
					</div>
				))}
			</dl>
			{!active && (counts.failed || counts.notRun) ? (
				<Button variant="secondary" disabled={!!busy} onClick={() => void retryMigrationFailures()}>
					{t("migrationRetryFailures")}
				</Button>
			) : null}
			{job.items.map((item) => (
				<article key={item.id} className="migration-job-item" data-item-status={item.status}>
					<header className="migration-toolbar">
						<h4>{item.name}</h4>
						<span className="migration-status" data-status={item.status}>
							{t(`migrationItemStatus.${item.status}`)}
						</span>
					</header>
					<p>
						{t(`migrationKind.${item.kind}`)} · {t(`migrationSource.${item.source}`)} ·{" "}
						{t(`migrationAction.${item.action}`)}
					</p>
					<div className="migration-map">
						<div>
							<span>{t("migrationRequestedTarget")}</span>
							<code>{item.requestedTarget.path}</code>
							<ScopeLabel scope={item.requestedTarget.scope} />
						</div>
						{item.actualTarget ? (
							<div>
								<span>{t("migrationActualTarget")}</span>
								<code>{item.actualTarget.path}</code>
								<ScopeLabel scope={item.actualTarget.scope} />
							</div>
						) : null}
					</div>
					<p>{t(`migrationActivation.${item.activation}`)}</p>
					<DiagnosticList diagnostics={item.diagnostics} />
					{item.status === "imported" && item.sessionId && onOpenSession ? (
						<Button
							variant="secondary"
							disabled={opening}
							onClick={async () => {
								if (!item.sessionId) return;
								setOpening(true);
								try {
									await onOpenSession(item.sessionId);
									closeMigration();
								} catch {
									updateMigration({ error: "session-open-failed" });
								} finally {
									setOpening(false);
								}
							}}
						>
							{t("migrationOpenSession")}
						</Button>
					) : null}
					{item.status === "imported" && item.backupId && !active ? (
						recovered.includes(`${job.id}:${item.id}`) ? (
							<p>{t("migrationRestored")}</p>
						) : (
							<Button
								variant="secondary"
								disabled={!!busy}
								onClick={() => void previewMigrationRecovery(job.id, item.id)}
							>
								{t("migrationPreviewRecovery")}
							</Button>
						)
					) : null}
				</article>
			))}
		</section>
	);
}
export function RecoveryReview() {
	const t = useT();
	const recovery = useMigrationStore((state) => state.recovery);
	const acknowledged = useMigrationStore((state) => state.recoveryAcknowledged);
	const busy = useMigrationStore((state) => state.busy);
	return (
		<section className="migration-recovery" hidden={!recovery} aria-label={t("migrationRecovery")}>
			{recovery ? (
				<>
					<h3>{t("migrationRecovery")}</h3>
					<code>{recovery.target.path}</code>
					<p className="migration-attention">{t("migrationRecoveryLimit")}</p>
					<p>{t("migrationRecoveryChanged")}</p>
					<DiagnosticList diagnostics={recovery.diagnostics} />
					<div className="migration-content-review">
						<PreviewText label={t("migrationCurrentContent")} text={recovery.currentText} />
						<PreviewText label={t("migrationRestoredContent")} text={recovery.restoredText} />
					</div>
					<label className="migration-check">
						<input
							type="checkbox"
							checked={acknowledged.includes("rules-impact")}
							disabled={!!busy}
							onChange={(event) => acknowledgeRecovery(event.currentTarget.checked)}
						/>
						{t("migrationRecoveryConsent")}
					</label>
					<Button
						variant="primary"
						disabled={
							!!busy || !acknowledged.includes("rules-impact") || Date.parse(recovery.expiresAt) <= Date.now()
						}
						onClick={() => void applyMigrationRecovery()}
					>
						{t("migrationApplyRecovery")}
					</Button>
				</>
			) : null}
		</section>
	);
}
