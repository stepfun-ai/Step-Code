/** Presentation-only projections of task state and immutable tool results. */
import type { AgentToolResult } from "@step-harness/agent-core";
import {
	type Component,
	Container,
	stripTerminalSequences,
	Text,
	TruncatedText,
	truncateToWidth,
} from "@step-harness/pi-tui";
import type { ToolRenderContext, ToolRenderResultOptions } from "../core/extensions/types.ts";
import type { Theme } from "../theme/theme.ts";
import type { StepTask, StepTaskStatus } from "./step-tasks.ts";

type TaskSummary = Pick<StepTask, "id" | "subject" | "status" | "owner"> & Partial<Pick<StepTask, "blockedBy">>;

const PREVIEW_TASKS = 5;
const STATUS_LABELS: Record<StepTaskStatus, string> = {
	pending: "todo",
	in_progress: "wip",
	completed: "done",
	deleted: "deleted",
};

function singleLine(text: string): string {
	return stripTerminalSequences(text)
		.replace(/[\p{Cc}\s]+/gu, " ")
		.trim();
}

export function formatTaskLine(task: TaskSummary): string {
	const owner = task.owner ? ` @${task.owner}` : "";
	const blockers = task.blockedBy?.length ? ` (blocked by ${task.blockedBy.join(", ")})` : "";
	return singleLine(`${STATUS_LABELS[task.status]} ${task.id}. ${task.subject}${owner}${blockers}`);
}

/** Input is in ID order; stable sorting puts active work first. RPC accepts these plain lines too. */
export function taskWidgetLines(tasks: readonly StepTask[]): string[] | undefined {
	if (tasks.length === 0) return undefined;
	const completed = tasks.filter((task) => task.status === "completed").length;
	const open = tasks
		.filter((task) => task.status === "pending" || task.status === "in_progress")
		.sort((a, b) => Number(b.status === "in_progress") - Number(a.status === "in_progress"));
	const lines = [`Tasks: ${completed}/${tasks.length} completed`];
	for (const task of open.slice(0, PREVIEW_TASKS)) {
		const line = formatTaskLine({
			id: task.id,
			status: task.status,
			owner: task.owner,
			subject: task.status === "in_progress" ? task.activeForm || task.subject : task.subject,
		});
		// truncateToWidth appends ANSI resets; widgets also travel over RPC.
		lines.push(stripTerminalSequences(truncateToWidth(line, 100)));
	}
	if (open.length > PREVIEW_TASKS) lines.push(`... ${open.length - PREVIEW_TASKS} more open tasks (/todos)`);
	return lines;
}

export function renderTaskCall(name: string, detail: string | undefined, theme: Theme): Component {
	return new TruncatedText(
		`${theme.fg("toolTitle", theme.bold(name))}${detail ? ` ${theme.fg("accent", singleLine(detail))}` : ""}`,
	);
}

function isTaskSummary(value: unknown): value is TaskSummary {
	if (!value || typeof value !== "object") return false;
	const task = value as Partial<TaskSummary>;
	return (
		typeof task.id === "string" &&
		typeof task.subject === "string" &&
		typeof task.status === "string" &&
		Object.hasOwn(STATUS_LABELS, task.status) &&
		(task.owner === undefined || typeof task.owner === "string") &&
		(task.blockedBy === undefined ||
			(Array.isArray(task.blockedBy) && task.blockedBy.every((id) => typeof id === "string")))
	);
}

export function renderTaskResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext<unknown, unknown>,
): Component {
	if (!options.expanded && !context.isError) {
		const details = result.details;
		if (Array.isArray(details) && details.every(isTaskSummary)) {
			if (details.length === 0) return new Text("No tasks tracked.", 0, 0);
			const container = new Container();
			for (const task of details.slice(0, PREVIEW_TASKS)) {
				container.addChild(new TruncatedText(theme.fg("toolOutput", formatTaskLine(task))));
			}
			if (details.length > PREVIEW_TASKS) {
				container.addChild(
					new TruncatedText(
						theme.fg("dim", `... ${details.length - PREVIEW_TASKS} more tasks (expand for details)`),
					),
				);
			}
			return container;
		}
		const summary =
			details && typeof details === "object" && "deleted" in details && details.deleted === true
				? { ...details, status: "deleted" }
				: details;
		if (isTaskSummary(summary)) {
			// Only task_list reports open blockers. get/update carry the full stored links.
			const { id, subject, status, owner } = summary;
			return new TruncatedText(theme.fg("toolOutput", formatTaskLine({ id, subject, status, owner })));
		}
	}
	return new Text(
		result.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n") || "(no output)",
		0,
		0,
	);
}
