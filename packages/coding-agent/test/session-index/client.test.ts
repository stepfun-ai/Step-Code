import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withSessionIndex } from "../../src/core/session-index/attach.ts";
import { openSessionIndex } from "../../src/core/session-index/client.ts";
import type { SessionIndex, SessionIndexHitBatch, SessionIndexQuery } from "../../src/core/session-index/types.ts";
import { type SessionFilePersistedEvent, SessionManager } from "../../src/core/session-manager.ts";
import { nativeSessionManagerFactory } from "../../src/core/session-manager-factory.ts";

const NOW = Date.now();

function writeSession(path: string, id: string, text: string): void {
	writeFileSync(
		path,
		`${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date(NOW).toISOString(), cwd: "/work/app" })}\n${JSON.stringify(
			{
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: new Date(NOW).toISOString(),
				message: { role: "user", content: text, timestamp: NOW },
			},
		)}\n`,
	);
}

async function collect(index: SessionIndex, query: SessionIndexQuery): Promise<SessionIndexHitBatch[]> {
	const batches: SessionIndexHitBatch[] = [];
	for await (const batch of index.search(query)) batches.push(batch);
	return batches;
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("openSessionIndex", () => {
	let agentDir: string;
	let sessionDir: string;
	let index: SessionIndex | undefined;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "session-index-client-"));
		sessionDir = join(agentDir, "sessions", "--work-app--");
		mkdirSync(sessionDir, { recursive: true });
	});

	afterEach(async () => {
		await index?.close();
		index = undefined;
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("backfills existing sessions in the worker and serves searches", async () => {
		writeSession(join(sessionDir, "a.jsonl"), "a", "worker backed search");
		index = await openSessionIndex({ agentDir });
		await waitFor(async () => (await index!.status()).indexed === 1);

		const [batch] = await collect(index, { text: "backed", limit: 10 });
		expect(batch?.hits.some((hit) => hit.entryId === "m1")).toBe(true);
		expect(batch?.coverage).toEqual({ indexed: 1, total: 1 });
		expect((await index.status()).state).not.toBe("degraded");
	});

	it("syncs files reported through notifyPersisted", async () => {
		index = await openSessionIndex({ agentDir, debounceMs: 5 });
		const path = join(sessionDir, "b.jsonl");
		writeSession(path, "b", "notified later");
		index.notifyPersisted({ path, kind: "create" });
		await waitFor(async () => {
			const [batch] = await collect(index!, { text: "notified", limit: 10 });
			return (batch?.hits.length ?? 0) > 0;
		});
		const page = await index.listSessions({ limit: 10 });
		expect(page.sessions.map((session) => session.id)).toEqual(["b"]);
		expect(page.sessions[0]?.modified).toBeInstanceOf(Date);
	});

	it("reports reindex progress", async () => {
		writeSession(join(sessionDir, "a.jsonl"), "a", "first");
		writeSession(join(sessionDir, "b.jsonl"), "b", "second");
		index = await openSessionIndex({ agentDir, backfill: false });
		const progress = [];
		for await (const step of index.reindex({ full: true })) progress.push(step);
		expect(progress.at(-1)).toEqual({ indexed: 2, total: 2, done: true });
	});

	it("falls back to a JSONL scan when the database belongs to something else", async () => {
		const dbPath = join(agentDir, "index", "session-search.v1.db");
		mkdirSync(dirname(dbPath), { recursive: true });
		const foreign = new DatabaseSync(dbPath);
		foreign.exec("CREATE TABLE other(x)");
		foreign.close();
		writeSession(join(sessionDir, "a.jsonl"), "a", "scan fallback text");
		// The scan skips child-agent sessions as the index does.
		writeSession(join(sessionDir, "child.jsonl"), "subagent-1", "scan fallback text");

		index = await openSessionIndex({ agentDir });
		const status = await index.status();
		expect(status.state).toBe("degraded");
		expect(status.degradedReason).toMatch(/not a Step session index/u);
		const [batch] = await collect(index, { text: "fallback", limit: 10 });
		expect(batch?.hits).toHaveLength(1);
		expect(batch?.hits[0]?.entryId).toBeNull();
		expect((await index.listSessions({ limit: 10 })).sessions.map((session) => session.id)).toEqual(["a"]);
	});

	it("finds files written by another process without a notification", async () => {
		rmSync(join(agentDir, "sessions"), { recursive: true, force: true });
		index = await openSessionIndex({ agentDir });
		await waitFor(async () => (await index!.status()).state === "ready");

		// The default root did not exist when the index opened, as on a fresh install.
		const otherDir = join(agentDir, "sessions", "--work-other--");
		mkdirSync(otherDir, { recursive: true });
		writeSession(join(otherDir, "b.jsonl"), "b", "written elsewhere");
		const [batch] = await collect(index, { text: "elsewhere", limit: 10 });
		expect(batch?.hits.some((hit) => hit.sessionId === "b" && hit.entryId === "m1")).toBe(true);
	});

	it("reports writes from managers built by a wrapped factory", async () => {
		index = await openSessionIndex({ agentDir, debounceMs: 5, backfill: false });
		const factory = withSessionIndex(nativeSessionManagerFactory, index);
		const manager = factory.create("/work/app", sessionDir);
		manager.appendMessage({ role: "user", content: "wrapped factory write", timestamp: NOW });
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "faux",
			provider: "faux",
			model: "faux",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: NOW,
		} as never);
		await waitFor(async () => {
			const [batch] = await collect(index!, { text: "wrapped", limit: 10 });
			return (batch?.hits.length ?? 0) > 0;
		});
	});
});

describe("SessionManager file persisted listener", () => {
	it("reports create and append and ignores listener failures", () => {
		const dir = mkdtempSync(join(tmpdir(), "session-persist-"));
		try {
			const manager = SessionManager.create("/work/app", dir);
			const events: SessionFilePersistedEvent["kind"][] = [];
			manager.setFilePersistedListener((event) => {
				events.push(event.kind);
				throw new Error("listener failures must not break writes");
			});
			manager.appendMessage({ role: "user", content: "hello", timestamp: NOW });
			expect(events).toEqual([]);
			manager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
				api: "faux",
				provider: "faux",
				model: "faux",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: NOW,
			} as never);
			manager.appendSessionInfo("named");
			expect(events).toEqual(["create", "append"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
