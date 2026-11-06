import { activeCwd, startDraft } from "../../state/session";
import { setUi } from "../../state/store";
import { seedExtensionReference } from "../composer/actions";
import type { ExtensionRemoval } from "./extension-removal";

/** Trial stages a reference in a fresh conversation; it never writes message text or sends it. */
export function startExtensionTrial(resource: ExtensionRemoval): void {
	if (
		resource.kind === "plugins"
			? resource.enabled === false
			: resource.kind === "skills"
				? !resource.skill.enabled
				: !resource.server.enabled
	)
		return;
	const name =
		resource.kind === "plugins"
			? resource.name
			: resource.kind === "skills"
				? resource.skill.name
				: resource.server.name;
	const kind = resource.kind === "plugins" ? "plugin" : resource.kind === "skills" ? "skill" : "connector";
	startDraft(activeCwd(), { listed: true });
	seedExtensionReference(kind, name);
	setUi({
		midView: null,
		settingsPage: null,
		settingsEditor: null,
		settingsDialog: null,
		promptDraftRequest: undefined,
	});
}
