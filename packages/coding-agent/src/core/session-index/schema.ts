import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CHILD_SESSION_ORIGIN, SUBAGENT_SESSION_ID_PREFIX, WORKFLOW_SESSION_ID_PREFIX } from "../child-session.ts";
import { PROJECTOR_VERSION } from "./projector.ts";

/**
 * Index database schema, validation, and creation. The database is derived
 * from the session JSONL files: any version or integrity problem is resolved
 * by rebuilding it, never by touching the session files.
 */

/** "STCX" — distinguishes our index from an unrelated SQLite file at the same path. */
export const SESSION_INDEX_APPLICATION_ID = 0x53544358;
/**
 * Incompatible layouts get a new file name, so binaries of different majors
 * never open or delete each other's index.
 */
export const SCHEMA_MAJOR = 1;
/**
 * Additive migration number within a major, stored in `user_version`. Older
 * files are migrated in place; newer files are used through known columns only.
 */
export const SCHEMA_MINOR = 2;
/** Changing the tokenizer or FTS columns rebuilds only the FTS tables from `entries`. */
export const FTS_DEFINITION = "trigram:v1";
export const SESSION_INDEX_FILE_NAME = `session-search.v${SCHEMA_MAJOR}.db`;
const MAX_CORRUPT_BACKUPS = 1;

type DatabaseSyncConstructor = typeof DatabaseSync;

export class ForeignDatabaseError extends Error {
	constructor(path: string) {
		super(`${path} is not a Step session index; refusing to modify it.`);
		this.name = "ForeignDatabaseError";
	}
}

export class FtsUnavailableError extends Error {
	constructor(cause: unknown) {
		super(`SQLite FTS5 trigram tokenizer is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
		this.name = "FtsUnavailableError";
	}
}

export function getSessionIndexPath(agentDir: string): string {
	return join(agentDir, "index", SESSION_INDEX_FILE_NAME);
}

const BASE_TABLES = ["index_meta", "roots", "sources", "sessions", "entries", "entries_fts", "sessions_fts"];

const CORE_DDL = `
CREATE TABLE index_meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
) STRICT;
CREATE TABLE roots (
	path TEXT PRIMARY KEY,
	kind TEXT NOT NULL CHECK (kind IN ('default', 'custom')),
	added_at INTEGER NOT NULL
) STRICT;
CREATE TABLE sources (
	path TEXT PRIMARY KEY,
	root TEXT NOT NULL REFERENCES roots(path) ON DELETE CASCADE,
	session_id TEXT,
	size INTEGER NOT NULL,
	mtime_ms INTEGER NOT NULL,
	dev_ino TEXT,
	indexed_offset INTEGER NOT NULL DEFAULT 0,
	line_count INTEGER NOT NULL DEFAULT 0,
	header_end INTEGER,
	header_hash TEXT,
	tail_offset INTEGER,
	tail_hash TEXT,
	header_version INTEGER,
	id_scheme TEXT,
	projector_version INTEGER,
	status TEXT NOT NULL CHECK (status IN ('ok', 'pending', 'error')),
	error TEXT,
	indexed_at INTEGER NOT NULL
) STRICT;
CREATE TABLE sessions (
	sid INTEGER PRIMARY KEY,
	path TEXT NOT NULL UNIQUE REFERENCES sources(path) ON DELETE CASCADE,
	session_id TEXT NOT NULL,
	cwd TEXT NOT NULL,
	parent_session TEXT,
	origin TEXT,
	name TEXT,
	first_message TEXT,
	created_at INTEGER NOT NULL,
	modified_at INTEGER NOT NULL,
	last_activity_at INTEGER,
	message_count INTEGER NOT NULL
) STRICT;
CREATE INDEX sessions_cwd_modified ON sessions(cwd, modified_at DESC);
CREATE INDEX sessions_modified ON sessions(modified_at DESC);
CREATE INDEX sessions_session_id ON sessions(session_id);
CREATE TABLE entries (
	eid INTEGER PRIMARY KEY,
	sid INTEGER NOT NULL REFERENCES sessions(sid) ON DELETE CASCADE,
	entry_id TEXT NOT NULL,
	parent_id TEXT,
	entry_type TEXT NOT NULL,
	role TEXT,
	ts INTEGER NOT NULL,
	text TEXT NOT NULL,
	UNIQUE (sid, entry_id)
) STRICT;
CREATE INDEX entries_sid_ts ON entries(sid, ts);
`;

const FTS_DDL = `
CREATE VIRTUAL TABLE entries_fts USING fts5(text, content='entries', content_rowid='eid', tokenize='trigram');
CREATE VIRTUAL TABLE sessions_fts USING fts5(name, first_message, content='sessions', content_rowid='sid', tokenize='trigram');
CREATE TRIGGER entries_ai AFTER INSERT ON entries BEGIN
	INSERT INTO entries_fts(rowid, text) VALUES (new.eid, new.text);
END;
CREATE TRIGGER entries_ad AFTER DELETE ON entries BEGIN
	INSERT INTO entries_fts(entries_fts, rowid, text) VALUES ('delete', old.eid, old.text);
END;
CREATE TRIGGER entries_au AFTER UPDATE OF text ON entries BEGIN
	INSERT INTO entries_fts(entries_fts, rowid, text) VALUES ('delete', old.eid, old.text);
	INSERT INTO entries_fts(rowid, text) VALUES (new.eid, new.text);
END;
CREATE TRIGGER sessions_ai AFTER INSERT ON sessions BEGIN
	INSERT INTO sessions_fts(rowid, name, first_message) VALUES (new.sid, coalesce(new.name, ''), coalesce(new.first_message, ''));
END;
CREATE TRIGGER sessions_ad AFTER DELETE ON sessions BEGIN
	INSERT INTO sessions_fts(sessions_fts, rowid, name, first_message)
	VALUES ('delete', old.sid, coalesce(old.name, ''), coalesce(old.first_message, ''));
END;
CREATE TRIGGER sessions_au AFTER UPDATE OF name, first_message ON sessions BEGIN
	INSERT INTO sessions_fts(sessions_fts, rowid, name, first_message)
	VALUES ('delete', old.sid, coalesce(old.name, ''), coalesce(old.first_message, ''));
	INSERT INTO sessions_fts(rowid, name, first_message) VALUES (new.sid, coalesce(new.name, ''), coalesce(new.first_message, ''));
END;
`;

const DROP_FTS = `
DROP TRIGGER IF EXISTS entries_ai;
DROP TRIGGER IF EXISTS entries_ad;
DROP TRIGGER IF EXISTS entries_au;
DROP TRIGGER IF EXISTS sessions_ai;
DROP TRIGGER IF EXISTS sessions_ad;
DROP TRIGGER IF EXISTS sessions_au;
DROP TABLE IF EXISTS entries_fts;
DROP TABLE IF EXISTS sessions_fts;
`;

type ExistingState =
	| { kind: "missing" }
	| { kind: "empty" }
	| { kind: "ours"; userVersion: number }
	| { kind: "foreign" }
	| { kind: "corrupt"; error: unknown };

/** Inspect an existing file without writing to it. */
function inspectExisting(Database: DatabaseSyncConstructor, path: string): ExistingState {
	if (!existsSync(path)) return { kind: "missing" };
	let db: DatabaseSync | undefined;
	try {
		db = new Database(path, { readOnly: true });
		const applicationId = Number(db.prepare("PRAGMA application_id").get()?.application_id ?? 0);
		const userVersion = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
		const tableCount = Number(
			db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table'").get()?.n ?? 0,
		);
		if (applicationId === SESSION_INDEX_APPLICATION_ID) {
			const tables = new Set(
				db
					.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
					.all()
					.map((row) => String(row.name)),
			);
			// A half-created file from an interrupted first run carries no tables yet.
			if (!BASE_TABLES.every((name) => tables.has(name))) return { kind: "corrupt", error: "missing tables" };
			const major = db.prepare("SELECT value FROM index_meta WHERE key = 'schema_major'").get()?.value;
			// The major is part of the file name; a mismatch means the file was copied or damaged.
			if (major !== String(SCHEMA_MAJOR)) return { kind: "corrupt", error: `schema_major ${String(major)}` };
			return { kind: "ours", userVersion };
		}
		if (applicationId === 0 && tableCount === 0) return { kind: "empty" };
		return { kind: "foreign" };
	} catch (error) {
		return { kind: "corrupt", error };
	} finally {
		db?.close();
	}
}

function removeDatabaseFiles(path: string): void {
	for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${path}${suffix}`, { force: true });
}

/** Move a damaged index aside for diagnosis and keep only the newest backups. */
function quarantine(path: string): void {
	const backup = `${path}.corrupt-${Date.now()}`;
	try {
		renameSync(path, backup);
	} catch {
		// Renaming can fail on locked files (Windows); the index is derived, so delete instead.
	}
	removeDatabaseFiles(path);
	const prefix = `${basename(path)}.corrupt-`;
	const backups = readdirSync(dirname(path))
		.filter((name) => name.startsWith(prefix))
		.sort()
		.reverse();
	for (const stale of backups.slice(MAX_CORRUPT_BACKUPS)) rmSync(join(dirname(path), stale), { force: true });
}

function probeTrigram(db: DatabaseSync): void {
	try {
		db.exec("CREATE VIRTUAL TABLE temp.session_index_probe USING fts5(x, tokenize='trigram')");
		db.exec("DROP TABLE temp.session_index_probe");
	} catch (error) {
		throw new FtsUnavailableError(error);
	}
}

function readMeta(db: DatabaseSync, key: string): string | undefined {
	const row = db.prepare("SELECT value FROM index_meta WHERE key = ?").get(key);
	return row ? String(row.value) : undefined;
}

export function writeMeta(db: DatabaseSync, key: string, value: string): void {
	db.prepare(
		"INSERT INTO index_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
	).run(key, value);
}

export function getMeta(db: DatabaseSync, key: string): string | undefined {
	return readMeta(db, key);
}

function createSchema(db: DatabaseSync): void {
	db.exec("BEGIN IMMEDIATE");
	try {
		db.exec(CORE_DDL);
		db.exec(FTS_DDL);
		writeMeta(db, "schema_major", String(SCHEMA_MAJOR));
		writeMeta(db, "fts_definition", FTS_DEFINITION);
		writeMeta(db, "projector_version", String(PROJECTOR_VERSION));
		writeMeta(db, "backfill_state", "running");
		// Stamp ownership last so an interrupted creation is recognised as ours only once complete.
		db.exec(`PRAGMA application_id = ${SESSION_INDEX_APPLICATION_ID}`);
		db.exec(`PRAGMA user_version = ${SCHEMA_MINOR}`);
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

/**
 * Bring an existing file to this build's minor and FTS definition. A file
 * written by a newer binary is left as is: its additive changes are
 * invisible to the known columns used here, and its FTS definition wins.
 */
function upgradeSchema(db: DatabaseSync, userVersion: number): void {
	if (userVersion > SCHEMA_MINOR) return;
	const ftsDefinition = readMeta(db, "fts_definition");
	if (userVersion === SCHEMA_MINOR && ftsDefinition === FTS_DEFINITION) return;
	db.exec("BEGIN IMMEDIATE");
	try {
		// Minor migrations go here in order, each guarded by `userVersion < N`.
		if (userVersion < 2) {
			// Rows written before the column existed predate the header marker, so the id prefix is all they carry.
			db.exec("ALTER TABLE sessions ADD COLUMN origin TEXT");
			db.prepare(
				"UPDATE sessions SET origin = ? WHERE substr(session_id, 1, ?) = ? OR substr(session_id, 1, ?) = ?",
			).run(
				CHILD_SESSION_ORIGIN,
				SUBAGENT_SESSION_ID_PREFIX.length,
				SUBAGENT_SESSION_ID_PREFIX,
				WORKFLOW_SESSION_ID_PREFIX.length,
				WORKFLOW_SESSION_ID_PREFIX,
			);
		}
		if (ftsDefinition !== FTS_DEFINITION) {
			// Rebuild from `entries` without rereading JSONL.
			db.exec(DROP_FTS);
			db.exec(FTS_DDL);
			db.exec("INSERT INTO entries_fts(entries_fts) VALUES ('rebuild')");
			db.exec("INSERT INTO sessions_fts(sessions_fts) VALUES ('rebuild')");
			writeMeta(db, "fts_definition", FTS_DEFINITION);
		}
		if (userVersion < SCHEMA_MINOR) db.exec(`PRAGMA user_version = ${SCHEMA_MINOR}`);
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

export interface OpenedIndexDatabase {
	db: DatabaseSync;
	/** Set when a damaged file was moved aside and replaced. */
	recreated?: "corrupt";
}

/**
 * Open or create the index. Throws ForeignDatabaseError for a file we do not
 * own and FtsUnavailableError when the SQLite build lacks trigram FTS5.
 */
export function openIndexDatabase(Database: DatabaseSyncConstructor, path: string): OpenedIndexDatabase {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const existing = inspectExisting(Database, path);
	let recreated: OpenedIndexDatabase["recreated"];
	if (existing.kind === "foreign") throw new ForeignDatabaseError(path);
	if (existing.kind === "corrupt") {
		quarantine(path);
		recreated = "corrupt";
	}

	const db = new Database(path, { enableForeignKeyConstraints: true, timeout: 5000 });
	try {
		try {
			chmodSync(path, 0o600);
		} catch {
			// Permissions are best effort (e.g. Windows); the index holds only copies of session text.
		}
		db.exec("PRAGMA foreign_keys = ON");
		db.exec("PRAGMA journal_mode = WAL");
		db.exec("PRAGMA synchronous = NORMAL");
		probeTrigram(db);
		if (existing.kind === "ours") {
			upgradeSchema(db, existing.userVersion);
		} else {
			createSchema(db);
		}
		if (Number(readMeta(db, "projector_version") ?? 0) < PROJECTOR_VERSION) {
			// Sources with an older projector_version are re-projected by the next reconcile.
			writeMeta(db, "projector_version", String(PROJECTOR_VERSION));
		}
		return { db, recreated };
	} catch (error) {
		db.close();
		throw error;
	}
}

export function deleteIndexDatabase(path: string): void {
	removeDatabaseFiles(path);
}
