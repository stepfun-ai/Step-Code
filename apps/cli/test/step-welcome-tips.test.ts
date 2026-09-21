import { stripTerminalSequences, visibleWidth } from "@step-harness/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { initTheme } from "../../../packages/coding-agent/src/theme/theme.ts";
import { StepWelcomeComponent } from "../src/ui/view/chrome/step-welcome.ts";

afterEach(() => initTheme("dark"));

describe("welcome tip alignment", () => {
	it.each([39, 40, 80, 120])("aligns descriptions and wrapped lines at width %i", (width) => {
		initTheme("step-blue");
		const component = new StepWelcomeComponent(() => ({ workspaceRoot: "/tmp/project" }));
		const lines = component.render(width).map(stripTerminalSequences);
		const tipsStart = lines.findIndex((line) => line.includes("Tips")) + 1;
		const tipsEnd = lines.findIndex((line) => line.includes("╰"));
		const tips = lines.slice(tipsStart, tipsEnd);
		const descriptions = [
			["/cron", "View and manage scheduled tasks."],
			["/goal", "Set a goal and keep working toward it across turns."],
			["ultracode", "Include this keyword in your prompt to enable parallel subagents."],
		] as const;
		for (const [command, description] of descriptions) {
			const start = tips.findIndex((line) => line.startsWith(`│ ${command} `));
			expect(start).toBeGreaterThanOrEqual(0);
			expect(tips[start]!.slice(0, 13)).toBe(`│ ${command.padEnd(11)}`);
			const rows = [tips[start]!];
			for (const line of tips.slice(start + 1)) {
				if (!line.startsWith(`│ ${" ".repeat(11)}`)) break;
				rows.push(line);
			}
			const descriptionWidth = width - 15;
			expect(rows).toHaveLength(Math.ceil(description.length / descriptionWidth));
			for (const [index, line] of rows.entries()) {
				expect(line.slice(13, -2).trimEnd()).toBe(
					description.slice(index * descriptionWidth, (index + 1) * descriptionWidth).trimEnd(),
				);
			}
		}
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});

	it.each([20, 30, 38])("stacks all descriptions consistently at width %i", (width) => {
		initTheme("step-blue");
		const component = new StepWelcomeComponent(() => ({ workspaceRoot: "/tmp/project" }));
		const lines = component.render(width).map(stripTerminalSequences);
		for (const command of ["/cron", "/goal", "ultracode"]) {
			const index = lines.findIndex((line) => line.startsWith(`│ ${command} `));
			expect(index).toBeGreaterThanOrEqual(0);
			expect(lines[index]!.slice(2, -2).trim()).toBe(command);
			expect(lines[index + 1]).toMatch(/^│ {3}\S/u);
		}
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});
});
