import { describe, expect, test } from "vitest";
import { annotateTranscriptRows } from "../src/step/feedback/row-metrics.ts";

/**
 * The transcript inside a feedback bundle carries each row's own numbers: the
 * tokens that request was billed for, its cache hit rate, and how long it took.
 *
 * Only the bundle copy is annotated. The canonical session file on disk is not
 * rewritten, so a support report never grows the user's session.
 */

function line(value: unknown): string {
	return JSON.stringify(value);
}

function transcript(): string {
	const entries = [
		{ type: "session", id: "s1", timestamp: "2026-10-23T00:00:00.000Z", cwd: "/w" },
		{ id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "fix it" }] } },
		{
			id: "a1",
			type: "message",
			message: {
				role: "assistant",
				provider: "step",
				model: "step-5",
				api: "openai-completions",
				stopReason: "toolUse",
				timestamp: 1000,
				content: [{ type: "toolCall", id: "call-1", name: "read_file", arguments: {} }],
				usage: {
					input: 1000,
					output: 200,
					cacheRead: 3000,
					cacheWrite: 0,
					totalTokens: 4200,
					cost: { total: 0.02 },
				},
			},
		},
		{
			id: "t1",
			type: "message",
			message: { role: "toolResult", toolCallId: "call-1", toolName: "read_file", isError: false, timestamp: 1350 },
		},
		{
			type: "custom",
			customType: "step.usage_provenance",
			data: {
				requestId: "req-1",
				usageEntryId: "a1",
				requestedProvider: "step",
				requestedModel: "step-5",
				durationMs: 2500,
				ttftMs: 640,
				outcome: "ok",
			},
		},
		{
			type: "custom",
			customType: "stepcode-web.thinking-timing",
			data: { messageTimestamp: 1000, thinkingTimings: { 0: { startedAt: 100, endedAt: 400 } } },
		},
	];
	return `${entries.map(line).join("\n")}\n`;
}

function parse(text: string): Array<Record<string, unknown>> {
	return text
		.split("\n")
		.filter((row) => row.trim().length > 0)
		.map((row) => JSON.parse(row) as Record<string, unknown>);
}

describe("feedback row metrics", () => {
	test("each assistant row carries its own tokens, cache hit rate and timing", () => {
		const rows = parse(annotateTranscriptRows(transcript()));
		const assistant = rows.find((row) => row.id === "a1");
		expect(assistant?.feedback).toEqual({
			turn: 1,
			tokens: { input: 1000, output: 200, cacheRead: 3000, cacheWrite: 0, total: 4200 },
			// 3000 / (1000 + 3000), i.e. this request alone, not the session average.
			cacheHitRate: 0.75,
			costUsd: 0.02,
			model: "step-5",
			provider: "step",
			stopReason: "toolUse",
			requestId: "req-1",
			durationMs: 2500,
			ttftMs: 640,
			outcome: "ok",
			thinkingMs: 300,
		});
	});

	test("a single tool call carries the elapsed time from issue to result", () => {
		const rows = parse(annotateTranscriptRows(transcript()));
		const result = rows.find((row) => row.id === "t1");
		expect(result?.feedback).toEqual({ turn: 1, elapsedMs: 350 });
	});

	test("a parallel batch records no per-call duration, because it would be a guess", () => {
		const entries = [
			{ id: "u1", type: "message", message: { role: "user" } },
			{
				id: "a1",
				type: "message",
				message: {
					role: "assistant",
					timestamp: 1000,
					content: [
						{ type: "toolCall", id: "c1", name: "read_file" },
						{ type: "toolCall", id: "c2", name: "read_file" },
					],
					usage: { input: 1, output: 1, cacheRead: 0, totalTokens: 2 },
				},
			},
			{ id: "t1", type: "message", message: { role: "toolResult", toolCallId: "c1", timestamp: 1400 } },
			{ id: "t2", type: "message", message: { role: "toolResult", toolCallId: "c2", timestamp: 1400 } },
		];
		const rows = parse(annotateTranscriptRows(`${entries.map(line).join("\n")}\n`));
		// No elapsed time is invented, so the rows are left untouched.
		expect(rows.find((row) => row.id === "t1")?.feedback).toBeUndefined();
		expect(rows.find((row) => row.id === "t2")?.feedback).toBeUndefined();
	});

	test("keeps every original field and the original line endings", () => {
		const text = transcript();
		const annotated = annotateTranscriptRows(text);
		const before = parse(text);
		const after = parse(annotated);
		expect(after).toHaveLength(before.length);
		for (const [index, row] of after.entries()) {
			const original = before[index]!;
			expect(Object.keys(row)).toEqual(expect.arrayContaining(Object.keys(original)));
			for (const [key, value] of Object.entries(original)) {
				if (key === "feedback") continue;
				expect(row[key]).toEqual(value);
			}
		}
		expect(annotated.endsWith("\n")).toBe(true);
	});

	test("passes a transcript with no metrics through unchanged", () => {
		const text = `${line({ type: "session", id: "s1" })}\n${line({ id: "u1", type: "message", message: { role: "user" } })}\n`;
		expect(annotateTranscriptRows(text)).toBe(text);
	});

	test("tolerates a malformed line without losing the rest", () => {
		const text = `not json\n${line({ id: "u1", type: "message", message: { role: "user" } })}\n${line({
			id: "a1",
			type: "message",
			message: { role: "assistant", usage: { input: 10, cacheRead: 0, output: 1, totalTokens: 11 } },
		})}\n`;
		const rows = parse(
			annotateTranscriptRows(text)
				.split("\n")
				.filter((row) => row !== "not json")
				.join("\n"),
		);
		expect(rows.find((row) => row.id === "a1")?.feedback).toMatchObject({ cacheHitRate: 0 });
	});
});
