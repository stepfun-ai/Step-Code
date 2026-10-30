/**
 * MCP servers: the user's servers from config.toml (create, edit, import JSON,
 * delete, switch on/off) and the servers installed plugins provide (switch
 * on/off only). Connection state is the host's last known state; settings
 * changes reconcile pooled connections and reach sessions before their next request.
 */

import { useMemo, useState } from "react";
import { type TranslateFn, useT } from "../../i18n";
import { apiSend } from "../../lib/api";
import { showError } from "../../state/session";
import { useAppStore } from "../../state/store";
import type { SettingsMcpServer } from "../../state/types";
import { Button, Icon, IconButton, SearchInput, Switch, Tooltip } from "../../ui";
import { closeSettingsEditor, openSettingsEditor, useSettingsResource } from "./actions";
import { McpEditor } from "./McpEditor";
import { Badge, EmptyBox, PageHeader, ResourceState, SectionHeader, SettingsCard, StatusDot } from "./parts";

const MCP_PATH = "/api/v1/settings/mcp";

function summary(t: TranslateFn, server: SettingsMcpServer): string {
	if (server.source === "plugin") return t("settingsMcpFromPlugin", { plugin: server.pluginName ?? "" });
	return t("settingsMcpStoredHidden");
}

function status(t: TranslateFn, server: SettingsMcpServer): { tone: string; label: string } {
	if (!server.enabled) return { tone: "off", label: t("settingsMcpOff") };
	switch (server.status) {
		case "connected":
			return { tone: "success", label: t("settingsMcpConnected", { count: server.toolCount ?? 0 }) };
		case "connecting":
			return { tone: "attention", label: t("mcpStatus.connecting") };
		case "failed":
			return { tone: "danger", label: t("mcpStatus.failed") };
		case "disabled":
			return { tone: "off", label: t("mcpStatus.disabled") };
		default:
			return { tone: "idle", label: t("settingsMcpIdle") };
	}
}

function McpRow({
	server,
	onToggle,
	onDelete,
}: {
	readonly server: SettingsMcpServer;
	readonly onToggle: (enabled: boolean) => void;
	readonly onDelete: () => void;
}) {
	const t = useT();
	const state = status(t, server);
	return (
		<div className="settings-list-row" data-mcp-server={server.name}>
			<span className="settings-row-icon">
				<Icon name={server.transport === "stdio" ? "terminal" : "globe"} />
			</span>
			<div className="settings-list-main">
				<div className="settings-list-title">
					<strong>{server.name}</strong>
					<Badge>{server.transport === "stdio" ? "stdio" : "HTTP"}</Badge>
					<StatusDot tone={state.tone} label={state.label} />
				</div>
				<Tooltip content={server.error && server.enabled ? t("settingsMcpSafeFailure") : summary(t, server)}>
					<div className="settings-list-desc">
						{server.error && server.enabled ? t("settingsMcpSafeFailure") : summary(t, server)}
					</div>
				</Tooltip>
			</div>
			<div className="settings-list-actions">
				{server.source === "user" ? (
					<>
						<Tooltip content={t("settingsEdit")}>
							<IconButton
								icon="pencil"
								iconSize="xs"
								className="settings-icon-action"
								aria-label={t("settingsEdit")}
								onClick={() => openSettingsEditor({ kind: "mcp", name: server.name })}
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
					</>
				) : null}
				<Switch
					checked={server.enabled}
					onChange={onToggle}
					aria-label={t("settingsToggleNamed", { name: server.name })}
				/>
			</div>
		</div>
	);
}

export function McpPage() {
	const t = useT();
	const editor = useAppStore((state) => state.ui.settingsEditor);
	const resource = useSettingsResource<{ servers: SettingsMcpServer[] }>(MCP_PATH, true);
	const [query, setQuery] = useState("");
	const servers = resource.data?.servers ?? [];
	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return needle
			? servers.filter((server) => `${server.name} ${server.pluginName ?? ""}`.toLowerCase().includes(needle))
			: servers;
	}, [servers, query]);
	const users = filtered.filter((server) => server.source === "user");
	const plugins = filtered.filter((server) => server.source === "plugin");
	const pluginGroups = [...new Set(plugins.map((server) => server.pluginName ?? ""))];

	if (editor?.kind === "mcp") {
		return (
			<McpEditor
				editor={editor}
				existing={servers.find((server) => server.name === editor.name && server.source === "user")}
				onDone={(saved) => {
					closeSettingsEditor();
					if (saved) resource.reload();
				}}
			/>
		);
	}

	const toggle = async (server: SettingsMcpServer, enabled: boolean) => {
		try {
			await apiSend(`${MCP_PATH}/${encodeURIComponent(server.name)}`, "PATCH", { enabled });
		} catch {
			showError(t("settingsMcpPatchFailed"));
		}
		resource.reload();
	};
	const remove = async (server: SettingsMcpServer) => {
		if (!window.confirm(t("settingsMcpDeleteConfirm", { name: server.name }))) return;
		try {
			await apiSend(`${MCP_PATH}/${encodeURIComponent(server.name)}`, "DELETE");
			showError(t("settingsMcpDeleted", { name: server.name }), false);
		} catch {
			showError(t("settingsMcpPatchFailed"));
		}
		resource.reload();
	};
	const row = (server: SettingsMcpServer) => (
		<McpRow
			key={server.name}
			server={server}
			onToggle={(enabled) => void toggle(server, enabled)}
			onDelete={() => void remove(server)}
		/>
	);

	return (
		<>
			<PageHeader
				title={t("settingsMcp")}
				description={t("settingsMcpDesc")}
				actions={
					<SearchInput
						wrapperClassName="settings-search"
						placeholder={t("settingsMcpSearch")}
						aria-label={t("settingsMcpSearch")}
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
				}
			/>
			<SectionHeader
				title={t("settingsMcpMine")}
				count={users.length}
				actions={
					<>
						<Tooltip content={t("settingsRefresh")}>
							<IconButton
								icon="refresh"
								iconSize="xs"
								className="settings-icon-action bordered"
								aria-label={t("settingsRefresh")}
								onClick={resource.reload}
							/>
						</Tooltip>
						<Button
							type="button"
							className="settings-btn"
							onClick={() => openSettingsEditor({ kind: "mcp", json: true })}
						>
							<Icon name="download" size="xs" />
							{t("settingsImport")}
						</Button>
						<Button
							type="button"
							className="settings-btn primary"
							id="settingsMcpNew"
							onClick={() => openSettingsEditor({ kind: "mcp" })}
						>
							<Icon name="plus" size="xs" />
							{t("settingsNew")}
						</Button>
					</>
				}
			/>
			<ResourceState
				loading={resource.loading}
				error={resource.error ? t("settingsMcpLoadFailed") : undefined}
				hasData={resource.data !== undefined}
				loadingLabel={t("settingsLoading")}
			/>
			{resource.data ? (
				users.length > 0 ? (
					<SettingsCard className="settings-list">{users.map(row)}</SettingsCard>
				) : (
					<EmptyBox
						icon="mcp"
						title={query ? t("settingsNoMatch") : t("settingsMcpEmpty")}
						hint={query ? undefined : t("settingsMcpEmptyHint")}
						actions={
							query ? undefined : (
								<>
									<Button
										type="button"
										className="settings-btn primary"
										onClick={() => openSettingsEditor({ kind: "mcp" })}
									>
										<Icon name="plus" size="xs" />
										{t("settingsMcpNew")}
									</Button>
									<Button
										type="button"
										className="settings-btn"
										onClick={() => openSettingsEditor({ kind: "mcp", json: true })}
									>
										<Icon name="download" size="xs" />
										{t("settingsMcpImportJson")}
									</Button>
								</>
							)
						}
					/>
				)
			) : null}
			{pluginGroups.map((group) => {
				const members = plugins.filter((server) => (server.pluginName ?? "") === group);
				return (
					<section key={group} className="settings-group">
						<SectionHeader
							title={t("settingsFromPlugin", { plugin: group })}
							count={members.length}
							hint={t("settingsMcpPluginHint")}
						/>
						<SettingsCard className="settings-list">{members.map(row)}</SettingsCard>
					</section>
				);
			})}
		</>
	);
}
