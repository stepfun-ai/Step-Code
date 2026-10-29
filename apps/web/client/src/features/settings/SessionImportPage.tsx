import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n";
import { api, apiSend } from "../../lib/api";
import { openSession, refreshSessions } from "../../state/session";
import { useAppStore } from "../../state/store";
import type { ImportCandidate, ImportJob, ImportPreview } from "../../state/types";
import { Button, Icon, Popover, SearchInput } from "../../ui";
import { closeSettings } from "./actions";
import { displayableImportCandidates, pendingImportCandidates } from "./session-import-history";
import "./session-import.css";

const PATH = "/api/v1/session-imports";
const SOURCES = [
	{ id: "codex", name: "Codex", logo: "/session-import-logos/codex.svg" },
	{ id: "claude-code", name: "Claude Code", logo: "/session-import-logos/claudecode.svg" },
	{ id: "workbuddy", name: "WorkBuddy", logo: "/session-import-logos/workbuddy.svg" },
	{ id: "qoder", name: "Qoder", logo: "/session-import-logos/qoder-dark.svg" },
] as const;

function groupProjects<T>(rows: readonly T[], cwd: (row: T) => string) {
	const groups = new Map<string, T[]>();
	for (const row of rows) {
		const path = cwd(row);
		const items = groups.get(path) ?? [];
		items.push(row);
		groups.set(path, items);
	}
	return [...groups];
}

function projectName(path: string, fallback: string) {
	return path.split(/[\\/]/u).filter(Boolean).at(-1) || fallback;
}

function remainingSelected(selected: ReadonlySet<string>, job: ImportJob) {
	const completed = new Set(
		job.results.filter((result) => result.status !== "failed").map((result) => result.candidateId),
	);
	return new Set([...selected].filter((id) => !completed.has(id)));
}

export function SessionImportPage() {
	const t = useT();
	const sessions = useAppStore((state) => state.sessions);
	const [candidates, setCandidates] = useState<readonly ImportCandidate[]>([]);
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
	const [previews, setPreviews] = useState<ReadonlyMap<string, ImportPreview>>(new Map());
	const [targets, setTargets] = useState<ReadonlyMap<string, string>>(new Map());
	const [query, setQuery] = useState("");
	const [scanned, setScanned] = useState(false);
	const [scanGeneration, setScanGeneration] = useState(0);
	const [busy, setBusy] = useState(false);
	const [focused, setFocused] = useState<string>();
	const [job, setJob] = useState<ImportJob>();
	const [jobs, setJobs] = useState<readonly ImportJob[]>([]);
	const mounted = useRef(true);
	const autoScanned = useRef(false);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	useEffect(() => {
		if (job?.status !== "running") return;
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const poll = async () => {
			try {
				const next = await api<ImportJob>(`${PATH}/${job.id}`);
				if (stopped) return;
				setJob(next);
				setJobs((current) => [next, ...current.filter((item) => item.id !== next.id)]);
				if (next.status === "running") timer = setTimeout(() => void poll(), 500);
				else {
					setSelected((current) => remainingSelected(current, next));
					await refreshSessions();
				}
			} catch {
				// Read-only retries preserve the last known job state without displaying technical diagnostics.
				if (!stopped) timer = setTimeout(() => void poll(), 2000);
			}
		};
		void poll();
		return () => {
			stopped = true;
			if (timer) clearTimeout(timer);
		};
	}, [job?.id, job?.status]);

	const pending = busy || job?.status === "running";
	const available = useMemo(
		() => displayableImportCandidates(candidates, jobs, previews),
		[candidates, jobs, previews],
	);
	const visible = useMemo(
		() => displayableImportCandidates(candidates, jobs, previews, query),
		[candidates, jobs, previews, query],
	);
	const chosen = available.filter((c) => selected.has(c.id));

	function groupCheckbox(rows: readonly ImportCandidate[], scope: string) {
		const all = rows.length > 0 && rows.every((row) => selected.has(row.id));
		const some = rows.some((row) => selected.has(row.id));
		const label = scope.includes(":")
			? projectName(rows[0]?.cwd ?? "", t("importUnknownProject"))
			: (SOURCES.find((source) => source.id === scope)?.name ?? t("importUnknownSource"));
		return (
			<input
				type="checkbox"
				className="session-import-select-group"
				data-import-select={scope}
				aria-label={`${label} ${t("importSelectGroup")}`}
				disabled={pending || !rows.length}
				checked={all}
				ref={(input) => {
					if (input) input.indeterminate = some && !all;
				}}
				onClick={(event) => event.stopPropagation()}
				onChange={(event) => {
					const checked = event.currentTarget.checked;
					setSelected((current) => {
						const next = new Set(current);
						for (const row of rows) {
							if (checked) next.add(row.id);
							else next.delete(row.id);
						}
						return next;
					});
				}}
			/>
		);
	}

	const preview = useCallback(async (ids: readonly string[], show = true) => {
		setBusy(true);
		if (show && ids[0]) setFocused(ids[0]);
		try {
			for (const id of ids) {
				if (!mounted.current) return;
				try {
					const value = await apiSend<ImportPreview>(`${PATH}/preview`, "POST", { candidateId: id });
					if (!mounted.current) return;
					setPreviews((current) => new Map(current).set(id, value));
				} catch {
					// An unavailable preview must not leave a stale selectable row or open disclosure.
					if (!mounted.current) return;
					setPreviews((current) => {
						const next = new Map(current);
						next.delete(id);
						return next;
					});
					setSelected((current) => {
						const next = new Set(current);
						next.delete(id);
						return next;
					});
					setFocused((current) => (current === id ? undefined : current));
				}
			}
		} finally {
			if (mounted.current) setBusy(false);
		}
	}, []);

	const scan = useCallback(async () => {
		setBusy(true);
		setScanned(false);
		setPreviews(new Map());
		setSelected(new Set());
		setFocused(undefined);
		try {
			const history = await api<{ jobs: ImportJob[] }>(PATH);
			if (!mounted.current) return;
			setJobs(history.jobs);
			setJob(
				(current) =>
					history.jobs.find((item) => item.status === "running") ??
					(current && history.jobs.find((item) => item.id === current.id)),
			);
			const result = await apiSend<{ candidates: ImportCandidate[] }>(`${PATH}/scan`, "POST", {
				includeArchived: false,
			});
			if (!mounted.current) return;
			setCandidates(result.candidates);
			setSelected(new Set());
			setPreviews(new Map());
			setTargets(new Map(result.candidates.map((candidate) => [candidate.id, candidate.cwd])));
			setFocused(undefined);
			setScanned(true);
			setScanGeneration((current) => current + 1);
			await preview(
				pendingImportCandidates(result.candidates, history.jobs).map((candidate) => candidate.id),
				false,
			);
		} catch {
			// Preserve known history and metadata; failed optional discovery renders no source list.
			if (mounted.current) {
				setScanned(false);
				setPreviews(new Map());
			}
		} finally {
			if (mounted.current) setBusy(false);
		}
	}, [preview]);
	useEffect(() => {
		if (autoScanned.current) return;
		autoScanned.current = true;
		void scan();
	}, [scan]);

	async function start(source: ImportCandidate["source"]) {
		const platformChosen = chosen.filter((candidate) => candidate.source === source);
		if (
			!platformChosen.length ||
			platformChosen.length > 100 ||
			!platformChosen.every((c) => previews.has(c.id) && targets.get(c.id)?.trim())
		)
			return;
		setBusy(true);
		try {
			const next = await apiSend<ImportJob>(PATH, "POST", {
				selections: platformChosen.map((c) => ({
					candidateId: c.id,
					fingerprint: previews.get(c.id)?.fingerprint,
					cwd: targets.get(c.id),
				})),
			});
			if (mounted.current) {
				setJob(next);
				if (next.status !== "running") setSelected((current) => remainingSelected(current, next));
				setJobs((current) => [next, ...current.filter((item) => item.id !== next.id)]);
			}
		} catch {
			// Submission is unconfirmed; keep selection and history, never auto-retry or invent success.
		} finally {
			if (mounted.current) setBusy(false);
		}
	}

	async function cancel() {
		if (!job) return;
		try {
			await apiSend(`${PATH}/${job.id}`, "DELETE");
		} catch {
			// Keep the last known running state; only a confirmed host response can report cancellation.
		}
	}

	return (
		<div className="session-import-page">
			<section aria-labelledby="importSourcesTitle">
				<header className="session-import-section-head">
					<h1 id="importSourcesTitle">{t("importSourcesTitle")}</h1>
					<div className="session-import-header-actions">
						<Button id="importScan" className="settings-btn" onClick={() => void scan()} disabled={pending}>
							<Icon name="refresh" size="sm" />
							{busy ? t("importWorking") : t("importRescan")}
						</Button>
					</div>
				</header>
				<div className="session-import-toolbar">
					<SearchInput
						wrapperClassName="search-input"
						aria-label={t("importSearch")}
						placeholder={t("importSearch")}
						value={query}
						onInputCapture={(event) => setQuery(event.currentTarget.value)}
					/>
				</div>
				<div className="session-import-list">
					{SOURCES.map((source) => {
						const rows = visible.filter((candidate) => candidate.source === source.id);
						const platformChosen = chosen.filter((candidate) => candidate.source === source.id);
						const ready =
							platformChosen.length > 0 &&
							platformChosen.every((c) => previews.has(c.id) && targets.get(c.id)?.trim());
						if (!scanned || !rows.length) return null;
						return (
							<details
								className="session-import-group"
								data-import-app={source.id}
								key={`${source.id}:${scanGeneration}`}
							>
								<summary className="session-import-app-summary">
									{groupCheckbox(rows, source.id)}
									{"logo" in source ? (
										<img className="session-import-logo" src={source.logo} alt="" width={32} height={32} />
									) : (
										<span className="session-import-logo-placeholder" aria-hidden="true" />
									)}
									<span className="session-import-app-info">
										<strong>{source.name}</strong>
									</span>
									<span className="session-import-app-count">
										{t("importSelected", {
											count: available.filter(
												(candidate) => candidate.source === source.id && selected.has(candidate.id),
											).length,
										})}
									</span>

									<Button
										className="settings-btn primary session-import-platform-confirm"
										data-import-confirm={source.id}
										aria-label={`${source.name} ${t("importConfirm")}`}
										disabled={pending || !ready || platformChosen.length > 100}
										onClick={(event) => {
											event.preventDefault();
											event.stopPropagation();
											void start(source.id);
										}}
									>
										{t("importConfirm")}
									</Button>
									<Icon className="session-import-app-chevron" name="chevronRight" size="sm" />
								</summary>
								<div className="session-import-app-body">
									{groupProjects(rows, (candidate) => candidate.cwd).map(([cwd, projectRows]) => (
										<details className="session-import-project" data-import-project={cwd} key={cwd}>
											<summary className="session-import-project-summary">
												{groupCheckbox(projectRows, `${source.id}:${cwd}`)}
												<Icon name="chevronRight" size="xs" />
												<Icon name="folder" size="sm" />
												<strong>{projectName(cwd, t("importUnknownProject"))}</strong>

												<span>
													{t("importSelected", {
														count: available.filter(
															(candidate) =>
																candidate.source === source.id &&
																candidate.cwd === cwd &&
																selected.has(candidate.id),
														).length,
													})}
												</span>
											</summary>
											<div className="session-import-project-body">
												{projectRows.map((candidate) => {
													const p = previews.get(candidate.id);
													return (
														<div
															className="session-import-row"
															key={candidate.id}
															data-import-source={candidate.source}
														>
															<label className="session-import-check">
																<input
																	type="checkbox"
																	checked={selected.has(candidate.id)}
																	disabled={pending}
																	aria-label={p?.title || candidate.title}
																	onChange={(event) => {
																		const next = new Set(selected);
																		if (event.target.checked) next.add(candidate.id);
																		else next.delete(candidate.id);
																		setSelected(next);
																	}}
																/>
																<span>
																	<strong>{p?.title || candidate.title}</strong>
																	{candidate.archived ? <small>{t("importArchived")}</small> : null}
																</span>
															</label>
															<Popover
																className="session-import-preview-popover"
																placement="bottom-end"
																role="region"
																aria-label={t("importPreview")}
																open={focused === candidate.id && !!p}
																onClose={() => setFocused(undefined)}
																content={
																	p ? (
																		<>
																			<strong>{p.title}</strong>
																			<pre>{p.excerpt}</pre>
																		</>
																	) : null
																}
															>
																<Button
																	className="settings-btn"
																	disabled={pending}
																	aria-expanded={focused === candidate.id && !!p}
																	onClick={() => {
																		if (focused === candidate.id) setFocused(undefined);
																		else void preview([candidate.id]);
																	}}
																>
																	{t("importPreview")}
																</Button>
															</Popover>

															{p ? (
																<div className="session-import-report">
																	<span>
																		{t("importCounts", {
																			messages: p.messageCount,
																			tools: p.toolCount,
																		})}
																	</span>
																</div>
															) : null}
														</div>
													);
												})}
											</div>
										</details>
									))}
								</div>
							</details>
						);
					})}
				</div>
			</section>
			<section className="session-import-history" aria-labelledby="importHistoryTitle" aria-live="polite">
				<header className="session-import-section-head">
					<h2 id="importHistoryTitle">{t("importHistoryTitle")}</h2>
					{job?.status === "running" ? (
						<Button className="settings-btn" onClick={() => void cancel()}>
							{t("importCancel")}
						</Button>
					) : null}
				</header>
				{job ? (
					<p className="settings-page-desc">
						{t(`importJob.${job.status}`)} · {job.results.length}/{job.total}
					</p>
				) : null}
				{[...SOURCES, { id: "unknown", name: t("importUnknownSource") }].map((source) => {
					const rows = [...jobs]
						.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
						.flatMap((item) => item.results.map((result, index) => ({ result, index, job: item })))
						.filter(({ result }) => (result.source ?? "unknown") === source.id);
					if (!rows.length) return null;
					return (
						<details className="session-import-group" data-import-history-app={source.id} key={source.id}>
							<summary className="session-import-app-summary">
								{"logo" in source ? (
									<img className="session-import-logo" src={source.logo} alt="" width={32} height={32} />
								) : (
									<span className="session-import-logo-placeholder" aria-hidden="true" />
								)}
								<span className="session-import-app-info">
									<strong>{source.name}</strong>
								</span>
								<Icon className="session-import-app-chevron" name="chevronRight" size="sm" />
							</summary>
							<div className="session-import-app-body">
								{groupProjects(
									rows,
									({ result }) =>
										sessions.find((session) => session.id === result.sessionId)?.cwd ||
										candidates.find((candidate) => candidate.id === result.candidateId)?.cwd ||
										"",
								).map(([cwd, projectRows]) => (
									<details className="session-import-project" data-import-history-project={cwd} key={cwd}>
										<summary className="session-import-project-summary">
											<Icon name="chevronRight" size="xs" />
											<Icon name="folder" size="sm" />
											<strong>{projectName(cwd, t("importUnknownProject"))}</strong>
										</summary>
										<div className="session-import-project-body">
											{projectRows.map(({ result, index, job: item }) => (
												<div
													className="session-import-result"
													key={`${item.id}-${index}`}
													data-import-result={result.sessionId ?? result.candidateId}
												>
													<div>
														<strong>{result.title ?? t("importUnknownProject")}</strong>
														<p>{t(`importResult.${result.status}`)}</p>
													</div>
													{result.sessionId ? (
														<Button
															className="settings-btn"
															onClick={() => {
																closeSettings();
																if (result.sessionId)
																	void openSession(result.sessionId, { reportErrors: false });
															}}
														>
															{t("importOpen")}
														</Button>
													) : null}
												</div>
											))}
										</div>
									</details>
								))}
							</div>
						</details>
					);
				})}
			</section>
		</div>
	);
}
