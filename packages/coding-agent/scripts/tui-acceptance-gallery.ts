/**
 * TUI 验收对比图渲染器 —— 在当前代码状态下渲染固定场景，输出 ANSI 文本。
 *
 * 用法：npx tsx scripts/tui-acceptance-gallery.ts <输出目录>
 * 验收 before/after 对比的流程：干净 main 跑一次 → 应用改动跑一次，
 * 再由 scripts/ansi-to-html.py + 浏览器截图 + 拼图生成对比图。
 * 场景与 test/tui-acceptance-snapshot.test.ts 同源，钉死 truecolor + step 主题，
 * 保证两次运行除代码差异外完全一致。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Markdown, SelectList, setCapabilities, Text } from "@earendil-works/pi-tui";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { StepWelcomeComponent } from "../src/modes/interactive/components/step-welcome.ts";
import {
	StepAssistantMessageComponent,
	StepUserMessageComponent,
} from "../src/modes/interactive/components/step-message.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { WorkingStatusIndicator, WorkingOutputTracker } from "../src/modes/interactive/components/status-indicator.ts";
import {
	getMarkdownTheme,
	getSelectListTheme,
	initTheme,
} from "../src/modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import type { TUI } from "@earendil-works/pi-tui";

const WIDTH = 100;

function fakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "step-3.5-flash",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	} as AssistantMessage;
}

const BUILTIN_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model (opens selector UI)" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "thinking", description: "Set thinking level" },
	{ name: "effort", description: "Set thinking level (alias for /thinking)" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "export", description: "Export session (HTML default, or specify path)" },
	{ name: "quit", description: "Quit the app" },
];
const EXTENSION_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
	{ name: "permissions", description: "Choose Step tool approval mode" },
	{ name: "plan", description: "Enter or leave plan mode" },
	{ name: "status", description: "Show session status" },
];

async function main(): Promise<void> {
	const outDir = process.argv[2];
	if (!outDir) throw new Error("usage: tui-acceptance-gallery.ts <outDir>");
	mkdirSync(outDir, { recursive: true });

	setCapabilities({ images: null, trueColor: true, hyperlinks: false });
	initTheme("step");

	const save = (name: string, lines: readonly string[]): void => {
		writeFileSync(join(outDir, `${name}.ansi`), lines.join("\n"), "utf8");
	};

	// 场景 1：欢迎屏（A 区）
	const welcome = new StepWelcomeComponent(() => ({
		version: "0.1.0",
		model: "step-3.5-flash",
		thinkingLevel: "high",
		workspaceRoot: "/Users/demo/Documents/step-harness",
	}));
	save("welcome", welcome.render(WIDTH));

	// 场景 2：斜杠命令下拉（F2 排序 + F4 选中样式）
	// 排序 helper 仅在重设计分支导出；干净 main 上回退原始顺序，正好呈现 before。
	let commands = [...BUILTIN_COMMANDS, ...EXTENSION_COMMANDS];
	try {
		const mod = (await import("../src/modes/interactive/interactive-mode.ts")) as {
			orderStepSlashCommands?: (items: typeof commands) => typeof commands;
		};
		if (typeof mod.orderStepSlashCommands === "function") {
			commands = mod.orderStepSlashCommands(commands);
		}
	} catch {
		// before 状态：helper 未导出，保持注册顺序
	}
	const dropdown = new SelectList(
		commands.slice(0, 6).map((command) => ({
			value: `/${command.name}`,
			label: command.name,
			description: command.description,
		})),
		6,
		getSelectListTheme(),
	);
	dropdown.handleInput("\x1b[B"); // 选中第二项
	save("dropdown", dropdown.render(WIDTH));

	// 场景 3：消息流（B/C/I 区：用户消息、thinking、代码块、行内 code）
	const user = new StepUserMessageComponent("帮我看下 `main.ts` 里\n\n**第二个**函数", getMarkdownTheme());
	const assistant = new StepAssistantMessageComponent(
		assistantMessage([
			{ type: "thinking", thinking: "用户要一个示例。先想结构，再决定语言。" },
			{
				type: "text",
				text: "## 示例\n\n行内 `code` 与 **加粗**：\n\n```typescript\nconst greet = (name: string): string => `hi ${name}`;\n```\n\n| 列1 | 列2 |\n| --- | --- |\n| a | b |",
			},
		]),
		false,
		getMarkdownTheme(),
	);
	save("messages", [...user.render(WIDTH), "", ...assistant.render(WIDTH)]);

	// 场景 4：工具行 + Working 状态行（D/E 区）
	const toolDef: ToolDefinition = {
		name: "custom_tool",
		label: "custom_tool",
		description: "custom tool",
		parameters: Type.Any(),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		renderCall: () => new Text("scan ./src for todos", 0, 0),
	};
	const toolPending = new ToolExecutionComponent(
		"custom_tool",
		"gallery-1",
		{},
		{ presentation: "step" },
		toolDef,
		fakeTui(),
		"/tmp/project",
	);
	const toolDone = new ToolExecutionComponent(
		"custom_tool",
		"gallery-2",
		{},
		{ presentation: "step" },
		toolDef,
		fakeTui(),
		"/tmp/project",
	);
	toolDone.updateResult({ content: [{ type: "text", text: "3 matches" }], details: {}, isError: false }, false);
	const tracker = new WorkingOutputTracker();
	tracker.reset(Date.now() - 4000);
	const working = new WorkingStatusIndicator(fakeTui(), "Working...", undefined, "step", tracker);
	const workingLines = working.render(WIDTH);
	working.dispose();
	save("tools-working", [...toolPending.render(WIDTH), ...toolDone.render(WIDTH), ...workingLines]);

	console.log(`gallery written to ${outDir}`);
}

void main();
