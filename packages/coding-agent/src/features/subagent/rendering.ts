/**
 * TUI rendering for the subagent tool: status icons, collapsed/expanded result
 * records, the aggregate tool-result component, and background-lane widget
 * lines. Tool registration and the child runner stay in step-subagent.ts.
 */

import type { AgentToolResult } from "@step-harness/agent-core";
import type { Component } from "@step-harness/pi-tui";
import { Container, Markdown, Spacer, Text, truncateToWidth, visibleWidth } from "@step-harness/pi-tui";
import type { ToolRenderResultOptions } from "../../core/extensions/types.ts";
import type { Theme } from "../../theme/theme.ts";
import { getMarkdownTheme } from "../../theme/theme.ts";
import {
	finalOutput,
	resultText,
	type StepSubagentDetails,
	type StepSubagentResultRecord,
	type StepSubagentUsage,
} from "../step-subagent.ts";
import { truncateText } from "./lane-events.ts";
import type { BackgroundAgentLane } from "./lane-lifecycle.ts";

const COLLAPSED_OUTPUT_LINES = 8;
/** Rows the live widget will show before collapsing the rest into a counter. */
const WIDGET_MAX_ROWS = 8;
/**
 * Fixed width for the trailing "<elapsed> · <tokens>" column.
 *
 * Sizing it to the widest value actually present made the column jump between
 * renders and between rows, so it is pinned instead: 6 columns of elapsed, the
 * 3-column separator, and 7 for "↓999.9k".
 */
const WIDGET_METRIC_WIDTH = 16;

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
	return theme.fg("error", "x");
}

function renderRecordSummary(record: StepSubagentResultRecord, theme: Theme): string {
	const output =
		record.activeText ||
		finalOutput(record.messages) ||
		(record.status === "running" ? "(running...)" : resultText(record));
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
 * One row's activity text plus which end to keep when it does not fit.
 *
 * The most specific live signal wins: the tool the child is running, else its
 * streamed text, else the task it was given (all a queued record has). A tool
 * row keeps its head so the tool name stays readable; streamed text keeps its
 * tail because the newest words are the useful ones.
 */
function recordActivity(record: StepSubagentResultRecord): { text: string; bias: "head" | "tail" } {
	if (record.activeTool) {
		const args = record.activeToolArgs ? ` ${record.activeToolArgs}` : "";
		return { text: `${record.activeTool}:${args}`.trimEnd(), bias: "head" };
	}
	// While a lane runs, its newest words are the status; once it settles the same
	// field holds a conclusion, which reads from the front.
	if (record.activeText?.trim()) {
		return { text: record.activeText, bias: record.status === "running" ? "tail" : "head" };
	}
	if (record.status !== "running" && record.errorMessage) return { text: record.errorMessage, bias: "head" };
	return { text: record.task, bias: "head" };
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
function fitLine(value: string, width: number, bias: "head" | "tail"): string {
	const flat = value.replace(/\s+/gu, " ").trim();
	if (width <= 0) return "";
	if (visibleWidth(flat) <= width) return flat;
	if (width === 1) return "\u2026";
	// Walked by hand rather than via truncateToWidth: that helper wraps its
	// ellipsis in ANSI resets, which would clear the row's color mid-title on
	// text that carries no escapes of its own.
	const characters = Array.from(flat);
	const kept: string[] = [];
	let used = 0;
	if (bias === "head") {
		for (const character of characters) {
			const next = visibleWidth(character);
			if (used + next > width - 1) break;
			used += next;
			kept.push(character);
		}
		return `${kept.join("")}\u2026`;
	}
	for (let index = characters.length - 1; index >= 0; index -= 1) {
		const next = visibleWidth(characters[index]);
		if (used + next > width - 1) break;
		used += next;
		kept.push(characters[index]);
	}
	return `\u2026${kept.reverse().join("")}`;
}

/**
 * Live list of a blocking subagent call's lanes, rendered under the editor.
 *
 * Elapsed is computed in render() rather than stored, so the column advances on
 * the redraws the working indicator already triggers; no timer is needed. The
 * instance is reused across updates (see the widget wiring in
 * step-subagent.ts), so it deliberately exposes no `dispose`.
 */
export class SubagentListWidget implements Component {
	private details: StepSubagentDetails;
	private readonly theme: Theme;

	constructor(details: StepSubagentDetails, theme: Theme) {
		this.details = details;
		this.theme = theme;
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
		const failed = records.length - running - completed;
		const summary = [`${completed}/${records.length} complete`];
		if (running > 0) summary.push(`${running} running`);
		if (failed > 0) summary.push(`${failed} failed`);
		const header = ` ${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", summary.join(", "))}`;
		const lines = [visibleWidth(header) > width ? truncateToWidth(header, width, "\u2026") : header];

		// Right column is sized across all shown rows so the metrics line up.
		const shown = records.slice(0, WIDGET_MAX_ROWS);
		const metrics = shown.map((record) => {
			const tokens = record.usage.output;
			return `${formatElapsed(record)}${tokens > 0 ? ` \u00b7 \u2193${formatTokenCount(tokens)}` : ""}`;
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
			const activity = recordActivity(record);
			const title = fitLine(activity.text, width - fixed, activity.bias);
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
	const completed = details.results.filter((record) => record.status === "completed").length;
	const heading =
		details.mode === "parallel"
			? `${completed}/${details.results.length} complete${running > 0 ? `, ${running} running` : ""}`
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

export function laneWidgetLines(lane: BackgroundAgentLane): string[] {
	const records = lane.details.results;
	const lines = [
		`agent ${lane.id} ${lane.status}`,
		...records.map((record) => {
			const live = record.activeTool
				? ` | ${record.activeTool}`
				: record.activeText
					? ` | ${record.activeText.split(/\r?\n/u).at(-1)?.slice(0, 100) ?? ""}`
					: "";
			return `${statusIcon(record.status, themeForWidget)} ${record.agent}${live}`;
		}),
	];
	return lines;
}

// Widgets receive the same color callback shape as the native renderer. Keep
// this tiny fallback local so background lanes can also be shown in test hosts.
const themeForWidget = {
	fg: (_color: string, text: string): string => text,
} as unknown as Theme;
