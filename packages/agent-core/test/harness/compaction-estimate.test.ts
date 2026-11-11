import type { AssistantMessage } from "@step-harness/providers";
import { describe, expect, it } from "vitest";
import { estimateTokens } from "../../src/harness/compaction/compaction.ts";
import { estimateMessageTokens } from "../../src/harness/compaction/projection-content.ts";

const han = "构建失败：解析器在第四十二行抛出断言错误";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "faux",
		provider: "faux",
		model: "faux-1",
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
	};
}

describe("harness token estimate", () => {
	it("keeps ASCII messages at four characters per token", () => {
		expect(estimateTokens({ role: "user", content: "a".repeat(400), timestamp: 1 })).toBe(100);
	});

	it("prices CJK text by UTF-8 bytes", () => {
		const text = han.repeat(10);
		expect(estimateTokens({ role: "user", content: text, timestamp: 1 })).toBe(Math.ceil((text.length * 3) / 4));
	});

	it("prices assistant text, thinking and tool arguments by bytes", () => {
		const message = assistant([
			{ type: "text", text: han },
			{ type: "thinking", thinking: han },
			{ type: "toolCall", id: "1", name: "run", arguments: { command: han } },
		]);
		expect(estimateTokens(message)).toBeGreaterThan(Math.ceil((han.length * 3 * 3) / 4) - 1);
	});

	it("keeps the fixed image estimate", () => {
		expect(
			estimateTokens({
				role: "user",
				content: [{ type: "image", mimeType: "image/png", data: "x" }],
				timestamp: 1,
			}),
		).toBe(1200);
	});

	it("prices bash output by bytes", () => {
		expect(
			estimateTokens({
				role: "bashExecution",
				command: "cat",
				output: han,
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 1,
			}),
		).toBe(Math.ceil(3 / 4) + Math.ceil((han.length * 3) / 4));
	});

	it("uses the same byte pricing in the lightweight projection", () => {
		const text = han.repeat(10);
		expect(estimateMessageTokens({ role: "user", content: text, timestamp: 1 })).toBe(
			Math.ceil((text.length * 3) / 4),
		);
	});
});
