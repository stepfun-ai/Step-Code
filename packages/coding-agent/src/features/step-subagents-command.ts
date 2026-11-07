/**
 * `/subagents`: what this session's background agents are doing right now.
 *
 * Background lanes draw nothing above the editor. A permanent panel would compete with the
 * conversation for as long as a lane runs — minutes, sometimes an hour — and its rows cannot show
 * the thing a user wants next: which step each child is on. This command answers that on demand.
 *
 * Shaped like `/ps`: a command that prints into the transcript. The list is a snapshot of the
 * current activity, so it is stale the moment it is printed; that is the right shape for something
 * the user asks for when they want to know.
 *
 * Fed by `SUBAGENT_LANE_CHANNEL`, the same session-local bus the Web host projects from. Reading the
 * bus rather than the lane map keeps this command outside the lane lifecycle's ownership: it
 * observes, it does not extend a lane's lifetime.
 *
 * Progress notifications stay out of the transcript on purpose (`lane-events.ts`): at roughly one
 * update per lane per 15s they would bury the session. Completion and needs-input do display, so the
 * outcome is never silent — only the intermediate noise is.
 *
 * Terminal only, for the same reason as `/ps`: Web and Desktop already draw lane state in their
 * inspector, and `notify` is a no-op there.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "../core/extensions/types.ts";
import type { StepSubagentResultRecord } from "./step-subagent.ts";
import { SUBAGENT_LANE_CHANNEL, type SubagentLaneSnapshot } from "./subagent/lane-events.ts";

/** Agents listed before the list is folded. */
const MAX_LISTED = 16;

/** First line only, bounded: a preview identifies the step, it does not reproduce it. */
function oneLine(text: string | undefined, limit = 100): string | undefined {
	const first = text?.trim().split("\n")[0]?.trim();
	if (!first) return undefined;
	return first.length > limit ? `${first.slice(0, limit - 3)}...` : first;
}

function elapsedOf(record: StepSubagentResultRecord, now: number): string {
	const startedAt = record.startedAt;
	if (!startedAt) return "";
	// A finished task stops counting: `now - startedAt` kept growing for a task that completed a
	// minute ago, so a settled row read as still running.
	const end = record.status === "running" ? now : (record.updatedAt ?? now);
	const seconds = Math.max(0, Math.floor((end - startedAt) / 1000));
	const minutes = Math.floor(seconds / 60);
	if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
	return `${seconds}s`;
}

/**
 * The step a child is on, in the terms the user thinks in: the tool it called, or what it is
 * writing while it reasons. Falls back to the reply text, so a child streaming an answer does not
 * read as idle.
 */
function activityOf(record: StepSubagentResultRecord): string | undefined {
	if (record.activeTool) {
		const args = oneLine(record.activeToolArgs, 60);
		return args ? `${record.activeTool} ${args}` : record.activeTool;
	}
	// `activeThinking` is present on builds that project a separate reasoning stream; read it
	// optionally so this stays correct either way.
	const thinking = (record as { activeThinking?: string }).activeThinking;
	if (thinking) return `thinking: ${oneLine(thinking, 80) ?? ""}`;
	if (record.activeText) return `writing: ${oneLine(record.activeText, 80) ?? ""}`;
	return undefined;
}

function statusMark(status: StepSubagentResultRecord["status"]): string {
	switch (status) {
		case "running":
			return "~";
		case "completed":
			return "\u2713";
		case "queued":
			return "\u00b7";
		case "skipped":
			return "-";
		default:
			return "x";
	}
}

function formatLane(snapshot: SubagentLaneSnapshot, now: number): string[] {
	const records = snapshot.details.results;
	const running = records.filter((record) => record.status === "running").length;
	// `skipped` is a chain step that never ran because an earlier one did not complete — a normal
	// ending, not a failure. Counting it as failed made a settled chain read as broken.
	const failed = records.filter((record) => record.status === "failed" || record.status === "aborted").length;
	const total = records.length + (snapshot.details.omittedResults ?? 0);
	const summary = [`${total} task${total === 1 ? "" : "s"}`];
	if (running > 0) summary.push(`${running} running`);
	if (failed > 0) summary.push(`${failed} failed`);

	// A lane that just launched has no roster yet; say so rather than printing a bare heading.
	const lines = [`  \u2022 ${snapshot.laneId} \u00b7 ${records.length === 0 ? "starting" : summary.join(", ")}`];
	const shown = records.slice(0, MAX_LISTED);
	for (const record of shown) {
		const activity = activityOf(record);
		const meta = [record.status, elapsedOf(record, now)].filter(Boolean).join(" \u00b7 ");
		lines.push(`    ${statusMark(record.status)} ${record.agent} \u2014 ${oneLine(record.task, 70) ?? "(no task)"}`);
		lines.push(`      ${meta}${activity ? ` \u2014 ${activity}` : ""}`);
	}
	const omitted = total - shown.length;
	if (omitted > 0) lines.push(`    ... and ${omitted} more`);
	return lines;
}

function formatList(snapshots: readonly SubagentLaneSnapshot[], now: number): string {
	const running = snapshots.filter((snapshot) => snapshot.status === "running");
	if (running.length === 0) {
		return "Subagents running\n\n  No subagents running.";
	}
	const lines = ["Subagents running", ""];
	for (const snapshot of running) lines.push(...formatLane(snapshot, now));
	return lines.join("\n");
}

export function createStepSubagentsCommandExtension(): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI): void => {
		// Latest snapshot per lane, so a lane that finished drops out of the live list. Registered
		// once per extension generation: a replaced session drops the old subscription with its
		// runner, and re-registering on the bus would leak one handler per reload.
		const lanes = new Map<string, SubagentLaneSnapshot>();
		// `events` is required by the type but absent on some embedders, and a throw here discards
		// the whole capabilities extension — taking `/ps`, plan, tasks and subagent with it.
		pi.events?.on?.(SUBAGENT_LANE_CHANNEL, (payload: unknown) => {
			const snapshot = payload as SubagentLaneSnapshot | undefined;
			if (!snapshot || typeof snapshot.laneId !== "string" || !snapshot.details) return;
			// Keep only live lanes: the map is never evicted elsewhere, and a finished lane's snapshot
			// (up to 48KB) would stay for the life of the session.
			if (snapshot.status === "running") lanes.set(snapshot.laneId, snapshot);
			else lanes.delete(snapshot.laneId);
		});

		pi.registerCommand("subagents", {
			description: "Show what this session's background subagents are doing",
			handler: async (args: string, ctx: ExtensionCommandContext) => {
				if (ctx.mode !== "tui") {
					ctx.ui.notify(
						"`/subagents` is a terminal command; this host shows subagents in its own interface.",
						"warning",
					);
					return;
				}
				const tokens = args.trim().split(/\s+/u).filter(Boolean);
				if (tokens.length > 0 && tokens[0] !== "list") {
					ctx.ui.notify("Usage: /subagents [list]", "warning");
					return;
				}
				ctx.ui.notify(formatList([...lanes.values()], Date.now()), "info");
			},
		});
	};
}
