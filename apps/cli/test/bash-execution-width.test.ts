/**
 * Test that BashExecutionComponent's collapsed output respects the render-time width,
 * not a stale captured width. Regression test for #2569.
 */
import { stripTerminalSequences, visibleWidth } from "@step-harness/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { BashExecutionComponent } from "../src/ui/view/transcript/bash-execution.ts";
import { initTheme } from "../../../packages/coding-agent/src/theme/theme.ts";

/** Minimal TUI stub that only exposes terminal.columns */
function createTuiStub(columns: number): { columns: number; stub: any } {
	const state = { columns };
	const stub = {
		terminal: {
			get columns() {
				return state.columns;
			},
			get rows() {
				return 24;
			},
		},
		// Loader calls ui.addInterval / ui.removeInterval
		addInterval: (_cb: () => void, _ms: number) => ({ dispose: () => {} }),
		removeInterval: () => {},
		requestRender: () => {},
	};
	return { columns: state.columns, stub };
}

describe("BashExecutionComponent width handling (#2569)", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("collapsed preview lines respect render-time width, not construction-time width", () => {
		const wideWidth = 200;
		const narrowWidth = 80;

		const { stub } = createTuiStub(wideWidth);
		const component = new BashExecutionComponent("pwd", stub);

		// Add output with long lines that will wrap differently at different widths
		const longLine = "x".repeat(150);
		component.appendOutput(`${longLine}\n${longLine}\n`);

		// Complete the command so it enters collapsed mode
		component.setComplete(0, false);

		// Render at the narrow width (simulating a resize or split pane)
		const lines = component.render(narrowWidth);

		// Every rendered line must fit within the narrow width
		for (let i = 0; i < lines.length; i++) {
			const w = visibleWidth(lines[i]);
			expect(w, `Line ${i} visibleWidth=${w} > ${narrowWidth}`).toBeLessThanOrEqual(narrowWidth);
		}
	});

	it("re-computes lines when width changes between renders", () => {
		const { stub } = createTuiStub(200);
		const component = new BashExecutionComponent("echo hello", stub);

		const longLine = "abcdefghij".repeat(20); // 200 chars
		component.appendOutput(`${longLine}\n`);
		component.setComplete(0, false);

		// First render at width 200
		const lines200 = component.render(200);
		for (const line of lines200) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(200);
		}

		// Second render at width 60 (split pane scenario)
		const lines60 = component.render(60);
		for (let i = 0; i < lines60.length; i++) {
			const w = visibleWidth(lines60[i]);
			expect(w, `Line ${i} visibleWidth=${w} > 60`).toBeLessThanOrEqual(60);
		}
	});

	it("uses the Step rail layout without Pi's full-width border", () => {
		const { stub } = createTuiStub(100);
		const component = new BashExecutionComponent("printf 'hello'", stub, false, "step");
		component.appendOutput("hello\nworld\n");
		component.setComplete(0, false);

		const lines = component.render(80).map(stripTerminalSequences);
		expect(lines[0]).toContain("● $ printf 'hello'");
		expect(lines[1]).toContain("└ hello");
		expect(lines[2]).toMatch(/^ {4}world$/);
		expect(lines.some((line) => /^─+$/.test(line))).toBe(false);
		expect(lines.at(-1)).toBe("");
	});

	it("keeps the running and failed states in the Step header/body", () => {
		const { stub } = createTuiStub(100);
		const running = new BashExecutionComponent("sleep 1", stub, false, "step");
		const runningLines = running.render(80).map(stripTerminalSequences);
		expect(runningLines[0]).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] \$ sleep 1$/);
		expect(runningLines.join("\n")).toContain("Running...");
		expect(runningLines.some((line) => /^─+$/.test(line))).toBe(false);

		const failed = new BashExecutionComponent("false", stub, false, "step");
		failed.setComplete(2, false);
		const failedLines = failed.render(80).map(stripTerminalSequences);
		expect(failedLines[0]).toContain("✗ $ false");
		expect(failedLines.join("\n")).toContain("└ exit 2");
	});

	it("wraps CJK output within the Step rail at narrow widths", () => {
		const { stub } = createTuiStub(100);
		const component = new BashExecutionComponent("printf cjk", stub, false, "step");
		component.appendOutput("中文".repeat(30));
		component.setComplete(0, false);

		for (const width of [12, 24, 40]) {
			for (const line of component.render(width)) {
				expect(visibleWidth(line), `line exceeds width ${width}`).toBeLessThanOrEqual(width);
			}
		}
	});

	it("leaves native rendering unchanged when no Step presentation is selected", () => {
		const { stub } = createTuiStub(100);
		const component = new BashExecutionComponent("pwd", stub);
		component.setComplete(0, false);

		const lines = component.render(40).map(stripTerminalSequences);
		expect(lines.some((line) => /^─+$/.test(line))).toBe(true);
	});
});
