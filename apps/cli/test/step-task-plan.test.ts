import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@step-harness/coding-agent";
import { stripTerminalSequences, type TUI, visibleWidth } from "@step-harness/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStepTasksExtension } from "../../../packages/coding-agent/src/features/step-tasks.ts";
import { initTheme, theme } from "../../../packages/coding-agent/src/theme/theme.ts";
import type { RuntimeContext } from "../src/ui/runtime/context.ts";
import { handleSessionEvent } from "../src/ui/runtime/session-events.ts";
import { ToolExecutionComponent } from "../src/ui/view/transcript/tool-execution.ts";

beforeEach(() => initTheme("step-blue"));
afterEach(() => initTheme("dark"));

function createHarness() {
	const tools = new Map<string, ToolDefinition>();
	createStepTasksExtension()({
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		registerCommand: () => {},
		appendEntry: () => {},
		on: () => {},
	} as unknown as ExtensionAPI);
	const ctx = { hasUI: true, ui: { setWidget: vi.fn() } } as unknown as ExtensionContext;
	const ui = { requestRender: () => {} } as unknown as TUI;
	const create = (name: string, args: Record<string, unknown>) =>
		new ToolExecutionComponent(name, "task-call", args, { presentation: "step" }, tools.get(name), ui, "/tmp");
	const execute = async (name: string, args: Record<string, unknown>) => {
		const component = create(name, args);
		component.markExecutionStarted();
		const result = await tools.get(name)!.execute("task-call", args, undefined, undefined, ctx);
		component.updateResult({ ...result, isError: false });
		return component;
	};
	return { ctx, tools, ui, create, execute };
}

describe("inline task plan", () => {
	it("counts only the selected plan while retaining historical rows", async () => {
		const { execute } = createHarness();
		for (const subject of ["甲", "乙", "丙"]) {
			await execute("task_create", { subject, description: "Old" });
		}
		const old = await execute("task_update", { taskId: "1", status: "completed" });
		const oldRows = old.render(80);
		for (const [index, subject] of ["梳理需求", "设计方案", "搭项目骨架", "编写实现", "验证收尾"].entries()) {
			await execute("task_create", { subject, description: "New", ...(index === 0 ? { newPlan: "新计划" } : {}) });
		}
		const current = await execute("task_update", { taskId: "4", status: "in_progress" });
		const currentRows = current.render(80);
		const plain = currentRows.map(stripTerminalSequences).join("\n");
		expect(plain).toContain("Updated Plan (0/5)");
		expect(plain).not.toMatch(/甲|乙|丙/);
		const resumed = await execute("task_update", { resumePlanId: "plan-1" });
		expect(resumed.render(80).map(stripTerminalSequences).join("\n")).toContain("Updated Plan (1/3)");
		old.invalidate();
		current.invalidate();
		expect(old.render(80)).toEqual(oldRows);
		expect(current.render(80)).toEqual(currentRows);
	});

	it("hides creation and reads, then shows a full immutable Updated Plan", async () => {
		const { ctx, create, execute } = createHarness();
		expect(create("task_create", { subject: "Task 1" }).render(80)).toEqual([]);
		for (let index = 1; index <= 7; index++) {
			const created = await execute("task_create", { subject: `Task ${index}`, description: "Details" });
			expect(created.render(80)).toEqual([]);
		}
		const fetched = await execute("task_get", { taskId: "1" });
		expect(fetched.render(80)).toEqual([]);
		await execute("task_update", { taskId: "1", status: "completed" });
		const updated = await execute("task_update", { taskId: "2", status: "in_progress" });
		const rows = updated.render(80);
		const plain = rows.map(stripTerminalSequences).join("\n");
		expect(plain).toContain("● Updated Plan (1/7)");
		expect(plain).toContain("  └ ✔ Task 1");
		expect(plain).toContain("    ◧ Task 2");
		expect(plain).toContain("    □ Task 7");
		expect(plain).not.toMatch(/task_create|task_update|more lines|todo \d|\(in progress\)/u);
		expect(rows.join("\n")).toContain(theme.bold(theme.fg("accent", "◧ Task 2")));
		const completed = await execute("task_update", { taskId: "2", status: "completed" });
		expect(completed.render(80).map(stripTerminalSequences).join("\n")).toContain("Updated Plan (2/7)");
		updated.invalidate();
		expect(updated.render(80)).toEqual(rows);
		expect(ctx.ui.setWidget).not.toHaveBeenCalled();
	});

	it("routes out-of-order result events by call id without overwriting newer snapshots", async () => {
		const { ctx, tools, ui, execute } = createHarness();
		for (let index = 1; index <= 5; index++) {
			await execute("task_create", { subject: `Task ${index}`, description: "work" });
		}
		const pendingTools = new Map<string, ToolExecutionComponent>();
		const runtime = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			pendingTools,
			settingsManager: { getShowImages: () => false, getImageWidthCells: () => undefined },
			options: { tuiStyle: "step" },
			getRegisteredToolDefinition: (name: string) => tools.get(name),
			ui,
			sessionManager: { getCwd: () => "/tmp" },
			chatContainer: { addChild: vi.fn() },
			workingOutputTracker: { notifyToolStarted: vi.fn() },
			workingVisible: false,
			redraw: { requestRender: vi.fn() },
		} as unknown as RuntimeContext;
		const firstArgs = { taskId: "1", status: "completed" };
		const secondArgs = { taskId: "2", status: "completed" };
		await handleSessionEvent(runtime, {
			type: "tool_execution_start",
			toolCallId: "first",
			toolName: "task_update",
			args: firstArgs,
		});
		await handleSessionEvent(runtime, {
			type: "tool_execution_start",
			toolCallId: "second",
			toolName: "task_update",
			args: secondArgs,
		});
		const first = pendingTools.get("first")!;
		const second = pendingTools.get("second")!;
		expect(first.render(80)).toEqual([]);
		expect(second.render(80)).toEqual([]);
		const firstResult = await tools.get("task_update")!.execute("first", firstArgs, undefined, undefined, ctx);
		const secondResult = await tools.get("task_update")!.execute("second", secondArgs, undefined, undefined, ctx);
		await handleSessionEvent(runtime, {
			type: "tool_execution_end",
			toolCallId: "second",
			toolName: "task_update",
			result: secondResult,
			isError: false,
		});
		const latestRows = second.render(80);
		expect(latestRows.map(stripTerminalSequences).join("\n")).toContain("Updated Plan (2/5)");
		await handleSessionEvent(runtime, {
			type: "tool_execution_end",
			toolCallId: "first",
			toolName: "task_update",
			result: firstResult,
			isError: false,
		});
		expect(first.render(80).map(stripTerminalSequences).join("\n")).toContain("Updated Plan (1/5)");
		expect(second.render(80)).toEqual(latestRows);
		expect(pendingTools.size).toBe(0);
		expect(runtime.redraw.requestRender).toHaveBeenCalledTimes(4);
	});

	it("keeps creation errors and explicitly expanded details visible", async () => {
		const { create, execute } = createHarness();
		const failed = create("task_create", {});
		failed.updateResult({ content: [{ type: "text", text: "Unable to save task" }], isError: true });
		expect(failed.render(80).map(stripTerminalSequences).join("\n")).toContain("Unable to save task");
		const created = await execute("task_create", { subject: "One", description: "Details" });
		created.setExpanded(true);
		expect(created.render(80).map(stripTerminalSequences).join("\n")).toContain("task_create");
	});

	it.each([1, 8, 20, 40, 80])("wraps plan entries without overflowing width %i", async (width) => {
		const { execute } = createHarness();
		await execute("task_create", { subject: `梳理\n\t${"输入渲染路径".repeat(20)}`, description: "Details" });
		const updated = await execute("task_update", { taskId: "1", status: "in_progress" });
		for (const line of updated.render(width)) {
			expect(line).not.toMatch(/[\r\n\t]/u);
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});
