/**
 * Background-lane notification events: builds and steers `<agent-notification>`
 * messages (final/progress/needs-input) from a lane into the parent session.
 */

import type { ExtensionAPI } from "../../core/extensions/types.ts";
import type { BackgroundAgentLane } from "../step-subagent.ts";

/** Notification detail levels for background lanes. */
export type BackgroundLaneSubscribeLevel = "final" | "progress" | "none";

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
	agentId: string;
	event: BackgroundLaneEvent;
	status: BackgroundAgentLane["status"];
	/** Alias when the lane has one, otherwise its id. */
	label?: string;
	/** Agent names running in the lane, e.g. ["general"]. */
	agents?: string[];
	/** Unescaped body below the headline (output, failure reasons, progress). */
	detail?: string;
}

/**
 * Cap on the lane output a final notification carries. The notification is the
 * parent's only copy of the result (agent_send can reply or stop, not fetch),
 * so it matches what a blocking call returns per task instead of a short
 * preview the parent would have to dig back out of the child's session file.
 */
const LANE_OUTPUT_MAX_CHARS = 50_000;

/** Minimum interval between background_progress notifications per lane. */
const PROGRESS_NOTIFY_INTERVAL_MS = 15_000;

/** Escape a value interpolated into a pseudo-XML wrapper — attribute values and
 * tag content alike — so a hostile alias or child output cannot close the
 * wrapper or forge attributes (S1/S2 review findings). The escape set (& " < >)
 * is safe for both positions. */
export function escapeXmlAttr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function truncateText(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars)}\n\n[output truncated]`;
}

// Plan 1 S0/S1 event flow (docs/improvement-plan.md): steer lane lifecycle
// notifications into the parent session. The parent agent sees them as
// <agent-notification> user-visible custom messages on its next turn.
export function notifyLaneEvent(
	pi: ExtensionAPI,
	lane: BackgroundAgentLane,
	event: BackgroundLaneEvent,
	detail?: string,
): void {
	if (lane.subscribe === "none") return;
	if (event === "background_progress" && lane.subscribe !== "progress") return;
	const label = lane.alias ?? lane.id;
	const headline =
		event === "background_needs_input"
			? `Background agent ${label} requests input.`
			: event === "background_progress"
				? `Background agent ${label} progress.`
				: event === "background_restarted"
					? `Background agent ${label} restarted its child process.`
					: `Background agent ${label} ${lane.status}.`;
	const body = detail?.trim() ? `${headline}\n${detail.trim()}` : headline;
	const details: AgentNotificationDetails = {
		agentId: lane.id,
		event,
		status: lane.status,
		label,
		agents: [...new Set(lane.details.results.map((record) => record.agent))],
		detail: detail?.trim() || undefined,
	};
	pi.sendMessage(
		{
			customType: "agent-notification",
			// The alias (model-suppliable spawn param, inside `body` via the
			// headline) and the detail (child-model output) both land in the
			// wrapper's text content. Escape the whole body — not only the
			// alias attribute — so neither can forge a `</agent-notification>`
			// close and inject content outside the wrapper (review blocker).
			content:
				`<agent-notification agentId="${escapeXmlAttr(lane.id)}" alias="${escapeXmlAttr(label)}" event="${event}" status="${lane.status}">` +
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
		// arrives every 15s per lane: while the parent sat in a long tool call
		// (a 3-minute sleep, say) dozens queued up, the parent read one per turn,
		// and the lanes' completion notices waited behind that backlog for over
		// half an hour. A steer also forces another model call after the parent
		// meant to stop. triggerTurn: false instead lands them as context:
		// appended at once while idle, or batched in at the end of the running
		// turn, which is the same boundary a steer would be injected at.
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

export function notifyLaneFinal(pi: ExtensionAPI, lane: BackgroundAgentLane): void {
	const event: BackgroundLaneEvent =
		lane.status === "failed"
			? "background_failed"
			: lane.status === "aborted"
				? "background_interrupted"
				: "background_done";
	const output = laneOutputText(lane);
	// The aggregate output can omit why a task failed (multi-task lanes surface
	// only their combined text). Always carry each failed task's cause, unless
	// the output already states it verbatim.
	const failureReasons =
		lane.status === "failed"
			? lane.details.results
					.map((record, index) => ({ record, index }))
					.filter(({ record }) => record.status === "failed")
					.map(({ record, index }) => ({
						label: `task ${record.step ?? index + 1} (${record.agent})`,
						cause: record.errorMessage?.trim() || record.stderr?.trim() || "no error detail captured",
					}))
					.filter(({ cause }) => !output.includes(cause))
					.map(({ label, cause }) => `- ${label}: ${truncateText(cause, 400)}`)
			: [];
	const detail = [
		output ? truncateText(output, LANE_OUTPUT_MAX_CHARS) : "",
		failureReasons.length > 0 ? `Failure reasons:\n${failureReasons.join("\n")}` : "",
	]
		.filter(Boolean)
		.join("\n\n");
	notifyLaneEvent(pi, lane, event, detail || undefined);
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
