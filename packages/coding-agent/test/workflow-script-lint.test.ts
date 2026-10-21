import { expect, test } from "vitest";
import { NO_AGENTS_WARNING, workflowToolResult } from "../src/features/workflow/runtime.ts";
import { assertWorkflowScriptUsage, findMultiArgumentPhaseCall } from "../src/features/workflow/script-lint.ts";
import type { WorkflowRunResult } from "../src/features/workflow/types.ts";

test("flags phase() calls that pass a callback or a second argument", () => {
	expect(findMultiArgumentPhaseCall(`phase("Review", async () => { await agent("x"); });`)).toBe(1);
	expect(findMultiArgumentPhaseCall(`log("a");\n\nawait phase ( "Build" , () => 1 );`)).toBe(3);
	expect(findMultiArgumentPhaseCall(`phase(\`Round \${i}\`, fn)`)).toBe(1);
	expect(() => assertWorkflowScriptUsage(`phase("a", () => {})`)).toThrow(/line 1: phase\(title\) takes one string/);
});

test("accepts single-argument phase() and lookalikes", () => {
	const valid = [
		`phase("Review");\nawait agent("review", { label: "r" });`,
		`phase(names.join(", "));`,
		`phase(fmt("a", "b"));`,
		`phase([a, b].join("/"));`,
		`phase(\`Round \${f(a, b)}\`);`,
		`phase("trailing",);`,
		`// phase("a", b)\n/* phase("a", b) */\nconst s = 'phase("a", b)';`,
		`const t = \`phase("a", \${b})\`;`,
		`obj.phase("a", b); tracker.phase(1, 2);`,
		`function phase(a, b) {}`,
		`const o = { phase(a, b) { return a; } };`,
		`const myphase = (a, b) => a; myphase("a", 1); phases("a", 1);`,
	];
	for (const script of valid) expect(findMultiArgumentPhaseCall(script), script).toBeUndefined();
});

function runResult(overrides: Partial<WorkflowRunResult>): WorkflowRunResult {
	return {
		schemaVersion: 1,
		runId: "r",
		name: "inline",
		status: "completed",
		value: null,
		meta: null,
		startedAt: 0,
		finishedAt: 0,
		spentTokens: 0,
		cacheHits: 0,
		agentCalls: 0,
		phases: [],
		...overrides,
	} as WorkflowRunResult;
}

test("a completed run with no agent calls leads with a warning", () => {
	const text = (result: WorkflowRunResult) => {
		const block = workflowToolResult(result).content[0];
		return block?.type === "text" ? block.text : "";
	};
	expect(text(runResult({}))).toMatch(
		new RegExp(`^${NO_AGENTS_WARNING.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\n\\{`),
	);
	expect(workflowToolResult(runResult({})).isError).toBe(false);
	expect(text(runResult({ agentCalls: 1 }))).not.toContain(NO_AGENTS_WARNING);
	expect(text(runResult({ status: "failed" }))).not.toContain(NO_AGENTS_WARNING);
});
