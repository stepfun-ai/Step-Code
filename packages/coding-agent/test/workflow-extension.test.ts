import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { afterEach, expect, test, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { registerWorkflowChildAcl, WORKFLOW_ACL_ENV } from "../src/features/workflow/acl-extension.ts";
import {
	createStepWorkflowExtension,
	resolveWorkflowScript,
	type WorkflowRequest,
} from "../src/features/workflow/step-workflow.ts";
import type { WorkflowRunResult } from "../src/features/workflow/types.ts";
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

test("workflow extension is disabled by default and registers only when enabled", () => {
	vi.stubEnv("STEP_ENABLE_WORKFLOW", "");
	vi.stubEnv("STEP_DISABLE_WORKFLOW", "");
	const disabled = harness();
	createStepWorkflowExtension({
		vmExecutor: async () => ({ value: null, meta: {} }),
	})(disabled.api);
	expect(disabled.tools.has("workflow")).toBe(false);
	expect(disabled.commands.has("workflows")).toBe(false);

	const enabled = harness();
	createStepWorkflowExtension({
		enabled: true,
		vmExecutor: async () => ({ value: null, meta: {} }),
	})(enabled.api);
	expect(enabled.tools.has("workflow")).toBe(true);
	expect(enabled.commands.has("workflows")).toBe(true);
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
	const saved = path.join(cwd, ".step-cli", "workflows", "saved");
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
	const projectSaved = path.join(cwd, ".step-cli", "workflows", "saved");
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
	const saved = path.join(cwd, ".step-cli", "workflows", "saved");
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
	const runDir = path.join(cwd, ".step-cli", "workflows", "runs", "wf_empty");
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
	const runsRoot = path.join(cwd, ".step-cli", "workflows", "runs");
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
	const workflowRoot = path.join(cwd, ".step-cli", "workflows");
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
