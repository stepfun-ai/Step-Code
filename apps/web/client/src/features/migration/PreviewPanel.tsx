import { useT } from "../../i18n";
import type { MigrationAcknowledgement, MigrationScope } from "../../state/types";
import { Button, Spinner } from "../../ui";
import { acknowledgePreview, deselectCandidate, previewCandidate } from "./actions";
import { DiagnosticList } from "./CandidateList";
import { useMigrationExpiry } from "./expiry";
import { useMigrationStore } from "./store";
import { MigrationTargetPicker } from "./TargetPicker";

export interface MigrationFeatureProps {
	readonly onPickTarget?: () => Promise<string | null>;
	readonly onOpenSession?: (sessionId: string) => Promise<void> | void;
}
export function ScopeLabel({ scope }: { readonly scope: MigrationScope }) {
	const t = useT();
	return (
		<span>
			{scope.kind === "global" ? t("migrationGlobalTarget") : t("migrationProjectTarget", { cwd: scope.cwd })}
		</span>
	);
}
export function PreviewText({ label, text }: { readonly label: string; readonly text: string | undefined }) {
	const t = useT();
	return (
		<section className="migration-text">
			<h4>{label}</h4>
			<pre>{text ?? t("migrationNoExistingContent")}</pre>
		</section>
	);
}
export function PreviewPanel({ onPickTarget }: MigrationFeatureProps) {
	const t = useT();
	const id = useMigrationStore((state) => state.focusedId);
	const draft = useMigrationStore((state) => (id ? state.drafts[id] : undefined));
	const candidate = useMigrationStore((state) => state.scan?.candidates.find((item) => item.id === id));
	const open = useMigrationStore((state) => state.open);
	const expired = useMigrationExpiry(open, draft?.preview?.expiresAt ?? null);
	if (!id || !draft) return <aside className="migration-preview" hidden />;
	const preview = draft.preview;
	const candidateKind = preview?.candidate.kind ?? candidate?.kind;
	// Only skills have a detail panel. MCP migrates as-is, enabled; a rule row already shows source and
	// target; a session is chosen from its row, which also shows its review state and errors.
	if (candidateKind !== "skills") return <aside className="migration-preview" hidden />;
	return (
		<aside className="migration-preview" aria-label={t("migrationPreview")}>
			<header className="migration-toolbar">
				<h3>{preview?.candidate.name ?? t("migrationPreview")}</h3>
				<Button id="migrationRefreshPreview" onClick={() => void previewCandidate(id)} disabled={draft.loading}>
					{t("migrationRefreshPreview")}
				</Button>
			</header>
			{draft.loading ? (
				<output>
					<Spinner /> {t("migrationLoadingPreview")}
				</output>
			) : null}
			{expired && !draft.loading ? (
				<p role="alert" className="migration-attention">
					{t("migrationDiagnostic.preview-expired")}
				</p>
			) : null}
			{draft.error ? (
				<div role="alert">
					<DiagnosticList diagnostics={[{ code: draft.error }]} />
				</div>
			) : null}
			{candidateKind ? (
				<MigrationTargetPicker key={id} id={id} kind={candidateKind} draft={draft} onPickTarget={onPickTarget} />
			) : null}
			{preview ? (
				<>
					<div className="migration-map">
						<div>
							<span>{t("migrationSourcePath")}</span>
							<code>{preview.candidate.sourcePath}</code>
						</div>
						<div>
							<span>{t("migrationTargetPath")}</span>
							<code>{preview.target.path}</code>
							<ScopeLabel scope={preview.target.scope} />
						</div>
					</div>
					<label className="migration-field">
						<span>{t("migrationAction")}</span>
						<select
							value={preview.action}
							disabled={draft.loading}
							onChange={(event) => {
								const action = preview.allowedActions.find((allowed) => allowed === event.currentTarget.value);
								if (action) void previewCandidate(id, { action });
							}}
						>
							{preview.allowedActions.map((action) => (
								<option key={action} value={action}>
									{t(`migrationAction.${action}`)}
								</option>
							))}
						</select>
					</label>
					{preview.candidate.kind !== "sessions" ? (
						<label className="migration-field">
							<span>
								{t(preview.candidate.kind === "mcp" ? "migrationMcpTargetName" : "migrationTargetName")}
							</span>
							<input
								key={`${id}:name`}
								defaultValue={draft.request.targetName ?? preview.target.name}
								onInputCapture={(event) => void previewCandidate(id, { targetName: event.currentTarget.value })}
							/>
						</label>
					) : null}
					<DiagnosticList diagnostics={preview.warnings} />
					<div className="migration-danger">
						<DiagnosticList diagnostics={preview.blockers} />
					</div>
					<p>{t(`migrationActivation.${preview.activation}`)}</p>
					<div className="migration-content-review">
						<PreviewText label={t("migrationSourceContent")} text={preview.sourceText} />
						<PreviewText label={t("migrationTargetContent")} text={preview.targetText} />
						<PreviewText label={t("migrationResultContent")} text={preview.resultText} />
					</div>
					{preview.files ? (
						<details>
							<summary>{t("migrationFiles", { count: preview.files.length })}</summary>
							<ul>
								{preview.files.map((file) => (
									<li key={file.path}>
										<code>{file.path}</code> · {t("migrationBytes", { count: file.bytes })}
									</li>
								))}
							</ul>
						</details>
					) : null}
					{preview.requiredAcknowledgements.map((ack: MigrationAcknowledgement) => (
						<label className="migration-check" key={`${preview.id}:${ack}`}>
							<input
								type="checkbox"
								checked={draft.acknowledged.includes(ack)}
								disabled={draft.loading}
								onChange={(event) => acknowledgePreview(id, ack, event.currentTarget.checked)}
							/>
							{t(`migrationAcknowledgement.${ack}`)}
						</label>
					))}
					<Button variant="secondary" onClick={() => deselectCandidate(id)}>
						{t("migrationDoNotMigrate")}
					</Button>
				</>
			) : null}
		</aside>
	);
}
