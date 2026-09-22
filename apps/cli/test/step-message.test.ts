import type { AssistantMessage } from "@step-harness/providers";
import { resetCapabilitiesCache, setCapabilities, stripTerminalSequences, visibleWidth } from "@step-harness/pi-tui";
import { afterEach, describe, expect, test } from "vitest";
import {
	StepAssistantMessageComponent,
	StepUserMessageComponent,
} from "../src/ui/view/transcript/step-message.ts";
import { getMarkdownTheme, initTheme, theme } from "../../../packages/coding-agent/src/theme/theme.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

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
		timestamp: Date.now(),
	};
}

function plain(lines: string[]): string[] {
	return lines.map((line) => stripTerminalSequences(line).trimEnd());
}

describe("Step message presentation", () => {
	afterEach(() => {
		resetCapabilitiesCache();
	});

	test("keeps thinking and answer as separate Step bullets", () => {
		initTheme("step-blue");
		const component = new StepAssistantMessageComponent(
			assistantMessage([
				{ type: "thinking", thinking: "first thought" },
				{ type: "text", text: "the answer" },
			]),
			false,
			getMarkdownTheme(),
		);
		const lines = plain(component.render(80));
		const thinking = lines.findIndex((line) => line.includes("• thinking"));
		const thought = lines.findIndex((line) => line.includes("first thought"));
		const answer = lines.findIndex((line) => line.includes("• the answer"));
		expect(thinking).toBeGreaterThanOrEqual(0);
		expect(thought).toBeGreaterThan(thinking);
		expect(answer).toBeGreaterThan(thought);
	});

	test("collapses reasoning to three rows and expands through setExpanded", () => {
		initTheme("step-blue");
		const reasoning = Array.from({ length: 8 }, (_, index) => `thought ${index}`).join("\n");
		const component = new StepAssistantMessageComponent(
			assistantMessage([
				{ type: "thinking", thinking: reasoning },
				{ type: "text", text: "answer" },
			]),
			false,
			getMarkdownTheme(),
		);
		const collapsed = plain(component.render(100)).join("\n");
		expect(collapsed).toContain("thought 0");
		expect(collapsed).toContain("thought 2");
		expect(collapsed).not.toContain("thought 5");
		expect(collapsed).toContain("+5 lines (ctrl+o to expand)");

		component.setExpanded(true);
		const expanded = plain(component.render(100)).join("\n");
		expect(expanded).toContain("thought 7");
		expect(expanded).not.toContain("ctrl+o to expand");
	});

	test("hides only complete fences and leaves an incomplete stream literal", () => {
		initTheme("step-blue");
		const complete = new StepAssistantMessageComponent(
			assistantMessage([{ type: "text", text: "```ts\nconst value = 1;\n```" }]),
			false,
			getMarkdownTheme(),
		);
		const completeLines = plain(complete.render(80)).join("\n");
		expect(completeLines).toContain("ts");
		expect(completeLines).toContain("const value = 1;");
		expect(completeLines).not.toContain("```");

		const incomplete = new StepAssistantMessageComponent(
			assistantMessage([{ type: "text", text: "```ts\nconst value = 1;" }]),
			false,
			getMarkdownTheme(),
		);
		expect(plain(incomplete.render(80)).join("\n")).toContain("```ts");
	});

	test("uses the same complete-fence presentation for user messages", () => {
		initTheme("step-blue");
		const component = new StepUserMessageComponent("说明\n\n```ts\nconst value = 1;\n```", getMarkdownTheme());
		const rawLines = component.render(80);
		const lines = plain(rawLines);
		const text = lines.join("\n");
		const rawText = rawLines.join("\n");
		expect(text).toContain("› 说明");
		expect(rawText).toContain(theme.getBgAnsi("userMessageBg"));
		expect(rawText).toContain(theme.getFgAnsi("userMessageText"));
		expect(text).toContain("  ts");
		expect(text).toContain("    const value = 1;");
		expect(text).not.toContain("```");
	});

	test("retains Pi OSC 133 markers while adding Step gutters", () => {
		initTheme("step-blue");
		const assistant = new StepAssistantMessageComponent(
			assistantMessage([{ type: "text", text: "hello" }]),
			false,
			getMarkdownTheme(),
		);
		const assistantLines = assistant.render(40);
		expect(assistantLines.join("\n")).toContain(OSC133_ZONE_START);
		expect(assistantLines.join("\n")).toContain(OSC133_ZONE_END + OSC133_ZONE_FINAL);

		const user = new StepUserMessageComponent("hello", getMarkdownTheme());
		const userLines = user.render(40);
		expect(userLines.join("\n")).toContain(OSC133_ZONE_START);
		expect(userLines.join("\n")).toContain(OSC133_ZONE_END + OSC133_ZONE_FINAL);
	});

	test("keeps Step gutters outside OSC-8 hyperlinks", () => {
		// OSC-8 is intentionally disabled for unknown/headless terminals. This
		// test exercises the enabled path explicitly so it remains deterministic
		// on CI runners as well as in a real terminal.
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		initTheme("step-blue");
		const component = new StepAssistantMessageComponent(
			assistantMessage([{ type: "text", text: "[open docs](https://example.com/docs)" }]),
			false,
			getMarkdownTheme(),
		);
		const rendered = component.render(80).join("\n");
		const opener = rendered.indexOf("\x1b]8;;https://example.com/docs");
		const bullet = rendered.indexOf("•");
		expect(opener).toBeGreaterThanOrEqual(0);
		expect(bullet).toBeGreaterThanOrEqual(0);
		expect(bullet).toBeLessThan(opener);
		expect(stripTerminalSequences(rendered)).toContain("• open docs");
	});

	test("preserves boundaries for alternating thinking and answer runs", () => {
		initTheme("step-blue");
		const component = new StepAssistantMessageComponent(
			assistantMessage([
				{ type: "thinking", thinking: "first reasoning" },
				{ type: "text", text: "first answer" },
				{ type: "thinking", thinking: "follow-up reasoning" },
				{ type: "text", text: "final answer" },
			]),
			false,
			getMarkdownTheme(),
		);
		const lines = plain(component.render(80));
		expect(lines.filter((line) => line === "• thinking")).toHaveLength(2);
		expect(lines).toContain("• first answer");
		expect(lines).toContain("• final answer");
		const followUpThinking = lines.indexOf("  follow-up reasoning");
		const finalAnswer = lines.indexOf("• final answer");
		expect(followUpThinking).toBeGreaterThan(lines.indexOf("• first answer"));
		expect(finalAnswer).toBeGreaterThan(followUpThinking);
	});

	test("updates output padding without dropping the first character", () => {
		initTheme("step-blue");
		const assistant = new StepAssistantMessageComponent(
			assistantMessage([{ type: "text", text: "hello" }]),
			false,
			getMarkdownTheme(),
			"Thinking...",
			1,
		);
		assistant.setOutputPad(0);
		expect(plain(assistant.render(40)).join("\n")).toContain("hello");

		const user = new StepUserMessageComponent("hello", getMarkdownTheme(), 1);
		user.setOutputPad(0);
		expect(plain(user.render(40)).join("\n")).toContain("› hello");
	});

	test("reuses assistant rows until the message or its display state changes", () => {
		initTheme("step-blue");
		const component = new StepAssistantMessageComponent(
			assistantMessage([
				{ type: "thinking", thinking: "a thought" },
				{ type: "text", text: "the answer" },
			]),
			false,
			getMarkdownTheme(),
		);

		const cached = component.render(80);
		expect(component.render(80)).toBe(cached);
		expect(component.render(60)).not.toBe(cached);

		const beforeExpand = component.render(80);
		component.setExpanded(true);
		expect(component.render(80)).not.toBe(beforeExpand);

		const beforeHide = component.render(80);
		component.setHideThinkingBlock(true);
		const hidden = component.render(80);
		expect(hidden).not.toBe(beforeHide);
		expect(plain(hidden).join("\n")).not.toContain("a thought");

		component.updateContent(assistantMessage([{ type: "text", text: "streamed answer" }]), true);
		const streamed = component.render(80);
		expect(streamed).not.toBe(hidden);
		expect(plain(streamed).join("\n")).toContain("• streamed answer");

		component.invalidate();
		expect(component.render(80)).not.toBe(streamed);
	});

	test("drops the OSC 133 markers when a tool call joins an already-rendered message", () => {
		initTheme("step-blue");
		const answer = { type: "text", text: "the answer" } as const;
		const component = new StepAssistantMessageComponent(assistantMessage([answer]), false, getMarkdownTheme());

		expect(component.render(80).join("\n")).toContain(OSC133_ZONE_START);

		// Pi's runs ignore toolCall content, so the rows and the run sources are
		// unchanged - only latestMessage moves, and render() reads it for the
		// prompt-zone markers.
		component.updateContent(
			assistantMessage([answer, { type: "toolCall", id: "call-1", name: "read", arguments: {} }]),
			true,
		);
		expect(component.render(80).join("\n")).not.toContain(OSC133_ZONE_START);
	});

	test("re-renders a code block when only the closing fence arrives", () => {
		initTheme("step-blue");
		const streamed = (text: string) => assistantMessage([{ type: "text", text }]);
		const component = new StepAssistantMessageComponent(
			streamed("```ts\nconst value = 1;"),
			true,
			getMarkdownTheme(),
		);

		const open = component.render(80);
		expect(plain(open).join("\n")).toContain("```ts");

		// Pi renders the unterminated fence as a finished code block, so the closing
		// delta leaves every native row identical; only the run source moves, and
		// hideCompleteFences reads that source.
		component.updateContent(streamed("```ts\nconst value = 1;\n```"), true);
		expect(plain(component.render(80)).join("\n")).not.toContain("```");
	});

	test("re-renders the pi status row that no run source reflects", () => {
		initTheme("step-blue");
		const answered = assistantMessage([{ type: "text", text: "partial answer" }]);
		const component = new StepAssistantMessageComponent(answered, false, getMarkdownTheme());

		expect(plain(component.render(80)).join("\n")).not.toContain("Operation aborted");

		// Aborting leaves the text run, its source and the width untouched; the only
		// thing that moves is the status row pi appends.
		component.updateContent({ ...answered, stopReason: "aborted" }, false);
		expect(plain(component.render(80)).join("\n")).toContain("Operation aborted");
	});

	test("reuses user rows until output padding changes", () => {
		initTheme("step-blue");
		const component = new StepUserMessageComponent("hello", getMarkdownTheme(), 1);

		const cached = component.render(40);
		expect(component.render(40)).toBe(cached);

		// Pi indents by the pad and Step takes exactly that back, so the rows never
		// move; what is worth pinning is that setOutputPad still drops the cache.
		component.setOutputPad(0);
		expect(component.render(40)).not.toBe(cached);
	});

	test("keeps every assistant row within the requested width", () => {
		initTheme("step-blue");
		const component = new StepAssistantMessageComponent(
			assistantMessage([
				{ type: "thinking", thinking: "想一想\n再想想" },
				{ type: "text", text: "回答" },
			]),
			false,
			getMarkdownTheme(),
		);
		for (const width of [8, 12, 20, 40]) {
			for (const line of component.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});
});
