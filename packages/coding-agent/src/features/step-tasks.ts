/**
 * Step's task-tracking extension.
 *
 * Four task_* tools maintain an active checklist and archived plans. Task tracking is
 * fully decoupled from plan mode and works in any mode. State lives in an
 * in-memory map; every mutation appends a full snapshot (tasks plus the
 * monotonic id counter) as a Pi session entry so a reloaded session restores
 * the active branch's most recent snapshot and never reuses the id of a deleted task.
 */

import type { AgentToolResult } from "@step-harness/agent-core";
import { Type } from "typebox";
import type { EventBus } from "../core/event-bus.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "../core/extensions/types.ts";
import { parseImportBatch, STEP_TASKS_IMPORT_CHANNEL, type StepTaskImportItem } from "./step-tasks-import.ts";
import { formatTaskLine, renderTaskCall, renderTaskResult } from "./step-tasks-render.ts";

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

interface TaskPlan {
	id: string;
	title: string;
	tasks: StepTask[];
}

interface TasksSnapshot {
	tasks: StepTask[];
	nextId: number;
	activePlan?: Omit<TaskPlan, "tasks">;
	archivedPlans?: TaskPlan[];
}

const TASK_STATUS_SCHEMA = Type.Union(
	[Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed"), Type.Literal("deleted")],
	{ description: "Task status; deleted permanently removes the task" },
);

const TASK_CREATE_PARAMS = Type.Object({
	subject: Type.String({ description: "Brief, actionable task title in imperative form" }),
	description: Type.String({ description: "What needs to be done" }),
	newPlan: Type.Optional(
		Type.String({
			minLength: 1,
			description:
				"Start a separate plan with this title and archive the current checklist. Set only on the first task of a different user request; omit when adding steps to the current plan.",
		}),
	),
	activeForm: Type.Optional(
		Type.String({ description: "Present-continuous form shown while the task is in progress" }),
	),
	metadata: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), { description: "Arbitrary metadata attached to the task" }),
	),
});

const TASK_UPDATE_PARAMS = Type.Object({
	taskId: Type.Optional(
		Type.String({ description: "Id of a task in the active plan; required unless resuming a plan" }),
	),
	resumePlanId: Type.Optional(
		Type.String({
			description:
				"Explicitly resume this archived plan when the user asks to continue it. Use alone, without taskId or other update fields; discover IDs with task_list(includeHistory:true).",
		}),
	),
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

const TASK_LIST_PARAMS = Type.Object({
	includeHistory: Type.Optional(
		Type.Boolean({
			description:
				"List current and archived plan summaries without switching plans; default lists only the active plan's tasks",
		}),
	),
});

function jsonResult(payload: unknown, plan?: unknown): AgentToolResult<unknown> {
	const details = structuredClone(payload);
	return {
		content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
		details: plan === undefined ? details : { ...(details as Record<string, unknown>), plan: structuredClone(plan) },
	};
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

/** Create Step's native task-tracking extension. */
export function createStepTasksExtension(): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		const tasks = new Map<string, StepTask>();
		const archivedPlans = new Map<string, TaskPlan>();
		let activePlan: Omit<TaskPlan, "tasks"> | undefined;
		let nextId = 1;
		/** Import batches buffered until the active-branch snapshot restore ran. */
		const pendingImports: StepTaskImportItem[][] = [];

		const allocateId = (): string => {
			while (tasks.has(String(nextId))) nextId += 1;
			const id = String(nextId);
			nextId += 1;
			return id;
		};

		const persistTasks = (): void => {
			pi.appendEntry(
				"step-tasks",
				structuredClone({
					tasks: [...tasks.values()],
					nextId,
					activePlan,
					archivedPlans: [...archivedPlans.values()],
				}),
			);
		};

		const archiveCurrentPlan = (): void => {
			if (activePlan)
				archivedPlans.set(activePlan.id, { ...activePlan, tasks: structuredClone([...tasks.values()]) });
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
			activePlan ??= { id: `plan-${task.id}`, title: task.subject };
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
			if (!task) {
				const archived = [...archivedPlans.values()].find((plan) =>
					plan.tasks.some((candidate) => candidate.id === taskId),
				);
				if (archived)
					throw new Error(
						`Task "${taskId}" belongs to archived plan "${archived.id}". Only if the user asks to continue it, call task_update with resumePlanId: "${archived.id}" first.`,
					);
				throw new Error(`No task with id "${taskId}". Use task_list to see existing tasks.`);
			}
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
				"Create a todo item in the active execution plan, with or without plan mode. For a different user request, set newPlan to its title on the first task to archive the old checklist; omit it for additional steps or cross-turn continuation. Returns task and plan IDs and starts as pending. This records work; it does not execute or delegate it.",
			promptSnippet: "Record a todo item without executing work",
			parameters: TASK_CREATE_PARAMS,
			executionMode: "sequential",
			renderShell: "self",
			renderCall: (args, theme, context) => renderTaskCall("task_create", args.subject, theme, context),
			renderResult: (result, options, theme, context) =>
				renderTaskResult("task_create", result, options, theme, context),
			execute: async (_toolCallId, params) => {
				const title = params.newPlan?.trim();
				if (params.newPlan !== undefined && !title) throw new Error("A new plan needs a nonempty title.");
				if (title) {
					archiveCurrentPlan();
					tasks.clear();
					activePlan = undefined;
				}
				const task = createTask({
					subject: params.subject,
					description: params.description,
					...(params.activeForm !== undefined ? { activeForm: params.activeForm } : {}),
					...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
				});
				if (title) activePlan = { id: `plan-${task.id}`, title };
				persistTasks();
				return jsonResult({ id: task.id, planId: activePlan!.id, subject: task.subject, status: task.status });
			},
		});

		pi.registerTool({
			name: "task_update",
			label: "Update task",
			description:
				"Update an active plan's todo item by taskId. Set in_progress when starting, completed after finishing and validating, or deleted to remove it. Alternatively, use resumePlanId alone to resume an archived checklist only when the user explicitly requests that work; the current plan is archived. This only changes tracking data; it does not execute or schedule work.",
			promptSnippet: "Update a todo item's progress, details, or dependencies",
			parameters: TASK_UPDATE_PARAMS,
			executionMode: "sequential",
			renderShell: "self",
			renderCall: (args, theme, context) =>
				renderTaskCall(
					"task_update",
					args.resumePlanId
						? `resume ${args.resumePlanId}`
						: `${args.taskId ?? ""}${args.status ? ` → ${args.status}` : ""}`,
					theme,
					context,
				),
			renderResult: (result, options, theme, context) =>
				renderTaskResult("task_update", result, options, theme, context),
			execute: async (_toolCallId, params) => {
				if (params.resumePlanId !== undefined) {
					if (Object.entries(params).some(([key, value]) => key !== "resumePlanId" && value !== undefined)) {
						throw new Error("Resume a plan separately from task updates.");
					}
					if (activePlan?.id !== params.resumePlanId) {
						const archived = archivedPlans.get(params.resumePlanId);
						if (!archived)
							throw new Error(
								`No plan with id "${params.resumePlanId}". Use task_list with includeHistory:true to see plans.`,
							);
						const restored = structuredClone(archived);
						archiveCurrentPlan();
						archivedPlans.delete(restored.id);
						tasks.clear();
						for (const task of restored.tasks) tasks.set(task.id, task);
						activePlan = { id: restored.id, title: restored.title };
						persistTasks();
					}
					return jsonResult({ planId: activePlan.id, title: activePlan.title, tasks: listTasks() }, listTasks());
				}
				const { taskId, status, subject, description, activeForm, owner, metadata, addBlocks, addBlockedBy } =
					params;
				if (!taskId) throw new Error("Provide taskId to update a task, or resumePlanId alone to resume a plan.");
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
					return jsonResult({ id: task.id, subject: task.subject, deleted: true }, listTasks());
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
				return jsonResult(task, listTasks());
			},
		});

		pi.registerTool({
			name: "task_get",
			label: "Get task",
			description:
				"Read a todo item's full details and all recorded dependencies, including completed ones. Use task_list to check which prerequisites remain unfinished.",
			promptSnippet: "Read a todo item's full details and recorded dependencies",
			parameters: TASK_GET_PARAMS,
			renderShell: "self",
			renderCall: (args, theme, context) => renderTaskCall("task_get", args.taskId, theme, context),
			renderResult: (result, options, theme, context) =>
				renderTaskResult("task_get", result, options, theme, context),
			execute: async (_toolCallId, params) => jsonResult(requireTask(params.taskId)),
		});

		pi.registerTool({
			name: "task_list",
			label: "List tasks",
			description:
				"List the active plan's todo items with id, subject, status, owner, and unfinished prerequisites (blockedBy). Use it to resume existing work or choose the next open, unblocked item. Set includeHistory:true to inspect plan IDs and counts without switching; only an explicit task_update(resumePlanId) reactivates an archived plan.",
			promptSnippet: "List todo progress and unfinished prerequisites",
			parameters: TASK_LIST_PARAMS,
			renderShell: "self",
			renderCall: (_args, theme, context) => renderTaskCall("task_list", undefined, theme, context),
			renderResult: (result, options, theme, context) =>
				renderTaskResult("task_list", result, options, theme, context),
			execute: async (_toolCallId, params) => {
				if (!params.includeHistory) return jsonResult(listTasks());
				const plans = [
					...archivedPlans.values(),
					...(activePlan ? [{ ...activePlan, tasks: [...tasks.values()] }] : []),
				];
				return jsonResult({
					activePlanId: activePlan?.id,
					plans: plans
						.sort((first, second) => compareTaskIds(first.id.slice(5), second.id.slice(5)))
						.map((plan) => ({
							id: plan.id,
							title: plan.title,
							active: plan.id === activePlan?.id,
							completed: plan.tasks.filter((task) => task.status === "completed").length,
							total: plan.tasks.length,
						})),
				});
			},
		});

		const restoreTasks = (ctx: ExtensionContext): void => {
			tasks.clear();
			archivedPlans.clear();
			activePlan = undefined;
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
				| { data?: Partial<TasksSnapshot> }
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
			const firstTask = tasks.values().next().value;
			activePlan = snapshotEntry?.data?.activePlan
				? structuredClone(snapshotEntry.data.activePlan)
				: firstTask
					? { id: `plan-${firstTask.id}`, title: firstTask.subject }
					: undefined;
			for (const plan of structuredClone(snapshotEntry?.data?.archivedPlans ?? [])) {
				if (plan.id !== activePlan?.id) archivedPlans.set(plan.id, plan);
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
		};
		pi.on("session_start", async (_event, ctx) => restoreTasks(ctx));
		pi.on("session_tree", async (_event, ctx) => restoreTasks(ctx));
	};
}
