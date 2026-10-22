import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseForeignSession } from "../src/core/session-import/parsers.ts";
import { SessionImportService } from "../src/core/session-import/service.ts";
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
	const agentDir = join(root, "target", "agent");
	await mkdir(cwd, { recursive: true });
	await mkdir(join(codexRoot, "sessions"), { recursive: true });
	await mkdir(claudeRoot);
	const source = join(codexRoot, "sessions", "rollout-one.jsonl");
	await writeFile(source, jsonl([meta(cwd), user("Keep migration facts"), reply("Confirmed")]));
	const events: string[] = [];
	const service = new SessionImportService({ agentDir, onPersisted: (event) => events.push(event.path) });
	return { root, cwd, codexRoot, claudeRoot, agentDir, source, service, events };
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

describe("offline import lifecycle", () => {
	it("discovers and imports Claude metadata in a first record larger than 64 KiB", async () => {
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
		first.message.content = `${"x".repeat(65535 - prefixBytes)}\u754c${"x".repeat(5000)}`;
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
	});

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
			expect(await f.service.scan({ ...f, codexRoot: archivedRoot })).toEqual({ candidates: [], errors: [] });
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
