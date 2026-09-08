/**
 * Cross-extension import protocol for the step-tasks extension.
 *
 * Other extensions seed tasks into the session task list by emitting on
 * {@link STEP_TASKS_IMPORT_CHANNEL} (for example step-plan migrating a legacy
 * todos array). Payload shape: `{ source?: string; tasks: StepTaskImportItem[] }`.
 *
 * Imports are buffered by step-tasks and applied after its own active-branch
 * snapshot restore, so an import emitted from another extension's
 * session_start/session_tree handler can never be clobbered by (or clobber) the persisted
 * snapshot. Producers emit during session_start or session_tree; the buffer is
 * flushed after restoration on either event. The built-in plan extension is
 * registered before tasks so migrations are imported in the same event.
 */

import type { StepTaskStatus } from "./step-tasks.ts";

export const STEP_TASKS_IMPORT_CHANNEL = "step-tasks:import";

/** One task seeded through {@link STEP_TASKS_IMPORT_CHANNEL}. */
export interface StepTaskImportItem {
	subject: string;
	description?: string;
	status?: Exclude<StepTaskStatus, "deleted">;
}

const IMPORT_STATUSES = new Set<StepTaskStatus>(["pending", "in_progress", "completed"]);

/** Validate an import payload, dropping entries without a usable subject. */
export function parseImportBatch(payload: unknown): StepTaskImportItem[] {
	if (!payload || typeof payload !== "object") return [];
	const tasks = (payload as { tasks?: unknown }).tasks;
	if (!Array.isArray(tasks)) return [];
	const batch: StepTaskImportItem[] = [];
	for (const candidate of tasks) {
		if (!candidate || typeof candidate !== "object") continue;
		const importItem = candidate as Record<string, unknown>;
		if (typeof importItem.subject !== "string" || importItem.subject.trim().length === 0) continue;
		batch.push({
			subject: importItem.subject.trim(),
			...(typeof importItem.description === "string" ? { description: importItem.description } : {}),
			...(typeof importItem.status === "string" && IMPORT_STATUSES.has(importItem.status as StepTaskStatus)
				? { status: importItem.status as Exclude<StepTaskStatus, "deleted"> }
				: {}),
		});
	}
	return batch;
}
