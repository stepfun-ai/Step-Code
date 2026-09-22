import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Component, setKeybindings } from "@step-harness/pi-tui";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createStepPlanExtension } from "../src/features/step-plan.ts";
import { createStepTasksExtension, type StepTask } from "../src/features/step-tasks.ts";
import type { StepTelemetryReporter } from "../src/step/telemetry.ts";

// Preserve real file I/O while making the ESM read export spyable for EACCES tests.
vi.mock("node:fs", { spy: true });

interface SessionEntryStub {
	type: string;
	customType: string;
	data?: unknown;
}

interface Harness {
	api: ExtensionAPI;
	session: SessionManager;
	tools: Map<string, ToolDefinition>;
	commands: Map<string, { handler: (args: string, ctx: ExtensionContext) => unknown }>;
	handlerEvents: () => string[];
	appended: Array<{ customType: string; data: unknown }>;
	notifications: Array<{ message: string; type?: string }>;
	userMessages: Array<Parameters<ExtensionAPI["sendUserMessage"]>>;
	statuses: Map<string, string | undefined>;
	customCalls: () => number;
	reviewComponent: () => (Component & { handleInput?(data: string): void }) | undefined;
	activeTools: () => string[];
	emit: (event: { type: string } & Record<string, unknown>, ctx: ExtensionContext) => Promise<unknown>;
	ctx: (overrides?: Record<string, unknown>) => ExtensionContext;
}

/** Keys the review dialog reacts to, spelled the way the terminal sends them. */
const REVIEW_KEYS = { enter: "\r", escape: "\u001b", down: "\u001b[B", up: "\u001b[A" } as const;

function typeReview(text: string): string[] {
	return [...text];
}

// Identity styling: the plan is rendered as markdown, so the double has to
// cover everything getMarkdownTheme reaches for, not just fg/bold.
const fakeReviewTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
};

const cleanups: Array<() => void> = [];

// The review component resolves keys through the global keybindings registry.
beforeAll(() => setKeybindings(new KeybindingsManager()));

afterEach(() => {
	vi.restoreAllMocks();
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
		select?: (title: string, options: string[]) => Promise<string | undefined>;
		editor?: (title: string, prefill?: string) => Promise<string | undefined>;
		/** Keystrokes fed to the plan review component mounted through ui.custom. */
		review?: string[];
	} = {},
): Harness {
	const tools = new Map<string, ToolDefinition>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => unknown }>();
	const handlers = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
	const appended: Array<{ customType: string; data: unknown }> = [];
	const notifications: Array<{ message: string; type?: string }> = [];
	const userMessages: Array<Parameters<ExtensionAPI["sendUserMessage"]>> = [];
	const statuses = new Map<string, string | undefined>();
	const cwd = options.cwd ?? "/workspace";
	let customCalls = 0;
	let lastReviewComponent: (Component & { handleInput?(data: string): void }) | undefined;
	const session = SessionManager.inMemory(cwd, { id: "sess-1" });
	for (const entry of options.entries ?? []) session.appendCustomEntry(entry.customType, entry.data);
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
			appended.push({ customType, data });
			session.appendCustomEntry(customType, data);
		},
		sendMessage: () => {},
		sendUserMessage: (...args: Parameters<ExtensionAPI["sendUserMessage"]>) => {
			userMessages.push(args);
		},
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
				editor: options.editor ?? (async () => undefined),
				custom: async <T>(
					factory: (
						tui: unknown,
						theme: unknown,
						keybindings: unknown,
						done: (result: T) => void,
					) => Component & { focused?: boolean; handleInput?(data: string): void },
				): Promise<T | undefined> => {
					customCalls += 1;
					let result: T | undefined;
					let settled = false;
					const component = factory({ requestRender: () => {} }, fakeReviewTheme, {}, (value: T) => {
						if (settled) return;
						settled = true;
						result = value;
					});
					lastReviewComponent = component;
					component.focused = true;
					for (const key of options.review ?? []) {
						if (settled) break;
						component.handleInput?.(key);
					}
					return result;
				},
				setStatus: (key: string, text: string | undefined) => {
					statuses.set(key, text);
				},
				setWidget: () => {},
				theme: { fg: (_color: string, text: string) => text },
			},
			sessionManager: session,
			...overrides,
		}) as unknown as ExtensionContext;

	return {
		api,
		session,
		tools,
		commands,
		handlerEvents: () => [...handlers.keys()],
		appended,
		notifications,
		userMessages,
		statuses,
		customCalls: () => customCalls,
		reviewComponent: () => lastReviewComponent,
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

	const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
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
	const harness = createHarness({ cwd, review: [REVIEW_KEYS.enter] });
	createStepPlanExtension({ telemetry })(harness.api);
	const context = harness.ctx();

	// /plan on + off → entered(user) + exited(user, toggled_off).
	await harness.commands.get("plan")!.handler("", context);
	await harness.commands.get("plan")!.handler("", context);

	// Agent flow: enter, write the plan file, approved exit.
	await runTool(harness, "enter_plan_mode", {}, context);
	const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
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
	const harness = createHarness({ cwd, review: [REVIEW_KEYS.enter] });
	createStepPlanExtension({ telemetry })(harness.api);
	// rpc children have a dialog bridge (hasUI true) but no real user.
	const context = harness.ctx({ mode: "rpc" });

	await runTool(harness, "enter_plan_mode", {}, context);
	const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	mkdirSync(path.dirname(planPath), { recursive: true });
	writeFileSync(planPath, "# The plan\n1. Do the thing\n");

	const result = (await runTool(harness, "exit_plan_mode", {}, context)) as {
		content: Array<{ type: string; text: string }>;
	};
	const text = result.content[0]!.text;
	expect(text).toContain("Cannot gate approval in rpc child context.");
	expect(text).toContain(planPath);
	expect(text).toContain("caller should approve externally");
	expect(harness.customCalls()).toBe(0);

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

test("tui-mode exit_plan_mode still gates through the review dialog", async () => {
	const cwd = makeWorkspace();
	const harness = createHarness({ cwd, review: [REVIEW_KEYS.escape] });
	createStepPlanExtension()(harness.api);
	const context = harness.ctx();

	await runTool(harness, "enter_plan_mode", {}, context);
	const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	mkdirSync(path.dirname(planPath), { recursive: true });
	writeFileSync(planPath, "# The plan\n");

	const result = (await runTool(harness, "exit_plan_mode", {}, context)) as {
		content: Array<{ type: string; text: string }>;
		terminate?: boolean;
	};
	expect(harness.customCalls()).toBe(1);
	expect(result.content[0]!.text).toContain("Staying in plan mode.");
	expect(harness.statuses.get("plan-mode")).toBe("Planning (agent)");
	// Escape hands the turn back to the user. Without this the model re-submits
	// the unchanged plan straight away and the dialog re-opens on every Escape.
	expect(result.terminate).toBe(true);
	expect(result.content[0]!.text).toContain("do not call exit_plan_mode again");
});

test("only a dismissed review ends the turn; approval and notes let the agent keep going", async () => {
	const cwd = makeWorkspace();
	const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	const cases = [
		{ keys: [REVIEW_KEYS.enter], terminate: false, outcome: "approved" },
		{
			keys: [REVIEW_KEYS.down, ...typeReview("use canvas"), REVIEW_KEYS.enter],
			terminate: false,
			outcome: "feedback",
			feedback: "use canvas",
		},
		{ keys: [REVIEW_KEYS.escape], terminate: true, outcome: "dismissed" },
	];
	for (const { keys, terminate, outcome, feedback } of cases) {
		const harness = createHarness({ cwd, review: keys });
		createStepPlanExtension()(harness.api);
		await runTool(harness, "enter_plan_mode", {}, harness.ctx());
		mkdirSync(path.dirname(planPath), { recursive: true });
		writeFileSync(planPath, "# The plan\n");

		const result = (await runTool(harness, "exit_plan_mode", {}, harness.ctx())) as {
			terminate?: boolean;
			details?: unknown;
		};
		expect(result.terminate).toBe(terminate);
		// Every reviewed outcome carries the plan so the tool row can replay it
		// after the dialog — the only place it was drawn — has been torn down.
		expect(result.details).toEqual({
			planFilePath: planPath,
			planContents: "# The plan\n",
			outcome,
			...(feedback === undefined ? {} : { feedback }),
		});
	}
});

// ---------------------------------------------------------------------------
// Shared entry and branch-local restoration
// ---------------------------------------------------------------------------

test("plan extension registers only the plan command and its two model tools", () => {
	const harness = createHarness();
	createStepPlanExtension()(harness.api);
	expect([...harness.commands.keys()]).toEqual(["plan"]);
	expect([...harness.tools.keys()]).toEqual(["enter_plan_mode", "exit_plan_mode"]);
});

test.each(["/plan", "--plan", "enter_plan_mode"])(
	"%s preserves tools and announces a writable plan path",
	async (entry) => {
		const cwd = makeWorkspace();
		const { telemetry, events } = createTelemetryRecorder();
		const harness = createHarness({ cwd, flags: { plan: entry === "--plan" } });
		const originalTools = ["read_file", "run_command", "write", "edit", "custom_tool"];
		harness.api.setActiveTools(originalTools);
		createStepPlanExtension({ telemetry })(harness.api);
		const context = harness.ctx();
		if (entry === "/plan") await harness.commands.get("plan")!.handler("", context);
		else if (entry === "--plan") await harness.emit({ type: "session_start", reason: "startup" }, context);
		else await runTool(harness, "enter_plan_mode", {}, context);

		const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
		const source = entry === "enter_plan_mode" ? "agent" : "user";
		expect(lastPlanEntry(harness)).toMatchObject({
			enabled: true,
			planSource: source,
			planFilePath: planPath,
			toolsBeforePlanMode: originalTools,
		});
		expect(harness.activeTools()).toEqual(
			expect.arrayContaining(["write_file", "edit_file", "run_command", "custom_tool"]),
		);
		expect(harness.activeTools()).not.toContain("write");
		expect(harness.activeTools()).not.toContain("edit");
		if (source === "user") {
			expect(harness.notifications.at(-1)?.message).toContain(planPath);
			expect(harness.notifications.at(-1)?.message).not.toContain("command execution are disabled");
		}
		for (const toolName of ["write_file", "edit_file", "write", "edit"]) {
			await expect(
				harness.emit({ type: "tool_call", toolName, input: { path: path.relative(cwd, planPath) } }, context),
			).resolves.toBeUndefined();
			await expect(
				harness.emit({ type: "tool_call", toolName, input: { path: "src/app.ts" } }, context),
			).resolves.toMatchObject({ block: true });
		}
		await expect(
			harness.emit({ type: "tool_call", toolName: "run_command", input: { command: "git status" } }, context),
		).resolves.toBeUndefined();

		const snapshotsBefore = harness.appended.length;
		const telemetryBefore = events.length;
		const toolsBefore = harness.activeTools();
		const repeated = await runTool(harness, "enter_plan_mode", {}, context);
		expect(repeated).toMatchObject({ content: [{ text: expect.stringContaining(planPath) }] });
		expect(harness.appended).toHaveLength(snapshotsBefore);
		expect(events).toHaveLength(telemetryBefore);
		expect(events[0]).toEqual({ event: "plan_mode_entered", properties: { source } });
		expect(harness.activeTools()).toEqual(toolsBefore);
		expect(lastPlanEntry(harness).planSource).toBe(source);

		await harness.commands.get("plan")!.handler("", context);
		expect(harness.activeTools()).toEqual(originalTools);
		if (entry === "--plan") {
			const telemetryBeforeRestore = events.length;
			await harness.emit({ type: "session_start", reason: "reload" }, context);
			expect(harness.statuses.get("plan-mode")).toBeUndefined();
			expect(events).toHaveLength(telemetryBeforeRestore);
		}
	},
);

async function restoreLifecycle(harness: Harness, type: "session_start" | "session_tree"): Promise<void> {
	await harness.emit(
		type === "session_start"
			? { type, reason: "resume" }
			: { type, oldLeafId: null, newLeafId: harness.session.getLeafId() },
		harness.ctx(),
	);
}

test.each(["session_start", "session_tree"] as const)(
	"%s restores the active sibling's source, path and original tools without telemetry",
	async (type) => {
		const cwd = makeWorkspace();
		const { telemetry, events } = createTelemetryRecorder();
		const harness = createHarness({ cwd });
		const root = harness.session.appendCustomEntry("branch-root");
		const pathA = path.join(cwd, "proposal-a.md");
		const pathB = path.join(cwd, "proposal-b.md");
		const toolsA = ["read_file", "write", "edit", "branch_a_tool"];
		const toolsB = ["read_file", "write_file", "branch_b_tool"];
		const branchA = harness.session.appendCustomEntry("step-plan", {
			enabled: true,
			planSource: "user",
			planFilePath: pathA,
			toolsBeforePlanMode: toolsA,
		});
		harness.session.branch(root);
		const branchB = harness.session.appendCustomEntry("step-plan", {
			enabled: true,
			planSource: "agent",
			planFilePath: pathB,
			toolsBeforePlanMode: toolsB,
		});
		harness.session.branch(branchA);
		createStepPlanExtension({ telemetry })(harness.api);
		for (const name of ["branch_a_tool", "branch_b_tool"]) {
			harness.api.registerTool({ ...harness.tools.get("enter_plan_mode")!, name });
		}
		harness.api.setActiveTools([...harness.activeTools(), "branch_a_tool", "branch_b_tool"]);

		await restoreLifecycle(harness, type);
		expect(harness.statuses.get("plan-mode")).toBe("Planning (user)");
		expect(harness.activeTools()).toContain("branch_a_tool");
		expect(harness.activeTools()).not.toContain("branch_b_tool");
		expect(await runTool(harness, "enter_plan_mode", {}, harness.ctx())).toMatchObject({
			content: [{ text: expect.stringContaining(pathA) }],
		});
		await expect(
			harness.emit({ type: "tool_call", toolName: "edit_file", input: { path: pathA } }, harness.ctx()),
		).resolves.toBeUndefined();
		await expect(
			harness.emit({ type: "tool_call", toolName: "edit_file", input: { path: pathB } }, harness.ctx()),
		).resolves.toMatchObject({ block: true });
		expect(harness.appended).toHaveLength(0);
		expect(events.filter((event) => event.event !== "plan_updated")).toEqual([]);
		await harness.commands.get("plan")!.handler("", harness.ctx());
		expect(harness.activeTools()).toEqual(toolsA);
		const offBranch = harness.session.getLeafId()!;

		harness.session.branch(branchB);
		await restoreLifecycle(harness, type);
		expect(harness.statuses.get("plan-mode")).toBe("Planning (agent)");
		expect(harness.activeTools()).toContain("branch_b_tool");
		expect(harness.activeTools()).not.toContain("branch_a_tool");
		expect(await runTool(harness, "enter_plan_mode", {}, harness.ctx())).toMatchObject({
			content: [{ text: expect.stringContaining(pathB) }],
		});
		await harness.commands.get("plan")!.handler("", harness.ctx());
		expect(harness.activeTools()).toEqual(toolsB);

		// Switch directly from B-off to A-off; visiting A-on first hides stale tools.
		harness.session.branch(offBranch);
		const snapshotsBefore = harness.appended.length;
		const telemetryBefore = events.length;
		for (let attempt = 0; attempt < 2; attempt++) {
			await restoreLifecycle(harness, type);
			expect(harness.statuses.get("plan-mode")).toBeUndefined();
			expect(harness.activeTools()).toEqual(toolsA);
		}
		expect(harness.appended).toHaveLength(snapshotsBefore);
		expect(events).toHaveLength(telemetryBefore);
		expect(await runTool(harness, "exit_plan_mode", {}, harness.ctx())).toMatchObject({
			content: [{ text: "Not in plan mode." }],
		});
		expect(events.filter((event) => event.event === "plan_mode_entered")).toEqual([]);
	},
);

test("legacy off snapshots recover the latest branch baseline and new entry captures current tools", async () => {
	const originalTools = ["read_file", "saved_tool"];
	const harness = createHarness({
		entries: [
			{ type: "custom", customType: "step-plan", data: { enabled: true, toolsBeforePlanMode: ["older_tool"] } },
			{ type: "custom", customType: "step-plan", data: { enabled: false } },
			{ type: "custom", customType: "step-plan", data: { enabled: true, toolsBeforePlanMode: originalTools } },
			{ type: "custom", customType: "step-plan", data: { enabled: false } },
		],
	});
	createStepPlanExtension()(harness.api);
	for (const name of ["older_tool", "saved_tool", "new_tool"]) {
		harness.api.registerTool({ ...harness.tools.get("enter_plan_mode")!, name });
	}
	for (let attempt = 0; attempt < 2; attempt++) {
		await restoreLifecycle(harness, "session_start");
		expect(harness.statuses.get("plan-mode")).toBeUndefined();
		expect(harness.activeTools()).toEqual(originalTools);
	}
	expect(harness.appended).toEqual([]);

	// Restoring an off snapshot must not leave a transient planning baseline.
	const changedTools = ["read_file", "new_tool"];
	harness.api.setActiveTools(changedTools);
	await harness.commands.get("plan")!.handler("", harness.ctx());
	expect(lastPlanEntry(harness).toolsBeforePlanMode).toEqual(changedTools);
	await harness.commands.get("plan")!.handler("", harness.ctx());
	expect(harness.activeTools()).toEqual(changedTools);
});

test.each(["session_start", "session_tree"] as const)(
	"%s clears plan state on an empty branch and restores the previous tools",
	async (type) => {
		const cwd = makeWorkspace();
		const { telemetry, events } = createTelemetryRecorder();
		const harness = createHarness({ cwd, flags: { plan: true } });
		const originalTools = ["read_file", "custom_tool"];
		harness.session.appendCustomEntry("step-plan", {
			enabled: true,
			planSource: "user",
			planFilePath: path.join(cwd, "old-plan.md"),
			toolsBeforePlanMode: originalTools,
		});
		createStepPlanExtension({ telemetry })(harness.api);
		await restoreLifecycle(harness, "session_start");
		harness.session.resetLeaf();
		await restoreLifecycle(harness, type);

		expect(harness.statuses.get("plan-mode")).toBeUndefined();
		expect(harness.activeTools()).toEqual(originalTools);
		expect(harness.appended).toEqual([]);
		expect(events).toEqual([]);
		await expect(
			harness.emit({ type: "tool_call", toolName: "write_file", input: { path: "src/app.ts" } }, harness.ctx()),
		).resolves.toBeUndefined();
		await runTool(harness, "enter_plan_mode", {}, harness.ctx());
		expect(lastPlanEntry(harness)).toMatchObject({
			planFilePath: path.join(cwd, ".stepcode", "plans", "session-sess-1.md"),
			planSource: "agent",
			toolsBeforePlanMode: originalTools,
		});
	},
);

test("a legacy branch without saved tools does not capture the preceding branch's planning tools", async () => {
	const harness = createHarness();
	const originalTools = ["read_file", "write", "custom_tool"];
	const root = harness.session.appendCustomEntry("branch-root");
	const branchA = harness.session.appendCustomEntry("step-plan", {
		enabled: true,
		toolsBeforePlanMode: originalTools,
	});
	harness.session.branch(root);
	const branchB = harness.session.appendCustomEntry("step-plan", { enabled: true });
	harness.session.branch(branchA);
	createStepPlanExtension()(harness.api);
	await restoreLifecycle(harness, "session_start");
	harness.session.branch(branchB);
	await restoreLifecycle(harness, "session_tree");
	expect(harness.statuses.get("plan-mode")).toBe("Planning (unknown)");
	await harness.commands.get("plan")!.handler("", harness.ctx());
	expect(harness.activeTools()).toEqual(originalTools);
});

test.each(["reload", "new", "resume", "fork"])("--plan does not reapply during session_start (%s)", async (reason) => {
	const harness = createHarness({ flags: { plan: true } });
	const { telemetry, events } = createTelemetryRecorder();
	createStepPlanExtension({ telemetry })(harness.api);
	await harness.emit({ type: "session_start", reason }, harness.ctx());
	expect(harness.statuses.get("plan-mode")).toBeUndefined();
	expect(harness.appended).toEqual([]);
	expect(events).toEqual([]);
});

test.each([false, true])("--plan at process startup honors the flag with persisted enabled=%s", async (enabled) => {
	const originalTools = ["read_file", "custom_tool"];
	const harness = createHarness({
		flags: { plan: true },
		entries: [
			{
				type: "custom",
				customType: "step-plan",
				data: {
					enabled,
					toolsBeforePlanMode: originalTools,
					planSource: enabled ? "agent" : undefined,
				},
			},
		],
	});
	const { telemetry, events } = createTelemetryRecorder();
	createStepPlanExtension({ telemetry })(harness.api);
	await harness.emit({ type: "session_start", reason: "startup" }, harness.ctx());
	expect(harness.statuses.get("plan-mode")).toBe(`Planning (${enabled ? "agent" : "user"})`);
	expect(harness.activeTools()).toEqual(expect.arrayContaining(["custom_tool", "write_file", "edit_file"]));
	expect(events).toEqual(enabled ? [] : [{ event: "plan_mode_entered", properties: { source: "user" } }]);
	expect(harness.appended).toHaveLength(enabled ? 0 : 1);
	await harness.commands.get("plan")!.handler("", harness.ctx());
	expect(harness.activeTools()).toEqual(originalTools);
});

for (const type of ["session_start", "session_tree"] as const) {
	test.each([false, true])(
		`${type} retains active plan/task tools and restores the legacy custom-tool selection (enabled=%s)`,
		async (enabled) => {
			const cwd = makeWorkspace();
			const originalTools = ["read_file", "write", "edit", "selected_custom_tool"];
			const savedTools = [...originalTools];
			const harness = createHarness({
				cwd,
				review: [REVIEW_KEYS.enter],
				entries: [
					{
						type: "custom",
						customType: "step-plan",
						data: {
							enabled,
							toolsBeforePlanMode: savedTools,
							todos: [{ text: "Legacy task" }],
						},
					},
				],
			});
			createStepPlanExtension()(harness.api);
			createStepTasksExtension()(harness.api);
			const currentPlanTaskTools = [...harness.tools.keys()];
			for (const name of ["selected_custom_tool", "new_custom_tool", "disabled_custom_tool"]) {
				harness.api.registerTool({ ...harness.tools.get("task_list")!, name });
			}
			// The runtime activates registered extensions before session_start. An
			// older tool snapshot must not remove newly available control/task tools.
			harness.api.setActiveTools([...originalTools, "list_directory", ...currentPlanTaskTools, "new_custom_tool"]);

			await restoreLifecycle(harness, type);
			expect(harness.activeTools()).toEqual(expect.arrayContaining(currentPlanTaskTools));
			expect(harness.activeTools()).toContain("selected_custom_tool");
			expect(harness.activeTools()).not.toContain("new_custom_tool");
			expect(harness.activeTools()).not.toContain("disabled_custom_tool");
			expect(await runTool(harness, "task_list", {}, harness.ctx())).toMatchObject({
				details: [{ id: "1", subject: "Legacy task" }],
			});
			// A second restore must retain tools without importing the tasks twice.
			await restoreLifecycle(harness, type);
			expect(harness.activeTools()).toEqual(expect.arrayContaining(currentPlanTaskTools));
			expect(await runTool(harness, "task_list", {}, harness.ctx())).toMatchObject({
				details: [{ id: "1", subject: "Legacy task" }],
			});
			if (enabled) {
				const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
				mkdirSync(path.dirname(planPath), { recursive: true });
				writeFileSync(planPath, "A readable proposal.");
				await runTool(harness, "exit_plan_mode", {}, harness.ctx());
			}
			expect(harness.activeTools()).toEqual([...originalTools, ...currentPlanTaskTools]);
			expect(savedTools).toEqual(originalTools);
		},
	);
}

test("legacy plan restoration does not activate inactive plan/task tools", async () => {
	const harness = createHarness({
		entries: [
			{ type: "custom", customType: "step-plan", data: { enabled: true, toolsBeforePlanMode: ["read_file"] } },
		],
	});
	createStepPlanExtension()(harness.api);
	createStepTasksExtension()(harness.api);
	const active = ["read_file", ...[...harness.tools.keys()].filter((name) => name !== "task_get")];
	harness.api.setActiveTools(active);
	await restoreLifecycle(harness, "session_start");
	expect(harness.activeTools()).toContain("exit_plan_mode");
	expect(harness.activeTools()).toContain("task_list");
	expect(harness.activeTools()).not.toContain("task_get");
	await harness.commands.get("plan")!.handler("", harness.ctx());
	expect(harness.activeTools()).toEqual(active);
});

test("switching to a fresh session clears the preceding plan path and source", async () => {
	const cwd = makeWorkspace();
	const harness = createHarness({ cwd, flags: { plan: true } });
	createStepPlanExtension()(harness.api);
	await runTool(harness, "enter_plan_mode", {}, harness.ctx());
	harness.session.newSession({ id: "sess-2" });
	await harness.emit({ type: "session_start", reason: "new" }, harness.ctx());
	expect(harness.statuses.get("plan-mode")).toBeUndefined();
	await harness.commands.get("plan")!.handler("", harness.ctx());
	expect(lastPlanEntry(harness)).toMatchObject({
		enabled: true,
		planSource: "user",
		planFilePath: path.join(cwd, ".stepcode", "plans", "session-sess-2.md"),
	});
});

test.each(["session_start", "session_tree"] as const)(
	"%s migrates only active-branch legacy todos without duplicate imports",
	async (type) => {
		const harness = createHarness();
		const root = harness.session.appendCustomEntry("branch-root");
		const legacyBranch = harness.session.appendCustomEntry("step-plan", {
			enabled: false,
			todos: [{ text: "Active proposal task", completed: true }],
		});
		harness.session.branch(root);
		harness.session.appendCustomEntry("step-plan", { enabled: false, todos: [{ text: "Abandoned future task" }] });
		harness.session.branch(legacyBranch);
		createStepPlanExtension()(harness.api);
		createStepTasksExtension()(harness.api);
		await restoreLifecycle(harness, type);
		expect(await runTool(harness, "task_list", {}, harness.ctx())).toMatchObject({
			details: [{ subject: "Active proposal task", status: "completed" }],
		});
		const migratedBranch = harness.session.getLeafId()!;
		await restoreLifecycle(harness, type);
		expect(await runTool(harness, "task_list", {}, harness.ctx())).toMatchObject({
			details: [{ subject: "Active proposal task", status: "completed" }],
		});
		expect(harness.notifications.filter((notification) => notification.message.includes("Migrated"))).toHaveLength(1);

		harness.session.branch(root);
		await restoreLifecycle(harness, type);
		expect(await runTool(harness, "task_list", {}, harness.ctx())).toMatchObject({ details: [] });
		harness.session.branch(migratedBranch);
		await restoreLifecycle(harness, type);
		expect(await runTool(harness, "task_list", {}, harness.ctx())).toMatchObject({
			details: [{ subject: "Active proposal task", status: "completed" }],
		});
		expect(harness.notifications.filter((notification) => notification.message.includes("Migrated"))).toHaveLength(1);
	},
);

// ---------------------------------------------------------------------------
// Proposal validation and caller-owned approval
// ---------------------------------------------------------------------------

for (const mode of ["tui", "print", "rpc"] as const) {
	test.each(["missing", "empty", "whitespace", "directory", "unreadable"])(
		`exit_plan_mode refuses %s proposal files in ${mode} before approval or exit`,
		async (invalid) => {
			const cwd = makeWorkspace();
			const { telemetry, events } = createTelemetryRecorder();
			const select = vi.fn(async () => "Execute the plan");
			const harness = createHarness({ cwd, select });
			createStepPlanExtension({ telemetry })(harness.api);
			const context = harness.ctx({ mode, hasUI: mode !== "print" });
			await runTool(harness, "enter_plan_mode", {}, context);
			const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
			mkdirSync(path.dirname(planPath), { recursive: true });
			if (invalid === "directory") mkdirSync(planPath);
			else if (invalid !== "missing") writeFileSync(planPath, invalid === "whitespace" ? " \n\t " : "");
			if (invalid === "unreadable") {
				writeFileSync(planPath, "A proposal that cannot be read.");
				// Simulate EACCES at the read boundary so this also exercises root-run CI.
				vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
					throw new Error("EACCES: permission denied");
				});
			}

			const result = (await runTool(harness, "exit_plan_mode", {}, context)) as {
				content: Array<{ text: string }>;
			};
			expect(select).not.toHaveBeenCalled();
			expect(result.content[0].text).toContain(planPath);
			expect(result.content[0].text).toContain("exit_plan_mode");
			expect(result.content[0].text).toMatch(/write_file|readable|regular file/i);
			expect(lastPlanEntry(harness).enabled).toBe(true);
			expect(harness.appended).toHaveLength(1);
			expect(harness.statuses.get("plan-mode")).toBe("Planning (agent)");
			expect(events).toEqual([{ event: "plan_mode_entered", properties: { source: "agent" } }]);
			expect(harness.notifications).toEqual([]);
		},
	);
}

test.each([
	{ name: "approve", keys: [REVIEW_KEYS.enter], approved: true },
	// Escape is the only way to keep planning now that the third option is gone.
	{ name: "dismiss", keys: [REVIEW_KEYS.escape], approved: false },
	// Enter on an empty feedback row must not read as approval or as a note.
	{ name: "empty feedback", keys: [REVIEW_KEYS.down, REVIEW_KEYS.enter], approved: false },
])("a readable plain-text proposal preserves the $name outcome", async ({ keys, approved }) => {
	const cwd = makeWorkspace();
	const { telemetry, events } = createTelemetryRecorder();
	const harness = createHarness({ cwd, review: keys });
	const originalTools = ["read_file", "custom_tool"];
	harness.api.setActiveTools(originalTools);
	createStepPlanExtension({ telemetry })(harness.api);
	await runTool(harness, "enter_plan_mode", {}, harness.ctx());
	const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	mkdirSync(path.dirname(planPath), { recursive: true });
	const proposal = "Change the parser, add focused regression coverage, then verify the result.";
	writeFileSync(planPath, proposal);

	await runTool(harness, "exit_plan_mode", {}, harness.ctx());
	expect(harness.customCalls()).toBe(1);
	expect(harness.userMessages).toEqual([]);
	if (approved) {
		expect(lastPlanEntry(harness)).toMatchObject({ enabled: false, planSource: undefined });
		expect(harness.activeTools()).toEqual(originalTools);
		expect(events.at(-1)).toEqual({
			event: "plan_mode_exited",
			properties: { source: "agent", outcome: "approved" },
		});
	} else {
		expect(lastPlanEntry(harness).enabled).toBe(true);
		expect(harness.appended).toHaveLength(1);
		expect(events).toHaveLength(1);
	}
});

test.each(["Cover the migration edge case.", "  padded note  "])(
	"typing %j on the feedback row steers it into the next turn and keeps planning",
	async (notes) => {
		const cwd = makeWorkspace();
		const harness = createHarness({
			cwd,
			review: [REVIEW_KEYS.down, ...typeReview(notes), REVIEW_KEYS.enter],
		});
		createStepPlanExtension()(harness.api);
		await runTool(harness, "enter_plan_mode", {}, harness.ctx());
		const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
		mkdirSync(path.dirname(planPath), { recursive: true });
		writeFileSync(planPath, "Draft proposal.");

		const result = await runTool(harness, "exit_plan_mode", {}, harness.ctx());
		expect(lastPlanEntry(harness).enabled).toBe(true);
		expect(harness.appended).toHaveLength(1);
		expect(harness.statuses.get("plan-mode")).toBe("Planning (agent)");
		// Steering, not follow-up: this tool result keeps the agent running, and the
		// follow-up queue only drains once it would stop, so the note has to jump the
		// queue or the model answers the empty turn by asking what to change.
		expect(harness.userMessages).toEqual([
			[`Plan refinement requested. Update ${planPath} based on:\n\n${notes.trim()}`, { deliverAs: "steer" }],
		]);
		expect(result).toMatchObject({
			content: [{ text: expect.stringContaining("do not ask what to change") }],
		});
	},
);

test("the review dialog shows the whole plan, however long", async () => {
	const cwd = makeWorkspace();
	const harness = createHarness({ cwd, review: [REVIEW_KEYS.enter] });
	createStepPlanExtension()(harness.api);
	await runTool(harness, "enter_plan_mode", {}, harness.ctx());
	const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	mkdirSync(path.dirname(planPath), { recursive: true });
	const proposal = [
		"# Heading",
		"",
		...Array.from({ length: 200 }, (_, index) => `step ${index}: ${"detail ".repeat(10)}`),
		"",
		"## Last section",
		"the final line of the plan",
	].join("\n");
	writeFileSync(planPath, proposal);

	await runTool(harness, "exit_plan_mode", {}, harness.ctx());
	// Approving a plan whose end is hidden is approving something unread. The
	// plan renders as markdown, which reflows consecutive lines into paragraphs,
	// so compare with whitespace collapsed: words survive, line breaks need not.
	const collapse = (text: string): string => text.replace(/\s+/gu, " ");
	const rendered = collapse((harness.reviewComponent()?.render(200) ?? []).join("\n"));
	for (const line of proposal.split("\n")) {
		if (line.trim().length > 0) expect(rendered).toContain(collapse(line.trim()));
	}
	expect(rendered).not.toContain("truncated");
});

test("a valid headless proposal exits with external approval and the whole plan", async () => {
	const cwd = makeWorkspace();
	const { telemetry, events } = createTelemetryRecorder();
	const select = vi.fn(async () => "Execute the plan");
	const harness = createHarness({ cwd, select });
	const originalTools = harness.activeTools();
	createStepPlanExtension({ telemetry })(harness.api);
	const context = harness.ctx({ mode: "print", hasUI: false });
	await runTool(harness, "enter_plan_mode", {}, context);
	const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	mkdirSync(path.dirname(planPath), { recursive: true });
	writeFileSync(planPath, `${"p".repeat(2000)}tail of the plan`);

	const result = (await runTool(harness, "exit_plan_mode", {}, context)) as { content: Array<{ text: string }> };
	expect(result.content[0].text).toContain("caller must gate approval externally");
	// A caller that has to gate approval externally cannot do it on a clipped plan.
	expect(result.content[0].text).toContain("tail of the plan");
	expect(result.content[0].text).not.toContain("truncated");
	expect(select).not.toHaveBeenCalled();
	expect(lastPlanEntry(harness).enabled).toBe(false);
	expect(harness.activeTools()).toEqual(originalTools);
	expect(events.at(-1)).toEqual({
		event: "plan_mode_exited",
		properties: { source: "agent", outcome: "auto_headless" },
	});
});

test("enter_plan_mode describes writing a proposal rather than tracking todos", () => {
	const harness = createHarness();
	createStepPlanExtension()(harness.api);
	const tool = harness.tools.get("enter_plan_mode")!;
	expect(tool.description).toContain("not to track todos");
	expect(tool.description).toContain("Returns the proposal file path");
	expect(tool.description).toContain("write_file or edit_file");
	expect(tool.description).toContain("File-editing tools are limited to that file");
	expect(tool.description).toContain("commands still use normal permissions");
	expect(tool.promptSnippet).toContain("proposal");
});

test("exit_plan_mode describes review and mode-specific approval rather than unconditional exit", () => {
	const harness = createHarness();
	createStepPlanExtension()(harness.api);
	const tool = harness.tools.get("exit_plan_mode")!;
	expect(tool.description).toMatch(/^Submit .*proposal.*review/);
	expect(tool.description).toContain("readable, nonempty regular plan file");
	expect(tool.description).toContain("user approval exits planning");
	expect(tool.description).toContain("staying, refining, or cancelling keeps it active");
	expect(tool.description).toContain("headless and RPC");
	expect(tool.description).toContain("exits without interactive approval");
	expect(tool.description).toContain("caller must gate approval externally");
	expect(tool.promptSnippet).toMatch(/^Submit .*proposal.*review/);
});

// ---------------------------------------------------------------------------
// `/plan <task>` — enable plan mode and hand the task over in one submission
// ---------------------------------------------------------------------------

test("/plan with a task enables plan mode and sends the task as a user turn", async () => {
	const cwd = makeWorkspace();
	const harness = createHarness({ cwd });
	createStepPlanExtension()(harness.api);
	const context = harness.ctx();

	await harness.commands.get("plan")!.handler("实现一个俄罗斯方块,简单版", context);

	expect(harness.statuses.get("plan-mode")).toBe("Planning (user)");
	expect(harness.userMessages).toEqual([["实现一个俄罗斯方块,简单版", {}]]);
	// The turn must start under the plan-mode tool set, not the unrestricted one.
	expect(harness.activeTools()).not.toContain("edit_file_unrestricted");
	expect(harness.activeTools()).toContain("read_file");
});

test("/plan with a task never toggles plan mode off", async () => {
	const cwd = makeWorkspace();
	const harness = createHarness({ cwd });
	createStepPlanExtension()(harness.api);
	const context = harness.ctx();

	await harness.commands.get("plan")!.handler("", context);
	await harness.commands.get("plan")!.handler("now plan the next thing", context);

	expect(harness.statuses.get("plan-mode")).toBe("Planning (user)");
	expect(harness.userMessages.map(([text]) => text)).toEqual(["now plan the next thing"]);
});

test("/plan with a task queues as a follow-up while the agent is streaming", async () => {
	const cwd = makeWorkspace();
	const harness = createHarness({ cwd });
	createStepPlanExtension()(harness.api);

	await harness.commands.get("plan")!.handler("plan this too", harness.ctx({ isIdle: () => false }));

	expect(harness.userMessages).toEqual([["plan this too", { deliverAs: "followUp" }]]);
});

test("bare /plan still toggles plan mode and sends nothing", async () => {
	const cwd = makeWorkspace();
	const harness = createHarness({ cwd });
	createStepPlanExtension()(harness.api);
	const context = harness.ctx();

	await harness.commands.get("plan")!.handler("", context);
	expect(harness.statuses.get("plan-mode")).toBe("Planning (user)");
	await harness.commands.get("plan")!.handler("   ", context);
	expect(harness.statuses.get("plan-mode")).toBeUndefined();
	expect(harness.userMessages).toEqual([]);
});
