import { useState } from "react";
import { useT } from "../../i18n";
import { useAppStore } from "../../state/store";
import type { MigrationKind } from "../../state/types";
import { Button } from "../../ui";
import { changeTarget } from "./actions";
import type { MigrationDraft } from "./model";
import { getMigrationState } from "./store";

export function MigrationTargetPicker({
	id,
	kind,
	draft,
	onPickTarget,
}: {
	readonly id: string;
	readonly kind: MigrationKind;
	readonly draft: MigrationDraft;
	readonly onPickTarget?: () => Promise<string | null>;
}) {
	const t = useT();
	const workspaces = useAppStore((state) => state.workspaces);
	const defaultCwd = useAppStore((state) => state.defaultCwd);
	const [picking, setPicking] = useState(false);
	const [failed, setFailed] = useState(false);
	const target = draft.request.target ?? draft.preview?.target.scope;
	const projects = [
		...new Set([
			...workspaces
				.filter((workspace) => workspace.available && !workspace.hidden)
				.map((workspace) => workspace.path),
			...(defaultCwd ? [defaultCwd] : []),
			...(target?.kind === "project" ? [target.cwd] : []),
		]),
	];
	const value = target?.kind === "global" ? "global" : target?.kind === "project" ? target.cwd : "";
	return (
		<>
			<label className="migration-field">
				<span>{t("migrationTarget")}</span>
				<select
					value={value}
					disabled={draft.loading}
					onChange={(event) =>
						changeTarget(
							id,
							event.currentTarget.value === "global"
								? { kind: "global" }
								: { kind: "project", cwd: event.currentTarget.value },
						)
					}
				>
					<option value="" disabled>
						{t("migrationChooseTarget")}
					</option>
					{kind !== "sessions" ? <option value="global">{t("migrationGlobalTarget")}</option> : null}
					{kind !== "mcp"
						? projects.map((cwd) => (
								<option key={cwd} value={cwd}>
									{cwd}
								</option>
							))
						: null}
				</select>
			</label>
			{onPickTarget && kind !== "mcp" ? (
				<Button
					variant="secondary"
					disabled={picking || draft.loading}
					onClick={async () => {
						setPicking(true);
						setFailed(false);
						try {
							const cwd = await onPickTarget();
							const current = getMigrationState();
							if (
								cwd &&
								current.open &&
								current.focusedId === id &&
								current.drafts[id]?.request === draft.request
							)
								changeTarget(id, { kind: "project", cwd });
						} catch {
							setFailed(true);
						} finally {
							setPicking(false);
						}
					}}
				>
					{t("migrationPickTarget")}
				</Button>
			) : null}
			{failed ? (
				<p role="alert" className="migration-danger">
					{t("migrationPickerFailed")}
				</p>
			) : null}
		</>
	);
}
