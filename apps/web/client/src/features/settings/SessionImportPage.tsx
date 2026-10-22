import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { api, apiSend, errorMessage } from "../../lib/api";
import { getDesktopBridge } from "../../platform/host";
import { openSession, refreshSessions } from "../../state/session";
import type { ImportCandidate, ImportJob, ImportPreview } from "../../state/types";
import { Button, Icon, SearchInput } from "../../ui";
import { closeSettings } from "./actions";
import { PageHeader } from "./parts";
import "./session-import.css";

const PATH = "/api/v1/session-imports";

export function SessionImportPage() {
	const t = useT();
	const [codexRoot, setCodexRoot] = useState("");
	const [claudeRoot, setClaudeRoot] = useState("");
	const [includeArchived, setIncludeArchived] = useState(false);
	const [candidates, setCandidates] = useState<readonly ImportCandidate[]>([]);
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
	const [previews, setPreviews] = useState<ReadonlyMap<string, ImportPreview>>(new Map());
	const [targets, setTargets] = useState<ReadonlyMap<string, string>>(new Map());
	const [query, setQuery] = useState("");
	const [scanned, setScanned] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [scanErrors, setScanErrors] = useState<readonly { source: string; message: string }[]>([]);
	const [focused, setFocused] = useState<string>();
	const [job, setJob] = useState<ImportJob>();
	const mounted = useRef(true);

	useEffect(() => {
		mounted.current = true;
		void api<{ jobs: ImportJob[] }>(PATH)
			.then(({ jobs }) => {
				if (mounted.current) setJob(jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]);
			})
			.catch((caught: unknown) => {
				if (mounted.current) setError(errorMessage(caught));
			});
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
				if (next.status === "running") timer = setTimeout(() => void poll(), 500);
				else await refreshSessions();
			} catch (caught) {
				if (!stopped) {
					setError(errorMessage(caught));
					timer = setTimeout(() => void poll(), 2000);
				}
			}
		};
		void poll();
		return () => {
			stopped = true;
			if (timer) clearTimeout(timer);
		};
	}, [job?.id, job?.status]);

	const pending = busy || job?.status === "running";
	const needle = query.trim().toLowerCase();
	const visible = candidates.filter((c) => `${c.title} ${c.cwd} ${c.source}`.toLowerCase().includes(needle));
	const groups = new Map<string, ImportCandidate[]>();
	for (const candidate of visible) {
		const group = groups.get(candidate.cwd) ?? [];
		group.push(candidate);
		groups.set(candidate.cwd, group);
	}
	const chosen = candidates.filter((c) => selected.has(c.id));
	const ready = chosen.length > 0 && chosen.every((c) => previews.has(c.id) && targets.get(c.id)?.trim());
	const focusedPreview = focused ? previews.get(focused) : undefined;

	async function scan() {
		setBusy(true);
		setError("");
		try {
			const result = await apiSend<{ candidates: ImportCandidate[]; errors: { source: string; message: string }[] }>(
				`${PATH}/scan`,
				"POST",
				{ codexRoot, claudeRoot, includeArchived },
			);
			if (!mounted.current) return;
			setCandidates(result.candidates);
			setScanErrors(result.errors);
			setSelected(new Set());
			setPreviews(new Map());
			setTargets(new Map(result.candidates.map((c) => [c.id, c.cwd])));
			setFocused(undefined);
			setScanned(true);
		} catch (caught) {
			if (mounted.current) setError(errorMessage(caught));
		} finally {
			if (mounted.current) setBusy(false);
		}
	}

	async function preview(ids: readonly string[]) {
		setBusy(true);
		setError("");
		setPreviews((current) => {
			const next = new Map(current);
			for (const id of ids) next.delete(id);
			return next;
		});
		try {
			for (const id of ids) {
				try {
					const value = await apiSend<ImportPreview>(`${PATH}/preview`, "POST", { candidateId: id });
					if (!mounted.current) return;
					setPreviews((current) => new Map(current).set(id, value));
					setFocused(id);
				} catch (caught) {
					if (mounted.current) setError((current) => `${current ? `${current}\n` : ""}${errorMessage(caught)}`);
				}
			}
		} finally {
			if (mounted.current) setBusy(false);
		}
	}

	async function pick(id: string) {
		try {
			const bridge = getDesktopBridge();
			const path = bridge
				? await bridge.pickDirectory({ title: t("importTarget") })
				: (await apiSend<{ path?: string }>(`/api/v1/workspaces/pick`, "POST", { title: t("importTarget") })).path;
			if (path && mounted.current) setTargets((current) => new Map(current).set(id, path));
		} catch (caught) {
			if (mounted.current) setError(errorMessage(caught));
		}
	}

	async function start() {
		if (!ready) return;
		setBusy(true);
		setError("");
		try {
			const next = await apiSend<ImportJob>(PATH, "POST", {
				selections: chosen.map((c) => ({
					candidateId: c.id,
					fingerprint: previews.get(c.id)?.fingerprint,
					cwd: targets.get(c.id),
				})),
			});
			if (mounted.current) setJob(next);
		} catch (caught) {
			if (mounted.current) setError(errorMessage(caught));
		} finally {
			if (mounted.current) setBusy(false);
		}
	}

	async function cancel() {
		if (!job) return;
		try {
			await apiSend(`${PATH}/${job.id}`, "DELETE");
		} catch (caught) {
			setError(errorMessage(caught));
		}
	}

	return (
		<>
			<PageHeader title={t("importTitle")} description={t("importSubtitle")} />
			<div className="session-import-sources">
				<label className="settings-field" htmlFor="importCodexRoot">
					<span>{t("importCodexRoot")}</span>
					<input
						id="importCodexRoot"
						className="settings-input mono"
						value={codexRoot}
						placeholder="CODEX_HOME / ~/.codex"
						onInputCapture={(event) => setCodexRoot(event.currentTarget.value)}
						disabled={pending}
					/>
				</label>
				<label className="settings-field" htmlFor="importClaudeRoot">
					<span>{t("importClaudeRoot")}</span>
					<input
						id="importClaudeRoot"
						className="settings-input mono"
						value={claudeRoot}
						placeholder="~/.claude/projects"
						onInputCapture={(event) => setClaudeRoot(event.currentTarget.value)}
						disabled={pending}
					/>
				</label>
			</div>
			<div className="session-import-toolbar">
				<label className="session-import-check">
					<input
						id="importIncludeArchived"
						type="checkbox"
						checked={includeArchived}
						onChange={(event) => setIncludeArchived(event.target.checked)}
						disabled={pending}
					/>
					{t("importIncludeArchived")}
				</label>
				<Button id="importScan" className="settings-btn" onClick={() => void scan()} disabled={pending}>
					<Icon name="search" size="sm" />
					{busy ? t("importWorking") : t("importScan")}
				</Button>
			</div>
			{error ? (
				<p className="settings-alert danger session-import-error" role="alert">
					{error}
				</p>
			) : null}
			{scanErrors.length ? (
				<details className="session-import-errors">
					<summary>{t("importScanErrors", { count: scanErrors.length })}</summary>
					{scanErrors.map((item, index) => (
						<p key={`${item.source}-${index}`}>
							{item.source}: {item.message}
						</p>
					))}
				</details>
			) : null}
			{scanned ? (
				<>
					<div className="session-import-toolbar">
						<SearchInput
							aria-label={t("importSearch")}
							placeholder={t("importSearch")}
							value={query}
							onInputCapture={(event) => setQuery(event.currentTarget.value)}
						/>
						<label className="session-import-check">
							<input
								id="importSelectAll"
								type="checkbox"
								aria-label={t("importSelectAll")}
								checked={visible.length > 0 && visible.every((c) => selected.has(c.id))}
								disabled={pending || !visible.length}
								onChange={(event) => {
									const next = new Set(selected);
									for (const c of visible) {
										if (event.target.checked) next.add(c.id);
										else next.delete(c.id);
									}
									setSelected(next);
								}}
							/>
							{t("importSelectAll")}
						</label>
					</div>
					{!visible.length ? <p className="empty-list">{t("importEmpty")}</p> : null}
					<div className="session-import-list">
						{[...groups].map(([cwd, rows]) => (
							<section className="session-import-group" key={cwd}>
								<h2 className="mono">{cwd || t("importUnknownProject")}</h2>
								{rows.map((candidate) => {
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
													<small>
														{candidate.source} · {candidate.version} · {candidate.modified.slice(0, 10)}
														{candidate.archived ? ` · ${t("importArchived")}` : ""}
													</small>
												</span>
											</label>
											<Button
												className="settings-btn"
												disabled={pending}
												onClick={() => void preview([candidate.id])}
											>
												{t("importPreview")}
											</Button>
											{selected.has(candidate.id) ? (
												<div className="session-import-target">
													<label className="settings-field" htmlFor={`target-${candidate.id}`}>
														<span>{t("importTarget")}</span>
														<input
															id={`target-${candidate.id}`}
															className="settings-input mono"
															value={targets.get(candidate.id) ?? ""}
															onInputCapture={(event) => {
																const value = event.currentTarget.value;
																setTargets((current) => new Map(current).set(candidate.id, value));
															}}
															disabled={pending}
														/>
													</label>
													<Button
														className="settings-btn"
														aria-label={t("importChooseTarget")}
														disabled={pending}
														onClick={() => void pick(candidate.id)}
													>
														<Icon name="folder" size="sm" />
													</Button>
												</div>
											) : null}
											{p ? (
												<div className="session-import-report">
													<span>
														{t("importCounts", { messages: p.messageCount, tools: p.toolCount })}
													</span>
													{p.warnings.map((warning) => (
														<span key={warning.code}>
															{t(`importWarning.${warning.code}` as Parameters<typeof t>[0])} (
															{warning.count})
														</span>
													))}
												</div>
											) : null}
										</div>
									);
								})}
							</section>
						))}
					</div>
					<div className="session-import-toolbar session-import-footer">
						<span>{t("importSelected", { count: chosen.length })}</span>
						<Button
							id="importReviewSelected"
							className="settings-btn"
							disabled={pending || !chosen.length}
							onClick={() => void preview(chosen.map((c) => c.id))}
						>
							{t("importReviewSelected")}
						</Button>
						<Button
							id="importConfirm"
							className="settings-btn primary"
							disabled={pending || !ready || chosen.length > 100}
							onClick={() => void start()}
						>
							{t("importConfirm")}
						</Button>
					</div>
				</>
			) : null}
			{focusedPreview ? (
				<section className="session-import-preview">
					<h2>{focusedPreview.title}</h2>
					<pre>{focusedPreview.excerpt}</pre>
				</section>
			) : null}
			{job ? (
				<section className="session-import-job" aria-live="polite">
					<h2>
						{t(`importJob.${job.status}`)} · {job.results.length}/{job.total}
					</h2>
					{job.status === "running" ? (
						<Button className="settings-btn" onClick={() => void cancel()}>
							{t("importCancel")}
						</Button>
					) : null}
					{job.results.map((result, index) => (
						<div className="session-import-result" key={`${result.candidateId}-${index}`}>
							<span>
								{result.title ? `${result.title} · ` : ""}
								{t(`importResult.${result.status}`)}
								{result.error ? `: ${result.error}` : ""}
								{result.warning ? `: ${result.warning}` : ""}
							</span>
							{result.sessionId ? (
								<Button
									className="settings-btn"
									onClick={() => {
										closeSettings();
										void openSession(result.sessionId as string);
									}}
								>
									{t("importOpen")}
								</Button>
							) : null}
						</div>
					))}
				</section>
			) : null}
		</>
	);
}
