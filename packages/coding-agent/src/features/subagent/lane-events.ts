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
			display: true,
			details: { agentId: lane.id, event, status: lane.status },
		},
		{ deliverAs: "steer" },
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
		output ? truncateText(output, 2_000) : "",
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
