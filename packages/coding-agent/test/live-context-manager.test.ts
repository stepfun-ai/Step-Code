import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@step-harness/agent-core";
import { fauxAssistantMessage } from "@step-harness/providers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompactionPreparation } from "../src/core/compaction/compaction.ts";
import { LiveContextManager } from "../src/core/compaction/live-context/manager.ts";
import { createFileOps } from "../src/core/compaction/utils.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(persisted = false) {
	const directory = mkdtempSync(join(tmpdir(), "step-clm-manager-"));
	roots.push(directory);
	const session = persisted ? SessionManager.create(directory, directory) : SessionManager.inMemory();
	const raw: AgentMessage[] = [
		{ role: "user", content: "Fix parser; preserve the public API.", timestamp: 1 },
		fauxAssistantMessage("OLD DETAIL to replace", { timestamp: 2 }),
		{ role: "user", content: "Continue", timestamp: 3 },
		fauxAssistantMessage("current state", { timestamp: 4 }),
	];
	for (const message of raw) {
		if (message.role === "user" || message.role === "assistant" || message.role === "toolResult")
			session.appendMessage(message);
	}
	return { directory, session, raw, manager: new LiveContextManager(session, { directory }) };
}
function edit(manager: LiveContextManager, before: string, after: string) {
	const path = manager.status().path!;
	writeFileSync(path, readFileSync(path, "utf8").replace(before, after));
}

describe("live context manager", () => {
	it("applies an edit only to working context and preserves the newly appended tail", async () => {
		const { manager, raw, session } = fixture();
		await manager.prepare(raw);
		edit(manager, "OLD DETAIL to replace", "Parser uses a naive comma split; use csv.reader.");
		const tail = fauxAssistantMessage("new result", { timestamp: 5 });
		raw.push(tail);
		session.appendMessage(tail);
		const event = await manager.accept(raw);
		expect(event?.accepted).toBe(true);
		const next = manager.project(raw);
		expect(JSON.stringify(next)).toContain("use csv.reader");
		expect(JSON.stringify(next)).not.toContain("OLD DETAIL");
		expect(next.at(-1)).toBe(tail);
		expect(JSON.stringify(session.getEntries())).toContain("OLD DETAIL");
		expect(raw[1]).toMatchObject({ content: [{ text: "OLD DETAIL to replace" }] });
	});
	it("offers a bounded index so inspecting large context does not echo the transcript", async () => {
		const { manager, raw } = fixture();
		const old = raw[1];
		if (old.role !== "assistant") throw new Error("fixture");
		old.content = [{ type: "text", text: "obsolete diagnostic observation\n".repeat(7000) }];
		await manager.prepare(raw);
		const status = manager.status();
		const index = readFileSync(status.indexPath, "utf8");
		expect(index.length).toBeLessThanOrEqual(6000);
		expect(index).toContain("read-only");
		expect(index).toContain("assistant");
		expect(index).toContain("body starts at line");
		expect(index).not.toContain("preserve the public API");
		expect(index).not.toContain("obsolete diagnostic observation\n".repeat(20));
		expect(manager.guidance()).toContain(status.indexPath);
	});
	it("prioritizes task completion when the host handles automatic context maintenance", () => {
		const { manager } = fixture();
		const guidance = manager.guidance({ automaticMaintenance: true });
		expect(guidance).toContain("The host handles routine context reductions");
		expect(guidance).toContain("finish task tracking and return the final answer");
		expect(guidance).toContain("Do not inspect or edit the mirror solely to wrap up a completed task");
		expect(guidance).not.toContain("Summarize obsolete observations at completed subtasks");
		expect(guidance).toContain(manager.status().path);
		expect(guidance).toContain(manager.status().indexPath);
		expect(guidance).toContain("retaining exact errors, decisions, failed approaches, and next actions");
	});
	it("retains the full editing instructions for manual context management", () => {
		const { manager } = fixture();
		expect(manager.guidance()).toContain("Summarize obsolete observations at completed subtasks");
		expect(manager.guidance({ automaticMaintenance: false })).toBe(manager.guidance());
		expect(manager.guidance()).not.toContain("The host handles routine context reductions");
	});

	it("restores an accepted revision from session custom entries", async () => {
		const { manager, raw, session, directory } = fixture();
		await manager.prepare(raw);
		edit(manager, "OLD DETAIL to replace", "retained finding");
		await manager.accept(raw);
		const restored = new LiveContextManager(session, { directory });
		expect(JSON.stringify(restored.project(raw))).toContain("retained finding");
		expect(restored.status().revision).toBe(1);
	});
	it("does not reuse a checkpoint on another branch", async () => {
		const { manager, raw, session } = fixture();
		const oldLeaf = session.getLeafId()!;
		await manager.prepare(raw);
		edit(manager, "OLD DETAIL to replace", "branch finding");
		await manager.accept(raw);
		session.branch(oldLeaf);
		expect(manager.project(raw)).toEqual(raw);
	});
	it("keeps a last valid revision when a draft edits a protected instruction", async () => {
		const { manager, raw } = fixture();
		await manager.prepare(raw);
		edit(manager, "OLD DETAIL to replace", "accepted finding");
		await manager.accept(raw);
		await manager.prepare(raw);
		edit(manager, "preserve the public API", "delete the public API");
		expect((await manager.accept(raw))?.accepted).toBe(false);
		expect(JSON.stringify(manager.project(raw))).toContain("accepted finding");
		expect(JSON.stringify(manager.project(raw))).toContain("preserve the public API");
	});
	it("rejects a draft when its raw source prefix changed", async () => {
		const { manager, raw } = fixture();
		await manager.prepare(raw);
		edit(manager, "OLD DETAIL to replace", "stale finding");
		raw[0] = { role: "user", content: "another task", timestamp: 10 };
		expect((await manager.accept(raw))?.accepted).toBe(false);
		expect(manager.project(raw)).toEqual(raw);
	});
	it("does not activate an edit that cannot be persisted", async () => {
		const { manager, raw, session } = fixture();
		await manager.prepare(raw);
		edit(manager, "OLD DETAIL to replace", "unsaved finding");
		vi.spyOn(session, "appendCustomEntry").mockImplementation(() => {
			throw new Error("disk full");
		});
		const result = await manager.accept(raw);
		expect(result?.accepted).toBe(false);
		expect(result?.reason).toContain("disk full");
		expect(manager.project(raw)).toEqual(raw);
	});
	it("archives the previous editable context before accepting an edit", async () => {
		const { manager, raw } = fixture();
		await manager.prepare(raw);
		edit(manager, "OLD DETAIL to replace", "brief finding");
		const result = await manager.accept(raw);
		expect(readFileSync(result!.archivePath!, "utf8")).toContain("OLD DETAIL to replace");
	});
	it("abandons a pending edit on cancellation", async () => {
		const { manager, raw } = fixture();
		await manager.prepare(raw);
		edit(manager, "OLD DETAIL to replace", "cancelled finding");
		const signal = AbortSignal.abort();
		await manager.accept(raw, signal);
		expect(manager.project(raw)).toEqual(raw);
	});
	it("resets working context with a branch-local reset entry", async () => {
		const { manager, raw, session, directory } = fixture();
		await manager.prepare(raw);
		edit(manager, "OLD DETAIL to replace", "finding");
		await manager.accept(raw);
		manager.reset();
		expect(manager.project(raw)).toEqual(raw);
		expect(new LiveContextManager(session, { directory }).project(raw)).toEqual(raw);
	});
	it("does not activate an in-memory entry left by a real persistence failure", async () => {
		const { manager, raw, session } = fixture();
		await manager.prepare(raw);
		edit(manager, "OLD DETAIL to replace", "must not become active");
		vi.spyOn(session, "_persist").mockImplementation(() => {
			throw new Error("disk full after append");
		});
		expect((await manager.accept(raw))?.accepted).toBe(false);
		expect(manager.project(raw)).toEqual(raw);
		expect(
			session.getEntries().some((entry) => entry.type === "custom" && entry.customType === "step-live-context"),
		).toBe(false);
	});

	it("restores projected context when canonical history contains a retried provider error", async () => {
		const { manager, raw, session, directory } = fixture();
		const failed = fauxAssistantMessage("", { stopReason: "error", errorMessage: "transient", timestamp: 0 });
		await manager.prepare(raw);
		edit(manager, "OLD DETAIL to replace", "survives retry and resume");
		await manager.accept(raw);
		const restored = new LiveContextManager(session, { directory });
		const withError = [failed, ...raw];
		expect(JSON.stringify(restored.project(withError))).toContain("survives retry and resume");
		expect(JSON.stringify(restored.project(withError))).not.toContain("OLD DETAIL");
	});
	it("restores edits and readable archives after closing and reopening a JSONL session", async () => {
		const { manager, raw, session, directory } = fixture(true);
		await manager.prepare(raw);
		edit(manager, "OLD DETAIL to replace", "persisted working finding");
		const accepted = await manager.accept(raw);
		manager.dispose();
		const reopened = SessionManager.open(session.getSessionFile()!, directory);
		const restored = new LiveContextManager(reopened, { directory });
		const context = reopened.buildSessionContext().messages;
		expect(JSON.stringify(restored.project(context))).toContain("persisted working finding");
		expect(readFileSync(accepted!.archivePath!, "utf8")).toContain("OLD DETAIL to replace");
	});
	it.each([
		["hostExcludedIndexes", 3],
		["hostExcludedIndexes", [-1]],
		["hostExcludedIndexes", [999]],
		["retrySourceIndexes", "invalid"],
		["retrySourceIndexes", [0.5]],
		["sourceHashes", 3],
		["sourceHashes", ["invalid"]],
	])("ignores malformed persisted %s=%j when resuming a retried context", async (field, value) => {
		const { manager, raw, session, directory } = fixture(true);
		await manager.prepare(raw);
		edit(manager, "OLD DETAIL to replace", "persisted edited finding");
		expect((await manager.accept(raw))?.accepted).toBe(true);
		const file = session.getSessionFile()!;
		const rows = readFileSync(file, "utf8")
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line));
		const saved = rows.find((entry) => entry.type === "custom" && entry.customType === "step-live-context");
		saved.data[field] = value;
		writeFileSync(file, `${rows.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		const reopened = SessionManager.open(file, directory);
		const restored = new LiveContextManager(reopened, { directory });
		const context = [
			fauxAssistantMessage("", { stopReason: "error", timestamp: 0 }),
			...reopened.buildSessionContext().messages,
		];
		expect(restored.project(context)).toEqual(context);
		await expect(restored.prepare(context)).resolves.toEqual(context);
	});
	it.each([
		{ role: "assistant" },
		{ role: "assistant", content: "invalid assistant content" },
		{ role: "assistant", content: [null] },
		{ role: "assistant", content: [{ type: "text", text: 3 }] },
		{ role: "toolResult", content: [] },
		{ role: "custom", content: null },
		{ role: "compactionSummary", summary: null },
	])("ignores malformed saved messages on resume: %j", async (message) => {
		const { manager, raw, session, directory } = fixture(true);
		await manager.prepare(raw);
		edit(manager, "OLD DETAIL to replace", "persisted edited finding");
		expect((await manager.accept(raw))?.accepted).toBe(true);
		const file = session.getSessionFile()!;
		const rows = readFileSync(file, "utf8")
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line));
		const saved = rows.find((entry) => entry.type === "custom" && entry.customType === "step-live-context");
		saved.data.messages[1] = message;
		writeFileSync(file, `${rows.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		const reopened = SessionManager.open(file, directory);
		const restored = new LiveContextManager(reopened, { directory });
		const context = reopened.buildSessionContext().messages;
		expect(restored.project(context)).toEqual(context);
		await expect(restored.prepare(context)).resolves.toEqual(context);
	});

	it("re-arms bounded budget reminders after a context reduction", () => {
		const { manager } = fixture();
		expect(manager.budgetNotice(10000, 100000)).toBeUndefined();
		expect(manager.budgetNotice(65000, 100000)?.content).toContain("65,000");
		expect(manager.budgetNotice(66000, 100000)).toBeUndefined();
		expect(manager.budgetNotice(20000, 100000)).toBeUndefined();
		expect(manager.budgetNotice(76000, 100000)?.content).toContain("76,000");
	});
	it("keeps automatic budget reminders informational instead of asking the task agent to edit", () => {
		const { manager } = fixture();
		const notice = manager.budgetNotice(65000, 100000, { automaticMaintenance: true });
		expect(notice?.content).toContain("65,000");
		expect(notice?.content).toContain("The host handles routine context reductions");
		expect(notice?.content).not.toContain("before the next task request");
		expect(notice?.content).not.toContain("Consider one batched edit");
	});
	it("distinguishes identical message occurrences on opposite sides of a native cut", async () => {
		const { directory } = fixture();
		const session = SessionManager.inMemory();
		const duplicate = fauxAssistantMessage("duplicate message", { timestamp: 10 });
		const raw = [
			{ role: "user" as const, content: "first task", timestamp: 1 },
			duplicate,
			{ role: "user" as const, content: "second step", timestamp: 2 },
			structuredClone(duplicate),
			{ role: "user" as const, content: "third step", timestamp: 3 },
			fauxAssistantMessage("current", { timestamp: 11 }),
		];
		const ids = raw.map((m) => session.appendMessage(m));
		const manager = new LiveContextManager(session, { directory });
		await manager.prepare(raw);
		const path = manager.status().path;
		writeFileSync(
			path,
			readFileSync(path, "utf8").replace(/(index=4[^\n]*\n)duplicate message/, "$1EDITED SECOND OCCURRENCE"),
		);
		expect((await manager.accept(raw))?.accepted).toBe(true);
		const preparation: CompactionPreparation = {
			firstKeptEntryId: ids[3],
			messagesToSummarize: raw.slice(0, 3),
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			fileOps: createFileOps(),
			settings: { enabled: true, keepRecentTokens: 20, reserveTokens: 100 },
		};
		const prepared = manager.prepareCompaction(preparation, raw);
		expect(JSON.stringify(prepared.preparation.messagesToSummarize)).not.toContain("EDITED SECOND OCCURRENCE");
		expect(JSON.stringify(prepared.tail.messages)).toContain("EDITED SECOND OCCURRENCE");
	});

	it("preserves projected retained history across consecutive native compactions", async () => {
		const { manager, raw, session } = fixture();
		await manager.prepare(raw);
		edit(manager, "OLD DETAIL to replace", "EDITED KEPT DETAIL");
		await manager.accept(raw);
		const keptEntry = session.getBranch().find((e) => e.type === "message" && e.message === raw[1])!;
		const settings = { enabled: true, keepRecentTokens: 10000, reserveTokens: 100 };
		const preparation: CompactionPreparation = {
			firstKeptEntryId: keptEntry.id,
			messagesToSummarize: [raw[0]],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			fileOps: createFileOps(),
			settings,
		};
		const first = manager.prepareCompaction(preparation, raw);
		session.appendCompaction("first summary", keptEntry.id, 100, { liveContext: first.tail });
		let rebuilt = session.buildSessionContext().messages;
		expect(JSON.stringify(manager.project(rebuilt))).toContain("EDITED KEPT DETAIL");
		session.appendMessage({ role: "user", content: "continue", timestamp: 20 });
		session.appendMessage(fauxAssistantMessage("latest", { timestamp: 21 }));
		rebuilt = session.buildSessionContext().messages;
		const secondPreparation = { ...preparation, messagesToSummarize: [rebuilt[0]], previousSummary: "first summary" };
		const second = manager.prepareCompaction(secondPreparation, rebuilt);
		session.appendCompaction("second summary", keptEntry.id, 100, { liveContext: second.tail });
		const next = manager.project(session.buildSessionContext().messages);
		expect(JSON.stringify(next)).toContain("EDITED KEPT DETAIL");
		expect(JSON.stringify(next)).not.toContain("OLD DETAIL to replace");
	});

	it("matches persisted custom messages without relying on their enqueue timestamp", async () => {
		const { manager, raw, session, directory } = fixture();
		const notification = {
			role: "custom" as const,
			customType: "agent-notification",
			display: false,
			content: "PROTECTED_EVIDENCE",
			timestamp: 5,
		};
		raw.push(notification);
		session.appendCustomMessageEntry(notification.customType, notification.content, notification.display);
		await manager.prepare(raw);
		edit(manager, "OLD DETAIL to replace", "persistent finding");
		await manager.accept(raw);
		const restored = new LiveContextManager(session, { directory });
		const next = restored.project(session.buildSessionContext().messages);
		expect(JSON.stringify(next)).toContain("persistent finding");
		expect(JSON.stringify(next)).toContain("PROTECTED_EVIDENCE");
	});
});
