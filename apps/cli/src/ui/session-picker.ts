/**
 * TUI session selector for --resume flag
 */

import type { SessionInfo, SessionListProgress, SettingsManager } from "@step-harness/coding-agent";
import { KeybindingsManager } from "@step-harness/coding-agent";
import { setKeybindings } from "@step-harness/pi-tui";
import { createStartupTui, type StartupTuiPathOptions, startStartupTui } from "./startup-ui.ts";
import { SessionSelectorComponent } from "./view/dialogs/session-selector.ts";

type SessionsLoader = (onProgress?: SessionListProgress) => Promise<SessionInfo[]>;

/** Show TUI session selector and return selected session path or null if cancelled */
export async function selectSession(
	currentSessionsLoader: SessionsLoader,
	allSessionsLoader: SessionsLoader,
	settingsManager: SettingsManager,
	paths?: StartupTuiPathOptions,
): Promise<string | null> {
	const ui = await createStartupTui(settingsManager, paths);
	return new Promise((resolve) => {
		const keybindings = KeybindingsManager.create(paths?.agentDir);
		setKeybindings(keybindings);
		let resolved = false;

		const selector = new SessionSelectorComponent(
			currentSessionsLoader,
			allSessionsLoader,
			(path: string) => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					resolve(path);
				}
			},
			() => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					resolve(null);
				}
			},
			() => {
				ui.stop();
				process.exit(0);
			},
			() => ui.requestRender(),
			{ showRenameHint: false, keybindings },
		);

		ui.addChild(selector);
		ui.setFocus(selector.getSessionList());
		startStartupTui(ui, settingsManager);
	});
}
