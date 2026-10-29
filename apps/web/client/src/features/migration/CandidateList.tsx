import { memo, useState } from "react";
import { useT } from "../../i18n";
import { sessionModifiedLabel } from "../../lib/format";
import type { MigrationCandidate, MigrationDiagnostic, MigrationSource } from "../../state/types";
import { Button, EmptyState, SegmentedControl } from "../../ui";
import { deselectCandidate, previewCandidate, scanMigration, selectMigrationGroup, setSessionOptions } from "./actions";
import { isActionable, isIndependentCopy, type MigrationDraft } from "./model";
import { SourceDetails } from "./SourceDetails";
import { groupMigrationCandidates, groupSelectionState, type MigrationCandidateGroup } from "./selection";
import { useMigrationStore } from "./store";
export function SourceLogo({ source }: { readonly source: MigrationSource }) {
	const files: Partial<Record<MigrationSource, string>> = {
		"claude-code": "claudecode.svg",
		codex: "codex.svg",
		workbuddy: "workbuddy.svg",
		qoder: "qoder-dark.svg",
	};
	const file = files[source];
	return file ? (
		<img className="migration-source-logo" src={`/session-import-logos/${file}`} alt="" aria-hidden="true" />
	) : null;
}
export function DiagnosticList({ diagnostics }: { readonly diagnostics: readonly MigrationDiagnostic[] }) {
	const t = useT();
	return (
		<ul className="migration-diagnostics">
			{diagnostics.map((diagnostic, index) => {
				const key = `migrationDiagnostic.${diagnostic.code}`;
				const label = t(key);
				return (
					<li key={`${diagnostic.code}:${index}`}>
						{label === key ? t("migrationDiagnosticUnknown", { code: diagnostic.code }) : label}
						{diagnostic.count !== undefined ? (
							<span> {t("migrationDiagnosticCount", { count: diagnostic.count })}</span>
						) : null}
						{diagnostic.path ? <code>{diagnostic.path}</code> : null}
					</li>
				);
			})}
		</ul>
	);
}
export function CandidateStatus({ candidate }: { readonly candidate: MigrationCandidate }) {
	const t = useT();
	return (
		<span className="migration-status" data-status={candidate.readiness}>
			{t(`migrationHolding.${candidate.holding}`)} · {t(`migrationReadiness.${candidate.readiness}`)}
		</span>
	);
}
/** V3 wording: a row is only promised as migratable after its own check settles. */
export function CandidateProgressStatus({
	candidate,
	draft,
}: {
	readonly candidate: MigrationCandidate;
	readonly draft?: MigrationDraft;
}) {
	const t = useT();
	const state = !candidate.needsMigration
		? candidate.kind === "sessions"
			? "imported"
			: "available"
		: draft?.loading
			? "checking"
			: draft?.error
				? "blocked"
				: !draft?.preview
					? draft?.selected
						? "checking"
						: "pending"
					: draft.preview.blockers.length
						? "blocked"
						: "ready";
	const label =
		state === "imported"
			? "migrationStatusImported"
			: state === "available"
				? "migrationStatusAvailable"
				: state === "checking"
					? "migrationStatusChecking"
					: state === "pending"
						? "migrationStatusPendingCheck"
						: state === "blocked"
							? "migrationStatusBlocked"
							: "migrationStatusReady";
	return (
		<span className="migration-status" data-progress={state}>
			{t(label)}
		</span>
	);
}
const CandidateRow = memo(function CandidateRow({ candidate }: { readonly candidate: MigrationCandidate }) {
	const t = useT();
	const draft = useMigrationStore((state) => state.drafts[candidate.id]);
	const focused = useMigrationStore((state) => state.focusedId === candidate.id);
	const canSelect = isActionable(candidate);
	const busy = useMigrationStore((state) => !!state.busy || state.scanning);
	return (
		<div className={`migration-row${focused ? " migration-row-focused" : ""}`} data-candidate-id={candidate.id}>
			<input
				type="checkbox"
				aria-label={t("migrationSelectItem", { name: candidate.name })}
				checked={draft?.selected ?? false}
				disabled={!canSelect || busy || draft?.loading}
				onChange={(event) =>
					event.currentTarget.checked
						? void previewCandidate(candidate.id, {}, true, false)
						: deselectCandidate(candidate.id)
				}
			/>
			<SourceLogo source={candidate.source} />
			<div className="migration-row-body">
				<Button
					className="migration-row-title"
					disabled={busy || draft?.loading}
					onClick={() => void previewCandidate(candidate.id)}
				>
					{candidate.name}
				</Button>
				<div className="migration-meta">
					{candidate.kind === "mcp" ? (
						<>
							{t(`migrationMcpTransport.${candidate.mcpTransport ?? "stdio"}`)} ·{" "}
							{t("migrationMcpNoDescription")}
						</>
					) : (
						<>
							{t(`migrationSource.${candidate.source}`)}
							{candidate.modified ? ` · ${sessionModifiedLabel(candidate.modified)}` : ""}
							{candidate.kind === "sessions" && candidate.messageCount !== undefined
								? ` · ${candidate.messageCount}${candidate.messageCountCapped ? "+" : ""} ${t("migrationMessages")}`
								: ""}
						</>
					)}
				</div>
				{candidate.kind === "mcp" ? <span className="migration-meta">{t("migrationMcpAfterNote")}</span> : null}
				{!candidate.needsMigration && candidate.kind !== "sessions" ? (
					<CandidateStatus candidate={candidate} />
				) : null}
				<CandidateProgressStatus candidate={candidate} draft={draft} />
				{draft?.loading ? <span className="migration-meta">{t("migrationLoadingPreview")}</span> : null}
				{draft?.preview && !draft.loading ? <DiagnosticList diagnostics={draft.preview.blockers} /> : null}
				{/* The 已可用 status pill already says this; the verbose diagnostic would be noise. */}
				<DiagnosticList
					diagnostics={candidate.diagnostics.filter((item) => item.code !== "session-already-imported")}
				/>
				{draft?.error ? (
					<p className="migration-danger">
						{t(`migrationDiagnostic.${draft.error}`) === `migrationDiagnostic.${draft.error}`
							? t("migrationDiagnosticUnknown", { code: draft.error })
							: t(`migrationDiagnostic.${draft.error}`)}
					</p>
				) : null}
				{isIndependentCopy(candidate) ? (
					<Button
						variant="secondary"
						onClick={() => void previewCandidate(candidate.id, { action: "copy" }, true)}
					>
						{t("migrationIndependentCopy")}
					</Button>
				) : null}
			</div>
		</div>
	);
});
const scopeName = (cwd: string): string => cwd.replaceAll("\\", "/").replace(/\/+$/u, "").split("/").pop() || cwd;
function SourceGroup({ group }: { readonly group: MigrationCandidateGroup }) {
	const t = useT();
	const drafts = useMigrationStore((state) => state.drafts);
	const busy = useMigrationStore((state) => !!state.busy || state.scanning);
	const selection = groupSelectionState(group.candidates, drafts);
	const sessions = group.candidates[0]?.kind === "sessions";
	const attention = group.candidates.filter((item) => item.needsMigration && !isActionable(item)).length;
	const checked = group.candidates.filter((item) => drafts[item.id]?.preview && !drafts[item.id]?.loading);
	const groupBlocked = checked.filter(
		(item) => drafts[item.id]?.preview?.blockers.length || drafts[item.id]?.error,
	).length;
	const groupUnchecked = group.candidates.filter(
		(item) => item.needsMigration && !drafts[item.id]?.preview && !drafts[item.id]?.loading,
	).length;
	const [expanded, setExpanded] = useState(group.candidates[0]?.kind === "mcp");
	const label = sessions
		? group.scope.kind === "project"
			? scopeName(group.root)
			: t("migrationUnknownWorkspace")
		: t(`migrationSource.${group.source}`);
	return (
		<section
			className="migration-group"
			data-scope-cwd={group.scope.kind === "project" ? group.scope.cwd : ""}
			data-source-group={group.id}
		>
			<header className="migration-group-head">
				<input
					type="checkbox"
					aria-label={t("migrationGroupSelectAll", { name: label })}
					ref={(input) => {
						if (input) input.indeterminate = selection.indeterminate;
					}}
					disabled={busy || !selection.eligible}
					checked={selection.checked}
					onChange={(event) => void selectMigrationGroup(group.candidates, event.currentTarget.checked)}
				/>
				<Button className="migration-group-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
					{sessions ? null : <SourceLogo source={group.source} />}
					<span className="migration-group-name">{label}</span>
					{sessions && group.scope.kind === "project" ? <code>{group.root}</code> : null}
					<span className="migration-pill">
						{t(sessions ? "migrationWorkspaceSessions" : "migrationMcpCount", { count: group.candidates.length })}
					</span>
					{sessions && attention ? (
						<span className="migration-pill migration-pill-attention">
							{t("migrationGroupPending", { count: attention })}
						</span>
					) : sessions && groupBlocked ? (
						<span className="migration-pill migration-pill-attention">
							{t("migrationGroupPending", { count: groupBlocked })}
						</span>
					) : sessions && groupUnchecked ? (
						<span className="migration-pill">{t("migrationStatusPendingCheck")}</span>
					) : sessions && selection.eligible ? (
						<span className="migration-pill migration-pill-success">{t("migrationReady")}</span>
					) : null}
					<span aria-hidden="true">{expanded ? "⌄" : "›"}</span>
				</Button>
			</header>
			{sessions && selection.selected > 0 ? (
				<div className="migration-workspace-target">
					<span className="migration-meta">
						{t("migrationSelectedSessions", { count: selection.selected })} · {t("migrationInheritedTarget")}
					</span>
				</div>
			) : null}
			<div className="migration-group-items" hidden={!expanded}>
				{group.candidates.map((candidate) => (
					<CandidateRow key={candidate.id} candidate={candidate} />
				))}
			</div>
		</section>
	);
}
export function CandidateList(_: { readonly onPickTarget?: () => Promise<string | null> }) {
	const t = useT();
	const scan = useMigrationStore((state) => state.scan);
	const kind = useMigrationStore((state) => state.kind);
	const [source, setSource] = useState<MigrationSource | "all">("all");
	const options = useMigrationStore((state) => state.sessionOptions);
	const candidates = (scan?.candidates ?? []).filter((candidate) => candidate.kind === kind);
	const sources = [...new Set(candidates.map((candidate) => candidate.source))];
	const matches = candidates.filter((candidate) => source === "all" || source === candidate.source);
	const pending = matches.filter(isActionable);
	// V3: session groups keep every discovered row (already-in-use ones stay visible, unselectable).
	const groups = kind === "rules" ? null : groupMigrationCandidates(matches);
	const scannedKinds = useMigrationStore((state) => state.scannedKinds);
	const drafts = useMigrationStore((state) => state.drafts);
	const busy = useMigrationStore((state) => !!state.busy || state.scanning);
	const selection = groupSelectionState(pending, drafts);
	return (
		<div className="migration-list">
			<div className="migration-toolbar">
				{kind === "mcp" && !busy && pending.length ? (
					<p className="migration-meta" data-mcp-found="">
						{t("migrationMcpFound", { count: pending.length })}
					</p>
				) : null}
				<div className="migration-scan-controls">
					{kind === "sessions" ? (
						<>
							<label className="migration-scan-select">
								<span>{t("migrationScanRangeLabel")}</span>
								<select
									aria-label={t("migrationTimeFilter")}
									value={options.range}
									disabled={busy}
									onChange={(event) => {
										const range = event.currentTarget.value;
										if (range === "all" || range === "7" || range === "30" || range === "90")
											setSessionOptions({ range });
									}}
								>
									{["all", "7", "30", "90"].map((value) => (
										<option key={value} value={value}>
											{t(`migrationTimeRange.${value}`)}
										</option>
									))}
								</select>
							</label>
							<label className="migration-scan-select">
								<span>{t("migrationScanLimitLabel")}</span>
								<select
									aria-label={t("migrationSessionLimit")}
									value={options.limit ?? "unlimited"}
									disabled={busy}
									onChange={(event) => {
										const limit = event.currentTarget.value;
										setSessionOptions({
											limit: limit === "30" ? 30 : limit === "50" ? 50 : limit === "100" ? 100 : null,
										});
									}}
								>
									{[30, 50, 100].map((limit) => (
										<option key={limit} value={limit}>
											{t("migrationLimitCount", { count: limit })}
										</option>
									))}
									<option value="unlimited">{t("migrationUnlimited")}</option>
								</select>
							</label>
						</>
					) : null}
				</div>
				<SourceDetails />
				<Button
					id="migrationScanButton"
					className="migration-scan-run"
					disabled={busy}
					onClick={() => void scanMigration(kind)}
				>
					<span aria-hidden="true">↻</span>
					{t(
						busy
							? "migrationScanning"
							: kind === "sessions" && !scannedKinds.includes("sessions")
								? "migrationScanSessions"
								: "migrationRescan",
					)}
				</Button>
			</div>
			<div className="migration-list-toolbar">
				<SegmentedControl
					className="migration-source-tabs"
					aria-label={t("migrationSourceFilter")}
					value={source}
					onChange={setSource}
					items={[
						{ value: "all", label: t("migrationAllSources") },
						...sources.map((value) => ({
							value,
							label: (
								<>
									<SourceLogo source={value} />
									{t(`migrationSource.${value}`)}
								</>
							),
						})),
					]}
				/>
				<div className="migration-select-all">
					{kind !== "rules" ? (
						<label className="migration-check">
							<input
								type="checkbox"
								aria-label={t("migrationSelectAllPending")}
								ref={(input) => {
									if (input) input.indeterminate = selection.indeterminate;
								}}
								checked={selection.checked}
								disabled={busy || !selection.eligible}
								onChange={(event) => void selectMigrationGroup(pending, event.currentTarget.checked)}
							/>
							{t("migrationSelectAllPending")}
						</label>
					) : (
						<span>{t("migrationRuleIndividualSelection")}</span>
					)}
					<span className="migration-meta">
						{t("migrationGroupSelection", { selected: selection.selected, total: selection.eligible })}
					</span>
				</div>
			</div>
			{groups ? (
				groups.length ? (
					groups.map((group) => <SourceGroup key={group.id} group={group} />)
				) : (
					<EmptyState>{t("migrationNoCandidates")}</EmptyState>
				)
			) : matches.length ? (
				matches.map((candidate) => <CandidateRow key={candidate.id} candidate={candidate} />)
			) : (
				<EmptyState>{t("migrationNoCandidates")}</EmptyState>
			)}
			{scan?.truncated ? <p className="migration-attention">{t("migrationTruncated")}</p> : null}
			{kind === "sessions" && scan?.sessionSummary ? (
				<>
					<p className="migration-meta" data-session-summary="">
						{t("migrationSessionShown", {
							shown: scan.sessionSummary.shown,
							total: scan.sessionSummary.total,
						})}
					</p>
				</>
			) : null}
		</div>
	);
}
