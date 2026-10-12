import { visibleWidth } from "@step-harness/pi-tui";
import { expect, test } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import {
	type BackgroundAgentLane,
	createStepSubagentExtension,
	type StepSubagentRunInput,
	type StepSubagentRunResult,
} from "../src/features/step-subagent.ts";
import { type AgentNotificationDetails, notifyLaneEvent } from "../src/features/subagent/lane-events.ts";
import { renderAgentNotification } from "../src/features/subagent/rendering.ts";
import type { Theme } from "../src/theme/theme.ts";

// Identity theme: assertions are about content and layout, not colors.
const plainTheme = { fg: (_c: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

function runResult(text: string, output = 2, exitCode = 0): StepSubagentRunResult {
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
					output,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1 + output,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		],
		stderr: "",
		exitCode,
		usage: { input: 1, output, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 1 + output, turns: 1 },
		startedAt: Date.now(),
		updatedAt: Date.now(),
	} as unknown as StepSubagentRunResult;
}

const fakeTui = { requestRender: () => {} };

interface WidgetCall {
	key: string;
	component?: { render(width: number): string[] };
}

function harness(): {
	api: ExtensionAPI;
	tools: Map<string, { execute: (...args: never[]) => Promise<unknown> }>;
	ctx: ExtensionContext;
	calls: WidgetCall[];
} {
	const tools = new Map<string, { execute: (...args: never[]) => Promise<unknown> }>();
	const api = {
		registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never),
		registerMessageRenderer: () => {},
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
		hasUI: true,
		cwd: "/tmp",
		model: undefined,
		thinkingLevel: "high",
		isIdle: () => true,
		isProjectTrusted: () => true,
		ui: {
			confirm: async () => true,
			notify: () => {},
			setWidget: (key: string, content: unknown) => {
				calls.push({
					key,
					component:
						typeof content === "function"
							? (content as (tui: unknown, theme: Theme) => WidgetCall["component"])(fakeTui, plainTheme)
							: undefined,
				});
			},
		},
		sessionManager: { getEntries: () => [] },
	} as unknown as ExtensionContext;
	return { api, tools, ctx, calls };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

test("background lanes share one stable list widget that clears when the batch settles", async () => {
	const { api, tools, ctx, calls } = harness();
	const gates = new Map<string, () => void>();
	const inputs = new Map<string, StepSubagentRunInput>();
	createStepSubagentExtension({
		includeBuiltinAgents: true,
		agentDir: "/tmp/step-agent-test",
		runner: (input) => {
			inputs.set(input.task, input);
			return new Promise((resolve) => gates.set(input.task, () => resolve(runResult(`${input.task} done`, 9))));
		},
	})(api);
	const subagent = tools.get("subagent")!;
	for (const task of ["alpha task", "beta task"]) {
		await subagent.execute(
			`call-${task}` as never,
			{ agent: "general", task, run_in_background: true } as never,
			undefined as never,
			undefined as never,
			ctx as never,
		);
	}
	await waitFor(() => inputs.size === 2);

	// A burst of streamed deltas only moves the live text; none of it reaches
	// the widget, so it is not republished.
	const before = calls.length;
	for (const delta of ["Now let me", "Now let me look at the section", "- INVERT_IF: `if cond:`"]) {
		inputs.get("beta task")!.onUpdate?.({ ...runResult("", 0), exitCode: -1, activeText: delta, messages: [] });
	}
	expect(calls.length).toBe(before);

	expect(new Set(calls.map((call) => call.key))).toEqual(new Set(["step-agent-lanes"]));
	const widget = calls.at(-1)!.component!;
	const rows = widget.render(100);
	expect(rows[0]).toContain("background agents");
	expect(rows[0]).toContain("2 running");
	// Rows keep spawn order regardless of which lane updated last, never show
	// the child's streamed text, and fit the width on one line each.
	expect(rows.findIndex((row) => row.includes("alpha task"))).toBeLessThan(
		rows.findIndex((row) => row.includes("beta task")),
	);
	expect(rows.join("\n")).not.toContain("INVERT_IF");
	for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(100);

	gates.get("alpha task")!();
	await waitFor(() => (calls.at(-1)?.component?.render(100)[0] ?? "").includes("1/2 complete"));
	expect(
		calls
			.at(-1)!
			.component!.render(100)
			.some((row) => row.includes("alpha task")),
	).toBe(true);

	gates.get("beta task")!();
	await waitFor(() => calls.at(-1)?.component === undefined);
	expect(calls.at(-1)!.key).toBe("step-agent-lanes");
});

function fakeLane(subscribe: BackgroundAgentLane["subscribe"]): BackgroundAgentLane {
	return {
		id: "b727337a",
		subscribe,
		status: "running",
		details: { results: [{ agent: "general" }] },
	} as unknown as BackgroundAgentLane;
}

test("progress notifications reach the model but stay out of the transcript", () => {
	const sent: Array<{ display?: boolean; details?: AgentNotificationDetails; content: string }> = [];
	const pi = { sendMessage: (message: (typeof sent)[number]) => sent.push(message) } as unknown as ExtensionAPI;
	const lane = fakeLane("progress");

	notifyLaneEvent(pi, lane, "background_progress", "step 1/1; tool write_file; turns 107");
	lane.status = "completed";
	notifyLaneEvent(pi, lane, "background_done", "all done");

	expect(sent[0].display).toBe(false);
	expect(sent[0].content).toContain("turns 107");
	expect(sent[1].display).toBe(true);
	expect(sent[1].details).toMatchObject({
		agentId: "b727337a",
		event: "background_done",
		label: "b727337a",
		agents: ["general"],
		detail: "all done",
	});
});

function notification(details?: AgentNotificationDetails): CustomMessage<AgentNotificationDetails> {
	return {
		role: "custom",
		customType: "agent-notification",
		content: '<agent-notification agentId="b727337a">raw</agent-notification>',
		display: true,
		details,
		timestamp: Date.now(),
	} as CustomMessage<AgentNotificationDetails>;
}

test("agent-notification renders as a status line with a collapsible preview", () => {
	const detail = ["line 1", "line 2", "line 3", "line 4", "line 5"].join("\n");
	const message = notification({
		agentId: "b727337a",
		event: "background_failed",
		status: "failed",
		label: "audit",
		agents: ["general"],
		detail,
	});

	const collapsed = renderAgentNotification(message, { expanded: false, outputPad: 0 }, plainTheme)!
		.render(120)
		.join("\n");
	expect(collapsed).toContain("background agent audit (general) failed");
	expect(collapsed).toContain("line 3");
	expect(collapsed).not.toContain("line 4");
	expect(collapsed).toContain("2 more lines");
	expect(collapsed).not.toContain("<agent-notification");

	const expanded = renderAgentNotification(message, { expanded: true, outputPad: 0 }, plainTheme)!
		.render(120)
		.join("\n");
	expect(expanded).toContain("line 5");
	expect(expanded).not.toContain("more lines");
});

test("agent-notification without structured details falls back to the host rendering", () => {
	expect(renderAgentNotification(notification(undefined), { expanded: false, outputPad: 0 }, plainTheme)).toBe(
		undefined,
	);
});
