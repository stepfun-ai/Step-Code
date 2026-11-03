import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { type Component, setKeybindings } from "@step-harness/pi-tui";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { PLAN_MODE_BLOCK_VERSION } from "../src/features/plan-mode-prompt.ts";
import { getPlanFilePath } from "../src/features/plan-mode-tools.ts";
import { createStepExtension } from "../src/features/step.ts";
import { createStepPlanExtension } from "../src/features/step-plan.ts";
import { createStepTasksExtension, type StepTask } from "../src/features/step-tasks.ts";
import type { PlanReviewDetails } from "../src/render/plan-review.ts";
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
	notifications: Array<{ message: string; type?: string; options?: { transient?: boolean } }>;
	userMessages: Array<Parameters<ExtensionAPI["sendUserMessage"]>>;
	/** Hidden custom messages, so a test can assert an instruction is not in the user's bubble. */
	customMessages: Array<Parameters<ExtensionAPI["sendMessage"]>>;
	statuses: Map<string, string | undefined>;
	customCalls: () => number;
	reviewComponent: () => (Component & { handleInput?(data: string): void }) | undefined;
	activeTools: () => string[];
	emit: (event: { type: string } & Record<string, unknown>, ctx: ExtensionContext) => Promise<unknown>;
	ctx: (overrides?: Record<string, unknown>) => ExtensionContext;
}

/** Every tool the plan-mode entry has to guarantee, in Step's model-facing names. */
const PLAN_TOOLS_UNDER_TEST = [
	"read_file",
	"find_files",
	"search_files",
	"list_directory",
	"run_command",
	"clarify_user",
	"write_file",
	"edit_file",
	"exit_plan_mode",
];

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
beforeEach(() => vi.stubEnv("STEP_CODING_AGENT_PLAN_DIR", undefined));

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
	const notifications: Array<{ message: string; type?: string; options?: { transient?: boolean } }> = [];
	const userMessages: Array<Parameters<ExtensionAPI["sendUserMessage"]>> = [];
	const customMessages: Array<Parameters<ExtensionAPI["sendMessage"]>> = [];
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
		registerProvider: () => {},
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
		sendMessage: (...args: Parameters<ExtensionAPI["sendMessage"]>) => {
			customMessages.push(args);
		},
		sendUserMessage: (...args: Parameters<ExtensionAPI["sendUserMessage"]>) => {
			userMessages.push(args);
		},
		events: createEventBus(),
	} as unknown as ExtensionAPI;

	const ctx = (overrides: Record<string, unknown> = {}): ExtensionContext =>
		({
			mode: "tui",
			hasUI: true,
			// The terminal answers a plan review inside the tool call.
			planReviewSurface: false,
			cwd,
			isIdle: () => true,
			hasPendingMessages: () => false,
			hasPendingUserDecision: () => false,
			// The plan extension registers the pending-decision guard on session start;
			// the end-to-end behavior is covered by test/suite/plan-approval-gate.test.ts.
			registerAutomaticTurnGuard: () => () => {},
			ui: {
				notify: (message: string, type?: string, options?: { transient?: boolean }) => {
					notifications.push({ message, type, options });
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
		customMessages,
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

async function runTool(
	harness: Harness,
	name: string,
	params: unknown,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<unknown> {
	const tool = harness.tools.get(name);
	expect(tool, `tool ${name} is registered`).toBeDefined();
	return await tool!.execute(`${name}-call`, params as never, signal, undefined, ctx);
}

/** Enter plan mode the only way a session can: the user's /plan toggle. */
async function enterPlanMode(harness: Harness, ctx: ExtensionContext): Promise<void> {
	await harness.commands.get("plan")!.handler("", ctx);
}

const NOT_IN_PLAN_MODE =
	"Not in plan mode. Only the user starts plan mode, with /plan or --plan; continue the task in the current mode.";

function lastPlanEntry(harness: Harness): Record<string, unknown> {
	const entry = harness.appended.filter((candidate) => candidate.customType === "step-plan").at(-1);
	expect(entry, "a step-plan entry was persisted").toBeDefined();
	return entry!.data as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Legacy hidden-meta scrubbing
// ---------------------------------------------------------------------------

test("plan extension scrubs the legacy hidden meta messages", async () => {
	const harness = createHarness();
	createStepPlanExtension()(harness.api);

	// The text-mining hooks are gone; before_agent_start only announces mode changes.
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
	await enterPlanMode(harness, context);

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

test("planSource is user for /plan and cleared on exit", async () => {
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

	// Second cycle: enter, write the plan file, approved exit.
	await enterPlanMode(harness, context);
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
		{ event: "plan_mode_entered", properties: { source: "user" } },
		{ event: "plan_updated", properties: { source: "user", created: true } },
		{ event: "plan_mode_exited", properties: { source: "user", outcome: "approved" } },
	]);
});

// ---------------------------------------------------------------------------
// rpc children
// ---------------------------------------------------------------------------

test("an interactive rpc host keeps plan mode on until the user answers", async () => {
	// The web and desktop apps land here: they draw the proposal themselves, so
	// the tool must not leave the mode on submission. Leaving would let the next
	// message — a question as easily as an approval — authorize the work.
	const cwd = makeWorkspace();
	const { telemetry, events } = createTelemetryRecorder();
	const harness = createHarness({ cwd, review: [REVIEW_KEYS.enter] });
	createStepPlanExtension({ telemetry })(harness.api);
	const context = harness.ctx({ mode: "rpc", hasUI: true, planReviewSurface: true });

	await enterPlanMode(harness, context);
	const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	mkdirSync(path.dirname(planPath), { recursive: true });
	const planContents = "# The plan\n1. Do the thing\n";
	writeFileSync(planPath, planContents);

	const result = (await runTool(harness, "exit_plan_mode", {}, context)) as {
		content: Array<{ type: string; text: string }>;
		details?: PlanReviewDetails;
		terminate?: boolean;
		stopTurn?: boolean;
	};
	expect(result.content[0]?.text).toContain("Plan mode stays on");
	expect(result.content[0]?.text).toContain(planContents);
	expect(result.details).toEqual({
		outcome: "external_approval_required",
		// Who owns the decision, not what carries it: this host shows the proposal
		// and its person answers, so the answer is theirs.
		approvalSource: "user",
		planFilePath: planPath,
		planContents,
		planHash: createHash("sha256").update(planContents, "utf8").digest("hex"),
		planModeExited: false,
	});
	expect(result.terminate).toBe(true);
	expect(result.stopTurn).toBe(true);
	expect(harness.userMessages).toEqual([]);
	// Still planning: the mode, its tools, and the file boundary are untouched.
	expect(harness.activeTools()).toContain("exit_plan_mode");
	expect(harness.statuses.get("plan-mode")).toBe("Planning (user)");
	expect(lastPlanEntry(harness)).toMatchObject({ enabled: true });
	expect(events.filter((event) => event.event === "plan_mode_exited")).toEqual([]);

	// The user's approval is one decision: leave the mode and start the work.
	await harness.commands.get("plan")!.handler("approve", context);
	expect(lastPlanEntry(harness)).toMatchObject({ enabled: false });
	expect(harness.statuses.get("plan-mode")).toBeUndefined();
	// The decision is the command; the instruction it carries is hidden, so the
	// transcript does not read as two things the user said.
	expect(harness.userMessages).toEqual([]);
	expect(
		harness.customMessages.some(
			([message]) =>
				message.customType === "step-plan-approved" && String(message.content).includes("Implement it now"),
		),
	).toBe(true);
	expect(events.at(-1)).toEqual({
		event: "plan_mode_exited",
		properties: { source: "user", outcome: "approved" },
	});
});

test("an rpc child with no user behind its dialog hands approval to the caller", async () => {
	const cwd = makeWorkspace();
	const { telemetry, events } = createTelemetryRecorder();
	const harness = createHarness({ cwd, review: [REVIEW_KEYS.enter] });
	const originalTools = harness.activeTools();
	createStepPlanExtension({ telemetry })(harness.api);
	const context = harness.ctx({ mode: "rpc", hasUI: false });

	await enterPlanMode(harness, context);
	const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	mkdirSync(path.dirname(planPath), { recursive: true });
	const planContents = "# The plan\n1. Do the thing\n";
	writeFileSync(planPath, planContents);

	const result = (await runTool(harness, "exit_plan_mode", {}, context)) as {
		content: Array<{ type: string; text: string }>;
		details?: PlanReviewDetails;
		terminate?: boolean;
		stopTurn?: boolean;
	};
	expect(result.content).toEqual([
		{
			type: "text",
			text: `Cannot gate approval in this RPC host. Plan file at ${planPath}; caller should approve externally. This turn ends now; do not execute until the caller approves.\n\nPlan contents:\n${planContents}`,
		},
	]);
	expect(result.details).toEqual({
		outcome: "external_approval_required",
		approvalSource: "external",
		planFilePath: planPath,
		planContents,
		planHash: createHash("sha256").update(planContents, "utf8").digest("hex"),
		planModeExited: true,
	});
	expect(result.terminate).toBe(true);
	expect(result.stopTurn).toBe(true);
	expect(harness.userMessages).toEqual([]);

	// Nothing can answer inside the child, so it leaves and restores the tools.
	expect(harness.activeTools()).toEqual(originalTools);
	expect(harness.statuses.get("plan-mode")).toBeUndefined();
	expect(lastPlanEntry(harness)).toMatchObject({ enabled: false });
	expect(
		harness.notifications.some(
			(notification) => notification.type === "warning" && notification.message.includes("no plan-review bridge"),
		),
	).toBe(true);
	expect(events.at(-1)).toEqual({
		event: "plan_mode_exited",
		properties: { source: "user", outcome: "auto_rpc" },
	});
});

test("a submitted proposal records the reviewed snapshot as the decision fact", async () => {
	const cwd = makeWorkspace();
	const harness = createHarness({ cwd });
	createStepPlanExtension()(harness.api);
	const context = harness.ctx({ mode: "rpc", hasUI: true, planReviewSurface: true });
	await enterPlanMode(harness, context);
	const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	mkdirSync(path.dirname(planPath), { recursive: true });
	const planContents = "# Plan\n1. Do the thing\n";
	writeFileSync(planPath, planContents);
	const hash = createHash("sha256").update(planContents, "utf8").digest("hex");

	await runTool(harness, "exit_plan_mode", {}, context);
	// The fact is persisted with the mode, so a restart still knows it waits.
	expect(lastPlanEntry(harness)).toMatchObject({ enabled: true, pendingProposalHash: hash });

	// Approval clears it: nothing waits, and the mutation boundary lifts.
	await harness.commands.get("plan")!.handler("approve", context);
	expect(lastPlanEntry(harness)).toMatchObject({ enabled: false });
	expect(lastPlanEntry(harness).pendingProposalHash).toBeUndefined();
	// The decision is the command; the instruction it carries is hidden, so the
	// transcript does not read as two things the user said.
	expect(harness.userMessages).toEqual([]);
	expect(
		harness.customMessages.some(
			([message]) =>
				message.customType === "step-plan-approved" && String(message.content).includes("Implement it now"),
		),
	).toBe(true);
});

test("a review requested change clears the fact so the session does not wait on the old proposal", async () => {
	const cwd = makeWorkspace();
	const harness = createHarness({ cwd });
	createStepPlanExtension()(harness.api);
	const context = harness.ctx({ mode: "rpc", hasUI: true, planReviewSurface: true });
	await enterPlanMode(harness, context);
	const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	mkdirSync(path.dirname(planPath), { recursive: true });
	writeFileSync(planPath, "# Plan\n1. Do the thing\n");
	await runTool(harness, "exit_plan_mode", {}, context);
	expect(lastPlanEntry(harness).pendingProposalHash).toBeDefined();

	await harness.commands.get("plan")!.handler("split the second step", context);
	// The notes replace the proposal: the old snapshot is not awaiting an answer,
	// and the model is told to submit again.
	expect(lastPlanEntry(harness).pendingProposalHash).toBeUndefined();
	expect(lastPlanEntry(harness)).toMatchObject({ enabled: true });
	// The notes are the whole message. Plan mode already tells the model that
	// changes mean updating the plan and submitting again; a second hidden
	// instruction could not be kept in the same request as the notes.
	expect(harness.userMessages.at(-1)?.[0]).toBe("split the second step");
	expect(harness.customMessages).toEqual([]);
});

test("/plan approve refuses a file edited after the review", async () => {
	// Approval belongs to the snapshot the user read, the same rule the terminal
	// dialog applies by rereading the file before it leaves.
	const cwd = makeWorkspace();
	const harness = createHarness({ cwd });
	createStepPlanExtension()(harness.api);
	const context = harness.ctx({ mode: "rpc", hasUI: true, planReviewSurface: true });
	await enterPlanMode(harness, context);
	const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	mkdirSync(path.dirname(planPath), { recursive: true });
	writeFileSync(planPath, "# Plan\n1. Do the thing\n");
	await runTool(harness, "exit_plan_mode", {}, context);

	writeFileSync(planPath, "# Plan\n1. Something else entirely\n");
	await harness.commands.get("plan")!.handler("approve", context);

	// Not approved: the mode stays on and no implementation turn starts.
	expect(lastPlanEntry(harness)).toMatchObject({ enabled: true });
	expect(harness.userMessages).toEqual([]);
	expect(harness.notifications.some((notice) => /plan changed since it was submitted/.test(notice.message))).toBe(
		true,
	);
	// Nothing was decided, so the wait stays too: clearing it here would let
	// automatic work past a proposal nobody approved and no one can answer.
	expect(lastPlanEntry(harness).pendingProposalHash).toBeDefined();

	// The next review of the text that is on disk now is what can be approved.
	await runTool(harness, "exit_plan_mode", {}, context);
	await harness.commands.get("plan")!.handler("approve", context);
	expect(lastPlanEntry(harness)).toMatchObject({ enabled: false });
	expect(lastPlanEntry(harness).pendingProposalHash).toBeUndefined();
});

test("/plan approve names the proposal it answers", async () => {
	// A click knows which card it came from. A decision that arrives after a newer
	// submission must not approve that one: the file being current says nothing
	// about which proposal was on screen.
	const cwd = makeWorkspace();
	const harness = createHarness({ cwd });
	createStepPlanExtension()(harness.api);
	const context = harness.ctx({ mode: "rpc", hasUI: true, planReviewSurface: true });
	await enterPlanMode(harness, context);
	const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	mkdirSync(path.dirname(planPath), { recursive: true });
	writeFileSync(planPath, "# Plan\n1. First\n");
	await runTool(harness, "exit_plan_mode", {}, context);
	const first = String(lastPlanEntry(harness).pendingProposalHash);

	writeFileSync(planPath, "# Plan\n1. Second\n");
	await runTool(harness, "exit_plan_mode", {}, context);
	const second = String(lastPlanEntry(harness).pendingProposalHash);
	expect(second).not.toBe(first);

	await harness.commands.get("plan")!.handler(`approve ${first}`, context);
	expect(lastPlanEntry(harness)).toMatchObject({ enabled: true });
	expect(lastPlanEntry(harness).pendingProposalHash).toBe(second);
	expect(harness.notifications.some((notice) => /no longer waiting/.test(notice.message))).toBe(true);

	await harness.commands.get("plan")!.handler(`approve ${second}`, context);
	expect(lastPlanEntry(harness)).toMatchObject({ enabled: false });
	expect(lastPlanEntry(harness).pendingProposalHash).toBeUndefined();
});

test("/plan approve answers a proposal a caller handoff left waiting", async () => {
	// A host without a review surface hands approval to its caller, and text is
	// the only channel that caller has. Requiring the mode to still be on would
	// make the one verb that can answer the handoff unusable there.
	const cwd = makeWorkspace();
	const harness = createHarness({ cwd });
	createStepPlanExtension()(harness.api);
	const context = harness.ctx({ mode: "rpc", hasUI: false });
	await enterPlanMode(harness, context);
	const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	mkdirSync(path.dirname(planPath), { recursive: true });
	writeFileSync(planPath, "# Plan\n1. Do the thing\n");
	await runTool(harness, "exit_plan_mode", {}, context);
	expect(lastPlanEntry(harness)).toMatchObject({ enabled: false });
	expect(lastPlanEntry(harness).pendingProposalHash).toBeDefined();

	await harness.commands.get("plan")!.handler("approve", context);
	expect(lastPlanEntry(harness).pendingProposalHash).toBeUndefined();
	expect(harness.customMessages.some(([message]) => message.customType === "step-plan-approved")).toBe(true);
});

test("entering plan mode does not carry a proposal from an earlier round", async () => {
	// The mode had ended with a handoff still waiting. Turning planning back on is
	// not a decision about that snapshot, so it must not stay approvable.
	const cwd = makeWorkspace();
	const harness = createHarness({ cwd });
	createStepPlanExtension()(harness.api);
	const context = harness.ctx({ mode: "rpc", hasUI: false });
	await enterPlanMode(harness, context);
	const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	mkdirSync(path.dirname(planPath), { recursive: true });
	writeFileSync(planPath, "# Plan\n1. Do the thing\n");
	await runTool(harness, "exit_plan_mode", {}, context);
	expect(lastPlanEntry(harness).pendingProposalHash).toBeDefined();

	await harness.commands.get("plan")!.handler("", context);
	expect(lastPlanEntry(harness)).toMatchObject({ enabled: true });
	expect(lastPlanEntry(harness).pendingProposalHash).toBeUndefined();
});

test("a question past a submitted proposal does not release the decision", async () => {
	// The whole point of the review surface: the user is still deciding, so
	// another thing they say — a question as easily as a note — is not consent.
	const cwd = makeWorkspace();
	const harness = createHarness({ cwd });
	createStepPlanExtension()(harness.api);
	const context = harness.ctx({ mode: "rpc", hasUI: true, planReviewSurface: true });
	await enterPlanMode(harness, context);
	const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	mkdirSync(path.dirname(planPath), { recursive: true });
	writeFileSync(planPath, "# Plan\n1. Do the thing\n");
	await runTool(harness, "exit_plan_mode", {}, context);
	const waiting = lastPlanEntry(harness).pendingProposalHash;
	expect(waiting).toBeDefined();

	await startTurn(harness, context);

	expect(lastPlanEntry(harness).pendingProposalHash).toBe(waiting);
});

test("a caller handoff is settled by the next turn, because that is its only channel", async () => {
	// The mirror case: no surface to answer with, so the caller's next message is
	// the decision, and the gate lets the conversation continue.
	const cwd = makeWorkspace();
	const harness = createHarness({ cwd });
	createStepPlanExtension()(harness.api);
	const context = harness.ctx({ mode: "rpc", hasUI: false });
	await enterPlanMode(harness, context);
	const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	mkdirSync(path.dirname(planPath), { recursive: true });
	writeFileSync(planPath, "# Plan\n1. Do the thing\n");
	await runTool(harness, "exit_plan_mode", {}, context);
	expect(lastPlanEntry(harness).pendingProposalHash).toBeDefined();

	await startTurn(harness, context);

	expect(lastPlanEntry(harness).pendingProposalHash).toBeUndefined();
});

test("a caller handoff records the wait and the exit in one entry", async () => {
	// Two writes would leave a window where the branch says a proposal waits but
	// the caller never received one, or the reverse.
	const cwd = makeWorkspace();
	const harness = createHarness({ cwd });
	createStepPlanExtension()(harness.api);
	const context = harness.ctx({ mode: "rpc", hasUI: false });
	await enterPlanMode(harness, context);
	const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	mkdirSync(path.dirname(planPath), { recursive: true });
	writeFileSync(planPath, "# Plan\n1. Do the thing\n");
	const before = harness.appended.filter((entry) => entry.customType === "step-plan").length;

	await runTool(harness, "exit_plan_mode", {}, context);

	const written = harness.appended.filter((entry) => entry.customType === "step-plan");
	expect(written).toHaveLength(before + 1);
	expect(written.at(-1)?.data).toMatchObject({ enabled: false, pendingProposalHash: expect.any(String) });
});

test("/plan off answers a proposal a caller handoff left waiting", async () => {
	// Leaving is a decision too: the handoff set the wait, and the mode is already
	// off, so a `/plan off` that only looked at the mode would leave the gate held
	// with nothing left for the user to click.
	const cwd = makeWorkspace();
	const harness = createHarness({ cwd });
	createStepPlanExtension()(harness.api);
	const context = harness.ctx({ mode: "rpc", hasUI: false });
	await enterPlanMode(harness, context);
	const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	mkdirSync(path.dirname(planPath), { recursive: true });
	writeFileSync(planPath, "# Plan\n1. Do the thing\n");
	await runTool(harness, "exit_plan_mode", {}, context);
	expect(lastPlanEntry(harness).pendingProposalHash).toBeDefined();

	await harness.commands.get("plan")!.handler("off", context);
	expect(lastPlanEntry(harness)).toMatchObject({ enabled: false });
	expect(lastPlanEntry(harness).pendingProposalHash).toBeUndefined();
	// Leaving is not approving: no implementation turn starts.
	expect(harness.customMessages).toEqual([]);
});

test("/plan off is idempotent and never turns the mode back on", async () => {
	const cwd = makeWorkspace();
	const harness = createHarness({ cwd });
	createStepPlanExtension()(harness.api);
	const context = harness.ctx();

	await enterPlanMode(harness, context);
	await harness.commands.get("plan")!.handler("off", context);
	expect(lastPlanEntry(harness)).toMatchObject({ enabled: false });
	expect(harness.userMessages).toEqual([]);

	// A queued `/plan off` that arrives after the turn already left the mode must
	// not turn it back on.
	await harness.commands.get("plan")!.handler("off", context);
	expect(lastPlanEntry(harness)).toMatchObject({ enabled: false });
	expect(harness.userMessages).toEqual([]);
});

test("/plan approve refuses when no proposal is waiting", async () => {
	const cwd = makeWorkspace();
	const harness = createHarness({ cwd });
	createStepPlanExtension()(harness.api);
	const context = harness.ctx();

	await harness.commands.get("plan")!.handler("approve", context);
	expect(harness.userMessages).toEqual([]);
	expect(harness.appended.filter((entry) => entry.customType === "step-plan")).toEqual([]);
	expect(harness.notifications.some((notice) => /No plan is waiting for approval/.test(notice.message))).toBe(true);
});

test("/plan approve with text that is not a hash is refused, not read as a task", async () => {
	// The verb claims the whole input. A host that sends a truncated or upper-cased
	// hash must not have its text read as something to plan: that would drop the
	// wait it meant to answer and hand the broken hash to the model.
	const cwd = makeWorkspace();
	const harness = createHarness({ cwd });
	createStepPlanExtension()(harness.api);
	const context = harness.ctx({ mode: "rpc", hasUI: true, planReviewSurface: true });
	await enterPlanMode(harness, context);
	const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	mkdirSync(path.dirname(planPath), { recursive: true });
	writeFileSync(planPath, "# Plan\n1. Do the thing\n");
	await runTool(harness, "exit_plan_mode", {}, context);
	const waiting = lastPlanEntry(harness).pendingProposalHash;

	await harness.commands.get("plan")!.handler("approve the payment flow", context);
	// Nothing ran and nothing was decided: the wait is still there.
	expect(harness.userMessages).toEqual([]);
	expect(lastPlanEntry(harness)).toMatchObject({ enabled: true });
	expect(lastPlanEntry(harness).pendingProposalHash).toBe(waiting);
	expect(harness.notifications.some((notice) => /not a proposal hash/.test(notice.message))).toBe(true);
});

test("/plan approve accepts a hash in any case", async () => {
	const cwd = makeWorkspace();
	const harness = createHarness({ cwd });
	createStepPlanExtension()(harness.api);
	const context = harness.ctx({ mode: "rpc", hasUI: true, planReviewSurface: true });
	await enterPlanMode(harness, context);
	const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	mkdirSync(path.dirname(planPath), { recursive: true });
	writeFileSync(planPath, "# Plan\n1. Do the thing\n");
	await runTool(harness, "exit_plan_mode", {}, context);
	const hash = String(lastPlanEntry(harness).pendingProposalHash);

	await harness.commands.get("plan")!.handler(`approve ${hash.toUpperCase()}`, context);
	expect(lastPlanEntry(harness)).toMatchObject({ enabled: false });
	expect(lastPlanEntry(harness).pendingProposalHash).toBeUndefined();
});

test("/plan verbs are matched without case", async () => {
	// A host forwards what its user typed, and a capitalized verb must not fall
	// through to "plan this text": that would clear the wait it meant to answer.
	const cwd = makeWorkspace();
	const harness = createHarness({ cwd });
	createStepPlanExtension()(harness.api);
	const context = harness.ctx({ mode: "rpc", hasUI: true, planReviewSurface: true });
	await enterPlanMode(harness, context);
	const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	mkdirSync(path.dirname(planPath), { recursive: true });
	writeFileSync(planPath, "# Plan\n1. Do the thing\n");
	await runTool(harness, "exit_plan_mode", {}, context);
	const hash = String(lastPlanEntry(harness).pendingProposalHash);

	await harness.commands.get("plan")!.handler(`Approve ${hash.toUpperCase()}`, context);
	expect(lastPlanEntry(harness)).toMatchObject({ enabled: false });
	expect(lastPlanEntry(harness).pendingProposalHash).toBeUndefined();
	expect(harness.userMessages).toEqual([]);

	// `OFF` leaves without implementing anything.
	await enterPlanMode(harness, context);
	await harness.commands.get("plan")!.handler("OFF", context);
	expect(lastPlanEntry(harness)).toMatchObject({ enabled: false });
	expect(harness.userMessages).toEqual([]);
});

test("a pending write the branch rejects leaves nothing waiting", async () => {
	// A wait nobody recorded would hold every automatic turn back with no visible
	// cause; a decision nobody recorded would let work past an unapproved plan.
	const cwd = makeWorkspace();
	const harness = createHarness({ cwd });
	createStepPlanExtension()(harness.api);
	const context = harness.ctx({ mode: "rpc", hasUI: true, planReviewSurface: true });
	await enterPlanMode(harness, context);
	const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	mkdirSync(path.dirname(planPath), { recursive: true });
	writeFileSync(planPath, "# Plan\n1. Do the thing\n");

	const append = harness.api.appendEntry;
	harness.api.appendEntry = (type, data) => {
		if (type === "step-plan" && data && typeof data === "object" && "pendingProposalHash" in data) {
			throw new Error("persist failed");
		}
		append(type, data);
	};
	await expect(runTool(harness, "exit_plan_mode", {}, context)).rejects.toThrow("persist failed");
	harness.api.appendEntry = append;

	// The memory agreed with the branch again: nothing waits, so approve refuses
	// and the mode is still on with its boundary intact.
	await harness.commands.get("plan")!.handler("approve", context);
	expect(harness.notifications.some((notice) => /No plan is waiting for approval/.test(notice.message))).toBe(true);
	expect(lastPlanEntry(harness)).toMatchObject({ enabled: true });
	expect(lastPlanEntry(harness).pendingProposalHash).toBeUndefined();
});

test("a revision requested mid-run is queued behind the running turn", async () => {
	// The notes are the whole message, so there is no second delivery to fall out
	// of step with them.
	const cwd = makeWorkspace();
	const harness = createHarness({ cwd });
	createStepPlanExtension()(harness.api);
	const context = harness.ctx({ mode: "rpc", hasUI: true, planReviewSurface: true });
	await enterPlanMode(harness, context);
	const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	mkdirSync(path.dirname(planPath), { recursive: true });
	writeFileSync(planPath, "# Plan\n1. Do the thing\n");
	await runTool(harness, "exit_plan_mode", {}, context);

	await harness.commands.get("plan")!.handler(
		"split the second step",
		harness.ctx({
			mode: "rpc",
			hasUI: true,
			planReviewSurface: true,
			isIdle: () => false,
		}),
	);

	// The words are the user's, forwarded. A proposal submitted by the turn they
	// waited behind must not turn their change request into extension traffic that
	// the pending-decision guard holds back.
	expect(harness.userMessages.at(-1)).toEqual([
		"split the second step",
		{ expandPromptTemplates: true, deliverAs: "followUp" },
	]);
	expect(harness.customMessages).toEqual([]);
	// The old proposal is no longer waiting, so the session holds no gate while
	// the model revises and submits again.
	expect(lastPlanEntry(harness)).toMatchObject({ enabled: true });
	expect(lastPlanEntry(harness).pendingProposalHash).toBeUndefined();
});

/**
 * A branch as an earlier process left it.
 *
 * The extension is mounted after the entries exist, so `session_start` replays
 * them the way a restart does: nothing here comes from this process's memory.
 */
function resumedHarness(options: {
	cwd: string;
	planEntry: Record<string, unknown>;
	handoff: { planHash: string; planFilePath: string; planContents: string };
	afterHandoff?: { customType: string; data: unknown };
}): Harness {
	const harness = createHarness({ cwd: options.cwd });
	harness.session.appendCustomEntry("step-plan", options.planEntry);
	harness.session.appendMessage({
		role: "toolResult",
		toolCallId: "resumed-handoff",
		toolName: "exit_plan_mode",
		content: [{ type: "text", text: `Review this plan.\n\n${options.handoff.planContents}` }],
		details: {
			outcome: "external_approval_required",
			approvalSource: "external",
			planFilePath: options.handoff.planFilePath,
			planContents: options.handoff.planContents,
			planHash: options.handoff.planHash,
			planModeExited: true,
		},
		isError: false,
		timestamp: Date.now(),
	});
	if (options.afterHandoff) {
		harness.session.appendCustomEntry(options.afterHandoff.customType, options.afterHandoff.data);
	}
	createStepPlanExtension()(harness.api);
	return harness;
}

test("a waiting proposal survives a restart", async () => {
	// The wait is the session fact, so a new process reads it back instead of
	// trusting that the transcript looks like a handoff.
	const cwd = makeWorkspace();
	const planContents = "# Plan\n1. Do the thing\n";
	const planFilePath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	mkdirSync(path.dirname(planFilePath), { recursive: true });
	writeFileSync(planFilePath, planContents);
	const planHash = createHash("sha256").update(planContents, "utf8").digest("hex");

	const harness = resumedHarness({
		cwd,
		planEntry: { version: 3, enabled: false, planFilePath, pendingProposalHash: planHash },
		handoff: { planHash, planFilePath, planContents },
	});
	await restoreLifecycle(harness, "session_start");

	await harness.commands.get("plan")!.handler("approve", harness.ctx());
	expect(lastPlanEntry(harness).pendingProposalHash).toBeUndefined();
	expect(harness.customMessages.some(([message]) => message.customType === "step-plan-approved")).toBe(true);
});

test("a session written before the decision fact keeps its gate after an upgrade", async () => {
	// Those builds recorded the wait only in the transcript, so the fact is read
	// back from the handoff once — otherwise upgrading would silently release a
	// proposal nobody answered.
	const cwd = makeWorkspace();
	const planContents = "# Plan\n1. Do the thing\n";
	const planFilePath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	mkdirSync(path.dirname(planFilePath), { recursive: true });
	writeFileSync(planFilePath, planContents);
	const planHash = createHash("sha256").update(planContents, "utf8").digest("hex");

	const harness = resumedHarness({
		cwd,
		planEntry: { version: 2, enabled: false, planFilePath },
		handoff: { planHash, planFilePath, planContents },
	});
	const before = harness.appended.filter((entry) => entry.customType === "step-plan").length;
	await restoreLifecycle(harness, "session_start");

	// Written back once, so the branch — which every reader consults — carries the
	// wait too, not just this process's memory.
	const written = harness.appended.filter((entry) => entry.customType === "step-plan");
	expect(written).toHaveLength(before + 1);
	expect(written.at(-1)?.data).toMatchObject({ version: 3, enabled: false, pendingProposalHash: planHash });

	// A second restore reads version 3 and leaves the branch alone.
	const afterFirst = harness.appended.length;
	await restoreLifecycle(harness, "session_start");
	expect(harness.appended).toHaveLength(afterFirst);

	await harness.commands.get("plan")!.handler("approve", harness.ctx());
	expect(lastPlanEntry(harness).pendingProposalHash).toBeUndefined();
	expect(harness.customMessages.some(([message]) => message.customType === "step-plan-approved")).toBe(true);
});

test("an older entry that already carries the fact keeps it instead of re-deriving it", async () => {
	// A build that wrote `pendingProposalHash` under `version: 2` keeps a wait even
	// when the user asked a question after submitting. The transcript scan cannot
	// see that — it stops at the user message — so re-deriving would drop a wait
	// the branch still reports.
	const cwd = makeWorkspace();
	const planContents = "# Plan\n1. Do the thing\n";
	const planFilePath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	mkdirSync(path.dirname(planFilePath), { recursive: true });
	writeFileSync(planFilePath, planContents);
	const planHash = createHash("sha256").update(planContents, "utf8").digest("hex");

	const harness = createHarness({ cwd });
	harness.session.appendCustomEntry("step-plan", {
		version: 2,
		enabled: true,
		planFilePath,
		pendingProposalHash: planHash,
	});
	harness.session.appendMessage({
		role: "toolResult",
		toolCallId: "handoff",
		toolName: "exit_plan_mode",
		content: [{ type: "text", text: `Review this plan.\n\n${planContents}` }],
		details: {
			outcome: "external_approval_required",
			planFilePath,
			planContents,
			planHash,
			planModeExited: false,
		},
		isError: false,
		timestamp: Date.now(),
	});
	// The user is still deciding; a question is not an answer.
	harness.session.appendMessage({
		role: "user",
		content: [{ type: "text", text: "Why the second step?" }],
		timestamp: Date.now(),
	});
	createStepPlanExtension()(harness.api);
	const before = harness.appended.filter((entry) => entry.customType === "step-plan").length;
	await restoreLifecycle(harness, "session_start");

	// Nothing was migrated away: the recorded fact is the answer.
	expect(harness.appended.filter((entry) => entry.customType === "step-plan")).toHaveLength(before);
	await harness.commands.get("plan")!.handler("approve", harness.ctx());
	expect(lastPlanEntry(harness).pendingProposalHash).toBeUndefined();
	expect(harness.customMessages.some(([message]) => message.customType === "step-plan-approved")).toBe(true);
});

test("a legacy handoff behind a summary is not restored as a wait", async () => {
	// The old gate scanned the conversation the model reads; a summary boundary
	// means the handoff is no longer in it, so a wait restored from behind one is
	// a wait nobody can be shown a proposal for.
	const cwd = makeWorkspace();
	const planContents = "# Plan\n1. Do the thing\n";
	const planFilePath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	mkdirSync(path.dirname(planFilePath), { recursive: true });
	writeFileSync(planFilePath, planContents);
	const planHash = createHash("sha256").update(planContents, "utf8").digest("hex");

	const harness = resumedHarness({
		cwd,
		planEntry: { version: 2, enabled: false, planFilePath },
		handoff: { planHash, planFilePath, planContents },
	});
	harness.session.appendCompaction("Earlier work summarized.", harness.session.getEntries()[0]!.id, 1_000);
	await restoreLifecycle(harness, "session_start");

	await harness.commands.get("plan")!.handler("approve", harness.ctx());
	expect(harness.notifications.some((notice) => /No plan is waiting for approval/.test(notice.message))).toBe(true);
	expect(harness.customMessages).toEqual([]);
});

test("a plan entry after a legacy handoff is not replayed as a decision", async () => {
	// The user left, or turned planning back on, after the handoff. That is a later
	// transition, and the migration must not resurrect the proposal it replaced.
	const cwd = makeWorkspace();
	const planContents = "# Plan\n1. Do the thing\n";
	const planFilePath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	mkdirSync(path.dirname(planFilePath), { recursive: true });
	writeFileSync(planFilePath, planContents);
	const planHash = createHash("sha256").update(planContents, "utf8").digest("hex");

	const harness = resumedHarness({
		cwd,
		planEntry: { version: 2, enabled: false, planFilePath },
		handoff: { planHash, planFilePath, planContents },
		afterHandoff: { customType: "step-plan", data: { version: 2, enabled: false, planFilePath } },
	});
	await restoreLifecycle(harness, "session_start");

	await harness.commands.get("plan")!.handler("approve", harness.ctx());
	expect(harness.notifications.some((notice) => /No plan is waiting for approval/.test(notice.message))).toBe(true);
	expect(harness.customMessages).toEqual([]);
});

test("tui-mode exit_plan_mode still gates through the review dialog", async () => {
	const cwd = makeWorkspace();
	const harness = createHarness({ cwd, review: [REVIEW_KEYS.escape] });
	createStepPlanExtension()(harness.api);
	const context = harness.ctx();

	await enterPlanMode(harness, context);
	const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	mkdirSync(path.dirname(planPath), { recursive: true });
	writeFileSync(planPath, "# The plan\n");

	const result = (await runTool(harness, "exit_plan_mode", {}, context)) as {
		content: Array<{ type: string; text: string }>;
		terminate?: boolean;
		stopTurn?: boolean;
	};
	expect(harness.customCalls()).toBe(1);
	expect(result.content[0]!.text).toContain("Staying in plan mode.");
	expect(harness.statuses.get("plan-mode")).toBe("Planning (user)");
	// Escape hands the turn back to the user. Without this the model re-submits
	// the unchanged plan straight away and the dialog re-opens on every Escape.
	expect(result.terminate).toBe(true);
	expect(result.stopTurn).toBe(true);
	expect(result.content[0]!.text).toContain("do not call exit_plan_mode again");
});

test.each([
	{ keys: [REVIEW_KEYS.enter], terminate: false, outcome: "approved" },
	{
		keys: [REVIEW_KEYS.down, ...typeReview("use canvas"), REVIEW_KEYS.enter],
		terminate: false,
		outcome: "feedback",
		feedback: "use canvas",
	},
	{ keys: [REVIEW_KEYS.escape], terminate: true, outcome: "dismissed" },
	{ keys: [], terminate: true, outcome: "dismissed" },
])(
	"interactive $outcome reports its exit state and termination (keys: $keys)",
	async ({ keys, terminate, outcome, feedback }) => {
		const cwd = makeWorkspace();
		const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
		const planContents = "# The plan\n";
		const harness = createHarness({ cwd, review: keys });
		createStepPlanExtension()(harness.api);
		await enterPlanMode(harness, harness.ctx());
		mkdirSync(path.dirname(planPath), { recursive: true });
		writeFileSync(planPath, planContents);

		const result = (await runTool(harness, "exit_plan_mode", {}, harness.ctx())) as {
			terminate?: boolean;
			details?: PlanReviewDetails;
		};
		expect(result.terminate).toBe(terminate);
		// Every reviewed outcome carries the complete snapshot after the dialog closes.
		expect(result.details).toEqual({
			planFilePath: planPath,
			planContents,
			planHash: createHash("sha256").update(planContents, "utf8").digest("hex"),
			planModeExited: outcome === "approved",
			approvalSource: "user",
			outcome,
			...(feedback === undefined ? {} : { feedback }),
		});
		expect(result.details?.planModeExited).toBe(!lastPlanEntry(harness).enabled);
	},
);

// ---------------------------------------------------------------------------
// Shared entry and branch-local restoration
// ---------------------------------------------------------------------------

test("plan extension registers only the plan command and the exit tool; the model cannot enter plan mode", () => {
	const harness = createHarness();
	createStepPlanExtension()(harness.api);
	expect([...harness.commands.keys()]).toEqual(["plan"]);
	expect([...harness.tools.keys()]).toEqual(["exit_plan_mode"]);
});

const planEntryCases = ["/plan", "--plan"].flatMap((entry) =>
	[false, true].map((external) => [entry, external] as const),
);

test.each(planEntryCases)(
	"%s preserves tools and announces a writable plan path (external storage: %s)",
	async (entry, external) => {
		const cwd = makeWorkspace();
		const planDir = external ? path.join(makeWorkspace(), "runtime plans") : path.join(cwd, ".stepcode", "plans");
		if (external) vi.stubEnv("STEP_CODING_AGENT_PLAN_DIR", planDir);
		const { telemetry, events } = createTelemetryRecorder();
		const harness = createHarness({ cwd, flags: { plan: entry === "--plan" } });
		const originalTools = ["read_file", "run_command", "write", "edit", "custom_tool"];
		harness.api.setActiveTools(originalTools);
		createStepPlanExtension({ telemetry })(harness.api);
		const context = harness.ctx();
		if (entry === "/plan") await enterPlanMode(harness, context);
		else await harness.emit({ type: "session_start", reason: "startup" }, context);

		const planPath = path.join(planDir, "session-sess-1.md");
		expect(fs.existsSync(planDir)).toBe(false);
		const source = "user";
		expect(lastPlanEntry(harness)).toMatchObject({
			version: 3,
			enabled: true,
			planSource: source,
			planFilePath: planPath,
		});
		// This build appends instead of narrowing, so it stores no replaced list.
		expect(lastPlanEntry(harness)).not.toHaveProperty("toolsBeforePlanMode");
		expect(harness.activeTools()).toEqual(
			expect.arrayContaining(["write_file", "edit_file", "run_command", "custom_tool"]),
		);
		// Plan mode narrows permissions, not the tool block: the aliases stay
		// visible and the tool_call policy below is what blocks them. Dropping
		// them would rewrite the request's tool block and discard the provider's
		// cached prompt prefix for the whole conversation.
		expect(harness.activeTools()).toContain("write");
		expect(harness.activeTools()).toContain("edit");
		expect(harness.notifications.at(-1)?.message).toContain(planPath);
		expect(harness.notifications.at(-1)?.message).not.toContain("command execution are disabled");
		// The guard is the only enforcement now that the editing tools stay
		// visible, and the file tools resolve through resolveToCwd. Every accepted
		// spelling below must therefore mean the same file the tools will write.
		const accepted = [
			path.relative(cwd, planPath),
			planPath,
			`@${path.relative(cwd, planPath)}`,
			path.join(cwd, "..", path.basename(cwd), path.relative(cwd, planPath)),
		];
		// A narrowed-but-not-normalized target stays blocked: these all point
		// somewhere else even though they look like the plan path.
		const rejected = [
			"src/app.ts",
			".stepcode/config.toml",
			path.join(planDir, "other-plan.md"),
			"@src/app.ts",
			" src/app.ts",
			path.join(path.relative(cwd, planPath), "..", "..", "evil.md"),
		];
		for (const toolName of ["write_file", "edit_file", "write", "edit"]) {
			for (const target of accepted) {
				await expect(
					harness.emit({ type: "tool_call", toolName, input: { path: target } }, context),
				).resolves.toBeUndefined();
			}
			for (const target of rejected) {
				await expect(
					harness.emit({ type: "tool_call", toolName, input: { path: target } }, context),
				).resolves.toMatchObject({ block: true });
			}
		}
		await expect(
			harness.emit({ type: "tool_call", toolName: "run_command", input: { command: "git status" } }, context),
		).resolves.toBeUndefined();

		const snapshotsBefore = harness.appended.length;
		const telemetryBefore = events.length;
		const toolsBefore = harness.activeTools();
		// `/plan <task>` while planning hands over the task without re-entering.
		await harness.commands.get("plan")!.handler("refine the proposal", context);
		expect(harness.userMessages.at(-1)).toEqual(["refine the proposal", { expandPromptTemplates: true }]);
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

test("entering and leaving plan mode keeps an equivalent tool set in its original order", async () => {
	const cwd = makeWorkspace();
	const harness = createHarness({ cwd });
	// A real Step profile already offers every plan tool, including clarify_user,
	// so plan mode narrows permissions without changing the capability set.
	const originalTools = [
		"clarify_user",
		"exit_plan_mode",
		"list_directory",
		"find_files",
		"search_files",
		"read_file",
		"write_file",
		"edit_file",
		"run_command",
		"find_tools",
		"custom_tool",
	];
	harness.api.setActiveTools(originalTools);
	const applied: string[][] = [];
	const setActiveTools = harness.api.setActiveTools.bind(harness.api);
	harness.api.setActiveTools = (names: string[]) => {
		applied.push([...names]);
		setActiveTools(names);
	};

	createStepPlanExtension()(harness.api);
	const context = harness.ctx();
	await harness.commands.get("plan")!.handler("", context);

	// Reapplying the same set in a different order rewrites the request's tool
	// block and drops the provider prompt cache for the whole conversation.
	expect(harness.activeTools()).toEqual(originalTools);
	expect(applied).toEqual([]);

	// Plan-file writes stay gated by the tool_call path check, not by absence.
	const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	await expect(
		harness.emit(
			{ type: "tool_call", toolName: "write_file", input: { path: path.relative(cwd, planPath) } },
			context,
		),
	).resolves.toBeUndefined();
	await expect(
		harness.emit({ type: "tool_call", toolName: "write_file", input: { path: "src/app.ts" } }, context),
	).resolves.toMatchObject({ block: true });

	await harness.commands.get("plan")!.handler("", context);
	expect(harness.activeTools()).toEqual(originalTools);
	expect(applied).toEqual([]);
});

test("entering plan mode appends only the plan tools a profile lacks", async () => {
	const cwd = makeWorkspace();
	const harness = createHarness({ cwd });
	// A Pi-native profile has the editing aliases but not the Step names, so
	// plan mode has to add them — and must not remove anything to do it.
	const originalTools = ["read_file", "write", "edit", "custom_tool"];
	harness.api.setActiveTools(originalTools);
	const applied: string[][] = [];
	const setActiveTools = harness.api.setActiveTools.bind(harness.api);
	harness.api.setActiveTools = (names: string[]) => {
		applied.push([...names]);
		setActiveTools(names);
	};

	createStepPlanExtension()(harness.api);
	const context = harness.ctx();

	await harness.commands.get("plan")!.handler("", context);
	expect(applied).toEqual([
		[
			...originalTools,
			"find_files",
			"search_files",
			"list_directory",
			"run_command",
			"clarify_user",
			"write_file",
			"edit_file",
			"exit_plan_mode",
		],
	]);
	// Existing order is preserved and nothing is dropped.
	expect(harness.activeTools().slice(0, originalTools.length)).toEqual(originalTools);
	expect(harness.activeTools()).toContain("write");
	expect(harness.activeTools()).toContain("edit");

	// The aliases stay visible; the policy blocks the mutation instead.
	await expect(
		harness.emit({ type: "tool_call", toolName: "write", input: { path: "src/app.ts" } }, context),
	).resolves.toMatchObject({ block: true });

	await harness.commands.get("plan")!.handler("", context);
	expect(harness.activeTools()).toEqual(originalTools);
	expect(applied).toHaveLength(2);
});

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
		vi.stubEnv("STEP_CODING_AGENT_PLAN_DIR", path.join(makeWorkspace(), "new-plans"));
		const { telemetry, events } = createTelemetryRecorder();
		const harness = createHarness({ cwd });
		const root = harness.session.appendCustomEntry("branch-root");
		const pathA = path.join(cwd, ".stepcode", "plans", "proposal-a.md");
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
			harness.api.registerTool({ ...harness.tools.get("exit_plan_mode")!, name });
		}
		harness.api.setActiveTools([...harness.activeTools(), "branch_a_tool", "branch_b_tool"]);

		await restoreLifecycle(harness, type);
		expect(harness.statuses.get("plan-mode")).toBe("Planning (user)");
		expect(harness.activeTools()).toContain("branch_a_tool");
		expect(harness.activeTools()).not.toContain("branch_b_tool");
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
		await expect(
			harness.emit({ type: "tool_call", toolName: "edit_file", input: { path: pathB } }, harness.ctx()),
		).resolves.toBeUndefined();
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
			content: [{ text: NOT_IN_PLAN_MODE }],
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
		harness.api.registerTool({ ...harness.tools.get("exit_plan_mode")!, name });
	}
	for (let attempt = 0; attempt < 2; attempt++) {
		await restoreLifecycle(harness, "session_start");
		expect(harness.statuses.get("plan-mode")).toBeUndefined();
		expect(harness.activeTools()).toEqual(originalTools);
	}
	expect(harness.appended).toEqual([]);

	// Restoring an off snapshot must not leave a transient planning baseline.
	// This build appends instead of narrowing, so a new entry records no replaced
	// list and exit reverses only what the entry actually added.
	const changedTools = ["read_file", "new_tool"];
	harness.api.setActiveTools(changedTools);
	await harness.commands.get("plan")!.handler("", harness.ctx());
	expect(lastPlanEntry(harness)).toMatchObject({ version: 3, enabled: true });
	expect(lastPlanEntry(harness)).not.toHaveProperty("toolsBeforePlanMode");
	await harness.commands.get("plan")!.handler("", harness.ctx());
	expect(harness.activeTools()).toEqual(changedTools);
});

test("exiting plan mode removes only the tools entering added", async () => {
	const harness = createHarness();
	// A Pi-native profile lacks the Step aliases, so entering really does add.
	harness.api.setActiveTools(["read_file", "write", "edit", "custom_tool"]);
	createStepPlanExtension()(harness.api);
	// Register the custom names too: the real session drops unknown names, so a
	// test that relies on them must not depend on the stub echoing everything.
	for (const name of ["custom_tool", "late_tool"]) {
		harness.api.registerTool({ ...harness.tools.get("exit_plan_mode")!, name });
	}
	const context = harness.ctx();

	await harness.commands.get("plan")!.handler("", context);
	expect(harness.activeTools()).toEqual(
		expect.arrayContaining(["read_file", "write", "edit", "custom_tool", "write_file", "edit_file"]),
	);

	// A tool activated while planning (a late MCP catalog, find_tools) must keep
	// its place: exit undoes its own addition instead of replaying a snapshot.
	harness.api.setActiveTools([...harness.activeTools(), "late_tool"]);
	await harness.commands.get("plan")!.handler("", context);

	expect(harness.activeTools()).toEqual(["read_file", "write", "edit", "custom_tool", "late_tool"]);
});

test("a legacy todo migration keeps the replaced tool list for later restores", async () => {
	// Migration rewrites the entry. Dropping the snapshot here would strand the
	// branch: the next restore could no longer tell which list plan mode replaced.
	const originalTools = ["read_file", "write", "edit"];
	const harness = createHarness({
		entries: [
			{
				type: "custom",
				customType: "step-plan",
				data: {
					enabled: true,
					planSource: "user",
					toolsBeforePlanMode: originalTools,
					todos: [{ text: "Legacy task" }],
				},
			},
		],
	});
	createStepPlanExtension()(harness.api);
	await restoreLifecycle(harness, "session_start");

	const migrated = lastPlanEntry(harness);
	expect(migrated).toMatchObject({ version: 3, enabled: true });
	expect(migrated.toolsBeforePlanMode).toEqual(originalTools);

	// A fresh process must replay that list, not fall back to the profile default.
	harness.session.resetLeaf?.();
	await restoreLifecycle(harness, "session_start");
	expect(harness.activeTools()).toEqual(expect.arrayContaining(originalTools));
});

test("a plan entry that adds nothing records no replaced tool list", async () => {
	const harness = createHarness();
	const live = [...PLAN_TOOLS_UNDER_TEST, "find_tools"];
	harness.api.setActiveTools(live);
	const applied: string[][] = [];
	const setActiveTools = harness.api.setActiveTools.bind(harness.api);
	harness.api.setActiveTools = (names: string[]) => {
		applied.push([...names]);
		setActiveTools(names);
	};
	createStepPlanExtension()(harness.api);

	await harness.commands.get("plan")!.handler("", harness.ctx());
	expect(lastPlanEntry(harness)).not.toHaveProperty("toolsBeforePlanMode");
	await harness.commands.get("plan")!.handler("", harness.ctx());

	// Enter, exit, and the persisted snapshot all leave the list alone.
	expect(applied).toEqual([]);
	expect(harness.activeTools()).toEqual(live);
});

test("restoring a new-format plan branch reapplies nothing", async () => {
	const harness = createHarness({
		entries: [{ type: "custom", customType: "step-plan", data: { version: 2, enabled: true } }],
	});
	const live = [...PLAN_TOOLS_UNDER_TEST, "find_tools", "custom_tool"];
	harness.api.setActiveTools(live);
	const applied: string[][] = [];
	const setActiveTools = harness.api.setActiveTools.bind(harness.api);
	harness.api.setActiveTools = (names: string[]) => {
		applied.push([...names]);
		setActiveTools(names);
	};
	createStepPlanExtension()(harness.api);

	await restoreLifecycle(harness, "session_start");

	expect(harness.statuses.get("plan-mode")).toBe("Planning (unknown)");
	expect(applied).toEqual([]);
	expect(harness.activeTools()).toEqual(live);
});

test("a stale legacy baseline is not replayed onto a newer plan entry", async () => {
	// Entry 1 narrowed the list and recorded what it replaced. Entry 3 was written
	// by this build, which never narrows; replaying entry 1 here would reorder the
	// current list and drop tools the newer branch never touched.
	const harness = createHarness({
		entries: [
			{ type: "custom", customType: "step-plan", data: { enabled: true, toolsBeforePlanMode: ["read_file"] } },
			{ type: "custom", customType: "step-plan", data: { enabled: false } },
			{ type: "custom", customType: "step-plan", data: { version: 2, enabled: true } },
		],
	});
	createStepPlanExtension()(harness.api);
	const live = [
		"find_tools",
		"read_file",
		"find_files",
		"search_files",
		"list_directory",
		"run_command",
		"clarify_user",
		"write_file",
		"edit_file",
		"exit_plan_mode",
		"late_tool",
	];
	harness.api.setActiveTools(live);
	const applied: string[][] = [];
	const setActiveTools = harness.api.setActiveTools.bind(harness.api);
	harness.api.setActiveTools = (names: string[]) => {
		applied.push([...names]);
		setActiveTools(names);
	};

	await restoreLifecycle(harness, "session_start");
	expect(harness.statuses.get("plan-mode")).toBe("Planning (unknown)");
	// Every plan tool was already live, so the entry adds nothing and the stale
	// baseline is never applied: same list, same order.
	expect(applied).toEqual([]);
	expect(harness.activeTools()).toEqual(live);
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
		await enterPlanMode(harness, harness.ctx());
		expect(lastPlanEntry(harness)).toMatchObject({
			version: 3,
			planFilePath: path.join(cwd, ".stepcode", "plans", "session-sess-1.md"),
			planSource: "user",
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
	await enterPlanMode(harness, harness.ctx());
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

test.each([undefined, "", " \t "])("plan storage keeps the legacy default for %j", (value) => {
	vi.stubEnv("STEP_CODING_AGENT_PLAN_DIR", value);
	const cwd = makeWorkspace();
	expect(getPlanFilePath("sess-1", cwd)).toBe(path.join(cwd, ".stepcode", "plans", "session-sess-1.md"));
	expect(getPlanFilePath("sess-1")).toBe(path.join(process.cwd(), ".stepcode", "plans", "session-sess-1.md"));
});

test("plan storage resolves absolute, session-relative and home-relative overrides", () => {
	const cwd = path.join(makeWorkspace(), "project");
	const external = path.join(makeWorkspace(), "plans with spaces");
	for (const [value, expected] of [
		[`  ${external}  `, external],
		["../runtime plans", path.resolve(cwd, "../runtime plans")],
		["~/runtime-plans", path.join(homedir(), "runtime-plans")],
	]) {
		vi.stubEnv("STEP_CODING_AGENT_PLAN_DIR", value);
		expect(getPlanFilePath("sess-1", cwd)).toBe(path.join(expected, "session-sess-1.md"));
	}
});

test("the selected external plan path stays pinned until a fresh session", async () => {
	const cwd = makeWorkspace();
	const firstRoot = makeWorkspace();
	const nextRoot = makeWorkspace();
	vi.stubEnv("STEP_CODING_AGENT_PLAN_DIR", firstRoot);
	const harness = createHarness({ cwd });
	createStepPlanExtension()(harness.api);
	await enterPlanMode(harness, harness.ctx());
	const firstPath = path.join(firstRoot, "session-sess-1.md");
	expect(lastPlanEntry(harness).planFilePath).toBe(firstPath);
	vi.stubEnv("STEP_CODING_AGENT_PLAN_DIR", nextRoot);
	for (const type of ["session_start", "session_tree"] as const) {
		await restoreLifecycle(harness, type);
		await expect(
			harness.emit({ type: "tool_call", toolName: "write_file", input: { path: firstPath } }, harness.ctx()),
		).resolves.toBeUndefined();
	}
	vi.stubEnv("STEP_CODING_AGENT_PLAN_DIR", undefined);
	await harness.commands.get("plan")!.handler("", harness.ctx());
	await restoreLifecycle(harness, "session_start");
	await enterPlanMode(harness, harness.ctx());
	expect(lastPlanEntry(harness).planFilePath).toBe(firstPath);
	vi.stubEnv("STEP_CODING_AGENT_PLAN_DIR", nextRoot);
	harness.session.newSession({ id: "sess-2" });
	await harness.emit({ type: "session_start", reason: "new" }, harness.ctx());
	await enterPlanMode(harness, harness.ctx());
	expect(lastPlanEntry(harness).planFilePath).toBe(path.join(nextRoot, "session-sess-2.md"));
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

for (const { mode, hasUI } of [
	{ mode: "tui", hasUI: true },
	{ mode: "print", hasUI: false },
	{ mode: "rpc", hasUI: true },
	{ mode: "rpc", hasUI: false },
] as const) {
	test(`exit_plan_mode without active planning has no handoff in ${mode} (hasUI: ${hasUI})`, async () => {
		const harness = createHarness({ cwd: makeWorkspace() });
		createStepPlanExtension()(harness.api);
		expect(await runTool(harness, "exit_plan_mode", {}, harness.ctx({ mode, hasUI }))).toEqual({
			content: [{ type: "text", text: NOT_IN_PLAN_MODE }],
			details: undefined,
			terminate: false,
		});
		expect(harness.appended).toEqual([]);
		expect(harness.customCalls()).toBe(0);
	});

	test.each(["missing", "empty", "whitespace", "directory", "unreadable"])(
		`exit_plan_mode refuses %s proposal files in ${mode} (hasUI: ${hasUI}) before approval or exit`,
		async (invalid) => {
			const cwd = makeWorkspace();
			const { telemetry, events } = createTelemetryRecorder();
			const select = vi.fn(async () => "Execute the plan");
			const harness = createHarness({ cwd, select });
			createStepPlanExtension({ telemetry })(harness.api);
			const context = harness.ctx({ mode, hasUI });
			await enterPlanMode(harness, context);
			const noticesAfterEntry = harness.notifications.length;
			const planningTools = harness.activeTools();
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
				details?: PlanReviewDetails;
				terminate?: boolean;
			};
			expect(result.details).toBeUndefined();
			expect(result.terminate).toBe(false);
			expect(harness.customCalls()).toBe(0);
			expect(harness.activeTools()).toEqual(planningTools);
			expect(select).not.toHaveBeenCalled();
			expect(result.content[0].text).toContain(planPath);
			expect(result.content[0].text).toContain("exit_plan_mode");
			expect(result.content[0].text).toMatch(/write_file|readable|regular file/i);
			expect(lastPlanEntry(harness).enabled).toBe(true);
			expect(harness.appended).toHaveLength(1);
			expect(harness.statuses.get("plan-mode")).toBe("Planning (user)");
			expect(events).toEqual([{ event: "plan_mode_entered", properties: { source: "user" } }]);
			expect(harness.notifications).toHaveLength(noticesAfterEntry);
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
	await enterPlanMode(harness, harness.ctx());
	const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	mkdirSync(path.dirname(planPath), { recursive: true });
	const proposal = "Change the parser, add focused regression coverage, then verify the result.";
	writeFileSync(planPath, proposal);

	const result = (await runTool(harness, "exit_plan_mode", {}, harness.ctx())) as { stopTurn?: boolean };
	expect(harness.customCalls()).toBe(1);
	expect(harness.userMessages).toEqual([]);
	// A decision barrier ends the turn even though a sibling result may not ask to.
	expect(result.stopTurn).toBe(approved ? undefined : true);
	if (approved) {
		expect(lastPlanEntry(harness)).toMatchObject({ enabled: false, planSource: undefined });
		expect(harness.activeTools()).toEqual(originalTools);
		expect(events.at(-1)).toEqual({
			event: "plan_mode_exited",
			properties: { source: "user", outcome: "approved" },
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
		await enterPlanMode(harness, harness.ctx());
		const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
		mkdirSync(path.dirname(planPath), { recursive: true });
		writeFileSync(planPath, "Draft proposal.");

		const result = await runTool(harness, "exit_plan_mode", {}, harness.ctx());
		expect((result as { stopTurn?: boolean }).stopTurn).toBeUndefined();
		expect(lastPlanEntry(harness).enabled).toBe(true);
		expect(harness.appended).toHaveLength(1);
		expect(harness.statuses.get("plan-mode")).toBe("Planning (user)");
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
	await enterPlanMode(harness, harness.ctx());
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

test("a valid headless proposal exits requiring external approval with the whole plan", async () => {
	const cwd = makeWorkspace();
	const { telemetry, events } = createTelemetryRecorder();
	const select = vi.fn(async () => "Execute the plan");
	const harness = createHarness({ cwd, select });
	const originalTools = harness.activeTools();
	createStepPlanExtension({ telemetry })(harness.api);
	const context = harness.ctx({ mode: "print", hasUI: false });
	await enterPlanMode(harness, context);
	const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	mkdirSync(path.dirname(planPath), { recursive: true });
	const planContents = `${"p".repeat(2000)}tail of the plan`;
	writeFileSync(planPath, planContents);

	const result = (await runTool(harness, "exit_plan_mode", {}, context)) as {
		content: Array<{ text: string }>;
		details?: PlanReviewDetails;
		terminate?: boolean;
		stopTurn?: boolean;
	};
	expect(result.content).toEqual([
		{
			type: "text",
			text: `Plan mode exited. Plan file kept at ${planPath} for reference.\n\nPlan contents:\n${planContents}\n\nCannot show interactive prompt; caller must gate approval externally. This turn ends now.`,
		},
	]);
	expect(result.details).toEqual({
		outcome: "external_approval_required",
		approvalSource: "external",
		planFilePath: planPath,
		planContents,
		planHash: createHash("sha256").update(planContents, "utf8").digest("hex"),
		planModeExited: true,
	});
	expect(result.terminate).toBe(true);
	expect(result.stopTurn).toBe(true);
	expect(result.content[0].text).toContain("tail of the plan");
	expect(result.content[0].text).not.toContain("truncated");
	expect(select).not.toHaveBeenCalled();
	expect(harness.customCalls()).toBe(0);
	expect(harness.userMessages).toEqual([]);
	expect(harness.statuses.get("plan-mode")).toBeUndefined();
	expect(lastPlanEntry(harness).enabled).toBe(false);
	expect(harness.activeTools()).toEqual(originalTools);
	expect(events.at(-1)).toEqual({
		event: "plan_mode_exited",
		properties: { source: "user", outcome: "auto_headless" },
	});
});

test.each(["tui", "print", "rpc"] as const)(
	"%s plan hashes bind the complete UTF-8 content without normalization",
	async (mode) => {
		const cwd = makeWorkspace();
		const harness = createHarness({ cwd, review: [REVIEW_KEYS.enter] });
		createStepPlanExtension()(harness.api);
		// `rpc` here is the interactive host case, which keeps planning on submit.
		const context = harness.ctx({ mode, hasUI: mode !== "print", planReviewSurface: mode === "rpc" });
		const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
		mkdirSync(path.dirname(planPath), { recursive: true });
		const proposal = `\uFEFF# Plan — café 🧪\r\n\r\n${"detail ".repeat(1000)}\r\nlast line \t\r\n`;
		const variants = [
			proposal,
			proposal.replace("last line", "changed tail"),
			proposal.trim(),
			proposal.replaceAll("\r\n", "\n"),
		];
		const hashes: string[] = [];

		for (const planContents of variants) {
			// An interactive rpc host stays in plan mode after each submission, so
			// only enter when the previous round actually left it.
			if (harness.statuses.get("plan-mode") !== "Planning (user)") await enterPlanMode(harness, context);
			writeFileSync(planPath, planContents);
			const result = (await runTool(harness, "exit_plan_mode", {}, context)) as { details?: PlanReviewDetails };
			expect(result.details).toMatchObject({
				planContents,
				planHash: createHash("sha256").update(planContents, "utf8").digest("hex"),
				// An interactive rpc host keeps planning until the user answers; a
				// host with no review surface leaves on submission.
				planModeExited: mode !== "rpc",
			});
			hashes.push(result.details!.planHash!);
		}
		expect(new Set(hashes).size).toBe(variants.length);
	},
);

test("the plan pre-check sees a plan extension loaded through a different API object", async () => {
	const cwd = makeWorkspace();
	const harness = createHarness({ cwd });
	createStepPlanExtension()(harness.api);

	// The real loader creates one API object per extension, so the Step extension
	// must find the plan extension through shared session state, not through `pi`.
	const stepHandlers = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
	const stepApi = {
		registerProvider: () => {},
		registerTool: () => {},
		registerCommand: () => {},
		registerFlag: () => {},
		registerShortcut: () => {},
		on(event: string, handler: (event: never, ctx: ExtensionContext) => unknown) {
			const list = stepHandlers.get(event) ?? [];
			list.push(handler);
			stepHandlers.set(event, list);
		},
		getActiveTools: () => [...PLAN_TOOLS_UNDER_TEST],
		setActiveTools: () => {},
		getFlag: () => false,
		appendEntry: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
		events: createEventBus(),
	} as unknown as ExtensionAPI;
	createStepExtension({
		permission: { env: {}, initialPreset: "ask" },
		stepSettings: () => ({ getStepSettings: () => ({}), setEffectiveStepSettings: () => {} }),
	})(stepApi);

	const confirm = vi.fn(async () => true);
	const context = harness.ctx({ ui: { ...harness.ctx().ui, confirm } });
	await harness.emit({ type: "session_start", reason: "startup" }, context);
	await enterPlanMode(harness, context);

	let result: unknown;
	for (const handler of stepHandlers.get("tool_call") ?? []) {
		result = await handler(
			{ type: "tool_call", toolName: "write_file", toolCallId: "split", input: { path: "src/app.ts" } } as never,
			context,
		);
	}
	expect(result).toMatchObject({ block: true });
	expect(confirm).not.toHaveBeenCalled();
});

test("plan mode decides a forbidden edit before requesting permission", async () => {
	const cwd = makeWorkspace();
	const harness = createHarness({ cwd });
	createStepExtension({
		permission: { env: {}, initialPreset: "ask" },
		stepSettings: () => ({ getStepSettings: () => ({}), setEffectiveStepSettings: () => {} }),
	})(harness.api);
	createStepPlanExtension()(harness.api);
	const confirm = vi.fn(async () => true);
	const context = harness.ctx({ ui: { ...harness.ctx().ui, confirm } });
	await harness.emit({ type: "session_start", reason: "startup" }, context);
	await enterPlanMode(harness, context);

	const result = await harness.emit(
		{ type: "tool_call", toolName: "write_file", toolCallId: "outside", input: { path: "src/app.ts", content: "x" } },
		context,
	);
	expect(result).toMatchObject({ block: true });
	expect(JSON.stringify(result)).toContain("Only the plan file may be written");
	expect(confirm).not.toHaveBeenCalled();
});

test("a write to the plan file still asks the permission policy", async () => {
	const cwd = makeWorkspace();
	const harness = createHarness({ cwd });
	createStepExtension({
		permission: { env: {}, initialPreset: "ask" },
		stepSettings: () => ({ getStepSettings: () => ({}), setEffectiveStepSettings: () => {} }),
	})(harness.api);
	createStepPlanExtension()(harness.api);
	const confirm = vi.fn(async () => true);
	const context = harness.ctx({ ui: { ...harness.ctx().ui, confirm } });
	await harness.emit({ type: "session_start", reason: "startup" }, context);
	await enterPlanMode(harness, context);
	const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");

	const result = await harness.emit(
		{ type: "tool_call", toolName: "write_file", toolCallId: "plan", input: { path: planPath, content: "# Plan" } },
		context,
	);
	expect(result).toBeUndefined();
	expect(confirm).toHaveBeenCalledTimes(1);
});

test("a write is still blocked when only the plan extension is mounted", async () => {
	const harness = createHarness({ cwd: makeWorkspace() });
	createStepPlanExtension()(harness.api);
	const context = harness.ctx();
	await enterPlanMode(harness, context);
	const result = await harness.emit(
		{ type: "tool_call", toolName: "write_file", toolCallId: "plan-only", input: { path: "src/app.ts" } },
		context,
	);
	expect(result).toMatchObject({ block: true });
});

test.each(["tui", "rpc"] as const)("a missing proposal keeps plan mode active in %s", async (mode) => {
	const harness = createHarness({ cwd: makeWorkspace() });
	createStepPlanExtension()(harness.api);
	const context = harness.ctx({ mode, hasUI: true });
	await enterPlanMode(harness, context);

	const result = (await runTool(harness, "exit_plan_mode", {}, context)) as {
		content: Array<{ text: string }>;
		terminate?: boolean;
		stopTurn?: boolean;
	};
	expect(result.content[0]?.text).toContain("Plan mode stays active");
	expect(result.terminate).toBe(false);
	expect(lastPlanEntry(harness).enabled).toBe(true);
});

test("a proposal changed during the review cannot exit plan mode", async () => {
	const cwd = makeWorkspace();
	const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	const harness = createHarness({ cwd });
	createStepPlanExtension()(harness.api);
	const context = harness.ctx({
		ui: {
			...harness.ctx().ui,
			custom: async () => {
				writeFileSync(planPath, "# A different plan\n");
				return { action: "execute" };
			},
		},
	});
	await enterPlanMode(harness, context);
	mkdirSync(path.dirname(planPath), { recursive: true });
	writeFileSync(planPath, "# The reviewed plan\n");

	const result = (await runTool(harness, "exit_plan_mode", {}, context)) as {
		content: Array<{ text: string }>;
		terminate?: boolean;
		stopTurn?: boolean;
	};
	expect(result.content[0]?.text).toContain("The plan changed");
	expect(result.terminate).toBe(true);
	expect(result.stopTurn).toBe(true);
	expect(lastPlanEntry(harness).enabled).toBe(true);
	expect(harness.notifications.some((notice) => /changed during review/.test(notice.message))).toBe(true);
});

test("an aborted review does not exit plan mode", async () => {
	const cwd = makeWorkspace();
	const harness = createHarness({ cwd, review: [REVIEW_KEYS.enter] });
	createStepPlanExtension()(harness.api);
	const context = harness.ctx();
	await enterPlanMode(harness, context);
	const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	mkdirSync(path.dirname(planPath), { recursive: true });
	writeFileSync(planPath, "# The plan\n");
	const controller = new AbortController();
	controller.abort();

	const result = (await runTool(harness, "exit_plan_mode", {}, context, controller.signal)) as {
		content: Array<{ text: string }>;
		terminate?: boolean;
		stopTurn?: boolean;
	};
	expect(result.content[0]?.text).toContain("aborted");
	expect(result.terminate).toBe(true);
	expect(result.stopTurn).toBe(true);
	expect(lastPlanEntry(harness).enabled).toBe(true);
});

test("a step-only embedder does not inherit a plan boundary it cannot leave", async () => {
	const harness = createHarness({ cwd: makeWorkspace() });
	// A branch written by a build that had plan mode on, resumed by an embedder
	// that mounts the Step extension without the plan extension and its /plan.
	harness.session.appendCustomEntry("step-plan", {
		version: 2,
		enabled: true,
		planFilePath: "/tmp/plan.md",
		planSource: "user",
	});
	createStepExtension({
		permission: { env: {}, initialPreset: "full-access" },
		stepSettings: () => ({ getStepSettings: () => ({}), setEffectiveStepSettings: () => {} }),
	})(harness.api);
	const context = harness.ctx();
	await harness.emit({ type: "session_start", reason: "startup" }, context);

	const result = await harness.emit(
		{ type: "tool_call", toolName: "write_file", toolCallId: "step-only", input: { path: "src/app.ts" } },
		context,
	);
	expect(result).toBeUndefined();
});

test("leaving plan mode ends the work in flight instead of letting it implement", async () => {
	// The Default announcement only reaches the model's next request, so a run
	// still streaming would carry on with the plan boundary lifted — the exact
	// opposite of what the user asked for by leaving.
	const harness = createHarness({ cwd: makeWorkspace() });
	createStepPlanExtension()(harness.api);
	const abort = vi.fn();
	const context = harness.ctx({ isIdle: () => false, abort });
	await harness.commands.get("plan")!.handler("", context);
	expect(lastPlanEntry(harness)).toMatchObject({ enabled: true });

	await harness.commands.get("plan")!.handler("off", context);
	expect(lastPlanEntry(harness)).toMatchObject({ enabled: false });
	expect(abort).toHaveBeenCalledTimes(1);
});

test("leaving plan mode while idle does not abort anything", async () => {
	const harness = createHarness({ cwd: makeWorkspace() });
	createStepPlanExtension()(harness.api);
	const abort = vi.fn();
	const context = harness.ctx({ isIdle: () => true, abort });
	await harness.commands.get("plan")!.handler("", context);
	await harness.commands.get("plan")!.handler("off", context);
	expect(abort).not.toHaveBeenCalled();
});

test("the status chip does not require a theme from the host", async () => {
	// A host that renders text rather than a terminal may answer `undefined`; styling
	// is a nicety, and a crash inside the status update loses the whole command.
	const harness = createHarness({ cwd: makeWorkspace() });
	createStepPlanExtension()(harness.api);
	const context = harness.ctx({ ui: { ...(harness.ctx().ui as object), theme: undefined } });

	await expect(harness.commands.get("plan")!.handler("", context)).resolves.toBeUndefined();
	expect(harness.statuses.get("plan-mode")).toBe("Planning (user)");
});

test("entering plan mode announces it without adding a transcript row", async () => {
	// The host draws plan mode from session state; a durable notice would be a row
	// nobody typed into the conversation. Leaving says nothing at all: the chip
	// closing and the composer reopening are the report.
	const harness = createHarness({ cwd: makeWorkspace() });
	createStepPlanExtension()(harness.api);
	const context = harness.ctx();
	await harness.commands.get("plan")!.handler("", context);
	await harness.commands.get("plan")!.handler("", context);

	const notices = harness.notifications.filter((notice) => /Plan mode (enabled|disabled)/.test(notice.message));
	expect(notices).toHaveLength(1);
	expect(notices[0]?.options?.transient).toBe(true);
});

test("plan mode denies a mutation even when the branch carries no plan entry", async () => {
	// The guard reads the branch so it can run before the plan extension has
	// replayed `session_start`. That must not turn a failed persist — or an
	// embedder whose `appendEntry` stores nothing — into an open door.
	const cwd = makeWorkspace();
	const harness = createHarness({ cwd });
	createStepPlanExtension()(harness.api);
	const context = harness.ctx();
	// Nothing reaches the branch: plan mode exists only in the live session.
	harness.api.appendEntry = () => {};
	await harness.commands.get("plan")!.handler("add a readme", context);
	expect(harness.appended.filter((entry) => entry.customType === "step-plan")).toHaveLength(0);

	await expect(
		harness.emit(
			{ type: "tool_call", toolName: "write_file", toolCallId: "lost-entry", input: { path: "src/app.ts" } },
			context,
		),
	).resolves.toMatchObject({ block: true, reason: expect.stringContaining("Only the plan file may be written") });
});

test("a failed enter persist leaves plan mode off", async () => {
	const harness = createHarness({ cwd: makeWorkspace() });
	createStepPlanExtension()(harness.api);
	const append = harness.api.appendEntry;
	harness.api.appendEntry = (type, data) => {
		if (type === "step-plan" && data && typeof data === "object" && "enabled" in data && data.enabled === true) {
			throw new Error("persist failed");
		}
		append(type, data);
	};
	const context = harness.ctx();
	await expect(harness.commands.get("plan")!.handler("", context)).rejects.toThrow("persist failed");

	// No live marker and no branch entry: a later write must not be blocked by a
	// mode this process never actually entered.
	const write = await harness.emit(
		{ type: "tool_call", toolName: "write_file", toolCallId: "after-failure", input: { path: "src/app.ts" } },
		context,
	);
	expect(write).toBeUndefined();
});

test("exit_plan_mode describes review and mode-specific approval rather than unconditional exit", () => {
	const harness = createHarness();
	createStepPlanExtension()(harness.api);
	const tool = harness.tools.get("exit_plan_mode")!;
	expect(tool.executionMode).toBe("sequential");
	expect(tool.description).toMatch(/^Submit .*proposal.*review/);
	expect(tool.description).toContain("readable, nonempty regular plan file");
	// One rule for every host: the user decides, the model cannot.
	expect(tool.description).toContain("The user decides; you do not");
	expect(tool.description).toContain("approval leaves planning and starts the work");
	expect(tool.description).toContain("a request for changes arrives as a new user message");
	expect(tool.description).toContain("hands the proposal to its caller");
	expect(tool.description).toContain("must obtain approval before execution");
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
	expect(harness.userMessages).toEqual([["实现一个俄罗斯方块,简单版", { expandPromptTemplates: true }]]);
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

	expect(harness.userMessages).toEqual([["plan this too", { expandPromptTemplates: true, deliverAs: "followUp" }]]);
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

// ---------------------------------------------------------------------------
// Collaboration-mode announcements
// ---------------------------------------------------------------------------

interface AnnouncementMessage {
	customType: string;
	content: string;
	display: boolean;
	details: { mode: string; planFilePath?: string };
}

async function startTurn(
	harness: Harness,
	context: ExtensionContext = harness.ctx(),
): Promise<AnnouncementMessage | undefined> {
	const result = (await harness.emit(
		{ type: "before_agent_start", prompt: "next", systemPrompt: "base prompt" },
		context,
	)) as { message?: AnnouncementMessage } | undefined;
	// Persist like AgentSession does, so the next turn sees what was announced.
	if (result?.message) {
		const { customType, content, display, details } = result.message;
		harness.session.appendCustomMessageEntry(customType, content, display, details);
	}
	return result?.message;
}

async function requestView(harness: Harness, messages: Array<Record<string, unknown>>) {
	const result = (await harness.emit({ type: "context", messages }, harness.ctx())) as {
		messages: Array<Record<string, unknown>>;
	};
	return result.messages;
}

test("default mode announces nothing and leaves the request untouched", async () => {
	const harness = createHarness({ cwd: makeWorkspace() });
	createStepPlanExtension()(harness.api);
	expect(await startTurn(harness)).toBeUndefined();
	const messages = [{ role: "user", content: "hello" }];
	expect(await requestView(harness, messages)).toEqual(messages);
});

test("/plan announces plan mode once, and leaving it announces Default once", async () => {
	const cwd = makeWorkspace();
	const harness = createHarness({ cwd });
	createStepPlanExtension()(harness.api);
	const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");

	await enterPlanMode(harness, harness.ctx());
	const planBlock = await startTurn(harness);
	expect(planBlock).toMatchObject({
		customType: "step-plan-mode",
		display: false,
		details: { mode: "plan", planFilePath: planPath },
	});
	expect(planBlock?.content).toContain("<collaboration_mode>");
	expect(planBlock?.content).toContain(planPath);
	expect(planBlock?.content).toContain("exit_plan_mode");
	// Append-only: an unchanged mode is never repeated.
	expect(await startTurn(harness)).toBeUndefined();

	await harness.commands.get("plan")!.handler("", harness.ctx());
	const defaultBlock = await startTurn(harness);
	expect(defaultBlock).toMatchObject({ customType: "step-plan-mode", details: { mode: "default" } });
	expect(defaultBlock?.content).toContain("Collaboration Mode: Default");
	expect(await startTurn(harness)).toBeUndefined();
	// The block travels as a hidden message; plan state entries are unchanged in shape.
	expect(harness.appended.every((entry) => entry.customType === "step-plan")).toBe(true);
});

test("/plan <task> announces plan mode on the turn that carries the task", async () => {
	const harness = createHarness({ cwd: makeWorkspace() });
	createStepPlanExtension()(harness.api);
	await harness.commands.get("plan")!.handler("plan the parser rewrite", harness.ctx());
	expect(harness.userMessages).toEqual([["plan the parser rewrite", { expandPromptTemplates: true }]]);
	expect((await startTurn(harness))?.details.mode).toBe("plan");
});

test("toggling plan mode on and off between turns announces nothing", async () => {
	const harness = createHarness({ cwd: makeWorkspace() });
	createStepPlanExtension()(harness.api);
	await enterPlanMode(harness, harness.ctx());
	await harness.commands.get("plan")!.handler("", harness.ctx());
	expect(await startTurn(harness)).toBeUndefined();
});

test("the context hook restores a compacted announcement without writing history", async () => {
	const cwd = makeWorkspace();
	const harness = createHarness({ cwd });
	createStepPlanExtension()(harness.api);
	await enterPlanMode(harness, harness.ctx());
	const announced = await startTurn(harness);
	const appendedBefore = harness.appended.length;
	const entriesBefore = harness.session.getEntries().length;

	// Compaction summarized the block away: the request view gets it back.
	const compacted = [{ role: "compactionSummary", summary: "earlier work", timestamp: 1 }];
	const restored = await requestView(harness, compacted);
	expect(restored).toHaveLength(2);
	expect(restored[1]).toMatchObject({
		role: "custom",
		customType: "step-plan-mode",
		display: false,
		content: announced?.content,
	});

	// With the block still present, nothing is added.
	const intact = [{ role: "custom", ...announced, timestamp: 1 }];
	expect(await requestView(harness, intact)).toEqual(intact);

	expect(harness.appended).toHaveLength(appendedBefore);
	expect(harness.session.getEntries()).toHaveLength(entriesBefore);
});

test("an approval mid-run shows the Default block on the next request of the same run", async () => {
	const cwd = makeWorkspace();
	const harness = createHarness({ cwd, review: [REVIEW_KEYS.enter] });
	createStepPlanExtension()(harness.api);
	await enterPlanMode(harness, harness.ctx());
	const announced = await startTurn(harness);
	const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	mkdirSync(path.dirname(planPath), { recursive: true });
	writeFileSync(planPath, "# Plan\n");
	await runTool(harness, "exit_plan_mode", {}, harness.ctx());

	const view = await requestView(harness, [{ role: "custom", ...announced, timestamp: 1 }]);
	expect(view.at(-1)).toMatchObject({ customType: "step-plan-mode", details: { mode: "default" } });
	// The next turn persists the Default block once.
	expect((await startTurn(harness))?.details.mode).toBe("default");
	expect(await startTurn(harness)).toBeUndefined();
});

test("a compacted Plan block is re-announced while planning and still retracted after leaving", async () => {
	const harness = createHarness({ cwd: makeWorkspace() });
	createStepPlanExtension()(harness.api);
	await enterPlanMode(harness, harness.ctx());
	expect((await startTurn(harness))?.details.mode).toBe("plan");

	// Compaction keeps only entries from the marker on: the Plan block is summarized away.
	const kept = harness.session.appendCustomEntry("marker");
	harness.session.appendCompaction("earlier planning", kept, 1000);
	expect((await startTurn(harness))?.details.mode).toBe("plan");

	const second = harness.session.appendCustomEntry("marker");
	harness.session.appendCompaction("more planning", second, 1000);
	await harness.commands.get("plan")!.handler("", harness.ctx());
	// The summary may still carry Plan rules, so leaving owes a Default block even
	// though no Plan block is visible any more.
	const view = await requestView(harness, [{ role: "compactionSummary", summary: "more planning", timestamp: 1 }]);
	expect(view.at(-1)).toMatchObject({ customType: "step-plan-mode", details: { mode: "default" } });
	expect((await startTurn(harness))?.details.mode).toBe("default");
	expect(await startTurn(harness)).toBeUndefined();
});

test("--plan at startup announces plan mode on the first turn", async () => {
	const harness = createHarness({ cwd: makeWorkspace(), flags: { plan: true } });
	createStepPlanExtension()(harness.api);
	await harness.emit({ type: "session_start", reason: "startup" }, harness.ctx());
	expect((await startTurn(harness))?.details.mode).toBe("plan");
	expect(await startTurn(harness)).toBeUndefined();
});

test.each(["session_start", "session_tree"] as const)(
	"%s restore re-announces only when the visible block disagrees with the mode",
	async (type) => {
		const planFilePath = "/workspace/.stepcode/plans/session-sess-1.md";
		const announced = (mode: "plan" | "default") =>
			mode === "plan" ? { mode, planFilePath, version: PLAN_MODE_BLOCK_VERSION } : { mode };

		// A plan that was already announced in the current wording: no repeat.
		const legacy = createHarness({
			entries: [
				{ type: "custom", customType: "step-plan", data: { enabled: true, planSource: "agent", planFilePath } },
			],
		});
		legacy.session.appendCustomMessageEntry("step-plan-mode", "<collaboration_mode>", false, announced("plan"));
		createStepPlanExtension()(legacy.api);
		await restoreLifecycle(legacy, type);
		expect(legacy.statuses.get("plan-mode")).toBe("Planning (agent)");
		expect(await startTurn(legacy)).toBeUndefined();

		// A block written by an older build states older rules, so the current one is
		// appended once; the next turn has nothing left to say.
		const stale = createHarness({
			entries: [
				{ type: "custom", customType: "step-plan", data: { enabled: true, planSource: "agent", planFilePath } },
			],
		});
		stale.session.appendCustomMessageEntry("step-plan-mode", "<collaboration_mode>", false, {
			mode: "plan",
			planFilePath,
		});
		createStepPlanExtension()(stale.api);
		await restoreLifecycle(stale, type);
		expect(await startTurn(stale)).toMatchObject({ details: announced("plan") });
		expect(await startTurn(stale)).toBeUndefined();

		// The same plan state recorded before announcements existed: announce once.
		const unannounced = createHarness({
			entries: [
				{ type: "custom", customType: "step-plan", data: { enabled: true, planSource: "agent", planFilePath } },
			],
		});
		createStepPlanExtension()(unannounced.api);
		await restoreLifecycle(unannounced, type);
		expect(await startTurn(unannounced)).toMatchObject({ details: announced("plan") });
		expect(await startTurn(unannounced)).toBeUndefined();

		// A finished cycle whose Default block is recorded: nothing more to say.
		const finished = createHarness({
			entries: [{ type: "custom", customType: "step-plan", data: { version: 2, enabled: false } }],
		});
		finished.session.appendCustomMessageEntry("step-plan-mode", "<collaboration_mode>", false, announced("plan"));
		finished.session.appendCustomMessageEntry("step-plan-mode", "<collaboration_mode>", false, announced("default"));
		createStepPlanExtension()(finished.api);
		await restoreLifecycle(finished, type);
		expect(await startTurn(finished)).toBeUndefined();
	},
);
