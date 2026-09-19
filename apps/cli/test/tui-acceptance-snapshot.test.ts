/**
 * TUI 验收快照套件（第 1 层）—— 对应《tui-acceptance-manual.md》A/B/C/D/E/F/G/I 分区。
 *
 * 两个互补的断言层：
 * - 布局快照：stripTerminalSequences 后 toMatchSnapshot()，diff 即"改动效果图"；
 *   基线更新用 `npx vitest run test/tui-acceptance-snapshot.test.ts -u`。
 * - 颜色抽查：对关键主题应用（用户消息底色、选中加粗、diff/语法色、状态字形）
 *   直接断言 truecolor SGR 序列，钉住"配色不回退"。
 *
 * 确定性约定：钉死 truecolor 能力、step 主题、固定宽度和 fake timers；
 * 工具行不传共享时钟（spinner 帧恒为 ⠋）。
 */

import type { AssistantMessage } from "@step-harness/providers";
import {
	Markdown,
	resetCapabilitiesCache,
	SelectList,
	setCapabilities,
	stripTerminalSequences,
	Text,
	type TUI,
	visibleWidth,
} from "@step-harness/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentSession } from "../../../packages/coding-agent/src/core/agent-session.ts";
import type { ToolDefinition } from "../../../packages/coding-agent/src/core/extensions/types.ts";
import type { ReadonlyFooterDataProvider } from "../../../packages/coding-agent/src/core/footer-data-provider.ts";
import { FooterComponent } from "../src/ui/view/chrome/footer.ts";
import {
	IdleStatus,
	TurnDoneIndicator,
	WorkingOutputTracker,
	WorkingStatusIndicator,
} from "../src/ui/view/chrome/status-indicator.ts";
import { buildStatusTips, StatusTipRotator } from "../src/ui/view/chrome/status-tips.ts";
import {
	StepAssistantMessageComponent,
	StepUserMessageComponent,
} from "../src/ui/view/transcript/step-message.ts";
import { StepWelcomeComponent } from "../src/ui/view/chrome/step-welcome.ts";
import { ToolExecutionComponent } from "../src/ui/view/transcript/tool-execution.ts";
import { getMarkdownTheme, getSelectListTheme, initTheme, theme } from "../../../packages/coding-agent/src/theme/theme.ts";

function plain(lines: readonly string[]): string[] {
	return lines.map((line) => stripTerminalSequences(line).trimEnd());
}

function fakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
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
	};
}

function customToolDefinition(): ToolDefinition {
	return {
		name: "custom_tool",
		label: "custom_tool",
		description: "custom tool",
		parameters: Type.Any(),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		renderCall: () => new Text("scan ./src for todos", 0, 0),
		renderResult: () => new Text("3 matches", 0, 0),
	};
}

function stepToolComponent(presentation: "native" | "step" = "step"): ToolExecutionComponent {
	return new ToolExecutionComponent(
		"custom_tool",
		"tool-accept-1",
		{},
		{ presentation },
		customToolDefinition(),
		fakeTui(),
		"/tmp/project",
	);
}

function footerSession(): AgentSession {
	const session = {
		state: {
			model: { id: "step-3.8", provider: "stepfun", contextWindow: 200_000, reasoning: true },
			thinkingLevel: "high",
		},
		sessionManager: { getEntries: () => [], getSessionName: () => "", getCwd: () => "/tmp/project" },
		getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3, tokens: 24_600 }),
	};
	return session as unknown as AgentSession;
}

function footerData(statuses: Record<string, string> = {}): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map(Object.entries(statuses)),
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	} as unknown as ReadonlyFooterDataProvider;
}

beforeEach(() => {
	setCapabilities({ images: null, trueColor: true, hyperlinks: false });
	initTheme("step-blue");
});

afterEach(() => {
	resetCapabilitiesCache();
	initTheme("dark");
	vi.useRealTimers();
});

describe("A. 欢迎屏快照", () => {
	test("宽终端走小鸟档（A1/A2/A4）", () => {
		const component = new StepWelcomeComponent(() => ({
			version: "0.3.2",
			model: "step-3.8",
			thinkingLevel: "high",
			workspaceRoot: "/Users/demo/work/project",
			sessionId: "sess-1234",
		}));
		const lines = component.render(100);
		// The wordmark art replaces the literal title at this width; the
		// version rides in the info-box border title instead.
		expect(lines.join("\n")).toContain("v0.3.2");
		expect(lines.join("\n")).toContain("step-3.8");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(100);
		expect(plain(lines)).toMatchSnapshot("welcome-bird-100");
	});

	test("中终端走方块 mark 档（A1）", () => {
		const component = new StepWelcomeComponent(() => ({ workspaceRoot: "/tmp/project", model: "step-3.8" }));
		expect(plain(component.render(50))).toMatchSnapshot("welcome-mark-50");
	});

	test("窄终端走徽章档且不越界（A1/A4）", () => {
		const component = new StepWelcomeComponent(() => ({ workspaceRoot: "/tmp/project", model: "step-3.8" }));
		const lines = component.render(30);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(30);
		expect(plain(lines)).toMatchSnapshot("welcome-badge-30");
	});
});

describe("B. 用户消息快照与底色", () => {
	test("灰底整条 + › gutter（B1）", () => {
		const component = new StepUserMessageComponent("帮我看下 `main.ts` 里\n\n**第二个**函数", getMarkdownTheme());
		const rows = component.render(40);
		// › gutter 只出现在首个正文行；底色覆盖整条消息
		const promptRow = rows.find((row) => stripTerminalSequences(row).includes("› 帮我看下"));
		const secondRow = rows.find((row) => stripTerminalSequences(row).includes("第二个"));
		expect(promptRow).toBeDefined();
		expect(secondRow).toBeDefined();
		expect(promptRow).toContain(theme.getBgAnsi("userMessageBg"));
		expect(secondRow).toContain(theme.getBgAnsi("userMessageBg"));
		expect(promptRow).toContain(`${theme.getFgAnsi("userMessageText")}› `);
		expect(plain(rows)).toMatchSnapshot("user-message-40");
	});
});

describe("C. 助手消息快照", () => {
	test("thinking + 回答 + 代码块（C1/C2/I2）", () => {
		const component = new StepAssistantMessageComponent(
			assistantMessage([
				{ type: "thinking", thinking: "用户要一个示例。我先想一下结构，再决定示例语言。" },
				{
					type: "text",
					// 拼接避免 lint 把 ${name} 当模板占位符；内容与快照基线一致
					text:
						"## 示例\n\n下面是一个函数：\n\n```ts\nconst greet = (name: string) => `hi $" +
						"{name}`;\n```\n\n行内 `code` 与 *强调*。",
				},
			]),
			false,
			getMarkdownTheme(),
		);
		const lines = plain(component.render(72));
		const thinking = lines.findIndex((line) => line.includes("• thinking"));
		// Markdown 标题保留 ## 前缀（muted 弱化），gutter 后接前缀+标题文本
		const answer = lines.findIndex((line) => line.includes("• ## 示例"));
		expect(thinking).toBeGreaterThanOrEqual(0);
		expect(answer).toBeGreaterThan(thinking);

		// F-2 回归：完成态围栏只渲染一个语言标签，不允许重复
		const labelRows = lines.filter((line) => line.replace(/[^a-z]/gu, "") === "ts");
		expect(labelRows).toHaveLength(1);
		expect(lines.join("\n")).not.toMatch(/(typescript|ts)\1/u);
		expect(component.render(72).join("\n")).toContain(theme.getFgAnsi("syntaxKeyword"));
		expect(lines).toMatchSnapshot("assistant-message-72");
	});
});

describe("C2. thinking 摘要行（CC 对齐：流式零占位，完成态带数据）", () => {
	test("流式期间隐藏 thinking 不占行——瞬时状态由底部状态行承担", () => {
		const component = new StepAssistantMessageComponent(undefined, true, getMarkdownTheme());
		component.updateContent(assistantMessage([{ type: "thinking", thinking: "先想一下结构" }]), true);
		const lines = plain(component.render(72));
		expect(lines.join("\n")).not.toContain("Thinking");
		expect(lines.length).toBe(0);
	});

	test("完成态显示 Thought for Ns · ↓ N tokens（时长来自流式增量计时）", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const component = new StepAssistantMessageComponent(undefined, true, getMarkdownTheme());
		component.updateContent(assistantMessage([{ type: "thinking", thinking: "x".repeat(40) }]), true);
		vi.setSystemTime(12_000);
		component.updateContent(
			assistantMessage([
				{ type: "thinking", thinking: "x".repeat(40) },
				{ type: "text", text: "答案" },
			]),
			false,
		);
		const text = plain(component.render(72)).join("\n");
		expect(text).toContain("• Thought for 12s");
		expect(text).toContain("↓ 10 tokens");
		expect(text).not.toContain("Thinking...");
	});

	test("工具调用是思考段边界：时长在工具出现时截止，不吃后续工具执行时间", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const component = new StepAssistantMessageComponent(undefined, true, getMarkdownTheme());
		component.updateContent(assistantMessage([{ type: "thinking", thinking: "x".repeat(40) }]), true);
		vi.setSystemTime(5_000);
		const withTool = assistantMessage([
			{ type: "thinking", thinking: "x".repeat(40) },
			{ type: "toolCall", id: "t1", name: "read", arguments: {} },
		]);
		component.updateContent(withTool, true);
		// 工具跑了很久之后消息才完成——思考时长仍是 5s
		vi.setSystemTime(60_000);
		component.updateContent(withTool, false);
		const text = plain(component.render(72)).join("\n");
		expect(text).toContain("• Thought for 5s");
	});

	test("usage.reasoning 优先于字符估算", () => {
		const message = assistantMessage([{ type: "thinking", thinking: "x".repeat(40) }]);
		message.usage.reasoning = 4221;
		const component = new StepAssistantMessageComponent(message, true, getMarkdownTheme());
		const text = plain(component.render(72)).join("\n");
		expect(text).toContain("↓ 4.2k tokens");
	});

	test("回放路径（构造即完成态）无时长数据——降级为不带时长", () => {
		const component = new StepAssistantMessageComponent(
			assistantMessage([
				{ type: "thinking", thinking: "x".repeat(40) },
				{ type: "text", text: "答案" },
			]),
			true,
			getMarkdownTheme(),
		);
		const text = plain(component.render(72)).join("\n");
		expect(text).toContain("• Thought ·");
		expect(text).not.toContain("for");
	});
});

describe("D. 工具执行流快照", () => {
	test("进行中/成功/失败三态（D1/D6）", () => {
		const pending = stepToolComponent();
		const pendingLines = pending.render(72).join("\n");
		expect(pendingLines).toContain("⠋");

		const success = stepToolComponent();
		success.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const successLines = success.render(72).join("\n");
		expect(successLines).toContain(stripTerminalSequences(theme.fg("success", "●")));
		expect(plain(success.render(72))).toMatchSnapshot("tool-success-72");

		const failure = stepToolComponent();
		failure.updateResult({ content: [{ type: "text", text: "boom" }], details: {}, isError: true }, false);
		expect(failure.render(72).join("\n")).toContain(stripTerminalSequences(theme.fg("error", "✗")));
		// 6-2 错误三要素：why（错误文本 error 色）+ how（↳ 恢复建议）
		expect(failure.render(72).join("\n")).toContain(stripTerminalSequences(theme.fg("error", "boom")));
		expect(failure.render(72).join("\n")).toContain("↳ 可回复「重试」");
		expect(plain(failure.render(72))).toMatchSnapshot("tool-error-72");
	});
});

describe("E. 运行状态指示", () => {
	test("Working 行后缀稳定（E1/E2）——间隙不再轮换假动作词", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const tracker = new WorkingOutputTracker();
		tracker.reset(0);
		const indicator = new WorkingStatusIndicator(fakeTui(), "Working...", undefined, "step", tracker);
		try {
			const line = stripTerminalSequences(indicator.render(80)[0] ?? "");
			expect(line).toContain("Working... (0s · ↓ 0 tokens)");

			// 长间隙：动词保持 Working...（计时器和 token 后缀仍活），
			// 不再出现 Reading/Exploring 这类计时器轮换的伪动作词
			vi.advanceTimersByTime(40_000);
			vi.setSystemTime(40_000);
			const idleLine = stripTerminalSequences(indicator.render(80)[0] ?? "");
			expect(idleLine).toContain("Working... (40s ·");
			expect(idleLine).not.toContain("Reading...");
			expect(idleLine).not.toContain("Exploring...");
		} finally {
			indicator.dispose();
		}
	});

	test("thinking 阶段保持 Thinking...（E1/E2）", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const tracker = new WorkingOutputTracker();
		tracker.reset(0);
		const partial = assistantMessage([{ type: "thinking", thinking: "x" }]);
		tracker.update({ type: "thinking_delta", contentIndex: 0, delta: "x".repeat(80), partial } as Parameters<
			typeof tracker.update
		>[0]);
		const indicator = new WorkingStatusIndicator(fakeTui(), "Working...", undefined, "step", tracker);
		try {
			vi.advanceTimersByTime(12_000);
			const line = stripTerminalSequences(indicator.render(80)[0] ?? "");
			expect(line).toContain("Thinking...");
			expect(line).toContain("· thinking");
		} finally {
			indicator.dispose();
		}
	});

	test("动词跟随真实工具（E2 扩展）", () => {
		vi.useFakeTimers();
		const tracker = new WorkingOutputTracker();
		tracker.reset(0);
		// 工具间隙：轮换动词照旧（Working...）
		const idleIndicator = new WorkingStatusIndicator(fakeTui(), "Working...", undefined, "step", tracker);
		// 工具执行中：bash 在跑 → Running...，read 在跑 → Reading...
		const bashIndicator = new WorkingStatusIndicator(
			fakeTui(),
			"Working...",
			undefined,
			"step",
			tracker,
			() => "bash",
		);
		const readIndicator = new WorkingStatusIndicator(
			fakeTui(),
			"Working...",
			undefined,
			"step",
			tracker,
			() => "read",
		);
		try {
			vi.advanceTimersByTime(4_000);
			expect(stripTerminalSequences(idleIndicator.render(80)[0] ?? "")).toContain("Working...");
			expect(stripTerminalSequences(bashIndicator.render(80)[0] ?? "")).toContain("Running...");
			expect(stripTerminalSequences(readIndicator.render(80)[0] ?? "")).toContain("Reading...");
			// 未映射工具不瞎编，显示诚实的 Working...
			const unknownIndicator = new WorkingStatusIndicator(
				fakeTui(),
				"Working...",
				undefined,
				"step",
				tracker,
				() => "mystery_tool",
			);
			vi.advanceTimersByTime(4_000);
			const unknownLine = stripTerminalSequences(unknownIndicator.render(80)[0] ?? "");
			expect(unknownLine).toContain("Working...");
			expect(unknownLine).not.toContain("Mystery");
			unknownIndicator.dispose();
		} finally {
			idleIndicator.dispose();
			bashIndicator.dispose();
			readIndicator.dispose();
		}
	});

	test("工具动词黏性与降级门控（E2 完整序列）", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const tracker = new WorkingOutputTracker();
		tracker.reset(0);
		let activeTool: string | undefined;
		const indicator = new WorkingStatusIndicator(
			fakeTui(),
			"Working...",
			undefined,
			"step",
			tracker,
			() => activeTool,
		);
		const msg = () => stripTerminalSequences(indicator.render(80)[0] ?? "");
		try {
			// 1) 模型思考 → Thinking...
			const thinkingPartial = assistantMessage([{ type: "thinking", thinking: "x" }]);
			tracker.update({
				type: "thinking_delta",
				contentIndex: 0,
				delta: "x".repeat(40),
				partial: thinkingPartial,
			} as Parameters<typeof tracker.update>[0]);
			vi.advanceTimersByTime(4_000);
			expect(msg()).toContain("Thinking...");

			// 2) read 开始（tool_execution_start 接线：notifyToolStarted + refreshVerb）
			tracker.notifyToolStarted();
			activeTool = "read";
			indicator.refreshVerb();
			expect(msg()).toContain("Reading...");

			// 3) read 300ms 即结束（spinner 清名，无其他事件）——连续 3 个 tick
			//    （12 秒）内必须保持 Reading...，不得被降级为 Working...
			activeTool = undefined;
			vi.advanceTimersByTime(12_000);
			expect(msg()).toContain("Reading...");

			// 4) 模型开始输出总结（text_delta）→ 解锁降级 → Working...
			const textPartial = assistantMessage([{ type: "text", text: "x" }]);
			tracker.update({ type: "text_delta", contentIndex: 0, delta: "项目名是", partial: textPartial } as Parameters<
				typeof tracker.update
			>[0]);
			vi.advanceTimersByTime(4_000);
			expect(msg()).toContain("Working...");
		} finally {
			indicator.dispose();
		}
	});

	test("计时进位（E3）", () => {
		vi.useFakeTimers();
		vi.setSystemTime(3600_000);
		const tracker = new WorkingOutputTracker();
		tracker.reset(0);
		const indicator = new WorkingStatusIndicator(fakeTui(), "Working...", undefined, "step", tracker);
		try {
			expect(stripTerminalSequences(indicator.render(80)[0] ?? "")).toContain("(1h ·");
		} finally {
			indicator.dispose();
		}
	});

	test("轮次结束标记（E4）：Done in Xm Ys · HH:MM", () => {
		const minutes = new TurnDoneIndicator(110, new Date(2026, 8, 9, 19, 26));
		expect(stripTerminalSequences(minutes.render(80)[0] ?? "")).toContain("✻ Done in 1m 50s · 19:26");

		const seconds = new TurnDoneIndicator(45, new Date(2026, 8, 9, 9, 5));
		expect(stripTerminalSequences(seconds.render(80)[0] ?? "")).toContain("✻ Done in 45s · 09:05");

		// 亚秒轮次：<1s，不显示 0s
		const instant = new TurnDoneIndicator(0, new Date(2026, 8, 9, 9, 5));
		expect(stripTerminalSequences(instant.render(80)[0] ?? "")).toContain("✻ Done in <1s · 09:05");
	});

	test("空闲两空行（E6）", () => {
		const idle = new IdleStatus();
		const lines = idle.render(20);
		expect(lines).toEqual([" ".repeat(20), " ".repeat(20)]);
	});

	test("工作行 tip：一轮一条，状态行下一行 dim 显示（E7）", () => {
		const tracker = new WorkingOutputTracker();
		const indicator = new WorkingStatusIndicator(fakeTui(), "Working...", undefined, "step", tracker);
		try {
			// 未设置 tip 时只有一行
			expect(indicator.render(80)).toHaveLength(1);

			indicator.setStatusTip("Use /theme to switch themes (step-blue / step-violet)");
			const rows = indicator.render(80).map((row) => stripTerminalSequences(row));
			expect(rows).toHaveLength(2);
			expect(rows[0]).toContain("Working...");
			expect(rows[1]).toContain("  tip: Use /theme to switch themes (step-blue / step-violet)");
			// tip 比 Working 行更弱（dim），不与状态行争注意力
			expect(indicator.render(80)[1]).toContain(theme.getFgAnsi("dim"));

			// 空串视为未设置
			indicator.setStatusTip("   ");
			expect(indicator.render(80)).toHaveLength(1);
		} finally {
			indicator.dispose();
		}
	});

	test("tip 轮换：会话随机起点，顺序推进，一轮一条不重复（E7）", () => {
		const pool = ["a", "b", "c"];
		const rotator = new StatusTipRotator(pool, 1); // 显式起点 1
		expect([rotator.next(), rotator.next(), rotator.next(), rotator.next()]).toEqual(["b", "c", "a", "b"]);

		// 默认起点 0：每次会话第一条都是池头（用户拍板 /theme 排第一）
		const fresh = new StatusTipRotator(pool);
		expect(fresh.next()).toBe("a");
		expect(new StatusTipRotator([], 0).next()).toBeUndefined();

		// 内置池：/theme 必须排第一，其余非空
		const tips = buildStatusTips();
		expect(tips.length).toBeGreaterThanOrEqual(5);
		expect(tips[0]).toContain("/theme");
		for (const tip of tips) expect(tip.trim().length).toBeGreaterThan(0);
	});
});

describe("F/G. 选中样式与页脚快照", () => {
	test("下拉选中行加粗 + accent（F4）", () => {
		const list = new SelectList(
			[
				{ value: "model", label: "model", description: "Select model" },
				{ value: "permissions", label: "permissions", description: "Permission mode" },
				{ value: "effort", label: "effort", description: "Thinking level" },
			],
			5,
			getSelectListTheme(),
		);
		list.handleInput("\x1b[B"); // down
		const rendered = list.render(60).join("\n");
		expect(rendered).toContain("→ ");
		// 加粗 + 中性前景（品牌紫只锚在工具行与门面，选中态不占紫）
		const selected = rendered.split("\n").find((line) => line.includes("→ ")) ?? "";
		expect(selected).toContain("\x1b[1m");
		expect(selected).toContain(theme.getFgAnsi("text"));
		expect(selected).not.toContain(theme.getFgAnsi("accent"));
		expect(plain(list.render(60))).toMatchSnapshot("select-list-60");
	});

	test("页脚 step 呈现（G1/G2/G4）", () => {
		const footer = new FooterComponent(
			footerSession(),
			footerData({ "step-permission": "Mode: Ask (auto-resume)" }),
			{
				presentation: "step",
			},
		);
		const lines = footer.render(120);
		const flat = lines.join("\n");
		expect(stripTerminalSequences(flat)).toContain("⏵ Ask");
		expect(stripTerminalSequences(flat)).toContain("step-3.8");
		expect(stripTerminalSequences(flat)).toContain("context left");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(120);
		expect(plain(lines)).toMatchSnapshot("footer-step-120");
	});

	test("页脚隐藏 token 用量并保留 context 变色（G4/6-1）", () => {
		const session = footerSession();
		session.sessionManager.getEntries = () =>
			[
				{
					type: "message",
					message: {
						role: "assistant",
						usage: { input: 12_000, output: 3_000, cacheRead: 60_000, cacheWrite: 0, cost: { total: 0.02 } },
					},
				},
			] as never;
		const footer = new FooterComponent(session, footerData(), { presentation: "step" });
		const flat = stripTerminalSequences(footer.render(120).join("\n"));
		expect(flat).not.toContain("75k tok");
		expect(flat).toContain("88% context left");

		const calm = footer.render(120).join("\n");
		expect(calm).not.toContain(theme.getFgAnsi("warning"));
		expect(calm).not.toContain(theme.getFgAnsi("error"));

		// 高水位：>70% used 变 warning、>90% used 变 error
		session.getContextUsage = () => ({ contextWindow: 200_000, percent: 75, tokens: 150_000 });
		const warned = footer.render(120).join("\n");
		expect(warned).toContain(theme.getFgAnsi("warning"));
		session.getContextUsage = () => ({ contextWindow: 200_000, percent: 95, tokens: 190_000 });
		const alarmed = footer.render(120).join("\n");
		expect(alarmed).toContain(theme.getFgAnsi("error"));
	});
});

describe("I. Markdown 渲染快照", () => {
	const MD = [
		"# 标题一",
		"",
		"段落，带 **加粗**、*斜体*、~~删除~~、`行内码` 和 [链接](https://example.com)。",
		"",
		"- 列表项 A",
		"- 列表项 B",
		"",
		"> 引用块",
		"",
		"| 列1 | 列2 |",
		"| --- | --- |",
		"| a | b |",
		"",
		"```ts",
		"const x: number = 42;",
		"```",
		"",
		"---",
	].join("\n");

	test("全块型 + 代码高亮（I1/I2/I3）", () => {
		const markdown = new Markdown(MD, 1, 0, getMarkdownTheme());
		const raw = markdown.render(60).join("\n");
		expect(raw).toContain(theme.getFgAnsi("mdHeading"));
		expect(raw).toContain(theme.getFgAnsi("syntaxKeyword"));
		expect(raw).toContain(theme.getFgAnsi("mdCode"));
		expect(plain(markdown.render(60))).toMatchSnapshot("markdown-blocks-60");
	});

	test("emoji 宽度不越界（I5）", () => {
		const markdown = new Markdown("表情 🫠🫰🪨 结尾", 1, 0, getMarkdownTheme());
		for (const line of markdown.render(20)) expect(visibleWidth(line)).toBeLessThanOrEqual(20);
	});
});
