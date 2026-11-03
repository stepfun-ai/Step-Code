/**
 * Background-lane notification events: builds and steers `<agent-notification>`
 * messages (final/progress/needs-input) from a lane into the parent session.
 */

import { createHash } from "node:crypto";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { retainToolOutputText } from "../../core/tools/tool-output.ts";
import { truncateHead, truncateTail } from "../../core/tools/truncate.ts";
import type { BackgroundAgentLane, StepSubagentResultRecord } from "../step-subagent.ts";
import { isRecordValue, totalResults } from "./helpers.ts";
import { liveRoster } from "./projection.ts";

/** Live-only channel; it never steers the model or appends progress to its transcript. */
export const SUBAGENT_LANE_CHANNEL = "step:subagent-lane";
export const SUBAGENT_RESPONSE_ENTRY = "step-subagent-response";

export interface CompletedSubagentResponse {
	laneId: string;
	agent: string;
	task: string;
	taskIndex: number;
	sessionId: string;
	timestamp: number;
	/** Complete text, or a retained-output preview and path. */
	output: string;
	/** Hash of the unabridged, trimmed answer, including when output is a retention preview. */
	outputHash?: string;
}

export interface SubagentLaneSnapshot {
	laneId: string;
	status: BackgroundAgentLane["status"];
	details: BackgroundAgentLane["details"];
}

const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "cost", "contextTokens", "turns"];
const LIVE_STRING_FIELDS = [
	"model",
	"stopReason",
	"errorMessage",
	"activeText",
	"activeTool",
	"activeToolArgs",
	"activeToolOutput",
	"lastEvent",
	"worktreePath",
	"worktreeBranch",
	"sessionId",
	"sessionFile",
];
const nonnegativeNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;

function validLaneSnapshot(value: unknown): value is SubagentLaneSnapshot {
	if (
		!isRecordValue(value) ||
		typeof value.laneId !== "string" ||
		!value.laneId ||
		value.laneId.length > 200 ||
		typeof value.status !== "string" ||
		!["running", "completed", "failed", "aborted"].includes(value.status)
	)
		return false;
	const details = value.details;
	if (
		!isRecordValue(details) ||
		details.agentId !== value.laneId ||
		(details.status !== undefined && details.status !== value.status) ||
		typeof details.mode !== "string" ||
		!["single", "parallel", "chain"].includes(details.mode) ||
		typeof details.agentScope !== "string" ||
		!["user", "project", "both"].includes(details.agentScope)
	)
		return false;
	if (
		typeof details.userAgentsDir !== "string" ||
		details.userAgentsDir.length > 2048 ||
		!(
			details.projectAgentsDir === null ||
			(typeof details.projectAgentsDir === "string" && details.projectAgentsDir.length <= 2048)
		)
	)
		return false;
	if (
		![details.startedAt, details.updatedAt, details.omittedResults].every(
			(field) => field === undefined || nonnegativeNumber(field),
		) ||
		(details.omittedResults !== undefined && !Number.isSafeInteger(details.omittedResults))
	)
		return false;
	return (
		Array.isArray(details.results) &&
		details.results.every((record) => {
			if (
				!isRecordValue(record) ||
				typeof record.agent !== "string" ||
				typeof record.task !== "string" ||
				typeof record.stderr !== "string" ||
				typeof record.agentSource !== "string" ||
				!["builtin", "user", "project", "unknown"].includes(record.agentSource) ||
				typeof record.status !== "string" ||
				!["queued", "running", "completed", "failed", "aborted", "skipped"].includes(record.status)
			)
				return false;
			if (
				typeof record.exitCode !== "number" ||
				!Number.isFinite(record.exitCode) ||
				!Array.isArray(record.messages) ||
				record.messages.length !== 0
			)
				return false;
			const usage = record.usage;
			if (
				!isRecordValue(usage) ||
				Object.keys(usage).some((key) => !USAGE_FIELDS.includes(key)) ||
				!USAGE_FIELDS.every((key) => nonnegativeNumber(usage[key]))
			)
				return false;
			return (
				LIVE_STRING_FIELDS.every((key) => record[key] === undefined || typeof record[key] === "string") &&
				[record.startedAt, record.updatedAt, record.step].every(
					(field) => field === undefined || nonnegativeNumber(field),
				) &&
				(record.pendingReply === undefined || typeof record.pendingReply === "boolean") &&
				(record.cancelledPrompts === undefined ||
					(Array.isArray(record.cancelledPrompts) &&
						record.cancelledPrompts.every((field) => typeof field === "string")))
			);
		})
	);
}

/** Validate and re-project the extension-bus boundary; unknown fields never reach host caches. */
export function readSubagentLaneSnapshot(value: unknown): SubagentLaneSnapshot | undefined {
	if (!validLaneSnapshot(value)) return;
	const details = value.details;
	const roster = liveRoster(details.results);
	return {
		laneId: value.laneId,
		status: value.status,
		details: {
			mode: details.mode,
			agentScope: details.agentScope,
			userAgentsDir: details.userAgentsDir,
			projectAgentsDir: details.projectAgentsDir,
			agentId: value.laneId,
			status: value.status,
			startedAt: details.startedAt,
			updatedAt: details.updatedAt,
			results: roster.results,
			omittedResults: (details.omittedResults ?? 0) + (roster.omittedResults ?? 0) || undefined,
		},
	};
}

export function publishLaneSnapshot(pi: ExtensionAPI, lane: BackgroundAgentLane): void {
	const roster = liveRoster(lane.details.results);
	const snapshot: SubagentLaneSnapshot = {
		laneId: lane.id,
		status: lane.status,
		details: {
			...lane.details,
			agentId: lane.id,
			status: lane.status,
			startedAt: lane.startedAt,
			updatedAt: lane.updatedAt,
			...roster,
			results: roster.results,
			omittedResults: (lane.details.omittedResults ?? 0) + (roster.omittedResults ?? 0) || undefined,
		},
	};
	pi.events?.emit(SUBAGENT_LANE_CHANNEL, snapshot);
}

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
export function laneTaskCounts(records: readonly StepSubagentResultRecord[], total = records.length): string {
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
	if (total > records.length) parts.push(`${total - records.length} not shown`);
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
			return `Lane ${lane.id} was stopped: ${laneTaskCounts(lane.details.results, totalResults(lane.details))}.`;
		default:
			return `Lane ${lane.id} finished: ${laneTaskCounts(lane.details.results, totalResults(lane.details))}.`;
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
				`<agent-notification lane="${escapeXmlAttr(lane.id)}" tasks="${totalResults(lane.details)}">` +
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

export function laneOutputText(lane: BackgroundAgentLane): string {
	return (
		lane.result?.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim() ?? ""
	);
}

export function completedOutputHash(output: string): string {
	return createHash("sha256").update(output.trim()).digest("hex");
}

/** A bounded recent-answer view; every omitted answer remains a durable journal fact. */
export function completedResponseLines(lane: BackgroundAgentLane, output: string, budget = 16_000): string[] {
	const hash = completedOutputHash(output);
	const responses = (lane.completedResponses ?? []).filter((response) => {
		const text = response.output.trim();
		return text && !(response.outputHash ? response.outputHash === hash : text === output.trim());
	});
	const lines: string[] = [];
	let remaining = Math.max(0, budget - 250);
	let shown = 0;
	for (let index = responses.length - 1; index >= 0 && remaining > 300; index--) {
		const response = responses[index];
		const title = `Completed response (${response.agent.slice(0, 200)}, child ${response.sessionId.slice(0, 200)}):\n`;
		if (Buffer.byteLength(title) + 100 > remaining) break;
		const body = clipAnswerView(response.output, Math.max(0, remaining - Buffer.byteLength(title) - 100)).text;
		lines.push(title + body);
		remaining -= Buffer.byteLength(title + body);
		shown++;
	}
	const omitted = responses.length - shown + (lane.completedResponsesOmitted ?? 0);
	if (omitted > 0)
		lines.unshift(
			`${omitted} earlier completed responses omitted from this view; see the parent journal and child transcripts.`,
		);
	return lines;
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
export function laneSummaryLines(lane: BackgroundAgentLane, now = Date.now(), complete = false): string[] {
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
	return complete ? lines : [clipLaneView(lines.join("\n\n"), 6_000).text];
}

function clipLaneView(text: string, maxBytes: number): { text: string; clipped: boolean } {
	const result = truncateHead(text, { maxBytes, maxLines: 128 });
	return {
		text:
			result.content +
			(result.truncated ? `\n[${result.totalLines - result.outputLines} lines omitted from this view]` : ""),
		clipped: result.truncated,
	};
}

/** Answers keep both their introduction and conclusion; metadata uses a head-only view. */
function clipAnswerView(text: string, maxBytes: number): { text: string; clipped: boolean } {
	const whole = truncateHead(text, { maxBytes, maxLines: 1_000 });
	if (!whole.truncated) return { text, clipped: false };
	const allocation = Math.max(0, Math.floor((maxBytes - 100) / 2));
	const head = truncateHead(text, { maxBytes: allocation, maxLines: 450 });
	let first = head.content;
	if (!first && allocation > 0) {
		const bytes = Buffer.from(text);
		let end = Math.min(bytes.length, allocation);
		while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
		first = bytes.subarray(0, end).toString("utf8");
	}
	const tail = truncateTail(text, { maxBytes: allocation, maxLines: 450 });
	return { text: `${first}\n[output middle omitted from this view]\n${tail.content}`, clipped: true };
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
		.filter(({ cause }) => output.length > 8_000 || !output.includes(cause))
		.map(({ label, cause }) => `- ${label}: ${truncateText(cause, 400)}`);
}

/**
 * Body of the one terminal notification. The structured summary comes first so
 * it survives the output bound; oversized output is saved through the shared
 * tool-output retention boundary and replaced by a preview plus its path.
 */
export function laneReportView(lane: BackgroundAgentLane): { text: string; complete: string; clipped: boolean } {
	const output = laneOutputText(lane);
	const current = clipAnswerView(output, 10_000);
	const reasons = failureReasons(lane, current.text);
	const diagnosticText = [
		lane.completionError ? `Completed response retention failed: ${lane.completionError}` : "",
		reasons.length > 0 ? `Failure reasons:\n${reasons.join("\n")}` : "",
	]
		.filter(Boolean)
		.join("\n\n");
	const diagnostics = clipLaneView(diagnosticText, 4_000);
	const summary = laneSummaryLines(lane, Date.now(), true).join("\n\n");
	const metadata = clipLaneView(summary, 6_000);
	const history = clipAnswerView(completedResponseLines(lane, output).join("\n\n"), 10_000);
	const title = `Current outcome: ${lane.status}`;
	const outputTitle = lane.status === "running" ? "Output of the previous turn" : "Output";
	const text = [
		title,
		diagnostics.text,
		current.text ? `${outputTitle}:\n${current.text}` : "",
		metadata.text,
		history.text,
	]
		.filter(Boolean)
		.join("\n\n");
	const complete = [
		title,
		diagnosticText,
		output ? `${outputTitle}:\n${output}` : "",
		summary,
		...(lane.completedResponses ?? []).map(
			(response) => `Completed response (${response.agent}, child ${response.sessionId}):\n${response.output}`,
		),
		lane.completedResponsesOmitted
			? `${lane.completedResponsesOmitted} older answers remain in the parent journal and child transcripts.`
			: "",
	]
		.filter(Boolean)
		.join("\n\n");
	return { text, complete, clipped: diagnostics.clipped || current.clipped || metadata.clipped || history.clipped };
}

export async function buildLaneFinalView(
	lane: BackgroundAgentLane,
	outputDirectory: string,
): Promise<{ text: string; path?: string }> {
	const view = laneReportView(lane);
	if (!view.clipped) return { text: view.text };
	try {
		const path = await retainToolOutputText(view.complete, outputDirectory);
		return { path, text: `Retained lane diagnostics. Full output: ${JSON.stringify(path)}\n\n${view.text}` };
	} catch (error) {
		// Preserve the bounded current outcome even when its complete snapshot cannot be saved.
		return {
			text: `${view.text}\n[full output could not be saved: ${truncateText(error instanceof Error ? error.message : String(error), 800)}]`,
		};
	}
}

export async function buildLaneFinalDetail(lane: BackgroundAgentLane, outputDirectory: string): Promise<string> {
	return (await buildLaneFinalView(lane, outputDirectory)).text;
}

function laneProgressDetail(lane: BackgroundAgentLane): string {
	const records = lane.details.results;
	const active = records.find((record) => record.status === "running") ?? records.at(-1);
	const parts: string[] = [
		`step ${active ? records.indexOf(active) + 1 : 1}/${Math.max(totalResults(lane.details), 1)}`,
	];
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
