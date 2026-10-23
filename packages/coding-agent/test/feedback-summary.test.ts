import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { prepareFeedbackEvidence } from "../src/step/feedback/evidence.ts";
import { collapseHomePaths } from "../src/step/feedback/redact-home.ts";
import { summarizeSessionEntries, summarizeSessionFile } from "../src/step/feedback/session-summary.ts";

/**
 * The summary is what makes a report investigable without reading the
 * transcript: model, effort, counts, failures, spend, and the request id that
 * joins the server-side log. It must never carry user content.
 */

function session(): unknown[] {
	return [
		{ type: "session", id: "s1", timestamp: "2026-10-23T00:00:00.000Z", cwd: "/Users/me/code/demo" },
		{ type: "model_change", provider: "step", modelId: "step-5" },
		{ type: "thinking_level_change", thinkingLevel: "high" },
		{
			type: "custom",
			customType: "step.usage_provenance",
			data: {
				requestId: "req-1",
				requestedProvider: "step",
				requestedModel: "step-5",
				reasoningAtDispatch: "high",
				sourceLeafId: "leaf-1",
			},
		},
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "please fix" }] } },
		{
			type: "message",
			message: {
				role: "assistant",
				provider: "step",
				model: "step-5",
				api: "openai-completions",
				content: [
					{ type: "text", text: "looking" },
					{ type: "toolCall", id: "t1", name: "read_file", arguments: {} },
					{ type: "toolCall", id: "t2", name: "run_command", arguments: {} },
				],
				usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0, reasoning: 3, totalTokens: 128 },
			},
		},
		{
			type: "message",
			message: { role: "toolResult", toolCallId: "t1", toolName: "read_file", isError: false, content: [] },
		},
		{
			type: "message",
			message: { role: "toolResult", toolCallId: "t2", toolName: "run_command", isError: true, content: [] },
		},
		{
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: "failed" }], stopReason: "error" },
		},
		{ type: "compaction", summary: "…", firstKeptEntryId: "x", tokensBefore: 10 },
		{ type: "custom", customType: "step-plan", data: { enabled: true, planSource: "user" } },
		{ type: "custom", customType: "step-goal", data: { status: "active" } },
		{
			type: "custom",
			customType: "step-tasks",
			data: { tasks: [{ status: "completed" }, { status: "pending" }, { status: "deleted" }] },
		},
		{
			type: "custom",
			customType: "stepcode-web.thinking-timing",
			data: { thinkingTimings: { 0: { startedAt: 1000, endedAt: 1500 } } },
		},
	];
}

describe("feedback session summary", () => {
	test("counts the shape of the session without any message text", () => {
		const summary = summarizeSessionEntries(session() as never, { home: "/Users/me" });
		expect(summary.counts).toEqual({
			turns: 1,
			assistantMessages: 2,
			toolCalls: 2,
			toolErrors: 1,
			failedAttempts: 1,
			abortedAttempts: 0,
			truncatedAttempts: 0,
			modelRequests: 1,
			compactions: 1,
			customEntries: 5,
		});
		expect(summary.usage).toEqual({
			input: 100,
			output: 20,
			cacheRead: 5,
			cacheWrite: 0,
			reasoning: 3,
			total: 128,
			// The synthetic message carries no pricing, so only the derived rate appears.
			cacheHitRate: 5 / 105,
		});
		expect(summary.recentErrors).toEqual([
			expect.objectContaining({ kind: "tool", toolName: "run_command" }),
			expect.objectContaining({ kind: "model" }),
		]);
		expect(summary.lastTurnTools).toEqual([
			{ name: "read_file", isError: false },
			{ name: "run_command", isError: true },
		]);
		expect(summary).toMatchObject({
			model: { provider: "step", id: "step-5", api: "openai-completions" },
			thinkingLevel: "high",
			thinkingMs: 500,
			features: { planMode: true, planSource: "user", goal: "active", tasks: { completed: 1, total: 2 } },
		});
		// The home directory never reaches a report as an absolute path.
		expect(summary.cwd).toBe("~/code/demo");
		expect(JSON.stringify(summary)).not.toContain("please fix");
		expect(JSON.stringify(summary)).not.toContain("looking");
	});

	test("reports each compaction's size before and after", () => {
		// A compaction that does not shrink the context, or that fires repeatedly,
		// is the first thing to check for a "context full" or "slow" report.
		const summary = summarizeSessionEntries(
			[
				{ type: "session", cwd: "/w" },
				{ type: "message", message: { role: "user" } },
				{ type: "compaction", tokensBefore: 190000, timestamp: "2026-10-23T00:00:01.000Z" },
				{
					type: "message",
					message: { role: "assistant", usage: { input: 42000, cacheRead: 0, output: 10, cacheWrite: 0 } },
				},
				{ type: "message", message: { role: "user" } },
				{ type: "compaction", tokensBefore: 188000, timestamp: "2026-10-23T00:05:00.000Z" },
				{
					type: "message",
					message: { role: "assistant", usage: { input: 40000, cacheRead: 0, output: 10, cacheWrite: 0 } },
				},
			] as never,
			{ home: "/w" },
		);
		expect(summary.compactions).toEqual([
			{ tokensBefore: 190000, tokensAfter: 42000, at: "2026-10-23T00:00:01.000Z" },
			{ tokensBefore: 188000, tokensAfter: 40000, at: "2026-10-23T00:05:00.000Z" },
		]);
	});

	test("keeps every compaction of a long session, plus the totals", () => {
		// A long session compacts repeatedly. Each pass is one row, and a pass that
		// never shrank the window is visible as two close numbers.
		const passes = [
			{ before: 190000, after: 42000 },
			{ before: 188000, after: 40000 },
			{ before: 195000, after: 190000 },
		];
		const entries: unknown[] = [{ type: "session", cwd: "/w" }];
		for (const [index, pass] of passes.entries()) {
			entries.push({ type: "compaction", tokensBefore: pass.before, timestamp: `2026-10-23T0${index}:00:00.000Z` });
			if (pass.after !== undefined) {
				entries.push({
					type: "message",
					message: { role: "assistant", usage: { input: pass.after, cacheRead: 0, output: 1, cacheWrite: 0 } },
				});
			}
		}
		const summary = summarizeSessionEntries(entries as never, { home: "/w" });
		expect(summary.counts.compactions).toBe(3);
		expect(summary.compactions.map((pass) => [pass.tokensBefore, pass.tokensAfter])).toEqual([
			[190000, 42000],
			[188000, 40000],
			[195000, 190000],
		]);
		expect(summary.compactionTotals).toEqual({
			passes: 3,
			resolved: 3,
			tokensBefore: 573000,
			tokensAfter: 272000,
			reclaimed: 301000,
		});
	});

	test("marks a compaction no request followed yet as unresolved", () => {
		const summary = summarizeSessionEntries(
			[
				{ type: "session", cwd: "/w" },
				{ type: "compaction", tokensBefore: 100 },
			] as never,
			{ home: "/w" },
		);
		expect(summary.compactions[0]).toEqual({ tokensBefore: 100, unresolved: true });
	});

	test("records the provider's HTTP error body, redacted and bounded", () => {
		const summary = summarizeSessionEntries(
			[
				{ type: "session", cwd: "/w" },
				{
					type: "message",
					message: {
						role: "assistant",
						stopReason: "error",
						errorKind: "rate_limit",
						errorMessage: '429: {"message":"concurrency reached, current: 11, limit: 10","type":"rate_limited"}',
					},
				},
			] as never,
			{ home: "/w" },
		);
		expect(summary.recentErrors[0]).toMatchObject({
			kind: "model",
			stopReason: "error",
			errorKind: "rate_limit",
			message: '429: {"message":"concurrency reached, current: 11, limit: 10","type":"rate_limited"}',
		});
	});

	test("collapses the home directory inside a provider error body", () => {
		// The one free-text field in the summary; an ENOENT body names a real path.
		const summary = summarizeSessionEntries(
			[
				{ type: "session", cwd: "/Users/me/w" },
				{
					type: "message",
					message: {
						role: "assistant",
						stopReason: "error",
						errorMessage: "ENOENT: open '/Users/me/code/app/.env'",
					},
				},
			] as never,
			{ home: "/Users/me" },
		);
		expect(summary.recentErrors[0]?.message).toBe("ENOENT: open '~/code/app/.env'");
	});

	test("records a cancelled request with its timing and how far it got", () => {
		// The reported case: the model hangs or keeps thinking, the user cancels.
		// A bare count would not say whether a token ever arrived.
		const summary = summarizeSessionEntries(
			[
				{ type: "session", cwd: "/w" },
				{
					type: "message",
					message: {
						role: "assistant",
						stopReason: "aborted",
						errorMessage: "Request was aborted",
						content: [{ type: "thinking", thinking: "…" }],
						timestamp: 1792675967000,
					},
				},
			] as never,
			{ home: "/w" },
		);
		expect(summary.counts.abortedAttempts).toBe(1);
		// The message records when and how far; duration and first-token time come
		// from the provenance entry that follows it (asserted in the join test).
		expect(summary.recentErrors[0]).toMatchObject({ kind: "aborted", stopReason: "aborted", reached: "thinking" });
		expect(summary.recentErrors[0]?.at).toBe(new Date(1792675967000).toISOString());
	});

	test("joins the timing from the provenance entry that belongs to the attempt", () => {
		// The message carries no duration; the provenance entry that follows it does.
		const summary = summarizeSessionEntries(
			[
				{ type: "session", cwd: "/w" },
				{
					id: "entry-1",
					type: "message",
					message: { role: "assistant", stopReason: "aborted", content: [{ type: "thinking", thinking: "…" }] },
				},
				{
					type: "custom",
					customType: "step.usage_provenance",
					data: {
						requestId: "req-2",
						requestedProvider: "step",
						requestedModel: "step-5",
						usageEntryId: "entry-1",
						durationMs: 187000,
						ttftMs: null,
						outcome: "transport_error",
					},
				},
			] as never,
			{ home: "/w" },
		);
		expect(summary.recentErrors[0]).toMatchObject({
			kind: "aborted",
			durationMs: 187000,
			ttftMs: null,
			outcome: "transport_error",
		});
	});

	test("a compaction that did not shrink the window reports a negative reclaim", () => {
		// The "two close numbers" case; the report must still be accepted downstream.
		const summary = summarizeSessionEntries(
			[
				{ type: "session", cwd: "/w" },
				{ type: "compaction", tokensBefore: 100 },
				{ type: "message", message: { role: "assistant", usage: { input: 120, cacheRead: 0, output: 1 } } },
			] as never,
			{ home: "/w" },
		);
		expect(summary.compactionTotals).toMatchObject({ passes: 1, resolved: 1, reclaimed: -20 });
	});

	test("a trailing blank or truncated line does not empty the summary", async () => {
		const root = await mkdtemp(join(tmpdir(), "feedback-tail-"));
		const file = join(root, "20261023_session-1.jsonl");
		const lines = [
			JSON.stringify({ type: "session", id: "h", parentId: null, cwd: "/w" }),
			JSON.stringify({ type: "message", id: "u1", parentId: "h", message: { role: "user" } }),
			"",
			'{"type":"message","id":"a1","par',
		];
		await writeFile(file, `${lines.join("\n")}\n`);
		const summary = await summarizeSessionFile(file, { home: "/w" });
		expect(summary?.counts.turns).toBe(1);
	});

	test("carries the context window and pricing limits observed at dispatch", () => {
		const summary = summarizeSessionEntries(
			[
				{ type: "session", cwd: "/w" },
				{
					type: "custom",
					customType: "step.usage_provenance",
					data: {
						requestId: "req-9",
						requestedProvider: "step",
						requestedModel: "step-5",
						api: "anthropic-messages",
						reasoningAtDispatch: "high",
						contextWindow: 200000,
						maxTokens: 8192,
						responseProvider: "step-proxy",
						responseModel: "step-5-2026",
						statusCode: 200,
						durationMs: 4200,
					},
				},
			] as never,
			{ home: "/w" },
		);
		expect(summary.request).toEqual({
			requestId: "req-9",
			provider: "step",
			model: "step-5",
			api: "anthropic-messages",
			reasoning: "high",
			contextWindow: 200000,
			maxTokens: 8192,
			responseProvider: "step-proxy",
			responseModel: "step-5-2026",
			statusCode: 200,
			durationMs: 4200,
		});
		expect(summary.counts.modelRequests).toBe(1);
	});

	test("keeps the live host facts a session file does not record", () => {
		const summary = summarizeSessionEntries([{ type: "session", cwd: "/Users/me/w" }] as never, {
			home: "/Users/me",
			runtime: {
				permissionPreset: "approve-for-me",
				contextUsed: 61000,
				contextWindow: 200000,
				toolCount: 24,
				skillCount: 3,
				mcpServerNames: ["playwright"],
			},
		});
		expect(summary.runtime).toEqual({
			permissionPreset: "approve-for-me",
			contextUsed: 61000,
			contextWindow: 200000,
			toolCount: 24,
			skillCount: 3,
			mcpServerNames: ["playwright"],
		});
	});

	test("counts a user stop separately from a failure, and reports total cost", () => {
		const summary = summarizeSessionEntries(
			[
				{ type: "session", cwd: "/w" },
				{
					type: "message",
					message: {
						role: "assistant",
						stopReason: "aborted",
						usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } },
					},
				},
			] as never,
			{ home: "/w" },
		);
		expect(summary.counts.abortedAttempts).toBe(1);
		expect(summary.counts.failedAttempts).toBe(0);
		expect(summary.usage.costUsd).toBe(0.25);
	});

	test("carries the newest model request id so the report joins the server log", () => {
		const summary = summarizeSessionEntries(session() as never, { home: "/Users/me" });
		expect(summary.request).toEqual({
			requestId: "req-1",
			provider: "step",
			model: "step-5",
			reasoning: "high",
			sourceLeafId: "leaf-1",
		});
	});

	test("bounds the latest turn's tool list instead of growing with the session", () => {
		const assistant = {
			type: "message",
			message: {
				role: "assistant",
				content: Array.from({ length: 80 }, (_, index) => ({
					type: "toolCall",
					id: `t${index}`,
					name: "read_file",
				})),
			},
		};
		const summary = summarizeSessionEntries([{ type: "message", message: { role: "user" } }, assistant] as never);
		expect(summary.lastTurnTools).toHaveLength(50);
		expect(summary.counts.toolCalls).toBe(80);
	});

	test("summarizes the branch the file ends on, not abandoned turns", async () => {
		// Navigating back leaves the abandoned turn in the file. Counting it would
		// report turns the user rewound and a requestId from another branch.
		const root = await mkdtemp(join(tmpdir(), "feedback-branch-"));
		const file = join(root, "20261023_session-1.jsonl");
		const abandoned = [
			{ type: "session", id: "h", parentId: null, cwd: "/w" },
			{ type: "message", id: "u1", parentId: "h", message: { role: "user" } },
			{ type: "message", id: "a1", parentId: "u1", message: { role: "assistant", usage: { input: 5, output: 1 } } },
			{
				type: "custom",
				id: "p1",
				parentId: "a1",
				customType: "step.usage_provenance",
				data: { requestId: "abandoned", usageEntryId: "a1" },
			},
		];
		const live = [
			{ type: "message", id: "u2", parentId: "h", message: { role: "user" } },
			{ type: "message", id: "a2", parentId: "u2", message: { role: "assistant", usage: { input: 7, output: 2 } } },
			{
				type: "custom",
				id: "p2",
				parentId: "a2",
				customType: "step.usage_provenance",
				data: { requestId: "live", usageEntryId: "a2" },
			},
		];
		await writeFile(file, `${[...abandoned, ...live].map((entry) => JSON.stringify(entry)).join("\n")}\n`);

		const summary = await summarizeSessionFile(file, { home: "/w" });

		expect(summary?.counts.turns).toBe(1);
		expect(summary?.usage.input).toBe(7);
		expect(summary?.request?.requestId).toBe("live");
	});

	test("reads the same values from the session file", async () => {
		const root = await mkdtemp(join(tmpdir(), "feedback-summary-"));
		const file = join(root, "20261023_session-1.jsonl");
		await writeFile(
			file,
			`${session()
				.map((value) => JSON.stringify(value))
				.join("\n")}\n`,
		);
		const fromFile = await summarizeSessionFile(file, { home: "/Users/me" });
		expect(fromFile).toEqual(summarizeSessionEntries(session() as never, { home: "/Users/me" }));
	});

	test("an unreadable line does not lose the counts around it", async () => {
		const root = await mkdtemp(join(tmpdir(), "feedback-summary-"));
		const file = join(root, "20261023_session-1.jsonl");
		await writeFile(
			file,
			`{"type":"session","cwd":"/tmp/x"}\nnot json\n{"type":"message","message":{"role":"user"}}\n`,
		);
		const summary = await summarizeSessionFile(file);
		expect(summary?.counts.turns).toBe(1);
	});

	test("collapses only a real home prefix", () => {
		expect(collapseHomePaths("/Users/bob/code/app", "/Users/bob")).toBe("~/code/app");
		expect(collapseHomePaths("/Users/bob2/code/app", "/Users/bob")).toBe("/Users/bob2/code/app");
		expect(collapseHomePaths("see /Users/bob and /Users/bob/x", "/Users/bob")).toBe("see ~ and ~/x");
		// A home directory that is a symlinked prefix of the resolved path must not
		// match inside it; the result would be a corrupted path in the report.
		expect(collapseHomePaths("/private/var/tmp/project", "/var/tmp/project")).toBe("/private/var/tmp/project");
		expect(collapseHomePaths("cwd=/Users/bob/w", "/Users/bob")).toBe("cwd=~/w");
	});
});

describe("feedback evidence", () => {
	test("gathers the transcript, the log tail and the summary from one session", async () => {
		const root = await mkdtemp(join(tmpdir(), "feedback-evidence-"));
		const sessionFile = join(root, "20261023_session-1.jsonl");
		await writeFile(
			sessionFile,
			`${session()
				.map((value) => JSON.stringify(value))
				.join("\n")}\n`,
		);
		const evidence = await prepareFeedbackEvidence({
			storageRootDir: root,
			sessionFile,
			env: { STEP_CODING_AGENT_DIR: join(root, "agent") } as NodeJS.ProcessEnv,
		});
		expect(evidence.sessionId).toBe("s1");
		expect(evidence.sessionFile).toBe(sessionFile);
		expect(evidence.summary?.counts.turns).toBe(1);
		expect(evidence.bundle?.status).toBe("ready");
	});

	test("an explicit opt-out still produces a report without the archive", async () => {
		const root = await mkdtemp(join(tmpdir(), "feedback-evidence-"));
		const sessionFile = join(root, "20261023_session-1.jsonl");
		await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
		const evidence = await prepareFeedbackEvidence({
			storageRootDir: root,
			sessionFile,
			withoutBundle: true,
			withoutDiagnostics: true,
			env: { STEP_CODING_AGENT_DIR: join(root, "agent") } as NodeJS.ProcessEnv,
		});
		expect(evidence.bundle).toBeUndefined();
		expect(evidence.diagnostics).toBeUndefined();
		// The summary is content-free, so it survives both opt-outs.
		expect(evidence.summary).toBeDefined();
	});
});
