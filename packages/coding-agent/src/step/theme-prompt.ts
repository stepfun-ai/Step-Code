/**
 * The first-run screen that asks which theme reads best in this terminal.
 *
 * It is asked once, on the first interactive launch, after the login and the
 * MCP import offer: a user who has just signed in is looking at the UI for the
 * first time, which is the only moment the question answers itself.
 *
 * Dismissing the screen is an answer too — it takes the default — so the screen
 * always resolves to a setting for the caller to persist, and that setting is
 * the whole record. Nothing tracks "we asked you": a config with a `theme` in it
 * is a question already answered, and deleting that line asks again. `/theme`
 * remains the way to change the theme later.
 *
 * Like the MCP import offer, it runs before the main UI is built and owns the
 * screen while it does. A picker mounted after `init()` would show the logo and
 * the input box first and replace them a frame later, which reads as a glitch.
 *
 * The screen applies each theme as it is highlighted, so what the list promises
 * is what the terminal shows. Persisting the confirmed setting is left to the
 * interactive mode, which owns the settings manager and reads it back when it
 * builds the UI.
 */

import {
	detectTerminalBackgroundFromEnv,
	getAvailableThemes,
	initTheme,
	parseAutoThemeSetting,
	resolveThemeSetting,
	setTheme,
	setThemeStorageDir,
	theme,
} from "../theme/theme.ts";
import { getStepDefaultTheme } from "./defaults.ts";
import { resolveStepAgentDir } from "./environment.ts";
import { createStandaloneStepHost, type StepLoginHost } from "./login-flow.ts";
import { StepThemePromptView } from "./theme-prompt-view.ts";

export interface StepThemeOption {
	/** Theme setting to persist: a theme name, or a `light/dark` auto pair. */
	readonly setting: string;
	readonly label: string;
	readonly description?: string;
}

/**
 * List the product default first, followed by the other registered themes.
 * An automatic default also exposes its dark and light halves explicitly.
 */
export function buildStepThemeOptions(availableThemes: readonly string[], defaultSetting: string): StepThemeOption[] {
	const available = availableThemes.filter((name) => name.trim().length > 0);
	const pair = parseAutoThemeSetting(defaultSetting);
	const options: StepThemeOption[] = [];
	const claimed = new Set<string>();

	if (pair && available.includes(pair.lightTheme) && available.includes(pair.darkTheme)) {
		options.push({
			setting: defaultSetting,
			label: "Auto (match terminal)",
			description: `${pair.darkTheme} / ${pair.lightTheme}`,
		});
		options.push({ setting: pair.darkTheme, label: "Dark mode", description: pair.darkTheme });
		options.push({ setting: pair.lightTheme, label: "Light mode", description: pair.lightTheme });
		claimed.add(pair.darkTheme).add(pair.lightTheme);
	} else if (!pair && available.includes(defaultSetting)) {
		options.push({ setting: defaultSetting, label: `${defaultSetting} (default)` });
		claimed.add(defaultSetting);
	}

	for (const name of available) {
		if (claimed.has(name)) continue;
		claimed.add(name);
		options.push({ setting: name, label: name });
	}
	return options;
}

export interface RunStepThemePromptOptions {
	readonly env?: NodeJS.ProcessEnv;
	/** Screen host; a standalone full-screen renderer by default. */
	readonly createHost?: () => StepLoginHost;
	/** Product default theme setting, for example `step-blue`. */
	readonly themeName?: string;
}

/**
 * Show the picker and resolve to the setting the caller should persist —
 * the confirmed option, or the default when the screen was dismissed.
 *
 * Resolves to `undefined` only when there was no question to put: a catalog
 * with no themes in it is a broken install, and recording a default for it
 * would answer a question the user never saw.
 */
export async function runStepThemePrompt(options: RunStepThemePromptOptions = {}): Promise<string | undefined> {
	const env = options.env ?? process.env;

	// Bind the product theme directory before the catalog is read, or a user's
	// own themes are missing from a list that claims to be all of them.
	setThemeStorageDir(resolveStepAgentDir(env));
	const defaultSetting = options.themeName?.trim() || getStepDefaultTheme(env);
	const terminalTheme = detectTerminalBackgroundFromEnv({ env }).theme;
	// This runs before main() initializes the product theme; only initialize when
	// this is the first renderer in the process.
	try {
		theme.fg("text", "");
	} catch {
		initTheme(resolveThemeSetting(defaultSetting, terminalTheme) ?? "dark", false);
	}
	const themeOptions = buildStepThemeOptions(getAvailableThemes(), defaultSetting);
	if (themeOptions.length === 0) return undefined;

	const applySetting = (setting: string) => {
		const themeName = resolveThemeSetting(setting, terminalTheme);
		if (themeName) setTheme(themeName);
	};
	applySetting(themeOptions.find((option) => option.setting === defaultSetting)?.setting ?? themeOptions[0].setting);

	const host = options.createHost?.() ?? createStandaloneStepHost();
	let settle: ((setting: string | undefined) => void) | undefined;
	const answered = new Promise<string | undefined>((resolve) => {
		settle = resolve;
	});

	const view = new StepThemePromptView(themeOptions, {
		initialSetting: defaultSetting,
		onPreview: (setting) => {
			applySetting(setting);
			host.requestRender();
		},
		onConfirm: (setting) => settle?.(setting),
		onCancel: () => settle?.(undefined),
		requestRender: () => host.requestRender(),
	});

	host.addChild(view);
	host.setFocus(view);
	let selection: string | undefined;
	try {
		await host.start();
		selection = await answered;
	} finally {
		await host.stop();
		host.clearScreen?.();
	}

	// Applied here as well as persisted by the caller: the process keeps
	// rendering after this screen closes, and the previews have already moved
	// the live theme around.
	const chosen = selection ?? defaultSetting;
	applySetting(chosen);
	return chosen;
}
