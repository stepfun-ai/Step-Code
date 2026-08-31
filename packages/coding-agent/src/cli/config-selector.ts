/**
 * TUI config selector for `pi config` command
 */

import { ProcessTerminal, type TUI, TuiMainScreen } from "@earendil-works/pi-tui";
import { CONFIG_DIR_NAME } from "../config.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { ConfigSelectorComponent, type ScopedResolvedPaths } from "../modes/interactive/components/config-selector.ts";
import { initTheme, setThemeStorageDir, stopThemeWatcher } from "../modes/interactive/theme/theme.ts";

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
	initTheme(options.settingsManager.getTheme() ?? process.env.STEP_CLI_DEFAULT_THEME?.trim(), true);

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
