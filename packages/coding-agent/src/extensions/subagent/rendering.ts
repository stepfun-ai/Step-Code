/**
 * TUI rendering for the subagent tool: status icons, collapsed/expanded result
 * records, the aggregate tool-result component, and background-lane widget
 * lines. Tool registration and the child runner stay in step-subagent.ts.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Component } from "@earendil-works/pi-tui";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
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
	if (status === "completed") return theme.fg("success", "+");
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
