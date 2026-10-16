import os from "node:os";
import type { AgentToolResult } from "@step-harness/agent-core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import type {
	StepSubagentDetails,
	StepSubagentRunInput,
	StepSubagentRunResult,
	SubagentParams,
} from "../src/features/step-subagent.ts";
import { executeSubagent } from "../src/features/subagent/execute.ts";
import { acquireWorkflowAdmission, resetWorkflowAdmission } from "../src/features/workflow/admission.ts";

beforeEach(() => {
	// These tests exercise a four-slot window, independent of the CI host's CPU count.
	vi.spyOn(os, "cpus").mockReturnValue(Array(6).fill(os.cpus()[0]!));
	vi.stubEnv("STEP_WORKFLOW_CONCURRENCY_LIMIT", "");
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	resetWorkflowAdmission();
});

// Deterministic runner outcome keyed by the step's task text.
type Outcome = { text: string; exitCode?: number; stopReason?: string; errorMessage?: string };

function runResult(outcome: Outcome): StepSubagentRunResult {
	const exitCode = outcome.exitCode ?? 0;
	return {
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text: outcome.text }],
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
				stopReason: outcome.stopReason ?? "stop",
				timestamp: Date.now(),
			},
		],
		stderr: "",
		exitCode,
		stopReason: outcome.stopReason,
		errorMessage: outcome.errorMessage,
		usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 3, turns: 1 },
		startedAt: Date.now(),
		updatedAt: Date.now(),
	} as unknown as StepSubagentRunResult;
}

const ctx = {
	mode: "print",
	hasUI: false,
	cwd: "/tmp",
	model: undefined,
	thinkingLevel: "high",
	isProjectTrusted: () => true,
} as unknown as ExtensionContext;

async function run(
	params: SubagentParams,
	respond: (input: StepSubagentRunInput, index: number) => Outcome,
	options: { maxConcurrency?: number; runnerDelayMs?: number } = {},
): Promise<{
	peakActive: number;
	result: AgentToolResult<StepSubagentDetails>;
	tasks: string[];
	partialModes: StepSubagentDetails["mode"][];
	partialStatuses: string[][];
}> {
	const tasks: string[] = [];
	const partialModes: StepSubagentDetails["mode"][] = [];
	const partialStatuses: string[][] = [];
	let active = 0;
	let peakActive = 0;
	const result = await executeSubagent(
		params,
		undefined,
		(partial) => {
			if (!partial.details) return;
			partialModes.push(partial.details.mode);
			partialStatuses.push(partial.details.results.map((record) => record.status));
		},
		ctx,
		{
			agentDir: "/tmp/step-agent-test",
			configDirName: ".step",
			includeBuiltinAgents: true,
			maxParallelTasks: 8,
			maxConcurrency: options.maxConcurrency ?? 4,
			worktreeManager: { allocate: async () => Promise.reject(new Error("no worktrees in this test")) },
			runner: async (input) => {
				const index = tasks.length;
				tasks.push(input.task);
				const partial = runResult({ text: "" });
				input.onUpdate?.({ ...partial, exitCode: -1, messages: [] });
				active++;
				peakActive = Math.max(peakActive, active);
				try {
					if (options.runnerDelayMs) await new Promise((resolve) => setTimeout(resolve, options.runnerDelayMs));
					return runResult(respond(input, index));
				} finally {
					active--;
				}
			},
		},
	);
	return { result, tasks, partialModes, partialStatuses, peakActive };
}

function contentText(result: AgentToolResult<StepSubagentDetails>): string {
	return result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

const threeSteps: SubagentParams = {
	chain: [
		{ agent: "explore", task: "return STEP_1_SOURCE" },
		{ agent: "explore", task: "summarize {previous} as STEP_2_SUMMARY" },
		{ agent: "general", task: "from {previous} return STEP_3_FINAL" },
	],
} as SubagentParams;

test("a completed chain returns the last step's output with a per-step summary", async () => {
	const outputs = ["STEP_1_SOURCE", "STEP_2_SUMMARY", "STEP_3_FINAL"];
	const { result, tasks, partialModes } = await run(threeSteps, (_input, index) => ({ text: outputs[index] }));

	expect(tasks[1]).toBe("summarize STEP_1_SOURCE as STEP_2_SUMMARY");
	expect(tasks[2]).toBe("from STEP_2_SUMMARY return STEP_3_FINAL");
	const text = contentText(result);
	expect(text).toContain("3/3 steps completed");
	expect(text).toContain("STEP_3_FINAL");
	// Earlier bodies stay in details, not in the parent's context.
	expect(text).not.toContain("STEP_1_SOURCE");
	expect(result.details?.mode).toBe("chain");
	expect(result.details?.results.map((record) => record.status)).toEqual(["completed", "completed", "completed"]);
	expect(new Set(partialModes)).toEqual(new Set(["chain"]));
});

test("a failed step surfaces its error in content and marks later steps skipped", async () => {
	const { result, tasks } = await run(threeSteps, (_input, index) =>
		index === 0
			? { text: "STEP_1_SOURCE" }
			: { text: "", exitCode: 2, stopReason: "error", errorMessage: "STEP_2_BROKE" },
	);

	expect(tasks).toHaveLength(2);
	const text = contentText(result);
	expect(text).toContain("Chain stopped at step 2/3");
	expect(text).toContain("did not complete");
	expect(text).toContain("STEP_2_BROKE");
	expect(text).toContain("3. general: skipped");
	expect(text).toContain("STEP_1_SOURCE");
	const records = result.details?.results ?? [];
	expect(records.map((record) => record.status)).toEqual(["completed", "failed", "skipped"]);
	expect(records[2].startedAt).toBeUndefined();
});

test("an aborted step is reported as aborted, not as success", async () => {
	const { result } = await run(threeSteps, (_input, index) =>
		index === 0 ? { text: "STEP_1_SOURCE" } : { text: "", exitCode: 1, stopReason: "aborted" },
	);

	expect(contentText(result)).toContain("Chain stopped at step 2/3 (explore: aborted)");
	expect(result.details?.results.map((record) => record.status)).toEqual(["completed", "aborted", "skipped"]);
});

test("a failing first step skips the rest", async () => {
	const { result, tasks } = await run(threeSteps, () => ({
		text: "",
		exitCode: 1,
		stopReason: "error",
		errorMessage: "STEP_1_BROKE",
	}));

	expect(tasks).toHaveLength(1);
	const text = contentText(result);
	expect(text).toContain("Chain stopped at step 1/3");
	expect(text).toContain("STEP_1_BROKE");
	expect(text).not.toContain("Last completed output");
	expect(result.details?.results.map((record) => record.status)).toEqual(["failed", "skipped", "skipped"]);
});

test("single mode still returns the step's own output", async () => {
	const { result } = await run({ agent: "general", task: "solo" } as SubagentParams, () => ({ text: "SOLO_OUT" }));

	expect(contentText(result)).toBe("SOLO_OUT");
	expect(result.details?.mode).toBe("single");
});

test("parallel mode still aggregates every task", async () => {
	const { result } = await run(
		{
			tasks: [
				{ agent: "explore", task: "a" },
				{ agent: "explore", task: "b" },
			],
		} as SubagentParams,
		(input) => ({ text: `OUT_${input.task}` }),
	);

	const text = contentText(result);
	expect(text).toContain("Parallel: 2/2 succeeded");
	expect(text).toContain("OUT_a");
	expect(text).toContain("OUT_b");
});

test("chain steps wait as queued, not running, until dispatched", async () => {
	const { partialStatuses } = await run(threeSteps, (_input, index) => ({ text: `OUT_${index}` }));

	expect(partialStatuses[0]).toEqual(["queued", "queued", "queued"]);
	expect(partialStatuses).toContainEqual(["running", "queued", "queued"]);
	expect(partialStatuses).toContainEqual(["completed", "running", "queued"]);
	// A step that has not been dispatched never reads as running.
	for (const statuses of partialStatuses) {
		const running = statuses.indexOf("running");
		if (running !== -1) expect(statuses.slice(running + 1).every((status) => status === "queued")).toBe(true);
	}
});

test("parallel tasks beyond maxConcurrency wait as queued", async () => {
	const { partialStatuses } = await run(
		{
			tasks: [
				{ agent: "explore", task: "a" },
				{ agent: "explore", task: "b" },
			],
		} as SubagentParams,
		(input) => ({ text: `OUT_${input.task}` }),
		{ maxConcurrency: 1 },
	);

	expect(partialStatuses).toContainEqual(["running", "queued"]);
	expect(partialStatuses.at(-1)).toEqual(["completed", "completed"]);
});

test("parallel subagents wait for slots in the window shared with workflows", async () => {
	const workflow = acquireWorkflowAdmission(2);
	const held = [await workflow.semaphore.acquire(), await workflow.semaphore.acquire()];
	let started = 0;
	const running = run(
		{
			tasks: [
				{ agent: "explore", task: "a" },
				{ agent: "explore", task: "b" },
			],
		} as SubagentParams,
		(input) => {
			started++;
			return { text: `OUT_${input.task}` };
		},
	);
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(started).toBe(0);
	for (const release of held) release();
	const { result } = await running;
	expect(contentText(result)).toContain("Parallel: 2/2 succeeded");
	expect(started).toBe(2);
	workflow.release();
});

test("a 429 inside a parallel subagent lowers the shared window", async () => {
	const workflow = acquireWorkflowAdmission(4);
	await run({ tasks: [{ agent: "explore", task: "a" }] } as SubagentParams, (input) => {
		input.onModelRequest?.({ type: "started" });
		input.onModelRequest?.({ type: "rate_limit", attempt: 1, maxRetries: 3, delayMs: 0, message: "429" });
		return { text: "ok" };
	});
	expect(workflow.semaphore.max).toBe(3);
	workflow.release();
});

test("parallel subagents honor the configured provider concurrency limit", async () => {
	vi.stubEnv("STEP_WORKFLOW_CONCURRENCY_LIMIT", "1");
	const tasks = ["a", "b", "c"].map((task) => ({ agent: "explore", task }));
	const { result, peakActive } = await run({ tasks } as SubagentParams, () => ({ text: "ok" }), {
		runnerDelayMs: 10,
	});
	expect(contentText(result)).toContain("Parallel: 3/3 succeeded");
	expect(peakActive).toBe(1);

	vi.unstubAllEnvs();
	const unlimited = await run({ tasks } as SubagentParams, () => ({ text: "ok" }), { runnerDelayMs: 10 });
	expect(unlimited.peakActive).toBeGreaterThan(1);
});

test("admitted parallel subagents ask the runner to hold their slot until the child exits", async () => {
	const seen: Array<boolean | undefined> = [];
	await run({ tasks: [{ agent: "explore", task: "a" }] } as SubagentParams, (input) => {
		seen.push(input.awaitExit);
		return { text: "ok" };
	});
	await run({ agent: "explore", task: "single" } as SubagentParams, (input) => {
		seen.push(input.awaitExit);
		return { text: "ok" };
	});
	expect(seen).toEqual([true, undefined]);
});
