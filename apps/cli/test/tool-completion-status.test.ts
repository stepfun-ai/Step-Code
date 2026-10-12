import { initTheme } from "@step-harness/coding-agent";
import { Container, stripTerminalSequences, type TUI } from "@step-harness/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeContext } from "../src/ui/runtime/context.ts";
import { handleSessionEvent } from "../src/ui/runtime/session-events.ts";
import { WorkingOutputTracker, WorkingStatusIndicator } from "../src/ui/view/chrome/status-indicator.ts";
import { StepToolSpinnerClock } from "../src/ui/view/transcript/step-spinner.ts";
import { ToolExecutionComponent } from "../src/ui/view/transcript/tool-execution.ts";

function createView() {
	const ui = { requestRender: vi.fn() } as unknown as TUI;
	const spinner = new StepToolSpinnerClock(() => ui.requestRender());
	const tracker = new WorkingOutputTracker();
	const indicator = new WorkingStatusIndicator(ui, "Working...", undefined, "step", tracker, () =>
		spinner.currentToolName(),
	);
	const pendingTools = new Map<string, ToolExecutionComponent>();
	const chatContainer = new Container();
	const ctx = {
		isInitialized: true,
		presentation: "step",
		footer: { invalidate: vi.fn() },
		pendingTools,
		chatContainer,
		stepSpinner: spinner,
		workingOutputTracker: tracker,
		activeStatusIndicator: indicator,
		workingVisible: true,
		redraw: { requestRender: () => ui.requestRender() },
	} as unknown as RuntimeContext;
	return {
		pendingTools,
		spinner,
		tracker,
		text: () => stripTerminalSequences(indicator.render(100).join("\n")),
		async start(toolName: string, toolCallId: string) {
			const args = { path: "fixture.txt", command: "printf done" };
			const component = new ToolExecutionComponent(
				toolName,
				toolCallId,
				args,
				{ presentation: "step", spinner, showImages: false },
				undefined,
				ui,
				process.cwd(),
			);
			pendingTools.set(toolCallId, component);
			chatContainer.addChild(component);
			await handleSessionEvent(ctx, { type: "tool_execution_start", toolName, toolCallId, args });
		},
		end(toolName: string, toolCallId: string, isError = false) {
			return handleSessionEvent(ctx, {
				type: "tool_execution_end",
				toolName,
				toolCallId,
				result: { content: [{ type: "text", text: isError ? "failed" : "done" }] },
				isError,
			});
		},
		dispose() {
			indicator.dispose();
			spinner.dispose();
		},
	};
}

describe("working status after tool completion", () => {
	beforeEach(() => {
		initTheme("step-blue");
		vi.useFakeTimers();
		vi.setSystemTime(0);
	});
	afterEach(() => vi.useRealTimers());

	it.each([
		["run_command", "Running...", false],
		["read_file", "Reading...", false],
		["edit_file", "Editing...", false],
		["run_command", "Running...", true],
		["read_file", "Reading...", true],
		["edit_file", "Editing...", true],
	] as const)("stops naming completed %s (%s, error=%s)", async (toolName, verb, isError) => {
		const view = createView();
		try {
			await view.start(toolName, "call-1");
			expect(view.text()).toContain(verb);
			vi.advanceTimersByTime(10);
			await view.end(toolName, "call-1", isError);

			expect(view.pendingTools.size).toBe(0);
			expect(view.spinner.currentToolName()).toBeUndefined();
			expect(view.text()).toContain("Working...");
			expect(view.text()).not.toContain(verb);
			// No further model output arrives during this simulated minute.
			vi.advanceTimersByTime(60_000);
			expect(view.text()).toContain("Working... (1m");
			expect(view.text()).not.toContain(verb);
		} finally {
			view.dispose();
		}
	});

	it("names the remaining parallel tool as soon as the newest one completes", async () => {
		const view = createView();
		try {
			await view.start("run_command", "long-command");
			await view.start("read_file", "short-read");
			expect(view.text()).toContain("Reading...");
			await view.end("read_file", "short-read");
			expect(view.pendingTools.size).toBe(1);
			expect(view.text()).toContain("Running...");

			vi.advanceTimersByTime(60_000);
			expect(view.text()).toContain("Running...");
			await view.end("run_command", "long-command");
			expect(view.text()).toContain("Working...");
		} finally {
			view.dispose();
		}
	});
});
