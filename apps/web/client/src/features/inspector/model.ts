import type { SessionEntry, SessionInspector, SessionStatus, SubagentStatus, TimelineItem } from "../../state/types";

/** The status a checklist row renders; `aborted` is derived, never stored in a snapshot. */
export type InspectorTaskStatus = SessionInspector["tasks"][number]["status"] | "aborted";

/** The statuses during which the session can still be advancing a checklist row. */
export function sessionIsLive(status: SessionStatus | undefined): boolean {
	return status === "running" || status === "waiting";
}

/**
 * The last task snapshot keeps the status it had when a turn stopped, so a
 * stopped session must not keep an `in_progress` row spinning.
 */
export function effectiveTaskStatus(
	status: SessionInspector["tasks"][number]["status"],
	live: boolean,
): InspectorTaskStatus {
	return !live && status === "in_progress" ? "aborted" : status;
}

export interface SummaryAgentRecord {
	readonly key: string;
	readonly agent: string;
	readonly task: string;
	readonly status: SubagentStatus;
	readonly target:
		| { readonly kind: "task"; readonly toolItemId: string; readonly taskIndex: number }
		| { readonly kind: "child"; readonly sessionId: string }
		| { readonly kind: "workflow"; readonly runId: string };
}

/** Reuse validated timeline state; a returned dispatch does not prove child success. */
export function summaryAgentRecords(items: readonly TimelineItem[]): SummaryAgentRecord[] {
	const records: SummaryAgentRecord[] = [];
	const identities = new Map<string, number>();
	const retain = (record: SummaryAgentRecord, aliases: string[]): void => {
		const index = aliases.map((alias) => identities.get(alias)).find((value) => value !== undefined);
		if (index === undefined) {
			for (const alias of aliases) identities.set(alias, records.length);
			records.push(record);
		} else {
			for (const alias of aliases) identities.set(alias, index);
			const original = records[index];
			records[index] = {
				...original,
				status: record.status !== "unknown" ? record.status : original.status,
				agent: original.agent || record.agent,
				task: original.task || record.task,
			};
		}
	};
	for (const item of items) {
		if (item.kind !== "tool" || item.toolName === "agent_send") continue;
		if (item.subagentTasks?.length) {
			for (const [index, task] of item.subagentTasks.entries()) {
				const laneIdentity = task.backgroundAgentId ? `lane:${task.backgroundAgentId}:task:${index}` : undefined;
				const childIdentity = task.sessionId ? `child:${task.sessionId}` : undefined;
				const key = laneIdentity ?? childIdentity ?? `${item.itemId}:task:${index}`;
				retain(
					{
						key,
						agent: task.agent,
						task: task.task,
						status: task.status,
						target: { kind: "task", toolItemId: item.itemId, taskIndex: index },
					},
					[key, ...(childIdentity ? [childIdentity] : [])],
				);
			}
		} else if (item.children?.length) {
			for (const child of item.children) {
				const key = `child:${child.sessionId}`;
				retain(
					{
						key,
						agent: child.label,
						task: item.inputSummary,
						status: "unknown",
						target: { kind: "child", sessionId: child.sessionId },
					},
					[key],
				);
			}
		} else if (item.workflowRun) {
			records.push({
				key: `${item.itemId}:workflow`,
				agent: "",
				task: item.inputSummary,
				status: "unknown",
				target: { kind: "workflow", runId: item.workflowRun },
			});
		} else if (item.toolName === "subagent") {
			records.push({
				key: `${item.itemId}:dispatch`,
				agent: "",
				task: item.inputSummary,
				status: "unknown",
				target: { kind: "task", toolItemId: item.itemId, taskIndex: 0 },
			});
		}
	}
	return records;
}

export function finiteAmount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Summary is current activity; history remains navigable from the parent tool rows. */
export function activeAgentRecords(items: readonly TimelineItem[]): SummaryAgentRecord[] {
	return summaryAgentRecords(items).filter((record) => record.status === "running");
}

/** Header activity preserves unknown history; its count describes only current running agents. */
export function summaryHeaderState(
	items: readonly TimelineItem[],
	parentStatus: SessionStatus | undefined,
	tasks: SessionInspector["tasks"],
	hasInspector: boolean,
): { count: number; state: "running" | "aborted" | "unknown" | "idle" } {
	const records = summaryAgentRecords(items);
	const count = records.filter((record) => record.status === "running").length;
	const partialActive = items.some(
		(item) => item.kind === "tool" && item.subagentLaneStatus === "running" && (item.subagentOmitted ?? 0) > 0,
	);
	const running =
		count > 0 ||
		partialActive ||
		(sessionIsLive(parentStatus) && tasks.some((task) => task.status === "in_progress"));
	return {
		count,
		state: running
			? "running"
			: parentStatus === "failed"
				? "aborted"
				: !hasInspector || records.some((record) => record.status === "unknown")
					? "unknown"
					: "idle",
	};
}

/**
 * The agent a subagent panel opens on when it is opened without a target.
 *
 * The rail's button has no row to name, so it asks for a default: the newest
 * agent still working, otherwise the newest record at all. A running agent is
 * what someone opening the panel cold is watching; a finished one is what they
 * come back to read. Records are in timeline order, so the last match is the
 * most recent.
 */
export function latestAgentRecord(items: readonly TimelineItem[]): SummaryAgentRecord | undefined {
	const records = summaryAgentRecords(items);
	const live = records.filter((record) => record.status === "queued" || record.status === "running");
	return live.at(-1) ?? records.at(-1);
}

/** Only readable message blocks; opaque signatures and provider transport data stay out. */
export function recordedMessage(entry: SessionEntry): { role: string; content: unknown } | undefined {
	const message = entry.message;
	if (!message) return undefined;
	const content =
		typeof message.content === "string"
			? message.content
			: message.content?.map((part) => {
					if (part.type === "image") return { type: "image" };
					if (part.type === "thinking")
						return { type: "thinking", thinking: part.redacted ? undefined : part.thinking };
					if (part.type === "toolCall") return { type: part.type, name: part.name, arguments: part.arguments };
					return { type: part.type, text: part.text };
				});
	return { role: message.role, content };
}

/** One-line preview of a recorded message, read as prose: Markdown emphasis, code ticks and line marks are dropped. */
export function messagePreview(entry: SessionEntry): string {
	const content = entry.message?.content;
	const text =
		typeof content === "string"
			? content
			: (content
					?.map((part) => part.text ?? part.name ?? "")
					.filter(Boolean)
					.join(" ") ?? "");
	return text
		.replace(/\*\*|__|`+/g, "")
		.replace(/(^|\s)(#{1,6}|>|[-*+])\s+/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}
