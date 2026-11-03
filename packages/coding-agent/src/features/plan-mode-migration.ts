/**
 * One-time migration of the legacy step-plan persisted shape.
 *
 * Older versions of the plan extension persisted a todos array inside the
 * plan state. Each todo becomes a step-tasks task, then the caller persists
 * the todo-less shape so later restores find nothing left to migrate.
 * The caller supplies state from the active branch on session_start and
 * session_tree. Register plan before tasks: step-tasks flushes the import
 * after its own snapshot restore (see STEP_TASKS_IMPORT_CHANNEL).
 */

import type { EventBus } from "../core/event-bus.ts";
import type { ExtensionContext } from "../core/extensions/types.ts";
import { STEP_TASKS_IMPORT_CHANNEL, type StepTaskImportItem } from "./step-tasks-import.ts";

/** Todo shape persisted by older versions of the plan extension. */
export interface LegacyPlanTodo {
	step?: number;
	text?: string;
	completed?: boolean;
}

/** Legacy persisted plan-state fields consumed only by this migration. */
export interface LegacyPlanTodoFields {
	todos?: LegacyPlanTodo[];
}

/** Seed step-tasks from a legacy todos array and persist the todo-less shape. */
export function migrateLegacyPlanTodos(options: {
	persistedPlanState: LegacyPlanTodoFields;
	events: EventBus | undefined;
	extensionContext: ExtensionContext;
	/** Persists the todo-less plan shape so the migration runs only once. */
	persistMigratedPlanState: () => void;
}): void {
	const legacyTodos = Array.isArray(options.persistedPlanState.todos)
		? options.persistedPlanState.todos.filter(
				(todo): todo is LegacyPlanTodo & { text: string } =>
					!!todo && typeof todo.text === "string" && todo.text.trim().length > 0,
			)
		: [];
	if (legacyTodos.length === 0) return;
	const importedTasks: StepTaskImportItem[] = legacyTodos.map((todo) => ({
		subject: todo.text.trim(),
		description: `Migrated from the legacy plan-mode todo list${
			typeof todo.step === "number" ? ` (step ${todo.step})` : ""
		}.`,
		status: todo.completed === true ? "completed" : "pending",
	}));
	options.events?.emit(STEP_TASKS_IMPORT_CHANNEL, { source: "step-plan-legacy-todos", tasks: importedTasks });
	options.persistMigratedPlanState();
	options.extensionContext.ui.notify(
		`Migrated ${legacyTodos.length} legacy plan todo${legacyTodos.length === 1 ? "" : "s"} into session tasks (see /todos or task_list).`,
		"info",
	);
}
