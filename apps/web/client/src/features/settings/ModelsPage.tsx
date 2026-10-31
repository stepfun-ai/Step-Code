/**
 * Model providers: the custom `models.json` declarations, with the add card at
 * the bottom of the list.
 *
 * A provider row shows its id, a "custom" badge and where its key comes from —
 * never the key. The page writes the user's global configuration, so a change
 * reaches a session when that session starts; the footnote says so instead of
 * pretending the open session already changed.
 *
 * The third-party tab of the reference design has nothing to offer here: the
 * public build ships an empty generated catalog, so there are no registered
 * providers to pick from and only the custom form exists.
 */

import { useEffect, useState } from "react";
import { type TranslateFn, useT } from "../../i18n";
import { apiSend, errorMessage } from "../../lib/api";
import { cx } from "../../lib/format";
import { showError } from "../../state/session";
import { useAppStore } from "../../state/store";
import type { SettingsModelProvider } from "../../state/types";
import { Button, Icon, IconButton, Tooltip } from "../../ui";
import { closeSettingsEditor, openSettingsEditor, useSettingsResource } from "./actions";
import { ModelEditor } from "./ModelEditor";
import { Badge, EmptyBox, PageHeader, ResourceState, SectionHeader, SettingsCard, StatusDot } from "./parts";

const MODELS_PATH = "/api/v1/settings/models";

/** `stored` is a key this host holds; `configured` is one the declaration names. */
function credentialState(t: TranslateFn, provider: SettingsModelProvider): { tone: string; label: string } {
	switch (provider.credential) {
		case "stored":
			return { tone: "success", label: t("settingsModelsKeyStored") };
		case "configured":
			return { tone: "success", label: t("settingsModelsKeyConfigured") };
		default:
			return { tone: "off", label: t("settingsModelsKeyMissing") };
	}
}

function ProviderRow({
	provider,
	onDelete,
}: {
	readonly provider: SettingsModelProvider;
	readonly onDelete: () => void;
}) {
	const t = useT();
	const state = credentialState(t, provider);
	return (
		<div className="settings-list-row" data-model-provider={provider.id}>
			<span className="settings-row-icon">
				<Icon name="cube" />
			</span>
			<div className="settings-list-main">
				<div className="settings-list-title">
					<strong>{provider.name}</strong>
					{provider.name !== provider.id ? <span className="settings-badge">{provider.id}</span> : null}
					<Badge>{t("settingsModelsCustom")}</Badge>
					<StatusDot tone={state.tone} label={state.label} />
				</div>
				<div className="settings-list-desc mono" title={provider.baseUrl}>
					{provider.baseUrl}
					{provider.api ? ` · ${provider.api}` : ""}
					{provider.models.length > 0 ? ` · ${t("settingsModelsCount", { count: provider.models.length })}` : ""}
				</div>
			</div>
			<div className="settings-list-actions">
				<Tooltip content={t("settingsEdit")}>
					<IconButton
						icon="pencil"
						iconSize="xs"
						className="settings-icon-action"
						aria-label={t("settingsEdit")}
						onClick={() => openSettingsEditor({ kind: "model", id: provider.id })}
					/>
				</Tooltip>
				<Tooltip content={t("settingsDelete")}>
					<IconButton
						icon="trash"
						iconSize="xs"
						className="settings-icon-action danger"
						aria-label={t("settingsDelete")}
						onClick={onDelete}
					/>
				</Tooltip>
			</div>
		</div>
	);
}

export function ModelsPage() {
	const t = useT();
	const editor = useAppStore((state) => state.ui.settingsEditor);
	const resource = useSettingsResource<{ providers: SettingsModelProvider[] }>(MODELS_PATH, true);
	const [removing, setRemoving] = useState(false);
	const [openingConfig, setOpeningConfig] = useState(false);
	// Set once models.json was handed to an editor: the list reloads when the
	// window regains focus, so hand edits show up without a refresh control.
	const [editingConfig, setEditingConfig] = useState(false);
	const providers = resource.data?.providers ?? [];
	const { reload } = resource;

	useEffect(() => {
		if (!editingConfig) return;
		const onFocus = () => {
			setEditingConfig(false);
			reload();
		};
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [editingConfig, reload]);

	if (editor?.kind === "model") {
		return (
			<ModelEditor
				editor={editor}
				existing={providers.find((provider) => provider.id === editor.id)}
				onDone={(saved) => {
					closeSettingsEditor();
					if (saved) resource.reload();
				}}
			/>
		);
	}

	const remove = async (provider: SettingsModelProvider) => {
		if (!window.confirm(t("settingsModelsDeleteConfirm", { name: provider.name }))) return;
		setRemoving(true);
		try {
			await apiSend(`${MODELS_PATH}/${encodeURIComponent(provider.id)}`, "DELETE");
			showError(t("settingsModelsDeleted", { name: provider.name }), false);
		} catch (error) {
			showError(errorMessage(error));
		} finally {
			setRemoving(false);
		}
		resource.reload();
	};

	const openConfig = async () => {
		setOpeningConfig(true);
		try {
			await apiSend(`${MODELS_PATH}/open-config`, "POST");
			setEditingConfig(true);
		} catch (error) {
			showError(errorMessage(error));
		} finally {
			setOpeningConfig(false);
		}
	};

	const addCard = (
		<button
			type="button"
			className="settings-dashed-add"
			id="settingsModelNew"
			disabled={removing}
			onClick={() => openSettingsEditor({ kind: "model" })}
		>
			<Icon name="plus" size="xs" />
			{t("settingsModelsNew")}
		</button>
	);

	return (
		<>
			<PageHeader
				title={t("settingsModels")}
				description={t("settingsModelsDesc")}
				actions={
					<Tooltip content={t("settingsModelsOpenConfigHint")}>
						<Button
							type="button"
							className="settings-btn"
							id="settingsModelsOpenConfig"
							disabled={openingConfig}
							onClick={() => void openConfig()}
						>
							<Icon name="file" size="xs" />
							{t("settingsModelsOpenConfig")}
						</Button>
					</Tooltip>
				}
			/>
			<SectionHeader title={t("settingsModelsMine")} count={providers.length} />
			<ResourceState
				loading={resource.loading}
				error={resource.error}
				hasData={resource.data !== undefined}
				loadingLabel={t("settingsLoading")}
			/>
			{resource.data ? (
				<>
					{providers.length > 0 ? (
						<SettingsCard className="settings-list">
							{providers.map((provider) => (
								<ProviderRow key={provider.id} provider={provider} onDelete={() => void remove(provider)} />
							))}
						</SettingsCard>
					) : (
						<EmptyBox icon="cube" title={t("settingsModelsEmpty")} hint={t("settingsModelsEmptyHint")} />
					)}
					{addCard}
					<p className={cx("settings-footnote", "settings-models-footnote")}>
						{t("settingsAppliesToNewSessions")}
					</p>
				</>
			) : null}
		</>
	);
}
