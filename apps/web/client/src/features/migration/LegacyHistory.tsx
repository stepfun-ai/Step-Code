import { useEffect, useState } from "react";
import { useT } from "../../i18n";
import { api } from "../../lib/api";
import { openSessionWithOutcome } from "../../state/session";
import { useAppStore } from "../../state/store";
import { Button, EmptyState, Spinner } from "../../ui";
import { closeSettings } from "../settings/actions";

type LegacyResultStatus = "imported" | "skipped" | "failed" | "unknown";
type LegacyJobStatus = "running" | "completed" | "cancelled" | "interrupted" | "unknown";
interface LegacyResult {
	readonly status: LegacyResultStatus;
	readonly candidateId?: string;
	readonly source?: string;
	readonly sourcePath?: string;
	readonly title?: string;
	readonly requestedCwd?: string;
	readonly sessionId?: string;
	readonly hasWarning: boolean;
}
interface LegacyJob {
	readonly id?: string;
	readonly createdAt?: string;
	readonly status: LegacyJobStatus;
	readonly total?: number;
	readonly results: readonly LegacyResult[];
	readonly resultsUnknown: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}
function parseResult(value: unknown): LegacyResult {
	const row = isRecord(value) ? value : undefined;
	const status = row?.status;
	return {
		status: status === "imported" || status === "skipped" || status === "failed" ? status : "unknown",
		source:
			typeof row?.source === "string" && ["codex", "claude-code", "workbuddy", "qoder"].includes(row.source)
				? row.source
				: undefined,
		candidateId: text(row?.candidateId),
		sourcePath: text(row?.sourcePath),
		title: text(row?.title),
		// Old journals record the selected directory, not a verified final target.
		requestedCwd: text(row?.cwd),
		sessionId:
			typeof row?.sessionId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(row.sessionId)
				? row.sessionId
				: undefined,
		hasWarning: !!text(row?.warning),
	};
}

/** Preserve unknown rows; malformed history is not an empty successful history. */
export function parseLegacyHistory(value: unknown): readonly LegacyJob[] {
	const body = isRecord(value) ? value : undefined;
	if (!Array.isArray(body?.jobs)) throw new Error("legacy-history-invalid");
	return body.jobs.map((value): LegacyJob => {
		const job = isRecord(value) ? value : undefined;
		const status = job?.status;
		return {
			id: text(job?.id),
			createdAt:
				typeof job?.createdAt === "string" && Number.isFinite(Date.parse(job.createdAt))
					? new Date(job.createdAt).toISOString()
					: undefined,
			status:
				status === "running" || status === "completed" || status === "cancelled" || status === "interrupted"
					? status
					: "unknown",
			total:
				typeof job?.total === "number" && Number.isSafeInteger(job.total) && job.total >= 0 ? job.total : undefined,
			results: Array.isArray(job?.results) ? job.results.map(parseResult) : [],
			resultsUnknown: !Array.isArray(job?.results),
		};
	});
}

export async function readLegacyHistory(signal?: AbortSignal): Promise<readonly LegacyJob[]> {
	return parseLegacyHistory(await api<unknown>("/api/v1/session-imports", { signal }));
}

export async function openLegacySession(result: LegacyResult): Promise<void> {
	if (result.status !== "imported" || !result.sessionId) return;
	if ((await openSessionWithOutcome(result.sessionId, { reportErrors: false })) !== "opened") {
		throw new Error("legacy-session-open-failed");
	}
	closeSettings();
}

export function LegacyHistory() {
	const t = useT();
	const visible = useAppStore((state) => state.ui.settingsPage === "migration");
	const [jobs, setJobs] = useState<readonly LegacyJob[]>([]);
	const [loadingRequest, setLoadingRequest] = useState<number | null>(null);
	const loading = loadingRequest !== null;
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState(false);
	const [refresh, setRefresh] = useState(0);
	const [opening, setOpening] = useState(false);
	const [openError, setOpenError] = useState(false);
	useEffect(() => {
		if (!visible) return;
		const controller = new AbortController();
		let current = true;
		setLoadingRequest(refresh);
		setError(false);
		void readLegacyHistory(controller.signal)
			.then((next) => {
				if (current) {
					setJobs(next);
					setLoaded(true);
				}
			})
			.catch(() => {
				if (current) setError(true);
			})
			.finally(() => {
				if (current) setLoadingRequest(null);
			});
		return () => {
			current = false;
			controller.abort();
		};
	}, [visible, refresh]);
	return (
		<section className="migration-history" aria-label={t("migrationLegacyHistory")}>
			<header className="migration-toolbar">
				<h3>{t("migrationLegacyHistory")}</h3>
				<Button variant="secondary" disabled={loading || !visible} onClick={() => setRefresh((value) => value + 1)}>
					{t("migrationRefreshHistory")}
				</Button>
			</header>
			<p className="migration-meta">{t("migrationLegacyReadOnly")}</p>
			{loading ? (
				<output>
					<Spinner />
					{t("migrationLoadingHistory")}
				</output>
			) : null}
			{error ? (
				<p role="alert" className="migration-attention">
					{t("migrationLegacyLoadFailed")}
				</p>
			) : null}
			{openError ? (
				<p role="alert" className="migration-attention">
					{t("migrationLegacyOpenFailed")}
				</p>
			) : null}
			{loaded && !jobs.length && !loading && !error ? <EmptyState>{t("migrationLegacyEmpty")}</EmptyState> : null}
			{jobs.map((job, index) => (
				<article
					className="migration-job-item"
					key={`${job.id ?? "unknown"}:${index}`}
					data-legacy-job-status={job.status}
				>
					<h4>{job.createdAt ?? t("migrationLegacyUnknown")}</h4>
					<p>{t(`migrationLegacyJob.${job.status}`)}</p>
					<p>
						{t("migrationLegacyRecorded", {
							recorded: job.results.length,
							total: job.total ?? t("migrationLegacyUnknown"),
						})}
					</p>
					{job.resultsUnknown ? <p className="migration-attention">{t("migrationLegacyResultsUnknown")}</p> : null}
					{job.results.map((result, resultIndex) => (
						<div
							className="migration-job-item"
							key={`${result.candidateId ?? result.sessionId ?? "unknown"}:${resultIndex}`}
							data-legacy-result-status={result.status}
						>
							<h4>{result.title ?? t("migrationLegacyUntitled")}</h4>
							<p>
								{t(`migrationLegacyResult.${result.status}`)} ·{" "}
								{result.source ? t(`migrationSource.${result.source}`) : t("migrationLegacyUnknown")}
							</p>
							<dl className="migration-map">
								<div>
									<dt>{t("migrationSourcePath")}</dt>
									<dd>
										<code>{result.sourcePath ?? t("migrationLegacyUnknown")}</code>
									</dd>
								</div>
								<div>
									<dt>{t("migrationLegacyRequestedCwd")}</dt>
									<dd>
										<code>{result.requestedCwd ?? t("migrationLegacyUnknown")}</code>
									</dd>
								</div>
								<div>
									<dt>{t("migrationActualTarget")}</dt>
									<dd>{t("migrationLegacyActualUnknown")}</dd>
								</div>
							</dl>
							{result.status === "failed" ? (
								<p className="migration-attention">{t("migrationLegacyFailure")}</p>
							) : null}
							{result.hasWarning ? <p className="migration-attention">{t("migrationLegacyWarning")}</p> : null}
							{result.status === "imported" && result.sessionId ? (
								<Button
									variant="secondary"
									disabled={opening}
									onClick={async () => {
										setOpening(true);
										setOpenError(false);
										try {
											await openLegacySession(result);
										} catch {
											setOpenError(true);
										} finally {
											setOpening(false);
										}
									}}
								>
									{t("migrationOpenSession")}
								</Button>
							) : result.status === "imported" ? (
								<p>{t("migrationLegacySessionUnknown")}</p>
							) : null}
						</div>
					))}
				</article>
			))}
		</section>
	);
}
