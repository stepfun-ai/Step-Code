import chalk from "chalk";
import type { ProjectTrustContext } from "../core/extensions/types.ts";
import type { AppMode } from "../core/project-trust.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import type { StartupTuiPathOptions } from "../modes/interactive-contract.ts";

/**
 * Startup selector primitives injected from the product shell. The interactive
 * selectors live in @step-harness/cli; this package receives them as callbacks
 * (dependency inversion) so it never imports the shell. When they are absent
 * (e.g. coding-agent's own `main()` running a non-interactive command) the
 * context behaves exactly like a no-UI context.
 */
export interface ProjectTrustUiPrimitives {
	showStartupSelector?: <T>(
		settingsManager: SettingsManager,
		title: string,
		options: Array<{ label: string; value: T }>,
		paths?: StartupTuiPathOptions,
	) => Promise<T | undefined>;
	showStartupInput?: (
		settingsManager: SettingsManager,
		title: string,
		placeholder?: string,
		paths?: StartupTuiPathOptions,
	) => Promise<string | undefined>;
}

export function createProjectTrustContext(options: {
	cwd: string;
	mode: AppMode;
	settingsManager: SettingsManager;
	hasUI: boolean;
	paths?: StartupTuiPathOptions;
	ui?: ProjectTrustUiPrimitives;
}): ProjectTrustContext {
	const showStartupSelector = options.ui?.showStartupSelector;
	const showStartupInput = options.ui?.showStartupInput;
	return {
		cwd: options.cwd,
		mode: options.mode === "interactive" ? "tui" : options.mode,
		hasUI: options.hasUI,
		ui: {
			select: async (title, selectOptions) => {
				if (!options.hasUI) {
					return undefined;
				}
				if (options.mode !== "interactive") {
					return undefined;
				}
				if (!showStartupSelector) {
					return undefined;
				}
				return showStartupSelector(
					options.settingsManager,
					title,
					selectOptions.map((option) => ({ label: option, value: option })),
					options.paths,
				);
			},
			confirm: async (title, message) => {
				if (!options.hasUI) {
					return false;
				}
				if (options.mode !== "interactive") {
					return false;
				}
				if (!showStartupSelector) {
					return false;
				}
				return (
					(await showStartupSelector(
						options.settingsManager,
						`${title}\n${message}`,
						[
							{ label: "Yes", value: true },
							{ label: "No", value: false },
						],
						options.paths,
					)) ?? false
				);
			},
			input: async (title, placeholder) => {
				if (!options.hasUI) {
					return undefined;
				}
				if (options.mode !== "interactive") {
					return undefined;
				}
				if (!showStartupInput) {
					return undefined;
				}
				return showStartupInput(options.settingsManager, title, placeholder, options.paths);
			},
			notify: (message, type = "info") => {
				if (options.mode !== "interactive") {
					const color = type === "error" ? chalk.red : type === "warning" ? chalk.yellow : chalk.cyan;
					console.error(color(message));
				}
			},
		},
	};
}
