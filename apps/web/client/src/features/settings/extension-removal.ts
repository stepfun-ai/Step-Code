import type { TranslateFn } from "../../i18n";
import { apiSend, errorMessage } from "../../lib/api";
import { showError } from "../../state/session";
import type { SettingsMcpServer, SettingsSkill } from "../../state/types";

export type ExtensionRemoval =
	| { readonly kind: "plugins"; readonly id: string; readonly name: string; readonly enabled?: boolean }
	| { readonly kind: "skills"; readonly skill: SettingsSkill }
	| { readonly kind: "connectors"; readonly server: SettingsMcpServer };

let revision = 0;
const listeners = new Set<() => void>();
const pending = new Set<string>();
export function extensionResourceSnapshot(): number {
	return revision;
}
export function subscribeExtensionResources(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
export function invalidateExtensionResources(): void {
	revision++;
	for (const listener of listeners) listener();
}
export function canRemoveExtension(resource: ExtensionRemoval): boolean {
	return (
		resource.kind === "plugins" ||
		(resource.kind === "skills"
			? resource.skill.source === "user" && resource.skill.deletable
			: resource.server.source === "user")
	);
}

export async function removeExtension(resource: ExtensionRemoval, t: TranslateFn): Promise<boolean> {
	if (!canRemoveExtension(resource)) return false;
	const name =
		resource.kind === "plugins"
			? resource.name
			: resource.kind === "skills"
				? resource.skill.name
				: resource.server.name;
	const id =
		resource.kind === "plugins" ? resource.id : resource.kind === "skills" ? resource.skill.id : resource.server.name;
	const key = `${resource.kind}:${id}`;
	if (pending.has(key)) return false;
	const confirm =
		resource.kind === "plugins"
			? t("settingsPluginRemoveConfirm", { name })
			: resource.kind === "skills"
				? t("settingsSkillDeleteConfirm", { name, location: resource.skill.location })
				: t("settingsMcpDeleteConfirm", { name });
	if (!window.confirm(confirm)) return false;
	pending.add(key);
	try {
		const path =
			resource.kind === "plugins"
				? `/api/v1/settings/plugins/${encodeURIComponent(id)}`
				: resource.kind === "skills"
					? `/api/v1/settings/skills?${new URLSearchParams({ id })}`
					: `/api/v1/settings/mcp/${encodeURIComponent(id)}`;
		const result = await apiSend<{ warnings?: string[] }>(path, "DELETE");
		invalidateExtensionResources();
		const warnings = Array.isArray(result?.warnings)
			? result.warnings.filter((value) => typeof value === "string")
			: [];
		showError(
			t(
				resource.kind === "plugins"
					? "settingsPluginRemoved"
					: resource.kind === "skills"
						? "settingsSkillDeleted"
						: "settingsMcpDeleted",
				{ name },
			) + (warnings.length ? ` ${warnings.join(" ")}` : ""),
			false,
		);
		return true;
	} catch (error) {
		showError(resource.kind === "connectors" ? t("settingsMcpPatchFailed") : errorMessage(error));
		return false;
	} finally {
		pending.delete(key);
	}
}
