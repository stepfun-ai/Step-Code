import type { AssistantMessage, Context } from "@step-harness/providers";
import { fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareCompaction } from "../../../src/core/compaction/compaction.ts";
import { createHarness, type Harness } from "../harness.ts";

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

describe("compaction integrity", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function seedSession(layout: Layout, previousSummary = true): Promise<Harness> {
		const harness = await createHarness({
			settings: {
				compaction: { keepRecentTokens: 20 },
				retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 },
			},
		});
		harnesses.push(harness);
		const firstKeptEntryId = harness.sessionManager.appendMessage({
			role: "user",
			content: previousSummary ? "Continue the investigation." : HISTORY_MARKER,
			timestamp: 1,
		});
		harness.sessionManager.appendMessage(
			fauxAssistantMessage(fauxToolCall("read", { path: "src/retained.ts" }, { id: "read-1" }), {
				stopReason: "toolUse",
				timestamp: 2,
			}),
		);
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "read-1",
			toolName: "read",
			content: [{ type: "text", text: "Previously inspected source." }],
			isError: false,
			timestamp: 3,
		});
		if (layout === "history-and-prefix") {
			harness.sessionManager.appendMessage({ role: "user", content: "Check the current turn.", timestamp: 4 });
		}
		if (previousSummary) {
			harness.sessionManager.appendCompaction(PREVIOUS_SUMMARY, firstKeptEntryId, 112000, {
				readFiles: ["src/old.ts"],
				modifiedFiles: ["src/fix.ts"],
			});
		}
		harness.sessionManager.appendMessage(
			layout === "history"
				? { role: "user", content: RETAINED_TEXT, timestamp: 5 }
				: fauxAssistantMessage(RETAINED_TEXT, { timestamp: 5 }),
		);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		const preparation = prepareCompaction(
			harness.sessionManager.getBranch(),
			harness.settingsManager.getCompactionSettings(),
		);
		expect(preparation).toBeDefined();
		expect(preparation!.isSplitTurn).toBe(layout !== "history");
		expect(preparation!.messagesToSummarize.length > 0).toBe(layout !== "prefix");
		expect(preparation!.turnPrefixMessages.length > 0).toBe(layout !== "history");
		expect(preparation!.fileOps.read.has("src/retained.ts")).toBe(true);
		return harness;
	}

	function captureSession(harness: Harness) {
		return {
			entries: structuredClone(harness.sessionManager.getEntries()),
			context: structuredClone(harness.sessionManager.buildSessionContext()),
			messages: structuredClone(harness.session.messages),
			leafId: harness.sessionManager.getLeafId(),
		};
	}

	// CP-01: the marker exists only in the previous checkpoint, outside the retained messages.
	it("preserves previous history through prepare, split-turn compaction, and context reload", async () => {
		const harness = await seedSession("prefix");
		const requests: Context[] = [];
		harness.setResponses([
			(context) => {
				requests.push(context);
				return fauxAssistantMessage(PREFIX_SUMMARY);
			},
		]);
		const firstKeptEntryId = harness.sessionManager.getLeafId();
		expect(JSON.stringify(harness.session.messages)).toContain(HISTORY_MARKER);

		const result = await harness.session.compact();

		expect(requests).toHaveLength(1);
		expect(JSON.stringify(requests)).not.toContain(HISTORY_MARKER);
		expect(result.summary).toContain(
			`${PREVIOUS_SUMMARY}\n\n---\n\n**Turn Context (split turn):**\n\n${PREFIX_SUMMARY}`,
		);
		expect(result.firstKeptEntryId).toBe(firstKeptEntryId);
		expect(result.details).toEqual({ readFiles: ["src/old.ts", "src/retained.ts"], modifiedFiles: ["src/fix.ts"] });
		expect(harness.session.messages[0]).toMatchObject({ role: "compactionSummary", summary: result.summary });
		expect(JSON.stringify(harness.session.messages)).toContain(HISTORY_MARKER);
		expect(harness.session.messages).toEqual(harness.sessionManager.buildSessionContext().messages);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(2);
	});

	// CP-02: validate each generated part before history, split-turn scaffolding, or file metadata can mask it.
	describe.each(failureScenarios)("$name", (scenario) => {
		it.each(emptyContents)(
			"rejects $name without replacing context or appending a checkpoint",
			async ({ content }) => {
				const harness = await seedSession(scenario.layout, scenario.previousSummary);
				const before = captureSession(harness);
				const messages = harness.session.messages;
				const appendCompaction = vi.spyOn(harness.sessionManager, "appendCompaction");
				harness.setResponses([
					...(scenario.validHistoryFirst ? [fauxAssistantMessage(HISTORY_SUMMARY)] : []),
					fauxAssistantMessage(content),
				]);

				await expect(harness.session.compact()).rejects.toThrow(`${scenario.label} failed: empty summary`);

				expect(appendCompaction).not.toHaveBeenCalled();
				expect(captureSession(harness)).toEqual(before);
				expect(harness.session.messages).toBe(messages);
				expect(JSON.stringify(harness.session.messages)).toContain(HISTORY_MARKER);
				expect(harness.faux.state.callCount).toBe(scenario.validHistoryFirst ? 2 : 1);
				expect(harness.eventsOfType("summarization_retry_scheduled")).toHaveLength(0);
				expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage: expect.stringContaining("empty summary"),
				});
			},
		);
	});

	// Without file metadata, these cases previously produced "" or only the fixed split-turn boilerplate.
	it.each<Layout>(["history", "prefix"])("keeps context after an empty automatic %s compaction", async (layout) => {
		const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 20 } } });
		harnesses.push(harness);
		harness.sessionManager.appendMessage({ role: "user", content: HISTORY_MARKER, timestamp: 1 });
		if (layout === "history") {
			harness.sessionManager.appendMessage(
				fauxAssistantMessage("Investigated the original goal.", { timestamp: 2 }),
			);
		}
		harness.sessionManager.appendMessage(
			layout === "history"
				? { role: "user", content: RETAINED_TEXT, timestamp: 3 }
				: fauxAssistantMessage(RETAINED_TEXT, { timestamp: 3 }),
		);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		const before = captureSession(harness);
		const messages = harness.session.messages;
		const appendCompaction = vi.spyOn(harness.sessionManager, "appendCompaction");
		harness.setResponses([fauxAssistantMessage([])]);
		const session = harness.session as unknown as {
			_runAutoCompaction(reason: "threshold", willRetry: boolean): Promise<boolean>;
		};

		await expect(session._runAutoCompaction("threshold", false)).resolves.toBe(false);

		expect(appendCompaction).not.toHaveBeenCalled();
		expect(captureSession(harness)).toEqual(before);
		expect(harness.session.messages).toBe(messages);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "threshold",
			result: undefined,
			aborted: false,
			willRetry: false,
			errorMessage: expect.stringContaining("empty summary"),
		});
	});

	it.each<Layout>(["history", "prefix", "history-and-prefix"])(
		"persists valid %s summaries with file metadata",
		async (layout) => {
			const harness = await seedSession(layout);
			const text = ` \n${layout === "prefix" ? PREFIX_SUMMARY : HISTORY_SUMMARY}\n `;
			harness.setResponses([
				fauxAssistantMessage([
					{ type: "thinking", thinking: "This reasoning is not part of the summary." },
					{ type: "text", text },
				]),
				...(layout === "history-and-prefix" ? [fauxAssistantMessage(PREFIX_SUMMARY)] : []),
			]);

			const result = await harness.session.compact();

			expect(result.summary).toContain(text);
			expect(result.summary).not.toContain("This reasoning is not part of the summary.");
			expect(result.summary).toContain("<read-files>\nsrc/old.ts\nsrc/retained.ts\n</read-files>");
			expect(result.summary).toContain("<modified-files>\nsrc/fix.ts\n</modified-files>");
			expect(result.usage!.totalTokens).toBeGreaterThan(0);
			expect(harness.faux.state.callCount).toBe(layout === "history-and-prefix" ? 2 : 1);
			expect(harness.session.messages[0]).toMatchObject({ role: "compactionSummary", summary: result.summary });
			expect(JSON.stringify(harness.session.messages)).toContain(HISTORY_MARKER);
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(2);
		},
	);

	describe.each<Layout>(["history", "prefix"])("%s failure diagnostics", (layout) => {
		it.each([
			{
				name: "partial length stop",
				response: fauxAssistantMessage("partial", { stopReason: "length" }),
				error: "generation hit the token cap",
			},
			{
				name: "empty length stop",
				response: fauxAssistantMessage([], { stopReason: "length" }),
				error: "generation hit the token cap",
			},
			{
				name: "provider error",
				response: fauxAssistantMessage([], { stopReason: "error", errorMessage: "insufficient_quota" }),
				error: "insufficient_quota",
			},
		])("preserves $name and the original context", async ({ response, error }) => {
			const harness = await seedSession(layout);
			const before = captureSession(harness);
			harness.setResponses([response]);

			await expect(harness.session.compact()).rejects.toThrow(error);

			expect(captureSession(harness)).toEqual(before);
			expect(harness.faux.state.callCount).toBe(1);
			expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
				result: undefined,
				aborted: false,
				errorMessage: expect.stringContaining(error),
			});
		});

		it("preserves cancellation when the aborted response has no text", async () => {
			const harness = await seedSession(layout);
			const before = captureSession(harness);
			harness.setResponses([
				() => {
					harness.session.abortCompaction();
					return fauxAssistantMessage([], { stopReason: "aborted" });
				},
			]);

			await expect(harness.session.compact()).rejects.toThrow();

			expect(captureSession(harness)).toEqual(before);
			expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
				result: undefined,
				aborted: true,
				errorMessage: undefined,
			});
		});
	});
});
