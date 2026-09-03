/**
 * Step's task-tracking extension.
 *
 * Four task_* tools maintain a session-scoped task list. Task tracking is
 * fully decoupled from plan mode and works in any mode. State lives in an
 * in-memory map; every mutation appends a full snapshot (tasks plus the
 * monotonic id counter) as a Pi session entry so a reloaded session restores
 * the most recent snapshot and never reuses the id of a deleted task.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { EventBus } from "../core/event-bus.ts";
import type { ExtensionAPI, ExtensionFactory } from "../core/extensions/types.ts";
import { parseImportBatch, STEP_TASKS_IMPORT_CHANNEL, type StepTaskImportItem } from "./step-tasks-import.ts";

export type StepTaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface StepTask {
	id: string;
	subject: string;
	description: string;
	status: StepTaskStatus;
	activeForm?: string;
	owner?: string;
	metadata?: Record<string, unknown>;
	blocks: string[];
	blockedBy: string[];
	createdAt: number;
	updatedAt: number;
}

const TASK_STATUS_SCHEMA = Type.Union(
	[Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed"), Type.Literal("deleted")],
	{ description: "Task status; deleted permanently removes the task" },
);

const TASK_CREATE_PARAMS = Type.Object({
	subject: Type.String({ description: "Brief, actionable task title in imperative form" }),
	description: Type.String({ description: "What needs to be done" }),
	activeForm: Type.Optional(
		Type.String({ description: "Present-continuous form shown while the task is in progress" }),
	),
	metadata: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), { description: "Arbitrary metadata attached to the task" }),
	),
});

const TASK_UPDATE_PARAMS = Type.Object({
	taskId: Type.String({ description: "Id of the task to update" }),
	status: Type.Optional(TASK_STATUS_SCHEMA),
	subject: Type.Optional(Type.String({ description: "New task title" })),
	description: Type.Optional(Type.String({ description: "New task description" })),
	activeForm: Type.Optional(Type.String({ description: "New present-continuous label" })),
	owner: Type.Optional(Type.String({ description: "New task owner" })),
	metadata: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description: "Metadata keys merged into the task; a null value deletes the key",
		}),
	),
	addBlocks: Type.Optional(
		Type.Array(Type.String(), { description: "Ids of tasks that cannot start until this one completes" }),
	),
	addBlockedBy: Type.Optional(
		Type.Array(Type.String(), { description: "Ids of tasks that must complete before this one starts" }),
	),
});

const TASK_GET_PARAMS = Type.Object({
	taskId: Type.String({ description: "Id of the task to read" }),
});

const TASK_LIST_PARAMS = Type.Object({});

function jsonResult(payload: unknown): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], details: payload };
}

/** Merge metadata updates into a task's existing map; a null value deletes the key. */
function mergeTaskMetadata(
	existing: Record<string, unknown> | undefined,
	updates: Record<string, unknown>,
): Record<string, unknown> {
	const merged = { ...(existing ?? {}) };
	for (const [key, value] of Object.entries(updates)) {
		if (value === null) delete merged[key];
		else merged[key] = value;
	}
	return merged;
}

/** Order tasks by numeric id when possible, falling back to lexicographic. */
export function compareTaskIds(a: string, b: string): number {
	const numericA = Number.parseInt(a, 10);
	const numericB = Number.parseInt(b, 10);
	if (Number.isFinite(numericA) && Number.isFinite(numericB) && numericA !== numericB) {
		return numericA - numericB;
	}
	return a.localeCompare(b);
}

/** Create Step's native task-tracking extension. */
export function createStepTasksExtension(): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		const tasks = new Map<string, StepTask>();
		let nextId = 1;
		/** Import batches buffered until the session_start snapshot restore ran. */
		const pendingImports: StepTaskImportItem[][] = [];

		const allocateId = (): string => {
			while (tasks.has(String(nextId))) nextId += 1;
			const id = String(nextId);
			nextId += 1;
			return id;
		};

		const persistTasks = (): void => {
			pi.appendEntry("step-tasks", { tasks: [...tasks.values()], nextId });
		};

		/** Create and store a task without persisting; callers persist once done. */
		const createTask = (taskFields: {
			subject: string;
			description: string;
			status?: Exclude<StepTaskStatus, "deleted">;
			activeForm?: string;
			metadata?: Record<string, unknown>;
		}): StepTask => {
			const now = Date.now();
			const task: StepTask = {
				id: allocateId(),
				subject: taskFields.subject,
				description: taskFields.description,
				status: taskFields.status ?? "pending",
				...(taskFields.activeForm !== undefined ? { activeForm: taskFields.activeForm } : {}),
				...(taskFields.metadata !== undefined ? { metadata: { ...taskFields.metadata } } : {}),
				blocks: [],
				blockedBy: [],
				createdAt: now,
				updatedAt: now,
			};
			tasks.set(task.id, task);
			return task;
		};

		// The event bus is optional so minimal embedder/test harnesses that stub
		// ExtensionAPI keep working without one.
		const events = (pi as { events?: EventBus }).events;
		events?.on(STEP_TASKS_IMPORT_CHANNEL, (payload) => {
			const importBatch = parseImportBatch(payload);
			if (importBatch.length > 0) pendingImports.push(importBatch);
		});

		const requireTask = (taskId: string): StepTask => {
			const task = tasks.get(taskId);
			if (!task) throw new Error(`No task with id "${taskId}". Use task_list to see existing tasks.`);
			return task;
		};

		/**
		 * Resolve dependency ids before any mutation so task_update stays
		 * atomic: one bad id fails the whole call instead of leaving a
		 * partially updated task behind.
		 */
		const resolveLinkTargets = (sourceTask: StepTask, linkedTaskIds: string[] | undefined): StepTask[] =>
			(linkedTaskIds ?? []).map((linkedTaskId) => {
				if (linkedTaskId === sourceTask.id) throw new Error("A task cannot block itself.");
				return requireTask(linkedTaskId);
			});

		/** Record a blocker → blocked dependency symmetrically on both tasks. */
		const linkTasks = (blocker: StepTask, blocked: StepTask): void => {
			if (!blocker.blocks.includes(blocked.id)) blocker.blocks.push(blocked.id);
			if (!blocked.blockedBy.includes(blocker.id)) blocked.blockedBy.push(blocker.id);
		};

		/** Remove a task and scrub it from every other task's dependency lists. */
		const removeTaskAndDropLinks = (task: StepTask): void => {
			tasks.delete(task.id);
			for (const other of tasks.values()) {
				other.blocks = other.blocks.filter((taskId) => taskId !== task.id);
				other.blockedBy = other.blockedBy.filter((taskId) => taskId !== task.id);
			}
		};

		/** Stored blockers that still exist and are not completed. */
		const openBlockers = (task: StepTask): string[] =>
			task.blockedBy.filter((id) => {
				const blocker = tasks.get(id);
				return blocker !== undefined && blocker.status !== "completed";
			});

		pi.registerTool({
			name: "task_create",
			label: "Create task",
			description:
				"Create a task in the session task list. Use one task per distinct step when work has three or more steps. The task starts as pending; the returned id is used with the other task_* tools.",
			promptSnippet: "Add a task to the session task list",
			parameters: TASK_CREATE_PARAMS,
			execute: async (_toolCallId, params) => {
				const task = createTask({
					subject: params.subject,
					description: params.description,
					...(params.activeForm !== undefined ? { activeForm: params.activeForm } : {}),
					...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
				});
				persistTasks();
				return jsonResult({ id: task.id, subject: task.subject, status: task.status });
			},
		});

		pi.registerTool({
			name: "task_update",
			label: "Update task",
			description:
				"Update a task: set status (pending, in_progress, completed; deleted removes the task), edit fields, merge metadata (a null value deletes the key), or add dependencies with addBlocks/addBlockedBy. Mark a task in_progress before starting it and completed immediately after finishing it.",
			promptSnippet: "Update a task's status, fields, or dependencies",
			parameters: TASK_UPDATE_PARAMS,
			execute: async (_toolCallId, params) => {
				const { taskId, status, subject, description, activeForm, owner, metadata, addBlocks, addBlockedBy } =
					params;
				const task = requireTask(taskId);
				if (status === "deleted") {
					removeTaskAndDropLinks(task);
					persistTasks();
					return jsonResult({ id: task.id, subject: task.subject, deleted: true });
				}
				const blocksTargets = resolveLinkTargets(task, addBlocks);
				const blockedByTargets = resolveLinkTargets(task, addBlockedBy);
				if (subject !== undefined) task.subject = subject;
				if (description !== undefined) task.description = description;
				if (activeForm !== undefined) task.activeForm = activeForm;
				if (owner !== undefined) task.owner = owner;
				if (status !== undefined) task.status = status;
				if (metadata !== undefined) task.metadata = mergeTaskMetadata(task.metadata, metadata);
				for (const blocked of blocksTargets) linkTasks(task, blocked);
				for (const blocker of blockedByTargets) linkTasks(blocker, task);
				task.updatedAt = Date.now();
				persistTasks();
				return jsonResult(task);
			},
		});

		pi.registerTool({
			name: "task_get",
			label: "Get task",
			description:
				"Get one task by id with its full description, status, owner, metadata, and dependency lists (blocks / blockedBy). Verify blockedBy is clear before starting the task.",
			promptSnippet: "Read one task's full details",
			parameters: TASK_GET_PARAMS,
			execute: async (_toolCallId, params) => jsonResult(requireTask(params.taskId)),
		});

		pi.registerTool({
			name: "task_list",
			label: "List tasks",
			description:
				"List all tasks with id, subject, status, owner, and open blockers (blockedBy filtered to tasks that still exist and are not completed). Use it to check progress and pick the next available task.",
			promptSnippet: "List session tasks with status and open blockers",
			parameters: TASK_LIST_PARAMS,
			execute: async () =>
				jsonResult(
					[...tasks.values()]
						.sort((a, b) => compareTaskIds(a.id, b.id))
						.map((task) => ({
							id: task.id,
							subject: task.subject,
							status: task.status,
							owner: task.owner,
							blockedBy: openBlockers(task),
						})),
				),
		});

		pi.on("session_start", async (_event, ctx) => {
			const snapshotEntry = [...ctx.sessionManager.getEntries()]
				.reverse()
				.find((candidate) => candidate.type === "custom" && candidate.customType === "step-tasks") as
				| { data?: { tasks?: StepTask[]; nextId?: number } }
				| undefined;
			const snapshot = snapshotEntry?.data;
			if (snapshot?.tasks) {
				tasks.clear();
				let highestRestoredId = 0;
				for (const task of snapshot.tasks) {
					if (!task || typeof task.id !== "string" || task.id.length === 0) continue;
					tasks.set(task.id, {
						...task,
						blocks: Array.isArray(task.blocks) ? task.blocks : [],
						blockedBy: Array.isArray(task.blockedBy) ? task.blockedBy : [],
					});
					const numericId = Number.parseInt(task.id, 10);
					if (Number.isFinite(numericId) && numericId > highestRestoredId) highestRestoredId = numericId;
				}
				// Restore the persisted counter so the id of a deleted task is never
				// reused after a reload; snapshots without a counter (legacy) fall
				// back to one past the highest surviving id.
				const persistedNextId = snapshot.nextId;
				nextId = Math.max(
					highestRestoredId + 1,
					typeof persistedNextId === "number" && Number.isFinite(persistedNextId)
						? Math.floor(persistedNextId)
						: 1,
				);
			}
			// Apply buffered imports only after the snapshot restore so seeded
			// tasks extend the restored list instead of racing it.
			if (pendingImports.length > 0) {
				for (const importBatch of pendingImports.splice(0)) {
					for (const importItem of importBatch) {
						createTask({
							subject: importItem.subject,
							description: importItem.description ?? "",
							...(importItem.status !== undefined ? { status: importItem.status } : {}),
						});
					}
				}
				persistTasks();
			}
		});
	};
}
