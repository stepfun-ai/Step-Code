/**
 * Step's task-tracking extension.
 *
 * Four task_* tools maintain a session-scoped task list. Task tracking is
 * fully decoupled from plan mode and works in any mode. State lives in an
 * in-memory map; every mutation appends a full snapshot (tasks plus the
 * monotonic id counter) as a Pi session entry so a reloaded session restores
 * the active branch's most recent snapshot and never reuses the id of a deleted task.
 */

import type { AgentToolResult } from "@step-harness/agent-core";
import { Type } from "typebox";
import type { EventBus } from "../core/event-bus.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "../core/extensions/types.ts";
import { isUserMessage } from "../core/messages.ts";
import { parseImportBatch, STEP_TASKS_IMPORT_CHANNEL, type StepTaskImportItem } from "./step-tasks-import.ts";
import {
	formatTaskLine,
	renderTaskCall,
	renderTaskResult,
	singleLine,
	TaskWidgetComponent,
	taskWidgetLines,
	widgetTaskLine,
} from "./step-tasks-render.ts";

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
	const details = structuredClone(payload);
	return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
}

/** Merge metadata updates into a task's existing map; a null value deletes the key. */
function mergeTaskMetadata(
	existing: Record<string, unknown> | undefined,
	updates: Record<string, unknown>,
): Record<string, unknown> {
	const merged = { ...existing, ...structuredClone(updates) };
	for (const [key, value] of Object.entries(updates)) {
		if (value === null) delete merged[key];
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

/** Validate the whole dependency batch before changing fields or either side of a link. */
function assertNoDependencyCycle(tasks: ReadonlyMap<string, StepTask>, links: [string, string][]): void {
	if (links.length === 0) return;
	const graph = new Map<string, string[]>([...tasks.values()].map((task) => [task.id, [...task.blocks]]));
	for (const [blocker, blocked] of links) graph.get(blocker)!.push(blocked);
	for (const [blocker, blocked] of links) {
		const pending = [blocked];
		const seen = new Set<string>();
		while (pending.length > 0) {
			const id = pending.pop()!;
			if (id === blocker) throw new Error("Task dependencies cannot form a cycle.");
			if (seen.has(id)) continue;
			seen.add(id);
			pending.push(...(graph.get(id) ?? []));
		}
	}
}

/** One-line summary of a user message for receipt recaps. */
function singleLineOfUserPrompt(message: unknown): string | undefined {
	const content = (message as { content?: unknown } | undefined)?.content;
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.filter((part): part is { type: "text"; text: string } => {
							const candidate = part as { type?: string; text?: unknown } | null;
							return !!candidate && candidate.type === "text" && typeof candidate.text === "string";
						})
						.map((part) => part.text)
						.join(" ")
				: undefined;
	if (!text) return undefined;
	// Flatten to one line, then cap at 72 visible characters.
	const flattened = singleLine(text);
	if (!flattened) return undefined;
	return flattened.length > 72 ? `${flattened.slice(0, 71)}…` : flattened;
}

/** Create Step's native task-tracking extension. */
export function createStepTasksExtension(): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		const tasks = new Map<string, StepTask>();
		let nextId = 1;
		/** Import batches buffered until the active-branch snapshot restore ran. */
		const pendingImports: StepTaskImportItem[][] = [];
		/** Most recent user prompt text, one line, for receipt recaps. */
		let latestUserPrompt: string | undefined;
		/** The prompt that started the current checklist; captured on first task_create. */
		let checklistOrigin: string | undefined;
		/** Latched once the checklist's receipt is in the transcript; reset by any task mutation. */
		let receiptPosted = false;

		const allocateId = (): string => {
			while (tasks.has(String(nextId))) nextId += 1;
			const id = String(nextId);
			nextId += 1;
			return id;
		};

		const persistTasks = (): void => {
			pi.appendEntry("step-tasks", structuredClone({ tasks: [...tasks.values()], nextId }));
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
				...(taskFields.metadata !== undefined ? { metadata: structuredClone(taskFields.metadata) } : {}),
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

		const sortedTasks = (): StepTask[] => [...tasks.values()].sort((a, b) => compareTaskIds(a.id, b.id));
		const listTasks = () =>
			sortedTasks().map((task) => ({
				id: task.id,
				subject: task.subject,
				status: task.status,
				owner: task.owner,
				blockedBy: openBlockers(task),
			}));
		const updateWidget = (ctx: ExtensionContext): void => {
			if (!ctx.hasUI) return;
			const snapshot = sortedTasks();
			const lines = taskWidgetLines(snapshot);
			ctx.ui.setWidget(
				"step-tasks",
				lines,
				// Lines remain the transport for RPC/stdio hosts; interactive mode
				// renders the component, which follows the global ctrl+o expansion.
				lines === undefined
					? undefined
					: {
							component: (_tui, theme) => new TaskWidgetComponent(structuredClone(snapshot), theme),
						},
			);
		};

		pi.registerCommand("todos", {
			description: "Show the session task list",
			handler: async (_args, ctx) => {
				const list = listTasks();
				ctx.ui.notify(
					list.length > 0 ? list.map(formatTaskLine).join("\n") : "No tasks tracked. Use task_create to add some.",
					"info",
				);
			},
		});

		pi.registerTool({
			name: "task_create",
			label: "Create task",
			description:
				"Create a todo item in the session execution checklist, with or without plan mode. Returns an id and starts as pending. This records work; it does not execute or delegate it.",
			promptSnippet: "Record a todo item without executing work",
			parameters: TASK_CREATE_PARAMS,
			renderCall: (args, theme) => renderTaskCall("task_create", args.subject, theme),
			renderResult: renderTaskResult,
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				if (tasks.size === 0) {
					checklistOrigin = latestUserPrompt;
					// Consume the prompt so a checklist created later in the same
					// or a continuation run cannot quote a stale origin.
					latestUserPrompt = undefined;
				}
				receiptPosted = false;
				const task = createTask({
					subject: params.subject,
					description: params.description,
					...(params.activeForm !== undefined ? { activeForm: params.activeForm } : {}),
					...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
				});
				persistTasks();
				updateWidget(ctx);
				return jsonResult({ id: task.id, subject: task.subject, status: task.status });
			},
		});

		pi.registerTool({
			name: "task_update",
			label: "Update task",
			description:
				"Update a todo item's progress, details, or dependencies by id. Set in_progress when starting, completed after finishing and validating, or deleted to remove it. This only changes tracking data; it does not execute or schedule work.",
			promptSnippet: "Update a todo item's progress, details, or dependencies",
			parameters: TASK_UPDATE_PARAMS,
			renderCall: (args, theme) =>
				renderTaskCall("task_update", `${args.taskId ?? ""}${args.status ? ` → ${args.status}` : ""}`, theme),
			renderResult: renderTaskResult,
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				receiptPosted = false;
				const { taskId, status, subject, description, activeForm, owner, metadata, addBlocks, addBlockedBy } =
					params;
				const task = requireTask(taskId);
				const blocksTargets = resolveLinkTargets(task, addBlocks);
				const blockedByTargets = resolveLinkTargets(task, addBlockedBy);
				assertNoDependencyCycle(tasks, [
					...blocksTargets.map((blocked): [string, string] => [task.id, blocked.id]),
					...blockedByTargets.map((blocker): [string, string] => [blocker.id, task.id]),
				]);
				if (status === "deleted") {
					removeTaskAndDropLinks(task);
					persistTasks();
					updateWidget(ctx);
					return jsonResult({ id: task.id, subject: task.subject, deleted: true });
				}
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
				updateWidget(ctx);
				return jsonResult(task);
			},
		});

		pi.registerTool({
			name: "task_get",
			label: "Get task",
			description:
				"Read a todo item's full details and all recorded dependencies, including completed ones. Use task_list to check which prerequisites remain unfinished.",
			promptSnippet: "Read a todo item's full details and recorded dependencies",
			parameters: TASK_GET_PARAMS,
			renderCall: (args, theme) => renderTaskCall("task_get", args.taskId, theme),
			renderResult: renderTaskResult,
			execute: async (_toolCallId, params) => jsonResult(requireTask(params.taskId)),
		});

		pi.registerTool({
			name: "task_list",
			label: "List tasks",
			description:
				"List session todo items with id, subject, status, owner, and unfinished prerequisites (blockedBy). Use it to resume existing work or choose the next open, unblocked item.",
			promptSnippet: "List todo progress and unfinished prerequisites",
			parameters: TASK_LIST_PARAMS,
			renderCall: (_args, theme) => renderTaskCall("task_list", undefined, theme),
			renderResult: renderTaskResult,
			execute: async () => jsonResult(listTasks()),
		});

		const restoreTasks = (ctx: ExtensionContext): void => {
			tasks.clear();
			nextId = 1;
			// Contents follow the active branch, but IDs must not collide with
			// tasks referenced in sibling history (including deleted tasks).
			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type !== "custom" || entry.customType !== "step-tasks") continue;
				const snapshot = entry.data as { tasks?: StepTask[]; nextId?: number } | undefined;
				if (typeof snapshot?.nextId === "number" && Number.isSafeInteger(snapshot.nextId) && snapshot.nextId > 0) {
					nextId = Math.max(nextId, snapshot.nextId);
				} else if (Array.isArray(snapshot?.tasks)) {
					// Legacy snapshots did not persist an allocator.
					for (const task of snapshot.tasks) {
						const id = Number(task?.id);
						if (Number.isSafeInteger(id) && id > 0) nextId = Math.max(nextId, id + 1);
					}
				}
			}
			const snapshotEntry = ctx.sessionManager
				.getBranch()
				.reverse()
				.find((candidate) => candidate.type === "custom" && candidate.customType === "step-tasks") as
				| { data?: { tasks?: StepTask[] } }
				| undefined;
			if (Array.isArray(snapshotEntry?.data?.tasks)) {
				for (const task of structuredClone(snapshotEntry.data.tasks)) {
					if (!task || typeof task.id !== "string" || !task.id || typeof task.subject !== "string") continue;
					tasks.set(task.id, {
						...task,
						blocks: Array.isArray(task.blocks) ? task.blocks : [],
						blockedBy: Array.isArray(task.blockedBy) ? task.blockedBy : [],
					});
					const id = Number(task.id);
					if (Number.isSafeInteger(id) && id > 0) nextId = Math.max(nextId, id + 1);
				}
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
			updateWidget(ctx);
		};
		pi.on("session_start", async (_event, ctx) => restoreTasks(ctx));
		pi.on("session_tree", async (_event, ctx) => restoreTasks(ctx));
		/** Archive a fully-completed checklist into the transcript exactly once. */
		const postReceipt = (): void => {
			if (receiptPosted) return;
			const snapshot = sortedTasks();
			if (snapshot.length === 0 || snapshot.some((task) => task.status !== "completed")) return;
			receiptPosted = true;
			pi.sendMessage(
				{
					customType: "step-tasks",
					content: [
						`**Tasks: ${snapshot.length}/${snapshot.length} completed**`,
						...(checklistOrigin ? [`> ${checklistOrigin}`] : []),
						...snapshot.map(widgetTaskLine),
					].join("\n"),
					display: true,
					details: structuredClone(snapshot),
				},
				// Without this the receipt lands as a steering message while the
				// run is still tearing down, continuing the loop and re-firing
				// agent_end — one receipt per extra iteration.
				{ triggerTurn: false },
			);
		};
		// When a run finishes with every task completed, archive the checklist
		// as a transcript receipt. The panel keeps mirroring it until the next
		// user message retires it, so the history is durable even if the session
		// never gets another prompt. (turn_start/turn_end fire per agent-loop
		// iteration, so agent_end is the only reliable "this prompt's work is
		// done" signal.)
		pi.on("agent_end", async () => {
			postReceipt();
		});
		pi.on("message_start", async (event, ctx) => {
			if (!isUserMessage(event.message)) return;
			latestUserPrompt = singleLineOfUserPrompt(event.message);
			// A fully-completed checklist stays on screen after the turn ends —
			// a receipt the user can review (ctrl+o) until they move on; the
			// transcript copy was already archived at agent_end. The next user
			// message retires the panel and the stored tasks so fresh work
			// starts on a clean board. The id counter persists, so future tasks
			// never reuse ids that earlier turns referenced.
			const allDone = tasks.size > 0 && [...tasks.values()].every((task) => task.status === "completed");
			if (!allDone) return;
			// A queued user message can retire the checklist before this run's
			// agent_end fires; make sure the receipt still lands.
			postReceipt();
			tasks.clear();
			checklistOrigin = undefined;
			receiptPosted = false;
			persistTasks();
			updateWidget(ctx);
		});
	};
}
