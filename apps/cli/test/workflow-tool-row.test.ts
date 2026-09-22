import { setKeybindings, stripTerminalSequences, Text, visibleWidth } from "@step-harness/pi-tui";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "../../../packages/coding-agent/src/core/extensions/types.ts";
import { KeybindingsManager } from "../../../packages/coding-agent/src/core/keybindings.ts";
import { createStepWorkflowExtension } from "../../../packages/coding-agent/src/features/workflow/step-workflow.ts";
import type { WorkflowProgress } from "../../../packages/coding-agent/src/features/workflow/types.ts";
import { initTheme } from "../../../packages/coding-agent/src/theme/theme.ts";
import { TuiMainScreen } from "../../../packages/tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../../packages/tui/test/virtual-terminal.ts";
import { ToolExecutionComponent } from "../src/ui/view/transcript/tool-execution.ts";

const cleanups: Array<() => void> = [];

beforeEach(() => {
	initTheme("step-blue");
	setKeybindings(new KeybindingsManager());
});
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	initTheme("dark");
});

function createRow() {
	let definition: ToolDefinition | undefined;
	createStepWorkflowExtension({
		enabled: true,
		vmExecutor: async () => ({ value: null, meta: {} }),
	})({
		registerTool: (tool: ToolDefinition) => {
			definition = tool;
		},
		registerCommand: () => {},
		on: () => {},
	} as unknown as ExtensionAPI);
	const terminal = new VirtualTerminal(100, 44);
	const ui = new TuiMainScreen(terminal);
	const component = new ToolExecutionComponent(
		"workflow",
		"live-workflow",
		{ script: "await agent('inline script source')" },
		{ presentation: "step" },
		definition,
		ui,
		process.cwd(),
	);
	cleanups.push(() => ui.stop());
	component.setArgsComplete();
	component.markExecutionStarted();
	return { component, terminal, ui };
}

function progress(): WorkflowProgress {
	return {
		schemaVersion: 1,
		runId: "wf_live",
		name: "inline",
		status: "running",
		startedAt: 1,
		updatedAt: 2,
		currentPhase: "Review",
		completedAgents: 0,
		totalAgents: 8,
		spentTokens: 0,
		agents: Array.from({ length: 8 }, (_, index) => ({
			id: `agent-${index}`,
			label: `Task ${index + 1}`,
			task: `Inspect subsystem ${index + 1}`,
			status: "running",
			startedAt: 1,
		})),
	};
}

function rows(component: ToolExecutionComponent, width = 100): string[] {
	return component.render(width).map((row) => {
		expect(row).not.toMatch(/[\r\n\t]/u);
		expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		return stripTerminalSequences(row).trimEnd();
	});
}

test.each([40, 80, 122])("workflow shows running counts and tasks without expansion at width %i", (width) => {
	const { component } = createRow();
	component.updateResult({ content: [], details: progress(), isError: false }, true);
	const output = rows(component, width).join("\n");
	expect(output).toContain("8 running");
	expect(output).toMatch(/0\/8\s+completed/u);
	expect(output).toContain("Review");
	for (let task = 1; task <= 8; task += 1) expect(output).toContain(`Task ${task}`);
	expect(output).not.toContain("inline script source");
});

test("workflow redraw replaces live tasks and keeps the final result readable", async () => {
	const { component, terminal, ui } = createRow();
	const initial = progress();
	initial.agents = initial.agents.slice(0, 2);
	initial.agents[1]!.status = "queued";
	initial.totalAgents = 2;
	component.updateResult({ content: [], details: initial, isError: false }, true);
	ui.addChild(component);
	ui.addChild(new Text("WORKFLOW_FOOTER", 0, 0));
	ui.start();
	ui.renderNow();
	await terminal.flush();
	expect(terminal.getViewport().join("\n")).toContain("1 running");
	expect(terminal.getViewport().join("\n")).toContain("1 queued");

	const finished: WorkflowProgress = {
		...initial,
		status: "completed",
		completedAgents: 2,
		spentTokens: 7,
		agents: initial.agents.map((agent) => ({ ...agent, status: "completed", finishedAt: 3 })),
	};
	component.updateResult({ content: [], details: finished, isError: false }, true);
	component.updateResult(
		{
			content: [{ type: "text", text: "serialized tool result" }],
			details: {
				schemaVersion: 1,
				runId: "wf_live",
				name: "inline",
				status: "completed",
				value: "All checks passed",
				meta: {},
				startedAt: 1,
				finishedAt: 3,
				spentTokens: 7,
				cacheHits: 0,
				agentCalls: 2,
				phases: [],
			},
			isError: false,
		},
		false,
	);
	ui.renderNow();
	await terminal.flush();
	const output = terminal.getViewport().join("\n");
	expect(output).toContain("0 running");
	expect(output).toContain("2/2 completed");
	expect(output).toContain("All checks passed");
	expect(output).not.toContain("1 running");
	expect(output.match(/WORKFLOW_FOOTER/gu)).toHaveLength(1);
	expect(output.match(/workflow \(inline\)/gu)).toHaveLength(1);
});

test("workflow prioritizes active tasks and expands the complete task list", () => {
	const { component } = createRow();
	const snapshot = progress();
	snapshot.agents = Array.from({ length: 20 }, (_, index) => ({
		id: `agent-${index}`,
		label: `Task ${index + 1}`,
		status: index === 19 ? "running" : "completed",
	}));
	snapshot.totalAgents = 20;
	snapshot.completedAgents = 19;
	component.updateResult({ content: [], details: snapshot, isError: false }, true);
	const collapsed = rows(component).join("\n");
	expect(collapsed).toContain("Task 20");
	expect(collapsed).toContain("19/20 completed");
	expect(collapsed).toContain("12 more agents");
	expect(collapsed).toContain("to expand");
	component.setExpanded(true);
	const expanded = rows(component).join("\n");
	for (let task = 1; task <= 20; task += 1) expect(expanded).toContain(`Task ${task}`);
	expect(expanded).not.toContain("more agents");
});

test("workflow retains task failures and the actual tool error", () => {
	const { component } = createRow();
	const snapshot = progress();
	snapshot.status = "failed";
	snapshot.agents = [{ id: "failed", label: "Security", status: "failed" }];
	snapshot.totalAgents = 1;
	snapshot.message = "Permission denied inspecting authentication";
	component.updateResult({ content: [], details: snapshot, isError: false }, true);
	component.updateResult(
		{
			content: [{ type: "text", text: snapshot.message }],
			isError: true,
		},
		false,
	);
	const output = rows(component).join("\n");
	expect(output).toContain("1 failed");
	expect(output).toContain("Security");
	expect(output).toContain("Permission denied inspecting authentication");
	expect(output).not.toContain("1 running");
});
