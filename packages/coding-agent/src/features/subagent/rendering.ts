/**
 * TUI rendering for the subagent tool: status icons, collapsed/expanded result
 * records, the aggregate tool-result component, and background-lane widget
 * lines. Tool registration and the child runner stay in step-subagent.ts.
 */

import type { AgentToolResult } from "@step-harness/agent-core";
import type { Component } from "@step-harness/pi-tui";
import { Container, Markdown, Spacer, Text, truncateToWidth, visibleWidth } from "@step-harness/pi-tui";
import type { MessageRenderOptions, ToolRenderResultOptions } from "../../core/extensions/types.ts";
import type { CustomMessage } from "../../core/messages.ts";
import type { Theme } from "../../theme/theme.ts";
import { getMarkdownTheme } from "../../theme/theme.ts";
import {
	finalOutput,
	resultText,
	type StepSubagentDetails,
	type StepSubagentResultRecord,
	type StepSubagentUsage,
} from "../step-subagent.ts";
import { type AgentNotificationDetails, truncateText } from "./lane-events.ts";

const COLLAPSED_OUTPUT_LINES = 8;
/** Rows the live widget will show before collapsing the rest into a counter. */
const WIDGET_MAX_ROWS = 8;
/**
 * Fixed width for the trailing "<elapsed> · ↓ <tokens> tokens" column.
 *
 * Sizing it to the widest value actually present made the column jump between
 * renders and between rows, so it is pinned instead: 6 columns of elapsed, the
 * 3-column separator, 8 for "↓ 999.9k", and 7 for the " tokens" unit.
 */
const WIDGET_METRIC_WIDTH = 24;

function formatUsage(usage: StepSubagentUsage, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
	if (usage.input) parts.push(`in:${usage.input}`);
	if (usage.output) parts.push(`out:${usage.output}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatElapsed(record: StepSubagentResultRecord): string {
	const started = record.startedAt;
	if (!started) return "";
	const end = record.status === "running" ? Date.now() : (record.updatedAt ?? Date.now());
	const seconds = Math.max(0, Math.floor((end - started) / 1000));
	return `${seconds}s`;
}

function statusIcon(status: StepSubagentResultRecord["status"], theme: Theme): string {
	if (status === "running") return theme.fg("warning", "~");
	if (status === "completed") return theme.fg("success", "\u2713");
	if (status === "queued") return theme.fg("dim", "\u00b7");
	if (status === "skipped") return theme.fg("dim", "-");
	return theme.fg("error", "x");
}

function chainHeading(records: readonly StepSubagentResultRecord[]): string {
	const index = records.findIndex(
		(record) => record.status !== "completed" && record.status !== "queued" && record.status !== "skipped",
	);
	if (index !== -1) return `${records[index].status} at step ${index + 1}/${records.length}`;
	const completed = records.filter((record) => record.status === "completed").length;
	return completed === records.length
		? `${completed}/${records.length} steps completed`
		: `queued at step ${completed + 1}/${records.length}`;
}

function renderRecordSummary(record: StepSubagentResultRecord, theme: Theme): string {
	const output =
		record.activeText ||
		finalOutput(record.messages) ||
		(record.status === "running"
			? "(running...)"
			: record.status === "queued" || record.status === "skipped"
				? `(${record.status})`
				: resultText(record));
	const lines = output.split(/\r?\n/u).filter((line) => line.trim().length > 0);
	const preview = lines.slice(-COLLAPSED_OUTPUT_LINES).join("\n");
	const omitted = Math.max(0, lines.length - COLLAPSED_OUTPUT_LINES);
	let text = `${statusIcon(record.status, theme)} ${theme.fg("accent", record.agent)} ${theme.fg("muted", `(${record.agentSource})`)} ${theme.fg("dim", formatElapsed(record))}`;
	if (record.worktreePath) text += `\n  ${theme.fg("dim", `worktree: ${record.worktreePath}`)}`;
	if (record.activeTool) {
		text += `\n  ${theme.fg("warning", `running ${record.activeTool}`)}`;
		if (record.activeToolArgs) text += ` ${theme.fg("dim", truncateText(record.activeToolArgs, 240))}`;
	}
	if (record.activeToolOutput) text += `\n  ${theme.fg("toolOutput", truncateText(record.activeToolOutput, 400))}`;
	if (preview) text += `\n${theme.fg("toolOutput", preview)}`;
	if (omitted > 0) text += `\n${theme.fg("dim", `... ${omitted} earlier lines`)}`;
	return text;
}

function renderExpandedRecord(record: StepSubagentResultRecord, theme: Theme): Container {
	const container = new Container();
	container.addChild(
		new Text(
			`${statusIcon(record.status, theme)} ${theme.bold(record.agent)} ${theme.fg("muted", `(${record.agentSource})`)}`,
			0,
			0,
		),
	);
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "Task"), 0, 0));
	container.addChild(new Text(theme.fg("dim", record.task), 0, 0));
	if (record.worktreePath) {
		container.addChild(new Text(theme.fg("muted", `Worktree: ${record.worktreePath}`), 0, 0));
		container.addChild(new Text(theme.fg("dim", `Branch: ${record.worktreeBranch ?? "detached"}`), 0, 0));
	}
	container.addChild(new Spacer(1));
	const output = record.activeText || finalOutput(record.messages) || resultText(record);
	container.addChild(new Text(theme.fg("muted", "Output"), 0, 0));
	if (output) container.addChild(new Markdown(truncateText(output, 50_000), 0, 0, getMarkdownTheme()));
	if (record.errorMessage) container.addChild(new Text(theme.fg("error", `Error: ${record.errorMessage}`), 0, 0));
	const usage = formatUsage(record.usage, record.model);
	if (usage) container.addChild(new Text(theme.fg("dim", usage), 0, 0));
	if (record.activeTool) {
		container.addChild(new Spacer(1));
		container.addChild(
			new Text(
				theme.fg("warning", `Running ${record.activeTool}`) +
					(record.activeToolArgs ? ` ${theme.fg("dim", truncateText(record.activeToolArgs, 1000))}` : ""),
				0,
				0,
			),
		);
	}
	return container;
}

/** Compact token count for the widget's right-hand column: 201700 -> "201.7k". */
function formatTokenCount(value: number): string {
	if (value < 1000) return String(value);
	if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}

/**
 * Flatten to one line and fit it to `width` **display columns**.
 *
 * Measured with visibleWidth rather than String#length: CJK glyphs occupy two
 * columns each, so a length-based fit let a Chinese title overflow its cell,
 * push the row past the viewport, and lose the metric column to the row's own
 * final clamp. Iterating code points also keeps surrogate pairs intact.
 *
 * Deliberately not `truncateText`, which appends a "[output truncated]" marker
 * on its own line — fine for a tool body, fatal for a single widget row.
 */
function fitLine(value: string, width: number): string {
	const flat = value.replace(/\s+/gu, " ").trim();
	if (width <= 0) return "";
	if (visibleWidth(flat) <= width) return flat;
	if (width === 1) return "\u2026";
	// Walked by hand rather than via truncateToWidth: that helper wraps its
	// ellipsis in ANSI resets, which would clear the row's color mid-title on
	// text that carries no escapes of its own.
	const kept: string[] = [];
	let used = 0;
	for (const character of Array.from(flat)) {
		const next = visibleWidth(character);
		if (used + next > width - 1) break;
		used += next;
		kept.push(character);
	}
	return `${kept.join("")}\u2026`;
}

/**
 * Everything `render` draws except the clock, as one comparable string.
 *
 * The widget is republished on every child event, text deltas included, and a
 * publish costs the host a widget teardown plus a full redraw. Row titles are
 * now fixed, so a delta can only move the token column; when this signature is
 * unchanged there is nothing new to draw and the caller skips the publish.
 * Elapsed keeps advancing either way — render() reads the clock, and the
 * working indicator already redraws.
 */
export function subagentListSignature(details: StepSubagentDetails): string {
	const rows = details.results
		.slice(0, WIDGET_MAX_ROWS)
		.map((record) => [record.status, record.agent, record.task, record.usage.output].join("\u0000"));
	return [details.results.length, ...rows].join("\u0001");
}

/**
 * Live list of a blocking subagent call's lanes, rendered under the editor.
 *
 * Each row is stable for the lane's lifetime apart from its status icon and
 * metrics: the title is the task, not the child's live activity.
 *
 * Elapsed is computed in render() rather than stored, so the column advances on
 * the redraws the working indicator already triggers; no timer is needed. The
 * instance is reused across updates (see the widget wiring in
 * step-subagent.ts), so it deliberately exposes no `dispose`.
 */
export class SubagentListWidget implements Component {
	private details: StepSubagentDetails;
	private readonly theme: Theme;
	private readonly title: string;

	constructor(details: StepSubagentDetails, theme: Theme, title = "subagent") {
		this.details = details;
		this.theme = theme;
		this.title = title;
	}

	setDetails(details: StepSubagentDetails): void {
		this.details = details;
	}

	invalidate(): void {
		// Nothing is cached: every render recomputes from `details` and the clock.
	}

	render(width: number): string[] {
		const records = this.details.results;
		if (records.length === 0) return [];
		const theme = this.theme;
		const running = records.filter((record) => record.status === "running").length;
		const completed = records.filter((record) => record.status === "completed").length;
		const queued = records.filter((record) => record.status === "queued").length;
		const skipped = records.filter((record) => record.status === "skipped").length;
		const failed = records.length - running - completed - queued - skipped;
		const summary = [`${completed}/${records.length} complete`];
		if (running > 0) summary.push(`${running} running`);
		if (queued > 0) summary.push(`${queued} queued`);
		if (failed > 0) summary.push(`${failed} failed`);
		if (skipped > 0) summary.push(`${skipped} skipped`);
		const header = ` ${theme.fg("toolTitle", theme.bold(this.title))} ${theme.fg("accent", summary.join(", "))}`;
		const lines = [visibleWidth(header) > width ? truncateToWidth(header, width, "\u2026") : header];

		// Right column is sized across all shown rows so the metrics line up.
		const shown = records.slice(0, WIDGET_MAX_ROWS);
		const metrics = shown.map((record) => {
			// Tokens are a liveness readout for a lane still producing output; once
			// it settles the row keeps only its final elapsed, so finished rows read
			// as done at a glance instead of as one more counter.
			const tokens = record.status === "running" ? record.usage.output : 0;
			// Same shape as the working indicator's "· ↓ 1.2k tokens", so the two
			// token readouts on screen read as one unit.
			return `${formatElapsed(record)}${tokens > 0 ? ` \u00b7 \u2193 ${formatTokenCount(tokens)} tokens` : ""}`;
		});
		const metricWidth = WIDGET_METRIC_WIDTH;
		const names = shown.map((record) => record.agent);
		const nameWidth = Math.max(0, ...names.map((name) => visibleWidth(name)));

		for (const [index, record] of shown.entries()) {
			const metric = metrics[index];
			const name = names[index] + " ".repeat(Math.max(0, nameWidth - visibleWidth(names[index])));
			// 3 leading spaces + icon + space + name + space ... metric + 1 trailing.
			const fixed = 3 + 1 + 1 + nameWidth + 1 + metricWidth + 1;
			// Never widen past the viewport: a terminal too narrow for a title drops
			// it, and the final guard clips a row that still cannot fit.
			//
			// The title is the lane's task and nothing else. It used to prefer the
			// child's live tool call, then its streamed text, which rewrote every
			// row on every delta: the column churned too fast to read and each
			// change dragged the host through another republish and redraw.
			const title = fitLine(record.task, width - fixed);
			const gap = Math.max(1, width - fixed - visibleWidth(title) + 1);
			const row = `   ${statusIcon(record.status, theme)} ${theme.fg("accent", name)} ${theme.fg("toolOutput", title)}${" ".repeat(gap)}${theme.fg("dim", metric.padStart(metricWidth))}`;
			lines.push(visibleWidth(row) > width ? truncateToWidth(row, width, "\u2026") : row);
		}
		if (records.length > shown.length) {
			lines.push(`   ${theme.fg("dim", `... ${records.length - shown.length} more`)}`);
		}
		return lines;
	}
}

export function renderSubagentResult(
	result: AgentToolResult<StepSubagentDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
): Component {
	const details = result.details;
	if (!details || details.results.length === 0) {
		const text = result.content.find((block) => block.type === "text");
		return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
	}
	const running = details.results.filter((record) => record.status === "running").length;
	const queued = details.results.filter((record) => record.status === "queued").length;
	const completed = details.results.filter((record) => record.status === "completed").length;
	const heading =
		details.mode === "parallel"
			? `${completed}/${details.results.length} complete${running > 0 ? `, ${running} running` : ""}${queued > 0 ? `, ${queued} queued` : ""}`
			: details.mode === "chain"
				? chainHeading(details.results)
				: (details.results[0]?.status ?? "done");
	if (options.expanded) {
		const container = new Container();
		container.addChild(new Text(`${theme.bold("agent")} ${theme.fg("accent", heading)}`, 0, 0));
		for (const record of details.results) {
			container.addChild(new Spacer(1));
			container.addChild(renderExpandedRecord(record, theme));
		}
		return container;
	}
	let text = `${theme.bold("agent")} ${theme.fg("accent", heading)}`;
	for (const record of details.results) text += `\n\n${renderRecordSummary(record, theme)}`;
	if (running === 0) text += `\n${theme.fg("dim", "(Ctrl+O to expand)")}`;
	return new Text(text, 0, 0);
}

const NOTIFICATION_PREVIEW_LINES = 3;

const NOTIFICATION_STYLE: Record<
	AgentNotificationDetails["event"],
	{ icon: string; color: "success" | "error" | "warning" | "dim"; verb: string }
> = {
	background_done: { icon: "\u2713", color: "success", verb: "finished" },
	background_failed: { icon: "x", color: "error", verb: "failed" },
	background_interrupted: { icon: "x", color: "warning", verb: "interrupted" },
	background_needs_input: { icon: "?", color: "warning", verb: "needs input" },
	background_progress: { icon: "~", color: "dim", verb: "progress" },
	background_restarted: { icon: "~", color: "warning", verb: "restarted its child process" },
};

/**
 * Transcript entry for an `<agent-notification>` message: one status line plus
 * a short preview of the detail, instead of the raw pseudo-XML the parent model
 * reads. Returns undefined for messages without structured details (sessions
 * recorded before they were added), which keeps the host's default rendering.
 */
export function renderAgentNotification(
	message: CustomMessage<AgentNotificationDetails>,
	options: MessageRenderOptions,
	theme: Theme,
): Component | undefined {
	const details = message.details;
	const style = details?.event ? NOTIFICATION_STYLE[details.event] : undefined;
	if (!details || !style) return undefined;
	const label = details.label ?? details.agentId;
	const agents = details.agents?.length ? ` ${theme.fg("muted", `(${details.agents.join(", ")})`)}` : "";
	let text = `${theme.fg(style.color, style.icon)} ${theme.fg("toolTitle", theme.bold("background agent"))} ${theme.fg("accent", label)}${agents} ${theme.fg(style.color, style.verb)}`;
	const lines = (details.detail ?? "").split(/\r?\n/u).filter((line) => line.trim().length > 0);
	const shown = options.expanded ? lines : lines.slice(0, NOTIFICATION_PREVIEW_LINES);
	for (const line of shown) {
		text += `\n  ${theme.fg("dim", options.expanded ? line : truncateText(line, 200).split("\n")[0])}`;
	}
	if (shown.length < lines.length) {
		text += `\n  ${theme.fg("dim", `... ${lines.length - shown.length} more lines (Ctrl+O to expand)`)}`;
	}
	return new Text(text, options.outputPad, 0);
}
