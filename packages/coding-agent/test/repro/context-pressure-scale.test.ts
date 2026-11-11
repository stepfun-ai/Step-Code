/**
 * Payload-size and local-CPU measurement at production context sizes.
 *
 * Run:
 *   cd packages/coding-agent && pnpm exec vitest --run test/repro/context-pressure-scale.test.ts
 *
 * Writes /tmp/step-context-pressure-scale.md.
 */
import { writeFileSync } from "node:fs";
import type { AgentMessage } from "@step-harness/agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { afterAll, describe, expect, it } from "vitest";
import { estimateTokens, serializeConversation } from "../../src/core/compaction/index.ts";
import {
	digestMessages,
	renderLiveContext,
	renderLiveContextIndex,
} from "../../src/core/compaction/live-context/document.ts";
import { LiveContextManager } from "../../src/core/compaction/live-context/manager.ts";
import { convertToLlm } from "../../src/core/messages.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const REPORT = "/tmp/step-context-pressure-scale.md";
const lines: string[] = [];
afterAll(() => writeFileSync(REPORT, lines.join("\n"), "utf8"));

const chunk = "observed build output: src/parser.ts:42 exit code 1, assertion failed\n".repeat(200);

function history(tokens: number): AgentMessage[] {
	const messages: AgentMessage[] = [];
	let total = 0;
	let i = 0;
	while (total < tokens) {
		const assistant = fauxAssistantMessage([fauxToolCall("run_command", { command: "pnpm test" })], {
			stopReason: "toolUse",
			timestamp: 2 + i * 4,
		});
		messages.push(
			{ role: "user", content: `STEP ${i}: inspect the failing build`, timestamp: 1 + i * 4 },
			assistant,
			{
				role: "toolResult",
				toolCallId: (assistant.content[0] as { id: string }).id,
				toolName: "run_command",
				content: [{ type: "text", text: chunk }],
				isError: false,
				timestamp: 3 + i * 4,
			},
		);
		total += Math.ceil(chunk.length / 4) + 30;
		i++;
	}
	return messages;
}

function ms(fn: () => void): number {
	const start = performance.now();
	fn();
	return Math.round(performance.now() - start);
}

describe("context pressure at production size", () => {
	it("measures request payloads and local CPU cost", () => {
		lines.push("# 载荷与本地 CPU 开销", "");
		for (const target of [300_000, 600_000, 900_000]) {
			const messages = history(target);
			const llm = convertToLlm(messages);
			const summaryText = serializeConversation(llm);
			const document = renderLiveContext(messages, 0, "session");
			const index = renderLiveContextIndex(document, "/tmp/LIVE_CONTEXT.md");
			const manager = new LiveContextManager(SessionManager.inMemory());
			const mirrorMs = ms(() => {
				// prepare() renders the mirror and writes LIVE_CONTEXT.md + CONTEXT_INDEX.md.
				void manager.prepare(messages).catch(() => undefined);
			});
			const digestMs = ms(() => digestMessages(messages));
			const cloneMs = ms(() => {
				JSON.parse(JSON.stringify({ systemPrompt: "x", messages, tools: [] }));
			});
			const allEstimateMs = ms(() => {
				for (const message of messages) estimateTokens(message);
			});
			lines.push(
				`## ${target.toLocaleString("en-US")} token 历史（${messages.length} 条消息）`,
				`- 上下文估算（宿主启发式）：${messages.reduce((sum, message) => sum + estimateTokens(message), 0).toLocaleString("en-US")} tokens`,
				`- 原生摘要载荷：${Math.ceil(summaryText.length / 4).toLocaleString("en-US")} tokens (${summaryText.length.toLocaleString("en-US")} chars) [工具结果截断到约 2.4k 字符]`,
				`- CLM 维护载荷：${Math.ceil((JSON.stringify(llm).length + index.length) / 4).toLocaleString("en-US")} tokens [完整历史 + ${Math.ceil(index.length / 4).toLocaleString("en-US")} token 索引]`,
				`- 每次请求写出的 mirror 文档：${Math.ceil(document.text.length / 4).toLocaleString("en-US")} tokens (${document.text.length.toLocaleString("en-US")} chars)`,
				`- 本地 CPU：digestMessages=${digestMs}ms, JSON deep clone=${cloneMs}ms, mirror prepare(write)=${mirrorMs}ms, estimate all messages=${allEstimateMs}ms`,
				"",
			);
		}
		expect(lines.length).toBeGreaterThan(3);
	}, 180_000);
});
