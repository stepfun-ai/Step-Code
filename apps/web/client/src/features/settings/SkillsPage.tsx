/**
 * Skills: the user's skills (switch on/off, delete those in StepCode's own
 * folders), skills contributed by plugins (read-only), creating a skill
 * (`SKILL.md` from a form) and importing a local skill folder.
 */

import { type FormEvent, useId, useRef, useState } from "react";
import { useT } from "../../i18n";
import { apiSend, errorMessage } from "../../lib/api";
import { getDesktopBridge } from "../../platform/host";
import { showError, showNotice } from "../../state/session";
import { useAppStore } from "../../state/store";
import type { SettingsSkill } from "../../state/types";
import { Icon, IconButton, Modal, SearchInput, Switch, Tooltip } from "../../ui";
import { chooseResourceDirectory } from "../workspace/actions";
import { closeSettingsDialog, closeSettingsEditor, invalidateExtensionResources, useSettingsResource } from "./actions";
import { ExtensionCreateMenu } from "./ExtensionCreateMenu";
import { ExtensionRowMenu } from "./ExtensionRowMenu";
import { ExtensionSourceGroups } from "./ExtensionSourceGroups";
import { PageHeader, ResourceState } from "./parts";
import { importSkillFile } from "./skill-actions";

const SKILLS_PATH = "/api/v1/settings/skills";
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const INSTRUCTIONS_PLACEHOLDER = `## When to use

## Steps
1.
2.
`;

function SkillRow({
	skill,
	onToggle,
}: {
	readonly skill: SettingsSkill;
	readonly onToggle: (enabled: boolean) => void;
}) {
	const t = useT();
	const [menuOpen, setMenuOpen] = useState(false);
	return (
		<div className="settings-list-row" data-skill={skill.name}>
			<span className="settings-row-icon">
				<Icon name="wand" />
			</span>
			<div className="settings-list-main">
				<div className="settings-list-title">
					<strong>{skill.name}</strong>
					<span className="settings-location mono" title={skill.location}>
						{skill.location}
					</span>
				</div>
				<div className="settings-list-desc" title={skill.description}>
					{skill.description || t("settingsNoDescription")}
				</div>
			</div>
			<div className="settings-list-actions">
				<ExtensionRowMenu
					resource={{ kind: "skills", skill }}
					name={skill.name}
					open={menuOpen}
					onOpenChange={setMenuOpen}
					triggerClassName="settings-icon-action"
				/>
				{skill.toggleable ? (
					<Switch
						checked={skill.enabled}
						onChange={onToggle}
						aria-label={t("settingsToggleNamed", { name: skill.name })}
					/>
				) : (
					<span className="settings-readonly">
						{t(
							skill.source === "plugin"
								? skill.enabled
									? "settingsAlwaysOn"
									: "extensionManagement.pluginDisabled"
								: "extensionManagement.packageSkill",
						)}
					</span>
				)}
			</div>
		</div>
	);
}

function SkillEditor({ onDone }: { readonly onDone: (saved: boolean) => void }) {
	const t = useT();
	const ids = useId();
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [instructions, setInstructions] = useState("");
	const [error, setError] = useState<string>();
	const [saving, setSaving] = useState(false);
	const nameInvalid = name.length > 0 && !SKILL_NAME.test(name);

	const save = async (event: FormEvent) => {
		event.preventDefault();
		setSaving(true);
		setError(undefined);
		try {
			await apiSend(SKILLS_PATH, "POST", { name, description, instructions });
			showNotice(t("extensionManagement.createSucceeded"), t("settingsSkillCreated", { name }), "success");
			onDone(true);
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setSaving(false);
		}
	};

	return (
		<form className="settings-editor" id="settingsSkillEditor" onSubmit={(event) => void save(event)}>
			<nav className="settings-breadcrumb" aria-label={t("settingsSkills")}>
				<button type="button" onClick={() => onDone(false)}>
					{t("settingsSkills")}
				</button>
				<Icon name="chevronRight" size="menu" />
				<span>{t("settingsSkillNew")}</span>
			</nav>
			<div className="settings-editor-head">
				<div>
					<h1 className="settings-page-title">{t("settingsSkillNew")}</h1>
					<p className="settings-page-desc">{t("settingsSkillNewDesc")}</p>
				</div>
			</div>
			<div className="settings-card settings-form">
				<label className="settings-field" htmlFor={`${ids}-name`}>
					<span>{t("settingsName")}</span>
					<input
						id={`${ids}-name`}
						className="mono"
						value={name}
						placeholder="release-notes"
						autoComplete="off"
						spellCheck={false}
						required
						aria-invalid={nameInvalid}
						onChange={(event) => setName(event.target.value.toLowerCase())}
					/>
					<small className={nameInvalid ? "invalid" : undefined}>{t("settingsSkillNameHint")}</small>
				</label>
				<label className="settings-field" htmlFor={`${ids}-description`}>
					<span>{t("settingsSkillDescription")}</span>
					<textarea
						id={`${ids}-description`}
						rows={2}
						value={description}
						placeholder={t("settingsSkillDescriptionPlaceholder")}
						required
						onChange={(event) => setDescription(event.target.value)}
					/>
					<small>{t("settingsSkillDescriptionHint")}</small>
				</label>
				<label className="settings-field" htmlFor={`${ids}-instructions`}>
					<span>{t("settingsSkillInstructions")}</span>
					<textarea
						id={`${ids}-instructions`}
						className="mono"
						rows={12}
						value={instructions}
						placeholder={INSTRUCTIONS_PLACEHOLDER}
						spellCheck={false}
						onChange={(event) => setInstructions(event.target.value)}
					/>
				</label>
				{error ? (
					<div className="settings-alert danger" role="alert">
						{error}
					</div>
				) : null}
				<div className="settings-form-footer">
					<span className="settings-form-note">{t("settingsSkillSavedTo")}</span>
					<button type="button" className="settings-btn" onClick={() => onDone(false)}>
						{t("cancel")}
					</button>
					<button
						type="submit"
						className="settings-btn primary"
						disabled={saving || nameInvalid || !name || !description.trim()}
					>
						{saving ? t("settingsSaving") : t("settingsSkillCreate")}
					</button>
				</div>
			</div>
		</form>
	);
}

/**
 * Pick a folder with the desktop shell's chooser, else the host's system
 * chooser when it has one; undefined when neither exists or the pick is cancelled.
 */
async function pickFolder(title: string): Promise<string | undefined> {
	return (await chooseResourceDirectory(title)) ?? undefined;
}

function ImportSkillDialog({ onImported }: { readonly onImported: () => void }) {
	const t = useT();
	const open = useAppStore((state) => state.ui.settingsDialog === "skillImport");
	const canPick = useAppStore((state) => state.directoryPicker === "native") || getDesktopBridge() !== undefined;
	const [path, setPath] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string>();
	const close = () => {
		if (pending) return;
		setError(undefined);
		closeSettingsDialog();
	};
	const choose = async () => {
		try {
			const picked = await pickFolder(t("settingsSkillImportPick"));
			if (picked) setPath(picked);
		} catch (caught) {
			setError(errorMessage(caught));
		}
	};
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!path.trim()) return;
		setPending(true);
		setError(undefined);
		try {
			const result = await apiSend<{ name: string }>(`${SKILLS_PATH}/import`, "POST", { path: path.trim() });
			showNotice(
				t("extensionManagement.importSucceeded"),
				t("settingsSkillImported", { name: result.name }),
				"success",
			);
			setPath("");
			closeSettingsDialog();
			onImported();
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setPending(false);
		}
	};
	return (
		<Modal
			open={open}
			onClose={close}
			id="settingsSkillImportDialog"
			className="settings-dialog"
			labelledBy="settingsSkillImportTitle"
		>
			<form onSubmit={(event) => void submit(event)}>
				<div className="settings-dialog-head">
					<h2 id="settingsSkillImportTitle">{t("settingsSkillImport")}</h2>
					<IconButton icon="close" iconSize="sm" aria-label={t("searchClose")} onClick={close} />
				</div>
				<p className="settings-dialog-desc">{t("settingsSkillImportDesc")}</p>
				<div className="settings-input-row">
					<input
						className="settings-input mono"
						id="settingsSkillImportPath"
						value={path}
						placeholder="~/Downloads/my-skill"
						aria-label={t("settingsSkillImportPath")}
						spellCheck={false}
						onChange={(event) => setPath(event.target.value)}
					/>
					{canPick ? (
						<button type="button" className="settings-btn" onClick={() => void choose()}>
							<Icon name="folder" size="xs" />
							{t("chooseFolder")}
						</button>
					) : null}
				</div>
				{error ? (
					<div className="settings-alert danger" role="alert">
						{error}
					</div>
				) : null}
				<div className="settings-dialog-footer">
					<button type="button" className="settings-btn" onClick={close} disabled={pending}>
						{t("cancel")}
					</button>
					<button type="submit" className="settings-btn primary" disabled={pending || !path.trim()}>
						{pending ? t("settingsWorking") : t("settingsImport")}
					</button>
				</div>
			</form>
		</Modal>
	);
}

export function SkillsPage() {
	const t = useT();
	const editor = useAppStore((state) => state.ui.settingsEditor);
	const resource = useSettingsResource<{ skills: SettingsSkill[] }>(SKILLS_PATH, true);
	const [query, setQuery] = useState("");
	const upload = useRef<HTMLInputElement>(null);
	const needle = query.trim().toLowerCase();
	const skills = (resource.data?.skills ?? []).filter(
		(skill) => !needle || `${skill.name} ${skill.description}`.toLowerCase().includes(needle),
	);

	if (editor?.kind === "skill") {
		return (
			<SkillEditor
				onDone={(saved) => {
					closeSettingsEditor();
					if (saved) invalidateExtensionResources();
				}}
			/>
		);
	}

	const toggle = async (skill: SettingsSkill, enabled: boolean) => {
		try {
			await apiSend(SKILLS_PATH, "PATCH", { id: skill.id, enabled });
			invalidateExtensionResources();
		} catch (error) {
			showError(errorMessage(error));
		}
		resource.reload();
	};
	const row = (skill: SettingsSkill) => (
		<SkillRow key={skill.id} skill={skill} onToggle={(enabled) => void toggle(skill, enabled)} />
	);

	return (
		<>
			<PageHeader
				title={t("settingsSkills")}
				description={t("settingsSkillsDesc")}
				actions={
					<div className="extension-management-actions">
						<Tooltip content={t("settingsRefresh")}>
							<IconButton icon="refresh" aria-label={t("settingsRefresh")} onClick={resource.reload} />
						</Tooltip>
						<ExtensionCreateMenu kind="skills" onUpload={() => upload.current?.click()} />
					</div>
				}
			/>
			<SearchInput
				wrapperClassName="settings-search extension-management-search"
				placeholder={t("settingsSkillsSearch")}
				aria-label={t("settingsSkillsSearch")}
				value={query}
				onChange={(event) => setQuery(event.target.value)}
			/>
			<input
				hidden
				type="file"
				ref={upload}
				accept=".zip,.skill,.md"
				onChange={(event) => {
					const file = event.currentTarget.files?.[0];
					event.currentTarget.value = "";
					void importSkillFile(file, t);
				}}
			/>
			<ResourceState
				loading={resource.loading}
				error={resource.error}
				hasData={resource.data !== undefined}
				loadingLabel={t("settingsLoading")}
			/>
			{resource.data ? (
				<ExtensionSourceGroups
					items={skills}
					origins={["market", "custom", "stepcode", "plugin"]}
					originOf={(skill) => skill.origin ?? (skill.source === "plugin" ? "plugin" : "custom")}
					renderItem={row}
				/>
			) : null}
			<ImportSkillDialog onImported={invalidateExtensionResources} />
		</>
	);
}
