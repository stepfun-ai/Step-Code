/** Presentation-only projections of task state and immutable tool results. */
import type { AgentToolResult } from "@step-harness/agent-core";
import {
	type Component,
	Container,
	stripTerminalSequences,
	Text,
	TruncatedText,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@step-harness/pi-tui";
import type { ToolRenderContext, ToolRenderResultOptions } from "../core/extensions/types.ts";
import type { Theme } from "../theme/theme.ts";
import type { StepTask, StepTaskStatus } from "./step-tasks.ts";

type TaskSummary = Pick<StepTask, "id" | "subject" | "status" | "owner"> & Partial<Pick<StepTask, "blockedBy">>;

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

export function renderTaskCall(
	name: string,
	detail: string | undefined,
	theme: Theme,
	context: ToolRenderContext<unknown, unknown>,
): Component {
	if (!context.expanded && !context.isError) {
		return new Container();
	}
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
	name: string,
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext<unknown, unknown>,
): Component {
	if (!options.expanded && !context.isError) {
		if (options.isPartial) return new Container();
		const details = result.details;
		if ((name === "task_create" || name === "task_get") && isTaskSummary(details)) return new Container();
		const summary =
			details && typeof details === "object" && "deleted" in details && details.deleted === true
				? { ...details, status: "deleted" }
				: details;
		const plan = Array.isArray(details)
			? details
			: details && typeof details === "object" && "plan" in details
				? details.plan
				: isTaskSummary(summary)
					? [summary]
					: undefined;
		if (Array.isArray(plan) && plan.every(isTaskSummary)) {
			const completed = plan.filter((task) => task.status === "completed").length;
			const title =
				Array.isArray(details) || (details && typeof details === "object" && "plan" in details)
					? `Updated Plan (${completed}/${plan.length})`
					: "Updated Plan";
			return {
				invalidate() {},
				render(width) {
					const lines: string[] = [];
					if (plan.length === 0) lines.push(theme.fg("muted", "No tasks tracked."));
					for (const task of plan) {
						const owner = task.owner ? ` @${task.owner}` : "";
						const blockers = task.blockedBy?.length ? ` (blocked by ${task.blockedBy.join(", ")})` : "";
						const status = task.status === "deleted" ? " (deleted)" : "";
						const glyph = task.status === "completed" ? "✔" : task.status === "in_progress" ? "◧" : "□";
						const text = singleLine(`${task.subject}${owner}${blockers}${status}`);
						const rows = wrapTextWithAnsi(text, Math.max(1, width - 6));
						for (const [index, row] of rows.entries()) {
							const line = `${index === 0 ? glyph : " "} ${row}`;
							lines.push(
								task.status === "in_progress" ? theme.bold(theme.fg("accent", line)) : theme.fg("muted", line),
							);
						}
					}
					return [
						truncateToWidth(theme.fg("toolTitle", theme.bold(title)), Math.max(1, width), ""),
						...lines.map((line, index) =>
							truncateToWidth(`${index === 0 ? "  └ " : "    "}${line}`, Math.max(1, width), ""),
						),
					];
				},
			};
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
