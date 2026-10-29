import type { TranslateFn } from "../../i18n";
import type { ThinkingTimelineItem, TimelineItem, ToolTimelineItem } from "../../state/types";
import { toolKind, toolLabel } from "./tool-presentation";

export interface IndexedTimelineRow {
	readonly key: string;
	readonly index: number;
	readonly lastIndex: number;
	readonly item: TimelineItem;
}

export interface ProcessGroup {
	readonly kind: "process-group";
	readonly key: string;
	readonly index: number;
	readonly lastIndex: number;
	readonly rows: readonly (IndexedTimelineRow & { readonly item: ThinkingTimelineItem | ToolTimelineItem })[];
	readonly running: boolean;
}

// These calls own dedicated interactions or lifecycles, not generic process output.
const SEPARATE_TOOLS = new Set([
	"subagent",
	"workflow",
	"enter_plan_mode",
	"exit_plan_mode",
	"desktop_send_message",
	"clarify_user",
]);

/** Presentation only. Indices remain those of the original timeline for turn attachments and search. */
export function groupProcessRows(
	items: readonly TimelineItem[],
	active: boolean,
	breakAfter: ReadonlySet<number> = new Set(),
): (IndexedTimelineRow | ProcessGroup)[] {
	const result: (IndexedTimelineRow | ProcessGroup)[] = [];
	const seen = new Map<string, number>();
	let lastUser = -1;
	items.forEach((item, index) => {
		if (item.kind === "message" && item.role === "user") lastUser = index;
	});
	const awaiting = new Set(items.filter((item) => item.kind === "approval").map((item) => item.approval.toolName));
	let pending: (IndexedTimelineRow & { readonly item: ThinkingTimelineItem | ToolTimelineItem })[] = [];
	const flush = () => {
		if (!pending.length) return;
		result.push({
			kind: "process-group",
			key: `process:${pending[0].key}`,
			index: pending[0].index,
			lastIndex: pending[pending.length - 1].index,
			rows: pending,
			running: pending.some(
				({ item, index }) =>
					active && index > lastUser && (item.kind === "thinking" ? item.running : item.state === "pending"),
			),
		});
		pending = [];
	};
	items.forEach((item, index) => {
		const occurrence = seen.get(item.itemId) ?? 0;
		seen.set(item.itemId, occurrence + 1);
		const key = occurrence ? `${item.itemId}#${index}` : item.itemId;
		const row = { key, index, lastIndex: index, item };
		if (
			item.kind === "thinking" ||
			(item.kind === "tool" &&
				!SEPARATE_TOOLS.has(item.toolName) &&
				!item.children?.length &&
				!item.workflowRun &&
				// A failed call is ordinary process output: it folds with its siblings and shows its state when opened.
				(item.state === "completed" ||
					item.state === "failed" ||
					(active && index > lastUser && !awaiting.has(item.toolName))))
		) {
			pending.push({ ...row, item });
		} else {
			flush();
			result.push(row);
		}
		if (breakAfter.has(index)) flush();
	});
	flush();
	return result;
}

/**
 * Keep the previous row and group objects whose content did not change, so memoized rows skip
 * re-rendering while a turn streams: grouping runs on every update and otherwise hands each
 * historical group a new object.
 */
export function reuseUnchangedRows(
	previous: readonly (IndexedTimelineRow | ProcessGroup)[],
	next: (IndexedTimelineRow | ProcessGroup)[],
): (IndexedTimelineRow | ProcessGroup)[] {
	const byKey = new Map(previous.map((row) => [row.key, row]));
	return next.map((row) => {
		const before = byKey.get(row.key);
		if (!before || before.index !== row.index || before.lastIndex !== row.lastIndex) return row;
		if (!("kind" in row)) return !("kind" in before) && before.item === row.item ? before : row;
		if (!("kind" in before) || before.running !== row.running || before.rows.length !== row.rows.length) return row;
		return before.rows.every(
			(member, index) => member.item === row.rows[index].item && member.key === row.rows[index].key,
		)
			? before
			: row;
	});
}

/** DFSC Simple uses the current tool subject, or the latest paragraph of live thinking. */
export function processGroupSummary(
	group: ProcessGroup,
	t: TranslateFn,
): { label: string; detail: string; icon: "wrench" | "brain" | "check" } {
	const tools = group.rows.map((row) => row.item).filter((item) => item.kind === "tool");
	const current = group.running ? [...tools].reverse().find((item) => item.state === "pending") : undefined;
	if (current) {
		return {
			label: toolLabel(current, t),
			detail: current.args?.command || current.args?.path || current.args?.pattern || current.inputSummary,
			icon: "wrench",
		};
	}
	if (group.running) {
		const thought = [...group.rows].reverse().find(({ item }) => item.kind === "thinking" && item.running)?.item;
		const paragraphs = thought?.kind === "thinking" ? thought.content.split(/\r?\n[\t ]*\r?\n/) : [];
		return {
			label: t("thinkingIndicator"),
			detail: (
				paragraphs
					.filter((text) => text.trim())
					.at(-1)
					?.split(/\r?\n/, 1)[0] ?? ""
			)
				.replaceAll("**", "")
				.replace(/\s+/gu, " ")
				.trim(),
			icon: "brain",
		};
	}
	if (!tools.length) return { label: t("processThinkingRecorded"), detail: "", icon: "brain" };
	const counts = new Map<string, number>();
	for (const tool of tools) {
		const kind = toolKind(tool);
		counts.set(kind, (counts.get(kind) ?? 0) + 1);
	}
	const summary = [...counts].map(([kind, count]) => t(`processCount.${kind}`, { count })).join(t("processJoiner"));
	return {
		label: counts.size > 3 ? t("processCompletedTools", { count: tools.length }) : t("processCompleted", { summary }),
		detail: "",
		icon: "check",
	};
}
