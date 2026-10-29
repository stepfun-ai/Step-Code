import { useState } from "react";
import { useT } from "../../i18n";
import { sessionModifiedLabel } from "../../lib/format";
import type { MigrationItemResult } from "../../state/types";
import { Button, EmptyState, Spinner } from "../../ui";
import {
	acknowledgeRecovery,
	applyMigrationRecovery,
	attachMigrationJob,
	closeMigration,
	previewMigrationRecovery,
	refreshMigrationHistory,
	retryMigrationFailures,
} from "./actions";
import { DiagnosticList } from "./CandidateList";
import { isActiveJob, resultCounts } from "./model";
import { type MigrationFeatureProps, PreviewText } from "./PreviewPanel";
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
					<div className="migration-history-info">
						<strong>
							{t(`migrationJobStatus.${job.status}`)} · {t("migrationItemCount", { count: job.items.length })}
							{sessionModifiedLabel(job.createdAt) ? ` · ${sessionModifiedLabel(job.createdAt)}` : ""}
						</strong>
						<code>{job.createdAt}</code>
					</div>
					<Button variant="secondary" onClick={() => attachMigrationJob(job.id)}>
						{t("migrationViewJob")}
					</Button>
				</div>
			))}
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
					<Button variant="secondary" disabled={!!busy || job.status === "stopping"} onClick={closeMigration}>
						{t(job.status === "stopping" ? "migrationStopping" : "migrationStopRemaining")}
					</Button>
				) : null}
			</header>
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
			<div
				className="migration-progress"
				role="progressbar"
				aria-label={t("migrationJob")}
				aria-valuemin={0}
				aria-valuemax={job.items.length}
				aria-valuenow={counts.imported + counts.skipped + counts.failed + counts.notRun}
			>
				<i
					style={{
						width: `${
							job.items.length
								? ((counts.imported + counts.skipped + counts.failed + counts.notRun) / job.items.length) * 100
								: 0
						}%`,
					}}
				/>
			</div>
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
						{t(`migrationSource.${item.source}`)} {t(`migrationKind.${item.kind}`)}{" "}
						{t(`migrationAction.${item.action}`)}
					</p>
					<JobItemTarget item={item} />
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
/** One line: the project (when scoped) and where the item went, or was asked to go before it finished. */
function JobItemTarget({ item }: { readonly item: MigrationItemResult }) {
	const t = useT();
	const target = item.status === "imported" ? (item.actualTarget ?? item.requestedTarget) : item.requestedTarget;
	const migrated = item.status === "imported";
	const values = {
		path: target.path,
		cwd: target.scope.kind === "project" ? target.scope.cwd : "",
		source: t(`migrationSource.${item.source}`),
	};
	const key =
		target.scope.kind === "project"
			? item.kind === "sessions"
				? migrated
					? "migrationJobSessionMigratedTo"
					: "migrationJobSessionTarget"
				: migrated
					? "migrationJobProjectMigratedTo"
					: "migrationJobProjectTarget"
			: migrated
				? "migrationJobMigratedTo"
				: "migrationJobTarget";
	return (
		<p className="migration-job-target" data-job-target="">
			{t(key, values)}
		</p>
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
