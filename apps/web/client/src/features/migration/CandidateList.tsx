import { memo, useState } from "react";
import { useT } from "../../i18n";
import type { MigrationCandidate, MigrationDiagnostic, MigrationSource } from "../../state/types";
import { Button, EmptyState, SearchInput, SegmentedControl } from "../../ui";
import { deselectCandidate, previewCandidate } from "./actions";
import { isActionable, isIndependentCopy } from "./model";
import { useMigrationStore } from "./store";

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
const CandidateRow = memo(function CandidateRow({ candidate }: { readonly candidate: MigrationCandidate }) {
	const t = useT();
	const draft = useMigrationStore((state) => state.drafts[candidate.id]);
	const focused = useMigrationStore((state) => state.focusedId === candidate.id);
	const canSelect = isActionable(candidate);
	return (
		<div className={`migration-row${focused ? " migration-row-focused" : ""}`} data-candidate-id={candidate.id}>
			<input
				type="checkbox"
				aria-label={t("migrationSelectItem", { name: candidate.name })}
				checked={draft?.selected ?? false}
				disabled={!canSelect}
				onChange={(event) =>
					event.currentTarget.checked
						? void previewCandidate(candidate.id, {}, true)
						: deselectCandidate(candidate.id)
				}
			/>
			<div className="migration-row-body">
				<Button className="migration-row-title" onClick={() => void previewCandidate(candidate.id)}>
					{candidate.name}
				</Button>
				<div className="migration-meta">
					{t(`migrationSource.${candidate.source}`)} ·{" "}
					{candidate.sourceScope.kind === "project" ? candidate.sourceScope.cwd : t("migrationGlobalSource")}
				</div>
				<code className="migration-path">{candidate.sourcePath}</code>
				<CandidateStatus candidate={candidate} />
				<DiagnosticList diagnostics={candidate.diagnostics} />
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
export function CandidateList() {
	const t = useT();
	const scan = useMigrationStore((state) => state.scan);
	const kind = useMigrationStore((state) => state.kind);
	const [query, setQuery] = useState("");
	const [source, setSource] = useState<MigrationSource | "all">("all");
	const candidates = (scan?.candidates ?? []).filter((candidate) => candidate.kind === kind);
	const sources = [...new Set(candidates.map((candidate) => candidate.source))];
	const matches = candidates.filter(
		(candidate) =>
			(source === "all" || source === candidate.source) &&
			`${candidate.name} ${candidate.sourcePath}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
	);
	const pending = matches.filter(isActionable);
	const other = matches.filter((candidate) => !isActionable(candidate));
	return (
		<div className="migration-list">
			<SegmentedControl
				aria-label={t("migrationSourceFilter")}
				value={source}
				onChange={setSource}
				items={[
					{ value: "all", label: t("migrationAllSources") },
					...sources.map((value) => ({ value, label: t(`migrationSource.${value}`) })),
				]}
			/>
			<SearchInput
				aria-label={t("migrationSearch")}
				placeholder={t("migrationSearch")}
				defaultValue=""
				onInputCapture={(event) => setQuery(event.currentTarget.value)}
			/>
			<h3>{t("migrationNeedsMigration", { count: pending.length })}</h3>
			{pending.length ? (
				pending.map((candidate) => <CandidateRow key={candidate.id} candidate={candidate} />)
			) : (
				<EmptyState>{t("migrationNoCandidates")}</EmptyState>
			)}
			<details className="migration-other">
				<summary>{t("migrationOtherStates", { count: other.length })}</summary>
				{other.map((candidate) => (
					<CandidateRow key={candidate.id} candidate={candidate} />
				))}
			</details>
			<details
				className="migration-source-reports"
				open={(scan?.sources ?? []).some((report) => report.kind === kind && report.status === "error")}
			>
				<summary>{t("migrationScanReports")}</summary>
				{(scan?.sources ?? [])
					.filter((report) => report.kind === kind)
					.map((report, index) => (
						<div key={`${report.path}:${index}`} data-scan-status={report.status}>
							<p>
								{t(`migrationSource.${report.source}`)} · {t(`migrationScanStatus.${report.status}`)}
							</p>
							<code>{report.path}</code>
							<DiagnosticList diagnostics={report.diagnostics} />
						</div>
					))}
			</details>
			{scan?.truncated ? <p className="migration-attention">{t("migrationTruncated")}</p> : null}
		</div>
	);
}
