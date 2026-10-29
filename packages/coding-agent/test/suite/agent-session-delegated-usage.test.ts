import { fauxAssistantMessage, fauxToolCall, type Usage } from "@step-harness/providers/compat";
import { expect, test } from "vitest";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import { createStepSubagentExtension, type StepSubagentRunResult } from "../../src/features/step-subagent.ts";
import { createStepWorkflowExtension } from "../../src/features/workflow/step-workflow.ts";
import { createHarness, type Harness } from "./harness.ts";

const childUsage = {
	input: 120,
	output: 30,
	cacheRead: 10,
	cacheWrite: 5,
	cost: 0.25,
	contextTokens: 165,
	turns: 2,
};

const expectedToolUsage: Usage = {
	input: 120,
	output: 30,
	cacheRead: 10,
	cacheWrite: 5,
	totalTokens: 165,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
};

function subagentResult(): StepSubagentRunResult {
	return {
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text: "subagent finished" }],
				api: "faux",
				provider: "faux",
				model: "faux-1",
				usage: expectedToolUsage,
				stopReason: "stop",
				timestamp: Date.now(),
			},
		],
		stderr: "",
		exitCode: 0,
		usage: childUsage,
		model: "faux/faux-1",
		stopReason: "stop",
	};
}

function parentTotals(entries: readonly SessionEntry[]) {
	return entries.reduce(
		(total, entry) => {
			if (entry.type !== "message" || entry.message.role !== "assistant") return total;
			const usage = entry.message.usage;
			return {
				input: total.input + usage.input,
				output: total.output + usage.output,
				cacheRead: total.cacheRead + usage.cacheRead,
				cacheWrite: total.cacheWrite + usage.cacheWrite,
				total: total.total + usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
				cost: total.cost + usage.cost.total,
			};
		},
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
	);
}

async function runDelegatedTool(harness: Harness, toolName: string, args: Record<string, unknown>): Promise<void> {
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall(toolName, args)], { stopReason: "toolUse" }),
		fauxAssistantMessage("parent finished"),
	]);
	await harness.session.prompt(`Run ${toolName}.`);
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for delegated usage");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function expectSessionTotals(harness: Harness): void {
	const parent = parentTotals(harness.sessionManager.getEntries());
	const stats = harness.session.getSessionStats();
	expect(stats.tokens).toEqual({
		input: parent.input + childUsage.input,
		output: parent.output + childUsage.output,
		cacheRead: parent.cacheRead + childUsage.cacheRead,
		cacheWrite: parent.cacheWrite + childUsage.cacheWrite,
		total: parent.total + 165,
	});
	expect(stats.cost).toBeCloseTo(parent.cost + childUsage.cost);
}

function expectDelegatedUsage(harness: Harness, toolName: string, expectError = false): void {
	const entries = harness.sessionManager.getEntries();
	const toolMessage = entries.find(
		(entry): entry is Extract<SessionEntry, { type: "message" }> =>
			entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === toolName,
	)?.message;
	expect(toolMessage?.role).toBe("toolResult");
	if (toolMessage?.role !== "toolResult") throw new Error(`${toolName} result was not persisted`);
	expect(Boolean(toolMessage.isError)).toBe(expectError);
	expect(toolMessage.usage).toEqual(expectedToolUsage);
	if (toolName === "workflow") expect(toolMessage.details).toMatchObject({ childSessionIds: ["workflow-child-1"] });

	expectSessionTotals(harness);
}

test("foreground subagent usage joins the parent session totals", async () => {
	const harness = await createHarness({
		extensionFactories: [
			{
				factory: createStepSubagentExtension({
					includeBuiltinAgents: true,
					agentDir: ".step-code/agents",
					runner: async () => subagentResult(),
				}),
			},
		],
		initialActiveToolNames: ["subagent"],
	});
	try {
		await runDelegatedTool(harness, "subagent", {
			agent: "general",
			task: "run one child",
			run_in_background: false,
		});
		expectDelegatedUsage(harness, "subagent");
	} finally {
		harness.cleanup();
	}
});

test("background subagent usage is counted once with synchronous progress", async () => {
	const harness = await createHarness({
		extensionFactories: [
			{
				factory: createStepSubagentExtension({
					includeBuiltinAgents: true,
					agentDir: ".step-code/agents",
					runner: async (input) => {
						input.onUpdate?.({ ...subagentResult(), exitCode: -1 });
						return subagentResult();
					},
				}),
			},
		],
		initialActiveToolNames: ["subagent"],
	});
	try {
		await harness.session.bindExtensions({ mode: "tui" });
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("subagent", { agent: "general", task: "background child", run_in_background: true })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("parent finished"),
			fauxAssistantMessage("background handled"),
		]);
		await harness.session.prompt("Run background subagent.");
		await waitFor(() =>
			harness.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom" && entry.customType === "step-subagent-usage"),
		);
		const entries = harness.sessionManager.getEntries();
		const launchResult = entries.find(
			(entry) =>
				entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "subagent",
		);
		expect(
			launchResult?.type === "message" && launchResult.message.role === "toolResult"
				? launchResult.message.usage
				: undefined,
		).toBeUndefined();
		expect(
			entries.filter((entry) => entry.type === "custom" && entry.customType === "step-subagent-usage"),
		).toHaveLength(1);
		expectSessionTotals(harness);
	} finally {
		harness.cleanup();
	}
});

test("workflow usage joins the parent session totals", async () => {
	const harness = await createHarness({
		extensionFactories: [
			{
				factory: createStepWorkflowExtension({
					runner: async () => ({
						text: "workflow child finished",
						usage: childUsage,
						sessionId: "workflow-child-1",
						status: "completed",
					}),
				}),
			},
		],
		initialActiveToolNames: ["workflow"],
	});
	try {
		await runDelegatedTool(harness, "workflow", {
			script: 'const value = await agent("run workflow child"); return value;',
		});
		expectDelegatedUsage(harness, "workflow");
	} finally {
		harness.cleanup();
	}
});

test.each([
	{
		name: "failed agent",
		script: 'return await agent("fail workflow child");',
		args: {},
		status: "failed" as const,
	},
	{
		name: "budget exhaustion",
		script: 'return await agent("exceed workflow budget");',
		args: { budget: 1 },
		status: "completed" as const,
	},
	{
		name: "top-level script failure",
		script: 'await agent("spend then throw"); throw new Error("script exploded");',
		args: {},
		status: "completed" as const,
	},
])("workflow $name still joins the parent session totals", async (scenario) => {
	const harness = await createHarness({
		extensionFactories: [
			{
				factory: createStepWorkflowExtension({
					runner: async () => ({
						text: "workflow child failed",
						usage: childUsage,
						sessionId: "workflow-child-1",
						status: scenario.status,
					}),
				}),
			},
		],
		initialActiveToolNames: ["workflow"],
	});
	try {
		await runDelegatedTool(harness, "workflow", { script: scenario.script, ...scenario.args });
		expectDelegatedUsage(harness, "workflow", true);
	} finally {
		harness.cleanup();
	}
});
