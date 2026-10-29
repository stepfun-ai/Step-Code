/**
 * Model-facing description of the subagent tool.
 *
 * The description owns how to delegate well: the lane mechanics, the agent
 * catalog, the default authorization gate, and the delegation method adapted
 * from Codex's spawn_agent guidance. Choosing between subagent and the other
 * coordination primitives stays in the system prompt, and session-standing
 * authorization arrives as an ultraloop reminder, so this text never changes
 * within a session and stays in the cached prefix.
 */

import { formatBuiltinAgentGuidance } from "../step-subagent-agents.ts";

export interface SubagentToolDescriptionOptions {
	/** Directory holding user-scope agent definitions. */
	userAgentsDir: string;
	/** Project config directory name, such as `.stepcode`. */
	configDirName: string;
}

export function buildSubagentToolDescription(options: SubagentToolDescriptionOptions): string {
	return [
		[
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			"By default the call blocks until the agents finish and returns their results.",
			"With run_in_background:true it returns a lane_id at once and later sends one <agent-notification> when the lane ends; manage the lane with agent_send.",
			formatBuiltinAgentGuidance(),
			`Default agent scope is "user" (from ${options.userAgentsDir}).`,
			`To enable project-local agents in ${options.configDirName}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		[
			"Do not spawn subagents unless the user or applicable AGENTS.md or skill instructions explicitly ask for subagents, delegation, or parallel agent work.",
			"Requests for depth, thoroughness, research, investigation, or detailed codebase analysis do not count as permission to spawn.",
			"The agent catalog and the guidance below only help you choose how to delegate once delegation is authorized; they never authorize it by themselves.",
		].join("\n"),
		[
			"### When to delegate vs. do the subtask yourself",
			"- First, quickly analyze the overall task and form a succinct high-level plan. Identify which tasks block your immediate next step on the critical path and which are sidecar tasks that can run in parallel. As part of that plan, explicitly decide what you will do locally right now, so you do not hand off the blocking task and then wait on it.",
			"- Delegate a subtask when it is easy enough for a subagent and can run in parallel with your local work. Prefer concrete, bounded sidecar tasks that materially advance the main task without blocking your next local step.",
			"- Keep work local when your very next action depends on its result, or when it is too difficult to delegate well, tightly coupled, or urgent.",
		].join("\n"),
		[
			"### Designing delegated subtasks",
			"- Subtasks must be concrete, well-defined, and self-contained. A subagent has no memory of this conversation: put every fact, path, constraint, and expected output it needs into the task text.",
			"- Delegated subtasks must materially advance the main task. Do not duplicate work between yourself and a subagent, and do not issue several calls on the same unresolved question unless the new task is genuinely different and necessary.",
			"- Narrow each ask to the concrete output you need next.",
			'- For coding tasks, prefer a bounded code-change task for "general" over read-only exploration when the write scope is clear. Subagents work in your workspace, so give each writing task a disjoint write set and ask it to list the paths it changed.',
			"- Subagents cannot spawn subagents of their own.",
		].join("\n"),
		[
			"### After you delegate",
			"- There is no wait tool. Use the foreground (the default) only when your next critical-path step needs the result. A background lane wakes you with one <agent-notification> when it ends; never sleep, poll, or call agent_send status to wait for it.",
			"- While a background lane runs, do meaningful non-overlapping work, or end your turn.",
			"- Do not redo delegated work yourself. When results return, review them, especially changed files, then integrate or refine them.",
		].join("\n"),
		[
			"### Parallel delegation patterns",
			"- Run independent information-seeking subtasks in parallel when you have distinct questions that can be answered separately.",
			"- Split implementation into disjoint codebase slices and run them in parallel when their write scopes do not overlap.",
			"- Delegate verification only when it can run alongside ongoing implementation and is likely to catch a concrete risk before integration.",
			"- Look for independent subtasks you can start together in one call, each well-defined, self-contained, and materially advancing the main task.",
		].join("\n"),
	].join("\n\n");
}
