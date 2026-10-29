import { useT } from "../../i18n";
import type { MigrationAcknowledgement, MigrationPreview, MigrationScope } from "../../state/types";
import { Button, Spinner } from "../../ui";
import { acknowledgePreview, checkRuleConsent, confirmRule, deselectCandidate, previewCandidate } from "./actions";
import { DiagnosticList } from "./CandidateList";
import { useMigrationExpiry } from "./expiry";
import { ResourcePreview } from "./ResourcePreview";
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
export function RuleImpact({ preview }: { readonly preview: MigrationPreview }) {
	const t = useT();
	const impact = preview.ruleImpact;
	return (
		<section className="migration-rule-impact">
			<h3>{t("migrationRuleWarning")}</h3>
			<p>
				{preview.target.scope.kind === "global"
					? t("migrationRuleGlobalScope")
					: t("migrationRuleProjectScope", { cwd: preview.target.scope.cwd })}
			</p>
			<p>{t("migrationRuleTiming")}</p>
			<p>{t("migrationRuleModel")}</p>
			<p>{t("migrationRulePermissions")}</p>
			<p>{t("migrationRecoveryLimit")}</p>
			<p>{t("migrationSourcePreserved")}</p>
			{impact ? (
				<>
					<div className="migration-rule-paths">
						{(["before", "after", "shadowed"] as const).map((type) => (
							<section key={type}>
								<h4>{t(`migrationRules.${type}`)}</h4>
								{impact[type].length ? (
									<ul>
										{impact[type].map((path) => (
											<li key={path}>
												<code>{path}</code>
											</li>
										))}
									</ul>
								) : (
									<p>{t("migrationNone")}</p>
								)}
							</section>
						))}
					</div>
					{impact.backupRequired ? <p>{t("migrationBackupRequired")}</p> : null}
				</>
			) : (
				<p className="migration-danger">{t("migrationRuleImpactMissing")}</p>
			)}
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
	if (candidateKind === "sessions" || candidateKind === "mcp")
		return (
			<ResourcePreview id={id} kind={candidateKind} draft={draft} expired={expired} onPickTarget={onPickTarget} />
		);
	const isRule = candidateKind === "rules";
	const confirmKey =
		preview?.ruleImpact?.backupRequired && preview.action === "append"
			? "migrationConfirmRuleAppend"
			: preview?.ruleImpact?.backupRequired && preview.action === "replace"
				? "migrationConfirmRuleReplace"
				: preview?.target.scope.kind === "project"
					? "migrationConfirmRuleProject"
					: "migrationConfirmRuleGlobal";
	return (
		<aside
			className={`migration-preview${isRule ? " migration-rule-review" : ""}`}
			aria-label={t("migrationPreview")}
		>
			<header className="migration-toolbar">
				<h3>{preview?.candidate.name ?? t("migrationPreview")}</h3>
				<Button onClick={() => void previewCandidate(id)} disabled={draft.loading}>
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
					{preview.candidate.kind === "mcp" ? (
						<p>
							{t("migrationMcpNoDescription")} ·{" "}
							{t(`migrationMcpTransport.${preview.candidate.mcpTransport ?? "stdio"}`)}
						</p>
					) : null}
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
					{!isRule && preview.candidate.kind !== "sessions" ? (
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
					{preview.candidate.kind === "mcp" ? (
						<>
							<p>{t("migrationMcpBoundary")}</p>
							<label className="migration-check">
								<input
									type="checkbox"
									checked={draft.request.includeSensitiveValues ?? false}
									onChange={(event) =>
										void previewCandidate(id, { includeSensitiveValues: event.currentTarget.checked })
									}
								/>
								{t("migrationIncludeSensitive")}
							</label>
						</>
					) : null}
					<DiagnosticList diagnostics={preview.warnings} />
					<div className="migration-danger">
						<DiagnosticList diagnostics={preview.blockers} />
					</div>
					{isRule ? <RuleImpact preview={preview} /> : <p>{t(`migrationActivation.${preview.activation}`)}</p>}
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
					{preview.requiredAcknowledgements
						.filter((ack) => ack !== "rules-impact")
						.map((ack: MigrationAcknowledgement) => (
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
					{isRule && preview.action !== "skip" ? (
						<div className="migration-rule-consent">
							<label className="migration-check">
								<input
									type="checkbox"
									checked={draft.ruleChecked}
									disabled={draft.loading}
									onChange={(event) => checkRuleConsent(id, event.currentTarget.checked)}
								/>
								{t("migrationRuleConsent")}
							</label>
							<Button
								variant="primary"
								disabled={
									!draft.selected ||
									!draft.ruleChecked ||
									!preview.ruleImpact ||
									draft.loading ||
									expired ||
									preview.blockers.length > 0
								}
								onClick={() => confirmRule(id)}
							>
								{t(confirmKey)}
							</Button>
							{draft.acknowledged.includes("rules-impact") ? (
								<p className="migration-attention">{t("migrationRuleConfirmed")}</p>
							) : null}
						</div>
					) : null}
					<Button variant="secondary" onClick={() => deselectCandidate(id)}>
						{t("migrationDoNotMigrate")}
					</Button>
				</>
			) : null}
		</aside>
	);
}
