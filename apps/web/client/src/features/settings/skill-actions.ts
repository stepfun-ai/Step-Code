import type { TranslateFn } from "../../i18n";
import { api, apiSend, errorMessage } from "../../lib/api";
import { showNotice } from "../../state/session";
import type { SettingsPluginInstallPreview as Preview } from "../../state/types";
import { invalidateExtensionResources } from "./extension-removal";

function installed(preview: Preview, t: TranslateFn): void {
	invalidateExtensionResources();
	showNotice(t("extensionManagement.installSucceeded"), t("skillInstall.done", { name: preview.name }), "success");
}
export async function installCatalogSkill(catalogId: string, t: TranslateFn): Promise<boolean> {
	try {
		const preview = await api<Preview>(`/api/v1/settings/skills/catalog/${encodeURIComponent(catalogId)}`);
		installed(
			await apiSend<Preview>("/api/v1/settings/skills", "POST", {
				catalogId,
				fingerprint: preview.fingerprint,
				confirmed: true,
			}),
			t,
		);
		return true;
	} catch (error) {
		showNotice(t("extensionManagement.installFailed"), errorMessage(error), "danger");
		return false;
	}
}
export async function importSkillFile(file: File | undefined, t: TranslateFn): Promise<boolean> {
	if (!file) return false;
	try {
		const markdown = file.name.toLowerCase() === "skill.md";
		if ((!markdown && !/\.(zip|skill)$/iu.test(file.name)) || file.size > 32 * 1024 * 1024)
			throw new Error(t("skillInstall.fileRequired"));
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
		const payload = { data, format: markdown ? "markdown" : "zip" };
		const result = await apiSend<{ preview: Preview; installed: boolean }>(
			"/api/v1/settings/skills/upload",
			"POST",
			payload,
		);
		const completed = await apiSend<{ preview: Preview; installed: boolean }>(
			"/api/v1/settings/skills/upload",
			"POST",
			{ ...payload, confirmed: true, fingerprint: result.preview.fingerprint },
		);
		if (!completed.installed) throw new Error(t("pluginInstall.readFailed"));
		installed(completed.preview, t);
		return true;
	} catch (error) {
		showNotice(t("extensionManagement.uploadSkillFailed"), errorMessage(error), "danger");
		return false;
	}
}
