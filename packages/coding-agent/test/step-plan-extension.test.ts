import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Component, setKeybindings } from "@step-harness/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { loadExtensions } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
	PlanReviewResult,
	ToolDefinition,
} from "../src/core/extensions/types.ts";
import { wrapRegisteredTools } from "../src/core/extensions/wrapper.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { getPlanFilePath } from "../src/features/plan-mode-tools.ts";
import { createStepExtension } from "../src/features/step.ts";
import { createStepPlanExtension, getStepPlanState } from "../src/features/step-plan.ts";
import { createStepTasksExtension, type StepTask } from "../src/features/step-tasks.ts";
import { PLAN_REVIEW_PROMPT, type PlanReviewDetails } from "../src/render/plan-review.ts";
import type { StepTelemetryReporter } from "../src/step/telemetry.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

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
		/**
		 * Bridged plan review, the way an rpc host with a real user behind its UI
		 * bridge (sdk-stdio) answers `ui.reviewPlan`. Absent by default: rpc hosts
		 * without a bridge keep the external handoff.
		 */
		reviewPlan?: (
			request: { planFilePath: string; planContents: string; planHash: string; title: string },
			opts?: { timeout?: number; signal?: AbortSignal },
		) => Promise<PlanReviewResult | undefined>;
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
				...(options.reviewPlan ? { reviewPlan: options.reviewPlan } : {}),
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

function createPlanAndPermissionHarness(cwd: string) {
	const harness = createHarness({ cwd });
	createStepExtension({
		permission: { env: {}, initialPreset: "ask" },
		stepSettings: () => ({ getStepSettings: () => ({}), setEffectiveStepSettings: () => {} }),
	})(harness.api);
	createStepPlanExtension()(harness.api);
	const confirm = vi.fn(async () => true);
	const context = harness.ctx({ ui: { ...harness.ctx().ui, confirm } });
	return { harness, confirm, context };
}

test("plan mode refuses forbidden edits before requesting permission", async () => {
	const { harness, confirm, context } = createPlanAndPermissionHarness(makeWorkspace());
	await harness.emit({ type: "session_start", reason: "startup" }, context);
	await enterPlanMode(harness, context);
	const result = await harness.emit(
		{ type: "tool_call", toolName: "write_file", toolCallId: "outside", input: { path: "src/app.ts", content: "x" } },
		context,
	);
	expect(result).toMatchObject({ block: true });
	expect(confirm).not.toHaveBeenCalled();
});

test("writing the plan still requires the normal permission decision", async () => {
	const cwd = makeWorkspace();
	const { harness, confirm, context } = createPlanAndPermissionHarness(cwd);
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

test("live plan mode still refuses edits when an embedder stores no entries", async () => {
	const { harness, confirm, context } = createPlanAndPermissionHarness(makeWorkspace());
	harness.api.appendEntry = vi.fn();
	await harness.emit({ type: "session_start", reason: "startup" }, context);
	await enterPlanMode(harness, context);
	const result = await harness.emit(
		{ type: "tool_call", toolName: "write_file", toolCallId: "unrecorded", input: { path: "src/app.ts" } },
		context,
	);
	expect(result).toMatchObject({ block: true });
	expect(confirm).not.toHaveBeenCalled();
});

test("plan state projection validates unknown source values and keeps branch order", () => {
	expect(getStepPlanState([])).toBeUndefined();
	expect(
		getStepPlanState([
			{
				type: "custom",
				customType: "step-plan",
				data: { enabled: true, planFilePath: "/plan.md", planSource: "other" },
			},
		]),
	).toEqual({ enabled: true, planFilePath: "/plan.md", planSource: "unknown" });
	expect(
		getStepPlanState([
			{ type: "custom", customType: "step-plan", data: { enabled: true, planSource: "user" } },
			{ type: "custom", customType: "step-plan", data: { enabled: false } },
		]),
	).toEqual({ enabled: false, planSource: "unknown" });
});

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

test.each([true, false])("rpc-mode exit_plan_mode hands approval to the caller (hasUI: %s)", async (hasUI) => {
	const cwd = makeWorkspace();
	const { telemetry, events } = createTelemetryRecorder();
	const harness = createHarness({ cwd, review: [REVIEW_KEYS.enter] });
	const originalTools = harness.activeTools();
	createStepPlanExtension({ telemetry })(harness.api);
	// RPC can expose a dialog bridge (hasUI true), but approval still belongs to its caller.
	const context = harness.ctx({ mode: "rpc", hasUI });

	await enterPlanMode(harness, context);
	const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	mkdirSync(path.dirname(planPath), { recursive: true });
	const planContents = "# The plan\n1. Do the thing\n";
	writeFileSync(planPath, planContents);

	const result = (await runTool(harness, "exit_plan_mode", {}, context)) as {
		content: Array<{ type: string; text: string }>;
		details?: PlanReviewDetails;
		terminate?: boolean;
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
	expect(harness.customCalls()).toBe(0);
	expect(harness.userMessages).toEqual([]);

	// Plan mode actually exited: tools restored, chip cleared, state persisted off.
	expect(harness.activeTools()).toEqual(originalTools);
	expect(harness.statuses.get("plan-mode")).toBeUndefined();
	expect(lastPlanEntry(harness)).toMatchObject({ enabled: false });
	expect(
		harness.notifications.some(
			(notification) =>
				notification.type === "warning" && notification.message.includes("has no plan-review bridge"),
		),
	).toBe(true);
	expect(events.at(-1)).toEqual({
		event: "plan_mode_exited",
		properties: { source: "user", outcome: "auto_rpc" },
	});
});

// ---------------------------------------------------------------------------
// rpc hosts with a bridged review (sdk-stdio / desktop): the tool waits for the
// reviewer instead of auto-exiting. Only a host that cannot bridge a review at
// all keeps the external handoff above.
// ---------------------------------------------------------------------------

/** What the bridged reviewer received, for snapshot assertions. */
interface BridgedReviewCall {
	request: { planFilePath: string; planContents: string; planHash: string; title: string };
	opts?: { timeout?: number; signal?: AbortSignal };
}

function recordBridgedReview(answer: PlanReviewResult | undefined, calls?: BridgedReviewCall[]) {
	return async (
		request: { planFilePath: string; planContents: string; planHash: string; title: string },
		opts?: { timeout?: number; signal?: AbortSignal },
	): Promise<PlanReviewResult | undefined> => {
		calls?.push({ request, opts });
		return answer;
	};
}

async function setupBridgedRpc(options: {
	answer?: PlanReviewResult | undefined;
	calls?: BridgedReviewCall[];
	review?: string[];
}): Promise<{
	harness: Harness;
	context: ExtensionContext;
	planPath: string;
	planContents: string;
	originalTools: string[];
}> {
	const cwd = makeWorkspace();
	const harness = createHarness({
		cwd,
		review: options.review,
		reviewPlan: recordBridgedReview(options.answer, options.calls),
	});
	createStepPlanExtension()(harness.api);
	const originalTools = harness.activeTools();
	const context = harness.ctx({ mode: "rpc", hasUI: true });
	await enterPlanMode(harness, context);
	const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	mkdirSync(path.dirname(planPath), { recursive: true });
	const planContents = "# The plan\n1. Do the thing\n";
	writeFileSync(planPath, planContents);
	return { harness, context, planPath, planContents, originalTools };
}

test("bridged rpc exit_plan_mode sends the plan snapshot and hash, then executes on approval", async () => {
	const calls: BridgedReviewCall[] = [];
	const { harness, context, planPath, planContents, originalTools } = await setupBridgedRpc({
		answer: { action: "execute" },
		calls,
	});

	const result = (await runTool(harness, "exit_plan_mode", {}, context)) as {
		content: Array<{ type: string; text: string }>;
		details?: PlanReviewDetails;
		terminate?: boolean;
	};

	// The bridge carries everything the desktop needs to render and verify.
	expect(calls).toHaveLength(1);
	expect(calls[0]!.request).toEqual({
		planFilePath: planPath,
		planContents,
		planHash: createHash("sha256").update(planContents, "utf8").digest("hex"),
		title: PLAN_REVIEW_PROMPT,
	});
	// The tool owns the review budget; a host only backstops it.
	expect(calls[0]!.opts?.timeout).toBeGreaterThan(60_000);
	expect(result.content[0]!.text).toContain("The user approved the plan");
	expect(result.details).toEqual({
		outcome: "approved",
		approvalSource: "user",
		planFilePath: planPath,
		planContents,
		planHash: createHash("sha256").update(planContents, "utf8").digest("hex"),
		planModeExited: true,
	});
	expect(result.terminate).toBe(false);
	// The bridged review replaces the in-process component entirely.
	expect(harness.customCalls()).toBe(0);
	expect(harness.activeTools()).toEqual(originalTools);
	expect(harness.statuses.get("plan-mode")).toBeUndefined();
	expect(lastPlanEntry(harness)).toMatchObject({ enabled: false });
});

test("bridged rpc exit_plan_mode steers refinement notes and keeps planning", async () => {
	const { harness, context, planPath } = await setupBridgedRpc({
		answer: { action: "feedback", text: "use canvas" },
	});

	const result = (await runTool(harness, "exit_plan_mode", {}, context)) as {
		content: Array<{ type: string; text: string }>;
		details?: PlanReviewDetails;
		terminate?: boolean;
	};
	expect(harness.userMessages).toEqual([
		[`Plan refinement requested. Update ${planPath} based on:\n\nuse canvas`, { deliverAs: "steer" }],
	]);
	expect(result.content[0]!.text).toContain("Staying in plan mode");
	expect(result.terminate).toBe(false);
	expect(result.details).toMatchObject({ outcome: "feedback", approvalSource: "user", feedback: "use canvas" });
	expect(harness.statuses.get("plan-mode")).toBe("Planning (user)");
});

test("bridged rpc exit_plan_mode keeps planning when the reviewer dismisses", async () => {
	const { harness, context, planContents } = await setupBridgedRpc({ answer: { action: "dismissed" } });

	const result = (await runTool(harness, "exit_plan_mode", {}, context)) as {
		details?: PlanReviewDetails;
		terminate?: boolean;
	};
	expect(result.terminate).toBe(true);
	expect(result.details).toEqual({
		outcome: "dismissed",
		approvalSource: "user",
		planFilePath: expect.any(String),
		planContents,
		planHash: expect.any(String),
		planModeExited: false,
	});
	// A user who declined did decide; only an unanswered bridge marks a failure.
	expect(result.details?.bridgeFailed).toBeUndefined();
	expect(harness.statuses.get("plan-mode")).toBe("Planning (user)");
	expect(lastPlanEntry(harness)).toMatchObject({ enabled: true });
});

test.each([
	{ name: "times out", answer: undefined as PlanReviewResult | undefined },
	{ name: "answers with an empty note", answer: { action: "feedback", text: "  " } as PlanReviewResult },
])("bridged rpc exit_plan_mode keeps planning and flags the bridge when it $name", async ({ answer }) => {
	const { harness, context, planContents } = await setupBridgedRpc({ answer });

	const result = (await runTool(harness, "exit_plan_mode", {}, context)) as {
		content: Array<{ type: string; text: string }>;
		details?: PlanReviewDetails;
		terminate?: boolean;
	};
	expect(result.content[0]!.text).toContain("was not answered");
	expect(result.content[0]!.text).toContain("Staying in plan mode.");
	expect(result.terminate).toBe(true);
	// Nobody decided, so the details do not claim a user decision: the host owns
	// the unresolved review.
	expect(result.details).toMatchObject({
		outcome: "dismissed",
		approvalSource: "external",
		planContents,
		planModeExited: false,
		bridgeFailed: true,
	});
	// No exit telemetry: plan mode never left, so nothing claims an outcome.
	expect(harness.statuses.get("plan-mode")).toBe("Planning (user)");
	expect(lastPlanEntry(harness)).toMatchObject({ enabled: true });
});

test("bridged rpc exit_plan_mode keeps planning when a host answers with a malformed note", async () => {
	// `ui.reviewPlan` is a public extension API: a third-party host is not bound by
	// the in-repo bridge's strict parsing, so a non-string note must land in the
	// "no decision" bucket rather than throwing past the terminate below.
	const { harness, context, planContents } = await setupBridgedRpc({
		answer: { action: "feedback", text: 42 } as unknown as PlanReviewResult,
	});

	const result = (await runTool(harness, "exit_plan_mode", {}, context)) as {
		content: Array<{ type: string; text: string }>;
		details?: PlanReviewDetails;
		terminate?: boolean;
	};
	expect(result.content[0]!.text).toContain("was not answered");
	expect(result.terminate).toBe(true);
	expect(result.details).toMatchObject({
		outcome: "dismissed",
		approvalSource: "external",
		planContents,
		planModeExited: false,
		bridgeFailed: true,
	});
	expect(harness.userMessages).toEqual([]);
});

test("bridged rpc exit_plan_mode treats a throwing bridge as no decision", async () => {
	const cwd = makeWorkspace();
	const harness = createHarness({
		cwd,
		reviewPlan: async () => {
			throw new Error("bridge exploded");
		},
	});
	createStepPlanExtension()(harness.api);
	const context = harness.ctx({ mode: "rpc", hasUI: true });
	await enterPlanMode(harness, context);
	const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	mkdirSync(path.dirname(planPath), { recursive: true });
	writeFileSync(planPath, "# The plan\n");

	const result = (await runTool(harness, "exit_plan_mode", {}, context)) as {
		content: Array<{ type: string; text: string }>;
		details?: PlanReviewDetails;
		terminate?: boolean;
	};
	// A host that throws mid-review decided nothing. Surfacing it as a tool error
	// instead would drop terminate, and the loop would let the model retry.
	expect(result.content[0]!.text).toContain("was not answered");
	expect(result.terminate).toBe(true);
	expect(result.details).toMatchObject({
		approvalSource: "external",
		bridgeFailed: true,
		planModeExited: false,
	});
	expect(harness.statuses.get("plan-mode")).toBe("Planning (user)");
});

test("bridged rpc exit_plan_mode forwards the run signal so an aborted review answers nothing", async () => {
	const calls: BridgedReviewCall[] = [];
	const cwd = makeWorkspace();
	const harness = createHarness({
		cwd,
		reviewPlan: async (request, opts) => {
			calls.push({ request, opts });
			return opts?.signal?.aborted ? undefined : { action: "execute" };
		},
	});
	createStepPlanExtension()(harness.api);
	const context = harness.ctx({ mode: "rpc", hasUI: true });
	await enterPlanMode(harness, context);
	const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	mkdirSync(path.dirname(planPath), { recursive: true });
	writeFileSync(planPath, "# The plan\n");
	const controller = new AbortController();
	controller.abort();

	const result = (await runTool(harness, "exit_plan_mode", {}, context, controller.signal)) as {
		details?: PlanReviewDetails;
		terminate?: boolean;
	};
	// An already-aborted run must not open another dialog.
	expect(calls).toHaveLength(0);
	expect(result.terminate).toBe(true);
	expect(result.details).toMatchObject({
		approvalSource: "external",
		bridgeFailed: true,
		planModeExited: false,
	});
	expect(harness.statuses.get("plan-mode")).toBe("Planning (user)");
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
	};
	expect(harness.customCalls()).toBe(1);
	expect(result.content[0]!.text).toContain("Staying in plan mode.");
	expect(harness.statuses.get("plan-mode")).toBe("Planning (user)");
	// Escape hands the turn back to the user. Without this the model re-submits
	// the unchanged plan straight away and the dialog re-opens on every Escape.
	expect(result.terminate).toBe(true);
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
			version: 2,
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
	expect(lastPlanEntry(harness)).toMatchObject({ version: 2, enabled: true });
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
	expect(migrated).toMatchObject({ version: 2, enabled: true });
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
			version: 2,
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

	await runTool(harness, "exit_plan_mode", {}, harness.ctx());
	expect(harness.customCalls()).toBe(1);
	expect(harness.userMessages).toEqual([]);
	if (approved) {
		expect(lastPlanEntry(harness)).toMatchObject({ enabled: false, planSource: undefined });
		expect(harness.activeTools()).toEqual(originalTools);
		expect(events.at(-1)).toEqual({
			event: "plan_mode_exited",
			properties: { source: "user", outcome: "approved" },
		});
	} else {
		expect(lastPlanEntry(harness).enabled).toBe(true);
		expect(harness.appended).toHaveLength(3);
		expect(lastPlanEntry(harness)).toMatchObject({ review: { outcome: "dismissed" } });
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
		expect(lastPlanEntry(harness).enabled).toBe(true);
		expect(harness.appended).toHaveLength(3);
		expect(lastPlanEntry(harness)).toMatchObject({ review: { outcome: "feedback" } });
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
	// A caller that has to gate approval externally cannot do it on a clipped plan.
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
		const context = harness.ctx({ mode, hasUI: mode !== "print" });
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
			await enterPlanMode(harness, context);
			writeFileSync(planPath, planContents);
			const result = (await runTool(harness, "exit_plan_mode", {}, context)) as { details?: PlanReviewDetails };
			expect(result.details).toMatchObject({
				planContents,
				planHash: createHash("sha256").update(planContents, "utf8").digest("hex"),
				planModeExited: true,
			});
			hashes.push(result.details!.planHash!);
		}
		expect(new Set(hashes).size).toBe(variants.length);
	},
);

test("exit_plan_mode describes review and mode-specific approval rather than unconditional exit", () => {
	const harness = createHarness();
	createStepPlanExtension()(harness.api);
	const tool = harness.tools.get("exit_plan_mode")!;
	expect(tool.description).toMatch(/^Submit .*proposal.*review/);
	expect(tool.description).toContain("readable, nonempty regular plan file");
	expect(tool.description).toContain("reviewPlan or clarify UI capability");
	expect(tool.description).toContain("approval exits planning");
	expect(tool.description).toContain("feedback or dismissal keeps it active");
	expect(tool.description).toContain("Headless runs and RPC hosts without those capabilities");
	expect(tool.description).toContain("end this turn");
	expect(tool.description).toContain("caller must approve before execution");
	expect(tool.description).toContain("keep plan mode active until the user turns it off");
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

async function startTurn(harness: Harness): Promise<AnnouncementMessage | undefined> {
	const result = (await harness.emit(
		{ type: "before_agent_start", prompt: "next", systemPrompt: "base prompt" },
		harness.ctx(),
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
		const announced = (mode: "plan" | "default") => (mode === "plan" ? { mode, planFilePath } : { mode });

		// A legacy agent-entered plan that was already announced: no repeat.
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

// ---------------------------------------------------------------------------
// Runner-wired exit gating
//
test("an in-process rpc host uses its structured clarification bridge for plan approval", async () => {
	const cwd = makeWorkspace();
	const harness = createHarness({ cwd });
	createStepPlanExtension()(harness.api);
	const clarify = vi.fn(async (_questions: unknown, _signal?: AbortSignal) => ({
		answers: [{ id: "plan-review", value: "execute", label: "Execute the plan", wasCustom: false }],
		cancelled: false,
	}));
	const context = harness.ctx({ mode: "rpc", ui: { ...harness.ctx().ui, clarify } });
	await enterPlanMode(harness, context);
	const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	mkdirSync(path.dirname(planPath), { recursive: true });
	writeFileSync(planPath, "# Plan\n\nThe complete proposal.\n");
	const result = (await runTool(harness, "exit_plan_mode", {}, context)) as { details?: PlanReviewDetails };
	expect(clarify).toHaveBeenCalledTimes(1);
	expect(clarify.mock.calls[0]?.[0]).toMatchObject([{ reason: "# Plan\n\nThe complete proposal.\n" }]);
	expect(result.details).toMatchObject({ outcome: "approved", approvalSource: "user", planModeExited: true });
});

test.each([{ action: "launch" }, {}, null])("an unrecognized host answer is unanswered: %j", async (answer) => {
	const { harness, context } = await setupBridgedRpc({ answer: answer as unknown as PlanReviewResult });
	const result = (await runTool(harness, "exit_plan_mode", {}, context)) as {
		details?: PlanReviewDetails;
		terminate?: boolean;
	};
	expect(result.details).toMatchObject({ planModeExited: false, approvalSource: "external", bridgeFailed: true });
	expect(result.terminate).toBe(true);
});

test("a changed proposal cannot exit plan mode using an earlier approval", async () => {
	const cwd = makeWorkspace();
	const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
	const harness = createHarness({
		cwd,
		reviewPlan: async () => {
			writeFileSync(planPath, "# Replaced plan\nDifferent work\n");
			return { action: "execute" };
		},
	});
	createStepPlanExtension()(harness.api);
	const context = harness.ctx({ mode: "rpc" });
	await enterPlanMode(harness, context);
	mkdirSync(path.dirname(planPath), { recursive: true });
	writeFileSync(planPath, "# Original plan\nOriginal work\n");
	const result = (await runTool(harness, "exit_plan_mode", {}, context)) as {
		content: Array<{ text: string }>;
		terminate?: boolean;
	};
	expect(lastPlanEntry(harness).enabled).toBe(true);
	expect(result.content[0]?.text).toContain("changed");
	expect(result.terminate).toBe(true);
});

test("a host that ignores its timeout cannot keep the plan tool waiting forever", async () => {
	vi.useFakeTimers();
	try {
		const { harness, context } = await setupBridgedRpc({ answer: undefined });
		context.ui.reviewPlan = () => new Promise(() => {});
		const pending = runTool(harness, "exit_plan_mode", {}, context);
		await vi.advanceTimersByTimeAsync(600_001);
		const settled = await Promise.race([pending, Promise.resolve("still waiting")]);
		expect(settled).not.toBe("still waiting");
		expect(settled).toMatchObject({ terminate: true, details: { bridgeFailed: true, planModeExited: false } });
	} finally {
		vi.useRealTimers();
	}
});

test("submission remains pending without exiting and the same snapshot can be reviewed again", async () => {
	const { harness, context } = await setupBridgedRpc({ answer: undefined });
	let answer!: (value: PlanReviewResult) => void;
	context.ui.reviewPlan = () =>
		new Promise((resolve) => {
			answer = resolve;
		});
	const pending = runTool(harness, "exit_plan_mode", {}, context);
	expect(getStepPlanState(harness.session.getBranch())).toMatchObject({
		enabled: true,
		review: { outcome: "pending" },
	});
	answer({ action: "dismissed" });
	await pending;
	expect(getStepPlanState(harness.session.getBranch())).toMatchObject({
		enabled: true,
		review: { outcome: "dismissed" },
	});
	context.ui.reviewPlan = async () => ({ action: "execute" });
	const repeated = (await runTool(harness, "exit_plan_mode", {}, context)) as { details?: PlanReviewDetails };
	expect(repeated.details).toMatchObject({ outcome: "approved", planModeExited: true });
});

test("only one review may be pending for the current plan mode", async () => {
	const { harness, context } = await setupBridgedRpc({ answer: undefined });
	let answer!: (value: PlanReviewResult) => void;
	const review = vi.fn(
		() =>
			new Promise<PlanReviewResult>((resolve) => {
				answer = resolve;
			}),
	);
	context.ui.reviewPlan = review;
	const first = runTool(harness, "exit_plan_mode", {}, context);
	const second = (await runTool(harness, "exit_plan_mode", {}, context)) as {
		terminate?: boolean;
		content: Array<{ text: string }>;
	};
	expect(review).toHaveBeenCalledTimes(1);
	expect(second.terminate).toBe(true);
	expect(second.content[0]?.text).toContain("already pending");
	answer({ action: "dismissed" });
	await first;
});

test("an old review cannot unlock a new plan round after the user toggles modes", async () => {
	const { harness, context } = await setupBridgedRpc({ answer: undefined });
	let answer!: (value: PlanReviewResult) => void;
	context.ui.reviewPlan = () =>
		new Promise((resolve) => {
			answer = resolve;
		});
	const pending = runTool(harness, "exit_plan_mode", {}, context);
	await harness.commands.get("plan")!.handler("", context);
	await harness.commands.get("plan")!.handler("", context);
	const result = (await pending) as { terminate?: boolean; content: Array<{ text: string }> };
	expect(result.terminate).toBe(true);
	expect(result.content[0]?.text).toContain("old review cannot authorize");
	answer({ action: "execute" });
	await Promise.resolve();
	expect(getStepPlanState(harness.session.getBranch())).toMatchObject({ enabled: true });
});

test("restoring an interrupted review keeps planning and records it as unanswered", async () => {
	const harness = createHarness({
		cwd: makeWorkspace(),
		entries: [
			{
				type: "custom",
				customType: "step-plan",
				data: {
					enabled: true,
					planSource: "user",
					review: { id: "old", planHash: "a".repeat(64), outcome: "pending" },
				},
			},
		],
	});
	createStepPlanExtension()(harness.api);
	await harness.emit({ type: "session_start", reason: "resume" }, harness.ctx());
	expect(getStepPlanState(harness.session.getBranch())).toMatchObject({
		enabled: true,
		review: { outcome: "unanswered" },
	});
	expect(harness.customCalls()).toBe(0);
});

test("a TUI implementation error is not recorded as a user dismissal", async () => {
	const { harness } = await setupBridgedRpc({ answer: undefined });
	const tui = harness.ctx({
		ui: {
			...harness.ctx().ui,
			reviewPlan: undefined,
			custom: async () => {
				throw new Error("renderer failed");
			},
		},
	});
	const result = await runTool(harness, "exit_plan_mode", {}, tui);
	expect(result).toMatchObject({
		isError: true,
		stopTurn: true,
		content: [{ text: expect.stringContaining("renderer failed") }],
	});
	expect(getStepPlanState(harness.session.getBranch())).toMatchObject({
		enabled: true,
		review: { outcome: "unanswered" },
	});
});

test("an unavailable oversized proposal tells the model how to recover without exiting", async () => {
	const { harness, context } = await setupBridgedRpc({
		answer: { action: "unavailable", reason: "proposal_too_large" },
	});
	const result = (await runTool(harness, "exit_plan_mode", {}, context)) as {
		content: Array<{ text: string }>;
		details?: PlanReviewDetails;
	};
	expect(result.content[0]?.text).toContain("Shorten the plan");
	expect(result.details).toBeUndefined();
	expect(getStepPlanState(harness.session.getBranch())).toMatchObject({ enabled: true });
});

test("a new /plan task supersedes an open review without disabling planning", async () => {
	const { harness, context } = await setupBridgedRpc({ answer: undefined });
	let answer!: (value: PlanReviewResult) => void;
	let signal: AbortSignal | undefined;
	context.ui.reviewPlan = (_request, options) =>
		new Promise((resolve) => {
			answer = resolve;
			signal = options?.signal;
		});
	const pending = runTool(harness, "exit_plan_mode", {}, context);
	try {
		await harness.commands.get("plan")!.handler("a different task", context);
		expect(signal?.aborted).toBe(true);
		const result = await pending;
		expect(result).toMatchObject({ stopTurn: true });
		expect(getStepPlanState(harness.session.getBranch())).toMatchObject({ enabled: true });
	} finally {
		answer({ action: "execute" });
		await pending;
	}
});

test("a failed exit persist does not unlock the session or continue the turn", async () => {
	const { harness, context } = await setupBridgedRpc({ answer: { action: "execute" } });
	const append = harness.api.appendEntry;
	harness.api.appendEntry = (type, data) => {
		if (type === "step-plan" && data && typeof data === "object" && "enabled" in data && data.enabled === false) {
			throw new Error("persist failed");
		}
		append(type, data);
	};
	const result = (await runTool(harness, "exit_plan_mode", {}, context)) as { isError?: boolean; stopTurn?: boolean };
	expect(result).toMatchObject({ isError: true, stopTurn: true });
	context.ui.reviewPlan = async () => ({ action: "dismissed" });
	const retry = (await runTool(harness, "exit_plan_mode", {}, context)) as { details?: PlanReviewDetails };
	expect(retry.details).toMatchObject({ outcome: "dismissed", planModeExited: false });
});

// The harness above hand-builds `ctx.ui`, which bypasses ExtensionRunner's
// wrapper layer. These cases drive the tool through a real runner, so the
// capability probe (`ctx.ui.reviewPlan`) sees exactly what a production host
// sees: a wrapped reviewPlan exists only where the bound UI context has one.
// ---------------------------------------------------------------------------

describe("exit_plan_mode through a real ExtensionRunner", () => {
	const appended: Array<{ customType: string; data: unknown }> = [];
	const notifications: Array<{ message: string; type?: string }> = [];
	const customCalls: unknown[] = [];
	const reviewCalls: Array<{ request: unknown; opts: unknown }> = [];
	const promptEvents: Array<{ type: string; kind?: string }> = [];
	let cwd: string;
	let sessionManager: SessionManager;

	beforeEach(async () => {
		appended.length = 0;
		notifications.length = 0;
		customCalls.length = 0;
		reviewCalls.length = 0;
		promptEvents.length = 0;
		cwd = makeWorkspace();
		sessionManager = SessionManager.inMemory(cwd, { id: "sess-1" });
		const planPath = path.join(cwd, ".stepcode", "plans", "session-sess-1.md");
		mkdirSync(path.dirname(planPath), { recursive: true });
		writeFileSync(planPath, "# The plan\n1. Do the thing\n");
	});

	/**
	 * Load the real plan extension through the loader and bind a UI context in
	 * the given mode, with or without a `reviewPlan` bridge.
	 */
	async function setupRunner(mode: "tui" | "rpc", withReviewPlan: boolean) {
		const stepPlanSource = fileURLToPath(new URL("../src/features/step-plan.ts", import.meta.url));
		const extensionPath = path.join(cwd, "step-plan-extension.ts");
		writeFileSync(
			extensionPath,
			`import { createStepPlanExtension } from "./${path.relative(cwd, stepPlanSource)}";\n` +
				`export default createStepPlanExtension();\n`,
		);
		const loaded = await loadExtensions([extensionPath], cwd);
		expect(loaded.errors).toEqual([]);
		const runner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			cwd,
			sessionManager,
			await createInMemoryModelRegistry(AuthStorage.inMemory()),
		);
		let activeTools = ["read_file", "write_file"];
		runner.bindCore(
			{
				sendMessage: () => {},
				sendUserMessage: () => {},
				appendEntry: (customType: string, data: unknown) => {
					appended.push({ customType, data });
				},
				setSessionName: () => {},
				getSessionName: () => undefined,
				setLabel: () => {},
				getActiveTools: () => [...activeTools],
				getAllTools: () => [],
				setActiveTools: (names: string[]) => {
					activeTools = [...names];
				},
				refreshTools: () => {},
				getCommands: () => [],
				setModel: async () => false,
				getThinkingLevel: () => "off",
				setThinkingLevel: () => {},
			},
			{
				getModel: () => undefined,
				isIdle: () => true,
				isProjectTrusted: () => true,
				getSignal: () => undefined,
				abort: () => {},
				hasPendingMessages: () => false,
				shutdown: () => {},
				getContextUsage: () => undefined,
				compact: () => {},
				getSystemPrompt: () => "",
				getScopedModels: () => [],
			},
		);
		const ui = {
			notify: (message: string, type?: string) => {
				notifications.push({ message, type });
			},
			select: async () => undefined,
			input: async () => undefined,
			editor: async () => undefined,
			custom: async () => {
				customCalls.push(true);
				return { action: "execute" } as PlanReviewResult;
			},
			setStatus: () => {},
			setWidget: () => {},
			theme: { fg: (_color: string, text: string) => text },
			...(withReviewPlan
				? {
						reviewPlan: async (request: unknown, opts: unknown) => {
							reviewCalls.push({ request, opts });
							return { action: "dismissed" } as PlanReviewResult;
						},
					}
				: {}),
		} as unknown as ExtensionUIContext;
		runner.setUIContext(ui, mode);
		// Observe the ui_prompt lifecycle the wrapper emits around a plan review.
		for (const type of ["ui_prompt_start", "ui_prompt_end"]) {
			const handlers = loaded.extensions[0]!.handlers.get(type) ?? [];
			handlers.push(async (event) => {
				promptEvents.push(event as { type: string; kind?: string });
			});
			loaded.extensions[0]!.handlers.set(type, handlers);
		}
		const tools = wrapRegisteredTools(runner.getAllRegisteredTools(), runner);
		const exitTool = tools.find((tool) => tool.name === "exit_plan_mode");
		expect(exitTool).toBeDefined();
		const planCommand = runner.getRegisteredCommands().find((command) => command.name === "plan");
		expect(planCommand).toBeDefined();
		await planCommand!.handler("", runner.createCommandContext());
		return { runner, exitTool: exitTool! };
	}

	function lastPlanEntry(): Record<string, unknown> {
		const entry = appended.filter((candidate) => candidate.customType === "step-plan").at(-1);
		expect(entry, "a step-plan entry was persisted").toBeDefined();
		return entry!.data as Record<string, unknown>;
	}

	test("a TUI-shaped context without a review bridge renders the in-process dialog", async () => {
		const { exitTool } = await setupRunner("tui", false);

		const result = (await exitTool.execute("call-1", {}, undefined, undefined)) as {
			content: Array<{ type: string; text: string }>;
			details?: PlanReviewDetails;
		};
		// The capability probe must see a host without a bridge and fall back to
		// the in-process component; an undefined bridge answer here would strand
		// the TUI user outside the review dialog entirely.
		expect(customCalls).toHaveLength(1);
		expect(reviewCalls).toHaveLength(0);
		expect(result.content[0]!.text).toContain("The user approved the plan");
		expect(result.details).toMatchObject({ outcome: "approved", approvalSource: "user", planModeExited: true });
		expect(lastPlanEntry().enabled).toBe(false);
		expect(promptEvents.map((event) => event.kind)).toEqual(["custom", "custom"]);
	});

	test("an rpc context without a review bridge keeps the external handoff", async () => {
		const { exitTool } = await setupRunner("rpc", false);

		const result = (await exitTool.execute("call-1", {}, undefined, undefined)) as {
			content: Array<{ type: string; text: string }>;
			details?: PlanReviewDetails;
		};
		expect(customCalls).toHaveLength(0);
		expect(result.content[0]!.text).toContain("caller should approve externally");
		expect(notifications.some((entry) => entry.message.includes("RPC host has no plan-review bridge"))).toBe(true);
		expect(result.details).toMatchObject({
			outcome: "external_approval_required",
			approvalSource: "external",
			planModeExited: true,
		});
		expect(lastPlanEntry().enabled).toBe(false);
	});

	test("an rpc context with a review bridge waits for the bridged answer", async () => {
		const { exitTool } = await setupRunner("rpc", true);

		const result = (await exitTool.execute("call-1", {}, undefined, undefined)) as {
			content: Array<{ type: string; text: string }>;
			details?: PlanReviewDetails;
			terminate?: boolean;
		};
		// The wrapper forwards the snapshot to the bound bridge, not to the
		// in-process component, and an explicit dismissal stays a decision.
		expect(customCalls).toHaveLength(0);
		expect(reviewCalls).toHaveLength(1);
		expect(reviewCalls[0]!.request).toMatchObject({
			planFilePath: path.join(cwd, ".stepcode", "plans", "session-sess-1.md"),
			planContents: "# The plan\n1. Do the thing\n",
			planHash: createHash("sha256").update("# The plan\n1. Do the thing\n", "utf8").digest("hex"),
			title: PLAN_REVIEW_PROMPT,
		});
		expect((reviewCalls[0]!.opts as { timeout?: number }).timeout).toBeGreaterThan(60_000);
		expect(result.terminate).toBe(true);
		expect(result.content[0]!.text).toContain("The user dismissed the review");
		expect(result.details).toMatchObject({
			outcome: "dismissed",
			approvalSource: "user",
			planModeExited: false,
		});
		expect(result.details?.bridgeFailed).toBeUndefined();
		expect(lastPlanEntry().enabled).toBe(true);
		// The wrapper fires the plan_review lifecycle around the bridged review.
		expect(promptEvents.map((event) => event.kind)).toEqual(["plan_review", "plan_review"]);
		expect(promptEvents.map((event) => event.type)).toEqual(["ui_prompt_start", "ui_prompt_end"]);
	});
});
