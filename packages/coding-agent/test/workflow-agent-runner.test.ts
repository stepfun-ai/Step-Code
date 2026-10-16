import { expect, test, vi } from "vitest";
import type { StepSubagentRunInput, StepSubagentRunResult } from "../src/features/step-subagent.ts";

const runStepSubagentProcess = vi.hoisted(() => vi.fn());

vi.mock("../src/features/step-subagent.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/features/step-subagent.ts")>()),
	runStepSubagentProcess,
}));

vi.mock("../src/features/step-subagent-agents.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/features/step-subagent-agents.ts")>()),
	discoverStepAgents: async () => ({ agents: [{ name: "general", systemPrompt: "", source: "builtin" }] }),
	resolveStepAgent: (agents: Array<{ name: string }>, name: string) => agents.find((agent) => agent.name === name),
}));

const { createDefaultWorkflowAgentRunner } = await import("../src/features/workflow/agent-runner.ts");

function childResult(overrides: Partial<StepSubagentRunResult> = {}): StepSubagentRunResult {
	return {
		messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 1, turns: 1 },
		exitCode: 0,
		stopReason: "stop",
		...overrides,
	} as StepSubagentRunResult;
}

test("default runner forwards each child tool start and vouches for complete tool reporting", async () => {
	runStepSubagentProcess.mockImplementation(async (input: StepSubagentRunInput) => {
		const update = (patch: Partial<StepSubagentRunResult>) => input.onUpdate?.(childResult(patch));
		update({ lastEvent: "message_update", activeTool: "read_file" });
		update({ lastEvent: "tool_execution_start", activeTool: "read_file" });
		update({ lastEvent: "tool_execution_update", activeTool: "read_file" });
		update({ lastEvent: "tool_execution_start", activeTool: "edit_file" });
		update({ lastEvent: "tool_execution_end" });
		return childResult();
	});
	const tools: string[] = [];
	const runner = createDefaultWorkflowAgentRunner();
	const result = await runner({
		prompt: "work",
		options: {},
		cwd: process.cwd(),
		runId: "run",
		agentId: "agent",
		onToolExecutionStart: (tool) => tools.push(tool),
	});
	expect(tools).toEqual(["read_file", "edit_file"]);
	expect(result).toMatchObject({ status: "completed", toolActivityObserved: true });

	runStepSubagentProcess.mockResolvedValueOnce(childResult({ stopReason: "error", errorMessage: "boom" }));
	const failed = await runner({ prompt: "work", options: {}, cwd: process.cwd(), runId: "run", agentId: "agent" });
	expect(failed).toMatchObject({ status: "failed", toolActivityObserved: true });

	// A killed or crashed child may have lost a tool event in its unread output.
	runStepSubagentProcess.mockResolvedValueOnce(childResult({ exitCode: 143, stopReason: "aborted" }));
	const killed = await runner({ prompt: "work", options: {}, cwd: process.cwd(), runId: "run", agentId: "agent" });
	expect(killed).toMatchObject({ status: "aborted", toolActivityObserved: false });
	runStepSubagentProcess.mockResolvedValueOnce(childResult({ exitCode: 1, stopReason: "error" }));
	const crashed = await runner({ prompt: "work", options: {}, cwd: process.cwd(), runId: "run", agentId: "agent" });
	expect(crashed).toMatchObject({ status: "failed", toolActivityObserved: false });
});
