import { createModels, fauxAssistantMessage, fauxProvider } from "@step-harness/providers";
import { describe, expect, it, vi } from "vitest";
import { generateBranchSummary } from "../../src/harness/compaction/branch-summarization.ts";
import { compact, generateSummaryWithUsage } from "../../src/harness/compaction/compaction.ts";
import { serializeConversation } from "../../src/harness/compaction/utils.ts";
import { convertToLlm } from "../../src/harness/messages.ts";
import type { AgentMessage } from "../../src/types.ts";

const messages: AgentMessage[] = [{ role: "user", content: "Preserve the parser contract.", timestamp: 1 }];

function setup(maxTokens = 65536) {
	const models = createModels();
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	const model = { ...faux.getModel(), contextWindow: 1048576, maxTokens };
	const complete = vi.spyOn(models, "completeSimple").mockResolvedValue(fauxAssistantMessage("Useful summary."));
	return { models, model, complete };
}

describe("harness summary requests", () => {
	it("omits thinking from the summary view without rewriting history", () => {
		const history = [
			...messages,
			fauxAssistantMessage([
				{ type: "thinking", thinking: "Replayed reasoning.", thinkingSignature: "signature" },
				{ type: "text", text: "Visible finding." },
				{ type: "toolCall", id: "read-parser", name: "read", arguments: { path: "parser.ts" } },
			]),
		];
		const original = structuredClone(history);
		const text = serializeConversation(convertToLlm(history));
		expect(text).not.toContain("Replayed reasoning.");
		expect(text).toContain("Visible finding.");
		expect(text).toContain('read(path="parser.ts")');
		expect(history).toEqual(original);
	});

	it.each([
		{ modelMax: 8192, reserve: 2000 },
		{ modelMax: 65536, reserve: 2000 },
		{ modelMax: 65536, reserve: 851968 },
	])("delegates history output sizing for model=$modelMax and reserve=$reserve", async ({ modelMax, reserve }) => {
		const { models, model, complete } = setup(modelMax);
		const result = await generateSummaryWithUsage(messages, models, model, reserve);
		expect(result.ok).toBe(true);
		expect(complete).toHaveBeenCalledTimes(1);
		expect(complete.mock.calls[0][2]).not.toHaveProperty("maxTokens");
	});

	it("delegates both split-turn output budgets to the provider", async () => {
		const { models, model, complete } = setup();
		const result = await compact(
			{
				messagesToSummarize: messages,
				turnPrefixMessages: messages,
				retainedTail: [],
				isSplitTurn: true,
				tokensBefore: 200000,
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
			},
			models,
			model,
		);
		expect(result.ok).toBe(true);
		expect(complete).toHaveBeenCalledTimes(2);
		for (const call of complete.mock.calls) expect(call[2]).not.toHaveProperty("maxTokens");
	});

	it("delegates branch-summary output sizing to the provider", async () => {
		const { models, model, complete } = setup();
		const result = await generateBranchSummary(
			[{ type: "message", id: "entry", parentId: null, seq: 1, timestamp: 1, message: messages[0] }],
			{ models, model, signal: new AbortController().signal },
		);
		expect(result.ok).toBe(true);
		expect(complete).toHaveBeenCalledTimes(1);
		expect(complete.mock.calls[0][2]).not.toHaveProperty("maxTokens");
	});
});
