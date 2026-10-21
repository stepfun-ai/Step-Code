/**
 * Background-lane notification events: builds and steers `<agent-notification>`
 * messages (final/progress/needs-input) from a lane into the parent session.
 */

import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { boundToolResultContent } from "../../core/tools/tool-output.ts";
import type { BackgroundAgentLane, StepSubagentResultRecord } from "../step-subagent.ts";

/** Notification detail levels for background lanes. */
export type BackgroundLaneSubscribeLevel = "final" | "progress";

/** Event kinds carried by `<agent-notification>` steer messages. */
export type BackgroundLaneEvent =
	| "background_done"
	| "background_failed"
	| "background_interrupted"
	| "background_needs_input"
	| "background_progress"
	| "background_restarted";

/** Events that start a parent turn when the parent is idle. */
const WAKING_EVENTS: ReadonlySet<BackgroundLaneEvent> = new Set([
	"background_done",
	"background_failed",
	"background_interrupted",
	"background_needs_input",
]);

/** `details` on an `<agent-notification>` message; read by its transcript renderer. */
export interface AgentNotificationDetails {
	/** Lane id. Named `agentId` for transcripts recorded before lanes had their own id format. */
	agentId: string;
	event: BackgroundLaneEvent;
	status: BackgroundAgentLane["status"];
	/** Display label; older transcripts stored an alias here. */
	label?: string;
	/** Agent names running in the lane, e.g. ["general"]. */
	agents?: string[];
	/** Unescaped body below the headline (output, failure reasons, progress). */
	detail?: string;
}

/** Minimum interval between background_progress notifications per lane. */
const PROGRESS_NOTIFY_INTERVAL_MS = 15_000;

/** Escape a value interpolated into a pseudo-XML wrapper — attribute values and
 * tag content alike — so child output cannot close the wrapper or forge
 * attributes. The escape set (& " < >) is safe for both positions. */
export function escapeXmlAttr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function truncateText(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars)}\n\n[output truncated]`;
}

/** "2 completed, 1 failed" over a lane's task records. */
export function laneTaskCounts(records: readonly StepSubagentResultRecord[]): string {
	const order: Array<[StepSubagentResultRecord["status"], string]> = [
		["completed", "completed"],
		["failed", "failed"],
		["aborted", "stopped"],
		["skipped", "skipped"],
		["running", "running"],
		["queued", "queued"],
	];
	const parts = order
		.map(([status, label]) => {
			const count = records.filter((record) => record.status === status).length;
			return count > 0 ? `${count} ${label}` : "";
		})
		.filter(Boolean);
	return parts.length > 0 ? parts.join(", ") : "no tasks ran";
}

function laneHeadline(lane: BackgroundAgentLane, event: BackgroundLaneEvent): string {
	switch (event) {
		case "background_needs_input":
			return `Lane ${lane.id} requests input.`;
		case "background_progress":
			return `Lane ${lane.id} progress.`;
		case "background_restarted":
			return `Lane ${lane.id} restarted its child process.`;
		case "background_interrupted":
			return `Lane ${lane.id} was stopped: ${laneTaskCounts(lane.details.results)}.`;
		default:
			return `Lane ${lane.id} finished: ${laneTaskCounts(lane.details.results)}.`;
	}
}

/** Steer one lane event into the parent session. `detail` is the unescaped text below the headline. */
export function notifyLaneEvent(
	pi: ExtensionAPI,
	lane: BackgroundAgentLane,
	event: BackgroundLaneEvent,
	detail?: string,
): void {
	if (event === "background_progress" && lane.subscribe !== "progress") return;
	const headline = laneHeadline(lane, event);
	const trimmed = detail?.trim();
	const body = trimmed ? `${headline}\n${trimmed}` : headline;
	const details: AgentNotificationDetails = {
		agentId: lane.id,
		event,
		status: lane.status,
		agents: [...new Set(lane.details.results.map((record) => record.agent))],
		detail: trimmed || undefined,
	};
	pi.sendMessage(
		{
			customType: "agent-notification",
			// The detail is child-model output. Escape the whole body so it cannot
			// forge a `</agent-notification>` close and inject content outside it.
			content:
				`<agent-notification lane="${escapeXmlAttr(lane.id)}" tasks="${lane.details.results.length}">` +
				`${escapeXmlAttr(body)}</agent-notification>`,
			// Progress is for the parent model; the user already watches the lanes
			// widget, and a transcript entry every 15s per lane buries the session.
			display: event !== "background_progress",
			details,
		},
		// A lane usually settles while the parent sits idle, waiting on it. A
		// steer alone only appends the message then, so the model never reads the
		// result until the user types again. Terminal and needs-input events wake
		// the parent with a steer.
		//
		// Progress and restart notices must stay out of the steering queue. It
		// drains one message per turn by default ("one-at-a-time"), and progress
		// arrives every 15s per lane, so completion notices would wait behind that
		// backlog. triggerTurn: false lands them as context instead: appended at
		// once while idle, or batched in at the end of the running turn.
		WAKING_EVENTS.has(event) ? { deliverAs: "steer", triggerTurn: true } : { triggerTurn: false },
	);
}

function laneOutputText(lane: BackgroundAgentLane): string {
	return (
		lane.result?.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim() ?? ""
	);
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
}

function taskLabel(record: StepSubagentResultRecord, index: number): string {
	return `task ${record.step ?? index + 1} (${record.agent})`;
}

/** Duration, usage, child sessions, and cancelled prompts: what status and the final notification share. */
export function laneSummaryLines(lane: BackgroundAgentLane, now = Date.now()): string[] {
	const records = lane.details.results;
	const usage = records.reduce(
		(total, record) => ({
			turns: total.turns + record.usage.turns,
			input: total.input + record.usage.input,
			output: total.output + record.usage.output,
			cost: total.cost + record.usage.cost,
		}),
		{ turns: 0, input: 0, output: 0, cost: 0 },
	);
	const end = lane.status === "running" ? now : lane.updatedAt;
	const lines = [
		`Mode: ${lane.details.mode}; elapsed ${formatDuration(end - lane.startedAt)}; turns ${usage.turns}, tokens in ${usage.input} / out ${usage.output}${usage.cost > 0 ? `, cost $${usage.cost.toFixed(4)}` : ""}`,
	];
	const sessions = records
		.map((record, index) =>
			record.sessionId
				? `- ${taskLabel(record, index)}: ${record.sessionId}${record.sessionFile ? ` (${record.sessionFile})` : ""}`
				: "",
		)
		.filter(Boolean);
	if (sessions.length > 0) lines.push(`Child sessions (transcripts stay on disk):\n${sessions.join("\n")}`);
	const cancelled = records.flatMap((record, index) =>
		(record.cancelledPrompts ?? []).map((title) => `- ${taskLabel(record, index)}: ${title}`),
	);
	if (cancelled.length > 0) {
		lines.push(`Prompts auto-cancelled because a background lane cannot ask the user:\n${cancelled.join("\n")}`);
	}
	return lines;
}

function failureReasons(lane: BackgroundAgentLane, output: string): string[] {
	if (lane.status !== "failed") return [];
	// The aggregate output can omit why a task failed (multi-task lanes surface
	// only their combined text). Always carry each failed task's cause, unless
	// the output already states it verbatim.
	return lane.details.results
		.map((record, index) => ({ record, index }))
		.filter(({ record }) => record.status === "failed")
		.map(({ record, index }) => ({
			label: taskLabel(record, index),
			cause: record.errorMessage?.trim() || record.stderr?.trim() || "no error detail captured",
		}))
		.filter(({ cause }) => !output.includes(cause))
		.map(({ label, cause }) => `- ${label}: ${truncateText(cause, 400)}`);
}

/**
 * Body of the one terminal notification. The structured summary comes first so
 * it survives the output bound; oversized output is saved through the shared
 * tool-output retention boundary and replaced by a preview plus its path.
 */
export async function buildLaneFinalDetail(lane: BackgroundAgentLane, outputDirectory: string): Promise<string> {
	const output = laneOutputText(lane);
	const reasons = failureReasons(lane, output);
	const detail = [
		...laneSummaryLines(lane),
		reasons.length > 0 ? `Failure reasons:\n${reasons.join("\n")}` : "",
		output ? `Output:\n${output}` : "",
	]
		.filter(Boolean)
		.join("\n\n");
	try {
		const bounded = await boundToolResultContent([{ type: "text", text: detail }], outputDirectory);
		return bounded
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
	} catch (error) {
		// Saving the full output failed; still deliver the notification, bounded
		// in memory, and say why no file path is given.
		return `${truncateText(detail, 50_000)}\n[full output could not be saved: ${error instanceof Error ? error.message : String(error)}]`;
	}
}

function laneProgressDetail(lane: BackgroundAgentLane): string {
	const records = lane.details.results;
	const active = records.find((record) => record.status === "running") ?? records.at(-1);
	const parts: string[] = [`step ${active ? records.indexOf(active) + 1 : 1}/${Math.max(records.length, 1)}`];
	if (active?.activeTool) parts.push(`tool ${active.activeTool}`);
	if (active) parts.push(`turns ${active.usage.turns}, in:${active.usage.input} out:${active.usage.output}`);
	return parts.join("; ");
}

export function maybeNotifyLaneProgress(pi: ExtensionAPI, lane: BackgroundAgentLane): void {
	if (lane.subscribe !== "progress" || lane.status !== "running") return;
	const now = Date.now();
	if (now - lane.lastProgressNotifyAt < PROGRESS_NOTIFY_INTERVAL_MS) return;
	lane.lastProgressNotifyAt = now;
	notifyLaneEvent(pi, lane, "background_progress", laneProgressDetail(lane));
}
