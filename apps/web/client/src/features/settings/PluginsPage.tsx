/**
 * Plugins: installed user plugins (uninstall), plugins offered by the configured
 * marketplaces (install), and the marketplaces themselves (add, update, remove).
 * Plugin-level enable/disable gates its contributions without removing installed files.
 */

import { type FormEvent, useRef, useState } from "react";
import { useT } from "../../i18n";
import { apiSend, errorMessage } from "../../lib/api";
import { cx } from "../../lib/format";
import { showError, showNotice, showToast } from "../../state/session";
import { useAppStore } from "../../state/store";
import type { SettingsPluginCatalog } from "../../state/types";
import { Button, Icon, IconButton, Modal, SearchInput, Switch, Tooltip } from "../../ui";
import { closeSettingsDialog, invalidateExtensionResources, openSettingsDialog, useSettingsResource } from "./actions";
import { ExtensionCreateMenu } from "./ExtensionCreateMenu";
import { ExtensionRowMenu } from "./ExtensionRowMenu";
import { ExtensionSourceGroups } from "./ExtensionSourceGroups";
import { PluginDependencyStatus } from "./PluginDependencyStatus";
import { Badge, EmptyBox, PageHeader, ResourceState, SectionHeader, SettingsCard } from "./parts";
import { importPluginFile } from "./plugin-actions";

const PLUGINS_PATH = "/api/v1/settings/plugins";
const MARKETPLACES_PATH = "/api/v1/settings/marketplaces";

type Tab = "installed" | "discover" | "sources";

/** First letter of a plugin name on a tinted tile, a stable stand-in for a plugin icon. */
function PluginMark({ name }: { readonly name: string }) {
	const hue = [...name].reduce((sum, char) => sum + (char.codePointAt(0) ?? 0), 0) % 6;
	return (
		<span className={cx("settings-row-icon plugin-mark", `hue-${hue}`)} aria-hidden="true">
			{name.slice(0, 1).toUpperCase()}
		</span>
	);
}

/** One installed plugin: the enable/disable gate plus the shared overflow menu (trial, uninstall). */
function PluginRow({
	plugin,
	busy,
	onToggle,
}: {
	readonly plugin: SettingsPluginCatalog["installed"][number];
	readonly busy: boolean;
	readonly onToggle: (enabled: boolean) => void;
}) {
	const t = useT();
	const [menuOpen, setMenuOpen] = useState(false);
	return (
		<div className="settings-list-row" data-plugin={plugin.id}>
			<PluginMark name={plugin.name} />
			<div className="settings-list-main">
				<div className="settings-list-title">
					<strong>{plugin.name}</strong>
					{plugin.version ? <Badge>v{plugin.version}</Badge> : null}
					{plugin.mcpServers.length ? (
						<Badge>{t("settingsPluginMcpCount", { count: plugin.mcpServers.length })}</Badge>
					) : null}
				</div>
				<div className="settings-list-desc">{plugin.description || t("settingsNoDescription")}</div>
				<PluginDependencyStatus id={plugin.id} dependency={plugin.dependency} />
			</div>
			<div className="settings-list-actions visible">
				<ExtensionRowMenu
					resource={{ kind: "plugins", id: plugin.id, name: plugin.name, enabled: plugin.enabled }}
					name={plugin.name}
					open={menuOpen}
					onOpenChange={setMenuOpen}
					triggerClassName="settings-icon-action"
				/>
				<Tooltip content={t("extensionManagement.pluginToggleNote")}>
					<Switch
						checked={plugin.enabled !== false}
						disabled={busy}
						aria-label={t("settingsToggleNamed", { name: plugin.name })}
						onChange={onToggle}
					/>
				</Tooltip>
			</div>
		</div>
	);
}

function AddMarketplaceDialog({ onAdded }: { readonly onAdded: () => void }) {
	const t = useT();
	const open = useAppStore((state) => state.ui.settingsDialog === "marketplace");
	const [source, setSource] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string>();
	const close = () => {
		if (pending) return;
		setError(undefined);
		closeSettingsDialog();
	};
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!source.trim()) return;
		setPending(true);
		setError(undefined);
		try {
			const result = await apiSend<{ warnings: string[] }>(MARKETPLACES_PATH, "POST", { source: source.trim() });
			showError(
				result.warnings.length > 0 ? result.warnings.join(" ") : t("settingsMarketplaceAdded"),
				result.warnings.length > 0,
			);
			setSource("");
			closeSettingsDialog();
			onAdded();
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
			id="settingsMarketplaceDialog"
			className="settings-dialog"
			labelledBy="settingsMarketplaceTitle"
		>
			<form onSubmit={(event) => void submit(event)}>
				<div className="settings-dialog-head">
					<h2 id="settingsMarketplaceTitle">{t("settingsMarketplaceAdd")}</h2>
					<IconButton icon="close" iconSize="sm" aria-label={t("searchClose")} onClick={close} />
				</div>
				<p className="settings-dialog-desc">{t("settingsMarketplaceAddDesc")}</p>
				<input
					className="settings-input mono"
					id="settingsMarketplaceSource"
					value={source}
					placeholder={t("settingsMarketplacePlaceholder")}
					aria-label={t("settingsMarketplaceAdd")}
					spellCheck={false}
					onChange={(event) => setSource(event.target.value)}
				/>
				{error ? (
					<div className="settings-alert danger" role="alert">
						{error}
					</div>
				) : null}
				<div className="settings-dialog-footer">
					<button type="button" className="settings-btn" onClick={close} disabled={pending}>
						{t("cancel")}
					</button>
					<button type="submit" className="settings-btn primary" disabled={pending || !source.trim()}>
						{pending ? t("settingsMarketplaceAdding") : t("settingsMarketplaceAdd")}
					</button>
				</div>
			</form>
		</Modal>
	);
}

export function PluginsPage() {
	const t = useT();
	const resource = useSettingsResource<SettingsPluginCatalog>(PLUGINS_PATH, true);
	const [tab, setTab] = useState<Tab>("installed");
	const [query, setQuery] = useState("");
	const upload = useRef<HTMLInputElement>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const catalog = resource.data;
	const needle = query.trim().toLowerCase();
	const matches = (text: string) => !needle || text.toLowerCase().includes(needle);
	const installed = (catalog?.installed ?? []).filter((plugin) =>
		matches(`${plugin.name} ${plugin.description ?? ""}`),
	);
	const available = (catalog?.available ?? []).filter((plugin) =>
		matches(`${plugin.name} ${plugin.description ?? ""}`),
	);
	const marketplaces = catalog?.marketplaces ?? [];

	const run = async (
		key: string,
		action: () => Promise<{ warnings?: string[] } | unknown>,
		done: string,
		title?: string,
	) => {
		setBusy(key);
		try {
			const result = (await action()) as { warnings?: string[] } | undefined;
			const warnings = result?.warnings ?? [];
			const message = warnings.length > 0 ? `${done} ${warnings.join(" ")}` : done;
			if (title) showNotice(title, message, "success");
			else showToast(message);
		} catch (error) {
			showNotice(
				title ? t("extensionManagement.installFailed") : t("extensionManagement.operationFailed"),
				errorMessage(error),
				"danger",
			);
		} finally {
			setBusy(null);
			resource.reload();
		}
	};
	const toggle = async (id: string, enabled: boolean) => {
		setBusy(`toggle:${id}`);
		try {
			await apiSend(`${PLUGINS_PATH}/${encodeURIComponent(id)}`, "PATCH", { enabled });
			invalidateExtensionResources();
		} catch {
			showError(t("extensionManagement.pluginToggleFailed"));
		} finally {
			setBusy(null);
		}
	};
	const install = (name: string, marketplace: string) =>
		void run(
			`install:${name}`,
			() => apiSend(PLUGINS_PATH, "POST", { name, marketplace }),
			t("settingsPluginInstalled", { name }),
			t("extensionManagement.installSucceeded"),
		);

	return (
		<>
			<PageHeader
				title={t("settingsPlugins")}
				description={t("settingsPluginsDesc")}
				actions={
					<div className="extension-management-actions">
						<Tooltip content={t("settingsRefresh")}>
							<IconButton icon="refresh" aria-label={t("settingsRefresh")} onClick={resource.reload} />
						</Tooltip>
						<ExtensionCreateMenu kind="plugins" onUpload={() => upload.current?.click()} />
					</div>
				}
			/>
			{tab !== "installed" ? (
				<Button className="settings-link" onClick={() => setTab("installed")}>
					<Icon name="back" size="sm" />
					{t("extensionManagement.backToPlugins")}
				</Button>
			) : null}
			<SearchInput
				wrapperClassName="settings-search extension-management-search"
				placeholder={t("settingsPluginsSearch")}
				aria-label={t("settingsPluginsSearch")}
				value={query}
				onChange={(event) => setQuery(event.target.value)}
			/>
			<input
				hidden
				type="file"
				ref={upload}
				accept=".zip"
				onChange={(event) => {
					const file = event.currentTarget.files?.[0];
					event.currentTarget.value = "";
					void importPluginFile(file, t);
				}}
			/>
			{tab === "sources" ? (
				<Button className="settings-btn" onClick={() => openSettingsDialog("marketplace")}>
					<Icon name="store" size="xs" />
					{t("settingsMarketplaceAdd")}
				</Button>
			) : null}
			<ResourceState
				loading={resource.loading}
				error={resource.error}
				hasData={catalog !== undefined}
				loadingLabel={t("settingsLoading")}
			/>
			{catalog && tab === "installed" ? (
				<ExtensionSourceGroups
					items={installed}
					origins={["market", "custom", "stepcode"]}
					originOf={(plugin) => plugin.origin ?? "custom"}
					renderItem={(plugin) => (
						<PluginRow
							key={plugin.id}
							plugin={plugin}
							busy={busy === `toggle:${plugin.id}`}
							onToggle={(enabled) => void toggle(plugin.id, enabled)}
						/>
					)}
				/>
			) : null}
			{catalog && tab === "discover" ? (
				available.length > 0 ? (
					<div className="plugin-grid">
						{available.map((plugin) => {
							const key = `install:${plugin.name}`;
							return (
								<article className="plugin-card" key={`${plugin.marketplace}/${plugin.name}`}>
									<div className="plugin-card-head">
										<PluginMark name={plugin.name} />
										<div>
											<strong>{plugin.name}</strong>
											<small>{plugin.marketplace}</small>
										</div>
									</div>
									<p>{plugin.description || t("settingsNoDescription")}</p>
									<div className="plugin-card-foot">
										{plugin.installed ? (
											<span className="settings-installed">
												<Icon name="check" size="xs" />
												{t("settingsPluginInstalledTag")}
											</span>
										) : (
											<button
												type="button"
												className="settings-btn primary"
												disabled={busy === key}
												onClick={() => install(plugin.name, plugin.marketplace)}
											>
												{busy === key ? t("settingsWorking") : t("install")}
											</button>
										)}
									</div>
								</article>
							);
						})}
					</div>
				) : (
					<EmptyBox
						icon="store"
						title={needle ? t("settingsNoMatch") : t("settingsPluginsNoneAvailable")}
						hint={needle ? undefined : t("settingsPluginsNoneAvailableHint")}
					/>
				)
			) : null}
			{catalog && tab === "sources" ? (
				<>
					<SectionHeader title={t("settingsMarketplaces")} hint={t("settingsMarketplacesHint")} />
					<SettingsCard className="settings-list">
						{marketplaces.map((source) => (
							<div className="settings-list-row" key={source.name} data-marketplace={source.name}>
								<span className="settings-row-icon">
									<Icon name="store" />
								</span>
								<div className="settings-list-main">
									<div className="settings-list-title">
										<strong>{source.name}</strong>
										<Badge>{t(`settingsMarketplaceKind.${source.kind}`)}</Badge>
									</div>
									<div className="settings-list-desc mono">
										{source.origin ??
											(source.kind === "builtin"
												? t("settingsMarketplaceBuiltinDesc")
												: t("settingsMarketplaceLocalDesc"))}
									</div>
								</div>
								<div className="settings-list-actions visible">
									{source.kind === "git" ? (
										<button
											type="button"
											className="settings-btn"
											disabled={busy === `update:${source.name}`}
											onClick={() =>
												void run(
													`update:${source.name}`,
													() =>
														apiSend(
															`${MARKETPLACES_PATH}/${encodeURIComponent(source.name)}/update`,
															"POST",
														),
													t("settingsMarketplaceUpdated", { name: source.name }),
												)
											}
										>
											{busy === `update:${source.name}` ? t("settingsWorking") : t("settingsUpdate")}
										</button>
									) : null}
									{source.kind !== "builtin" ? (
										<Tooltip content={t("settingsDelete")}>
											<IconButton
												icon="trash"
												iconSize="xs"
												className="settings-icon-action danger"
												aria-label={t("settingsDelete")}
												onClick={() => {
													if (
														!window.confirm(t("settingsMarketplaceRemoveConfirm", { name: source.name }))
													)
														return;
													void run(
														`remove-source:${source.name}`,
														() =>
															apiSend(
																`${MARKETPLACES_PATH}/${encodeURIComponent(source.name)}`,
																"DELETE",
															),
														t("settingsMarketplaceRemoved", { name: source.name }),
													);
												}}
											/>
										</Tooltip>
									) : null}
								</div>
							</div>
						))}
					</SettingsCard>
				</>
			) : null}
			{catalog && catalog.warnings.length > 0 ? (
				<details className="settings-warnings">
					<summary>{t("settingsWarnings", { count: catalog.warnings.length })}</summary>
					<ul>
						{catalog.warnings.map((warning) => (
							<li key={warning}>{warning}</li>
						))}
					</ul>
				</details>
			) : null}
			<AddMarketplaceDialog onAdded={resource.reload} />
		</>
	);
}
