import { setKeybindings } from "@step-harness/pi-tui";
import { SettingsManager } from "@step-harness/coding-agent";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../../packages/coding-agent/src/core/keybindings.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/ui/view/dialogs/settings-selector.ts";
import { initTheme } from "../../../packages/coding-agent/src/theme/theme.ts";
import { InteractiveMode } from "../src/ui/interactive-mode.ts";

describe("SettingsSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("cycles through fullscreen settings", () => {
		const onExitOutputChange = vi.fn();
		const onScrollbarChange = vi.fn();
		const onCopyOnSelectChange = vi.fn();
		const config = {
			fullscreenExitOutput: "transcript",
			fullscreenScrollbar: "auto",
			fullscreenCopyOnSelect: true,
			warnings: {},
			defaultModel: "not set",
			availableDefaultModels: [],
			availableThinkingLevels: [],
			modelThinkingLevels: {},
			availableThemes: [],
		} as unknown as SettingsConfig;
		const callbacks = {
			onFullscreenExitOutputChange: onExitOutputChange,
			onFullscreenScrollbarChange: onScrollbarChange,
			onFullscreenCopyOnSelectChange: onCopyOnSelectChange,
		} as unknown as SettingsCallbacks;

		const cycle = (label: string, count: number) => {
			const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();
			for (const character of label) list.handleInput(character);
			for (let i = 0; i < count; i++) list.handleInput("\r");
		};

		cycle("Fullscreen exit output", 2);
		expect(onExitOutputChange.mock.calls.flat()).toEqual(["resume-hint", "transcript"]);
		cycle("Fullscreen scrollbar", 3);
		expect(onScrollbarChange.mock.calls.flat()).toEqual(["always", "hidden", "auto"]);
		cycle("Fullscreen copy on select", 2);
		expect(onCopyOnSelectChange.mock.calls.flat()).toEqual([false, true]);
	});

	it.each([
		{ isStreaming: true, isCompacting: false },
		{ isStreaming: false, isCompacting: true },
		{ isStreaming: false, isCompacting: false },
	])("applies terminal progress toggles immediately: %j", (activity) => {
		const settingsManager = SettingsManager.inMemory({ terminal: { showTerminalProgress: true } });
		const setProgress = vi.fn();
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode;
		let selector: SettingsSelectorComponent | undefined;
		Object.assign(mode, {
			runtimeHost: {
				session: { ...activity, settingsManager, modelRuntime: { getAvailableSnapshot: () => [] } },
			},
			ui: { mode: "regular", terminal: { setProgress } },
			themeController: { getThemeSelection: () => "dark", getTerminalTheme: () => "dark" },
			showSelector: (create: (done: () => void) => { component: SettingsSelectorComponent }) => {
				selector = create(() => {}).component;
			},
		});
		mode.showSettingsSelector();
		const list = selector!.getSettingsList();
		for (const character of "Terminal progress") list.handleInput(character);
		list.handleInput("\r");
		expect(settingsManager.getShowTerminalProgress()).toBe(false);
		expect(setProgress).toHaveBeenLastCalledWith(false);
		list.handleInput("\r");
		expect(settingsManager.getShowTerminalProgress()).toBe(true);
		expect(setProgress).toHaveBeenLastCalledWith(activity.isStreaming || activity.isCompacting);
	});
});
