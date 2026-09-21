import { visibleWidth } from "@step-harness/pi-tui";
import { expect, test } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import {
	createStepSubagentExtension,
	type StepSubagentDetails,
	type StepSubagentResultRecord,
	type StepSubagentRunResult,
} from "../src/features/step-subagent.ts";
import { SubagentListWidget } from "../src/features/subagent/rendering.ts";
import type { Theme } from "../src/theme/theme.ts";

// Identity theme: assertions are about layout, not colors.
const plainTheme = { fg: (_c: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

function record(overrides: Partial<StepSubagentResultRecord> = {}): StepSubagentResultRecord {
	const now = Date.now();
	return {
		agent: "general",
		agentSource: "builtin",
		task: "review the scheduler",
		status: "running",
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		startedAt: now,
		updatedAt: now,
		...overrides,
	} as StepSubagentResultRecord;
}

function details(results: StepSubagentResultRecord[]): StepSubagentDetails {
	return {
		mode: "parallel",
		agentScope: "user",
		userAgentsDir: "/tmp/agents",
		projectAgentsDir: null,
		results,
	};
}

// The TUI's own column measure: String#length would repeat the very bug these
// assertions exist to catch, since CJK glyphs occupy two columns each.
const visibleWidthOf = (line: string): number => visibleWidth(line);

test("header counts running, completed, and failed lanes", () => {
	const widget = new SubagentListWidget(
		details([
			record({ status: "completed" }),
			record(),
			record(),
			record({ status: "failed", errorMessage: "429 rate limited" }),
		]),
		plainTheme,
	);
	expect(widget.render(120)[0]).toContain("1/4 complete, 2 running, 1 failed");
});

test("activity title prefers the running tool, then streamed text, then the task", () => {
	const widget = new SubagentListWidget(
		details([
			record({ agent: "a", activeTool: "run_command", activeToolArgs: "git status" }),
			// Multi-line streamed text collapses onto one row.
			record({ agent: "b", activeText: "Reading extensionHarness in\n   step-schedule.test.ts" }),
			record({ agent: "c" }),
		]),
		plainTheme,
	);
	const rows = widget.render(120).slice(1);
	expect(rows[0]).toContain("run_command: git status");
	expect(rows[1]).toContain("Reading extensionHarness in step-schedule.test.ts");
	expect(rows[2]).toContain("review the scheduler");
});

test("streamed text truncates from the tail while running and from the head once settled", () => {
	const text = `${"a".repeat(200)} TAIL-MARKER`;
	const running = new SubagentListWidget(details([record({ activeText: text })]), plainTheme);
	// Newest words are the live status, so the tail survives.
	expect(running.render(80)[1]).toContain("TAIL-MARKER");

	const settled = new SubagentListWidget(details([record({ status: "completed", activeText: text })]), plainTheme);
	// The same field is a conclusion once settled, so it reads from the front.
	const row = settled.render(80)[1];
	expect(row).not.toContain("TAIL-MARKER");
	expect(row).toContain("aaa");
});

test("elapsed and token columns render and elapsed advances with the clock", () => {
	const started = Date.now() - 65_000;
	const widget = new SubagentListWidget(
		details([
			record({
				startedAt: started,
				usage: { input: 10, output: 201_700, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 4 },
			}),
		]),
		plainTheme,
	);
	expect(widget.render(120)[1]).toMatch(/65s · ↓201\.7k$/u);

	// Elapsed is derived in render(), so a later render reports more time without
	// any update to the details object.
	const later = new SubagentListWidget(details([record({ startedAt: started - 10_000 })]), plainTheme);
	expect(later.render(120)[1]).toMatch(/75s$/u);
});

test("a settled lane freezes its elapsed at updatedAt", () => {
	const now = Date.now();
	const widget = new SubagentListWidget(
		details([record({ status: "completed", startedAt: now - 300_000, updatedAt: now - 240_000 })]),
		plainTheme,
	);
	expect(widget.render(120)[1]).toMatch(/60s$/u);
});

// Regression: fitLine measured with String#length, so a CJK title (2 columns
// per glyph) overflowed its cell, pushed the row past the viewport, and lost the
// metric column to the row's own final clamp — visible as rows whose elapsed and
// token counts simply vanished.
test("wide glyphs are measured in display columns, so the metric column survives", () => {
	const widget = new SubagentListWidget(
		details([
			record({
				status: "completed",
				startedAt: Date.now() - 259_000,
				usage: { input: 0, output: 5100, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 2 },
				activeText: "已获取全部所需数据，多个来源交叉验证一致。以下是查询结果，品种为黄金现货。",
			}),
			record({ activeText: "plain ascii activity text that is also comfortably longer than the cell" }),
		]),
		plainTheme,
	);
	for (const width of [80, 100, 120]) {
		const rows = widget.render(width).slice(1);
		for (const row of rows) {
			expect(visibleWidthOf(row), `width ${width}: ${JSON.stringify(row)}`).toBe(width);
		}
		// Both rows must still end in their metric, not in a clipped title.
		expect(rows[0]).toMatch(/259s · ↓5\.1k$/u);
	}
});

test("the metric column is a fixed width, so rows align regardless of value length", () => {
	const now = Date.now();
	const widget = new SubagentListWidget(
		details([
			record({ startedAt: now - 7_000 }),
			record({
				startedAt: now - 259_000,
				usage: { input: 0, output: 180_000, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 9 },
			}),
		]),
		plainTheme,
	);
	const rows = widget.render(100).slice(1);
	expect(rows.map((row) => visibleWidthOf(row))).toEqual([100, 100]);
	// A bare "7s" and a full "259s · ↓180.0k" occupy the same cell, so the short
	// one is padded rather than the column shrinking to fit it.
	// Both metrics are right-aligned inside the same 16-column cell: "7s" is two
	// columns so it carries 14 of padding, "259s · ↓180.0k" is fourteen and
	// carries two. A cell sized to its contents would give both zero.
	expect(rows[0].endsWith(`${" ".repeat(14)}7s`)).toBe(true);
	expect(rows[1].endsWith(`${" ".repeat(2)}259s · ↓180.0k`)).toBe(true);
});

test("no row exceeds the viewport width, down to a narrow terminal", () => {
	const widget = new SubagentListWidget(
		details([
			record({ agent: "reviewer", activeTool: "run_command", activeToolArgs: "git diff ".repeat(40) }),
			record({ agent: "b", activeText: "x".repeat(400) }),
			record({ status: "failed", errorMessage: "y".repeat(400) }),
		]),
		plainTheme,
	);
	for (const width of [30, 40, 60, 80, 120]) {
		for (const line of widget.render(width)) {
			expect(visibleWidthOf(line), `width ${width}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(width);
		}
	}
});

test("rows beyond the cap collapse into a counter", () => {
	const widget = new SubagentListWidget(
		details(Array.from({ length: 11 }, (_, index) => record({ agent: `a${index}` }))),
		plainTheme,
	);
	const lines = widget.render(120);
	expect(lines).toHaveLength(1 + 8 + 1);
	expect(lines.at(-1)).toContain("... 3 more");
});

interface WidgetCall {
	key: string;
	cleared: boolean;
	placement?: string;
}

function harness(hasUI: boolean): {
	api: ExtensionAPI;
	tools: Map<string, { execute: (...args: never[]) => Promise<unknown> }>;
	ctx: ExtensionContext;
	calls: WidgetCall[];
} {
	const tools = new Map<string, { execute: (...args: never[]) => Promise<unknown> }>();
	const api = {
		registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never),
		registerCommand: () => {},
		registerFlag: () => {},
		registerShortcut: () => {},
		on: () => {},
		getActiveTools: () => [],
		setActiveTools: () => {},
		getFlag: () => false,
		appendEntry: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
	} as unknown as ExtensionAPI;
	const calls: WidgetCall[] = [];
	const ctx = {
		mode: "tui",
		hasUI,
		cwd: "/tmp",
		model: undefined,
		thinkingLevel: "high",
		isIdle: () => true,
		isProjectTrusted: () => true,
		ui: {
			confirm: async () => true,
			notify: () => {},
			setWidget: (key: string, content: unknown, options?: { placement?: string }) => {
				calls.push({ key, cleared: content === undefined, placement: options?.placement });
			},
		},
		sessionManager: { getEntries: () => [] },
	} as unknown as ExtensionContext;
	return { api, tools, ctx, calls };
}

function runResult(text: string): StepSubagentRunResult {
	return {
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text }],
				api: "anthropic-messages",
				provider: "step",
				model: "step-3.7-flash",
				usage: {
					input: 1,
					output: 2,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 3,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		],
		stderr: "",
		exitCode: 0,
		usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 3, turns: 1 },
		startedAt: Date.now(),
		updatedAt: Date.now(),
	} as unknown as StepSubagentRunResult;
}

test("a blocking parallel run publishes the list below the editor and clears it after", async () => {
	const { api, tools, ctx, calls } = harness(true);
	createStepSubagentExtension({
		includeBuiltinAgents: true,
		agentDir: "/tmp/step-agent-test",
		runner: async () => runResult("done"),
	})(api);

	await tools.get("subagent")!.execute(
		"call-1" as never,
		{
			tasks: [
				{ agent: "general", task: "one" },
				{ agent: "general", task: "two" },
			],
		} as never,
		undefined as never,
		undefined as never,
		ctx as never,
	);

	const key = "step-subagent-list:call-1";
	const mine = calls.filter((call) => call.key === key);
	expect(mine.length).toBeGreaterThan(1);
	expect(mine.some((call) => !call.cleared && call.placement === "belowEditor")).toBe(true);
	// The widget must not outlive the tool call.
	expect(mine.at(-1)?.cleared).toBe(true);
});

test("the list is published before any child produces output", async () => {
	const { api, tools, ctx, calls } = harness(true);
	let released: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		released = resolve;
	});
	createStepSubagentExtension({
		includeBuiltinAgents: true,
		agentDir: "/tmp/step-agent-test",
		// Stand in for a child that has not streamed anything yet: spawn, mcp
		// startup and the first token all happen before the first onUpdate.
		runner: async () => {
			await gate;
			return runResult("done");
		},
	})(api);

	const pending = tools.get("subagent")!.execute(
		"call-3" as never,
		{
			tasks: [
				{ agent: "general", task: "one" },
				{ agent: "general", task: "two" },
			],
		} as never,
		undefined as never,
		undefined as never,
		ctx as never,
	);
	// The roster emit lands after executeSubagent's agent discovery (real fs I/O),
	// so wait for it rather than for a fixed number of microtasks. The gated
	// runner guarantees no child has produced anything by the time it appears.
	const key = "step-subagent-list:call-3";
	const deadline = Date.now() + 3_000;
	while (!calls.some((call) => call.key === key && !call.cleared)) {
		if (Date.now() > deadline) throw new Error("the subagent list was never published");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	expect(calls.some((call) => call.key === key && call.placement === "belowEditor")).toBe(true);
	released();
	await pending;
	expect(calls.filter((call) => call.key === key).at(-1)?.cleared).toBe(true);
});

test("a headless host gets no widget", async () => {
	const { api, tools, ctx, calls } = harness(false);
	createStepSubagentExtension({
		includeBuiltinAgents: true,
		agentDir: "/tmp/step-agent-test",
		runner: async () => runResult("done"),
	})(api);

	await tools
		.get("subagent")!
		.execute(
			"call-2" as never,
			{ agent: "general", task: "solo" } as never,
			undefined as never,
			undefined as never,
			ctx as never,
		);
	expect(calls.filter((call) => call.key.startsWith("step-subagent-list:"))).toHaveLength(0);
});
