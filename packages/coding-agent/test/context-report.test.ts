import type { TUI } from "@step-harness/pi-tui";
import type { AssistantMessage } from "@step-harness/providers/compat";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { ToolInfo } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { formatSkillsForPrompt } from "../src/core/skills.ts";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "../src/core/system-prompt.ts";
import { ContextPanel, formatContextReportText } from "../src/render/context-panel.ts";
import {
	buildContextReport,
	type ContextReportInput,
	type ContextReportRow,
	contextMeterSegments,
	contextReportRows,
} from "../src/step/context-report.ts";
import { initTheme, theme } from "../src/theme/theme.ts";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
		api: "anthropic-messages",
		provider: "test",
		model: "test-model",
	};
}

function tool(name: string, source = "builtin"): ToolInfo {
	return {
		name,
		description: `${name} description`,
		parameters: { type: "object", properties: {} },
		sourceInfo: { path: `<${source}:${name}>`, source, scope: "temporary", origin: "top-level" },
	};
}

function fixture(): ContextReportInput {
	const systemPromptOptions: BuildSystemPromptOptions = {
		cwd: "/repo",
		selectedTools: ["read"],
		contextFiles: [{ path: "/repo/AGENTS.md", content: "a".repeat(40) }],
		skills: [
			{
				name: "alpha-skill",
				description: "Alpha skill description",
				filePath: "/repo/.step-code/skills/alpha/SKILL.md",
				baseDir: "/repo/.step-code/skills/alpha",
				sourceInfo: {
					path: "/repo/.step-code/skills/alpha/SKILL.md",
					source: "project",
					scope: "project",
					origin: "top-level",
				},
				disableModelInvocation: false,
			},
		],
	};
	return {
		systemPrompt: buildSystemPrompt(systemPromptOptions),
		systemPromptOptions,
		tools: [tool("read"), tool("docs__search", "extension")],
		mcpServerNames: ["docs"],
		messages: [
			{ role: "user", content: "u".repeat(40), timestamp: 1 },
			assistant([
				{ type: "text", text: "a".repeat(40) },
				{ type: "thinking", thinking: "t".repeat(20) },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "x" } },
			]),
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "o".repeat(80) }],
				isError: false,
				timestamp: 2,
			},
			{ role: "compactionSummary", summary: "s".repeat(40), tokensBefore: 100, timestamp: 3 },
			{ role: "custom", customType: "notice", content: "i".repeat(20), display: false, timestamp: 4 },
		],
		contextWindow: 100_000,
		reserveTokens: 1_000,
	};
}

function group(report: ReturnType<typeof buildContextReport>, id: string) {
	const result = report.groups.find((candidate) => candidate.id === id);
	if (!result) throw new Error(`Missing group ${id}`);
	return result;
}

function child(rows: ReturnType<typeof buildContextReport>["groups"], id: string): ContextReportRow | undefined {
	for (const row of rows) {
		if (row.id === id) return row;
		const found = child(row.children ?? [], id);
		if (found) return found;
	}
	return undefined;
}

beforeAll(() => {
	initTheme("dark");
});

describe("current context report", () => {
	test("separates message roles and reconciles every category with the total", () => {
		const input = fixture();
		const report = buildContextReport(input);
		const conversation = group(report, "conversation");
		const toolCalls = child(report.groups, "toolCalls")!.tokens!;
		const expectedMessages =
			(child(report.groups, "user")!.tokens ?? 0) +
			(child(report.groups, "assistant")!.tokens ?? 0) +
			(child(report.groups, "thinking")!.tokens ?? 0) +
			toolCalls +
			(child(report.groups, "toolResults")!.tokens ?? 0) +
			(child(report.groups, "compaction")!.tokens ?? 0) +
			(child(report.groups, "injected")!.tokens ?? 0);

		expect(child(report.groups, "user")!.tokens).toBe(10);
		expect(child(report.groups, "assistant")!.tokens).toBe(10);
		expect(child(report.groups, "thinking")!.tokens).toBe(5);
		expect(child(report.groups, "toolResults")!.tokens).toBe(20);
		expect(child(report.groups, "compaction")!.tokens).toBe(10);
		expect(child(report.groups, "injected")!.tokens).toBe(5);
		expect(toolCalls).toBe(4);
		expect(conversation.tokens).toBe(expectedMessages);
		expect(report.usedTokens).toBe(
			group(report, "instructions").tokens! + group(report, "tools").tokens! + conversation.tokens!,
		);
		expect(report.freeTokens).toBe(100_000 - report.usedTokens! - 1_000);
	});

	test("keeps category rounding reconciled with the session token estimator", () => {
		const messages: ContextReportInput["messages"] = [
			assistant([
				{ type: "text", text: "a" },
				{ type: "thinking", thinking: "t" },
				{ type: "toolCall", id: "odd-call", name: "r", arguments: {} },
			]),
			{
				role: "bashExecution",
				command: "x",
				output: "yy",
				cancelled: false,
				truncated: false,
				exitCode: 0,
				timestamp: 2,
			},
		];
		const report = buildContextReport({
			...fixture(),
			systemPrompt: "",
			systemPromptOptions: { cwd: "/repo" },
			tools: [],
			messages,
			reserveTokens: 0,
		});
		const conversation = group(report, "conversation");
		const categoryTotal = conversation.children!.reduce((total, row) => total + row.tokens!, 0);
		expect(child(report.groups, "assistant")!.tokens).toBe(1);
		expect(child(report.groups, "thinking")!.tokens).toBe(1);
		expect(child(report.groups, "toolCalls")!.tokens).toBe(3);
		expect(child(report.groups, "toolResults")!.tokens).toBe(1);
		expect(conversation.tokens).toBe(6);
		expect(categoryTotal).toBe(6);
		expect(report.usedTokens).toBe(6);
	});

	test("counts non-ASCII text closer to one token per code point", () => {
		const report = buildContextReport({
			...fixture(),
			systemPrompt: "中文",
			systemPromptOptions: { cwd: "/repo" },
			tools: [],
			messages: [],
			reserveTokens: 0,
		});
		expect(child(report.groups, "system-prompt")!.tokens).toBe(2);
		expect(report.usedTokens).toBe(2);
	});

	test("keeps the system prompt remainder nonnegative after section rounding", () => {
		const input = fixture();
		const options = input.systemPromptOptions;
		const skillsSection = formatSkillsForPrompt(options.skills ?? [], "read");
		const contextSection =
			"\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n" +
			'<project_instructions path="/repo/AGENTS.md">\n' +
			"a".repeat(40) +
			"\n</project_instructions>\n\n</project_context>\n";
		const report = buildContextReport({
			...input,
			systemPrompt: `${skillsSection}${contextSection}`,
			tools: [],
			messages: [],
			reportedTokens: null,
		});

		expect(child(report.groups, "system-prompt")!.tokens).toBeGreaterThanOrEqual(0);
	});

	test("anchors the estimated breakdown to host-reported context tokens", () => {
		const base = fixture();
		const unanchored = buildContextReport(base);
		const reportedTokens = (unanchored.usedTokens ?? 0) * 2;
		const report = buildContextReport({ ...base, reportedTokens });
		expect(report.usedTokens).toBe(reportedTokens);
		expect(group(report, "instructions").tokens).toBe(group(unanchored, "instructions").tokens! * 2);
		expect(group(report, "tools").tokens).toBe(group(unanchored, "tools").tokens! * 2);
		expect(group(report, "conversation").tokens).toBe(group(unanchored, "conversation").tokens! * 2);
		expect(report.freeTokens).toBe(100_000 - reportedTokens - 1_000);
	});

	test("separates MCP tools and expands resources only in the detailed view", () => {
		const report = buildContextReport(fixture());
		expect(child(report.groups, "builtin-tools")!.children!.map((row) => row.label)).toEqual(["read"]);
		expect(child(report.groups, "mcp-tools")!.children!.map((row) => row.label)).toEqual(["docs__search"]);

		const summary = contextReportRows(report).join("\n");
		const detailed = contextReportRows(report, true).join("\n");
		expect(summary).not.toContain("docs__search");
		expect(summary).not.toContain("alpha-skill");
		expect(detailed).toContain("docs__search");
		expect(detailed).toContain("alpha-skill");
		expect(detailed).toContain("AGENTS.md");
		expect(formatContextReportText(report, true)).toContain("A summary");
	});

	test("separates SDK tools and reconciles instruction children with the system prompt", () => {
		const input = fixture();
		const report = buildContextReport({ ...input, tools: [...input.tools!, tool("sdk_tool", "sdk")] });
		expect(child(report.groups, "builtin-tools")!.children!.map((row) => row.label)).toEqual(["read"]);
		expect(child(report.groups, "sdk-tools")!.children!.map((row) => row.label)).toEqual(["sdk_tool"]);

		const instructions = group(report, "instructions");
		const childrenTotal = instructions.children!.reduce((total, row) => total + row.tokens!, 0);
		expect(childrenTotal).toBe(instructions.tokens);
	});

	test("marks an unavailable tool catalog as unknown instead of zero", () => {
		const report = buildContextReport({ ...fixture(), tools: undefined });
		expect(report.usedTokens).toBeNull();
		expect(report.freeTokens).toBeNull();
		expect(contextReportRows(report).join("\n")).toContain("--");
		expect(contextMeterSegments(report)).toEqual([]);
	});

	test("allocates the meter across used, reserve, and free space", () => {
		const base = buildContextReport(fixture());
		const report = {
			...base,
			contextWindow: base.usedTokens! + 1_000,
			reserveTokens: 200,
			freeTokens: 800,
		};
		const segments = contextMeterSegments(report);
		expect(segments).toHaveLength(40);
		expect(segments).toContain("instructions");
		expect(segments).toContain("tools");
		expect(segments).toContain("conversation");
		expect(segments).toContain("reserve");
		expect(segments).toContain("free");
	});

	test("uses provider token counts for group totals and keeps children reconciled", () => {
		const base = fixture();
		const report = buildContextReport({
			...base,
			tokenCounts: {
				groups: { instructions: 1_000, tools: 200, conversation: 5_000 },
			},
		});
		expect(report.tokenSource).toBe("provider");
		expect(report.usedTokens).toBe(6_200);
		expect(group(report, "instructions").tokens).toBe(1_000);
		expect(group(report, "tools").tokens).toBe(200);
		expect(group(report, "conversation").tokens).toBe(5_000);
		for (const groupRow of report.groups) {
			const childrenTotal = groupRow.children!.reduce((total, row) => total + row.tokens!, 0);
			expect(childrenTotal).toBe(groupRow.tokens);
		}
		expect(contextReportRows(report).join("\n")).toContain("Context Usage (token-count API)");
	});

	test("uses provider category counts as conversation weights", () => {
		const base = fixture();
		const report = buildContextReport({
			...base,
			tokenCounts: {
				groups: { conversation: 800 },
				rows: {
					user: 100,
					assistant: 200,
					thinking: 50,
					toolCalls: 150,
					toolResults: 300,
					compaction: 0,
					injected: 0,
					other: 0,
				},
			},
		});
		expect(report.tokenSource).toBe("provider");
		expect(group(report, "conversation").tokens).toBe(800);
		expect(child(report.groups, "user")!.tokens).toBe(100);
		expect(child(report.groups, "toolResults")!.tokens).toBe(300);
		expect(report.usedTokens).toBe(group(report, "instructions").tokens! + group(report, "tools").tokens! + 800);
	});

	test("panel toggles details, renders within the terminal, and closes", () => {
		const report = buildContextReport(fixture());
		const onClose = vi.fn();
		const tui = { terminal: { rows: 24 }, requestRender: vi.fn() } as unknown as TUI;
		const panel = new ContextPanel({ report, theme, tui, onClose }, new KeybindingsManager());
		const summary = panel.render(80).join("\n");
		expect(summary).toContain("Context Usage");
		expect(summary).not.toContain("docs__search");
		expect(summary.split("\n").length).toBeLessThanOrEqual(18);

		panel.handleInput("a");
		expect(panel.render(80).join("\n")).toContain("docs__search");
		panel.handleInput("\x1b");
		expect(onClose).toHaveBeenCalledOnce();
	});
});
