/** Presentation-only projections of task state and immutable tool results. */
import type { AgentToolResult } from "@step-harness/agent-core";
import { type Component, stripTerminalSequences, Text, TruncatedText, truncateToWidth } from "@step-harness/pi-tui";
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

export function singleLine(text: string): string {
	return stripTerminalSequences(text)
		.replace(/[\p{Cc}\s]+/gu, " ")
		.trim();
}

export function formatTaskLine(task: TaskSummary): string {
	const owner = task.owner ? ` @${task.owner}` : "";
	const blockers = task.blockedBy?.length ? ` (blocked by ${task.blockedBy.join(", ")})` : "";
	return singleLine(`${STATUS_LABELS[task.status]} ${task.id}. ${task.subject}${owner}${blockers}`);
}

function isOpen(task: StepTask): boolean {
	return task.status === "pending" || task.status === "in_progress";
}

/** Stable ordering that puts active work first within the open preview. */
function wipFirst(a: StepTask, b: StepTask): number {
	return Number(b.status === "in_progress") - Number(a.status === "in_progress");
}

export function widgetTaskLine(task: StepTask): string {
	return formatTaskLine({
		id: task.id,
		status: task.status,
		owner: task.owner,
		subject: task.status === "in_progress" ? task.activeForm || task.subject : task.subject,
	});
}

interface OverflowSummary {
	/** Items not visible in the collapsed preview (completed plus truncated open). */
	hidden: number;
	done: number;
	todo: number;
	wip: number;
}

/** Open tasks in id order with active work first; shared by both widget paths. */
function openTasksSorted(tasks: readonly StepTask[]): StepTask[] {
	return tasks.filter(isOpen).sort(wipFirst);
}

/** What the collapsed preview hides: every completed task plus open tasks beyond the cap. */
export function collapsedOverflow(tasks: readonly StepTask[]): OverflowSummary | undefined {
	const hiddenOpen = openTasksSorted(tasks).slice(PREVIEW_TASKS);
	const done = tasks.filter((task) => task.status === "completed").length;
	const hidden = done + hiddenOpen.length;
	if (hidden === 0) return undefined;
	return {
		hidden,
		done,
		todo: hiddenOpen.filter((task) => task.status === "pending").length,
		wip: hiddenOpen.filter((task) => task.status === "in_progress").length,
	};
}

function overflowCountsText({ done, todo, wip }: OverflowSummary): string {
	const parts: string[] = [];
	if (done > 0) parts.push(`${done} done`);
	if (todo > 0) parts.push(`${todo} todo`);
	if (wip > 0) parts.push(`${wip} wip`);
	return parts.join(" · ");
}

/** Input is in ID order; stable sorting puts active work first. RPC accepts these plain lines too. */
export function taskWidgetLines(tasks: readonly StepTask[]): string[] | undefined {
	if (tasks.length === 0) return undefined;
	const completed = tasks.filter((task) => task.status === "completed").length;
	const open = openTasksSorted(tasks);
	const lines = [`Tasks: ${completed}/${tasks.length} completed`];
	for (const task of open.slice(0, PREVIEW_TASKS)) {
		// truncateToWidth appends ANSI resets; widgets also travel over RPC.
		lines.push(stripTerminalSequences(truncateToWidth(widgetTaskLine(task), 100)));
	}
	const overflow = collapsedOverflow(tasks);
	if (overflow) {
		lines.push(`... +${overflow.hidden} more (${overflowCountsText(overflow)}) · /todos to expand`);
	}
	return lines;
}

/**
 * Persistent task widget for interactive mode. The collapsed view mirrors the
 * RPC lines; ctrl+o (the global expand toggle) switches it to the full list
 * with completed items dimmed, so done and open progress stay visible without
 * scrolling the transcript.
 */
export class TaskWidgetComponent implements Component {
	private readonly tasks: readonly StepTask[];
	private expanded = false;
	private readonly theme: Theme;
	/** Styled lines cached per expansion state; tasks are an immutable snapshot. */
	private cache: { expanded: boolean; lines: string[] } | undefined;

	constructor(tasks: readonly StepTask[], theme: Theme) {
		this.tasks = tasks;
		this.theme = theme;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	invalidate(): void {
		this.cache = undefined;
	}

	render(width: number): string[] {
		if (this.tasks.length === 0) return [];
		// render() runs per frame; sorting and styling the snapshot is done once.
		if (this.cache?.expanded !== this.expanded) {
			this.cache = {
				expanded: this.expanded,
				lines: this.expanded ? this.expandedLines() : this.collapsedLines(),
			};
		}
		return this.cache.lines.map((line) => truncateToWidth(line, width));
	}

	private summaryLine(): string {
		const completed = this.tasks.filter((task) => task.status === "completed").length;
		return this.theme.fg("accent", `Tasks: ${completed}/${this.tasks.length} completed`);
	}

	private collapsedLines(): string[] {
		const open = this.tasks.filter(isOpen).sort(wipFirst);
		const lines = [this.summaryLine()];
		for (const task of open.slice(0, PREVIEW_TASKS)) {
			lines.push(this.theme.fg("toolOutput", widgetTaskLine(task)));
		}
		const overflow = collapsedOverflow(this.tasks);
		if (overflow) {
			lines.push(
				this.theme.fg("dim", `... +${overflow.hidden} more (${overflowCountsText(overflow)}) · ctrl+o to expand`),
			);
		}
		return lines;
	}

	private expandedLines(): string[] {
		const lines = [this.summaryLine()];
		for (const task of this.tasks) {
			const line = widgetTaskLine(task);
			lines.push(task.status === "completed" ? this.theme.fg("dim", line) : this.theme.fg("toolOutput", line));
		}
		lines.push(this.theme.fg("dim", `all ${this.tasks.length} items · ctrl+o to collapse`));
		return lines;
	}
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
			// The Tasks panel above the editor owns the per-item view, so the
			// transcript keeps only the counts line.
			const completed = details.filter((task) => task.status === "completed").length;
			const open = details.filter((task) => task.status === "pending" || task.status === "in_progress").length;
			return new TruncatedText(theme.fg("toolOutput", `${details.length} tasks · ${completed} done · ${open} open`));
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
