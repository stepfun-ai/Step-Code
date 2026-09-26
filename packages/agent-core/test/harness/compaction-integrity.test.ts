import {
	type AssistantMessage,
	type Context,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@step-harness/providers";
import { describe, expect, it } from "vitest";
import { compact, generateSummary, prepareCompaction } from "../../src/harness/compaction/compaction.ts";
import { buildSessionContext } from "../../src/harness/session/context.ts";
import type { CompactionEntry, Entry } from "../../src/harness/session/types.ts";
import { getOrThrow } from "../../src/harness/types.ts";
import type { AgentMessage } from "../../src/types.ts";

const HISTORY_MARKER = "ORIGINAL_GOAL_VERIFY_AND_SUBMIT_9F13";
const PREVIOUS_SUMMARY = `## User Goal\n${HISTORY_MARKER}\n\nKeep the verified results and submission constraints.\n`;
const HISTORY_SUMMARY = `## User Goal\n${HISTORY_MARKER}\n\nThe earlier investigation is complete.`;
const PREFIX_SUMMARY = "## Next Actions\nInspect the retained output and run the regression test.";
const RETAINED_TEXT = "Retained investigation output. ".repeat(20);

type Layout = "history" | "prefix" | "history-and-prefix";

const emptyContents: { name: string; content: AssistantMessage["content"] }[] = [
	{ name: "empty array", content: [] },
	{ name: "empty text", content: [{ type: "text", text: "" }] },
	{ name: "thinking only", content: [{ type: "thinking", thinking: "I should write the handoff now." }] },
	{
		name: "whitespace text blocks",
		content: [
			{ type: "text", text: " \t\r\n" },
			{ type: "text", text: "\u00a0\u2003" },
		],
	},
	{
		name: "thinking and whitespace",
		content: [
			{ type: "thinking", thinking: "Preserve the original goal." },
			{ type: "text", text: "\n \t" },
		],
	},
];

const failureScenarios: {
	name: string;
	layout: Layout;
	previousSummary: boolean;
	validHistoryFirst: boolean;
	label: string;
}[] = [
	{ name: "history", layout: "history", previousSummary: true, validHistoryFirst: false, label: "Summarization" },
	{
		name: "history before a split turn",
		layout: "history-and-prefix",
		previousSummary: true,
		validHistoryFirst: false,
		label: "Summarization",
	},
	{
		name: "prefix after valid history",
		layout: "history-and-prefix",
		previousSummary: true,
		validHistoryFirst: true,
		label: "Turn prefix summarization",
	},
	{
		name: "prefix with previous summary",
		layout: "prefix",
		previousSummary: true,
		validHistoryFirst: false,
		label: "Turn prefix summarization",
	},
	{
		name: "prefix with no prior history",
		layout: "prefix",
		previousSummary: false,
		validHistoryFirst: false,
		label: "Turn prefix summarization",
	},
];

function createScenario(layout: Layout, previousSummary = true) {
	const models = createModels();
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	const prefix: AgentMessage[] = [
		{ role: "user", content: previousSummary ? "Continue the investigation." : HISTORY_MARKER, timestamp: 1 },
		fauxAssistantMessage(fauxToolCall("read", { path: "src/retained.ts" }, { id: "read-1" }), {
			stopReason: "toolUse",
			timestamp: 2,
		}),
		{
			role: "toolResult",
			toolCallId: "read-1",
			toolName: "read",
			content: [{ type: "text", text: "Previously inspected source." }],
			isError: false,
			timestamp: 3,
		},
	];
	if (layout === "history-and-prefix") {
		prefix.push({ role: "user", content: "Check the current turn.", timestamp: 4 });
	}
	const entries: Entry[] = previousSummary
		? [
				{
					type: "compaction",
					id: "previous",
					parentId: null,
					seq: 1,
					timestamp: 4,
					summary: PREVIOUS_SUMMARY,
					retainedTail: prefix,
					tokensBefore: 112000,
					details: { readFiles: ["src/old.ts"], modifiedFiles: ["src/fix.ts"] },
				},
			]
		: prefix.map((message, index) => ({
				type: "message",
				id: `prefix-${index}`,
				parentId: index === 0 ? null : `prefix-${index - 1}`,
				seq: index + 1,
				timestamp: message.timestamp,
				message,
			}));
	entries.push({
		type: "message",
		id: "tail",
		parentId: entries.at(-1)!.id,
		seq: entries.length + 1,
		timestamp: 5,
		message:
			layout === "history"
				? { role: "user", content: RETAINED_TEXT, timestamp: 5 }
				: fauxAssistantMessage(RETAINED_TEXT, { timestamp: 5 }),
	});
	const preparation = getOrThrow(
		prepareCompaction(entries, { enabled: true, reserveTokens: 16384, keepRecentTokens: 20 }),
	)!;
	expect(preparation).toBeDefined();
	expect(preparation.isSplitTurn).toBe(layout !== "history");
	expect(preparation.messagesToSummarize.length > 0).toBe(layout !== "prefix");
	expect(preparation.turnPrefixMessages.length > 0).toBe(layout !== "history");
	expect(preparation.fileOps.read.has("src/retained.ts")).toBe(true);
	return { models, faux, model: faux.getModel(), entries, preparation };
}

describe("harness compaction integrity", () => {
	// CP-01: exercise the real retained-tail preparation and context reconstruction.
	it("preserves the previous history when only a turn prefix needs summarizing", async () => {
		const { models, faux, model, entries, preparation } = createScenario("prefix");
		const requests: Context[] = [];
		faux.setResponses([
			(context) => {
				requests.push(context);
				return fauxAssistantMessage(PREFIX_SUMMARY);
			},
		]);
		expect(JSON.stringify(buildSessionContext(entries))).toContain(HISTORY_MARKER);

		const result = getOrThrow(await compact(preparation, models, model));

		expect(requests).toHaveLength(1);
		expect(JSON.stringify(requests)).not.toContain(HISTORY_MARKER);
		expect(result.summary).toContain(
			`${PREVIOUS_SUMMARY}\n\n---\n\n**Turn Context (split turn):**\n\n${PREFIX_SUMMARY}`,
		);
		expect(result.retainedTail).toHaveLength(1);
		expect(result.retainedTail[0]).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: RETAINED_TEXT }],
		});
		const checkpoint: CompactionEntry = {
			type: "compaction",
			id: "next",
			parentId: "tail",
			seq: 3,
			timestamp: 6,
			...result,
		};
		const context = buildSessionContext([...entries, checkpoint]);
		expect(context.messages[0]).toMatchObject({ role: "compactionSummary", summary: result.summary });
		expect(JSON.stringify(context)).toContain(HISTORY_MARKER);
		expect(context.messages.slice(1)).toEqual(preparation.retainedTail);
	});

	// CP-02: an error result carries no replacement checkpoint, even if another part or file metadata is nonempty.
	describe.each(failureScenarios)("$name", (scenario) => {
		it.each(emptyContents)("rejects $name before returning replacement context", async ({ content }) => {
			const { models, faux, model, entries, preparation } = createScenario(
				scenario.layout,
				scenario.previousSummary,
			);
			const beforeEntries = structuredClone(entries);
			const beforePreparation = structuredClone(preparation);
			const beforeContext = structuredClone(buildSessionContext(entries));
			faux.setResponses([
				...(scenario.validHistoryFirst ? [fauxAssistantMessage(HISTORY_SUMMARY)] : []),
				fauxAssistantMessage(content),
			]);

			const result = await compact(preparation, models, model, undefined, undefined, undefined, {
				enabled: true,
				maxRetries: 2,
				baseDelayMs: 0,
			});

			expect(result).toMatchObject({
				ok: false,
				error: { code: "summarization_failed", message: `${scenario.label} failed: empty summary` },
			});
			expect(result).not.toHaveProperty("value");
			expect(entries).toEqual(beforeEntries);
			expect(preparation).toEqual(beforePreparation);
			expect(buildSessionContext(entries)).toEqual(beforeContext);
			expect(JSON.stringify(beforeContext)).toContain(HISTORY_MARKER);
			expect(faux.state.callCount).toBe(scenario.validHistoryFirst ? 2 : 1);
		});
	});

	it.each(emptyContents)("rejects $name through the public generateSummary helper", async ({ content }) => {
		const { models, faux, model, preparation } = createScenario("history");
		faux.setResponses([fauxAssistantMessage(content)]);

		expect(await generateSummary(preparation.messagesToSummarize, models, model, 16384)).toMatchObject({
			ok: false,
			error: { code: "summarization_failed", message: "Summarization failed: empty summary" },
		});
	});

	it.each<Layout>(["history", "prefix", "history-and-prefix"])(
		"accepts valid %s summaries with file metadata",
		async (layout) => {
			const { models, faux, model, preparation } = createScenario(layout);
			const text = ` \n${layout === "prefix" ? PREFIX_SUMMARY : HISTORY_SUMMARY}\n `;
			faux.setResponses([
				fauxAssistantMessage([
					{ type: "thinking", thinking: "This reasoning is not part of the summary." },
					{ type: "text", text },
				]),
				...(layout === "history-and-prefix" ? [fauxAssistantMessage(PREFIX_SUMMARY)] : []),
			]);

			const result = getOrThrow(await compact(preparation, models, model));

			expect(result.summary).toContain(text);
			expect(result.summary).not.toContain("This reasoning is not part of the summary.");
			expect(result.summary).toContain("<read-files>\nsrc/old.ts\nsrc/retained.ts\n</read-files>");
			expect(result.summary).toContain("<modified-files>\nsrc/fix.ts\n</modified-files>");
			expect(result.summary).toContain(HISTORY_MARKER);
			expect(result.usage!.totalTokens).toBeGreaterThan(0);
			expect(result.retainedTail).toEqual(preparation.retainedTail);
			expect(faux.state.callCount).toBe(layout === "history-and-prefix" ? 2 : 1);
		},
	);

	describe.each<Layout>(["history", "prefix"])("%s failure diagnostics", (layout) => {
		it.each([
			{
				name: "partial length stop",
				response: fauxAssistantMessage("partial", { stopReason: "length" }),
				code: "summarization_failed",
				error: "summary is incomplete",
			},
			{
				name: "empty length stop",
				response: fauxAssistantMessage([], { stopReason: "length" }),
				code: "summarization_failed",
				error: "summary is incomplete",
			},
			{
				name: "provider error",
				response: fauxAssistantMessage([], { stopReason: "error", errorMessage: "insufficient_quota" }),
				code: "summarization_failed",
				error: "insufficient_quota",
			},
			{
				name: "abort",
				response: fauxAssistantMessage([], { stopReason: "aborted", errorMessage: "summary cancelled" }),
				code: "aborted",
				error: "summary cancelled",
			},
		])("preserves $name and the original context", async ({ response, code, error }) => {
			const { models, faux, model, entries, preparation } = createScenario(layout);
			const before = structuredClone(buildSessionContext(entries));
			faux.setResponses([response]);

			expect(await compact(preparation, models, model)).toMatchObject({
				ok: false,
				error: { code, message: expect.stringContaining(error) },
			});
			expect(buildSessionContext(entries)).toEqual(before);
			expect(faux.state.callCount).toBe(1);
		});
	});
});
