import type { AgentToolResult } from "@step-harness/agent-core";
import { type Component, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@step-harness/pi-tui";
import type { ToolRenderContext, ToolRenderResultOptions } from "../../core/extensions/types.ts";
import { keyHint } from "../../render/keybinding-hints.ts";
import type { Theme } from "../../theme/theme.ts";
import type { WorkflowRequest } from "./step-workflow.ts";
import type { WorkflowProgress, WorkflowProgressAgent, WorkflowRunResult } from "./types.ts";

const COLLAPSED_AGENTS = 8;
const AGENT_ORDER: Record<WorkflowProgressAgent["status"], number> = {
	running: 0,
	queued: 1,
	failed: 2,
	aborted: 3,
	completed: 4,
	cached: 4,
};

export interface WorkflowRenderState {
	/** Keep the last live snapshot when the final tool result replaces the update. */
	progress?: WorkflowProgress;
}

function singleLine(text: string): string {
	return stripTerminalSequences(text).replace(/\s+/gu, " ").trim();
}

function progressSummary(progress: WorkflowProgress): string {
	const counts = { running: 0, queued: 0, completed: 0, failed: 0, aborted: 0, cached: 0 };
	for (const agent of progress.agents) counts[agent.status] += 1;
	return [
		progress.status.replace(/_/gu, " "),
		`${counts.running} running`,
		`${counts.queued} queued`,
		`${progress.completedAgents}/${progress.totalAgents} completed`,
		...(counts.cached ? [`${counts.cached} cached`] : []),
		...(counts.failed ? [`${counts.failed} failed`] : []),
		...(counts.aborted ? [`${counts.aborted} aborted`] : []),
		`${progress.spentTokens} tokens`,
	].join(" · ");
}

function visibleAgents(progress: WorkflowProgress, expanded: boolean): WorkflowProgressAgent[] {
	const ordered = [...progress.agents].sort((left, right) => AGENT_ORDER[left.status] - AGENT_ORDER[right.status]);
	// Show every running task (bounded by the runtime's concurrency limit).
	// Queued and settled tasks share the remaining collapsed preview slots.
	const running = progress.agents.filter((agent) => agent.status === "running").length;
	return expanded ? ordered : ordered.slice(0, Math.max(COLLAPSED_AGENTS, running));
}

function agentSummary(agent: WorkflowProgressAgent): string {
	const label = singleLine(agent.label);
	const task = agent.task ? singleLine(agent.task) : "";
	return `${agent.status} ${label}${task && task !== label ? `: ${task}` : ""}`;
}

/** Text remains useful to RPC/headless consumers; details carry the complete snapshot. */
export function workflowProgressResult(progress: WorkflowProgress): AgentToolResult<WorkflowProgress> {
	const agents = visibleAgents(progress, false);
	const hidden = progress.agents.length - agents.length;
	return {
		content: [
			{
				type: "text",
				text: [
					progressSummary(progress),
					...(progress.currentPhase ? [`Phase: ${singleLine(progress.currentPhase)}`] : []),
					...agents.map(agentSummary),
					...(hidden ? [`${hidden} more agents`] : []),
				].join("\n"),
			},
		],
		details: progress,
	};
}

export function renderWorkflowCall(args: WorkflowRequest, theme: Theme): Component {
	const source = singleLine(args.name || args.scriptPath || "inline");
	const title = `${theme.fg("toolTitle", theme.bold("workflow"))} ${theme.fg("muted", `(${source})`)}`;
	return {
		render: (width) => [truncateToWidth(title, Math.max(1, width - 2))],
		invalidate: () => {},
	};
}

export function renderWorkflowResult(
	result: AgentToolResult<WorkflowProgress | WorkflowRunResult>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext<WorkflowRenderState>,
): Component {
	const details = result.details;
	if (details && "agents" in details) context.state.progress = details;
	const progress = context.state.progress;
	const completed = details && "agentCalls" in details ? details : undefined;
	return {
		render: (width) => {
			const bodyWidth = Math.max(1, width - 4);
			const rows: string[] = [];
			let expandable = false;
			if (progress) {
				const color =
					progress.status === "running" ? "accent" : progress.status === "completed" ? "success" : "error";
				rows.push(...wrapTextWithAnsi(theme.fg(color, progressSummary(progress)), bodyWidth));
				if (progress.currentPhase) {
					rows.push(
						...wrapTextWithAnsi(theme.fg("muted", `Phase: ${singleLine(progress.currentPhase)}`), bodyWidth),
					);
				}
				const agents = visibleAgents(progress, options.expanded);
				for (const agent of agents) {
					const color = agent.status === "running" ? "accent" : agent.status === "failed" ? "error" : "muted";
					const text = theme.fg(color, agentSummary(agent));
					rows.push(
						...(options.expanded ? wrapTextWithAnsi(text, bodyWidth) : [truncateToWidth(text, bodyWidth)]),
					);
				}
				const hidden = progress.agents.length - agents.length;
				if (hidden) rows.push(theme.fg("muted", `${hidden} more agents`));
				expandable = progress.agents.length > 0;
				if (progress.status === "running" && progress.message && progress.message !== "Workflow started") {
					rows.push(truncateToWidth(theme.fg("dim", singleLine(progress.message)), bodyWidth));
				}
			} else if (completed) {
				rows.push(
					...wrapTextWithAnsi(
						theme.fg(
							"success",
							`${completed.status} · ${completed.agentCalls} agent calls · ${completed.spentTokens} tokens`,
						),
						bodyWidth,
					),
				);
			}

			const output = completed
				? typeof completed.value === "string"
					? completed.value
					: JSON.stringify(completed.value, null, 2)
				: context.isError || !progress
					? result.content
							.filter((block) => block.type === "text")
							.map((block) => block.text)
							.join("\n")
					: undefined;
			if (output) {
				const lines = stripTerminalSequences(output).replace(/\r\n?/gu, "\n").split("\n");
				const preview = options.expanded ? lines : lines.slice(0, 3);
				for (const line of preview) {
					const text = theme.fg(context.isError ? "error" : "toolOutput", line.replace(/\t/gu, "    "));
					rows.push(
						...(options.expanded ? wrapTextWithAnsi(text, bodyWidth) : [truncateToWidth(text, bodyWidth)]),
					);
				}
				if (preview.length < lines.length)
					rows.push(theme.fg("muted", `${lines.length - preview.length} more result lines`));
				expandable = true;
			}
			if (options.expanded && completed) {
				rows.push(...wrapTextWithAnsi(theme.fg("dim", `Run: ${completed.runId}`), bodyWidth));
				if (completed.scriptPath)
					rows.push(...wrapTextWithAnsi(theme.fg("dim", `Script: ${completed.scriptPath}`), bodyWidth));
			}
			if (!options.expanded && expandable) rows.push(`(${keyHint("app.tools.expand", "to expand")})`);
			return rows.map((row, index) => truncateToWidth(`${index === 0 ? "  └ " : "    "}${row}`, Math.max(1, width)));
		},
		invalidate: () => {},
	};
}
