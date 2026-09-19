import type { AgentToolResult } from "@step-harness/agent-core";
import { visibleWidth } from "@step-harness/pi-tui";
import { expect, test, vi } from "vitest";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
	ToolRenderContext,
} from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createStepTasksExtension, type StepTask } from "../src/features/step-tasks.ts";
import type { Theme } from "../src/theme/theme.ts";

interface TasksSnapshot {
	tasks: StepTask[];
	nextId: number;
}

function createApi(sessionManager = SessionManager.inMemory("/workspace")): {
	api: ExtensionAPI;
	tools: Map<string, ToolDefinition>;
	entries: TasksSnapshot[];
	sessionManager: SessionManager;
	commands: Map<string, { handler: (args: string, ctx: ExtensionContext) => unknown }>;
	emit: (event: { type: string } & Record<string, unknown>, ctx: ExtensionContext) => Promise<unknown>;
} {
	const tools = new Map<string, ToolDefinition>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => unknown }>();
	const entries: TasksSnapshot[] = [];
	const handlers = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
	const api = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => unknown }) {
			commands.set(name, command);
		},
		registerFlag: () => {},
		on(event: string, handler: (event: never, ctx: ExtensionContext) => unknown) {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
		getActiveTools: () => [],
		setActiveTools: () => {},
		getFlag: () => false,
		appendEntry: (customType: string, data: TasksSnapshot) => {
			expect(customType).toBe("step-tasks");
			entries.push(data);
			sessionManager.appendCustomEntry(customType, data);
		},
		sendMessage: () => {},
		sendUserMessage: () => {},
	} as unknown as ExtensionAPI;
	return {
		api,
		tools,
		entries,
		sessionManager,
		commands,
		emit: async (event, ctx) => {
			let last: unknown;
			for (const handler of handlers.get(event.type) ?? []) {
				last = await handler(event as never, ctx);
			}
			return last;
		},
	};
}

function createContext(
	entries: Array<{ type: string; customType: string; data: unknown }> = [],
	sessionManager?: SessionManager,
): ExtensionContext {
	return {
		hasUI: true,
		mode: "tui",
		ui: { setWidget: vi.fn(), notify: vi.fn() },
		cwd: "/workspace",
		sessionManager: sessionManager ?? {
			getEntries: () => entries,
			getBranch: () => entries,
			getSessionId: () => "session-test",
		},
	} as unknown as ExtensionContext;
}

async function runResult(
	tools: Map<string, ToolDefinition>,
	name: string,
	params: unknown,
	ctx = createContext(),
): Promise<AgentToolResult<unknown>> {
	const tool = tools.get(name);
	expect(tool, `tool ${name} is registered`).toBeDefined();
	return tool!.execute(`${name}-call`, params as never, undefined, undefined, ctx);
}

async function run(
	tools: Map<string, ToolDefinition>,
	name: string,
	params: unknown,
	ctx = createContext(),
): Promise<unknown> {
	return (await runResult(tools, name, params, ctx)).details;
}

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

function renderContext(
	expanded = false,
	isError = false,
): ToolRenderContext<Record<string, unknown>, Record<string, unknown>> {
	return {
		args: {},
		toolCallId: "task-call",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: "/workspace",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded,
		showImages: false,
		isError,
	};
}

function renderResult(
	tool: ToolDefinition,
	result: AgentToolResult<unknown>,
	expanded = false,
	isError = false,
): string {
	expect(tool.renderResult).toBeTypeOf("function");
	return tool.renderResult!(result, { expanded, isPartial: false }, plainTheme, renderContext(expanded, isError))
		.render(120)
		.join("\n");
}

test("task_create returns a fresh id and task_get round-trips the stored task", async () => {
	const { api, tools } = createApi();
	createStepTasksExtension()(api);
	expect([...tools.keys()].sort()).toEqual(["task_create", "task_get", "task_list", "task_update"]);

	const created = (await run(tools, "task_create", {
		subject: "Write the parser",
		description: "Implement the tokenizer and grammar",
		activeForm: "Writing the parser",
	})) as { id: string; subject: string; status: string };
	expect(created).toMatchObject({ id: "1", subject: "Write the parser", status: "pending" });

	const fetched = (await run(tools, "task_get", { taskId: created.id })) as StepTask;
	expect(fetched).toMatchObject({
		id: "1",
		subject: "Write the parser",
		description: "Implement the tokenizer and grammar",
		activeForm: "Writing the parser",
		status: "pending",
		blocks: [],
		blockedBy: [],
	});
	expect(fetched.createdAt).toBeGreaterThan(0);

	await expect(run(tools, "task_get", { taskId: "999" })).rejects.toThrow('No task with id "999"');
});

test("task_update drives the lifecycle, keeps dependencies symmetric, and task_list reports open blockers", async () => {
	const { api, tools } = createApi();
	createStepTasksExtension()(api);
	const first = (await run(tools, "task_create", { subject: "One", description: "first" })) as { id: string };
	const second = (await run(tools, "task_create", { subject: "Two", description: "second" })) as { id: string };
	expect(second.id).toBe("2");

	const blocked = (await run(tools, "task_update", {
		taskId: second.id,
		addBlockedBy: [first.id],
		metadata: { lane: "b" },
	})) as StepTask;
	expect(blocked.blockedBy).toEqual([first.id]);
	expect(blocked.metadata).toEqual({ lane: "b" });
	const blocker = (await run(tools, "task_get", { taskId: first.id })) as StepTask;
	expect(blocker.blocks).toEqual([second.id]);

	await run(tools, "task_update", { taskId: first.id, status: "in_progress", owner: "worker-a" });
	let list = (await run(tools, "task_list", {})) as Array<Record<string, unknown>>;
	expect(list).toEqual([
		{ id: "1", subject: "One", status: "in_progress", owner: "worker-a", blockedBy: [] },
		{ id: "2", subject: "Two", status: "pending", owner: undefined, blockedBy: ["1"] },
	]);

	await run(tools, "task_update", { taskId: first.id, status: "completed" });
	list = (await run(tools, "task_list", {})) as Array<Record<string, unknown>>;
	expect(list[1]).toMatchObject({ id: "2", blockedBy: [] });

	const removal = (await run(tools, "task_update", { taskId: first.id, status: "deleted" })) as {
		deleted: boolean;
	};
	expect(removal.deleted).toBe(true);
	const survivor = (await run(tools, "task_get", { taskId: second.id })) as StepTask;
	expect(survivor.blockedBy).toEqual([]);
	await expect(run(tools, "task_get", { taskId: first.id })).rejects.toThrow("No task with id");
});

test("session_start restores the latest persisted snapshot and keeps ids monotonic", async () => {
	const source = createApi();
	createStepTasksExtension()(source.api);
	await run(source.tools, "task_create", { subject: "Persisted", description: "carried across reload" });
	await run(source.tools, "task_update", { taskId: "1", status: "in_progress" });
	expect(source.entries.length).toBe(2);

	const reloaded = createApi();
	createStepTasksExtension()(reloaded.api);
	const ctx = createContext(source.entries.map((data) => ({ type: "custom", customType: "step-tasks", data })));
	await reloaded.emit({ type: "session_start" }, ctx);

	const restored = (await run(reloaded.tools, "task_get", { taskId: "1" })) as StepTask;
	expect(restored).toMatchObject({ id: "1", subject: "Persisted", status: "in_progress" });
	const next = (await run(reloaded.tools, "task_create", { subject: "After reload", description: "next id" })) as {
		id: string;
	};
	expect(next.id).toBe("2");
});

test("task_update with an unknown dependency id fails atomically without mutating the task", async () => {
	const { api, tools, entries } = createApi();
	createStepTasksExtension()(api);
	const first = (await run(tools, "task_create", { subject: "Stable", description: "original description" })) as {
		id: string;
	};
	const second = (await run(tools, "task_create", { subject: "Peer", description: "potential link target" })) as {
		id: string;
	};
	const before = structuredClone((await run(tools, "task_get", { taskId: first.id })) as StepTask);
	const persistedBefore = entries.length;

	await expect(
		run(tools, "task_update", {
			taskId: first.id,
			subject: "Changed",
			description: "changed description",
			status: "in_progress",
			owner: "worker-x",
			metadata: { lane: "a" },
			addBlocks: [second.id, "999"],
			addBlockedBy: [second.id],
		}),
	).rejects.toThrow('No task with id "999"');

	// A failing update must not leak field mutations, links, or a snapshot.
	expect((await run(tools, "task_get", { taskId: first.id })) as StepTask).toEqual(before);
	let peer = (await run(tools, "task_get", { taskId: second.id })) as StepTask;
	expect(peer.blocks).toEqual([]);
	expect(peer.blockedBy).toEqual([]);
	expect(entries.length).toBe(persistedBefore);

	// Same guarantee when the bad id sits in addBlockedBy after valid addBlocks.
	await expect(
		run(tools, "task_update", { taskId: first.id, owner: "worker-y", addBlocks: [second.id], addBlockedBy: ["777"] }),
	).rejects.toThrow('No task with id "777"');
	expect((await run(tools, "task_get", { taskId: first.id })) as StepTask).toEqual(before);
	peer = (await run(tools, "task_get", { taskId: second.id })) as StepTask;
	expect(peer.blockedBy).toEqual([]);
	expect(entries.length).toBe(persistedBefore);
});

test("deleting the highest-id task never recycles its id, in session and across reload", async () => {
	const source = createApi();
	createStepTasksExtension()(source.api);
	await run(source.tools, "task_create", { subject: "Keep", description: "survives" });
	const doomed = (await run(source.tools, "task_create", {
		subject: "Doomed",
		description: "deleted before reload",
	})) as { id: string };
	expect(doomed.id).toBe("2");
	await run(source.tools, "task_update", { taskId: doomed.id, status: "deleted" });

	// Same session: the freed id is not handed out again.
	const inSession = (await run(source.tools, "task_create", {
		subject: "Third",
		description: "in-session create",
	})) as { id: string };
	expect(Number(inSession.id)).toBeGreaterThan(Number(doomed.id));
	expect(inSession.id).toBe("3");
	await run(source.tools, "task_update", { taskId: inSession.id, status: "deleted" });

	// Across reload: the highest ids ("2", "3") were deleted, so a recomputed
	// counter would restart at 2. The persisted counter must keep advancing.
	const reloaded = createApi();
	createStepTasksExtension()(reloaded.api);
	const ctx = createContext(source.entries.map((data) => ({ type: "custom", customType: "step-tasks", data })));
	await reloaded.emit({ type: "session_start" }, ctx);
	const afterReload = (await run(reloaded.tools, "task_create", {
		subject: "Fourth",
		description: "post-reload create",
	})) as { id: string };
	expect(Number(afterReload.id)).toBeGreaterThan(Number(inSession.id));
	expect(afterReload.id).toBe("4");
});

test("session_start falls back to one past the highest surviving id for legacy snapshots without a counter", async () => {
	const reloaded = createApi();
	createStepTasksExtension()(reloaded.api);
	const legacyTask: StepTask = {
		id: "5",
		subject: "Legacy",
		description: "snapshot without counter",
		status: "pending",
		blocks: [],
		blockedBy: [],
		createdAt: 1,
		updatedAt: 1,
	};
	const ctx = createContext([{ type: "custom", customType: "step-tasks", data: { tasks: [legacyTask] } }]);
	await reloaded.emit({ type: "session_start" }, ctx);
	const created = (await run(reloaded.tools, "task_create", { subject: "After legacy", description: "next id" })) as {
		id: string;
	};
	expect(created.id).toBe("6");
});

test("updates never mutate historical SessionManager snapshots or returned task details", async () => {
	const source = createApi();
	createStepTasksExtension()(source.api);
	await run(source.tools, "task_create", { subject: "One", description: "first", metadata: { nested: { value: 1 } } });
	const firstSnapshot = structuredClone(source.entries[0]);
	const fetched = await run(source.tools, "task_get", { taskId: "1" });
	const fetchedBefore = structuredClone(fetched);
	await run(source.tools, "task_create", { subject: "Two", description: "second" });
	const updated = await run(source.tools, "task_update", { taskId: "1", addBlocks: ["2"] });
	const updatedBefore = structuredClone(updated);
	await run(source.tools, "task_update", { taskId: "1", status: "completed", metadata: { nested: { value: 2 } } });
	await run(source.tools, "task_update", { taskId: "2", status: "deleted" });

	expect(source.entries[0]).toEqual(firstSnapshot);
	expect(fetched).toEqual(fetchedBefore);
	expect(updated).toEqual(updatedBefore);
	const persisted = source.sessionManager.getEntries()[0];
	expect(persisted.type === "custom" && persisted.data).toEqual(firstSnapshot);
});

test("input metadata and returned task details do not alias live task data", async () => {
	const source = createApi();
	createStepTasksExtension()(source.api);
	const metadata = { nested: { values: [1] } };
	await run(source.tools, "task_create", { subject: "One", description: "first", metadata });
	metadata.nested.values.push(2);
	expect(((await run(source.tools, "task_get", { taskId: "1" })) as StepTask).metadata).toEqual({
		nested: { values: [1] },
	});

	const updates = { nested: { values: [3] } };
	await run(source.tools, "task_update", { taskId: "1", metadata: updates });
	updates.nested.values.push(4);
	const result = (await run(source.tools, "task_get", { taskId: "1" })) as StepTask;
	expect(result.metadata).toEqual({ nested: { values: [3] } });
	result.subject = "corrupted result";
	result.blockedBy.push("missing");
	(result.metadata?.nested as { values: number[] }).values.push(5);
	expect(await run(source.tools, "task_get", { taskId: "1" })).toMatchObject({
		subject: "One",
		blockedBy: [],
		metadata: { nested: { values: [3] } },
	});
});

test("restored task objects and dependency arrays do not alias the stored snapshot", async () => {
	const source = createApi();
	createStepTasksExtension()(source.api);
	await run(source.tools, "task_create", { subject: "One", description: "first" });
	await run(source.tools, "task_create", { subject: "Two", description: "second" });
	const snapshot = structuredClone(source.entries.at(-1));
	const reloaded = createApi(source.sessionManager);
	createStepTasksExtension()(reloaded.api);
	await reloaded.emit({ type: "session_start" }, createContext([], source.sessionManager));
	await run(reloaded.tools, "task_update", { taskId: "1", addBlocks: ["2"] });
	expect(source.entries.at(-1)).toEqual(snapshot);
});

test("session_start restores only the active branch and allocates IDs beyond sibling history", async () => {
	const source = createApi();
	createStepTasksExtension()(source.api);
	await run(source.tools, "task_create", { subject: "Base", description: "pending here" });
	const base = source.sessionManager.getLeafId()!;
	await run(source.tools, "task_update", { taskId: "1", status: "completed" });
	await run(source.tools, "task_create", { subject: "Other branch", description: "not here" });
	source.sessionManager.branch(base);

	const reloaded = createApi(source.sessionManager);
	createStepTasksExtension()(reloaded.api);
	await reloaded.emit({ type: "session_start" }, createContext([], source.sessionManager));
	expect(await run(reloaded.tools, "task_list", {})).toEqual([
		{ id: "1", subject: "Base", status: "pending", owner: undefined, blockedBy: [] },
	]);
	expect(await run(reloaded.tools, "task_create", { subject: "This branch", description: "new" })).toMatchObject({
		id: "3",
	});
});

test("session_tree restores sibling task contents without changing either branch", async () => {
	const source = createApi();
	createStepTasksExtension()(source.api);
	const ctx = createContext([], source.sessionManager);
	await run(source.tools, "task_create", { subject: "Base", description: "first" });
	const base = source.sessionManager.getLeafId()!;
	await run(source.tools, "task_update", { taskId: "1", status: "completed" });
	const completedBranch = source.sessionManager.getLeafId()!;
	source.sessionManager.branch(base);
	await source.emit({ type: "session_tree" }, ctx);
	expect(await run(source.tools, "task_get", { taskId: "1" })).toMatchObject({ status: "pending" });
	await run(source.tools, "task_create", { subject: "Sibling", description: "second" });
	const siblingBranch = source.sessionManager.getLeafId()!;
	source.sessionManager.branch(completedBranch);
	await source.emit({ type: "session_tree" }, ctx);
	expect(await run(source.tools, "task_list", {})).toEqual([
		{ id: "1", subject: "Base", status: "completed", owner: undefined, blockedBy: [] },
	]);
	source.sessionManager.branch(siblingBranch);
	await source.emit({ type: "session_tree" }, ctx);
	expect(await run(source.tools, "task_list", {})).toHaveLength(2);
	expect(await run(source.tools, "task_get", { taskId: "1" })).toMatchObject({ status: "pending" });
});

test("an empty branch clears tasks but never reuses an ID from the session", async () => {
	const source = createApi();
	createStepTasksExtension()(source.api);
	await run(source.tools, "task_create", { subject: "Future", description: "discarded branch" });
	source.sessionManager.resetLeaf();
	await source.emit({ type: "session_tree" }, createContext([], source.sessionManager));
	expect(await run(source.tools, "task_list", {})).toEqual([]);
	expect(await run(source.tools, "task_create", { subject: "Fresh branch", description: "new" })).toMatchObject({
		id: "2",
	});
});

test("session_start clears stale tasks when the session has no snapshot", async () => {
	const source = createApi();
	createStepTasksExtension()(source.api);
	await run(source.tools, "task_create", { subject: "Old", description: "previous session" });
	source.sessionManager.newSession();
	await source.emit({ type: "session_start" }, createContext([], source.sessionManager));
	expect(await run(source.tools, "task_list", {})).toEqual([]);
	expect(await run(source.tools, "task_create", { subject: "New", description: "fresh session" })).toMatchObject({
		id: "1",
	});
});

test("task snapshots survive compaction even when they precede retained messages", async () => {
	const source = createApi();
	createStepTasksExtension()(source.api);
	await run(source.tools, "task_create", { subject: "Retained", description: "still open" });
	const kept = source.sessionManager.appendCustomEntry("test-retained-entry", {});
	source.sessionManager.appendCompaction("summary", kept, 1000);
	const reloaded = createApi(source.sessionManager);
	createStepTasksExtension()(reloaded.api);
	await reloaded.emit({ type: "session_start" }, createContext([], source.sessionManager));
	expect(await run(reloaded.tools, "task_get", { taskId: "1" })).toMatchObject({ subject: "Retained" });
});

test.each([
	{ name: "reverse edge", existing: [{ taskId: "1", addBlocks: ["2"] }], update: { taskId: "2", addBlocks: ["1"] } },
	{
		name: "transitive cycle",
		existing: [
			{ taskId: "1", addBlocks: ["2"] },
			{ taskId: "2", addBlocks: ["3"] },
		],
		update: { taskId: "3", addBlocks: ["1"] },
	},
	{
		name: "mixed update",
		existing: [{ taskId: "2", addBlocks: ["3"] }],
		update: { taskId: "1", addBlocks: ["2"], addBlockedBy: ["3"] },
	},
	{ name: "two new opposing edges", existing: [], update: { taskId: "1", addBlocks: ["2"], addBlockedBy: ["2"] } },
])("task_update rejects $name atomically", async ({ existing, update }) => {
	const source = createApi();
	createStepTasksExtension()(source.api);
	for (const subject of ["One", "Two", "Three"]) {
		await run(source.tools, "task_create", { subject, description: "test" });
	}
	for (const edge of existing) await run(source.tools, "task_update", edge);
	const before = structuredClone(source.entries.at(-1));
	const snapshots = source.entries.length;
	await expect(
		run(source.tools, "task_update", {
			...update,
			subject: "Must not change",
			status: "in_progress",
			metadata: { changed: true },
		}),
	).rejects.toThrow(/cycle/i);
	expect(source.entries).toHaveLength(snapshots);
	expect(source.entries.at(-1)).toEqual(before);
	for (const task of before!.tasks) expect(await run(source.tools, "task_get", { taskId: task.id })).toEqual(task);
});

test("duplicate and converging dependencies remain valid", async () => {
	const source = createApi();
	createStepTasksExtension()(source.api);
	for (const subject of ["One", "Two", "Three"])
		await run(source.tools, "task_create", { subject, description: "test" });
	await run(source.tools, "task_update", { taskId: "1", addBlocks: ["2", "3", "2"] });
	await run(source.tools, "task_update", { taskId: "2", addBlocks: ["3"], addBlockedBy: ["1"] });
	expect(await run(source.tools, "task_get", { taskId: "1" })).toMatchObject({ blocks: ["2", "3"] });
	expect(await run(source.tools, "task_get", { taskId: "3" })).toMatchObject({ blockedBy: ["1", "2"] });
});

test("/todos belongs to task tracking and lists open blockers without plan mode", async () => {
	const { api, tools, commands } = createApi();
	createStepTasksExtension()(api);
	const ctx = createContext();
	expect(commands.get("todos")).toBeDefined();
	await commands.get("todos")!.handler("", ctx);
	expect(ctx.ui.notify).toHaveBeenLastCalledWith("No tasks tracked. Use task_create to add some.", "info");
	await run(tools, "task_create", { subject: "Write the parser", description: "tokenizer" }, ctx);
	await run(tools, "task_create", { subject: "Add tests", description: "regression" }, ctx);
	await run(tools, "task_update", { taskId: "1", status: "in_progress", owner: "worker-a" }, ctx);
	await run(tools, "task_update", { taskId: "2", addBlockedBy: ["1"] }, ctx);
	await commands.get("todos")!.handler("", ctx);
	expect(ctx.ui.notify).toHaveBeenLastCalledWith(
		"wip 1. Write the parser @worker-a\ntodo 2. Add tests (blocked by 1)",
		"info",
	);
	await run(tools, "task_update", { taskId: "1", status: "completed" }, ctx);
	await commands.get("todos")!.handler("", ctx);
	expect(ctx.ui.notify).toHaveBeenLastCalledWith("done 1. Write the parser @worker-a\ntodo 2. Add tests", "info");
});

test("task updates retain the full ordered plan without creating a persistent RPC widget", async () => {
	const { api, tools } = createApi();
	createStepTasksExtension()(api);
	const ctx = { ...createContext(), mode: "rpc" as const };
	for (let i = 1; i <= 8; i++) {
		await run(
			tools,
			"task_create",
			{ subject: `Task ${i}`, description: "work", activeForm: `Working on ${i}` },
			ctx,
		);
	}
	await run(tools, "task_update", { taskId: "1", status: "completed" }, ctx);
	const result = await runResult(tools, "task_update", { taskId: "8", status: "in_progress" }, ctx);
	expect(ctx.ui.setWidget).not.toHaveBeenCalled();
	const rendered = renderResult(tools.get("task_update")!, result);
	expect(rendered).toContain("✔ Task 1");
	expect(rendered).toContain("Updated Plan (1/8)");
	expect(rendered).toContain("◧ Task 8");
	expect(rendered).not.toContain("(in progress)");
	for (let index = 2; index <= 7; index++) expect(rendered).toContain(`□ Task ${index}`);
	expect(rendered.indexOf("Task 1")).toBeLessThan(rendered.indexOf("Task 8"));
});

test("task plan flattens untrusted titles without changing stored data", async () => {
	const { api, tools } = createApi();
	createStepTasksExtension()(api);
	const ctx = createContext();
	const subject = `\u001b[31mLong\n\t${"界".repeat(150)}\u001b[0m`;
	await run(tools, "task_create", { subject, description: "raw data stays intact" }, ctx);
	const result = await runResult(tools, "task_list", {}, ctx);
	const lines = renderResult(tools.get("task_list")!, result).split("\n");
	for (const line of lines) {
		expect(line).not.toMatch(/[\r\n\t\u001b]/);
		expect(visibleWidth(line)).toBeLessThanOrEqual(120);
	}
	expect(await run(tools, "task_get", { taskId: "1" })).toMatchObject({ subject });
});

test("branch restores, completion, deletion and fresh sessions never mount a task widget", async () => {
	const source = createApi();
	createStepTasksExtension()(source.api);
	const ctx = createContext([], source.sessionManager);
	await run(source.tools, "task_create", { subject: "One", description: "first" }, ctx);
	const pending = source.sessionManager.getLeafId()!;
	await run(source.tools, "task_update", { taskId: "1", status: "completed" }, ctx);
	expect(ctx.ui.setWidget).not.toHaveBeenCalled();
	source.sessionManager.branch(pending);
	await source.emit({ type: "session_tree" }, ctx);
	expect(ctx.ui.setWidget).not.toHaveBeenCalled();
	await run(source.tools, "task_update", { taskId: "1", status: "deleted" }, ctx);
	expect(ctx.ui.setWidget).not.toHaveBeenCalled();
	source.sessionManager.branch(pending);
	await source.emit({ type: "session_start" }, ctx);
	expect(ctx.ui.setWidget).not.toHaveBeenCalled();
	source.sessionManager.newSession();
	await source.emit({ type: "session_start" }, ctx);
	expect(ctx.ui.setWidget).not.toHaveBeenCalled();
});

test("failed updates and read-only task tools do not refresh the widget", async () => {
	const { api, tools } = createApi();
	createStepTasksExtension()(api);
	const ctx = createContext();
	await run(tools, "task_create", { subject: "One", description: "first" }, ctx);
	expect(ctx.ui.setWidget).not.toHaveBeenCalled();
	await expect(run(tools, "task_update", { taskId: "1", addBlocks: ["1"] }, ctx)).rejects.toThrow();
	await run(tools, "task_get", { taskId: "1" }, ctx);
	await run(tools, "task_list", {}, ctx);
	expect(ctx.ui.setWidget).not.toHaveBeenCalled();
});

test("headless task tracking needs no UI", async () => {
	const source = createApi();
	createStepTasksExtension()(source.api);
	const ctx = { ...createContext([], source.sessionManager), hasUI: false };
	await source.emit({ type: "session_start" }, ctx);
	await run(source.tools, "task_create", { subject: "One", description: "first" }, ctx);
	await run(source.tools, "task_update", { taskId: "1", status: "completed" }, ctx);
	expect(ctx.ui.setWidget).not.toHaveBeenCalled();
});

test("task calls stay hidden until a result provides the plan snapshot", async () => {
	const { api, tools } = createApi();
	createStepTasksExtension()(api);
	for (const tool of tools.values()) {
		expect(tool.renderCall).toBeTypeOf("function");
		expect(tool.renderResult).toBeTypeOf("function");
		const lines = tool.renderCall!(
			{ subject: `A\n${"界".repeat(200)}`, taskId: "1", status: "in_progress" },
			plainTheme,
			renderContext(),
		).render(40);
		expect(tool.renderShell).toBe("self");
		expect(lines).toEqual([]);
	}
});

test("task result history renders its own snapshot and expands all task fields", async () => {
	const { api, tools } = createApi();
	createStepTasksExtension()(api);
	const created = await runResult(tools, "task_create", {
		subject: "Write parser",
		description: "Detailed grammar",
		metadata: { lane: "syntax" },
	});
	const fetched = await runResult(tools, "task_get", { taskId: "1" });
	const updated = await runResult(tools, "task_update", { taskId: "1", status: "in_progress", owner: "worker-a" });
	await run(tools, "task_update", { taskId: "1", status: "completed" });
	expect(renderResult(tools.get("task_create")!, created)).toBe("");
	expect(renderResult(tools.get("task_get")!, fetched)).toBe("");
	expect(renderResult(tools.get("task_get")!, fetched)).not.toContain("Detailed grammar");
	expect(renderResult(tools.get("task_update")!, updated)).toContain("Updated Plan (0/1)");
	expect(renderResult(tools.get("task_update")!, updated)).toContain("◧ Write parser @worker-a");
	expect(updated.content).not.toEqual(
		expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('"plan"') })]),
	);
	const expanded = renderResult(tools.get("task_get")!, fetched, true);
	expect(expanded).toContain("Detailed grammar");
	expect(expanded).toContain('"lane": "syntax"');
	expect(expanded).toContain('"blocks"');
	const removed = await runResult(tools, "task_update", { taskId: "1", status: "deleted" });
	expect(renderResult(tools.get("task_update")!, removed)).toContain("No tasks tracked.");
	expect(renderResult(tools.get("task_update")!, removed)).toContain("Updated Plan (0/0)");
});

test("parallel updates snapshot the committed task state without losing progress", async () => {
	const source = createApi();
	createStepTasksExtension()(source.api);
	for (let index = 1; index <= 5; index++) {
		await run(source.tools, "task_create", { subject: `Task ${index}`, description: "work" });
	}
	const results = await Promise.all([
		runResult(source.tools, "task_update", { taskId: "1", status: "completed" }),
		runResult(source.tools, "task_update", { taskId: "2", status: "completed" }),
		runResult(source.tools, "task_update", { taskId: "3", status: "in_progress" }),
	]);
	for (const [index, result] of results.entries()) {
		const snapshot = source.entries[5 + index]!;
		const completed = snapshot.tasks.filter((task) => task.status === "completed").length;
		expect(result.details).toMatchObject({
			plan: snapshot.tasks.map(({ id, subject, status }) => ({ id, subject, status })),
		});
		expect(renderResult(source.tools.get("task_update")!, result)).toContain(`Updated Plan (${completed}/5)`);
	}
	const latest = await runResult(source.tools, "task_list", {});
	expect(renderResult(source.tools.get("task_list")!, latest)).toContain("Updated Plan (2/5)");
	const writes = source.entries.length;
	await expect(
		run(source.tools, "task_update", { taskId: "3", status: "completed", addBlocks: ["999"] }),
	).rejects.toThrow("No task with id");
	expect(source.entries).toHaveLength(writes);
	expect(await runResult(source.tools, "task_list", {})).toEqual(latest);
	const reopened = await runResult(source.tools, "task_update", { taskId: "1", status: "in_progress" });
	expect(renderResult(source.tools.get("task_update")!, reopened)).toContain("Updated Plan (1/5)");
	const deleted = await runResult(source.tools, "task_update", { taskId: "2", status: "deleted" });
	expect(renderResult(source.tools.get("task_update")!, deleted)).toContain("Updated Plan (0/4)");
	expect(renderResult(source.tools.get("task_list")!, latest)).toContain("Updated Plan (2/5)");
	const restored = createApi(source.sessionManager);
	createStepTasksExtension()(restored.api);
	await restored.emit({ type: "session_start" }, createContext([], source.sessionManager));
	expect(renderResult(restored.tools.get("task_list")!, await runResult(restored.tools, "task_list", {}))).toContain(
		"Updated Plan (0/4)",
	);
});

test("partial results and legacy single-task results never invent a full-plan count", () => {
	const { api, tools } = createApi();
	createStepTasksExtension()(api);
	const tool = tools.get("task_update")!;
	const result = { content: [], details: { id: "1", subject: "Old task", status: "completed" } };
	expect(renderResult(tool, result)).toContain("Updated Plan\n");
	expect(renderResult(tool, result)).not.toContain("(1/1)");
	expect(
		tool.renderResult!(result, { expanded: false, isPartial: true }, plainTheme, renderContext()).render(80),
	).toEqual([]);
});

test("task list shows every step without requiring expansion", async () => {
	const { api, tools } = createApi();
	createStepTasksExtension()(api);
	for (let i = 1; i <= 7; i++) await run(tools, "task_create", { subject: `Task ${i}`, description: "work" });
	await run(tools, "task_update", { taskId: "2", addBlockedBy: ["1"] });
	const result = await runResult(tools, "task_list", {});
	const collapsed = renderResult(tools.get("task_list")!, result);
	expect(collapsed).toContain("□ Task 2 (blocked by 1)");
	expect(collapsed).toContain("□ Task 6");
	expect(collapsed).toContain("□ Task 7");
	expect(renderResult(tools.get("task_list")!, result, true)).toContain("Task 7");
});

test("individual task summaries do not mislabel full dependency lists as open blockers", async () => {
	const { api, tools } = createApi();
	createStepTasksExtension()(api);
	await run(tools, "task_create", { subject: "Done", description: "prerequisite" });
	await run(tools, "task_create", { subject: "Ready", description: "next" });
	await run(tools, "task_update", { taskId: "2", addBlockedBy: ["1"] });
	await run(tools, "task_update", { taskId: "1", status: "completed" });
	const result = await runResult(tools, "task_get", { taskId: "2" });
	expect(renderResult(tools.get("task_get")!, result)).not.toContain("blocked by");
	expect(renderResult(tools.get("task_get")!, result, true)).toContain('"blockedBy"');
});

test("task renderers retain empty, error and unfamiliar historical output", async () => {
	const { api, tools } = createApi();
	createStepTasksExtension()(api);
	expect(renderResult(tools.get("task_list")!, await runResult(tools, "task_list", {}))).toContain("No tasks tracked");
	for (const details of [undefined, { oldFormat: true }, [{ subject: 1 }]]) {
		expect(
			renderResult(tools.get("task_get")!, { content: [{ type: "text", text: "Original output" }], details }),
		).toContain("Original output");
	}
	expect(
		renderResult(
			tools.get("task_update")!,
			{ content: [{ type: "text", text: "No task with id 999" }], details: undefined },
			false,
			true,
		),
	).toContain("No task with id 999");
});

test.each([
	{ name: "unknown links", links: { addBlockedBy: ["999"] }, error: /No task with id/ },
	{ name: "self-links", links: { addBlocks: ["1"] }, error: /cannot block itself/ },
	{ name: "cycles", links: { addBlockedBy: ["2"] }, error: /cycle/ },
])("task deletion validates $name before any mutation", async ({ links, error }) => {
	const source = createApi();
	createStepTasksExtension()(source.api);
	const ctx = createContext([], source.sessionManager);
	await run(source.tools, "task_create", { subject: "One", description: "first" }, ctx);
	await run(source.tools, "task_create", { subject: "Two", description: "second" }, ctx);
	await run(source.tools, "task_update", { taskId: "1", addBlocks: ["2"] }, ctx);
	const before = structuredClone(source.entries.at(-1)!);
	const writes = source.entries.length;
	const widgets = vi.mocked(ctx.ui.setWidget).mock.calls.length;
	await expect(run(source.tools, "task_update", { taskId: "1", status: "deleted", ...links }, ctx)).rejects.toThrow(
		error,
	);
	expect(source.entries).toHaveLength(writes);
	expect(ctx.ui.setWidget).toHaveBeenCalledTimes(widgets);
	for (const task of before.tasks) expect(await run(source.tools, "task_get", { taskId: task.id }, ctx)).toEqual(task);
});

test("task_get directs readiness checks to task_list rather than the full stored links", () => {
	const { api, tools } = createApi();
	createStepTasksExtension()(api);
	expect(tools.get("task_get")!.description).toContain("task_list");
	expect(tools.get("task_get")!.description).not.toContain("Verify blockedBy is clear");
});

test("task tool descriptions identify todos rather than work execution", () => {
	const { api, tools } = createApi();
	createStepTasksExtension()(api);
	for (const tool of tools.values()) {
		expect(tool.description).toMatch(/\btodo\b/i);
		expect(tool.promptSnippet).toMatch(/\btodo\b/i);
	}
	expect(tools.get("task_create")!.description).toContain("with or without plan mode");
	expect(tools.get("task_create")!.description).toContain("does not execute or delegate");
	expect(tools.get("task_update")!.description).toContain("does not execute or schedule");
	expect(tools.get("task_get")!.description).toContain("including completed");
	expect(tools.get("task_list")!.description).toContain("unfinished prerequisites");
	expect(tools.get("task_list")!.description).toContain("resume existing work");
});

test("a new five-step plan excludes the previous three tasks and resumes them only explicitly", async () => {
	const source = createApi();
	createStepTasksExtension()(source.api);
	for (const subject of ["甲", "乙", "丙"]) {
		await run(source.tools, "task_create", { subject, description: "旧任务" });
	}
	const oldResult = await runResult(source.tools, "task_update", { taskId: "1", status: "completed" });
	const oldSnapshot = structuredClone(source.entries.at(-1));
	for (const [index, subject] of ["梳理需求", "设计方案", "搭项目骨架", "编写实现", "验证收尾"].entries()) {
		await run(source.tools, "task_create", {
			subject,
			description: "新任务",
			...(index === 0 ? { newPlan: "实现新需求" } : {}),
		});
	}
	const current = await runResult(source.tools, "task_update", { taskId: "4", status: "in_progress" });
	expect(renderResult(source.tools.get("task_update")!, current)).toContain("Updated Plan (0/5)");
	expect(renderResult(source.tools.get("task_update")!, current)).not.toMatch(/甲|乙|丙/);
	const history = await run(source.tools, "task_list", { includeHistory: true });
	expect(history).toMatchObject({
		activePlanId: "plan-4",
		plans: [
			{ id: "plan-1", title: "甲", active: false, completed: 1, total: 3 },
			{ id: "plan-4", title: "实现新需求", active: true, completed: 0, total: 5 },
		],
	});
	expect(await run(source.tools, "task_list", {})).toHaveLength(5);
	await expect(run(source.tools, "task_update", { taskId: "2", status: "completed" })).rejects.toThrow("resumePlanId");
	await expect(run(source.tools, "task_update", { taskId: "4", addBlockedBy: ["2"] })).rejects.toThrow("resumePlanId");
	const restored = await runResult(source.tools, "task_update", { resumePlanId: "plan-1" });
	expect(renderResult(source.tools.get("task_update")!, restored)).toContain("Updated Plan (1/3)");
	expect(await run(source.tools, "task_get", { taskId: "2" })).toMatchObject({ status: "pending" });
	await run(source.tools, "task_update", { taskId: "2", status: "completed" });
	const resumed = await runResult(source.tools, "task_update", { resumePlanId: "plan-4" });
	expect(renderResult(source.tools.get("task_update")!, resumed)).toContain("Updated Plan (0/5)");
	expect(await run(source.tools, "task_get", { taskId: "4" })).toMatchObject({ status: "in_progress" });
	expect(renderResult(source.tools.get("task_update")!, oldResult)).toContain("Updated Plan (1/3)");
	expect(source.entries[3]).toEqual(oldSnapshot);
});

test("plan boundaries survive turns, compaction and reload without reviving archived work", async () => {
	const source = createApi();
	createStepTasksExtension()(source.api);
	const ctx = createContext([], source.sessionManager);
	await run(source.tools, "task_create", { subject: "Old", description: "old" });
	await run(source.tools, "task_create", { subject: "Current", description: "new", newPlan: "Current plan" });
	await run(source.tools, "task_update", { taskId: "2", status: "in_progress" });
	await source.emit({ type: "turn_end" }, ctx);
	await source.emit({ type: "agent_end" }, ctx);
	await source.emit({ type: "turn_start" }, ctx);
	expect(await run(source.tools, "task_list", {})).toEqual([
		{ id: "2", subject: "Current", status: "in_progress", owner: undefined, blockedBy: [] },
	]);
	const kept = source.sessionManager.appendCustomEntry("retained", {});
	source.sessionManager.appendCompaction("summary", kept, 1000);
	const reloaded = createApi(source.sessionManager);
	createStepTasksExtension()(reloaded.api);
	await reloaded.emit({ type: "session_start" }, ctx);
	expect(await run(reloaded.tools, "task_list", {})).toEqual(await run(source.tools, "task_list", {}));
	expect(await run(reloaded.tools, "task_list", { includeHistory: true })).toMatchObject({ activePlanId: "plan-2" });
	await run(reloaded.tools, "task_update", { resumePlanId: "plan-1" });
	expect(await run(reloaded.tools, "task_get", { taskId: "1" })).toMatchObject({ subject: "Old" });
});

test("invalid plan switches leave current tasks, history and persistence unchanged", async () => {
	const source = createApi();
	createStepTasksExtension()(source.api);
	await run(source.tools, "task_create", { subject: "One", description: "old" });
	await run(source.tools, "task_create", { subject: "Two", description: "new", newPlan: "Second" });
	const snapshot = structuredClone(source.entries.at(-1));
	const writes = source.entries.length;
	await expect(run(source.tools, "task_update", { resumePlanId: "missing" })).rejects.toThrow("No plan");
	await expect(
		run(source.tools, "task_update", { resumePlanId: "plan-1", taskId: "1", status: "completed" }),
	).rejects.toThrow("separately");
	await expect(
		run(source.tools, "task_create", { subject: "Invalid", description: "invalid", newPlan: "   " }),
	).rejects.toThrow("title");
	expect(source.entries).toHaveLength(writes);
	expect(source.entries.at(-1)).toEqual(snapshot);
	expect(await run(source.tools, "task_list", {})).toHaveLength(1);
});

test("branch navigation restores its selected plan and history without reusing sibling plan IDs", async () => {
	const source = createApi();
	createStepTasksExtension()(source.api);
	const ctx = createContext([], source.sessionManager);
	await run(source.tools, "task_create", { subject: "Base", description: "base" });
	const base = source.sessionManager.getLeafId()!;
	await run(source.tools, "task_create", { subject: "Second", description: "second", newPlan: "Second plan" });
	const second = source.sessionManager.getLeafId()!;
	await run(source.tools, "task_update", { resumePlanId: "plan-1" });
	const resumed = source.sessionManager.getLeafId()!;
	source.sessionManager.branch(base);
	await source.emit({ type: "session_tree" }, ctx);
	expect(await run(source.tools, "task_list", { includeHistory: true })).toMatchObject({
		activePlanId: "plan-1",
		plans: [{ id: "plan-1", active: true, total: 1 }],
	});
	await expect(run(source.tools, "task_update", { resumePlanId: "plan-2" })).rejects.toThrow("No plan");
	expect(
		await run(source.tools, "task_create", { subject: "Sibling", description: "third", newPlan: "Sibling plan" }),
	).toMatchObject({ id: "3", planId: "plan-3" });
	source.sessionManager.branch(second);
	await source.emit({ type: "session_tree" }, ctx);
	expect(await run(source.tools, "task_list", { includeHistory: true })).toMatchObject({
		activePlanId: "plan-2",
		plans: [
			{ id: "plan-1", active: false },
			{ id: "plan-2", active: true },
		],
	});
	source.sessionManager.branch(resumed);
	await source.emit({ type: "session_tree" }, ctx);
	expect(await run(source.tools, "task_list", { includeHistory: true })).toMatchObject({
		activePlanId: "plan-1",
		plans: [
			{ id: "plan-1", active: true },
			{ id: "plan-2", active: false },
		],
	});
	source.sessionManager.newSession();
	await source.emit({ type: "session_start" }, ctx);
	expect(await run(source.tools, "task_list", { includeHistory: true })).toEqual({
		activePlanId: undefined,
		plans: [],
	});
});

test("completing or deleting current tasks never automatically resumes an archived plan", async () => {
	const source = createApi();
	createStepTasksExtension()(source.api);
	const ctx = createContext([], source.sessionManager);
	await run(source.tools, "task_create", { subject: "Old", description: "old" });
	await run(source.tools, "task_create", { subject: "New", description: "new", newPlan: "New plan" });
	await run(source.tools, "task_update", { taskId: "2", status: "completed" });
	await source.emit({ type: "turn_end" }, ctx);
	await source.commands.get("todos")!.handler("", ctx);
	expect(ctx.ui.notify).toHaveBeenLastCalledWith("done 2. New", "info");
	const removed = await runResult(source.tools, "task_update", { taskId: "2", status: "deleted" });
	expect(renderResult(source.tools.get("task_update")!, removed)).toContain("Updated Plan (0/0)");
	await source.emit({ type: "session_start" }, ctx);
	expect(await run(source.tools, "task_list", {})).toEqual([]);
	expect(await run(source.tools, "task_list", { includeHistory: true })).toMatchObject({ activePlanId: "plan-2" });
	await run(source.tools, "task_update", { resumePlanId: "plan-1" });
	await run(source.tools, "task_update", { resumePlanId: "plan-2" });
	expect(await run(source.tools, "task_list", {})).toEqual([]);
	const writes = source.entries.length;
	await run(source.tools, "task_update", { resumePlanId: "plan-2" });
	expect(source.entries).toHaveLength(writes);
});

test("resuming a plan preserves dependencies and metadata without mutating archived snapshots", async () => {
	const source = createApi();
	createStepTasksExtension()(source.api);
	await run(source.tools, "task_create", { subject: "One", description: "one", metadata: { nested: { value: 1 } } });
	await run(source.tools, "task_create", { subject: "Two", description: "two" });
	await run(source.tools, "task_update", { taskId: "1", addBlocks: ["2"], owner: "worker" });
	await run(source.tools, "task_create", { subject: "Three", description: "three", newPlan: "New" });
	const archivedSnapshot = structuredClone(source.entries.at(-1));
	const history = await run(source.tools, "task_list", { includeHistory: true });
	const historyCopy = structuredClone(history);
	await run(source.tools, "task_update", { resumePlanId: "plan-1" });
	expect(await run(source.tools, "task_get", { taskId: "1" })).toMatchObject({
		blocks: ["2"],
		owner: "worker",
		metadata: { nested: { value: 1 } },
	});
	expect(await run(source.tools, "task_get", { taskId: "2" })).toMatchObject({ blockedBy: ["1"] });
	await run(source.tools, "task_update", { taskId: "1", status: "completed", metadata: { nested: { value: 2 } } });
	expect(source.entries[3]).toEqual(archivedSnapshot);
	expect(history).toEqual(historyCopy);
	await run(source.tools, "task_update", { resumePlanId: "plan-3" });
	await run(source.tools, "task_update", { resumePlanId: "plan-1" });
	expect(await run(source.tools, "task_get", { taskId: "1" })).toMatchObject({
		status: "completed",
		metadata: { nested: { value: 2 } },
	});
	expect(await run(source.tools, "task_list", {})).toEqual([
		{ id: "1", subject: "One", status: "completed", owner: "worker", blockedBy: [] },
		{ id: "2", subject: "Two", status: "pending", owner: undefined, blockedBy: [] },
	]);
	expect(source.tools.get("task_create")!.executionMode).toBe("sequential");
	expect(source.tools.get("task_update")!.executionMode).toBe("sequential");
});
