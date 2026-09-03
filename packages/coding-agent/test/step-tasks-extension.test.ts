import { expect, test } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { createStepTasksExtension, type StepTask } from "../src/extensions/step-tasks.ts";

interface TasksSnapshot {
	tasks: StepTask[];
	nextId: number;
}

function createApi(): {
	api: ExtensionAPI;
	tools: Map<string, ToolDefinition>;
	entries: TasksSnapshot[];
	emit: (event: { type: string } & Record<string, unknown>, ctx: ExtensionContext) => Promise<unknown>;
} {
	const tools = new Map<string, ToolDefinition>();
	const entries: TasksSnapshot[] = [];
	const handlers = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
	const api = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		registerCommand: () => {},
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
			entries.push(structuredClone(data));
		},
		sendMessage: () => {},
		sendUserMessage: () => {},
	} as unknown as ExtensionAPI;
	return {
		api,
		tools,
		entries,
		emit: async (event, ctx) => {
			let last: unknown;
			for (const handler of handlers.get(event.type) ?? []) {
				last = await handler(event as never, ctx);
			}
			return last;
		},
	};
}

function createContext(entries: Array<{ type: string; customType: string; data: unknown }> = []): ExtensionContext {
	return {
		hasUI: false,
		cwd: "/workspace",
		sessionManager: { getEntries: () => entries, getSessionId: () => "session-test" },
	} as unknown as ExtensionContext;
}

async function run(tools: Map<string, ToolDefinition>, name: string, params: unknown): Promise<unknown> {
	const tool = tools.get(name);
	expect(tool, `tool ${name} is registered`).toBeDefined();
	const result = (await tool!.execute(`${name}-call`, params as never, undefined, undefined, createContext())) as {
		details: unknown;
	};
	return result.details;
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
