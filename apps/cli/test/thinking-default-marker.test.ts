import type { ThinkingLevel } from "@step-harness/agent-core";
import type { Model } from "@step-harness/providers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../../../packages/coding-agent/src/core/settings-manager.ts";
import { stepThinkingLevelMap } from "../../../packages/coding-agent/src/features/step-provider/index.ts";
import { initTheme } from "../../../packages/coding-agent/src/theme/theme.ts";
import { stripAnsi } from "../../../packages/coding-agent/src/utils/ansi.ts";
import { stepModel } from "../../../packages/coding-agent/test/utilities.ts";
import { InteractiveMode } from "../src/ui/interactive-mode.ts";
import type { ThinkingSelectorComponent } from "../src/ui/view/dialogs/thinking-selector.ts";

const showThinkingSelector = Reflect.get(InteractiveMode.prototype, "showThinkingSelector") as (this: object) => void;

function renderSelector(settingsManager: SettingsManager, model: Model<any>, levels: ThinkingLevel[]): string[] {
	let selector!: ThinkingSelectorComponent;
	showThinkingSelector.call({
		session: { model, thinkingLevel: "high", getAvailableThinkingLevels: () => levels },
		settingsManager,
		selectThinkingLevel: vi.fn(),
		showSelector(factory: (done: () => void) => { component: ThinkingSelectorComponent }) {
			selector = factory(() => {}).component;
		},
	});
	return selector.render(100).map(stripAnsi);
}

describe("thinking selector default marker", () => {
	beforeAll(() => initTheme("dark"));

	it("marks the saved global default for Step models", () => {
		const lines = renderSelector(
			SettingsManager.inMemory({ defaultThinkingLevel: "medium" }),
			stepModel({ thinkingLevelMap: stepThinkingLevelMap(["low", "medium", "high"]) }),
			["low", "medium", "high"],
		);
		expect(lines.some((line) => line.includes("medium") && line.includes("default"))).toBe(true);
		expect(lines.some((line) => line.includes("high") && line.includes("default"))).toBe(false);
	});

	it("marks the model-specific default ahead of the global default", () => {
		const lines = renderSelector(
			SettingsManager.inMemory({
				defaultThinkingLevel: "high",
				modelThinkingLevels: { "step/step-5-preview": "low" },
			}),
			stepModel({ thinkingLevelMap: stepThinkingLevelMap(["low", "medium", "high"]) }),
			["low", "medium", "high"],
		);
		expect(lines.some((line) => line.includes("low") && line.includes("default"))).toBe(true);
	});

	it("marks the supported level used when the saved default must be clamped", () => {
		const lines = renderSelector(
			SettingsManager.inMemory({ defaultThinkingLevel: "medium" }),
			stepModel({ thinkingLevelMap: stepThinkingLevelMap(["low", "high"]) }),
			["low", "high"],
		);
		expect(lines.some((line) => line.includes("high") && line.includes("default"))).toBe(true);
	});
});
