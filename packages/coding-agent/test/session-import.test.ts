import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseForeignSession } from "../src/core/session-import/parsers.ts";
import { SessionImportService, workbuddyProjectsRoot } from "../src/core/session-import/service.ts";
import { buildSessionContext, SessionManager } from "../src/core/session-manager.ts";
import { createWriteTool } from "../src/core/tools/write.ts";
import { collectSessionUsage } from "../src/core/usage-totals.ts";
import { createHarness } from "./suite/harness.ts";

const timestamp = "2026-10-22T00:00:00.000Z";
const jsonl = (records: unknown[]) => `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
const meta = (cwd = "/project", id = "source-1") => ({
	type: "session_meta",
	timestamp,
	payload: { id, cwd, cli_version: "0.163.0-alpha.11", history_mode: "paginated" },
});
const item = (payload: unknown) => ({ type: "response_item", timestamp, payload });
const user = (value: string, id?: string) =>
	item({ type: "message", role: "user", id, content: [{ type: "input_text", text: value }] });
const reply = (value: string) =>
	item({ type: "message", role: "assistant", content: [{ type: "output_text", text: value }] });

const directories: string[] = [];
afterEach(async () => {
	for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "step-session-import-"));
	directories.push(root);
	const cwd = join(root, "project");
	const codexRoot = join(root, "codex");
	const claudeRoot = join(root, "claude");
	const workbuddyRoot = join(root, "workbuddy");
	const qoderRoot = join(root, "qoder");
	const agentDir = join(root, "target", "agent");
	await mkdir(cwd, { recursive: true });
	await mkdir(join(codexRoot, "sessions"), { recursive: true });
	await mkdir(claudeRoot);
	await mkdir(workbuddyRoot);
	await mkdir(qoderRoot);
	const source = join(codexRoot, "sessions", "rollout-one.jsonl");
	await writeFile(source, jsonl([meta(cwd), user("Keep migration facts"), reply("Confirmed")]));
	const events: string[] = [];
	const service = new SessionImportService({ agentDir, onPersisted: (event) => events.push(event.path) });
	return { root, cwd, codexRoot, claudeRoot, workbuddyRoot, qoderRoot, agentDir, source, service, events };
}

async function finish(service: SessionImportService, id: string) {
	for (let i = 0; i < 100; i++) {
		const job = await service.getJob(id);
		if (job.status !== "running") return job;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Import did not settle");
}

describe("foreign adapters", () => {
	it("strips source control envelopes from user text and keeps thinking blocks typed per platform", () => {
		const control = "<command-name>/exit</command-name> <command-message>exit</command-message>";
		const codex = parseForeignSession(
			"codex",
			jsonl([
				meta(),
				user(`<environment_context>home</environment_context>`),
				user(`${control}\n真实问题`),
				item({ type: "reasoning", summary: [{ type: "summary_text", text: "think codex" }] }),
			]),
		);
		const codexUsers = codex.entries.filter((e) => e.type === "message" && e.message.role === "user");
		expect(codexUsers).toHaveLength(1);
		expect(JSON.stringify(codexUsers)).toContain("真实问题");
		expect(JSON.stringify(codexUsers)).not.toContain("command-name");
		expect(codex.warnings.some((w) => w.code === "source_instructions_excluded")).toBe(true);
		const claude = parseForeignSession(
			"claude-code",
			jsonl([
				{ type: "user", uuid: "u", sessionId: "c", cwd: "/p", message: { content: `${control}` } },
				{ type: "user", uuid: "u2", parentUuid: "u", sessionId: "c", message: { content: "Claude real ask" } },
				{
					type: "assistant",
					uuid: "a",
					parentUuid: "u2",
					sessionId: "c",
					message: {
						content: [
							{ type: "thinking", thinking: "think claude" },
							{ type: "text", text: "answer" },
						],
					},
				},
			]),
		);
		const wb = parseForeignSession(
			"workbuddy",
			jsonl([
				{ type: "session-meta", sessionId: "wb" },
				{
					type: "message",
					id: "w1",
					sessionId: "wb",
					cwd: "/p",
					role: "user",
					content: [{ type: "input_text", text: `${control}\nWB ask` }],
				},
				{ type: "reasoning", id: "w2", sessionId: "wb", content: [{ type: "text", text: "think wb" }] },
			]),
		);
		const qoder = parseForeignSession(
			"qoder",
			jsonl([
				{
					type: "user",
					uuid: "q1",
					parentUuid: null,
					sessionId: "q",
					cwd: "/p",
					message: { content: "Qoder ask" },
				},
				{
					type: "assistant",
					uuid: "q2",
					parentUuid: "q1",
					sessionId: "q",
					message: { content: [{ type: "thinking", thinking: "think qoder" }] },
				},
				{ type: "active-leaf", sessionId: "q", leafUuid: "q2" },
			]),
		);
		for (const [parsed, thinking] of [
			[codex, "think codex"],
			[claude, "think claude"],
			[wb, "think wb"],
			[qoder, "think qoder"],
		] as const) {
			const blocks = parsed.entries.flatMap((e) =>
				e.type === "message" && e.message.role === "assistant" ? e.message.content : [],
			);
			expect(blocks.filter((b) => b.type === "thinking").map((b) => b.type === "thinking" && b.thinking)).toContain(
				thinking,
			);
		}
		expect(JSON.stringify([claude.entries, wb.entries])).not.toContain("command-name");
	});
	it("parses WorkBuddy messages and tools without activating source controls", () => {
		const parsed = parseForeignSession(
			"workbuddy",
			jsonl([
				{ type: "session-meta", sessionId: "wb" },
				{
					type: "message",
					id: "u",
					sessionId: "wb",
					cwd: "/project",
					role: "user",
					timestamp: 1792990000000,
					content: [{ type: "input_text", text: "WorkBuddy task" }],
				},
				{ type: "ai-title", sessionId: "wb", aiTitle: "Named WorkBuddy task" },
				{ type: "message", id: "s", role: "system", content: [{ type: "input_text", text: "SOURCE CONTROL" }] },
				{
					type: "function_call",
					id: "c",
					callId: "call",
					name: "write_file",
					arguments: '{"path":"never-write.txt"}',
				},
				{
					type: "function_call_result",
					id: "r",
					callId: "call",
					status: "failed",
					output: { type: "text", text: "Permission denied" },
				},
			]),
		);
		expect(parsed.title).toBe("Named WorkBuddy task");
		expect(parsed.cwd).toBe("/project");
		expect(parsed.entries.every((entry) => entry.imported?.source === "workbuddy")).toBe(true);
		expect(JSON.stringify(parsed.entries)).not.toContain("SOURCE CONTROL");
		const output = parsed.entries.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
		expect(output?.type === "message" && output.message.role === "toolResult" && output.message.isError).toBe(true);
	});

	it("uses Qoder active-leaf rather than the last stored branch", () => {
		const parsed = parseForeignSession(
			"qoder",
			jsonl([
				{ type: "workspace-directories", sessionId: "qoder" },
				{ type: "runtime-config", sessionId: "qoder", model: "never-select" },
				{
					type: "user",
					sessionId: "qoder",
					cwd: "/project",
					uuid: "u",
					parentUuid: null,
					message: { role: "user", content: "Qoder task" },
				},
				{
					type: "assistant",
					uuid: "kept",
					parentUuid: "u",
					message: { role: "assistant", content: [{ type: "text", text: "Current branch" }] },
				},
				{
					type: "assistant",
					uuid: "other",
					parentUuid: "u",
					message: { role: "assistant", content: [{ type: "text", text: "Unselected branch" }] },
				},
				{ type: "active-leaf", sessionId: "qoder", leafUuid: "kept" },
			]),
		);
		expect(parsed.cwd).toBe("/project");
		expect(JSON.stringify(parsed.entries)).toContain("Current branch");
		expect(JSON.stringify(parsed.entries)).not.toContain("Unselected branch");
		expect(parsed.entries.every((entry) => entry.imported?.source === "qoder")).toBe(true);
	});
	it("deduplicates record identities, not legitimate repeated text or event mirrors", () => {
		const parsed = parseForeignSession(
			"codex",
			jsonl([
				meta(),
				{ type: "event_msg", timestamp, payload: { type: "user_message", message: "again" } },
				user("again", "one"),
				reply("yes"),
				user("again", "two"),
				user("again", "two"),
			]),
		);
		expect(parsed.entries.filter((e) => e.type === "message" && e.message.role === "user")).toHaveLength(2);
	});

	it("deduplicates tool protocol identities even when source item IDs are absent", () => {
		const call = item({ type: "function_call", call_id: "stable-call", name: "Read", arguments: "{}" });
		const output = item({ type: "function_call_output", call_id: "stable-call", output: "evidence" });
		const parsed = parseForeignSession("codex", jsonl([meta(), user("inspect"), call, output, call, output]));
		expect(parsed.entries.filter((e) => e.type === "message" && e.message.role === "assistant")).toHaveLength(1);
		expect(parsed.entries.filter((e) => e.type === "message" && e.message.role === "toolResult")).toHaveLength(1);
	});

	it("keeps independent tool calls and results but never restores their execution protocol or usage", () => {
		const parsed = parseForeignSession(
			"codex",
			jsonl([
				meta(),
				user("inspect"),
				item({ type: "function_call", call_id: "call-1", name: "exec_command", arguments: '{"cmd":"dir"}' }),
				item({
					type: "function_call_output",
					call_id: "call-1",
					output: [
						{ type: "text", text: "recorded output" },
						{ type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" },
					],
				}),
				item({ type: "message", role: "developer", content: [{ type: "input_text", text: "old controls" }] }),
			]),
		);
		const context = buildSessionContext(parsed.entries);
		expect(context.model).toBeNull();
		expect(JSON.stringify(context.messages)).toContain("Historical tool call");
		expect(JSON.stringify(context.messages)).toContain("recorded output");
		expect(JSON.stringify(context.messages)).toContain('"type":"image"');
		expect(JSON.stringify(context.messages)).not.toContain('"type":"toolCall"');
		expect(JSON.stringify(context.messages)).not.toContain("old controls");
		expect(collectSessionUsage(parsed.entries)).toMatchObject({ total: 0, missing: 0, invalid: 0 });
	});

	it("retains readable pre-compaction history and uses the source summary for context", () => {
		const parsed = parseForeignSession(
			"codex",
			jsonl([
				meta(),
				user("old detail"),
				reply("old reply"),
				{
					type: "compacted",
					timestamp,
					payload: { message: "Carry forward the task facts", replacement_history: [] },
				},
				user("continue"),
			]),
		);
		expect(JSON.stringify(parsed.entries)).toContain("old detail");
		const context = JSON.stringify(buildSessionContext(parsed.entries).messages);
		expect(context).toContain("Carry forward the task facts");
		expect(context).toContain("continue");
		expect(context).not.toContain("old detail");
	});

	it("preserves retained compaction images and their captions without activating source controls", () => {
		const parsed = parseForeignSession(
			"codex",
			jsonl([
				meta(),
				user("old detail"),
				{
					type: "compacted",
					timestamp,
					payload: {
						message: "Task summary",
						replacement_history: [
							{
								type: "message",
								role: "user",
								content: [
									{ type: "input_text", text: "Use this image" },
									{ type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" },
								],
							},
							{
								type: "message",
								role: "developer",
								content: [{ type: "input_text", text: "excluded developer controls" }],
							},
						],
					},
				},
				user("continue"),
			]),
		);
		const context = JSON.stringify(buildSessionContext(parsed.entries).messages);
		expect(context).toContain('"type":"image"');
		expect(context).toContain('"data":"aW1hZ2U="');
		expect(context).toContain("Use this image");
		expect(context).not.toContain("old detail");
		expect(context).not.toContain("excluded developer controls");
		expect(parsed.warnings).not.toContainEqual(expect.objectContaining({ code: "attachment_missing" }));
	});

	it("keeps the latest compaction attachments through rollback without counting them as new user turns", () => {
		const compacted = (data: string) => ({
			type: "compacted",
			timestamp,
			payload: {
				replacement_history: [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_image", image_url: `data:image/png;base64,${data}` }],
					},
				],
			},
		});
		const parsed = parseForeignSession(
			"codex",
			jsonl([
				meta(),
				user("old detail"),
				compacted("b2xk"),
				compacted("bmV3"),
				user("rolled back turn"),
				{ type: "event_msg", timestamp, payload: { type: "thread_rolled_back", num_turns: 1 } },
			]),
		);
		const context = JSON.stringify(buildSessionContext(parsed.entries).messages);
		expect(context).toContain('"data":"bmV3"');
		expect(context).not.toContain('"data":"b2xk"');
		expect(context).not.toContain("rolled back turn");
		expect(context).not.toContain("old detail");
	});

	it.each([
		[true, "failed"],
		[false, "completed"],
		[undefined, "unknown"],
	] as const)("preserves Claude tool outcome %s in continuation context as %s", (isError, status) => {
		const parsed = parseForeignSession(
			"claude-code",
			jsonl([
				{
					type: "user",
					uuid: "u",
					sessionId: "cc",
					message: { content: "run" },
				},
				{
					type: "assistant",
					uuid: "a",
					parentUuid: "u",
					sessionId: "cc",
					message: { content: [{ type: "tool_use", id: "t", name: "Write", input: { path: "x" } }] },
				},
				{
					type: "user",
					uuid: "r",
					parentUuid: "a",
					sessionId: "cc",
					message: {
						content: [{ type: "tool_result", tool_use_id: "t", content: "same output", is_error: isError }],
					},
				},
			]),
		);
		const context = JSON.stringify(buildSessionContext(parsed.entries).messages);
		expect(context).toContain(`status: ${status}`);
		expect(context).toContain("same output");
		expect(context).not.toContain('"type":"toolCall"');
	});

	it("keeps Codex tool outcomes unknown when no explicit outcome is recorded", () => {
		const parsed = parseForeignSession(
			"codex",
			jsonl([
				meta(),
				user("run"),
				item({ type: "function_call", call_id: "t", name: "Write", arguments: "{}" }),
				item({ type: "function_call_output", call_id: "t", output: "done" }),
			]),
		);
		expect(JSON.stringify(buildSessionContext(parsed.entries).messages)).toContain("status: unknown");
	});

	it("applies rollback and rejects malformed or unknown record formats", () => {
		const parsed = parseForeignSession(
			"codex",
			jsonl([
				meta(),
				user("keep"),
				reply("kept"),
				user("remove"),
				reply("removed"),
				{ type: "event_msg", timestamp, payload: { type: "thread_rolled_back", num_turns: 1 } },
			]),
		);
		expect(JSON.stringify(parsed.entries)).not.toContain('"remove"');
		expect(() => parseForeignSession("codex", `${jsonl([meta()])}{`)).toThrow("Invalid JSONL");
		expect(() => parseForeignSession("codex", jsonl([meta(), user("x"), { type: "future_record" }]))).toThrow(
			"Unsupported",
		);
	});

	it("reads the selected Claude branch and does not mistake tool results for human instructions", () => {
		const parsed = parseForeignSession(
			"claude-code",
			jsonl([
				{
					type: "user",
					uuid: "u",
					parentUuid: null,
					sessionId: "cc",
					cwd: "/project",
					timestamp,
					message: { content: "inspect" },
				},
				{
					type: "assistant",
					uuid: "wrong",
					parentUuid: "u",
					sessionId: "cc",
					timestamp,
					message: { content: [{ type: "text", text: "other branch" }] },
				},
				{
					type: "assistant",
					uuid: "a",
					parentUuid: "u",
					sessionId: "cc",
					timestamp,
					message: { content: [{ type: "tool_use", id: "t", name: "Read", input: { file_path: "a.ts" } }] },
				},
				{
					type: "user",
					uuid: "r",
					parentUuid: "a",
					sessionId: "cc",
					timestamp,
					message: {
						content: [{ type: "tool_result", tool_use_id: "t", content: "file contents", is_error: false }],
					},
				},
			]),
		);
		expect(parsed.entries.filter((e) => e.type === "message" && e.message.role === "user")).toHaveLength(1);
		expect(JSON.stringify(parsed.entries)).not.toContain("other branch");
		expect(JSON.stringify(buildSessionContext(parsed.entries).messages)).toContain("file contents");
	});

	it("warns when a Claude compaction boundary prevents lossless history migration", () => {
		const parsed = parseForeignSession(
			"claude-code",
			jsonl([
				{ type: "system", subtype: "compact_boundary", sessionId: "cc", timestamp },
				{
					type: "user",
					uuid: "summary",
					parentUuid: null,
					sessionId: "cc",
					timestamp,
					isCompactSummary: true,
					message: { content: "Carry forward the previous task facts" },
				},
			]),
		);
		expect(parsed.warnings).toContainEqual({ code: "claude_compaction", count: 2 });
		expect(JSON.stringify(buildSessionContext(parsed.entries).messages)).toContain("previous task facts");
	});
});

describe("WorkBuddy current and legacy layouts", () => {
	it("prefers ~/.workbuddy-ai/projects and falls back to the legacy ~/.workbuddy/projects", async () => {
		const f = await fixture();
		expect(workbuddyProjectsRoot(f.root)).toBe(join(f.root, ".workbuddy", "projects"));
		await mkdir(join(f.root, ".workbuddy-ai", "projects"), { recursive: true });
		expect(workbuddyProjectsRoot(f.root)).toBe(join(f.root, ".workbuddy-ai", "projects"));
	});

	it("discovers minimal WorkBuddy transcripts without session-meta through their flat message records", async () => {
		const f = await fixture();
		// Real-world shape: only message/file-history-snapshot records, sessionId and cwd on each record.
		await writeFile(
			join(f.workbuddyRoot, "125435ae.jsonl"),
			jsonl([
				{
					type: "message",
					id: "r1",
					sessionId: "125435ae",
					cwd: f.cwd,
					role: "user",
					timestamp: 1790000000000,
					content: [{ type: "input_text", text: "Continue the archived task" }],
				},
				{ type: "file-history-snapshot", id: "r2", sessionId: "125435ae", cwd: f.cwd, timestamp: 1790000000001 },
				{
					type: "message",
					id: "r3",
					sessionId: "125435ae",
					cwd: f.cwd,
					role: "assistant",
					timestamp: 1790000000002,
					content: [{ type: "output_text", text: "Resumed with history intact" }],
				},
			]),
		);
		const scan = await f.service.scan({
			workbuddyRoot: f.workbuddyRoot,
			claudeRoot: f.claudeRoot,
			qoderRoot: f.qoderRoot,
			codexRoot: f.codexRoot,
		});
		expect(scan.errors).toEqual([]);
		const candidate = scan.candidates.find((c) => c.source === "workbuddy");
		expect(candidate?.sessionId).toBe("125435ae");
		expect(candidate?.cwd).toBe(f.cwd);
		expect(candidate?.title).toBe("Continue the archived task");
		const preview = await f.service.preview(candidate?.id ?? "");
		expect(preview.messageCount).toBeGreaterThan(0);
	});
});

describe("offline import lifecycle", () => {
	it("discovers four mixed source formats once and imports new sources with durable provenance", async () => {
		const f = await fixture();
		try {
			await writeFile(
				join(f.claudeRoot, "claude.jsonl"),
				jsonl([{ type: "user", sessionId: "claude", cwd: f.cwd, uuid: "cu", message: { content: "Claude task" } }]),
			);
			await writeFile(
				join(f.workbuddyRoot, "wb.jsonl"),
				jsonl([
					{ type: "session-meta", sessionId: "wb" },
					{
						type: "message",
						id: "wu",
						sessionId: "wb",
						cwd: f.cwd,
						role: "user",
						content: [{ type: "input_text", text: "WorkBuddy task" }],
					},
					{ type: "ai-title", sessionId: "wb", aiTitle: "Named WorkBuddy task" },
				]),
			);
			await writeFile(
				join(f.qoderRoot, "qoder.jsonl"),
				jsonl([
					{ type: "workspace-directories", sessionId: "qoder" },
					{ type: "user", sessionId: "qoder", cwd: f.cwd, uuid: "qu", message: { content: "Qoder task" } },
				]),
			);
			const scan = await f.service.scan({ customRoot: f.root });
			expect(scan.errors).toEqual([]);
			expect(scan.candidates.map((c) => c.source).sort()).toEqual(["claude-code", "codex", "qoder", "workbuddy"]);
			for (const source of ["workbuddy", "qoder"] as const) {
				const candidate = scan.candidates.find((c) => c.source === source);
				expect(candidate?.cwd).toBe(f.cwd);
				const preview = await f.service.preview(candidate?.id ?? "");
				const job = await finish(
					f.service,
					(await f.service.start([{ candidateId: preview.id, fingerprint: preview.fingerprint, cwd: f.cwd }])).id,
				);
				expect(job.results[0].status).toBe("imported");
				expect(job.results[0].source).toBe(source);
				expect(JSON.stringify(SessionManager.open(job.results[0].path as string).getEntries())).toContain(source);
			}
		} finally {
			await f.service.close();
		}
	});
	it("appends custom scans without invalidating existing reviewed candidates and deduplicates repeated paths", async () => {
		const f = await fixture();
		try {
			const original = (await f.service.scan(f)).candidates[0];
			const reviewed = await f.service.preview(original.id);
			const customRoot = join(f.root, "extra");
			await mkdir(customRoot);
			await writeFile(join(customRoot, "rollout-extra.jsonl"), jsonl([meta(f.cwd, "extra"), user("Extra history")]));
			const extra = await f.service.scan({ customRoot });
			expect(extra.errors).toEqual([]);
			expect(extra.candidates).toHaveLength(1);
			expect(extra.candidates[0].sessionId).toBe("extra");
			const repeated = await f.service.scan({ customRoot });
			expect(repeated.candidates).toHaveLength(0);
			expect(repeated.existingCount).toBe(1);
			expect((await f.service.preview(original.id)).sessionId).toBe(original.sessionId);
			const imported = await finish(
				f.service,
				(await f.service.start([{ candidateId: original.id, fingerprint: reviewed.fingerprint, cwd: f.cwd }])).id,
			);
			expect(imported.results[0].status).toBe("imported");
			const missing = await f.service.scan({ customRoot: join(f.root, "missing") });
			expect(missing.errors.length).toBeGreaterThan(0);
			expect((await f.service.preview(extra.candidates[0].id)).sessionId).toBe("extra");
		} finally {
			await f.service.close();
		}
	});
	it("returns readable scan titles without previewing or validating the full transcript", async () => {
		const f = await fixture();
		const claude = join(f.claudeRoot, "named.jsonl");
		await writeFile(
			claude,
			jsonl([
				{
					type: "user",
					sessionId: "named",
					cwd: f.cwd,
					message: { content: [{ type: "text", text: "First task" }] },
				},
				{ type: "summary", sessionId: "named", summary: "Useful summary" },
				{ type: "custom-title", sessionId: "named", customTitle: "Explicit name" },
			]) + "malformed unfinished tail",
		);
		try {
			const scan = await f.service.scan(f);
			expect(scan.errors).toEqual([]);
			expect(scan.candidates.find((c) => c.source === "codex")?.title).toBe("Keep migration facts");
			expect(scan.candidates.find((c) => c.sessionId === "named")?.title).toBe("Explicit name");
			expect(await readdir(f.agentDir).catch(() => [])).toEqual([]);
			expect(await readFile(claude, "utf8")).toContain("malformed unfinished tail");
		} finally {
			await f.service.close();
		}
	});

	it("bounds title discovery but lets preview replace first-user fallbacks with parsed titles", async () => {
		const f = await fixture();
		await writeFile(
			join(f.claudeRoot, "late.jsonl"),
			jsonl([
				{ type: "user", uuid: "u", sessionId: "late", cwd: f.cwd, message: { content: "Early task" } },
				{ type: "ignored", padding: "x".repeat(1024 * 1024) },
				{ type: "custom-title", sessionId: "late", customTitle: "Late explicit title" },
			]),
		);
		try {
			const c = (await f.service.scan(f)).candidates.find((c) => c.sessionId === "late");
			expect(c?.title).toBe("Early task");
			expect((await f.service.preview(c?.id ?? "")).title).toBe("Late explicit title");
		} finally {
			await f.service.close();
		}
	});

	it("prefers reliable Codex index and metadata titles over first user text", async () => {
		const f = await fixture();
		await writeFile(
			f.source,
			jsonl([{ ...meta(f.cwd), payload: { ...meta(f.cwd).payload, title: "Metadata title" } }, user("Task text")]),
		);
		try {
			let c = (await f.service.scan(f)).candidates[0];
			expect(c.title).toBe("Metadata title");
			expect((await f.service.preview(c.id)).title).toBe("Metadata title");
			await writeFile(
				join(f.codexRoot, "session_index.jsonl"),
				jsonl([{ id: c.sessionId, thread_name: "Index title" }]),
			);
			c = (await f.service.scan(f)).candidates[0];
			expect(c.title).toBe("Index title");
			expect((await f.service.preview(c.id)).title).toBe("Index title");
		} finally {
			await f.service.close();
		}
	});
	it("records selected destination cwd for imported, skipped and failed outcomes", async () => {
		const f = await fixture();
		const destination = join(f.root, "destination");
		await mkdir(destination);
		try {
			const c = (await f.service.scan(f)).candidates[0];
			const p = await f.service.preview(c.id);
			const selection = { candidateId: c.id, fingerprint: p.fingerprint, cwd: destination };
			for (const status of ["imported", "skipped"] as const) {
				const job = await finish(f.service, (await f.service.start([selection])).id);
				expect(job.results[0]).toMatchObject({ status, cwd: destination });
			}
			const missing = join(f.root, "missing");
			const failed = await finish(f.service, (await f.service.start([{ ...selection, cwd: missing }])).id);
			expect(failed.results[0]).toMatchObject({ status: "failed", cwd: missing });
			await f.service.close();
			const restarted = new SessionImportService({ agentDir: f.agentDir });
			try {
				expect((await restarted.getJob(failed.id)).results[0].cwd).toBe(missing);
			} finally {
				await restarted.close();
			}
		} finally {
			await f.service.close();
		}
	});

	it("recovers older result cwd, title and provenance only from a contained bounded native header", async () => {
		const f = await fixture();
		const root = join(f.agentDir, "sessions", "imported");
		await mkdir(root, { recursive: true });
		const native = join(root, "native.jsonl");
		const outside = join(f.root, "outside.jsonl");
		const header = jsonl([
			{ type: "session", cwd: f.cwd },
			{
				type: "message",
				message: { role: "user", content: "First native task" },
				imported: { source: "codex", sessionId: "s", itemId: "u" },
			},
			{ type: "session_info", name: "[codex] Saved name" },
		]);
		await writeFile(native, header);
		await writeFile(outside, header);
		const linkPath = join(root, "escape.jsonl");
		await symlink(outside, linkPath);
		const bounded = join(root, "bounded.jsonl");
		await writeFile(
			bounded,
			jsonl([
				{ type: "session", cwd: f.cwd },
				{ type: "ignored", padding: "x".repeat(1024 * 1024) },
				{ type: "session_info", name: "Not read" },
			]),
		);
		const id = "11111111-1111-4111-a111-111111111111";
		const journal = join(f.agentDir, "session-imports", `${id}.json`);
		await mkdir(join(f.agentDir, "session-imports"));
		const job = {
			id,
			createdAt: timestamp,
			status: "completed",
			total: 6,
			results: [
				{ candidateId: "old", status: "imported", path: native },
				{
					candidateId: "source-known",
					status: "skipped",
					path: native,
					source: "claude-code",
					title: "Existing title",
				},
				{ candidateId: "outside", status: "imported", path: outside },
				{ candidateId: "symlink", status: "imported", path: linkPath },
				{ candidateId: "bounded", status: "imported", path: bounded },
				{ candidateId: "deleted", status: "imported", path: join(root, "missing.jsonl") },
			],
		};
		await writeFile(journal, JSON.stringify(job));
		try {
			const results = (await f.service.getJob(id)).results;
			expect(results[0]).toMatchObject({ cwd: f.cwd, title: "Saved name", source: "codex" });
			expect(results[1]).toMatchObject({ cwd: f.cwd, title: "Existing title", source: "claude-code" });
			for (const index of [2, 3, 5]) {
				expect(results[index].cwd).toBeUndefined();
				expect(results[index].title).toBeUndefined();
				expect(results[index].source).toBeUndefined();
			}
			expect(results[4]).toMatchObject({ cwd: f.cwd });
			expect(results[4].title).toBeUndefined();
			expect(results[4].source).toBeUndefined();
			await writeFile(native, header.split("\n").slice(0, 2).join("\n"));
			expect((await f.service.getJob(id)).results[0].title).toBe("First native task");
			for (const cwd of [42, "relative", "", null, "/bad\0path"]) {
				await writeFile(journal, JSON.stringify({ ...job, results: [{ ...job.results[0], cwd }] }));
				await expect(f.service.getJob(id)).rejects.toThrow("Invalid persisted import result");
			}
		} finally {
			await f.service.close();
		}
	});

	it.each([5000, 1024 * 1024])(
		"discovers and imports Claude metadata in a large first record with %s extra bytes",
		async (extra) => {
			const f = await fixture();
			const first = {
				type: "user",
				uuid: "long-user",
				sessionId: "long-claude",
				cwd: f.cwd,
				timestamp,
				message: { content: "" },
			};
			const emptyRecord = JSON.stringify(first);
			const contentStart = emptyRecord.indexOf('"content":""') + '"content":"'.length;
			const prefixBytes = Buffer.byteLength(emptyRecord.slice(0, contentStart));
			first.message.content = `${"x".repeat(65535 - prefixBytes)}\u754c${"x".repeat(extra)}`;
			const input = jsonl([first]);
			// Include a record without a trailing newline; split UTF-8 must not be decoded per chunk.
			await writeFile(join(f.claudeRoot, "long.jsonl"), input.trimEnd());
			try {
				const scan = await f.service.scan(f);
				expect(scan.errors).toEqual([]);
				const c = scan.candidates.find((candidate) => candidate.sessionId === "long-claude");
				expect(c).toBeDefined();
				const p = await f.service.preview(c?.id ?? "");
				const job = await finish(
					f.service,
					(await f.service.start([{ candidateId: p.id, fingerprint: p.fingerprint, cwd: f.cwd }])).id,
				);
				expect(job.results[0].status).toBe("imported");
				const messages = SessionManager.open(job.results[0].path as string).buildSessionContext().messages;
				expect(JSON.stringify(messages)).toContain("\u754c");
				expect(JSON.stringify(messages)).not.toContain("\uFFFD");
			} finally {
				await f.service.close();
			}
		},
	);

	it("scans a selected date subtree but excludes archive subtrees even when selected directly", async () => {
		const f = await fixture();
		const dateRoot = join(f.codexRoot, "sessions", "2026");
		const month = join(dateRoot, "10");
		const archivedRoot = join(f.codexRoot, "archived_sessions", "2026");
		await mkdir(month, { recursive: true });
		await mkdir(archivedRoot, { recursive: true });
		await writeFile(join(month, "rollout-day.jsonl"), jsonl([meta(f.cwd), user("dated")]));
		await writeFile(join(archivedRoot, "rollout-archive.jsonl"), "{ malformed archive");
		try {
			expect((await f.service.scan({ ...f, codexRoot: dateRoot })).candidates).toHaveLength(1);
			const scan = await f.service.scan({ ...f, codexRoot: archivedRoot });
			expect(scan).toEqual({
				existingCount: 0,
				roots: {
					codex: await realpath(archivedRoot),
					"claude-code": await realpath(f.claudeRoot),
					workbuddy: await realpath(f.workbuddyRoot),
					qoder: await realpath(f.qoderRoot),
				},
				candidates: [],
				errors: [],
			});
		} finally {
			await f.service.close();
		}
	});

	it("owns submitted selections and source references across later scans", async () => {
		const f = await fixture();
		try {
			const candidate = (await f.service.scan(f)).candidates[0];
			const p = await f.service.preview(candidate.id);
			const selections = [{ candidateId: candidate.id, fingerprint: p.fingerprint, cwd: f.cwd }];
			const pending = f.service.start(selections);
			selections[0].candidateId = "caller-mutated";
			selections[0].cwd = join(f.root, "missing");
			await f.service.scan({ ...f, codexRoot: f.claudeRoot });
			const job = await finish(f.service, (await pending).id);
			expect(job.results[0]).toMatchObject({ candidateId: candidate.id, status: "imported" });
		} finally {
			await f.service.close();
		}
	});

	it("excludes archives before parsing them and offers an explicit opt-in", async () => {
		const f = await fixture();
		await mkdir(join(f.codexRoot, "archived_sessions"));
		await writeFile(
			join(f.codexRoot, "archived_sessions", "rollout-archive.jsonl"),
			jsonl([meta(f.cwd, "archived"), user("old")]),
		);
		try {
			const scan = await f.service.scan(f);
			expect(scan.candidates).toHaveLength(1);
			const all = await f.service.scan({ ...f, includeArchived: true });
			expect(all.candidates).toHaveLength(2);
			expect(all.candidates.find((c) => c.sessionId === "archived")?.archived).toBe(true);
		} finally {
			await f.service.close();
		}
	});

	it("atomically publishes native sessions, skips repeated snapshots, preserves new versions and leaves sources untouched", async () => {
		const f = await fixture();
		const original = await readFile(f.source);
		try {
			const candidate = (await f.service.scan(f)).candidates[0];
			const p = await f.service.preview(candidate.id);
			const selection = { candidateId: candidate.id, fingerprint: p.fingerprint, cwd: f.cwd };
			const first = await finish(f.service, (await f.service.start([selection])).id);
			expect(first.results[0].status).toBe("imported");
			const path = first.results[0].path;
			expect(path).toBeTruthy();
			const session = SessionManager.open(path as string);
			expect(JSON.stringify(session.buildSessionContext().messages)).toContain("migration facts");
			session.appendMessage({ role: "user", content: "Continue in SCD", timestamp: Date.now() });
			const second = await finish(f.service, (await f.service.start([selection])).id);
			expect(second.results[0].status).toBe("skipped");
			expect(await readFile(path as string, "utf8")).toContain("Continue in SCD");
			expect(await readFile(f.source)).toEqual(original);
			await writeFile(f.source, `${original.toString("utf8")}${jsonl([user("new source turn")])}`);
			const stale = await finish(f.service, (await f.service.start([selection])).id);
			expect(stale.results[0].status).toBe("skipped");
			const updated = await f.service.preview(candidate.id);
			const third = await finish(
				f.service,
				(await f.service.start([{ ...selection, fingerprint: updated.fingerprint }])).id,
			);
			expect(third.results[0].sessionId).not.toBe(first.results[0].sessionId);
			expect(f.events).toHaveLength(4);
			expect(await readdir(join(f.agentDir, "sessions", "imported"))).toHaveLength(2);
		} finally {
			await f.service.close();
		}
	});

	it("imports the reviewed snapshot even when an active source appends metadata and messages", async () => {
		const f = await fixture();
		try {
			const c = (await f.service.scan(f)).candidates[0];
			const p = await f.service.preview(c.id);
			await writeFile(
				f.source,
				`${await readFile(f.source, "utf8")}${jsonl([
					{ type: "event_msg", timestamp, payload: { type: "token_count", info: {} } },
					user("not reviewed"),
				])}`,
			);
			const job = await finish(
				f.service,
				(await f.service.start([{ candidateId: c.id, fingerprint: p.fingerprint, cwd: f.cwd }])).id,
			);
			expect(job.results[0].status).toBe("imported");
			const saved = await readFile(job.results[0].path as string, "utf8");
			expect(saved).toContain("Keep migration facts");
			expect(saved).not.toContain("not reviewed");
			expect(saved).toContain(p.fingerprint);
		} finally {
			await f.service.close();
		}
	});

	it("serializes concurrent duplicate jobs and restores persisted results after restart", async () => {
		const f = await fixture();
		const candidate = (await f.service.scan(f)).candidates[0];
		const p = await f.service.preview(candidate.id);
		const selection = { candidateId: candidate.id, fingerprint: p.fingerprint, cwd: f.cwd };
		const jobs = await Promise.all([f.service.start([selection]), f.service.start([selection])]);
		await Promise.all(jobs.map((j) => finish(f.service, j.id)));
		await f.service.close();
		const results = await Promise.all(jobs.map((j) => f.service.getJob(j.id)));
		expect(results.flatMap((j) => j.results.map((r) => r.status)).sort()).toEqual(["imported", "skipped"]);
		const restarted = new SessionImportService({ agentDir: f.agentDir });
		try {
			expect(await restarted.listJobs()).toHaveLength(2);
			await writeFile(
				join(f.agentDir, "session-imports", `${jobs[0].id}.json`),
				JSON.stringify({ ...jobs[0], status: "running" }),
			);
			expect((await restarted.getJob(jobs[0].id)).status).toBe("interrupted");
		} finally {
			await restarted.close();
		}
	});

	it("rejects expired or unreviewed fingerprints without creating jobs", async () => {
		const f = await fixture();
		try {
			const c = (await f.service.scan(f)).candidates[0];
			const p = await f.service.preview(c.id);
			await expect(
				f.service.start([{ candidateId: c.id, fingerprint: "f".repeat(64), cwd: f.cwd }]),
			).rejects.toThrow("Preview expired");
			const now = Date.now();
			const clock = vi.spyOn(Date, "now").mockReturnValue(now + 16 * 60 * 1000);
			try {
				await expect(
					f.service.start([{ candidateId: c.id, fingerprint: p.fingerprint, cwd: f.cwd }]),
				).rejects.toThrow("Preview expired");
			} finally {
				clock.mockRestore();
			}
			expect(await f.service.listJobs()).toHaveLength(0);
			const refreshed = await f.service.preview(c.id);
			const job = await finish(
				f.service,
				(await f.service.start([{ candidateId: c.id, fingerprint: refreshed.fingerprint, cwd: f.cwd }])).id,
			);
			expect(job.results[0].status).toBe("imported");
		} finally {
			await f.service.close();
		}
	});

	it("reports durable imports as successful even if the search-index callback fails", async () => {
		const f = await fixture();
		const service = new SessionImportService({
			agentDir: f.agentDir,
			onPersisted: () => {
				throw new Error("index unavailable");
			},
		});
		try {
			const c = (await service.scan(f)).candidates[0];
			const p = await service.preview(c.id);
			const job = await finish(
				service,
				(await service.start([{ candidateId: c.id, fingerprint: p.fingerprint, cwd: f.cwd }])).id,
			);
			expect(job.results[0]).toMatchObject({ status: "imported", title: p.title });
			expect(job.results[0].warning).toContain("index unavailable");
			expect(SessionManager.open(job.results[0].path as string).buildSessionContext().messages).not.toHaveLength(0);
		} finally {
			await service.close();
			await f.service.close();
		}
	});

	it("validates source bounds, destination and snapshot fingerprints", async () => {
		const f = await fixture();
		try {
			const c = (await f.service.scan(f)).candidates[0];
			const p = await f.service.preview(c.id);
			expect(p.fingerprint).toBe(
				createHash("sha256")
					.update(await readFile(f.source))
					.digest("hex"),
			);
			await expect(f.service.start([{ candidateId: c.id, fingerprint: "bad", cwd: f.cwd }])).rejects.toThrow(
				"Invalid selection",
			);
			const job = await finish(
				f.service,
				(await f.service.start([{ candidateId: c.id, fingerprint: p.fingerprint, cwd: join(f.root, "missing") }]))
					.id,
			);
			expect(job.results[0].status).toBe("failed");
			await expect(f.service.preview("unknown")).rejects.toThrow("expired");
		} finally {
			await f.service.close();
		}
	});

	it("copies only contained image attachments and fingerprints their contents", async () => {
		const f = await fixture();
		const image = join(f.codexRoot, "image.png");
		await writeFile(image, Buffer.from("89504e470d0a1a0a01020304", "hex"));
		await writeFile(
			f.source,
			jsonl([
				meta(f.cwd),
				item({
					type: "message",
					role: "user",
					content: [
						{ type: "input_text", text: "inspect image" },
						{ type: "input_image", image_url: image },
						{ type: "input_image", image_url: join(f.root, "outside.png") },
					],
				}),
			]),
		);
		try {
			const c = (await f.service.scan(f)).candidates[0];
			const p = await f.service.preview(c.id);
			expect(p.warnings).toContainEqual({ code: "attachment_missing", count: 1 });
			await writeFile(image, Buffer.from("89504e470d0a1a0a05060708", "hex"));
			const changed = await f.service.preview(c.id);
			expect(changed.fingerprint).not.toBe(p.fingerprint);
			const reviewed = await finish(
				f.service,
				(await f.service.start([{ candidateId: c.id, fingerprint: p.fingerprint, cwd: f.cwd }])).id,
			);
			expect(await readFile(reviewed.results[0].path as string, "utf8")).toContain(
				Buffer.from("89504e470d0a1a0a01020304", "hex").toString("base64"),
			);
			const job = await finish(
				f.service,
				(await f.service.start([{ candidateId: c.id, fingerprint: changed.fingerprint, cwd: f.cwd }])).id,
			);
			expect(await readFile(job.results[0].path as string, "utf8")).toContain('"mimeType":"image/png"');
		} finally {
			await f.service.close();
		}
	});

	it("reopens compacted attachments and failed tool evidence into a real continuation request", async () => {
		const f = await fixture();
		const image = Buffer.from("89504e470d0a1a0a01020304", "hex");
		await writeFile(join(f.codexRoot, "retained.png"), image);
		await writeFile(
			f.source,
			jsonl([
				meta(f.cwd),
				user("old detail"),
				{
					type: "compacted",
					timestamp,
					payload: {
						message: "Continue inspecting the retained image",
						replacement_history: [
							{
								type: "message",
								role: "user",
								content: [
									{ type: "input_text", text: "Retained caption" },
									{ type: "input_image", image_url: "retained.png" },
									{ type: "input_image", image_url: "missing.png" },
								],
							},
						],
					},
				},
			]),
		);
		const h = await createHarness({ tools: [], settings: { compaction: { enabled: false } } });
		try {
			const c = (await f.service.scan(f)).candidates[0];
			const p = await f.service.preview(c.id);
			expect(p.warnings).toContainEqual({ code: "attachment_missing", count: 1 });
			const job = await finish(
				f.service,
				(await f.service.start([{ candidateId: c.id, fingerprint: p.fingerprint, cwd: f.cwd }])).id,
			);
			expect(job.results[0].status).toBe("imported");
			const reopened = SessionManager.open(job.results[0].path as string);
			const failedTool = parseForeignSession(
				"claude-code",
				jsonl([
					{ type: "user", uuid: "u", sessionId: "cc", message: { content: "write" } },
					{
						type: "assistant",
						uuid: "a",
						parentUuid: "u",
						sessionId: "cc",
						message: { content: [{ type: "tool_use", id: "t", name: "Write", input: {} }] },
					},
					{
						type: "user",
						uuid: "r",
						parentUuid: "a",
						sessionId: "cc",
						message: { content: [{ type: "tool_result", tool_use_id: "t", content: "done", is_error: true }] },
					},
				]),
			);
			h.session.agent.state.messages = [
				...reopened.buildSessionContext().messages,
				...buildSessionContext(failedTool.entries).messages,
			];
			let observed = false;
			h.setResponses([
				(context) => {
					const request = JSON.stringify(context.messages);
					expect(request).toContain('"type":"image"');
					expect(request).toContain(image.toString("base64"));
					expect(request).toContain("Retained caption");
					expect(request).toContain("status: failed");
					expect(request).not.toContain("old detail");
					expect(request).not.toContain('"type":"toolCall"');
					observed = true;
					return fauxAssistantMessage("Verified retained image and failed historical tool");
				},
			]);
			await h.session.prompt("Continue from the migrated evidence.");
			expect(observed).toBe(true);
		} finally {
			h.cleanup();
			await f.service.close();
		}
	});

	it("cancels remaining work and does not publish half-written sessions", async () => {
		const f = await fixture();
		try {
			const c = (await f.service.scan(f)).candidates[0];
			const p = await f.service.preview(c.id);
			const selections = Array.from({ length: 100 }, () => ({
				candidateId: c.id,
				fingerprint: p.fingerprint,
				cwd: f.cwd,
			}));
			const job = await f.service.start(selections);
			await f.service.cancel(job.id);
			const settled = await finish(f.service, job.id);
			expect(settled.status).toBe("cancelled");
			expect(settled.results.length).toBeLessThan(100);
		} finally {
			await f.service.close();
		}
	});

	it("continues a reopened import through a faux provider and executes only a new native tool", async () => {
		const f = await fixture();
		await writeFile(
			f.source,
			jsonl([
				meta(f.cwd),
				user("Migration proof must be written only after continuation"),
				item({
					type: "function_call",
					call_id: "old-tool",
					name: "exec_command",
					arguments: '{"cmd":"never replay"}',
				}),
				item({ type: "function_call_output", call_id: "old-tool", output: "historical evidence" }),
			]),
		);
		const h = await createHarness({ tools: [createWriteTool(f.cwd)], settings: { compaction: { enabled: false } } });
		try {
			const c = (await f.service.scan(f)).candidates[0];
			const p = await f.service.preview(c.id);
			const job = await finish(
				f.service,
				(await f.service.start([{ candidateId: c.id, fingerprint: p.fingerprint, cwd: f.cwd }])).id,
			);
			const loaded = SessionManager.open(job.results[0].path as string).buildSessionContext();
			h.session.agent.state.messages = loaded.messages;
			let observed = false;
			h.setResponses([
				(context) => {
					const request = JSON.stringify(context.messages);
					expect(request).toContain("historical evidence");
					expect(request).toContain("Migration proof");
					expect(request).not.toContain('"type":"toolCall"');
					observed = true;
					return fauxAssistantMessage(
						fauxToolCall("write", { path: "migration-proof.txt", content: "continued safely" }),
						{ stopReason: "toolUse" },
					);
				},
				fauxAssistantMessage("Continuation complete"),
			]);
			await h.session.prompt("Continue and write the migration proof.");
			expect(observed).toBe(true);
			expect(await readFile(join(f.cwd, "migration-proof.txt"), "utf8")).toBe("continued safely");
		} finally {
			h.cleanup();
			await f.service.close();
		}
	});
});
