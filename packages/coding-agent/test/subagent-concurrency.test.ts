import os from "node:os";
import type { AgentToolResult } from "@step-harness/agent-core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import type {
	StepSubagentDetails,
	StepSubagentExtensionOptions,
	StepSubagentRunResult,
	SubagentParams,
} from "../src/features/step-subagent.ts";
import { executeSubagent } from "../src/features/subagent/execute.ts";
import { resetWorkflowAdmission } from "../src/features/workflow/admission.ts";

beforeEach(() => {
	// A 2-CPU host: the old CPU-derived default clamped parallel batches to
	// max(1, min(16, 2 - 2)) = 1 child, so these tests prove the batch now runs
	// at the plain default and any configured value regardless of host CPUs.
	vi.spyOn(os, "cpus").mockReturnValue(Array(2).fill(os.cpus()[0]!));
	vi.stubEnv("STEP_WORKFLOW_CONCURRENCY_LIMIT", "");
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	resetWorkflowAdmission();
});

function okResult(text: string): StepSubagentRunResult {
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
		stopReason: "stop",
		usage: { input: 1, output: 2, cost: 0, contextTokens: 3, turns: 1 },
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

function baseOptions(overrides: Partial<StepSubagentExtensionOptions> = {}): StepSubagentExtensionOptions {
	return {
		agentDir: "/tmp/step-agent-test",
		configDirName: ".step",
		includeBuiltinAgents: true,
		...overrides,
	};
}

/**
 * Run a parallel batch of `tasks` tasks and return the observed peak number of
 * concurrently active children. Every runner blocks until the expected peak is
 * reached (or a timeout fires), so the peak is observed deterministically
 * instead of depending on runner timing.
 */
async function peakConcurrency(tasks: number, expected: number, options: StepSubagentExtensionOptions) {
	let active = 0;
	let peak = 0;
	let release!: () => void;
	const saturated = new Promise<void>((resolve) => {
		release = resolve;
	});
	const result: AgentToolResult<StepSubagentDetails> = await executeSubagent(
		{
			tasks: Array.from({ length: tasks }, (_unused, index) => ({ agent: "general", task: `task-${index}` })),
		} as SubagentParams,
		undefined,
		() => {},
		ctx,
		{
			...baseOptions(options),
			// Keep a caller-provided batch cap; the default must not swallow it.
			maxParallelTasks: options.maxParallelTasks ?? Math.max(1_000, tasks),
			worktreeManager: { allocate: async () => Promise.reject(new Error("no worktrees in this test")) },
			runner: async (input) => {
				active += 1;
				peak = Math.max(peak, active);
				if (active >= expected) release();
				await Promise.race([saturated, new Promise((resolve) => setTimeout(resolve, 250))]);
				active -= 1;
				return okResult(input.task);
			},
		} as Parameters<typeof executeSubagent>[4],
	);
	return { peak, result };
}

test("a parallel batch runs at the default of 8 regardless of host CPUs", async () => {
	const { peak, result } = await peakConcurrency(8, 8, {});
	expect(peak).toBe(8);
	expect(result.details?.results.every((record) => record.status === "completed")).toBe(true);
});

test("a configured max_concurrency above the default raises the ceiling", async () => {
	const { peak } = await peakConcurrency(12, 12, {
		maxConcurrencySettings: () => ({ maxConcurrency: 12 }),
	});
	expect(peak).toBe(12);
});

test("the workflow provider-limit env var no longer caps a subagent batch", async () => {
	vi.stubEnv("STEP_WORKFLOW_CONCURRENCY_LIMIT", "2");
	const { peak } = await peakConcurrency(8, 8, {});
	expect(peak).toBe(8);
});

test("a configured value overrides the host option", async () => {
	const { peak } = await peakConcurrency(6, 6, {
		maxConcurrency: 2,
		maxConcurrencySettings: () => ({ maxConcurrency: 6 }),
	});
	expect(peak).toBe(6);
});

test("maxParallelTasks still rejects an oversized batch before any child starts", async () => {
	const { peak, result } = await peakConcurrency(5, 5, { maxParallelTasks: 4 });
	expect(peak).toBe(0);
	const text = (result.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("");
	expect(text).toContain("Too many parallel tasks (5); maximum is 4");
});

test("tasks beyond the ceiling queue instead of running", async () => {
	const { peak } = await peakConcurrency(5, 2, { maxConcurrency: 2 });
	expect(peak).toBe(2);
});
