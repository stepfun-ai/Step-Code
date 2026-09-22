/**
 * End-to-end check of the exit_plan_mode tool row.
 *
 * The renderer unit tests cover the component in isolation; this one drives the
 * real ToolExecutionComponent, because the two bugs it guards against lived in
 * the Step card's body pass rather than in the renderer:
 *   - buildStepBodyLines drops every blank row, flattening the plan's paragraphs
 *   - it clips the body to STEP_COLLAPSED_LINES behind ctrl+o, hiding the plan
 * `renderShell: "self"` is what opts out of both.
 */
import { stripTerminalSequences, visibleWidth } from "@step-harness/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TuiMainScreen } from "../../../packages/tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../../packages/tui/test/virtual-terminal.ts";
import type { ExtensionAPI, ToolDefinition } from "../../../packages/coding-agent/src/core/extensions/types.ts";
import { registerPlanModeTools, type StepPlanModeController } from "../../../packages/coding-agent/src/features/plan-mode-tools.ts";
import type { PlanReviewDetails } from "../../../packages/coding-agent/src/render/plan-review.ts";
import { ToolExecutionComponent } from "../src/ui/view/transcript/tool-execution.ts";
import { initTheme } from "../../../packages/coding-agent/src/theme/theme.ts";

const cleanups: Array<() => void> = [];

const PLAN = [
	"# Plan: tank game",
	"",
	"## Goal",
	"",
	"Ship a single self-contained HTML file.",
	"",
	"## Steps",
	"",
	...Array.from({ length: 20 }, (_, index) => `${index + 1}. step number ${index + 1}`),
	"",
	"## Rollback",
	"",
	"Delete the directory.",
].join("\n");

/** The registered exit_plan_mode definition, with whatever renderers it carries. */
function exitPlanModeDefinition(): ToolDefinition<any, any, any> {
	const tools = new Map<string, unknown>();
	const api = {
		registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
		on: () => {},
	} as unknown as ExtensionAPI;
	registerPlanModeTools(api, {
		isPlanModeActive: () => true,
		enterPlanMode: () => "/tmp/plan.md",
		exitPlanMode: () => {},
		resolvePlanFilePath: () => "/tmp/plan.md",
	} satisfies StepPlanModeController);
	return tools.get("exit_plan_mode") as ToolDefinition<any, any, any>;
}

function createRow(details: PlanReviewDetails, definition: ToolDefinition<any, any, any> = exitPlanModeDefinition()) {
	const terminal = new VirtualTerminal(100, 44);
	const ui = new TuiMainScreen(terminal);
	const component = new ToolExecutionComponent(
		"exit_plan_mode",
		"call-1",
		{},
		{ presentation: "step" },
		definition as never,
		ui,
		process.cwd(),
	);
	cleanups.push(() => ui.stop());
	component.setArgsComplete();
	component.markExecutionStarted();
	component.updateResult({ content: [{ type: "text", text: "ctl" }], details, isError: false } as never, false);
	return component;
}

function rows(component: ToolExecutionComponent, width = 100): string[] {
	const rendered = component.render(width);
	for (const row of rendered) {
		expect(row).not.toMatch(/[\r\n\t]/u);
		expect(visibleWidth(row)).toBeLessThanOrEqual(width);
	}
	return rendered.map(stripTerminalSequences).map((row) => row.replace(/\s+$/u, ""));
}

const dismissed: PlanReviewDetails = {
	planFilePath: "/tmp/plan.md",
	planContents: PLAN,
	outcome: "dismissed",
};

beforeEach(() => initTheme("step-blue"));
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	initTheme("dark");
});

describe("exit_plan_mode tool row", () => {
	it("shows the whole plan while collapsed, with no expand affordance", () => {
		const out = rows(createRow(dismissed));

		expect(out[0]).toContain("exit_plan_mode");
		expect(out.some((row) => row.includes("Review dismissed"))).toBe(true);
		// Every section reaches the transcript: head, middle and tail alike. The
		// default body pass would have kept ~5 rows and hidden the rest.
		expect(out.some((row) => row.includes("# Plan: tank game"))).toBe(true);
		expect(out.some((row) => row.includes("step number 10"))).toBe(true);
		expect(out.some((row) => row.includes("Delete the directory."))).toBe(true);
		expect(out.some((row) => row.includes("to expand"))).toBe(false);
		expect(out.some((row) => row.includes("more lines"))).toBe(false);
	});

	it("keeps the blank rows between sections", () => {
		const out = rows(createRow(dismissed));
		const heading = out.findIndex((row) => row.includes("# Plan: tank game"));

		expect(heading).toBeGreaterThan(0);
		// The blank line after the heading is the one the default body pass ate.
		expect(out[heading + 1]).toBe("");
		expect(out.filter((row) => row === "").length).toBeGreaterThan(3);
	});

	it("renders identically expanded, since the row never collapsed", () => {
		const component = createRow(dismissed);
		const collapsed = rows(component);
		component.setExpanded(true);

		expect(rows(component)).toEqual(collapsed);
	});

	it("hangs the body off the header on the Step gutter", () => {
		const out = rows(createRow(dismissed));
		const summary = out.findIndex((row) => row.includes("Review dismissed"));

		expect(out[summary]).toMatch(/^ {2}└ /u);
		for (const row of out.slice(summary + 1).filter((row) => row !== "")) {
			expect(row).toMatch(/^ {4}\S/u);
		}
	});

	it("reports the approved and feedback outcomes too", () => {
		const approved = rows(createRow({ ...dismissed, outcome: "approved" }));
		expect(approved.some((row) => row.includes("Plan approved"))).toBe(true);

		const feedback = rows(createRow({ ...dismissed, outcome: "feedback", feedback: "use canvas" }));
		expect(feedback.some((row) => row.includes("Changes requested"))).toBe(true);
		expect(feedback.some((row) => row.includes("↳ use canvas"))).toBe(true);
	});
});
