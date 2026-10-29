import { useState } from "react";
import { useT } from "../../i18n";
import { useAppStore } from "../../state/store";
import type { MigrationKind } from "../../state/types";
import { Button } from "../../ui";
import { changeTarget } from "./actions";
import type { MigrationDraft } from "./model";
import { getMigrationState, useMigrationStore } from "./store";

export function MigrationTargetPicker({
	id,
	kind,
	draft,
	onPickTarget,
	labelled = true,
}: {
	readonly id: string;
	readonly kind: MigrationKind;
	readonly draft: MigrationDraft;
	readonly onPickTarget?: () => Promise<string | null>;
	/** False when an enclosing section already names the destination. */
	readonly labelled?: boolean;
}) {
	const t = useT();
	const workspaces = useAppStore((state) => state.workspaces);
	const defaultCwd = useAppStore((state) => state.defaultCwd);
	const candidate = useMigrationStore((state) => state.scan?.candidates.find((item) => item.id === id));
	const originalCwd =
		kind === "sessions" && candidate?.sourceScope.kind === "project" ? candidate.sourceScope.cwd : null;
	const [picking, setPicking] = useState(false);
	const [failed, setFailed] = useState(false);
	const [creating, setCreating] = useState(false);
	const [parent, setParent] = useState("");
	const [folderName, setFolderName] = useState("");
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
	const createParent = parent || projects[0] || "";
	const trimmedName = folderName.trim();
	const nameValid = trimmedName.length > 0 && trimmedName.length <= 60 && !/[\\/\0]/u.test(trimmedName);
	const value =
		kind === "sessions" && target?.kind === "global"
			? ""
			: target?.kind === "global"
				? "global"
				: target?.kind === "project"
					? target.cwd
					: "";
	return (
		<>
			<label className="migration-field">
				{labelled ? <span>{t("migrationTarget")}</span> : null}
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
					{projects.map((cwd) => (
						<option key={cwd} value={cwd}>
							{cwd === originalCwd ? t("migrationReuseOriginal", { cwd }) : cwd}
						</option>
					))}
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
			{kind === "sessions" ? (
				<div className="migration-create-workspace">
					{creating ? (
						<>
							<label className="migration-field">
								<span>{t("migrationCreateWorkspaceParent")}</span>
								<select
									value={createParent}
									disabled={draft.loading}
									onChange={(event) => setParent(event.currentTarget.value)}
								>
									{projects.map((cwd) => (
										<option key={cwd} value={cwd}>
											{cwd}
										</option>
									))}
								</select>
							</label>
							<label className="migration-field">
								<span>{t("migrationCreateWorkspaceName")}</span>
								<input
									value={folderName}
									disabled={draft.loading}
									maxLength={60}
									onChange={(event) => setFolderName(event.currentTarget.value)}
								/>
							</label>
							<div className="migration-create-workspace-actions">
								<Button
									variant="primary"
									disabled={!createParent || !nameValid || draft.loading}
									onClick={() => {
										changeTarget(id, {
											kind: "project",
											cwd: `${createParent.replace(/[\\/]+$/u, "")}/${trimmedName}`,
											create: true,
										});
										setCreating(false);
										setFolderName("");
									}}
								>
									{t("migrationCreateWorkspaceConfirm")}
								</Button>
								<Button variant="secondary" onClick={() => setCreating(false)}>
									{t("migrationBackToSelection")}
								</Button>
							</div>
							{folderName && !nameValid ? (
								<p className="migration-attention">{t("migrationCreateWorkspaceInvalid")}</p>
							) : null}
						</>
					) : (
						<Button variant="secondary" disabled={draft.loading} onClick={() => setCreating(true)}>
							{t("migrationCreateWorkspace")}
						</Button>
					)}
				</div>
			) : null}
			{failed ? (
				<p role="alert" className="migration-danger">
					{t("migrationPickerFailed")}
				</p>
			) : null}
		</>
	);
}
