import { useT } from "../../i18n";
import { IconButton, Spinner } from "../../ui";
import { acknowledgePreview, previewCandidate } from "./actions";
import { DiagnosticList } from "./CandidateList";
import type { MigrationDraft } from "./model";
import { PreviewText } from "./PreviewPanel";
import { updateMigration } from "./store";
import { MigrationTargetPicker } from "./TargetPicker";

export function ResourcePreview({
	id,
	kind,
	draft,
	expired,
}: {
	readonly id: string;
	readonly kind: "sessions" | "mcp";
	readonly draft: MigrationDraft;
	readonly expired: boolean;
	readonly onPickTarget?: () => Promise<string | null>;
}) {
	const t = useT();
	const preview = draft.preview;
	return (
		<aside className="migration-preview" aria-label={t("migrationPreview")}>
			<header className="migration-toolbar">
				<h3>{preview?.candidate.name ?? t("migrationPreview")}</h3>
				<IconButton
					icon="close"
					aria-label={t("migrationClosePreview")}
					onClick={() => updateMigration({ focusedId: null })}
				/>
			</header>
			{draft.loading ? (
				<output>
					<Spinner /> {t("migrationLoadingPreview")}
				</output>
			) : null}
			{draft.error ? (
				<div role="alert">
					<DiagnosticList diagnostics={[{ code: draft.error }]} />
				</div>
			) : null}
			{expired ? <DiagnosticList diagnostics={[{ code: "preview-expired" }]} /> : null}
			{kind === "sessions" ? (
				// A session card is a viewer: the row checkbox selects; nothing else is needed.
				<>{preview ? <PreviewText label={t("migrationSessionHistory")} text={preview.sourceText} /> : null}</>
			) : (
				<>
					<p className="migration-meta">
						{t(`migrationMcpTransport.${preview?.candidate.mcpTransport ?? "stdio"}`)} ·{" "}
						{t("migrationMcpNoDescription")}
					</p>
					<MigrationTargetPicker id={id} kind={kind} draft={draft} />
					<p className="migration-meta">{t("migrationMcpAfterNote")}</p>
					<details
						className="migration-mcp-safety"
						open={
							!!draft.request.includeSensitiveValues ||
							!!preview?.requiredAcknowledgements.length ||
							!!preview?.blockers.length
						}
					>
						<summary>{t("migrationMcpSafetyDetails")}</summary>
						<p>{t("migrationMcpBoundary")}</p>
						<label className="migration-check">
							<input
								type="checkbox"
								checked={draft.request.includeSensitiveValues ?? false}
								disabled={draft.loading}
								onChange={(event) =>
									void previewCandidate(id, { includeSensitiveValues: event.currentTarget.checked })
								}
							/>
							{t("migrationIncludeSensitive")}
						</label>
						{preview ? (
							<>
								<DiagnosticList diagnostics={preview.warnings} />
								<div className="migration-danger">
									<DiagnosticList diagnostics={preview.blockers} />
								</div>
								{preview.requiredAcknowledgements.map((ack) => (
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
							</>
						) : null}
					</details>
				</>
			)}
		</aside>
	);
}
