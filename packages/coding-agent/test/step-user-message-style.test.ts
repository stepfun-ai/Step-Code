import { resetCapabilitiesCache, setCapabilities, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test } from "vitest";
import { StepUserMessageComponent } from "../src/modes/interactive/components/step-message.ts";
import { getMarkdownTheme, getThemeByName, initTheme, setTheme, theme } from "../src/modes/interactive/theme/theme.ts";

afterEach(() => {
	resetCapabilitiesCache();
	initTheme("dark");
});

describe("Step user message presentation", () => {
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
		expect(promptRow).not.toContain("48;2;0;0;0");
	});

	test.each([
		["truecolor", true],
		["xterm-256", false],
	] as const)("uses light-background Markdown and syntax colors in %s mode", (_mode, trueColor) => {
		setCapabilities({ images: null, trueColor, hyperlinks: false });
		initTheme("step");
		const lightTheme = getThemeByName("step-light");
		expect(lightTheme).toBeDefined();
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
			expect(rowContaining(text)).toContain(lightTheme!.getFgAnsi("mdHeading"));
		}
		const codeRow = rowContaining("export function greet");
		expect(codeRow).toContain(lightTheme!.getFgAnsi("syntaxKeyword"));
		expect(codeRow).toContain(lightTheme!.getFgAnsi("syntaxFunction"));
		expect(rows.join("\n")).toContain(theme.getBgAnsi("userMessageBg"));
	});

	test.each([
		["step", "dark", "dark"],
		["step-light", "step", "step-light"],
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
