import { useT } from "../../i18n";
import { IconButton, Spinner } from "../../ui";
import { DiagnosticList } from "./CandidateList";
import type { MigrationDraft } from "./model";
import { PreviewText } from "./PreviewPanel";
import { updateMigration } from "./store";

export function ResourcePreview({
	draft,
	expired,
}: {
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
			{/* A session card is a viewer: the row checkbox selects; nothing else is needed. */}
			{preview ? <PreviewText label={t("migrationSessionHistory")} text={preview.sourceText} /> : null}
		</aside>
	);
}
