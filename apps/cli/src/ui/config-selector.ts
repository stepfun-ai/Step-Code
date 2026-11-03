/**
 * TUI config selector for `pi config` command
 */

import type { SettingsManager } from "@step-harness/coding-agent";
import { CONFIG_DIR_NAME, initTheme, setThemeStorageDir, stopThemeWatcher } from "@step-harness/coding-agent";
import { ProcessTerminal, type TUI, TuiMainScreen } from "@step-harness/pi-tui";
import { ConfigSelectorComponent, type ScopedResolvedPaths } from "./view/dialogs/config-selector.ts";

export interface ConfigSelectorOptions {
	resolvedPaths: ScopedResolvedPaths;
	settingsManager: SettingsManager;
	cwd: string;
	agentDir: string;
	configDirName?: string;
	writeScope: "global" | "project";
	projectModeAvailable: boolean;
}

/** Show TUI config selector and return when closed */
export async function selectConfig(options: ConfigSelectorOptions): Promise<void> {
	setThemeStorageDir(options.agentDir);
	// Initialize theme before showing TUI
	initTheme(options.settingsManager.getTheme() ?? process.env.STEPCODE_DEFAULT_THEME?.trim(), true);

	return new Promise((resolve) => {
		const ui: TUI = new TuiMainScreen(new ProcessTerminal(), undefined, options.agentDir);
		let resolved = false;

		const selector = new ConfigSelectorComponent(
			options.resolvedPaths,
			options.settingsManager,
			options.cwd,
			options.agentDir,
			() => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					stopThemeWatcher();
					resolve();
				}
			},
			() => {
				ui.stop();
				stopThemeWatcher();
				process.exit(0);
			},
			() => ui.requestRender(),
			ui.terminal.rows,
			options.writeScope,
			options.projectModeAvailable,
			options.configDirName ?? CONFIG_DIR_NAME,
		);

		ui.addChild(selector);
		ui.setFocus(selector.getResourceList());
		ui.start();
	});
}
