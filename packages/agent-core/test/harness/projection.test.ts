import type {
	Api,
	AssistantMessage,
	Message,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "@step-harness/providers";
import { describe, expect, it } from "vitest";
import {
	cutTextWithSalientLines,
	estimateProjectionTokens,
	PROJECTION_CUT_MARKER_PREFIX,
	PROJECTION_REPEAT_MARKER_PREFIX,
	PROJECTION_SUMMARY_MARKER_PREFIX,
	type ProjectionOptions,
	projectContextForRequest,
	shortContentHash,
	verifyProjectionInvariants,
} from "../../src/harness/compaction/projection.ts";

// ============================================================================
// Fixtures
// ============================================================================

let nextTimestamp = 1_000_000;
function ts(): number {
	return nextTimestamp++;
}

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: ts() };
}

function assistant(blocks: string | (TextContent | ThinkingContent | ToolCall)[]): AssistantMessage {
	return {
		role: "assistant",
		content: typeof blocks === "string" ? [{ type: "text", text: blocks }] : blocks,
		api: "anthropic-messages" as Api,
		provider: "anthropic",
		model: "test-model",
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp: ts(),
	};
}

function toolCall(id: string, name = "bash"): ToolCall {
	return { type: "toolCall", id, name, arguments: { command: "test" } };
}

function toolResult(id: string, text: string, options?: { toolName?: string; isError?: boolean }): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: options?.toolName ?? "bash",
		content: [{ type: "text", text }],
		isError: options?.isError ?? false,
		timestamp: ts(),
	};
}

/** Multi-line filler output with a salient error line buried in the middle. */
function bigOutput(lines: number, salientLine = "Error: build failed at src/main.ts:42"): string {
	const out: string[] = [];
	for (let i = 0; i < lines; i++) {
		out.push(
			i === Math.floor(lines / 2) ? salientLine : `plain filler output line number ${i} with some padding text`,
		);
	}
	return out.join("\n");
}

/** Options that force the trigger without engaging the aggressive cap pass. */
function triggeredOptions(overrides?: Partial<ProjectionOptions>): ProjectionOptions {
	return {
		contextWindow: 1_000_000,
		contextTokens: 600_000,
		keepRecentTokens: 10,
		...overrides,
	};
}

function textOf(message: Message): string {
	const content = message.content;
	if (typeof content === "string") return content;
	return content
		.map((block) => {
			if (block.type === "text") return block.text;
			if (block.type === "thinking") return block.thinking;
			return "";
		})
		.join("\n");
}

function deepFreeze(messages: Message[]): Message[] {
	for (const message of messages) {
		if (typeof message.content !== "string") {
			for (const block of message.content) Object.freeze(block);
			Object.freeze(message.content);
		}
		Object.freeze(message);
	}
	return messages;
}

// ============================================================================
// Trigger / passthrough behavior
// ============================================================================

describe("projectContextForRequest trigger", () => {
	it("returns the identical array reference below the soft threshold", () => {
		const messages = [user("hello"), assistant("hi"), user(bigOutput(200))];
		const { messages: projected, stats } = projectContextForRequest(messages, {
			contextWindow: 1_000_000,
			contextTokens: 100,
		});
		expect(projected).toBe(messages);
		expect(stats.applied).toBe(false);
		expect(stats.skippedReason).toBe("below-soft-threshold");
		expect(stats.originalTokens).toBe(100);
		expect(stats.projectedTokens).toBe(100);
		expect(Object.values(stats.byRule).every((count) => count === 0)).toBe(true);
	});

	it("passes through when no context window is provided", () => {
		const messages = [user("hello")];
		const { messages: projected, stats } = projectContextForRequest(messages);
		expect(projected).toBe(messages);
		expect(stats.skippedReason).toBe("no-context-window");
	});

	it("passes through empty message arrays", () => {
		const { messages: projected, stats } = projectContextForRequest([], triggeredOptions());
		expect(projected).toEqual([]);
		expect(stats.skippedReason).toBe("empty-messages");
	});

	it("reports no-reducible-content when triggered but nothing can be rewritten", () => {
		const messages = [user("short question"), assistant("short answer"), user("follow-up")];
		const { messages: projected, stats } = projectContextForRequest(messages, triggeredOptions());
		expect(projected).toBe(messages);
		expect(stats.applied).toBe(false);
		expect(stats.skippedReason).toBe("no-reducible-content");
	});

	it("uses the provided usage-based contextTokens for the trigger decision", () => {
		// Estimated tokens are tiny, but the caller-provided count crosses the threshold.
		const big = bigOutput(400);
		const messages = [user("q"), assistant([toolCall("t1")]), toolResult("t1", big), assistant("done"), user("next")];
		const below = projectContextForRequest(messages, { contextWindow: 1_000_000, contextTokens: 599_999 });
		expect(below.stats.skippedReason).toBe("below-soft-threshold");
		const above = projectContextForRequest(messages, triggeredOptions());
		expect(above.stats.applied).toBe(true);
	});
});

// ============================================================================
// Rule a: large toolResult / bashExecution cuts
// ============================================================================

describe("rule a: large tool result cuts", () => {
	it("cuts a large toolResult to head + tail + salient lines with a marker", () => {
		const big = bigOutput(400);
		const messages = [
			user("run the tests"),
			assistant([toolCall("t1")]),
			toolResult("t1", big),
			assistant("tests failed"),
			user("fix it"),
		];
		const { messages: projected, stats } = projectContextForRequest(messages, triggeredOptions());

		expect(stats.applied).toBe(true);
		expect(stats.byRule.tool_result_cuts).toBe(1);
		expect(stats.invariantsPassed).toBe(true);

		const cutText = textOf(projected[2]);
		expect(cutText).toContain(PROJECTION_CUT_MARKER_PREFIX);
		expect(cutText).toContain(`original_chars=${big.length}`);
		expect(cutText).toContain("plain filler output line number 0"); // head preserved
		expect(cutText).toContain("plain filler output line number 399"); // tail preserved
		expect(cutText).toContain("Error: build failed at src/main.ts:42"); // salient line preserved
		expect(cutText.length).toBeLessThan(big.length / 2);

		// Purity: the input message is untouched.
		expect(textOf(messages[2])).toBe(big);
	});

	it("cuts a large bashExecution-shaped user message", () => {
		const bash = `Ran \`npm test\`\n\`\`\`\n${bigOutput(300)}\n\`\`\``;
		const messages = [user("start"), user(bash), assistant("saw it"), user("continue")];
		const { messages: projected, stats } = projectContextForRequest(messages, triggeredOptions());
		expect(stats.byRule.tool_result_cuts).toBe(1);
		const cutText = textOf(projected[1]);
		expect(cutText).toContain(PROJECTION_CUT_MARKER_PREFIX);
		expect(cutText.startsWith("Ran `npm test`")).toBe(true);
	});

	it("leaves small tool results alone", () => {
		const messages = [
			user("q"),
			assistant([toolCall("t1")]),
			toolResult("t1", "short output"),
			assistant("a"),
			user("next"),
		];
		const { stats } = projectContextForRequest(messages, triggeredOptions());
		expect(stats.byRule.tool_result_cuts).toBe(0);
	});
});

// ============================================================================
// Rule b: repeated output folding
// ============================================================================

describe("rule b: repeated output folding", () => {
	it("folds middle duplicates, preserving the first and most recent full outputs", () => {
		const repeated = bigOutput(40, "FAIL src/app.test.ts > renders"); // identical output 3x
		const messages = [
			user("run tests"),
			assistant([toolCall("t1")]),
			toolResult("t1", repeated),
			assistant([toolCall("t2")]),
			toolResult("t2", repeated),
			assistant([toolCall("t3")]),
			toolResult("t3", repeated),
			assistant("same failure every time"),
			user("hm"),
		];
		const { messages: projected, stats } = projectContextForRequest(messages, triggeredOptions());

		expect(stats.byRule.dedup_folds).toBe(1);
		expect(textOf(projected[2])).toBe(repeated); // first stays full
		expect(textOf(projected[6])).toBe(repeated); // most recent stays full
		const folded = textOf(projected[4]);
		expect(folded.startsWith(PROJECTION_REPEAT_MARKER_PREFIX)).toBe(true);
		expect(folded).toContain("last full output at index 6");
		expect(folded.length).toBeLessThan(200);
	});

	it("does not fold outputs with different error flags", () => {
		const output = bigOutput(40);
		const messages = [
			user("go"),
			assistant([toolCall("t1")]),
			toolResult("t1", output, { isError: false }),
			assistant([toolCall("t2")]),
			toolResult("t2", output, { isError: true }),
			assistant([toolCall("t3")]),
			toolResult("t3", output, { isError: false }),
			assistant("done"),
			user("next"),
		];
		const { stats } = projectContextForRequest(messages, triggeredOptions());
		expect(stats.byRule.dedup_folds).toBe(0);
	});

	it("keeps both copies when an output only appears twice", () => {
		const output = bigOutput(40);
		const messages = [
			user("go"),
			assistant([toolCall("t1")]),
			toolResult("t1", output),
			assistant([toolCall("t2")]),
			toolResult("t2", output),
			assistant("done"),
			user("next"),
		];
		const { stats } = projectContextForRequest(messages, triggeredOptions());
		expect(stats.byRule.dedup_folds).toBe(0);
	});
});

// ============================================================================
// Rule c: historical thinking drops
// ============================================================================

describe("rule c: thinking drops", () => {
	it("keeps the most recent two thinking blocks and drops older ones with a marker", () => {
		const think = (n: number): ThinkingContent => ({ type: "thinking", thinking: `deliberation number ${n}` });
		const messages = [
			user("q1"),
			assistant([think(1), { type: "text", text: "answer one" }]),
			user("q2"),
			assistant([think(2), { type: "text", text: "answer two" }]),
			user("q3"),
			assistant([think(3), { type: "text", text: "answer three" }]),
			user("q4"),
			assistant([think(4), { type: "text", text: "answer four" }]),
			user("q5"),
		];
		const { messages: projected, stats } = projectContextForRequest(messages, triggeredOptions());

		expect(stats.byRule.thinking_drops).toBe(2);
		for (const index of [1, 3]) {
			const content = (projected[index] as AssistantMessage).content;
			expect(content.some((block) => block.type === "thinking")).toBe(false);
			expect(content.some((block) => block.type === "text" && block.text.includes("thinking elided"))).toBe(true);
			expect(content.some((block) => block.type === "text" && block.text.startsWith("answer"))).toBe(true);
		}
		for (const index of [5, 7]) {
			const content = (projected[index] as AssistantMessage).content;
			expect(content.some((block) => block.type === "thinking")).toBe(true);
		}
	});

	it("preserves tool calls when dropping thinking", () => {
		const messages = [
			user("q"),
			assistant([{ type: "thinking", thinking: "old thought" }, toolCall("t1")]),
			toolResult("t1", "ok"),
			assistant([
				{ type: "thinking", thinking: "recent 1" },
				{ type: "text", text: "a" },
			]),
			user("next"),
			assistant([
				{ type: "thinking", thinking: "recent 2" },
				{ type: "text", text: "b" },
			]),
			user("last"),
		];
		const { messages: projected, stats } = projectContextForRequest(messages, triggeredOptions());
		expect(stats.byRule.thinking_drops).toBe(1);
		const content = (projected[1] as AssistantMessage).content;
		expect(content.some((block) => block.type === "toolCall" && block.id === "t1")).toBe(true);
	});
});

// ============================================================================
// Rule d: repeated summary dedup
// ============================================================================

describe("rule d: summary dedup", () => {
	const summaryText = `The conversation history before this point was compacted into the following summary:\n\n<summary>\n## Goal\nShip the feature with all ${"tests ".repeat(60)}passing\n</summary>`;

	it("folds older identical summaries and keeps the newest", () => {
		const messages = [
			{ ...user(summaryText), timestamp: ts() },
			user("keep working"),
			assistant("ok"),
			{ ...user(summaryText), timestamp: ts() },
			assistant("continuing"),
			user("go on"),
		];
		const { messages: projected, stats } = projectContextForRequest(messages, triggeredOptions());
		expect(stats.byRule.summary_dedups).toBe(1);
		const folded = textOf(projected[0]);
		expect(folded.startsWith(PROJECTION_SUMMARY_MARKER_PREFIX)).toBe(true);
		expect(folded).toContain("retained at index 3");
		expect(textOf(projected[3])).toBe(summaryText);
	});

	it("does not fold different summaries", () => {
		const other = summaryText.replace("Ship the feature", "Refactor the module");
		const messages = [user(summaryText), assistant("ok"), user(other), assistant("ok"), user("next")];
		const { stats } = projectContextForRequest(messages, triggeredOptions());
		expect(stats.byRule.summary_dedups).toBe(0);
	});
});

// ============================================================================
// Rule e: large code / patch / JSON cuts
// ============================================================================

describe("rule e: large code/patch/JSON cuts", () => {
	it("cuts a large diff payload on line boundaries keeping diff headers salient", () => {
		const diffLines: string[] = ["diff --git a/src/app.ts b/src/app.ts", "@@ -1,80 +1,90 @@"];
		for (let i = 0; i < 300; i++) diffLines.push(`+       const value${i} = compute(${i});`);
		diffLines.push("@@ -200,10 +210,12 @@");
		for (let i = 0; i < 300; i++) diffLines.push(`-       legacy statement ${i} removed here;`);
		const diff = diffLines.join("\n");

		const messages = [user("apply this patch"), user(diff), assistant("applied"), user("now verify")];
		const { messages: projected, stats } = projectContextForRequest(messages, triggeredOptions());

		expect(stats.byRule.code_cuts).toBe(1);
		const cutText = textOf(projected[1]);
		expect(cutText).toContain(PROJECTION_CUT_MARKER_PREFIX);
		expect(cutText).toContain("diff --git a/src/app.ts b/src/app.ts");
		expect(cutText).toContain("@@ -200,10 +210,12 @@"); // structural line rescued from the middle
		expect(cutText.length).toBeLessThan(diff.length / 2);
	});

	it("cuts large JSON payloads", () => {
		const json = `{\n${Array.from({ length: 400 }, (_, i) => `  "key_${i}": "value ${i}",`).join("\n")}\n  "end": true\n}`;
		const messages = [user("here is the config"), user(json), assistant("read it"), user("next")];
		const { stats } = projectContextForRequest(messages, triggeredOptions());
		expect(stats.byRule.code_cuts).toBe(1);
	});

	it("leaves large prose user messages alone", () => {
		const prose = Array.from({ length: 300 }, (_, i) => `This is descriptive prose sentence ${i}.`).join(" ");
		const messages = [user("context:"), user(prose), assistant("ok"), user("next")];
		const { stats } = projectContextForRequest(messages, triggeredOptions());
		expect(stats.byRule.code_cuts).toBe(0);
	});
});

// ============================================================================
// Invariants
// ============================================================================

describe("projection invariants", () => {
	it("never touches the current user turn even when it is huge", () => {
		const bigUser = user(bigOutput(400));
		const messages = [user("old"), assistant("ok"), bigUser];
		const { messages: projected } = projectContextForRequest(messages, triggeredOptions());
		expect(projected[2]).toBe(bigUser);
		expect(textOf(projected[2])).toContain("plain filler output line number 399");
	});

	it("never touches the active tool-call group", () => {
		const big = bigOutput(400);
		const activeAssistant = assistant([toolCall("active")]);
		const activeResult = toolResult("active", big);
		const messages = [
			user("q"),
			assistant([toolCall("old")]),
			toolResult("old", big),
			user("continue"),
			activeAssistant,
			activeResult,
		];
		const { messages: projected, stats } = projectContextForRequest(messages, triggeredOptions());
		// Old result cut, active group untouched by reference.
		expect(stats.byRule.tool_result_cuts).toBe(1);
		expect(projected[4]).toBe(activeAssistant);
		expect(projected[5]).toBe(activeResult);
		expect(textOf(projected[5])).toBe(big);
		expect(textOf(projected[2])).toContain(PROJECTION_CUT_MARKER_PREFIX);
	});

	it("never touches the keepRecentTokens tail", () => {
		const big = bigOutput(400);
		const messages = [
			user("q"),
			assistant([toolCall("t1")]),
			toolResult("t1", big),
			assistant("mid"),
			user("more"),
			assistant([toolCall("t2")]),
			toolResult("t2", big),
			assistant("done"),
			user("latest"),
		];
		// Tail budget large enough to cover the second big result but not the first.
		const { messages: projected, stats } = projectContextForRequest(messages, {
			contextWindow: 1_000_000,
			contextTokens: 600_000,
			keepRecentTokens: Math.ceil(big.length / 4) + 50,
		});
		expect(stats.byRule.tool_result_cuts).toBe(1);
		expect(textOf(projected[2])).toContain(PROJECTION_CUT_MARKER_PREFIX);
		expect(projected[6]).toBe(messages[6]);
		expect(textOf(projected[6])).toBe(big);
	});

	it("keeps every answered tool call answered and does not mutate frozen inputs", () => {
		const messages = deepFreeze([
			user("q"),
			assistant([toolCall("t1")]),
			toolResult("t1", bigOutput(300)),
			assistant([toolCall("t2"), toolCall("t3")]),
			toolResult("t2", bigOutput(300)),
			toolResult("t3", "small"),
			assistant("done"),
			user("next"),
		]);
		const { messages: projected, stats } = projectContextForRequest(messages, triggeredOptions());
		expect(stats.applied).toBe(true);
		expect(stats.invariantsPassed).toBe(true);
		const answered = new Set(
			projected.filter((m) => m.role === "toolResult").map((m) => (m as ToolResultMessage).toolCallId),
		);
		expect(answered).toEqual(new Set(["t1", "t2", "t3"]));
		expect(projected.map((m) => m.role)).toEqual(messages.map((m) => m.role));
	});
});

describe("verifyProjectionInvariants fail-safe", () => {
	const original = [
		user("q"),
		assistant([toolCall("t1")]),
		toolResult("t1", "output"),
		assistant("done"),
		user("next"),
	];

	it("detects dropped messages", () => {
		expect(verifyProjectionInvariants(original, original.slice(0, -1), new Set(), 4)).toBe("message-count-changed");
	});

	it("detects modified protected messages", () => {
		const projected = original.slice();
		projected[2] = { ...(original[2] as ToolResultMessage), content: [{ type: "text", text: "tampered" }] };
		expect(verifyProjectionInvariants(original, projected, new Set([2]), 4)).toBe("protected-message-modified@2");
	});

	it("detects a modified current user turn", () => {
		const projected = original.slice();
		projected[4] = { ...(original[4] as UserMessage), content: "tampered" };
		expect(verifyProjectionInvariants(original, projected, new Set(), 4)).toBe("current-user-turn-modified");
	});

	it("detects removed tool-call blocks", () => {
		const projected = original.slice();
		projected[1] = { ...(original[1] as AssistantMessage), content: [{ type: "text", text: "no more call" }] };
		expect(verifyProjectionInvariants(original, projected, new Set(), 4)).toBe("tool-calls-modified@1");
	});

	it("detects tool-result identity changes", () => {
		const projected = original.slice();
		projected[2] = { ...(original[2] as ToolResultMessage), toolCallId: "other" };
		expect(verifyProjectionInvariants(original, projected, new Set(), 4)).toBe("tool-result-identity-changed@2");
	});

	it("accepts a faithful projection", () => {
		const projected = original.slice();
		projected[2] = { ...(original[2] as ToolResultMessage), content: [{ type: "text", text: "trimmed" }] };
		expect(verifyProjectionInvariants(original, projected, new Set([0, 1]), 4)).toBeUndefined();
	});
});

// ============================================================================
// Stats and budget
// ============================================================================

describe("projection stats", () => {
	it("reports consistent token/char accounting and per-rule counts", () => {
		const repeated = bigOutput(50);
		const summary = `The following is a summary of a branch that this conversation came back from:\n\n<summary>\nbranch work ${"details ".repeat(50)}\n</summary>`;
		const messages = [
			user("goal"),
			user(summary),
			assistant([
				{ type: "thinking", thinking: "early thinking" },
				{ type: "text", text: "plan" },
			]),
			assistant([toolCall("t1")]),
			toolResult("t1", bigOutput(400)),
			user(summary),
			assistant([toolCall("t2")]),
			toolResult("t2", repeated),
			assistant([toolCall("t3")]),
			toolResult("t3", repeated),
			assistant([toolCall("t4")]),
			toolResult("t4", repeated),
			assistant([
				{ type: "thinking", thinking: "mid thinking" },
				{ type: "text", text: "progress" },
			]),
			assistant([
				{ type: "thinking", thinking: "recent thinking" },
				{ type: "text", text: "wrap" },
			]),
			assistant([
				{ type: "thinking", thinking: "freshest thinking" },
				{ type: "text", text: "done" },
			]),
			user("final user turn"),
		];
		const { stats } = projectContextForRequest(messages, triggeredOptions());

		expect(stats.applied).toBe(true);
		expect(stats.invariantsPassed).toBe(true);
		expect(stats.byRule.tool_result_cuts).toBe(1);
		expect(stats.byRule.dedup_folds).toBe(1);
		expect(stats.byRule.summary_dedups).toBe(1);
		expect(stats.byRule.thinking_drops).toBeGreaterThanOrEqual(2);
		expect(stats.originalTokens).toBe(600_000);
		expect(stats.projectedTokens).toBeLessThan(stats.originalTokens);
		expect(stats.projectedChars).toBeLessThan(stats.originalChars);
		const savedTokens = stats.originalTokens - stats.projectedTokens;
		expect(savedTokens).toBeGreaterThan(0);
		expect(savedTokens).toBeLessThanOrEqual(stats.originalChars - stats.projectedChars);
	});

	it("runs the aggressive pass only while above the cap", () => {
		const messages = [
			user("q"),
			assistant([toolCall("t1")]),
			toolResult("t1", bigOutput(400)),
			assistant("d"),
			user("n"),
		];
		const relaxed = projectContextForRequest(messages, triggeredOptions());
		expect(relaxed.stats.aggressivePass).toBe(false);

		// Saved tokens are tiny relative to the reported context, so the cap stays exceeded.
		const pressured = projectContextForRequest(messages, {
			contextWindow: 1_000_000,
			contextTokens: 990_000,
			keepRecentTokens: 10,
		});
		expect(pressured.stats.aggressivePass).toBe(true);
		expect(pressured.stats.applied).toBe(true);
	});
});

// ============================================================================
// cutTextWithSalientLines unit behavior
// ============================================================================

describe("cutTextWithSalientLines", () => {
	it("returns undefined when cutting would not pay off", () => {
		expect(cutTextWithSalientLines("short text", 800, 800, 20, /error/i)).toBeUndefined();
	});

	it("caps and deduplicates salient lines", () => {
		const lines: string[] = [];
		for (let i = 0; i < 200; i++) lines.push(`filler line ${i} with enough padding to make the text long`);
		for (let i = 0; i < 50; i++) lines.push("error: identical failure line");
		for (let i = 0; i < 200; i++) lines.push(`more filler line ${i} with enough padding to make the text long`);
		const result = cutTextWithSalientLines(lines.join("\n"), 400, 400, 20, /error/i);
		expect(result).toBeDefined();
		const occurrences = result?.text.split("error: identical failure line").length ?? 0;
		expect(occurrences - 1).toBe(1); // deduplicated to a single salient line
		expect(result?.salientLines).toBe(1);
	});

	it("reports accurate original_chars in the marker", () => {
		const text = bigOutput(300);
		const result = cutTextWithSalientLines(text, 400, 400, 20, /error/i);
		expect(result?.text).toContain(`original_chars=${text.length}`);
	});
});

// ============================================================================
// Misc helpers
// ============================================================================

describe("helpers", () => {
	it("shortContentHash is deterministic and 16 hex chars", () => {
		const a = shortContentHash("some content");
		expect(a).toBe(shortContentHash("some content"));
		expect(a).toMatch(/^[0-9a-f]{16}$/);
		expect(a).not.toBe(shortContentHash("other content"));
	});

	it("estimateProjectionTokens scales with content size", () => {
		const small = estimateProjectionTokens([user("tiny")]);
		const large = estimateProjectionTokens([user(bigOutput(100))]);
		expect(large).toBeGreaterThan(small);
	});
});
