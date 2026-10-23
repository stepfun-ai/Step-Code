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

	it("previews long run_command scripts in the title and shows the full command only on expand", () => {
		const script = [
			'playwriter -e "',
			"  if (!state.r24) {",
			"    state.page = context.pages().find((p) => p.url().includes('grafana'));",
			"    const marker = 'FULL_COMMAND_TAIL';",
			"  }",
			'" -s 3 2>&1 | tail -12',
		].join("\n");
		const { component } = createHarness("run_command", { command: script, timeout: 120 });
		component.setArgsComplete();
		component.markExecutionStarted();
		component.updateResult({ content: [{ type: "text", text: "RESULT_ROW" }], isError: false }, false);

		const collapsed = expectPhysicalRows(component, 200).filter((row) => row.length > 0);
		expect(collapsed[0]).toBe('● run_command(playwriter -e " …)');
		expect(collapsed.join("\n")).not.toContain("FULL_COMMAND_TAIL");
		expect(collapsed.join("\n")).not.toContain("timeout 120s");
		expect(collapsed[1]).toBe("  └ RESULT_ROW");

		component.setExpanded(true);
		const expanded = expectPhysicalRows(component, 200).join("\n");
		expect(expanded).toContain("FULL_COMMAND_TAIL");
		expect(expanded).toContain('$ playwriter -e "');
		expect(expanded).toContain("RESULT_ROW");
	});

	it("shows the full short command on expand and removes it on collapse", () => {
		const { component } = createHarness("run_command", { command: "pnpm test" });
		component.updateResult({ content: [{ type: "text", text: "ok" }], isError: false }, false);
		component.setExpanded(true);
		const rows = expectPhysicalRows(component, 80).filter((row) => row.length > 0);
		expect(rows[0]).toBe("● run_command(pnpm test)");
		expect(rows.join("\n")).toContain("$ pnpm test");
		component.setExpanded(false);
		expect(expectPhysicalRows(component, 80).join("\n")).not.toContain("$ pnpm test");
	});

	it.each([40, 80, 200])("sizes command previews to width %s while retaining elapsed time", (width) => {
		const command = `echo ${"界面测试".repeat(40)} TAIL_MARKER`;
		const spinner: StepToolSpinnerState = { frame: "⠋", elapsedSeconds: () => 12 };
		const { component } = createHarness("run_command", { command }, width, 44, spinner);
		const header = expectPhysicalRows(component, width)[0]!;
		expect(header).toMatch(/^⠋ run_command\(/u);
		expect(header).toMatch(/…\) · 12s$/u);
		expect(visibleWidth(header)).toBeGreaterThan(width - 3);
		component.setExpanded(true);
		const expanded = expectPhysicalRows(component, width).join("\n");
		expect(expanded).toContain("TAIL_MARKER");
		component.setExpanded(false);
		expect(expectPhysicalRows(component, width)[0]).toBe(header);
	});

	it("does not limit a fitting single-line command to 50 characters", () => {
		const command = `echo ${"x".repeat(80)}`;
		const { component } = createHarness("run_command", { command });
		expect(expectPhysicalRows(component, 200)[0]).toBe(`⠋ run_command(${command})`);
	});

	it.each(["\n", "\r\n", "\r"])("previews only the first command line for %j separators", (separator) => {
		const command = `echo first${separator}echo HIDDEN_COMMAND`;
		const args = { command };
		const { component } = createHarness("run_command", args);
		expect(expectPhysicalRows(component, 80)[0]).toBe("⠋ run_command(echo first …)");
		expect(expectPhysicalRows(component, 80).join("\n")).not.toContain("HIDDEN_COMMAND");
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
