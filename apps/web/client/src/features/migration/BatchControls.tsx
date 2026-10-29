import { useT } from "../../i18n";
import { useAppStore } from "../../state/store";
import type { MigrationKind } from "../../state/types";
import { Button, Tooltip } from "../../ui";
import { changeMigrationBatchTarget } from "./actions";
import { useMigrationStore } from "./store";

/** Shared target choices never apply to rule consent or to unsupported MCP project scopes. */
export function MigrationBatchControls({ kind }: { readonly kind: MigrationKind }) {
	const t = useT();
	const target = useMigrationStore((state) => state.defaultTargets[kind]);
	const disabled = useMigrationStore((state) => !!state.busy || state.scanning);
	const workspaces = useAppStore((state) => state.workspaces);
	const defaultCwd = useAppStore((state) => state.defaultCwd);
	const drafts = useMigrationStore((state) => state.drafts);
	const projects = [
		...new Set([
			...workspaces
				.filter((workspace) => workspace.available && !workspace.hidden)
				.map((workspace) => workspace.path),
			...(defaultCwd ? [defaultCwd] : []),
			...Object.values(drafts).flatMap((draft) =>
				draft.request.target?.kind === "project" ? [draft.request.target.cwd] : [],
			),
		]),
	];
	if (kind === "rules") return <p className="migration-meta">{t("migrationRuleIndividualSelection")}</p>;
	const value = target?.kind === "global" ? "global" : target?.kind === "project" ? target.cwd : "";
	return (
		<div className="migration-batch-controls">
			<span className="migration-copy-mode">
				{t("migrationImportMode")}:{" "}
				{t(
					kind === "sessions"
						? "migrationHistoryCopy"
						: kind === "mcp"
							? "migrationMcpDisabledMode"
							: "migrationIndependentCopyMode",
				)}
			</span>
			<label className="migration-field migration-batch-target">
				<span>{t("migrationBatchTarget")}</span>
				<select
					aria-label={t("migrationBatchTarget")}
					value={value}
					disabled={disabled}
					onChange={(event) =>
						void changeMigrationBatchTarget(
							kind,
							event.currentTarget.value === ""
								? undefined
								: event.currentTarget.value === "global"
									? { kind: "global" }
									: { kind: "project", cwd: event.currentTarget.value },
						)
					}
				>
					<option value="global">{t("migrationGlobalTarget")}</option>
					{projects.map((cwd) => (
						<option value={cwd} key={cwd}>
							{cwd}
						</option>
					))}
				</select>
			</label>
			<Tooltip content={t("migrationBatchTargetHelp")}>
				<Button className="migration-batch-help" aria-label={t("migrationBatchTargetHelp")}>
					ⓘ
				</Button>
			</Tooltip>
		</div>
	);
}
