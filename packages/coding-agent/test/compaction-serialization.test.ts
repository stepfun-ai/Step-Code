import type { Message } from "@step-harness/providers";
import { describe, expect, it } from "vitest";
import { serializeConversation } from "../src/core/compaction/utils.ts";

describe("serializeConversation", () => {
	it("should truncate long tool results keeping head and tail", () => {
		const longContent = "x".repeat(5000);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: longContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toContain("[Tool result]:");
		expect(result).toContain("[... 3400 chars omitted (kept: 800-char head, 0 salient lines, 800-char tail) ...]");
		// Head and tail are preserved verbatim (800 chars each); the middle is omitted.
		expect(result.startsWith(`[Tool result]: ${"x".repeat(800)}\n[...`)).toBe(true);
		expect(result.endsWith("x".repeat(800))).toBe(true);
		expect(result).not.toContain("x".repeat(801));
	});

	it("keeps the trailing error line and salient middle lines of a long tool result", () => {
		// Long build output: unremarkable filler, one warning buried in the middle,
		// and the actual failure reported on the very last line.
		const headFiller = "aaaaaaaaaaaaaaaaaaa\n".repeat(45); // 900 chars, no salient matches
		const middleWarning = "src/build.log: warning: deprecated API usage\n";
		const middleFiller = "bbbbbbbbbbbbbbbbbbb\n".repeat(100); // 2000 chars, no salient matches
		const finalError = "Error: build failed with exit code 1";
		const longOutput = headFiller + middleWarning + middleFiller + finalError;

		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "bash",
				content: [{ type: "text", text: longOutput }],
				isError: true,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		// The tail is preserved verbatim, so the trailing error line survives
		// (the old head-only truncation dropped it).
		expect(result).toContain(finalError);
		expect(result.endsWith(finalError)).toBe(true);
		// The salient warning line from the omitted middle is re-surfaced.
		expect(result).toContain("[salient lines from omitted middle]");
		expect(result).toContain("src/build.log: warning: deprecated API usage");
		// The omission marker tells the summarizer what was kept.
		expect(result).toMatch(
			/\[\.\.\. \d+ chars omitted \(kept: 800-char head, 1 salient lines, 800-char tail\) \.\.\.\]/,
		);
		// The head is preserved verbatim.
		expect(result.startsWith("[Tool result]: aaaaaaaaaaaaaaaaaaa\n")).toBe(true);
	});

	it("re-surfaces python traceback and stack-frame lines from the omitted middle", () => {
		// None of the asserted lines match the generic error/fail/test keywords;
		// they are kept only by the stack-frame alternatives of SALIENT_LINE_PATTERN.
		const headFiller = "aaaaaaaaaaaaaaaaaaa\n".repeat(45); // 900 chars, no salient matches
		const pythonTraceback = [
			"Traceback (most recent call last):",
			'  File "/app/src/pipeline.py", line 88, in run_stage',
			"    stage.execute(batch)",
			'  File "/app/src/stage.py", line 41, in execute',
			"    raise RuntimeSignal(signum)",
		].join("\n");
		const nodeStackFrame = "    at runStage (/app/src/pipeline.ts:88:12)";
		const middleFiller = "bbbbbbbbbbbbbbbbbbb\n".repeat(60); // 1200 chars, no salient matches
		const tailFiller = "z".repeat(900);
		const longOutput = `${headFiller}${pythonTraceback}\n${nodeStackFrame}\n${middleFiller}${tailFiller}`;

		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "bash",
				content: [{ type: "text", text: longOutput }],
				isError: true,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toContain("chars omitted");
		expect(result).toContain("[salient lines from omitted middle]");
		expect(result).toContain("Traceback (most recent call last):");
		expect(result).toContain('File "/app/src/pipeline.py", line 88, in run_stage');
		expect(result).toContain('File "/app/src/stage.py", line 41, in execute');
		expect(result).toContain("at runStage (/app/src/pipeline.ts:88:12)");
	});

	it("should not truncate short tool results", () => {
		const shortContent = "x".repeat(1500);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: shortContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toBe(`[Tool result]: ${shortContent}`);
		expect(result).not.toContain("omitted");
	});

	it("should not truncate assistant or user messages", () => {
		const longText = "y".repeat(5000);
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: longText }],
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [{ type: "text", text: longText }],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).not.toContain("omitted");
		expect(result).toContain(longText);
	});
});
