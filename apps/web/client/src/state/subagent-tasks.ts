import { readMessageUsage } from "./subagent-usage";
import type {
	SessionEntry,
	SubagentControl,
	SubagentStatus,
	SubagentTask,
	SubagentUsage,
	TimelineItem,
	ToolState,
} from "./types";

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

export function subagentControl(
	input: unknown,
	details: unknown,
	previous?: SubagentControl,
): SubagentControl | undefined {
	const args = record(input);
	const action = args?.action ?? previous?.action;
	if (action !== "reply" && action !== "stop" && action !== "status") return;
	const lanes = (Array.isArray(details) ? details : []).flatMap((value) => {
		const lane = record(value);
		return typeof lane?.agentId === "string"
			? [{ laneId: lane.agentId, status: status(lane.status), tasks: subagentTasks(undefined, lane, "pending") }]
			: [];
	});
	return {
		action,
		laneId: typeof args?.lane_id === "string" ? args.lane_id : previous?.laneId,
		prompt: typeof args?.prompt === "string" ? args.prompt : previous?.prompt,
		lanes: lanes.length ? lanes : (previous?.lanes ?? []),
	};
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
				reportedStatus: status(item.status),
				...(typeof item.sessionId === "string" && item.sessionId ? { sessionId: item.sessionId } : {}),
				...(backgroundAgentId ? { backgroundAgentId } : {}),
				model: typeof item.model === "string" ? item.model : undefined,
				...(typeof usage?.turns === "number" && Number.isSafeInteger(usage.turns) && usage.turns >= 0
					? { turns: usage.turns }
					: {}),
				// What the run cost: the kernel already summed its turns, so the panel
				// does not have to re-add a transcript it may only partly read.
				...subagentUsage(usage),
				activeText: typeof item.activeText === "string" ? item.activeText : undefined,
				activeThinking: typeof item.activeThinking === "string" ? item.activeThinking : undefined,
				activeTool: typeof item.activeTool === "string" ? item.activeTool : undefined,
				activeToolOutput: typeof item.activeToolOutput === "string" ? item.activeToolOutput : undefined,
				error: typeof item.errorMessage === "string" && item.errorMessage ? item.errorMessage : undefined,
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

/** Validate the live SSE boundary before using a lane's identity or records. */
export function readSubagentLane(
	value: unknown,
): { laneId: string; status: SubagentStatus; details: Record<string, unknown> } | undefined {
	const lane = record(value);
	const details = record(lane?.details);
	if (typeof lane?.laneId !== "string" || !lane.laneId || !details || !Array.isArray(details.results)) return;
	if (
		typeof lane.status !== "string" ||
		!["running", "completed", "failed", "aborted"].includes(lane.status) ||
		details.agentId !== lane.laneId
	)
		return;
	return { laneId: lane.laneId, status: status(lane.status), details };
}

/** Same presentation-cache policy as the host: running lanes plus 16 recent terminal frames. */
export function cacheSubagentLanes(previous: readonly unknown[], value: unknown): readonly unknown[] {
	const next = readSubagentLane(value);
	if (!next) return previous;
	const lanes = previous.flatMap((item) => {
		const lane = readSubagentLane(item);
		return lane && lane.laneId !== next.laneId ? [lane] : [];
	});
	lanes.push(next);
	const finished = lanes
		.filter((lane) => lane.status !== "running")
		.sort((left, right) => Number(left.details.updatedAt ?? 0) - Number(right.details.updatedAt ?? 0));
	const expired = new Set(finished.slice(0, Math.max(0, finished.length - 16)).map((lane) => lane.laneId));
	return lanes.filter((lane) => !expired.has(lane.laneId));
}

/** Validate the durable completed-answer SSE/journal projection. */
export function readCompletedSubagentEntry(
	value: unknown,
): { id: string; laneId: string; sessionId: string; taskIndex: number; output: string } | undefined {
	const entry = record(value);
	if (typeof entry?.id !== "string" || entry.type !== "custom" || entry.customType !== "step-subagent-response")
		return;
	const response = record(entry.data);
	if (
		!response ||
		typeof response.laneId !== "string" ||
		typeof response.sessionId !== "string" ||
		typeof response.output !== "string" ||
		!Number.isSafeInteger(response.taskIndex) ||
		Number(response.taskIndex) < 0
	)
		return;
	return {
		id: entry.id,
		laneId: response.laneId,
		sessionId: response.sessionId,
		taskIndex: Number(response.taskIndex),
		output: response.output,
	};
}

/** Overlay runtime-owned progress and durable completed answers, never status inferred from prose. */
export function withSubagentLaneState(
	items: readonly TimelineItem[],
	snapshots?: readonly unknown[],
	entries: readonly SessionEntry[] = [],
): readonly TimelineItem[] {
	const lanes = new Map(
		(snapshots ?? []).flatMap((value) => {
			const lane = readSubagentLane(value);
			return lane ? [[lane.laneId, lane] as const] : [];
		}),
	);
	const responses = entries.flatMap((entry) => {
		const response = readCompletedSubagentEntry(entry);
		return response ? [response] : [];
	});
	const controls = items.filter(
		(item): item is TimelineItem & { kind: "tool"; subagentControl: SubagentControl } =>
			item.kind === "tool" && Boolean(item.subagentControl),
	);
	const controlOrder = new Map<string, number>();
	const notifications = new Map<string, { status: SubagentStatus; order: number }>();
	entries.forEach((entry, order) => {
		const message = entry.message;
		if (message?.role === "toolResult" && message.toolName === "agent_send" && typeof message.toolCallId === "string")
			controlOrder.set(`tool-${message.toolCallId}`, order);
		const details = record(entry.type === "custom_message" ? entry.details : message?.details);
		const notification =
			entry.type === "custom_message"
				? entry.customType === "agent-notification"
				: message?.role === "custom" && message.customType === "agent-notification";
		if (
			notification &&
			typeof details?.agentId === "string" &&
			typeof details.event === "string" &&
			Object.hasOwn(NOTIFICATION_STATUS, details.event) &&
			details.status === NOTIFICATION_STATUS[details.event]
		)
			notifications.set(details.agentId, { status: status(details.status), order });
	});
	if (
		!lanes.size &&
		!responses.length &&
		!controls.length &&
		!notifications.size &&
		(snapshots === undefined ||
			!items.some((item) => item.kind === "tool" && item.subagentTasks?.some((task) => task.backgroundAgentId)))
	)
		return items;
	return items.map((item) => {
		if (item.kind !== "tool" || !item.subagentTasks) return item;
		const groupId = item.subagentTasks.find((task) => task.backgroundAgentId)?.backgroundAgentId;
		const groupLane = groupId ? lanes.get(groupId) : undefined;
		const omitted = groupLane?.details.omittedResults;
		return {
			...item,
			subagentOmitted: typeof omitted === "number" && Number.isSafeInteger(omitted) && omitted > 0 ? omitted : 0,
			subagentLaneStatus: groupLane?.status,
			subagentTasks: item.subagentTasks.map((task, index, tasks) => {
				let settledRecord = ["completed", "failed", "aborted", "skipped"].includes(
					task.reportedStatus ?? task.status,
				);
				const notification = task.backgroundAgentId ? notifications.get(task.backgroundAgentId) : undefined;
				let newerControl = false;
				const operations = controls
					.filter(
						(control) =>
							task.backgroundAgentId &&
							(control.subagentControl.laneId === task.backgroundAgentId ||
								control.subagentControl.lanes.some((lane) => lane.laneId === task.backgroundAgentId)),
					)
					.sort(
						(left, right) =>
							(controlOrder.get(left.itemId) ?? Infinity) - (controlOrder.get(right.itemId) ?? Infinity),
					);
				for (const operation of operations) {
					const state =
						operation.state !== "failed"
							? operation.subagentControl.lanes.find((lane) => lane.laneId === task.backgroundAgentId)
							: undefined;
					const next =
						state?.tasks.find((candidate) => task.sessionId && candidate.sessionId === task.sessionId) ??
						state?.tasks[index];
					const recent = !notification || (controlOrder.get(operation.itemId) ?? Infinity) > notification.order;
					if (recent && next && ["completed", "failed", "aborted", "skipped"].includes(next.status))
						settledRecord = true;
					if (state && recent && (state.status !== "unknown" || (next?.status && next.status !== "unknown")))
						newerControl = true;
					if (state)
						task = {
							...task,
							...next,
							reportedStatus: recent && next ? next.reportedStatus : task.reportedStatus,
							task: task.task || next?.task || "",
							sessionId: next?.sessionId ?? task.sessionId,
							status: !recent
								? task.status
								: tasks.length === 1 && state.status !== "unknown"
									? state.status
									: next?.status && next.status !== "unknown"
										? next.status
										: task.status,
						};
				}
				if (
					notification &&
					!newerControl &&
					(tasks.length === 1 || task.status === "running" || task.status === "queued")
				)
					task = {
						...task,
						status:
							tasks.length > 1 && task.status === "queued" && notification.status !== "running"
								? "unknown"
								: notification.status,
					};
				const lane = task.backgroundAgentId ? lanes.get(task.backgroundAgentId) : undefined;
				const next = lane ? subagentTasks(undefined, lane.details, "pending")[index] : undefined;
				const done = responses.filter(
					(response) => response.laneId === task.backgroundAgentId && response.taskIndex === index,
				);
				const terminal = lane && lane.status !== "running";
				const noLiveOwner = snapshots !== undefined && task.backgroundAgentId && !lane;
				const missingRecord = lane && !next && Number(lane.details.omittedResults ?? 0) > 0 && !settledRecord;
				return {
					...task,
					...next,
					// The live task summary is bounded; the original dispatch keeps the full input.
					task: task.task || next?.task || "",
					sessionId:
						next?.sessionId ??
						task.sessionId ??
						(typeof done[0]?.sessionId === "string" ? done[0].sessionId : undefined),
					status:
						missingRecord || (noLiveOwner && (task.status === "running" || task.status === "queued"))
							? "unknown"
							: lane &&
									(tasks.length === 1 ||
										(terminal && ["running", "queued"].includes(next?.status ?? task.status)))
								? tasks.length > 1 && next?.status === "queued" && terminal
									? "unknown"
									: lane.status
								: (next?.status ?? task.status),
					completedOutputs: done.length
						? done.map((response) => ({ id: response.id, output: String(response.output) }))
						: task.completedOutputs,
					controls: operations.length
						? operations.map((operation) => ({
								id: operation.itemId,
								action: operation.subagentControl.action,
								prompt: operation.subagentControl.prompt,
								output: operation.outputDetail || operation.outputSummary,
							}))
						: task.controls,
				};
			}),
		};
	});
}

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
