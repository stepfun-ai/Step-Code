import type { TranslateFn } from "../../i18n";
import { api, apiSend, errorMessage } from "../../lib/api";
import { showNotice } from "../../state/session";
import type { SettingsPluginInstallPreview as PluginPreview, SettingsPluginDependency } from "../../state/types";
import { invalidateExtensionResources } from "./extension-removal";

export function pluginDependencyMessage(dependency: SettingsPluginDependency, t: TranslateFn): string {
	const lines = [
		t(
			dependency.status === "installed"
				? "pluginDependency.installed"
				: dependency.status === "ready"
					? "pluginDependency.ready"
					: "pluginDependency.unavailable",
			{ command: dependency.command },
		),
	];
	if (dependency.reason) lines.push(t(`pluginDependency.reason.${dependency.reason}`));
	if (dependency.firstUseConfiguration || dependency.status === "setup_required")
		lines.push(t("pluginDependency.firstUse"));
	if (dependency.setupCommand) lines.push(t("pluginDependency.setupCommand", { command: dependency.setupCommand }));
	return lines.join("\n");
}
function installed(preview: PluginPreview, t: TranslateFn): void {
	invalidateExtensionResources();
	const dependency =
		preview.dependency ??
		(preview.provisionCommand
			? {
					command: preview.provisionCommand,
					status: "setup_required" as const,
					reason: "unsupported" as const,
					firstUseConfiguration: true,
				}
			: undefined);
	const pending = dependency?.status === "setup_required";
	showNotice(
		t(pending ? "pluginDependency.needsSetup" : "extensionManagement.installSucceeded"),
		t("pluginInstall.done", { name: preview.name }) +
			(dependency ? `\n${pluginDependencyMessage(dependency, t)}` : ""),
		pending ? "neutral" : "success",
	);
}
export async function preparePluginCli(id: string, t: TranslateFn): Promise<void> {
	try {
		const result = await apiSend<{ dependency?: SettingsPluginDependency }>(
			`/api/v1/settings/plugins/${encodeURIComponent(id)}/prepare`,
			"POST",
		);
		invalidateExtensionResources();
		if (result.dependency)
			showNotice(
				t(
					result.dependency.status === "setup_required"
						? "pluginDependency.needsSetup"
						: "pluginDependency.prepared",
				),
				pluginDependencyMessage(result.dependency, t),
				result.dependency.status === "setup_required" ? "neutral" : "success",
			);
	} catch (error) {
		showNotice(t("pluginDependency.prepareFailed"), errorMessage(error), "danger");
	}
}
export async function installCatalogPlugin(catalogId: string, t: TranslateFn): Promise<boolean> {
	try {
		const preview = await api<PluginPreview>(`/api/v1/settings/plugins/catalog/${encodeURIComponent(catalogId)}`);
		const result = await apiSend<PluginPreview>("/api/v1/settings/plugins", "POST", {
			catalogId,
			fingerprint: preview.fingerprint,
			confirmed: true,
		});
		installed(result, t);
		return true;
	} catch (error) {
		showNotice(t("extensionManagement.installFailed"), errorMessage(error), "danger");
		return false;
	}
}
export async function importPluginFile(file: File | undefined, t: TranslateFn): Promise<boolean> {
	if (!file) return false;
	try {
		if (!file.name.toLowerCase().endsWith(".zip") || file.size > 32 * 1024 * 1024)
			throw new Error(t("pluginInstall.zipRequired"));
		const data = await new Promise<string>((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () =>
				typeof reader.result === "string"
					? resolve(reader.result.split(",")[1])
					: reject(new Error(t("pluginInstall.readFailed")));
			reader.onerror = () => reject(new Error(t("pluginInstall.readFailed")));
			reader.onabort = reader.onerror;
			reader.readAsDataURL(file);
		});
		const result = await apiSend<{ preview: PluginPreview; installed: boolean }>(
			"/api/v1/settings/plugins/import",
			"POST",
			{ data },
		);
		const completed = await apiSend<{ preview: PluginPreview; installed: boolean }>(
			"/api/v1/settings/plugins/import",
			"POST",
			{
				data,
				fingerprint: result.preview.fingerprint,
				confirmed: true,
			},
		);
		if (!completed.installed) throw new Error(t("pluginInstall.readFailed"));
		installed(completed.preview, t);
		return true;
	} catch (error) {
		showNotice(t("extensionManagement.uploadPluginFailed"), errorMessage(error), "danger");
		return false;
	}
}
