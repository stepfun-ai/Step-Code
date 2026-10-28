import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentToolResult } from "@step-harness/agent-core";
import {
	type Component,
	CURSOR_MARKER,
	type Terminal,
	TuiAltScreen,
	TuiMainScreen,
	visibleWidth,
} from "@step-harness/pi-tui";
import { type Model, validateToolArguments } from "@step-harness/providers";
import { expect, test } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
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
		registerMessageRenderer: () => {},
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

test("subagent rejects unknown fields and ignores an empty chain beside parallel tasks", async () => {
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

	// Fields outside the schema are rejected rather than silently dropped, so a
	// model that invents parameters gets a validation error it can correct.
	const staleCall = {
		agent: "",
		alias: "",
		chain: [],
		group: "",
		run_in_background: false,
		task: "",
		tasks: [
			{ agent: "general", task: "first inspection" },
			{ agent: "review", task: "second inspection" },
		],
	};
	expect(() => validateToolArguments(tool as never, { name: "subagent", arguments: staleCall } as never)).toThrow(
		/Validation failed/u,
	);
	const { alias: _alias, group: _group, ...currentCall } = staleCall;
	const validated = validateToolArguments(
		tool as never,
		{
			name: "subagent",
			arguments: currentCall,
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

async function openClarification(params: Record<string, unknown>, fullscreen = false) {
	const { api, tools } = createApi();
	createStepCapabilitiesExtension({ subagent: { includeBuiltinAgents: false } })(api);
	const ctx = createContext("/workspace");
	initTheme("step-blue");
	const terminal: Terminal = {
		columns: 80,
		rows: 40,
		kittyProtocolActive: false,
		start: () => {},
		stop: () => {},
		drainInput: async () => {},
		write: () => {},
		moveBy: () => {},
		hideCursor: () => {},
		showCursor: () => {},
		clearLine: () => {},
		clearFromCursor: () => {},
		clearScreen: () => {},
		setTitle: () => {},
		setProgress: () => {},
	};
	const tui = fullscreen ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
	const componentPromise = new Promise<Component>((resolveComponent, rejectComponent) => {
		ctx.ui.custom = async (factory) =>
			new Promise((resolve, reject) => {
				Promise.resolve(factory(tui, theme, new KeybindingsManager(), resolve)).then(
					(component) => {
						tui.addChild(component);
						resolveComponent(component);
					},
					(error: unknown) => {
						rejectComponent(error);
						reject(error);
					},
				);
			});
	});
	const result = tools.get("clarify_user")!.execute("ask", params, undefined, undefined, ctx);
	const component = await componentPromise;
	return {
		component,
		tui,
		result,
		close: async () => {
			// Escape first leaves custom-answer mode, then cancels the dialog.
			component.handleInput?.("\x1b");
			component.handleInput?.("\x1b");
			tui.setFocus(null);
			tui.removeChild(component);
			await result;
		},
	};
}

function answerCursor(component: Component, width = 80): { row: number; col: number } {
	const lines = component.render(width);
	const markerRows = lines.flatMap((line, row) => (line.includes(CURSOR_MARKER) ? [row] : []));
	expect(markerRows).toHaveLength(1);
	const row = markerRows[0]!;
	const answerLabelRow = lines.findIndex((line) => line.includes("Your answer:"));
	expect(answerLabelRow).toBeGreaterThanOrEqual(0);
	expect(row).toBeGreaterThan(answerLabelRow);
	return { row, col: visibleWidth(lines[row]!.split(CURSOR_MARKER)[0]!) };
}

test.each([false, true])(
	"clarify_user keeps the focused answer cursor at the typed position (fullscreen=%s)",
	async (fullscreen) => {
		const dialog = await openClarification({ question: "Describe the change" }, fullscreen);
		try {
			expect(dialog.component.render(80).join("\n")).not.toContain(CURSOR_MARKER);
			dialog.tui.setFocus(dialog.component);
			const start = answerCursor(dialog.component);
			for (const [index, char] of [..."中文abc"].entries()) {
				dialog.component.handleInput?.(char);
				const cursor = answerCursor(dialog.component);
				expect(cursor.row).toBe(start.row);
				expect(cursor.col).toBe(start.col + visibleWidth("中文abc".slice(0, index + 1)));
			}
			dialog.component.handleInput?.("\x1b[D");
			expect(answerCursor(dialog.component).col).toBe(start.col + 6);
			dialog.component.handleInput?.("\x7f");
			expect(answerCursor(dialog.component).col).toBe(start.col + 5);
			dialog.tui.setFocus(null);
			expect(dialog.component.render(80).join("\n")).not.toContain(CURSOR_MARKER);
			dialog.tui.setFocus(dialog.component);
			expect(answerCursor(dialog.component).col).toBe(start.col + 5);
		} finally {
			await dialog.close();
		}
	},
);

test("clarify_user recomputes answer wrapping when width changes without invalidation", async () => {
	const dialog = await openClarification({ question: "Describe the change" });
	try {
		dialog.tui.setFocus(dialog.component);
		dialog.component.handleInput?.("\x1b[200~abcdefghijklmnopqrstuvwx中文\x1b[201~");
		const wide = dialog.component.render(80);
		const narrow = dialog.component.render(20);
		expect(narrow).not.toBe(wide);
		expect(narrow.every((line) => visibleWidth(line) <= 20)).toBe(true);
		const narrowCursor = answerCursor(dialog.component, 20);
		expect(narrowCursor.col).toBeLessThan(20);
		expect(answerCursor(dialog.component, 80).col).toBe(29);
		expect(visibleWidth(dialog.component.render(80)[0]!)).toBe(80);
	} finally {
		await dialog.close();
	}
});

test("clarify_user only shows an answer cursor in freeform mode across question tabs", async () => {
	const dialog = await openClarification({
		questions: [
			{ id: "choice", question: "Choose", options: [{ label: "Option", value: "option" }] },
			{ id: "text", question: "Explain" },
		],
	});
	try {
		dialog.tui.setFocus(dialog.component);
		expect(dialog.component.render(80).join("\n")).not.toContain(CURSOR_MARKER);
		dialog.component.handleInput?.("2");
		answerCursor(dialog.component);
		dialog.component.handleInput?.("\x1b");
		expect(dialog.component.render(80).join("\n")).not.toContain(CURSOR_MARKER);
		dialog.component.handleInput?.("\t");
		const firstLine = answerCursor(dialog.component);
		dialog.component.handleInput?.("\x1b[13;2u");
		dialog.component.handleInput?.("second line");
		const multiline = answerCursor(dialog.component);
		expect(multiline.row).toBe(firstLine.row + 1);
		dialog.component.handleInput?.("\t");
		expect(dialog.component.render(80).join("\n")).not.toContain(CURSOR_MARKER);
		dialog.component.handleInput?.("\x1b[Z");
		answerCursor(dialog.component);
	} finally {
		await dialog.close();
	}
});
