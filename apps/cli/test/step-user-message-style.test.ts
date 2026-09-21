import { resetCapabilitiesCache, setCapabilities, stripTerminalSequences, visibleWidth } from "@step-harness/pi-tui";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { StepUserMessageComponent } from "../src/ui/view/transcript/step-message.ts";
import { getMarkdownTheme, getThemeByName, initTheme, setTheme, theme } from "../../../packages/coding-agent/src/theme/theme.ts";

describe("Step user message presentation", () => {
	beforeEach(() => {
		// Theme encoding follows pi-tui's detected terminal capabilities. Pin the
		// capability in this presentation test so a headless runner does not turn
		// the expected RGB values into an unrelated 256-color escape sequence.
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
	});

	afterEach(() => {
		resetCapabilitiesCache();
		initTheme("dark");
	});

	test("uses the Codex-style neutral full-width prompt bar", () => {
		initTheme("step-blue");
		const width = 40;
		const component = new StepUserMessageComponent("继续", getMarkdownTheme());
		const rows = component.render(width);
		const promptRow = rows.find((row) => stripTerminalSequences(row).includes("继续"));

		expect(promptRow).toBeDefined();
		expect(visibleWidth(promptRow!)).toBe(width);
		expect(promptRow).toContain(theme.getBgAnsi("userMessageBg"));
		expect(promptRow).toContain(`${theme.getFgAnsi("userMessageText")}› 继续`);
		expect(promptRow).toContain("48;2;61;59;57");
		expect(promptRow).toContain("38;2;232;232;234");
		expect(promptRow).not.toContain("48;2;238;238;238");
	});

	test.each([
		["truecolor", true],
		["xterm-256", false],
	] as const)("uses active-theme Markdown and syntax colors in %s mode", (_mode, trueColor) => {
		setCapabilities({ images: null, trueColor, hyperlinks: false });
		initTheme("step-blue");
		const activeTheme = getThemeByName("step-blue");
		expect(activeTheme).toBeDefined();
		const component = new StepUserMessageComponent(
			[
				"# Heading",
				"",
				"[docs](https://example.com)",
				"",
				"`inline`",
				"",
				"```ts",
				"export function greet(name: string) { return name; }",
				"```",
			].join("\n"),
			getMarkdownTheme(),
		);
		const rows = component.render(100);
		const rowContaining = (text: string) => rows.find((row) => stripTerminalSequences(row).includes(text));

		// 标题/链接/行内代码各有专属 token（2026-09-09 品牌紫收缩后不再同色）
		expect(rowContaining("Heading")).toContain(activeTheme!.getFgAnsi("mdHeading"));
		expect(rowContaining("docs")).toContain(activeTheme!.getFgAnsi("mdLink"));
		expect(rowContaining("inline")).toContain(activeTheme!.getFgAnsi("mdCode"));
		const codeRow = rowContaining("export function greet");
		expect(codeRow).toContain(activeTheme!.getFgAnsi("syntaxKeyword"));
		expect(codeRow).toContain(activeTheme!.getFgAnsi("syntaxFunction"));
		expect(rows.join("\n")).toContain(theme.getBgAnsi("userMessageBg"));
	});

	test.each([
		["step-blue", "dark", "dark"],
		["step-violet-light", "step-blue", "step-blue"],
	] as const)("updates existing user message colors after switching from %s to %s", (initial, next, expected) => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		initTheme(initial);
		const component = new StepUserMessageComponent("# Heading", getMarkdownTheme());
		component.render(80);

		expect(setTheme(next)).toEqual({ success: true });
		component.invalidate();
		const expectedTheme = getThemeByName(expected);
		expect(expectedTheme).toBeDefined();

		const headingRow = component.render(80).find((row) => stripTerminalSequences(row).includes("Heading"));
		expect(headingRow).toContain(expectedTheme!.getFgAnsi("mdHeading"));
	});

	test.each([true, false])("preserves prompt backgrounds around inline code with trueColor=%s", (trueColor) => {
		setCapabilities({ images: null, trueColor, hyperlinks: false });
		for (const name of ["dark", "light", "sage", "step-blue", "step-violet", "step-violet-light"]) {
			initTheme(name);
			const component = new StepUserMessageComponent("before `src/入口.ts` after", getMarkdownTheme());
			for (const width of [24, 80]) {
				const rows = component.render(width);
				const backgrounds = rows.join("\n").match(/\x1b\[48;[0-9;]+m/g) ?? [];
				expect(backgrounds.length).toBeGreaterThan(0);
				expect(new Set(backgrounds)).toEqual(new Set([theme.getBgAnsi("userMessageBg")]));
				expect(rows.filter((row) => stripTerminalSequences(row).trim()).every((row) => visibleWidth(row) === width)).toBe(true);
				if (width === 80) {
					expect(rows.map(stripTerminalSequences).join("\n")).toContain("before src/入口.ts after");
				}
			}
		}
	});
});
