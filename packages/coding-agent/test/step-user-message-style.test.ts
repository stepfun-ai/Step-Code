import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { StepUserMessageComponent } from "../src/modes/interactive/components/step-message.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("Step user message presentation", () => {
	test("uses the Codex-style neutral full-width prompt bar", () => {
		initTheme("step");
		const width = 40;
		const component = new StepUserMessageComponent("继续", getMarkdownTheme());
		const rows = component.render(width);
		const promptRow = rows.find((row) => stripTerminalSequences(row).includes("继续"));

		expect(promptRow).toBeDefined();
		expect(visibleWidth(promptRow!)).toBe(width);
		expect(promptRow).toContain("48;2;238;238;238");
		expect(promptRow).toContain("38;2;31;35;40");
		expect(promptRow).not.toContain("48;2;0;0;0");
	});
});
