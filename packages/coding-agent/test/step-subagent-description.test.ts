import { expect, test } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "../src/core/extensions/types.ts";
import { createStepSubagentExtension } from "../src/features/step-subagent.ts";
import { buildSubagentToolDescription } from "../src/features/subagent/tool-description.ts";

const options = { userAgentsDir: "/home/user/.stepcode/agent/agents", configDirName: ".stepcode" };

test("the description gates spawning on an explicit request before any method", () => {
	const description = buildSubagentToolDescription(options);
	const gate =
		"Do not spawn subagents unless the user or applicable AGENTS.md or skill instructions explicitly ask for subagents, delegation, or parallel agent work.";
	expect(description).toContain(gate);
	expect(description).toContain(
		"Requests for depth, thoroughness, research, investigation, or detailed codebase analysis do not count as permission to spawn.",
	);
	expect(description).toContain("they never authorize it by themselves");
	expect(description.indexOf(gate)).toBeLessThan(description.indexOf("### When to delegate"));
});

test("the description carries the four delegation sections in order", () => {
	const description = buildSubagentToolDescription(options);
	const headings = [
		"### When to delegate vs. do the subtask yourself",
		"### Designing delegated subtasks",
		"### After you delegate",
		"### Parallel delegation patterns",
	];
	const positions = headings.map((heading) => description.indexOf(heading));
	expect(positions.every((position) => position >= 0)).toBe(true);
	expect([...positions].sort((left, right) => left - right)).toEqual(positions);
});

test("the description states Step's lane facts and never names Codex-only tools", () => {
	const description = buildSubagentToolDescription(options);
	expect(description).toContain("Built-in agents, by exact name:");
	expect(description).toContain(`Default agent scope is "user" (from ${options.userAgentsDir}).`);
	expect(description).toContain('To enable project-local agents in .stepcode/agents, set agentScope: "both"');
	expect(description).toContain("<agent-notification>");
	expect(description).toContain("There is no wait tool.");
	expect(description).toContain("no memory of this conversation");
	expect(description).toContain("disjoint write set");
	expect(description).toContain("Subagents cannot spawn subagents of their own.");
	for (const missing of ["wait_agent", "resume_agent", "close_agent", "send_input", "fork_context", "spawn_agent"]) {
		expect(description).not.toContain(missing);
	}
});

test("the registered subagent tool uses the shared description", () => {
	const tools = new Map<string, ToolDefinition>();
	const api = {
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		registerMessageRenderer: () => {},
		on: () => {},
	} as unknown as ExtensionAPI;
	createStepSubagentExtension({ agentDir: "/tmp/step-agent-test", configDirName: ".stepcode" })(api);
	expect(tools.get("subagent")?.description).toBe(
		buildSubagentToolDescription({ userAgentsDir: "/tmp/step-agent-test/agents", configDirName: ".stepcode" }),
	);
});
