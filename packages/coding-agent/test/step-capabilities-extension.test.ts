import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentToolResult } from "@step-harness/agent-core";
import { type Model, validateToolArguments } from "@step-harness/providers";
import { expect, test } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { createStepCapabilitiesExtension } from "../src/features/step-capabilities.ts";
import { createStepPlanExtension } from "../src/features/step-plan.ts";
import {
	createStepSubagentExtension,
	type StepSubagentRunResult,
	type StepWorktreeLease,
} from "../src/features/step-subagent.ts";
import { discoverStepAgents } from "../src/features/step-subagent-agents.ts";
import type { StepTelemetryEventName, StepTelemetryProperties } from "../src/step/telemetry.ts";
import { initTheme, theme } from "../src/theme/theme.ts";

function agentFile(name: string, description: string, body = "Do the task."): string {
	return `---\nname: ${name}\ndescription: ${description}\ntools: read_file, find_files\n---\n${body}\n`;
}

function textResult(value: string): StepSubagentRunResult {
	return {
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text: value }],
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
		usage: {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 3,
			turns: 1,
		},
		model: "step/step-3.7-flash",
		stopReason: "stop",
	};
}

function createApi(): {
	api: ExtensionAPI;
	tools: Map<string, ToolDefinition>;
	commands: Map<string, { handler: (args: string, ctx: ExtensionContext) => unknown }>;
	activeTools: () => string[];
	setActiveTools: (names: string[]) => void;
	emit: (event: { type: string } & Record<string, unknown>, ctx: ExtensionContext) => Promise<unknown>;
} {
	const tools = new Map<string, ToolDefinition>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => unknown }>();
	const handlers = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
	let active = ["read_file", "find_files", "search_files", "list_directory", "run_command", "write_file", "edit_file"];
	const api = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => unknown }) {
			commands.set(name, command);
		},
		registerFlag: () => {},
		registerShortcut: () => {},
		on(event: string, handler: (event: never, ctx: ExtensionContext) => unknown) {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active = [...names];
		},
		getFlag: () => false,
		appendEntry: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
	} as unknown as ExtensionAPI;
	return {
		api,
		tools,
		commands,
		activeTools: () => [...active],
		setActiveTools: (names) => {
			active = [...names];
		},
		emit: async (event, ctx) => {
			// Mirror ExtensionRunner semantics: a block result short-circuits and
			// handlers returning undefined do not clobber an earlier result.
			let last: unknown;
			for (const handler of handlers.get(event.type) ?? []) {
				const result = await handler(event as never, ctx);
				if (result !== undefined && result !== null) {
					last = result;
					if (event.type === "tool_call" && (result as { block?: boolean }).block) return result;
				}
			}
			return last;
		},
	};
}

function createContext(cwd: string, model?: Model<string>): ExtensionContext {
	return {
		mode: "tui",
		hasUI: true,
		cwd,
		model,
		thinkingLevel: "high",
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		getSystemPrompt: () => "",
		ui: {
			theme: {
				fg: (_name: string, value: string) => value,
				bold: (value: string) => value,
			},
			select: async () => undefined,
			confirm: async () => true,
			input: async () => undefined,
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			onTerminalInput: () => () => {},
			setWorkingMessage: () => {},
			setWorkingVisible: () => {},
			setWorkingIndicator: () => {},
			setHiddenThinkingLabel: () => {},
			setFooter: () => {},
			setHeader: () => {},
			setTitle: () => {},
			pasteToEditor: () => {},
			setEditorText: () => {},
			getEditorText: () => "",
			editor: async () => undefined,
			addAutocompleteProvider: () => {},
			setEditorComponent: () => {},
			getEditorComponent: () => undefined,
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: true }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		},
		sessionManager: { getEntries: () => [], getSessionId: () => "test-session" },
		modelRegistry: {} as never,
		scopedModels: [],
	} as unknown as ExtensionContext;
}

test("Step agent discovery uses .stepcode project paths and project precedence", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "step-agent-discovery-"));
	try {
		const agentDir = path.join(root, "global-agent");
		const projectAgents = path.join(root, ".stepcode", "agents");
		await mkdir(path.join(agentDir, "agents"), { recursive: true });
		await mkdir(projectAgents, { recursive: true });
		await writeFile(path.join(agentDir, "review.md"), agentFile("review", "global review"));
		await writeFile(path.join(projectAgents, "review.md"), agentFile("review", "project review"));
		const result = await discoverStepAgents(root, {
			agentDir,
			configDirName: ".stepcode",
			scope: "both",
			includeBuiltin: false,
		});
		expect(result.projectAgentsDir).toBe(projectAgents);
		expect(result.userAgentsDir).toBe(path.join(agentDir, "agents"));
		expect(result.agents).toHaveLength(1);
		expect(result.agents[0]).toMatchObject({
			name: "review",
			description: "project review",
			source: "project",
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Step capabilities register native plan, clarify_user, and subagent tools", () => {
	const { api, tools, commands } = createApi();
	createStepCapabilitiesExtension({
		subagent: { includeBuiltinAgents: false, agentDir: "/tmp/step-agent-test" },
	})(api);
	expect([...tools.keys()]).toEqual(expect.arrayContaining(["subagent", "clarify_user"]));
	expect([...tools.keys()]).toEqual(
		expect.arrayContaining([
			"enter_plan_mode",
			"exit_plan_mode",
			"task_create",
			"task_update",
			"task_get",
			"task_list",
		]),
	);
	expect(tools.has("askuser")).toBe(false);
	expect(tools.has("questionnaire")).toBe(false);
	expect([...commands.keys()]).toEqual(expect.arrayContaining(["plan", "todos"]));
});

test("subagent follows the Pi schema and ignores an empty chain beside parallel tasks", async () => {
	const { api, tools } = createApi();
	const calls: string[] = [];
	createStepSubagentExtension({
		includeBuiltinAgents: true,
		runner: async (input) => {
			calls.push(input.task);
			return textResult(input.task);
		},
	})(api);

	const tool = tools.get("subagent");
	expect(tool).toBeDefined();
	const schema = tool!.parameters as {
		required?: readonly string[];
		properties?: Record<string, unknown>;
	};
	expect(schema.required ?? []).toEqual([]);
	expect(schema.properties).toHaveProperty("agent");
	expect(schema.properties).toHaveProperty("task");
	expect(schema.properties).toHaveProperty("tasks");
	expect(schema.properties).toHaveProperty("chain");
	expect(schema.properties).toHaveProperty("agentScope");
	expect(tool!.prepareArguments).toBeUndefined();

	const staleCall = {
		agent: "",
		agent_type: "",
		alias: "",
		chain: [],
		context_mode: "fresh",
		description: "",
		group: "",
		isolate_workspace: false,
		model: "",
		prompt: "",
		run_in_background: false,
		task: "",
		tasks: [
			{ agent: "general", task: "first inspection" },
			{ agent: "review", task: "second inspection" },
		],
		worktree_name: "",
	};
	const validated = validateToolArguments(
		tool as never,
		{
			name: "subagent",
			arguments: staleCall,
		} as never,
	);
	const result = (await tool!.execute(
		"call",
		validated,
		undefined,
		undefined,
		createContext("/workspace"),
	)) as AgentToolResult<{ mode?: string }>;
	expect(result.details?.mode).toBe("parallel");
	expect(calls).toEqual(["first inspection", "second inspection"]);
});

test("Step capability adapters report clarification, plan, and subagent telemetry", async () => {
	const { api, tools, emit } = createApi();
	const events: Array<{
		event: StepTelemetryEventName;
		properties: StepTelemetryProperties;
	}> = [];
	const telemetry = {
		track: (event: StepTelemetryEventName, properties: StepTelemetryProperties) => {
			events.push({ event, properties });
		},
	};
	createStepCapabilitiesExtension({
		telemetry,
		subagent: {
			includeBuiltinAgents: true,
			runner: async () => textResult("done"),
		},
	})(api);

	const context = createContext("/workspace");
	context.ui.input = async () => "freeform answer";
	await tools.get("clarify_user")!.execute("ask", { question: "Question" }, undefined, undefined, context);
	const clarifyUser = tools.get("clarify_user")!;
	context.ui.select = async () => "Option";
	await clarifyUser.execute(
		"clarify_user",
		{
			questions: [
				{
					id: "q1",
					question: "Choose",
					options: [{ value: "option", label: "Option" }],
				},
			],
		},
		undefined,
		undefined,
		context,
	);

	const planContext = createContext("/workspace");
	await emit(
		{
			type: "agent_end",
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "Plan:\n1. Inspect the repository" }],
				},
			],
		},
		planContext,
	);

	const subagent = tools.get("subagent")!;
	await subagent.execute(
		"subagent",
		{ agent: "general", task: "Inspect the repository" },
		undefined,
		undefined,
		context,
	);

	expect(events.map((entry) => entry.event)).toEqual([
		"clarification_resolved",
		"clarification_resolved",
		"subagent_task_created",
		"subagent_task_finished",
	]);
	expect(events[0]?.properties).toMatchObject({
		outcome: "freeform",
		option_count: 0,
	});
	expect(events[1]?.properties).toMatchObject({
		outcome: "option",
		option_count: 1,
	});
	expect(events[2]?.properties).toMatchObject({
		execution: "blocking",
		agent_type: "general",
	});
	expect(events[3]?.properties).toMatchObject({
		execution: "blocking",
		status: "completed",
	});
});

test("parallel subagents inherit the current model and receive isolated worktree paths", async () => {
	const { api, tools } = createApi();
	const calls: Array<{ name: string; cwd: string; model?: string }> = [];
	const leases: StepWorktreeLease[] = [];
	const extension = createStepSubagentExtension({
		agentDir: "/tmp/step-agent-test",
		includeBuiltinAgents: true,
		worktreeManager: {
			allocate: async (_cwd, label) => {
				const lease: StepWorktreeLease = {
					path: `/tmp/worktree/${label}`,
					branch: `step-agent/${label}`,
					cleanup: async () => {},
				};
				leases.push(lease);
				return lease;
			},
		},
		runner: async (input) => {
			calls.push({
				name: input.agent.name,
				cwd: input.cwd,
				model: input.model,
			});
			return textResult(`${input.agent.name} complete`);
		},
	});
	extension(api);
	const tool = tools.get("subagent");
	expect(tool).toBeDefined();
	const context = createContext("/workspace", {
		provider: "step",
		id: "step-3.7-flash",
		api: "anthropic-messages",
		name: "Step",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	} as Model<"anthropic-messages">);
	const result = await tool!.execute(
		"call",
		{
			tasks: [
				{ agent: "review", task: "review one", isolateWorkspace: true },
				{ agent: "planner", task: "plan two", isolateWorkspace: true },
			],
		},
		undefined,
		undefined,
		context,
	);
	expect(calls).toHaveLength(2);
	expect(calls.every((call) => call.model === "step/step-3.7-flash")).toBe(true);
	expect(calls.map((call) => call.cwd)).toEqual(
		expect.arrayContaining(["/tmp/worktree/review", "/tmp/worktree/planner"]),
	);
	expect(leases).toHaveLength(2);
	expect((result as AgentToolResult<unknown>).content[0]).toMatchObject({
		type: "text",
	});
	expect(
		(result as AgentToolResult<{ results: Array<{ worktreePath?: string }> }>).details.results.every(
			(item) => item.worktreePath,
		),
	).toBe(true);

	initTheme("step-blue");
	const collapsed = tool!.renderResult!(result, { expanded: false, isPartial: false }, theme, {} as never);
	expect(collapsed.render(100).join("\n")).toContain("worktree:");
	const expanded = tool!.renderResult!(result, { expanded: true, isPartial: false }, theme, {} as never);
	expect(expanded.render(100).join("\n")).toContain("Branch:");
});

test("plan adapter uses Step tool names and leaves run_command unrestricted", async () => {
	const { api, activeTools, commands, emit } = createApi();
	createStepPlanExtension()(api);
	const ctx = createContext("/workspace");
	await commands.get("plan")!.handler("", ctx);
	expect(activeTools()).toContain("run_command");
	// Aligned with Claude Code: plan mode no longer whitelists commands.
	await expect(
		emit(
			{
				type: "tool_call",
				toolName: "run_command",
				toolCallId: "tool-1",
				input: { command: "rm -rf build" },
			},
			ctx,
		),
	).resolves.toBeUndefined();
	// File mutations outside the session plan file remain blocked.
	await expect(
		emit(
			{
				type: "tool_call",
				toolName: "write_file",
				toolCallId: "tool-2",
				input: { path: "src/main.ts", content: "" },
			},
			ctx,
		),
	).resolves.toMatchObject({ block: true });
});
