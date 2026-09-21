import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentToolResult } from "@step-harness/agent-core";
import { afterEach, expect, test, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { registerWorkflowChildAcl, WORKFLOW_ACL_ENV } from "../src/features/workflow/acl-extension.ts";
import {
	createStepWorkflowExtension,
	resolveWorkflowScript,
	type WorkflowRequest,
} from "../src/features/workflow/step-workflow.ts";
import type { WorkflowAgentRunResult, WorkflowProgress, WorkflowRunResult } from "../src/features/workflow/types.ts";
import { isIsolatedVmAvailable } from "../src/features/workflow/vm.ts";
import type { StepTelemetryReporter } from "../src/step/telemetry.ts";

const cleanups: string[] = [];
const nativeWorkflowTest = test.skipIf(!isIsolatedVmAvailable());

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(cleanups.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function workspace(prefix = "step-workflow-extension-"): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), prefix));
	cleanups.push(directory);
	return directory;
}

function harness(): {
	api: ExtensionAPI;
	tools: Map<string, ToolDefinition>;
	commands: Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => unknown }>;
	notifications: string[];
} {
	const tools = new Map<string, ToolDefinition>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => unknown }>();
	const notifications: string[] = [];
	const api = {
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => unknown }) =>
			commands.set(name, command),
		on: () => {},
	} as unknown as ExtensionAPI;
	return { api, tools, commands, notifications };
}

function context(cwd: string, notifications: string[]): ExtensionCommandContext {
	return {
		cwd,
		mode: "tui",
		hasUI: true,
		signal: undefined,
		ui: { notify: (message: string) => notifications.push(message) },
		sessionManager: { getEntries: () => [], getSessionId: () => "workflow-test" },
	} as unknown as ExtensionCommandContext;
}

async function execute(
	tool: ToolDefinition,
	request: WorkflowRequest,
	cwd: string,
	notifications: string[],
): Promise<WorkflowRunResult> {
	const output = (await tool.execute(
		"workflow-call",
		request as never,
		undefined,
		undefined,
		context(cwd, notifications),
	)) as AgentToolResult<WorkflowRunResult>;
	return output.details!;
}

test("workflow extension registers by default and honors both off switches", () => {
	vi.stubEnv("STEP_ENABLE_WORKFLOW", "");
	vi.stubEnv("STEP_DISABLE_WORKFLOW", "");
	const registered = harness();
	createStepWorkflowExtension({
		vmExecutor: async () => ({ value: null, meta: {} }),
	})(registered.api);
	expect(registered.tools.has("workflow")).toBe(true);
	expect(registered.commands.has("workflows")).toBe(true);

	const optedOut = harness();
	createStepWorkflowExtension({
		enabled: false,
		vmExecutor: async () => ({ value: null, meta: {} }),
	})(optedOut.api);
	expect(optedOut.tools.has("workflow")).toBe(false);
	expect(optedOut.commands.has("workflows")).toBe(false);

	vi.stubEnv("STEP_DISABLE_WORKFLOW", "1");
	const envOff = harness();
	createStepWorkflowExtension({
		vmExecutor: async () => ({ value: null, meta: {} }),
	})(envOff.api);
	expect(envOff.tools.has("workflow")).toBe(false);
	expect(envOff.commands.has("workflows")).toBe(false);
});

test("child ACL hook blocks writes and emits redacted telemetry", async () => {
	const cwd = await workspace();
	vi.stubEnv(WORKFLOW_ACL_ENV, JSON.stringify({ baseCwd: cwd, readOnly: [cwd] }));
	let handler: ((event: { toolName: string; input: unknown }) => unknown) | undefined;
	const api = {
		on: (_event: string, callback: (event: never) => unknown) => {
			handler = callback as unknown as typeof handler;
		},
	} as unknown as ExtensionAPI;
	const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
	const telemetry: StepTelemetryReporter = {
		track: (event, properties) => {
			events.push({ event, properties: { ...properties } });
		},
	};

	expect(registerWorkflowChildAcl(api, telemetry)).toBe(true);
	const decision = await handler!({ toolName: "write_file", input: { path: path.join(cwd, "blocked.ts") } });
	expect(decision).toMatchObject({ block: true });
	expect(events).toEqual([
		{ event: "workflow_acl_blocked", properties: { operation: "write", reason_code: "tool_call" } },
	]);
});

nativeWorkflowTest("saved nested workflow executes once and a second nesting level is rejected", async () => {
	vi.stubEnv("STEP_DISABLE_WORKFLOW", "");
	const cwd = await workspace();
	const homeRoot = await workspace("step-workflow-home-");
	const saved = path.join(cwd, ".stepcode", "workflows", "saved");
	await mkdir(saved, { recursive: true });
	await writeFile(path.join(saved, "child.js"), "return { answer: args.value + 1 };\n");
	await writeFile(path.join(saved, "grandchild.js"), "return 'too deep';\n");
	const testHarness = harness();
	createStepWorkflowExtension({ enabled: true, homeRoot })(testHarness.api);
	const tool = testHarness.tools.get("workflow")!;

	const result = await execute(
		tool,
		{ script: 'return workflow("child", { value: 41 });' },
		cwd,
		testHarness.notifications,
	);
	expect(result).toMatchObject({ status: "completed", value: { answer: 42 } });

	await writeFile(path.join(saved, "child.js"), 'return workflow("grandchild");\n');
	await expect(execute(tool, { script: 'return workflow("child");' }, cwd, testHarness.notifications)).rejects.toThrow(
		"limited to one level",
	);
});

nativeWorkflowTest("saved workflow lookup prefers the project and /workflows reports runs", async () => {
	vi.stubEnv("STEP_DISABLE_WORKFLOW", "");
	const cwd = await workspace();
	const homeRoot = await workspace("step-workflow-home-");
	const projectSaved = path.join(cwd, ".stepcode", "workflows", "saved");
	const globalSaved = path.join(homeRoot, "workflows", "saved");
	await mkdir(projectSaved, { recursive: true });
	await mkdir(globalSaved, { recursive: true });
	await writeFile(path.join(projectSaved, "sample.js"), "return 'project';\n");
	await writeFile(path.join(globalSaved, "sample.js"), "return 'global';\n");

	const resolved = await resolveWorkflowScript(cwd, { name: "sample" }, homeRoot);
	expect(resolved).toMatchObject({ name: "sample", script: "return 'project';\n" });
	const testHarness = harness();
	createStepWorkflowExtension({ enabled: true, homeRoot })(testHarness.api);
	const run = await execute(testHarness.tools.get("workflow")!, { name: "sample" }, cwd, testHarness.notifications);
	expect(run.value).toBe("project");
	await testHarness.commands.get("workflows")!.handler("", context(cwd, testHarness.notifications));
	expect(testHarness.notifications.at(-1)).toContain("Saved workflows: sample");
	expect(testHarness.notifications.at(-1)).toContain("completed, 0/0 agents");
	expect(testHarness.notifications.at(-1)).toContain('prefix a message with "ultraloop:"');
	expect(testHarness.notifications.at(-1)).toContain("/ultraloop on");
});

test("workflow script resolution rejects ambiguous, oversized, and escaping sources", async () => {
	const cwd = await workspace();
	const outside = await workspace("step-workflow-outside-");
	const homeRoot = await workspace("step-workflow-home-");
	await writeFile(path.join(outside, "outside.js"), "return 'outside';\n");
	await symlink(path.join(outside, "outside.js"), path.join(cwd, "escape.js"));
	const saved = path.join(cwd, ".stepcode", "workflows", "saved");
	await mkdir(saved, { recursive: true });
	await symlink(path.join(outside, "outside.js"), path.join(saved, "escape.js"));

	await expect(resolveWorkflowScript(cwd, {}, homeRoot)).rejects.toThrow("exactly one");
	await expect(resolveWorkflowScript(cwd, { script: "return 1", name: "sample" }, homeRoot)).rejects.toThrow(
		"exactly one",
	);
	await expect(resolveWorkflowScript(cwd, { script: "x".repeat(128 * 1024 + 1) }, homeRoot)).rejects.toThrow(
		"exceeds",
	);
	await expect(resolveWorkflowScript(cwd, { scriptPath: "escape.js" }, homeRoot)).rejects.toThrow(
		"inside the working directory",
	);
	await expect(resolveWorkflowScript(cwd, { name: "escape" }, homeRoot)).rejects.toThrow("was not found");
});

test("the turn-state budget applies unless an explicit budget parameter overrides it", async () => {
	vi.stubEnv("STEP_DISABLE_WORKFLOW", "");
	const cwd = await workspace();
	const testHarness = harness();
	createStepWorkflowExtension({
		enabled: true,
		turnState: { budgetTotal: 123 },
		vmExecutor: async (_script, _args, vmHost) => {
			await vmHost.agent("consume", {});
			return { value: "done", meta: {} };
		},
		runner: async () => ({ text: "done", usage: { input: 100, output: 100 }, status: "completed" }),
	})(testHarness.api);
	const tool = testHarness.tools.get("workflow")!;

	await expect(execute(tool, { script: "return null" }, cwd, testHarness.notifications)).rejects.toThrow(
		/token budget exceeded/iu,
	);
	const overridden = await execute(tool, { script: "return null", budget: 1_000 }, cwd, testHarness.notifications);
	expect(overridden).toMatchObject({ status: "completed", value: "done", spentTokens: 200 });
});

test("the workflow result exposes the persisted script path for iteration", async () => {
	vi.stubEnv("STEP_DISABLE_WORKFLOW", "");
	const cwd = await workspace();
	const testHarness = harness();
	createStepWorkflowExtension({
		enabled: true,
		vmExecutor: async () => ({ value: 7, meta: {} }),
	})(testHarness.api);

	const result = await execute(
		testHarness.tools.get("workflow")!,
		{ script: "return 7" },
		cwd,
		testHarness.notifications,
	);
	expect(result.scriptPath).toBe(path.join(cwd, ".stepcode", "workflows", "runs", result.runId, "script.js"));
});

test("workflow rejects a missing resume run instead of silently starting over", async () => {
	vi.stubEnv("STEP_DISABLE_WORKFLOW", "");
	const cwd = await workspace();
	const testHarness = harness();
	createStepWorkflowExtension({
		enabled: true,
		vmExecutor: async () => ({ value: null, meta: {} }),
	})(testHarness.api);

	await expect(
		execute(
			testHarness.tools.get("workflow")!,
			{ script: "return null", resumeFromRunId: "missing" },
			cwd,
			testHarness.notifications,
		),
	).rejects.toThrow('Workflow resume run "missing" was not found');
});

test("workflow rejects a run directory without a journal", async () => {
	vi.stubEnv("STEP_DISABLE_WORKFLOW", "");
	const cwd = await workspace();
	const runDir = path.join(cwd, ".stepcode", "workflows", "runs", "wf_empty");
	await mkdir(runDir, { recursive: true });
	const testHarness = harness();
	createStepWorkflowExtension({
		enabled: true,
		vmExecutor: async () => ({ value: null, meta: {} }),
	})(testHarness.api);

	await expect(
		execute(
			testHarness.tools.get("workflow")!,
			{ script: "return null", resumeFromRunId: "wf_empty" },
			cwd,
			testHarness.notifications,
		),
	).rejects.toThrow('Workflow resume run "wf_empty" was not found');
});

test("workflow rejects a resume directory that escapes the project", async () => {
	vi.stubEnv("STEP_DISABLE_WORKFLOW", "");
	const cwd = await workspace();
	const outside = await workspace("step-workflow-resume-outside-");
	const runsRoot = path.join(cwd, ".stepcode", "workflows", "runs");
	await mkdir(runsRoot, { recursive: true });
	await symlink(outside, path.join(runsRoot, "escape"));
	const testHarness = harness();
	createStepWorkflowExtension({
		enabled: true,
		vmExecutor: async () => ({ value: null, meta: {} }),
	})(testHarness.api);

	await expect(
		execute(
			testHarness.tools.get("workflow")!,
			{ script: "return null", resumeFromRunId: "escape" },
			cwd,
			testHarness.notifications,
		),
	).rejects.toThrow('Workflow resume run "escape" was not found');
});

test("workflow rejects a symlinked project workflow root", async () => {
	vi.stubEnv("STEP_DISABLE_WORKFLOW", "");
	const cwd = await workspace();
	const outside = await workspace("step-workflow-saved-outside-");
	const workflowRoot = path.join(cwd, ".stepcode", "workflows");
	await mkdir(path.dirname(workflowRoot), { recursive: true });
	await symlink(outside, workflowRoot);
	const testHarness = harness();
	createStepWorkflowExtension({
		enabled: true,
		vmExecutor: async () => ({ value: null, meta: {} }),
	})(testHarness.api);

	await expect(
		execute(testHarness.tools.get("workflow")!, { script: "return null" }, cwd, testHarness.notifications),
	).rejects.toThrow("Workflow run root must stay inside");
});

test("workflow never starts agents after its tool signal was already aborted", async () => {
	const cwd = await workspace();
	const testHarness = harness();
	const runner = vi.fn(async () => ({ text: "unexpected", status: "completed" as const }));
	createStepWorkflowExtension({
		enabled: true,
		runner,
		vmExecutor: async (_script, _args, host) => ({ value: await host.agent("work", {}), meta: {} }),
	})(testHarness.api);
	const controller = new AbortController();
	controller.abort();

	await expect(
		testHarness.tools
			.get("workflow")!
			.execute(
				"cancelled-workflow",
				{ script: "return agent('work')" },
				controller.signal,
				undefined,
				context(cwd, testHarness.notifications),
			),
	).rejects.toThrow(/aborted/iu);
	expect(runner).not.toHaveBeenCalled();
});

test("workflow streams task counts and transitions while agents are still running", async () => {
	const cwd = await workspace();
	const testHarness = harness();
	const updates: AgentToolResult<WorkflowProgress>[] = [];
	const pending = new Map<string, (result: WorkflowAgentRunResult) => void>();
	createStepWorkflowExtension({
		enabled: true,
		maxConcurrency: 2,
		runner: ({ prompt }) => new Promise((resolve) => pending.set(prompt, resolve)),
		vmExecutor: async (_script, _args, host) => {
			host.phase("Review");
			host.log("Checking three subsystems");
			const value = await Promise.all([
				host.agent("Inspect authentication", { label: "Security" }),
				host.agent("Review rendering\n\tand redraws", {}),
				host.agent("Check scheduler", { label: "Scheduling" }),
			]);
			return { value, meta: {} };
		},
	})(testHarness.api);
	const execution = testHarness.tools
		.get("workflow")!
		.execute(
			"live-workflow",
			{ script: "three tasks" },
			undefined,
			(update) => updates.push(update as AgentToolResult<WorkflowProgress>),
			context(cwd, testHarness.notifications),
		);
	let settled = false;
	void execution.then(() => {
		settled = true;
	});
	try {
		await vi.waitFor(() => expect(pending.size).toBe(2));
		expect(settled).toBe(false);
		const live = updates.at(-1)?.details;
		expect(live).toMatchObject({
			status: "running",
			currentPhase: "Review",
			message: "Checking three subsystems",
			totalAgents: 3,
			completedAgents: 0,
		});
		expect(live?.agents).toMatchObject([
			{ label: "Security", task: "Inspect authentication", status: "running" },
			{ label: "Review rendering and redraws", status: "running" },
			{ label: "Scheduling", status: "queued" },
		]);
		const firstSnapshot = live;
		pending.get("Inspect authentication")!({ value: "safe", usage: { input: 2, output: 1 } });
		await vi.waitFor(() => expect(pending.size).toBe(3));
		expect(settled).toBe(false);
		expect(updates.at(-1)?.details).toMatchObject({ completedAgents: 1, spentTokens: 3 });
		expect(updates.at(-1)?.details?.agents.map((agent) => agent.status)).toEqual(["completed", "running", "running"]);
		expect(firstSnapshot?.completedAgents).toBe(0);
		expect(firstSnapshot?.agents[0]?.status).toBe("running");
	} finally {
		// Always drain the injected runners, even when the live assertions fail.
		for (const resolve of pending.values()) resolve({ value: "done" });
		await vi.waitFor(() => expect(pending.size).toBe(3));
		pending.get("Check scheduler")!({ value: "done" });
		await execution;
	}
	expect(updates.at(-1)?.details).toMatchObject({ status: "completed", completedAgents: 3, totalAgents: 3 });
	const finalResult = await execution;
	expect(finalResult.details).toMatchObject({ status: "completed", agentCalls: 3 });
	expect(finalResult.details).not.toHaveProperty("agents");
});

test("workflow streams cancellation for both running and queued agents", async () => {
	const cwd = await workspace();
	const testHarness = harness();
	const controller = new AbortController();
	const updates: WorkflowProgress[] = [];
	let started = false;
	createStepWorkflowExtension({
		enabled: true,
		maxConcurrency: 1,
		runner: ({ signal }) =>
			new Promise((_resolve, reject) => {
				started = true;
				signal!.addEventListener("abort", () => reject(new Error("cancelled by user")), { once: true });
			}),
		vmExecutor: async (_script, _args, host) => {
			await Promise.allSettled([host.agent("Running task", {}), host.agent("Queued task", {})]);
			return { value: null, meta: {} };
		},
	})(testHarness.api);
	const execution = testHarness.tools
		.get("workflow")!
		.execute(
			"cancel-live-workflow",
			{ script: "cancel tasks" },
			controller.signal,
			(update) => updates.push(update.details as WorkflowProgress),
			context(cwd, testHarness.notifications),
		);
	const rejected = expect(execution).rejects.toThrow(/aborted/iu);
	try {
		await vi.waitFor(() => expect(started).toBe(true));
		expect(updates.at(-1)?.agents.map((agent) => agent.status)).toEqual(["running", "queued"]);
	} finally {
		controller.abort();
		await rejected;
	}
	expect(updates.at(-1)).toMatchObject({ status: "aborted", totalAgents: 2 });
	expect(updates.at(-1)?.agents.map((agent) => agent.status)).toEqual(["aborted", "aborted"]);
});

test("workflow streams budget failures for tasks that never acquire a runnable slot", async () => {
	const cwd = await workspace();
	const testHarness = harness();
	const updates: WorkflowProgress[] = [];
	const runner = vi.fn(async () => ({ value: "done", usage: { input: 1 } }));
	createStepWorkflowExtension({
		enabled: true,
		maxConcurrency: 1,
		budgetTotal: 1,
		runner,
		vmExecutor: async (_script, _args, host) => {
			await Promise.allSettled([host.agent("First task", {}), host.agent("Unaffordable task", {})]);
			return { value: null, meta: {} };
		},
	})(testHarness.api);
	await expect(
		testHarness.tools
			.get("workflow")!
			.execute(
				"budget-live-workflow",
				{ script: "budget tasks" },
				undefined,
				(update) => updates.push(update.details as WorkflowProgress),
				context(cwd, testHarness.notifications),
			),
	).rejects.toThrow(/budget exhausted/iu);
	expect(runner).toHaveBeenCalledTimes(1);
	expect(updates.at(-1)).toMatchObject({ status: "budget_exceeded", completedAgents: 1, totalAgents: 2 });
	expect(updates.at(-1)?.agents).toMatchObject([
		{ label: "First task", status: "completed" },
		{ label: "Unaffordable task", status: "failed" },
	]);
	expect(updates.at(-1)?.agents[1]?.startedAt).toBeUndefined();
});

test("workflow replay reports cached tasks without launching agents or charging tokens again", async () => {
	const cwd = await workspace();
	const testHarness = harness();
	const updates: WorkflowProgress[] = [];
	const runner = vi.fn(async () => ({ value: "reviewed", usage: { input: 5 } }));
	createStepWorkflowExtension({
		enabled: true,
		runner,
		vmExecutor: async (_script, _args, host) => ({ value: await host.agent("Review authentication", {}), meta: {} }),
	})(testHarness.api);
	const tool = testHarness.tools.get("workflow")!;
	const original = await execute(tool, { script: "review" }, cwd, testHarness.notifications);
	const replay = await tool.execute(
		"replay-workflow",
		{ script: "review", resumeFromRunId: original.runId },
		undefined,
		(update) => updates.push(update.details as WorkflowProgress),
		context(cwd, testHarness.notifications),
	);
	expect(runner).toHaveBeenCalledTimes(1);
	expect(updates.at(-1)).toMatchObject({ status: "completed", completedAgents: 1, totalAgents: 1, spentTokens: 0 });
	expect(updates.at(-1)?.agents).toMatchObject([{ label: "Review authentication", status: "cached" }]);
	expect(replay.details).toMatchObject({ status: "completed", cacheHits: 1, spentTokens: 0, value: "reviewed" });
});
