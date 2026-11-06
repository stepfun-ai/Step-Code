import type { TranslateFn } from "../../i18n";
import type { SettingsMcpServer } from "../../state/types";

export function connectorSource(t: TranslateFn, server: SettingsMcpServer): string {
	const origin = server.origin ?? (server.source === "plugin" ? "plugin" : "custom");
	return server.source === "plugin"
		? `${t(`extensionOrigin.${origin}`)} · ${server.pluginName ?? t("extensionDetail.unknown")}`
		: t(`extensionOrigin.${origin}`);
}

export function connectorStatus(t: TranslateFn, server: SettingsMcpServer): string {
	if (!server.enabled) return t("settingsMcpOff");
	switch (server.status) {
		case "connected":
			return server.toolCount === undefined
				? t("mcpStatus.connected")
				: t("settingsMcpConnected", { count: server.toolCount });
		case "connecting":
			return t("mcpStatus.connecting");
		case "failed":
			return t("mcpStatus.failed");
		case "disabled":
			return t("mcpStatus.disabled");
		default:
			return t("settingsMcpIdle");
	}
}

/** Public service address only: credentials, query tokens and fragments are removed. */
export function sanitizedServiceUrl(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		// Only the origin is shown: paths and queries can embed workspace or tenant secrets.
		return url.origin;
	} catch {
		return undefined;
	}
}

export function connectorAuth(server: SettingsMcpServer): "oauth" | "bearer" | "header" | "unknown" {
	const config = server.config;
	if (config?.oauth) return "oauth";
	if (config?.bearer_token_env_var) return "bearer";
	if (Object.keys(config?.http_headers ?? {}).length || Object.keys(config?.env_http_headers ?? {}).length)
		return "header";
	return "unknown";
}

export function filterConnectors(servers: readonly SettingsMcpServer[], query: string): SettingsMcpServer[] {
	const needle = query.trim().toLocaleLowerCase();
	return servers.filter((server) =>
		`${server.name} ${server.pluginName ?? ""} ${server.transport}`.toLocaleLowerCase().includes(needle),
	);
}
