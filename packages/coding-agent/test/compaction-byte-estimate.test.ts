import type { AgentMessage } from "@step-harness/agent-core";
import { type AssistantMessage, fauxAssistantMessage, textUtf8ByteLength } from "@step-harness/providers";
import { describe, expect, it } from "vitest";
import { LiveContextManager } from "../src/core/compaction/live-context/manager.ts";
import { createSummarySourceReducer } from "../src/core/compaction/summary-overflow.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const han = "构建失败：解析器在第四十二行抛出断言错误。";

describe("CLM working-context estimate", () => {
	it("prices a CJK system prompt by UTF-8 bytes", () => {
		const live = new LiveContextManager(SessionManager.inMemory());
		const systemPrompt = han.repeat(100);
		expect(live.estimate({ systemPrompt, messages: [], tools: [] })).toBe(
			Math.ceil((systemPrompt.length * 3) / 4) + 1,
		);
	});

	it("lets usage calibration correct an overestimate below 1 but not below 0.5", () => {
		const live = new LiveContextManager(SessionManager.inMemory());
		const context = { systemPrompt: "x".repeat(40_000), messages: [], tools: [] };
		const base = live.estimate(context);
		const report = (observed: number): void => {
			live.recordRequest(context, "faux/faux-1");
			const response: AssistantMessage = {
				...fauxAssistantMessage("ok"),
				provider: "faux",
				model: "faux-1",
				usage: { ...fauxAssistantMessage("ok").usage, input: observed, totalTokens: observed },
			};
			live.observeUsage(response);
		};
		report(Math.floor(base * 0.8));
		expect(live.estimate(context)).toBeLessThan(base);
		for (let i = 0; i < 50; i++) report(1);
		expect(live.estimate(context)).toBe(Math.ceil(base * 0.5));
	});
});

describe("summary source reduction", () => {
	it("accounts the remaining source by UTF-8 bytes", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: `旧请求 ${han.repeat(200)}`, timestamp: 1 },
			fauxAssistantMessage(`旧回答 ${han.repeat(200)}`),
			{ role: "user", content: "最新请求：继续修复解析器", timestamp: 3 },
			fauxAssistantMessage("最新回答"),
		];
		const seen: number[] = [];
		const reduce = createSummarySourceReducer(messages, (bytes) => {
			seen.push(bytes);
			return Math.ceil(bytes / 4);
		});
		expect(reduce).toBeDefined();
		const reduced = reduce?.(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
		expect(reduced).toBeDefined();
		expect(reduced).not.toContain("旧请求");
		// The estimator receives the exact byte size of the text it would send.
		expect(seen.at(-1)).toBe(textUtf8ByteLength(reduced ?? ""));
		expect(seen.at(-1)).toBeGreaterThan((reduced ?? "").length);
	});
});
