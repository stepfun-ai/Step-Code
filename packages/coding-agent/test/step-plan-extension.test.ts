import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { createStepPlanExtension } from "../src/extensions/step-plan.ts";
import { createStepTasksExtension, type StepTask } from "../src/extensions/step-tasks.ts";
import type { StepTelemetryReporter } from "../src/step/telemetry.ts";

interface SessionEntryStub {
	type: string;
	customType: string;
	data?: unknown;
}

interface Harness {
	api: ExtensionAPI;
	tools: Map<string, ToolDefinition>;
	commands: Map<string, { handler: (args: string, ctx: ExtensionContext) => unknown }>;
	handlerEvents: () => string[];
	appended: Array<{ customType: string; data: unknown }>;
	notifications: Array<{ message: string; type?: string }>;
	statuses: Map<string, string | undefined>;
	activeTools: () => string[];
	emit: (event: { type: string } & Record<string, unknown>, ctx: ExtensionContext) => Promise<unknown>;
	ctx: (overrides?: Record<string, unknown>) => ExtensionContext;
}

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function makeWorkspace(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "step-plan-test-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function createHarness(
	options: {
		entries?: SessionEntryStub[];
		cwd?: string;
		flags?: Record<string, boolean | string>;
		select?: () => Promise<string | undefined>;
	} = {},
): Harness {
	const tools = new Map<string, ToolDefinition>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => unknown }>();
	const handlers = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
	const appended: Array<{ customType: string; data: unknown }> = [];
	const sessionEntries: SessionEntryStub[] = [...(options.entries ?? [])];
	const notifications: Array<{ message: string; type?: string }> = [];
	const statuses = new Map<string, string | undefined>();
	const cwd = options.cwd ?? "/workspace";
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
		getFlag: (name: string) => options.flags?.[name] ?? false,
		appendEntry: (customType: string, data: unknown) => {
			appended.push({ customType, data: structuredClone(data) });
			// Mirror the real session manager: appended custom entries become
			// visible through sessionManager.getEntries() immediately.
			sessionEntries.push({ type: "custom", customType, data: structuredClone(data) });
		},
		sendMessage: () => {},
		sendUserMessage: () => {},
		events: createEventBus(),
	} as unknown as ExtensionAPI;

	const ctx = (overrides: Record<string, unknown> = {}): ExtensionContext =>
		({
			mode: "tui",
			hasUI: true,
			cwd,
			isIdle: () => true,
			hasPendingMessages: () => false,
			ui: {
				notify: (message: string, type?: string) => {
					notifications.push({ message, type });
				},
				select: options.select ?? (async () => undefined),
				editor: async () => undefined,
				setStatus: (key: string, text: string | undefined) => {
					statuses.set(key, text);
				},
				setWidget: () => {},
				theme: { fg: (_color: string, text: string) => text },
			},
			sessionManager: { getEntries: () => sessionEntries, getSessionId: () => "sess-1" },
			...overrides,
		}) as unknown as ExtensionContext;

	return {
		api,
		tools,
		commands,
		handlerEvents: () => [...handlers.keys()],
		appended,
		notifications,
		statuses,
		activeTools: () => [...active],
		emit: async (event, context) => {
			// Mirror ExtensionRunner semantics: handlers run in registration order,
			// a block result short-circuits, undefined does not clobber a result.
			let last: unknown;
			for (const handler of handlers.get(event.type) ?? []) {
				const result = await handler(event as never, context);
				if (result !== undefined && result !== null) {
					last = result;
					if (event.type === "tool_call" && (result as { block?: boolean }).block) return result;
				}
			}
			return last;
		},
		ctx,
	};
}

async function runTool(harness: Harness, name: string, params: unknown, ctx: ExtensionContext): Promise<unknown> {
	const tool = harness.tools.get(name);
	expect(tool, `tool ${name} is registered`).toBeDefined();
	return await tool!.execute(`${name}-call`, params as never, undefined, undefined, ctx);
}

function lastPlanEntry(harness: Harness): Record<string, unknown> {
	const entry = harness.appended.filter((candidate) => candidate.customType === "step-plan").at(-1);
	expect(entry, "a step-plan entry was persisted").toBeDefined();
	return entry!.data as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Legacy hidden-meta scrubbing
// ---------------------------------------------------------------------------

test("plan extension no longer injects hidden meta and scrubs the persisted legacy ones", async () => {
	const harness = createHarness();
	createStepPlanExtension()(harness.api);

	// The per-turn injection and the text-mining hooks are gone.
	expect(harness.handlerEvents()).not.toContain("before_agent_start");
	expect(harness.handlerEvents()).not.toContain("turn_end");
	expect(harness.handlerEvents()).not.toContain("agent_end");

	// Old sessions still carry the injected messages; the context hook drops them.
	const context = harness.ctx();
	const result = (await harness.emit(
		{
			type: "context",
			messages: [
				{ role: "user", content: "hello" },
				{ role: "user", customType: "step-plan-context", content: "[STEP PLAN MODE ACTIVE]" },
				{ role: "user", customType: "step-plan-execution-context", content: "[STEP PLAN EXECUTION]" },
			],
		},
		context,
	)) as { messages: Array<Record<string, unknown>> };
	expect(result.messages).toHaveLength(1);
	expect(result.messages[0]).toMatchObject({ content: "hello" });
});

test("run_command is not gated in plan mode; non-plan-file mutations still are", async () => {
	const cwd = makeWorkspace();
	const harness = createHarness({ cwd });
	createStepPlanExtension()(harness.api);
	const context = harness.ctx();
	await runTool(harness, "enter_plan_mode", {}, context);

	await expect(
		harness.emit(
			{ type: "tool_call", toolName: "run_command", toolCallId: "t1", input: { command: "rm -rf build" } },
			context,
		),
	).resolves.toBeUndefined();

	await expect(
		harness.emit(
			{ type: "tool_call", toolName: "write_file", toolCallId: "t2", input: { path: "src/app.ts", content: "" } },
			context,
		),
	).resolves.toMatchObject({ block: true });

	const planPath = path.join(cwd, ".step-cli", "plans", "session-sess-1.md");
	await expect(
		harness.emit(
			{ type: "tool_call", toolName: "write_file", toolCallId: "t3", input: { path: planPath, content: "# plan" } },
			context,
		),
	).resolves.toBeUndefined();
});

// ---------------------------------------------------------------------------
// planSource
// ---------------------------------------------------------------------------

test("planSource is user for /plan, agent for enter_plan_mode, and cleared on exit", async () => {
	const cwd = makeWorkspace();
	const harness = createHarness({ cwd });
	createStepPlanExtension()(harness.api);
	const context = harness.ctx();

	await harness.commands.get("plan")!.handler("", context);
	expect(lastPlanEntry(harness)).toMatchObject({ enabled: true, planSource: "user" });

	await harness.commands.get("plan")!.handler("", context);
	const afterToggleOff = lastPlanEntry(harness);
	expect(afterToggleOff.enabled).toBe(false);
	expect(afterToggleOff.planSource).toBeUndefined();

	await runTool(harness, "enter_plan_mode", {}, context);
	expect(lastPlanEntry(harness)).toMatchObject({ enabled: true, planSource: "agent" });
});

// ---------------------------------------------------------------------------
// Legacy PlanState todos migration
// ---------------------------------------------------------------------------

test("session_start migrates legacy PlanState todos into step-tasks once", async () => {
	const harness = createHarness({
		entries: [
			{
				type: "custom",
				customType: "step-plan",
				data: {
					enabled: false,
					executing: true,
					todos: [
						{ step: 1, text: "Inspect the parser", completed: true },
						{ step: 2, text: "Add a regression test", completed: false },
						{ step: 3, text: "   ", completed: false },
					],
				},
			},
		],
	});
	// Registration order mirrors step-capabilities: plan first, tasks second.
	createStepPlanExtension()(harness.api);
	createStepTasksExtension()(harness.api);
	const context = harness.ctx();

	await harness.emit({ type: "session_start", reason: "resume" }, context);

	const listed = (await runTool(harness, "task_list", {}, context)) as { details: Array<Record<string, unknown>> };
	expect(listed.details).toEqual([
		expect.objectContaining({ id: "1", subject: "Inspect the parser", status: "completed" }),
		expect.objectContaining({ id: "2", subject: "Add a regression test", status: "pending" }),
	]);
	const migrated = (await runTool(harness, "task_get", { taskId: "1" }, context)) as { details: StepTask };
	expect(migrated.details.description).toContain("Migrated from the legacy plan-mode todo list");

	// The migrated (todo-less) plan shape was persisted, so the migration is one-time.
	const planEntry = lastPlanEntry(harness);
	expect(planEntry).not.toHaveProperty("todos");
	expect(planEntry).not.toHaveProperty("executing");
	expect(
		harness.notifications.some((notification) => notification.message.includes("Migrated 2 legacy plan todos")),
	).toBe(true);

	// A later session_start replays against the migrated entries: no duplicates.
	await harness.emit({ type: "session_start", reason: "reload" }, context);
	const relisted = (await runTool(harness, "task_list", {}, context)) as { details: Array<Record<string, unknown>> };
	expect(relisted.details).toHaveLength(2);
});

test("migration keeps previously persisted step-tasks snapshots intact", async () => {
	const existingTask: StepTask = {
		id: "1",
		subject: "Existing task",
		description: "already tracked",
		status: "in_progress",
		blocks: [],
		blockedBy: [],
		createdAt: 1,
		updatedAt: 1,
	};
	const harness = createHarness({
		entries: [
			{ type: "custom", customType: "step-tasks", data: { tasks: [existingTask], nextId: 2 } },
			{
				type: "custom",
				customType: "step-plan",
				data: { enabled: false, todos: [{ step: 1, text: "Migrated todo", completed: false }] },
			},
		],
	});
	createStepPlanExtension()(harness.api);
	createStepTasksExtension()(harness.api);
	const context = harness.ctx();
	await harness.emit({ type: "session_start", reason: "resume" }, context);

	const listed = (await runTool(harness, "task_list", {}, context)) as { details: Array<Record<string, unknown>> };
	expect(listed.details).toEqual([
		expect.objectContaining({ id: "1", subject: "Existing task", status: "in_progress" }),
		expect.objectContaining({ id: "2", subject: "Migrated todo", status: "pending" }),
	]);
});

// ---------------------------------------------------------------------------
// /todos reads the step-tasks list
// ---------------------------------------------------------------------------

test("/todos formats the step-tasks list with status, owner, and open blockers", async () => {
	const harness = createHarness();
	createStepPlanExtension()(harness.api);
	createStepTasksExtension()(harness.api);
	const context = harness.ctx();

	await runTool(harness, "task_create", { subject: "Write the parser", description: "tokenizer" }, context);
	await runTool(harness, "task_create", { subject: "Add tests", description: "regression" }, context);
	await runTool(harness, "task_update", { taskId: "1", status: "in_progress", owner: "worker-a" }, context);
	await runTool(harness, "task_update", { taskId: "2", addBlockedBy: ["1"] }, context);

	await harness.commands.get("todos")!.handler("", context);
	const output = harness.notifications.at(-1)!.message;
	expect(output).toBe("wip 1. Write the parser @worker-a\ntodo 2. Add tests (blocked by 1)");

	// Completed blockers stop being reported, matching task_list semantics.
	await runTool(harness, "task_update", { taskId: "1", status: "completed" }, context);
	await harness.commands.get("todos")!.handler("", context);
	expect(harness.notifications.at(-1)!.message).toBe("done 1. Write the parser @worker-a\ntodo 2. Add tests");
});

test("/todos falls back to the empty-state line when nothing is tracked", async () => {
	const harness = createHarness();
	createStepPlanExtension()(harness.api);
	createStepTasksExtension()(harness.api);
	const context = harness.ctx();
	await harness.commands.get("todos")!.handler("", context);
	expect(harness.notifications.at(-1)!.message).toBe("No tasks tracked. Use task_create to add some.");
});

// ---------------------------------------------------------------------------
// UI status chip + telemetry
// ---------------------------------------------------------------------------

function createTelemetryRecorder(): {
	telemetry: StepTelemetryReporter;
	events: Array<{ event: string; properties: Record<string, unknown> }>;
} {
	const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
	return {
		telemetry: {
			track: (event, properties) => {
				events.push({ event, properties: { ...properties } });
			},
		},
		events,
	};
}

test("status chip shows Planning with the source and clears when plan mode is off", async () => {
	const cwd = makeWorkspace();
	const harness = createHarness({ cwd });
	createStepPlanExtension()(harness.api);
	const context = harness.ctx();

	await harness.commands.get("plan")!.handler("", context);
	expect(harness.statuses.get("plan-mode")).toBe("Planning (user)");
	await harness.commands.get("plan")!.handler("", context);
	expect(harness.statuses.get("plan-mode")).toBeUndefined();

	await runTool(harness, "enter_plan_mode", {}, context);
	expect(harness.statuses.get("plan-mode")).toBe("Planning (agent)");
});

test("session_start restores the chip: user for --plan, unknown for persisted state without planSource", async () => {
	const flagged = createHarness({ flags: { plan: true } });
	createStepPlanExtension()(flagged.api);
	await flagged.emit({ type: "session_start", reason: "startup" }, flagged.ctx());
	expect(flagged.statuses.get("plan-mode")).toBe("Planning (user)");

	const restored = createHarness({
		entries: [{ type: "custom", customType: "step-plan", data: { enabled: true, planFilePath: "/tmp/plan.md" } }],
	});
	createStepPlanExtension()(restored.api);
	await restored.emit({ type: "session_start", reason: "resume" }, restored.ctx());
	expect(restored.statuses.get("plan-mode")).toBe("Planning (unknown)");
});

test("plan telemetry carries the source dim across enter, update, and exit", async () => {
	const cwd = makeWorkspace();
	const { telemetry, events } = createTelemetryRecorder();
	const harness = createHarness({ cwd, select: async () => "Execute the plan" });
	createStepPlanExtension({ telemetry })(harness.api);
	const context = harness.ctx();

	// /plan on + off → entered(user) + exited(user, toggled_off).
	await harness.commands.get("plan")!.handler("", context);
	await harness.commands.get("plan")!.handler("", context);

	// Agent flow: enter, write the plan file, approved exit.
	await runTool(harness, "enter_plan_mode", {}, context);
	const planPath = path.join(cwd, ".step-cli", "plans", "session-sess-1.md");
	await harness.emit(
		{ type: "tool_call", toolName: "write_file", toolCallId: "t1", input: { path: planPath, content: "# plan" } },
		context,
	);
	mkdirSync(path.dirname(planPath), { recursive: true });
	writeFileSync(planPath, "# The plan\n1. Do the thing\n");
	await runTool(harness, "exit_plan_mode", {}, context);

	expect(events).toEqual([
		{ event: "plan_mode_entered", properties: { source: "user" } },
		{ event: "plan_mode_exited", properties: { source: "user", outcome: "toggled_off" } },
		{ event: "plan_mode_entered", properties: { source: "agent" } },
		{ event: "plan_updated", properties: { source: "agent", created: true } },
		{ event: "plan_mode_exited", properties: { source: "agent", outcome: "approved" } },
	]);
});

// ---------------------------------------------------------------------------
// rpc children
// ---------------------------------------------------------------------------

test("rpc-mode exit_plan_mode auto-approves without the UI select", async () => {
	const cwd = makeWorkspace();
	const { telemetry, events } = createTelemetryRecorder();
	let selectCalls = 0;
	const harness = createHarness({
		cwd,
		select: async () => {
			selectCalls += 1;
			return "Stay in plan mode";
		},
	});
	createStepPlanExtension({ telemetry })(harness.api);
	// rpc children have a dialog bridge (hasUI true) but no real user.
	const context = harness.ctx({ mode: "rpc" });

	await runTool(harness, "enter_plan_mode", {}, context);
	const planPath = path.join(cwd, ".step-cli", "plans", "session-sess-1.md");
	mkdirSync(path.dirname(planPath), { recursive: true });
	writeFileSync(planPath, "# The plan\n1. Do the thing\n");

	const result = (await runTool(harness, "exit_plan_mode", {}, context)) as {
		content: Array<{ type: string; text: string }>;
	};
	const text = result.content[0]!.text;
	expect(text).toContain("Cannot gate approval in rpc child context.");
	expect(text).toContain(planPath);
	expect(text).toContain("caller should approve externally");
	expect(selectCalls).toBe(0);

	// Plan mode actually exited: tools restored, chip cleared, state persisted off.
	expect(harness.activeTools()).toContain("write_file");
	expect(harness.statuses.get("plan-mode")).toBeUndefined();
	expect(lastPlanEntry(harness)).toMatchObject({ enabled: false });
	expect(
		harness.notifications.some(
			(notification) =>
				notification.type === "warning" && notification.message.includes("rpc child auto-approved plan mode exit"),
		),
	).toBe(true);
	expect(events.at(-1)).toEqual({
		event: "plan_mode_exited",
		properties: { source: "agent", outcome: "auto_rpc" },
	});
});

test("tui-mode exit_plan_mode still gates through the UI select", async () => {
	const cwd = makeWorkspace();
	let selectCalls = 0;
	const harness = createHarness({
		cwd,
		select: async () => {
			selectCalls += 1;
			return "Stay in plan mode";
		},
	});
	createStepPlanExtension()(harness.api);
	const context = harness.ctx();

	await runTool(harness, "enter_plan_mode", {}, context);
	const planPath = path.join(cwd, ".step-cli", "plans", "session-sess-1.md");
	mkdirSync(path.dirname(planPath), { recursive: true });
	writeFileSync(planPath, "# The plan\n");

	const result = (await runTool(harness, "exit_plan_mode", {}, context)) as {
		content: Array<{ type: string; text: string }>;
	};
	expect(selectCalls).toBe(1);
	expect(result.content[0]!.text).toContain("Staying in plan mode.");
	expect(harness.statuses.get("plan-mode")).toBe("Planning (agent)");
});
