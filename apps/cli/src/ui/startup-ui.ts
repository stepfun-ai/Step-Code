import {
	CONFIG_DIR_NAME,
	DefaultPackageManager,
	detectTerminalBackgroundFromEnv,
	detectTerminalThemeForAuto,
	getAgentDir,
	IS_STEP_ENTRYPOINT,
	initTheme,
	KeybindingsManager,
	loadThemeFromPath,
	parseAutoThemeSetting,
	type ResolvedResource,
	resolveStepAgentDir,
	resolveThemeSetting,
	SettingsManager,
	setRegisteredThemes,
	setTheme,
	setThemeStorageDir,
	type Theme,
} from "@step-harness/coding-agent";
import { ProcessTerminal, setCapabilityOverrides, setKeybindings, type TUI, TuiMainScreen } from "@step-harness/pi-tui";
import { ExtensionInputComponent } from "./view/dialogs/extension-input.ts";
import { ExtensionSelectorComponent } from "./view/dialogs/extension-selector.ts";
import { FirstTimeSetupComponent, type FirstTimeSetupResult } from "./view/dialogs/first-time-setup.ts";

/** Product entrypoints keep the startup selector in the same visual language
 * as their interactive surface; keyboard handling remains in the shared
 * ExtensionSelector/Input components. */
const STARTUP_PRESENTATION: "native" | "step" = IS_STEP_ENTRYPOINT ? "step" : "native";

export interface StartupTuiPathOptions {
	agentDir?: string;
	configDirName?: string;
}

function loadThemes(resources: ResolvedResource[]): Theme[] {
	const themes: Theme[] = [];
	const seen = new Set<string>();
	for (const resource of resources) {
		if (!resource.enabled) continue;
		try {
			const loadedTheme = loadThemeFromPath(resource.path);
			if (loadedTheme.name) {
				if (seen.has(loadedTheme.name)) continue;
				seen.add(loadedTheme.name);
			}
			themes.push(loadedTheme);
		} catch {
			// Startup prompts should not fail because a theme is broken. The normal
			// resource loader reports theme diagnostics later in startup.
		}
	}
	return themes;
}

async function loadStartupThemes(
	settingsManager: SettingsManager,
	paths: Required<StartupTuiPathOptions>,
): Promise<Theme[]> {
	const globalSettingsManager = SettingsManager.inMemory(settingsManager.getGlobalSettings(), {
		projectTrusted: false,
	});
	const packageManager = new DefaultPackageManager({
		cwd: process.cwd(),
		agentDir: paths.agentDir,
		configDirName: paths.configDirName,
		settingsManager: globalSettingsManager,
	});
	const resolvedPaths = await packageManager.resolve(async () => "skip");
	return loadThemes(resolvedPaths.themes);
}

export async function createStartupTui(
	settingsManager: SettingsManager,
	paths: StartupTuiPathOptions = {},
): Promise<TUI> {
	const resolvedPaths: Required<StartupTuiPathOptions> = {
		agentDir: paths.agentDir ?? (IS_STEP_ENTRYPOINT ? resolveStepAgentDir() : getAgentDir()),
		configDirName: paths.configDirName?.trim() || CONFIG_DIR_NAME,
	};
	// Theme helpers have a product-level custom-theme directory context in
	// addition to the resource loader's explicit paths. Bind it before any
	// theme is loaded so startup selectors cannot read Pi's default directory.
	setThemeStorageDir(resolvedPaths.agentDir);
	setCapabilityOverrides(settingsManager.getTerminalCapabilityOverrides());
	setRegisteredThemes(await loadStartupThemes(settingsManager, resolvedPaths));
	const terminalTheme = detectTerminalBackgroundFromEnv().theme;
	initTheme(
		resolveThemeSetting(settingsManager.getThemeSetting() ?? process.env.STEPCODE_DEFAULT_THEME, terminalTheme) ??
			terminalTheme,
	);
	setKeybindings(KeybindingsManager.create(resolvedPaths.agentDir));
	const ui: TUI = new TuiMainScreen(
		new ProcessTerminal(),
		settingsManager.getShowHardwareCursor(),
		resolvedPaths.agentDir,
	);
	ui.setClearOnShrink(settingsManager.getClearOnShrink());
	return ui;
}

export function startStartupTui(ui: TUI, settingsManager: SettingsManager): void {
	ui.start();
	void applyDetectedStartupTheme(ui, settingsManager);
}

async function applyDetectedStartupTheme(ui: TUI, settingsManager: SettingsManager): Promise<void> {
	const themeSetting = settingsManager.getThemeSetting() ?? process.env.STEPCODE_DEFAULT_THEME?.trim();
	if (themeSetting && !parseAutoThemeSetting(themeSetting)) return;

	const terminalTheme = await detectTerminalThemeForAuto({ ui, timeoutMs: 100 });
	setTheme(resolveThemeSetting(themeSetting, terminalTheme) ?? terminalTheme);
	ui.invalidate();
	ui.requestRender();
}

async function clearStartupTui(ui: TUI): Promise<void> {
	ui.clear();
	ui.requestRender();
	await new Promise((resolve) => setTimeout(resolve, 25));
}

export async function showStartupSelector<T>(
	settingsManager: SettingsManager,
	title: string,
	options: Array<{ label: string; value: T }>,
	paths?: StartupTuiPathOptions,
): Promise<T | undefined> {
	const ui = await createStartupTui(settingsManager, paths);
	return new Promise((resolve) => {
		let settled = false;
		const finish = async (result: T | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			await clearStartupTui(ui);
			ui.stop();
			resolve(result);
		};

		const selector = new ExtensionSelectorComponent(
			title,
			options.map((option) => option.label),
			(option) => void finish(options.find((entry) => entry.label === option)?.value),
			() => void finish(undefined),
			{ tui: ui, presentation: STARTUP_PRESENTATION },
		);
		ui.addChild(selector);
		ui.setFocus(selector);
		startStartupTui(ui, settingsManager);
	});
}

/** Show the first-time setup dialog and persist the result */
export async function showFirstTimeSetup(
	settingsManager: SettingsManager,
	paths?: StartupTuiPathOptions,
): Promise<void> {
	const ui = await createStartupTui(settingsManager, paths);
	return new Promise((resolve) => {
		let settled = false;
		const finish = async (result: FirstTimeSetupResult | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			if (result) {
				settingsManager.setTheme(result.theme);
				settingsManager.setEnableAnalytics(result.shareAnalytics);
				await settingsManager.flush();
			}
			await clearStartupTui(ui);
			ui.stop();
			resolve();
		};

		const showSetup = async () => {
			ui.start();
			const detectedTheme = await detectTerminalThemeForAuto({ ui, timeoutMs: 100 });
			setTheme(detectedTheme);
			const component = new FirstTimeSetupComponent({
				detectedTheme,
				onThemePreview: (themeName) => {
					setTheme(themeName);
					ui.requestRender();
				},
				onSubmit: (result) => void finish(result),
				onCancel: () => void finish(undefined),
			});
			ui.addChild(component);
			ui.setFocus(component);
			ui.requestRender();
		};

		void showSetup();
	});
}

export async function showStartupInput(
	settingsManager: SettingsManager,
	title: string,
	placeholder?: string,
	paths?: StartupTuiPathOptions,
): Promise<string | undefined> {
	const ui = await createStartupTui(settingsManager, paths);
	return new Promise((resolve) => {
		let settled = false;
		const finish = async (result: string | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			input.dispose();
			await clearStartupTui(ui);
			ui.stop();
			resolve(result);
		};

		const input = new ExtensionInputComponent(
			title,
			placeholder,
			(value) => void finish(value),
			() => void finish(undefined),
			{
				tui: ui,
				presentation: STARTUP_PRESENTATION,
			},
		);
		ui.addChild(input);
		ui.setFocus(input);
		startStartupTui(ui, settingsManager);
	});
}
