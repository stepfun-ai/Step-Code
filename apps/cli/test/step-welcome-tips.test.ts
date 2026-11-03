import { stripTerminalSequences, visibleWidth } from "@step-harness/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { initTheme } from "../../../packages/coding-agent/src/theme/theme.ts";
import { StepWelcomeComponent } from "../src/ui/view/chrome/step-welcome.ts";

afterEach(() => initTheme("dark"));

describe("welcome tip alignment", () => {
	it.each([43, 44, 80, 120])("aligns descriptions and wrapped lines at width %i", (width) => {
		initTheme("step-blue");
		const component = new StepWelcomeComponent(() => ({
			workspaceRoot: "/tmp/project",
			ultracodeAvailable: true,
		}));
		const lines = component.render(width).map(stripTerminalSequences);
		const tipsStart = lines.findIndex((line) => line.includes("Tips")) + 1;
		const tipsEnd = lines.findIndex((line) => line.includes("╰"));
		const tips = lines.slice(tipsStart, tipsEnd);
		const descriptions = [
			["/cron", "View and manage scheduled tasks."],
			["/goal", "Set a goal and keep working toward it across turns."],
			["/ultracode on", "Use parallel agents for this session. One turn: ultracode: task."],
		] as const;
		for (const [command, description] of descriptions) {
			const start = tips.findIndex((line) => line.startsWith(`│ ${command} `));
			expect(start).toBeGreaterThanOrEqual(0);
			expect(tips[start]!.slice(0, 17)).toBe(`│ ${command.padEnd(15)}`);
			const rows = [tips[start]!];
			for (const line of tips.slice(start + 1)) {
				if (!line.startsWith(`│ ${" ".repeat(15)}`)) break;
				rows.push(line);
			}
			const descriptionWidth = width - 19;
			expect(rows).toHaveLength(Math.ceil(description.length / descriptionWidth));
			for (const [index, line] of rows.entries()) {
				expect(line.slice(17, -2).trimEnd()).toBe(
					description.slice(index * descriptionWidth, (index + 1) * descriptionWidth).trimEnd(),
				);
			}
		}
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});

	it.each([20, 30, 38, 39, 40, 42])("stacks all descriptions consistently at width %i", (width) => {
		initTheme("step-blue");
		const component = new StepWelcomeComponent(() => ({
			workspaceRoot: "/tmp/project",
			ultracodeAvailable: true,
		}));
		const lines = component.render(width).map(stripTerminalSequences);
		for (const command of ["/cron", "/goal", "/ultracode on"]) {
			const index = lines.findIndex((line) => line.startsWith(`│ ${command} `));
			expect(index).toBeGreaterThanOrEqual(0);
			expect(lines[index]!.slice(2, -2).trim()).toBe(command);
			expect(lines[index + 1]).toMatch(/^│ {3}\S/u);
		}
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});

	it.each([35, 36, 80, 120])("uses only visible tips to align descriptions at width %i", (width) => {
		initTheme("step-blue");
		const component = new StepWelcomeComponent(() => ({
			workspaceRoot: "/tmp/project",
			ultracodeAvailable: false,
		}));
		const lines = component.render(width).map(stripTerminalSequences);

		expect(lines.some((line) => line.startsWith("│ /cron  View and manage"))).toBe(true);
		expect(lines.some((line) => line.startsWith("│ /goal  Set a goal"))).toBe(true);
		expect(lines.join("\n")).not.toContain("ultracode");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});
});
