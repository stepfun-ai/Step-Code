import { resetCapabilitiesCache, setCapabilities, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { StepUserMessageComponent } from "../src/ui/components/step-message.ts";
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
		initTheme("step");
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
		initTheme("step");
		const activeTheme = getThemeByName("step");
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

		for (const text of ["Heading", "docs", "inline"]) {
			expect(rowContaining(text)).toContain(activeTheme!.getFgAnsi("mdHeading"));
		}
		const codeRow = rowContaining("export function greet");
		expect(codeRow).toContain(activeTheme!.getFgAnsi("syntaxKeyword"));
		expect(codeRow).toContain(activeTheme!.getFgAnsi("syntaxFunction"));
		expect(rows.join("\n")).toContain(theme.getBgAnsi("userMessageBg"));
	});

	test.each([
		["step", "dark", "dark"],
		["step-light", "step", "step"],
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
});
