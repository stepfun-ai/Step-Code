import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectEntry } from "../../src/core/session-index/projector.ts";
import {
	ForeignDatabaseError,
	openIndexDatabase,
	SCHEMA_MINOR,
	SESSION_INDEX_APPLICATION_ID,
	writeMeta,
} from "../../src/core/session-index/schema.ts";
import { SessionIndexStore } from "../../src/core/session-index/store.ts";
import { type SessionIndexHit, SNIPPET_MATCH_END, SNIPPET_MATCH_START } from "../../src/core/session-index/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const NOW = Date.parse("2026-10-01T00:00:00Z");

function entryHits(hits: SessionIndexHit[]): SessionIndexHit[] {
	return hits.filter((hit) => hit.entryId !== null);
}

function header(id: string, cwd = "/work/app", version: number | null = 3): string {
	return `${JSON.stringify({ type: "session", ...(version === null ? {} : { version }), id, timestamp: "2026-09-30T00:00:00.000Z", cwd })}\n`;
}

let counter = 0;
function message(role: "user" | "assistant", text: string, ts = NOW): string {
	counter++;
	return `${JSON.stringify({
		type: "message",
		id: `e${counter}`,
		parentId: null,
		timestamp: new Date(ts).toISOString(),
		message: { role, content: [{ type: "text", text }], timestamp: ts },
	})}\n`;
}

describe("SessionIndexStore", () => {
	let dir: string;
	let root: string;
	let store: SessionIndexStore;
	let dbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "session-index-"));
		root = join(dir, "sessions");
		mkdirSync(join(root, "--work-app--"), { recursive: true });
		dbPath = join(dir, "index.sqlite");
		store = new SessionIndexStore(openIndexDatabase(DatabaseSync, dbPath).db);
		store.addRoot(root, "default");
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const file = (name: string) => join(root, "--work-app--", `${name}.jsonl`);

	it("indexes a session and finds entries and titles with FTS", () => {
		const path = file("a");
		writeFileSync(
			path,
			header("s1") + message("user", "Fix the database migration") + message("assistant", "数据库迁移已修复"),
		);
		expect(store.syncFile(path)).toBe("indexed");

		const hits = store.search({ text: "migration", limit: 10 });
		expect(hits.map((hit) => hit.entryId)).toContain(null);
		const entryHit = hits.find((hit) => hit.entryId !== null);
		expect(entryHit).toMatchObject({ sessionId: "s1", entryType: "message", role: "user", cwd: "/work/app" });
		expect(entryHit?.snippet).toContain(`${SNIPPET_MATCH_START}migration${SNIPPET_MATCH_END}`);

		expect(store.search({ text: "数据库", limit: 10 })).toHaveLength(1);
		expect(store.syncFile(path)).toBe("skipped");
	});

	it("indexes child-agent sessions but never searches or lists them", () => {
		const childHeader = (id: string, origin?: string) =>
			`${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-30T00:00:00.000Z", cwd: "/work/app", ...(origin ? { origin } : {}) })}\n`;
		writeFileSync(file("user"), header("s1") + message("user", "quokka in the user session"));
		// Marked by the header, by the subagent id prefix, and by the workflow id prefix.
		writeFileSync(file("marked"), childHeader("c1", "subagent") + message("user", "quokka you are a subagent"));
		writeFileSync(file("lane"), childHeader("subagent-1") + message("user", "quokka lane task"));
		writeFileSync(file("flow"), childHeader("workflow-r-a") + message("user", "quokka workflow task"));
		for (const name of ["user", "marked", "lane", "flow"]) expect(store.syncFile(file(name))).toBe("indexed");

		const sessionsOf = (hits: SessionIndexHit[]) => [...new Set(hits.map((hit) => hit.sessionId))];
		expect(sessionsOf(store.search({ text: "quokka", limit: 20 }))).toEqual(["s1"]);
		expect(sessionsOf(store.search({ text: "you are a subagent", limit: 20 }))).toEqual([]);
		// Below the trigram minimum: the LIKE path and its recent-session window.
		expect(sessionsOf(store.search({ text: "qu", cwd: "/work/app", limit: 20 }, NOW))).toEqual(["s1"]);
		expect(store.listSessions({ limit: 10 }).sessions.map((session) => session.id)).toEqual(["s1"]);
		expect(store.counts().indexed).toBe(4);
	});

	it("migrates a minor-1 file by marking child sessions from their id prefix", () => {
		writeFileSync(file("user"), header("s1") + message("user", "quokka user"));
		writeFileSync(file("lane"), header("subagent-1") + message("user", "quokka lane"));
		store.syncFile(file("user"));
		store.syncFile(file("lane"));
		store.close();
		const raw = new DatabaseSync(dbPath);
		raw.exec("ALTER TABLE sessions DROP COLUMN origin");
		raw.exec("PRAGMA user_version = 1");
		raw.close();

		store = new SessionIndexStore(openIndexDatabase(DatabaseSync, dbPath).db);
		expect([...new Set(store.search({ text: "quokka", limit: 10 }).map((hit) => hit.sessionId))]).toEqual(["s1"]);
		const check = new DatabaseSync(dbPath, { readOnly: true });
		expect(check.prepare("PRAGMA user_version").get()?.user_version).toBe(SCHEMA_MINOR);
		check.close();
	});

	it("appends new lines without rebuilding and keeps list fields current", () => {
		const path = file("a");
		writeFileSync(path, header("s1") + message("user", "first question"));
		store.syncFile(path);
		appendFileSync(path, message("assistant", "an appended answer", NOW + 1000));
		appendFileSync(
			path,
			`${JSON.stringify({ type: "session_info", id: "n1", parentId: null, timestamp: "", name: "Renamed" })}\n`,
		);
		expect(store.syncFile(path)).toBe("appended");

		expect(entryHits(store.search({ text: "appended", limit: 5 }))).toHaveLength(1);
		expect(store.search({ text: "Renamed", limit: 5 })[0]?.entryId).toBeNull();
		const [item] = store.listSessions({ limit: 10 }).sessions;
		expect(item).toMatchObject({ name: "Renamed", messageCount: 2, firstMessage: "first question" });
		expect(item?.modified.getTime()).toBe(NOW + 1000);
	});

	it("rebuilds when the file is rewritten and keeps rows while it is empty", () => {
		const path = file("a");
		writeFileSync(path, header("s1") + message("user", "original wording"));
		store.syncFile(path);

		writeFileSync(path, "");
		expect(store.syncFile(path)).toBe("pending");
		expect(entryHits(store.search({ text: "original", limit: 5 }))).toHaveLength(1);

		writeFileSync(
			path,
			header("s1", "/work/app", 3).replace("2026-09-30", "2026-09-29") + message("user", "rewritten wording"),
		);
		expect(store.syncFile(path)).toBe("indexed");
		expect(entryHits(store.search({ text: "original", limit: 5 }))).toHaveLength(0);
		expect(entryHits(store.search({ text: "rewritten", limit: 5 }))).toHaveLength(1);
	});

	it("leaves an unfinished final line for the next sync", () => {
		const path = file("a");
		const line = message("user", "half written line");
		writeFileSync(path, header("s1") + line.slice(0, 20));
		store.syncFile(path);
		expect(entryHits(store.search({ text: "half written", limit: 5 }))).toHaveLength(0);

		appendFileSync(path, line.slice(20));
		expect(store.syncFile(path)).toBe("appended");
		expect(entryHits(store.search({ text: "half written", limit: 5 }))).toHaveLength(1);
	});

	it("indexes v1 files with line-number ids without modifying them", () => {
		const path = file("legacy");
		const legacyMessage = (text: string) =>
			`${JSON.stringify({ type: "message", timestamp: "2026-09-30T01:00:00.000Z", message: { role: "user", content: text } })}\n`;
		const content = header("old", "/work/app", null) + legacyMessage("legacy alpha") + legacyMessage("legacy beta");
		writeFileSync(path, content);
		store.syncFile(path);
		const ids = store.search({ text: "legacy", limit: 10 }).flatMap((hit) => (hit.entryId ? [hit.entryId] : []));
		expect(ids.sort()).toEqual(["L2", "L3"]);
		expect(readFileSync(path, "utf8")).toBe(content);
	});

	it("marks files whose first entry is not a header as errors", () => {
		const path = file("bad");
		writeFileSync(path, message("user", "no header here"));
		expect(store.syncFile(path)).toBe("error");
		expect(store.counts()).toMatchObject({ errors: 1, indexed: 0 });
	});

	it("uses bounded LIKE for queries shorter than a trigram", () => {
		const recent = file("recent");
		const old = file("old");
		writeFileSync(recent, header("r") + message("user", "fix ui bug", NOW));
		writeFileSync(old, header("o") + message("user", "old ui work", NOW - 60 * 24 * 3600 * 1000));
		store.syncFile(recent);
		store.syncFile(old);

		const hits = store.search({ text: "ui", limit: 500 }, NOW);
		expect(new Set(hits.map((hit) => hit.sessionId))).toEqual(new Set(["r"]));
		expect(hits.find((hit) => hit.entryId)?.snippet).toContain(`${SNIPPET_MATCH_START}ui${SNIPPET_MATCH_END}`);

		const scoped = store.search({ text: "ui", cwd: "/work/app", limit: 10 }, NOW);
		expect(new Set(scoped.map((hit) => hit.sessionId))).toEqual(new Set(["r", "o"]));
		expect(store.search({ text: "1%", limit: 10 }, NOW)).toHaveLength(0);
	});

	it("matches SessionManager.listAll for list fields", async () => {
		const sessionDir = join(root, "--work-app--");
		const manager = SessionManager.create("/work/app", sessionDir);
		manager.appendMessage({ role: "user", content: "hello index", timestamp: NOW });
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
			timestamp: NOW + 5,
		} as never);
		manager.appendSessionInfo("Named session");
		const plan = store.planReconcile();
		for (const path of plan.toSync) store.syncFile(path);

		const [expected] = await SessionManager.listAll(sessionDir);
		const [actual] = store.listSessions({ limit: 10, cwd: "/work/app" }).sessions;
		const { allMessagesText: _ignored, ...expectedFields } = expected!;
		expect(actual).toEqual(expectedFields);
	});

	it("pages the session list with a cursor", () => {
		for (let i = 0; i < 5; i++) {
			const path = file(`p${i}`);
			writeFileSync(path, header(`p${i}`) + message("user", `page ${i}`, NOW + i));
			store.syncFile(path);
		}
		const first = store.listSessions({ limit: 2 });
		const second = store.listSessions({ limit: 2, cursor: first.nextCursor });
		const third = store.listSessions({ limit: 2, cursor: second.nextCursor });
		expect([...first.sessions, ...second.sessions, ...third.sessions].map((s) => s.id)).toEqual([
			"p4",
			"p3",
			"p2",
			"p1",
			"p0",
		]);
		expect(third.nextCursor).toBeUndefined();
	});

	it("drops rows for deleted files only after listing their root", () => {
		const path = file("gone");
		writeFileSync(path, header("g") + message("user", "soon deleted"));
		store.syncFile(store.planReconcile().toSync[0]!);
		rmSync(path);
		expect(store.planReconcile().removed).toBe(1);
		expect(store.counts().total).toBe(0);
	});

	it("re-syncs a file whose mtime changed", () => {
		const path = file("a");
		writeFileSync(path, header("s1") + message("user", "stable text"));
		store.syncFile(path);
		utimesSync(path, new Date(NOW + 10_000), new Date(NOW + 10_000));
		expect(store.planReconcile().toSync).toEqual([path]);
		expect(store.syncFile(path)).toBe("appended");
		expect(entryHits(store.search({ text: "stable", limit: 5 }))).toHaveLength(1);
	});

	describe("refreshRecent", () => {
		const sync = (path: string) => {
			store.syncFile(path);
		};
		const touch = (path: string, ms: number) => utimesSync(path, new Date(ms), new Date(ms));

		it("picks up appends to recent files and files created after the last reconcile", () => {
			const known = file("known");
			writeFileSync(known, header("s1") + message("user", "first words"));
			for (const path of store.planReconcile().toSync) store.syncFile(path);

			appendFileSync(known, message("assistant", "appended paragraph"));
			const sibling = file("sibling");
			writeFileSync(sibling, header("s2") + message("user", "sibling session"));
			touch(join(root, "--work-app--"), NOW + 1_000);
			const otherDir = join(root, "--work-other--");
			mkdirSync(otherDir);
			writeFileSync(join(otherDir, "c.jsonl"), header("s3", "/work/other") + message("user", "another project"));
			touch(root, NOW + 2_000);

			expect(store.refreshRecent(Date.now() + 10_000, sync)).toBe(true);
			expect(entryHits(store.search({ text: "appended", limit: 5 }))).toHaveLength(1);
			expect(entryHits(store.search({ text: "sibling", limit: 5 }))).toHaveLength(1);
			expect(entryHits(store.search({ text: "another", limit: 5 }))).toHaveLength(1);
		});

		it("watches a root that did not exist at the last reconcile", () => {
			rmSync(root, { recursive: true, force: true });
			expect(store.planReconcile().total).toBe(0);
			mkdirSync(join(root, "--work-app--"), { recursive: true });
			writeFileSync(file("new"), header("s1") + message("user", "lazily created root"));

			expect(store.refreshRecent(Date.now() + 10_000, sync)).toBe(true);
			expect(entryHits(store.search({ text: "lazily", limit: 5 }))).toHaveLength(1);
		});

		it("stops at the deadline and leaves the rest for a later pass", () => {
			const path = file("a");
			writeFileSync(path, header("s1") + message("user", "first words"));
			for (const candidate of store.planReconcile().toSync) store.syncFile(candidate);
			const late = file("late");
			writeFileSync(late, header("s2") + message("user", "late arrival"));
			touch(join(root, "--work-app--"), NOW + 1_000);

			expect(store.refreshRecent(Date.now() - 1, sync)).toBe(false);
			expect(store.search({ text: "arrival", limit: 5 })).toHaveLength(0);
			expect(store.refreshRecent(Date.now() + 10_000, sync)).toBe(true);
			expect(entryHits(store.search({ text: "arrival", limit: 5 }))).toHaveLength(1);
		});
	});
});

describe("openIndexDatabase", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "session-index-db-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("refuses to touch a database it does not own", () => {
		const path = join(dir, "foreign.sqlite");
		const foreign = new DatabaseSync(path);
		foreign.exec("CREATE TABLE notes(x)");
		foreign.close();
		const before = readFileSync(path);
		expect(() => openIndexDatabase(DatabaseSync, path)).toThrow(ForeignDatabaseError);
		expect(readFileSync(path).equals(before)).toBe(true);
	});

	it("quarantines a corrupt file and starts empty", () => {
		const path = join(dir, "index.sqlite");
		writeFileSync(path, "this is not sqlite at all".repeat(100));
		const { db, recreated } = openIndexDatabase(DatabaseSync, path);
		db.close();
		expect(recreated).toBe("corrupt");
		expect(existsSync(path)).toBe(true);
	});

	it("rebuilds FTS from entries when the FTS definition changes", () => {
		const path = join(dir, "index.sqlite");
		const root = join(dir, "sessions");
		mkdirSync(root);
		const session = join(root, "a.jsonl");
		writeFileSync(session, header("s1") + message("user", "kept through rebuild"));
		let store = new SessionIndexStore(openIndexDatabase(DatabaseSync, path).db);
		store.addRoot(root, "custom");
		store.syncFile(session);
		store.close();

		const raw = new DatabaseSync(path);
		writeMeta(raw, "fts_definition", "older-tokenizer");
		raw.close();

		store = new SessionIndexStore(openIndexDatabase(DatabaseSync, path).db);
		expect(entryHits(store.search({ text: "rebuild", limit: 5 }))).toHaveLength(1);
		store.close();
	});

	it("stamps the documented identity and version", () => {
		const path = join(dir, "index.sqlite");
		openIndexDatabase(DatabaseSync, path).db.close();
		const raw = new DatabaseSync(path, { readOnly: true });
		expect(raw.prepare("PRAGMA application_id").get()?.application_id).toBe(SESSION_INDEX_APPLICATION_ID);
		expect(raw.prepare("PRAGMA user_version").get()?.user_version).toBe(SCHEMA_MINOR);
		expect(raw.prepare("SELECT value FROM index_meta WHERE key = 'schema_major'").get()?.value).toBe("1");
		raw.close();
	});

	it("uses a file from a newer minor without migrating it", () => {
		const path = join(dir, "index.sqlite");
		openIndexDatabase(DatabaseSync, path).db.close();
		const raw = new DatabaseSync(path);
		raw.exec(`PRAGMA user_version = ${SCHEMA_MINOR + 1}`);
		writeMeta(raw, "fts_definition", "newer-tokenizer");
		raw.close();

		const { db, recreated } = openIndexDatabase(DatabaseSync, path);
		expect(recreated).toBeUndefined();
		expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(SCHEMA_MINOR + 1);
		expect(db.prepare("SELECT value FROM index_meta WHERE key = 'fts_definition'").get()?.value).toBe(
			"newer-tokenizer",
		);
		db.close();
	});

	it("quarantines a file whose schema_major disagrees with its name", () => {
		const path = join(dir, "index.sqlite");
		openIndexDatabase(DatabaseSync, path).db.close();
		const raw = new DatabaseSync(path);
		writeMeta(raw, "schema_major", "2");
		raw.close();
		const { db, recreated } = openIndexDatabase(DatabaseSync, path);
		db.close();
		expect(recreated).toBe("corrupt");
	});
});

describe("projectEntry", () => {
	it("indexes displayed custom messages and labels", () => {
		const base = { id: "x", parentId: null, timestamp: "2026-10-01T00:00:00.000Z" };
		expect(
			projectEntry({ ...base, type: "custom_message", customType: "note", content: "shown note", display: true }, 0)
				?.text,
		).toBe("shown note");
		expect(
			projectEntry({ ...base, type: "custom_message", customType: "note", content: "hidden", display: false }, 0),
		).toBeNull();
		expect(projectEntry({ ...base, type: "label", targetId: "y", label: "方案定稿" }, 0)).toMatchObject({
			type: "label",
			text: "方案定稿",
		});
		expect(projectEntry({ ...base, type: "label", targetId: "y", label: undefined }, 0)).toBeNull();
	});
});
