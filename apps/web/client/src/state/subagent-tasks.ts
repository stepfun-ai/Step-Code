import { readMessageUsage } from "./subagent-usage";
import type { SessionEntry, SubagentStatus, SubagentTask, SubagentUsage, ToolState } from "./types";

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function status(value: unknown): SubagentStatus {
	switch (value) {
		case "queued":
		case "running":
		case "completed":
		case "failed":
		case "aborted":
		case "skipped":
			return value;
		default:
			return "unknown";
	}
}

/**
 * The run's own totals, read from the tool result.
 *
 * `usage` is the kernel's `StepSubagentUsage`: `turns` plus the token counts. The
 * client keeps the tokens under `SubagentUsage` (with a `records` count standing
 * in for how many turns reported them), because the panel reports cache rates
 * over them and must not invent a rate from a zero denominator.
 */
function subagentUsage(usage: Record<string, unknown> | undefined): { usage?: SubagentUsage } {
	if (!usage) return {};
	const totals = readMessageUsage(usage);
	if (!totals) return {};
	// `records` is how many turns reported usage; the kernel's `turns` is that count.
	const records =
		typeof usage.turns === "number" && Number.isSafeInteger(usage.turns) && usage.turns >= 0 ? usage.turns : 0;
	return { usage: { ...totals, records } };
}

/**
 * Only structured tool records define task state; prose and exit codes are not a
 * lifecycle protocol. One exception: a dispatch the kernel *rejected* never
 * started a child, so there are no structured per-task results — the planned
 * rows are kept, as failed attempts carrying the tool's own error, instead of
 * disappearing from the agent list as if nothing had been asked for.
 */
export function subagentTasks(
	input: unknown,
	details: unknown,
	toolState: ToolState,
	previous: readonly SubagentTask[] = [],
	/** The tool result's text when the dispatch itself failed; ignored otherwise. */
	failure?: string,
): readonly SubagentTask[] {
	const value = record(details);
	const backgroundAgentId = typeof value?.agentId === "string" ? value.agentId : undefined;
	const results = Array.isArray(value?.results) ? value.results : [];
	const tasks = results.flatMap((result): SubagentTask[] => {
		const item = record(result);
		if (!item || (typeof item.agent !== "string" && typeof item.task !== "string")) return [];
		const usage = record(item.usage);
		return [
			{
				agent: typeof item.agent === "string" ? item.agent : "",
				task: typeof item.task === "string" ? item.task : "",
				status: status(item.status),
				...(typeof item.sessionId === "string" && item.sessionId ? { sessionId: item.sessionId } : {}),
				...(backgroundAgentId ? { backgroundAgentId } : {}),
				...(typeof item.model === "string" ? { model: item.model } : {}),
				...(typeof usage?.turns === "number" && Number.isSafeInteger(usage.turns) && usage.turns >= 0
					? { turns: usage.turns }
					: {}),
				// What the run cost: the kernel already summed its turns, so the panel
				// does not have to re-add a transcript it may only partly read.
				...subagentUsage(usage),
				...(typeof item.errorMessage === "string" && item.errorMessage ? { error: item.errorMessage } : {}),
			},
		];
	});
	if (tasks.length) return tasks;
	const rejected = toolState === "failed";
	const error = rejected ? failure?.trim() : "";
	if (rejected) {
		// Only a step that never settled can be called failed; a chain step that
		// already completed stays completed, and its own result is untouched.
		const carried = previous.map((task) =>
			task.status === "queued" || task.status === "running"
				? { ...task, status: "failed" as const, ...(error ? { error } : {}) }
				: task,
		);
		if (carried.length) return carried;
	}
	if (previous.length)
		return previous.map((task) => ({
			...task,
			status:
				toolState === "completed" && (task.status === "queued" || task.status === "running")
					? "unknown"
					: task.status,
		}));
	const args = record(input);
	const planned = Array.isArray(args?.tasks)
		? args.tasks
		: Array.isArray(args?.chain)
			? args.chain
			: args
				? [args]
				: [];
	return planned.flatMap((candidate): SubagentTask[] => {
		const task = record(candidate);
		if (!task || (typeof task.agent !== "string" && typeof task.task !== "string")) return [];
		return [
			{
				agent: typeof task.agent === "string" ? task.agent : "",
				task: typeof task.task === "string" ? task.task : "",
				// Planned arguments do not prove execution started; a rejected dispatch
				// proves it did not finish, and its own error is the reason.
				status: toolState === "pending" ? "queued" : rejected ? "failed" : "unknown",
				...(error ? { error } : {}),
			},
		];
	});
}

const NOTIFICATION_STATUS: Readonly<Record<string, SubagentStatus>> = {
	background_done: "completed",
	background_failed: "failed",
	background_interrupted: "aborted",
	background_progress: "running",
	background_restarted: "running",
	background_needs_input: "running",
};

/** Background dispatch results are snapshots; subsequent structured notifications own lane state. */
export function backgroundSubagentStatuses(entries: readonly SessionEntry[]): ReadonlyMap<string, SubagentStatus> {
	const states = new Map<string, SubagentStatus>();
	for (const entry of entries) {
		const message = entry.message;
		const details = record(message?.details);
		if (message?.role === "toolResult" && message.toolName === "subagent" && typeof details?.agentId === "string") {
			const initial = status(details.status);
			if (initial !== "unknown") states.set(details.agentId, initial);
		}
	}
	for (const entry of entries) {
		const message = entry.message;
		if (message?.role === "toolResult" && message.toolName === "agent_send") {
			// One reply/stop reports every lane it addressed (`to.group`, `to.all`): an array of lane details.
			for (const lane of Array.isArray(message.details) ? message.details : []) {
				const details = record(lane);
				const next = status(details?.status);
				if (typeof details?.agentId === "string" && states.has(details.agentId) && next !== "unknown")
					states.set(details.agentId, next);
			}
			continue;
		}
		const details = record(entry.type === "custom_message" ? entry.details : message?.details);
		if (typeof details?.agentId !== "string" || !states.has(details.agentId)) continue;
		if (
			((entry.type === "custom_message" && entry.customType === "agent-notification") ||
				(message?.role === "custom" && message.customType === "agent-notification")) &&
			typeof details.event === "string" &&
			Object.hasOwn(NOTIFICATION_STATUS, details.event) &&
			details.status === NOTIFICATION_STATUS[details.event]
		) {
			states.set(details.agentId, NOTIFICATION_STATUS[details.event]);
		}
	}
	return states;
}
