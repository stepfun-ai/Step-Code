import { expect, test, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import {
	type BackgroundAgentLane,
	createStepSubagentExtension,
	type StepSubagentRunInput,
	type StepSubagentRunResult,
} from "../src/features/step-subagent.ts";
import {
	type AgentNotificationDetails,
	maybeNotifyLaneProgress,
	notifyLaneEvent,
} from "../src/features/subagent/lane-events.ts";
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
	sent: Array<{ customType?: string }>;
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
		sendMessage: (message: { customType?: string }) => sent.push(message),
		sendUserMessage: () => {},
	} as unknown as ExtensionAPI;
	const calls: WidgetCall[] = [];
	/** Agent notifications, used as the deterministic "this lane settled" signal. */
	const sent: Array<{ customType?: string }> = [];
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
	return { api, tools, ctx, calls, sent };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

test("background lanes draw no widget: /subagents is where they are read", async () => {
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

	// A background lane must not add anything above the editor. It used to share one list widget;
	// the roster is now read through `/subagents`, which subscribes to the same lane snapshots.
	expect(calls).toEqual([]);

	// Settle both lanes, then let the event loop drain past a repaint interval. The assertion is that
	// no widget is ever set, not that none was set in the first 50ms: a re-added 1s ticker, or a
	// publish from the async final-delivery path, would escape a short fixed sample.
	gates.get("alpha task")!();
	gates.get("beta task")!();
	await waitFor(() => inputs.size === 2);
	await new Promise((resolve) => setTimeout(resolve, 1_100));
	expect(calls).toEqual([]);
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
		agents: ["general"],
		detail: "all done",
	});
});

test("lane notifications count omitted live records without inventing their statuses", () => {
	const sent: Array<{ content: string }> = [];
	const pi = { sendMessage: (message: (typeof sent)[number]) => sent.push(message) } as unknown as ExtensionAPI;
	const lane = fakeLane("progress");
	lane.details.omittedResults = 199;
	lane.details.results[0] = { ...lane.details.results[0], status: "running", usage: runResult("").usage };
	lane.lastProgressNotifyAt = 0;
	const now = vi.spyOn(Date, "now").mockReturnValue(20_000);
	try {
		maybeNotifyLaneProgress(pi, lane);
	} finally {
		now.mockRestore();
	}
	expect(sent[0].content).toContain('tasks="200"');
	expect(sent[0].content).toContain("step 1/200");
	// Only the visible record's status is known; omitted records are not assumed done.
	notifyLaneEvent(pi, lane, "background_done");
	expect(sent[1].content).toContain("1 running, 199 not shown");
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
