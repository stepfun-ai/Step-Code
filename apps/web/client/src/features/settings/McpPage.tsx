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
import { closeSettingsEditor, invalidateExtensionResources, openSettingsEditor, useSettingsResource } from "./actions";
import { ExtensionRowMenu } from "./ExtensionRowMenu";
import { ExtensionSourceGroups } from "./ExtensionSourceGroups";
import { McpEditor } from "./McpEditor";
import { Badge, PageHeader, ResourceState, StatusDot } from "./parts";

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
}: {
	readonly server: SettingsMcpServer;
	readonly onToggle: (enabled: boolean) => void;
}) {
	const t = useT();
	const state = status(t, server);
	const [menuOpen, setMenuOpen] = useState(false);
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
					<Tooltip content={t("settingsEdit")}>
						<IconButton
							icon="pencil"
							iconSize="xs"
							className="settings-icon-action"
							aria-label={t("settingsEdit")}
							onClick={() => openSettingsEditor({ kind: "mcp", name: server.name })}
						/>
					</Tooltip>
				) : null}
				<ExtensionRowMenu
					resource={{ kind: "connectors", server }}
					name={server.name}
					open={menuOpen}
					onOpenChange={setMenuOpen}
					triggerClassName="settings-icon-action"
				/>
				<Tooltip content={server.pluginEnabled === false ? t("extensionManagement.enablePluginFirst") : null}>
					<Switch
						checked={server.enabled}
						disabled={server.pluginEnabled === false}
						onChange={onToggle}
						aria-label={t("settingsToggleNamed", { name: server.name })}
					/>
				</Tooltip>
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

	if (editor?.kind === "mcp") {
		return (
			<McpEditor
				editor={editor}
				existing={servers.find((server) => server.name === editor.name && server.source === "user")}
				onDone={(saved) => {
					closeSettingsEditor();
					if (saved) invalidateExtensionResources();
				}}
			/>
		);
	}

	const toggle = async (server: SettingsMcpServer, enabled: boolean) => {
		try {
			await apiSend(`${MCP_PATH}/${encodeURIComponent(server.name)}`, "PATCH", { enabled });
			invalidateExtensionResources();
		} catch {
			showError(t("settingsMcpPatchFailed"));
		}
		resource.reload();
	};
	const row = (server: SettingsMcpServer) => (
		<McpRow key={server.name} server={server} onToggle={(enabled) => void toggle(server, enabled)} />
	);

	return (
		<>
			<PageHeader
				title={t("settingsMcp")}
				description={t("settingsMcpDesc")}
				actions={
					<div className="extension-management-actions">
						<Tooltip content={t("settingsRefresh")}>
							<IconButton icon="refresh" aria-label={t("settingsRefresh")} onClick={resource.reload} />
						</Tooltip>
						<Button
							className="settings-btn primary"
							id="settingsMcpNew"
							onClick={() => openSettingsEditor({ kind: "mcp" })}
						>
							<Icon name="plus" size="xs" />
							{t("settingsNew")}
						</Button>
					</div>
				}
			/>
			<SearchInput
				wrapperClassName="settings-search extension-management-search"
				placeholder={t("settingsMcpSearch")}
				aria-label={t("settingsMcpSearch")}
				value={query}
				onChange={(event) => setQuery(event.target.value)}
			/>
			<ResourceState
				loading={resource.loading}
				error={resource.error ? t("settingsMcpLoadFailed") : undefined}
				hasData={resource.data !== undefined}
				loadingLabel={t("settingsLoading")}
			/>
			{resource.data ? (
				<ExtensionSourceGroups
					items={filtered}
					origins={["custom", "stepcode", "plugin"]}
					originOf={(server) => server.origin ?? (server.source === "plugin" ? "plugin" : "custom")}
					renderItem={row}
				/>
			) : null}
		</>
	);
}
