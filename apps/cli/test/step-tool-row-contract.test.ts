import { stripTerminalSequences, Text, visibleWidth } from "@step-harness/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TuiMainScreen } from "../../../packages/tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../../packages/tui/test/virtual-terminal.ts";
import type { StepToolSpinnerState } from "../src/ui/view/transcript/step-spinner.ts";
import { ToolExecutionComponent } from "../src/ui/view/transcript/tool-execution.ts";
import { initTheme } from "../../../packages/coding-agent/src/theme/theme.ts";
import { createStepToolProfile } from "../../../packages/coding-agent/src/step/tool-profile.ts";

const cleanups: Array<() => void> = [];

function createHarness(
	name: string,
	args: Record<string, unknown>,
	columns = 122,
	rows = 44,
	spinner?: StepToolSpinnerState,
) {
	const terminal = new VirtualTerminal(columns, rows);
	const ui = new TuiMainScreen(terminal);
	const definition = createStepToolProfile(process.cwd()).find((tool) => tool.name === name);
	const component = new ToolExecutionComponent(
		name,
		"multiline-call",
		args,
		{ presentation: "step", spinner },
		definition,
		ui,
		process.cwd(),
	);
	cleanups.push(() => ui.stop());
	return { terminal, ui, component };
}

function expectPhysicalRows(component: ToolExecutionComponent, width: number): string[] {
	const rows = component.render(width);
	for (const row of rows) {
		expect(row).not.toMatch(/[\r\n\t]/u);
		expect(visibleWidth(row)).toBeLessThanOrEqual(width);
	}
	return rows.map(stripTerminalSequences);
}

beforeEach(() => initTheme("step-blue"));
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	initTheme("dark");
});

describe("Step projected rows", () => {
	it.each([122, 80, 40])("keeps multiline command states on physical rows at width %s", (width) => {
		// Live regression: a raw heredoc newline in the projected heading moved
		// the terminal cursor while the differential renderer counted one row.
		const command = "cat <<'EOF'\nfirst line\r\n\tsecond line\nEOF";
		const args = { command };
		const { component } = createHarness("run_command", args);
		expectPhysicalRows(component, width);
		component.setArgsComplete();
		component.markExecutionStarted();
		component.updateResult({ content: [{ type: "text", text: "first line\nsecond line" }], isError: false }, true);
		expectPhysicalRows(component, width);
		component.updateResult({ content: [{ type: "text", text: "first line\nsecond line" }], isError: false }, false);
		expectPhysicalRows(component, width);
		component.setExpanded(true);
		const expanded = expectPhysicalRows(component, width).join("\n");
		expect(expanded).toContain("first line");
		expect(expanded).toContain("second line");
		expect(args.command).toBe(command);
	});

	it.each([
		["list_directory", { path: "src/one\ntwo\tdir" }],
		["read_file", { path: "src/one\rtwo.txt", start_line: 1, end_line: 2 }],
		["write_file", { path: "src/one\ntwo.txt", content: "first\nsecond" }],
		["edit_file", { path: "src/one\ntwo.txt", search: "before", replace: "after" }],
		["find_files", { path: "src/one\ntwo", pattern: "first\nsecond" }],
		["search_files", { path: "src/one\ntwo", pattern: "first\nsecond" }],
	] as const)("keeps %s titles and collapsed summaries on physical rows", (name, args) => {
		const original = JSON.stringify(args);
		const { component } = createHarness(name, args);
		expectPhysicalRows(component, 80);
		component.updateResult({ content: [{ type: "text", text: "one\ntwo" }], isError: false }, false);
		expectPhysicalRows(component, 80);
		component.setExpanded(true);
		expectPhysicalRows(component, 40);
		expect(JSON.stringify(args)).toBe(original);
	});

	it.each([
		[122, 44],
		[80, 24],
		[40, 16],
	])("does not accumulate multiline headings during redraw at %s x %s", async (columns, rows) => {
		let frame = "⠋";
		let seconds = 1;
		const spinner: StepToolSpinnerState = {
			get frame() {
				return frame;
			},
			elapsedSeconds: () => seconds,
		};
		const { terminal, ui, component } = createHarness(
			"run_command",
			{ command: "printf 'first'\nprintf 'second'\nprintf 'third'" },
			columns,
			rows,
			spinner,
		);
		ui.addChild(new Text("BEFORE_COMMAND", 0, 0));
		ui.addChild(component);
		ui.addChild(new Text("AFTER_COMMAND_FOOTER", 0, 0));
		ui.start();
		for (const nextFrame of ["⠋", "⠙", "⠹", "⠸", "⠼"]) {
			frame = nextFrame;
			seconds += 1;
			ui.renderNow();
			await terminal.flush();
		}
		component.updateResult({ content: [{ type: "text", text: "first\nsecond\nthird" }], isError: false }, false);
		ui.renderNow();
		await terminal.flush();
		const screen = terminal.getViewport().join("\n");
		expect(screen.match(/run_command\(/gu)).toHaveLength(1);
		expect(screen.match(/AFTER_COMMAND_FOOTER/gu)).toHaveLength(1);
		expect(screen).toContain("● run_command(");
	});
});
