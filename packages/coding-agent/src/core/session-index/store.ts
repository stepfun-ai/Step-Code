import { dirname } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { CHILD_SESSION_ORIGIN, isChildAgentSession } from "../child-session.ts";
import type { SessionHeader } from "../session-manager.ts";
import {
	createSessionSummary,
	foldSessionSummaryEntry,
	resolveSessionModifiedTime,
	type SessionSummaryFields,
} from "../session-summary.ts";
import {
	entryIdSchemeFor,
	headerVersion,
	isSessionHeader,
	normalizeEntry,
	PROJECTOR_VERSION,
	type ProjectedEntry,
	projectEntry,
} from "./projector.ts";
import {
	type FileFingerprint,
	hashFileRange,
	listJsonlFiles,
	listSubdirectories,
	parseJsonObjectLine,
	type RawLine,
	readLines,
	type SessionRootScan,
	scanSessionRoot,
	statDirectoryMtime,
	statSessionFile,
} from "./reader.ts";
import { writeMeta } from "./schema.ts";
import {
	type SessionIndexCoverage,
	type SessionIndexHit,
	type SessionIndexQuery,
	type SessionListItem,
	type SessionListPage,
	type SessionListQuery,
	SNIPPET_MATCH_END,
	SNIPPET_MATCH_START,
} from "./types.ts";

/**
 * Synchronous index operations over one DatabaseSync connection. Only the
 * worker owns an instance. Session files are read, never written.
 */

export const MIN_FTS_QUERY_CHARS = 3;
export const SHORT_QUERY_DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const SHORT_QUERY_MAX_SESSIONS = 200;
export const SHORT_QUERY_MAX_HITS = 50;
const SNIPPET_CONTEXT_CHARS = 48;
const FTS_SNIPPET_TOKENS = 32;
/**
 * Child-agent sessions (`origin` set) stay indexed but are never searched or
 * listed: they belong to a tool call, not to the user, and one fan-out can add
 * a dozen of them, enough to crowd real sessions out of a page or the
 * short-query window.
 */
const USER_SESSION = "s.origin IS NULL";
/** Known files re-checked before each search or list. */
export const REFRESH_RECENT_FILES = 20;

interface TrackedDirectory {
	mtimeMs: number;
	/** Roots may gain new per-cwd subdirectories; subdirectories only gain files. */
	isRoot: boolean;
}

export type SyncOutcome = "skipped" | "indexed" | "appended" | "pending" | "error" | "removed" | "conflict";

interface SourceRow {
	path: string;
	root: string;
	session_id: string | null;
	size: number;
	mtime_ms: number;
	dev_ino: string | null;
	indexed_offset: number;
	line_count: number;
	header_end: number | null;
	header_hash: string | null;
	tail_offset: number | null;
	tail_hash: string | null;
	header_version: number | null;
	id_scheme: string | null;
	projector_version: number | null;
	status: "ok" | "pending" | "error";
	error: string | null;
}

interface SessionRow {
	sid: number;
	session_id: string;
	cwd: string;
	name: string | null;
	created_at: number;
	last_activity_at: number | null;
	message_count: number;
	first_message: string | null;
}

export interface ReconcilePlan {
	/** Files that are new or changed, most recently modified first. */
	toSync: string[];
	/** Session files found on disk across all readable roots. */
	total: number;
	removed: number;
}

class SnapshotConflictError extends Error {}

function num(value: unknown): number {
	return typeof value === "bigint" ? Number(value) : (value as number);
}

function sameSnapshot(a: SourceRow | undefined, b: SourceRow | undefined): boolean {
	if (!a || !b) return a === b;
	return (
		a.indexed_offset === b.indexed_offset &&
		a.header_hash === b.header_hash &&
		a.status === b.status &&
		a.size === b.size &&
		a.mtime_ms === b.mtime_ms
	);
}

function isUnchanged(row: SourceRow, fp: FileFingerprint): boolean {
	return (
		row.status === "ok" && row.size === fp.size && row.mtime_ms === Math.trunc(fp.mtimeMs) && isCurrentProjection(row)
	);
}

/**
 * Rows projected by a newer binary count as current, so two installed
 * versions do not keep rebuilding each other's rows.
 */
function isCurrentProjection(row: SourceRow): boolean {
	return row.projector_version !== null && row.projector_version >= PROJECTOR_VERSION;
}

function escapeLike(token: string): string {
	return token.replace(/[\\%_]/gu, (char) => `\\${char}`);
}

function ftsPhrase(token: string): string {
	return `"${token.replaceAll('"', '""')}"`;
}

/** Excerpt around the first match of any token, matching LIKE's ASCII case folding. */
export function textSnippet(text: string, tokens: readonly string[]): string {
	const lower = text.replace(/[A-Z]/gu, (char) => char.toLowerCase());
	let start = -1;
	let length = 0;
	for (const token of tokens) {
		const index = lower.indexOf(token.replace(/[A-Z]/gu, (char) => char.toLowerCase()));
		if (index !== -1 && (start === -1 || index < start)) {
			start = index;
			length = token.length;
		}
	}
	if (start === -1) return text.slice(0, SNIPPET_CONTEXT_CHARS * 2);
	const from = Math.max(0, start - SNIPPET_CONTEXT_CHARS);
	const to = Math.min(text.length, start + length + SNIPPET_CONTEXT_CHARS);
	return `${from > 0 ? "…" : ""}${text.slice(from, start)}${SNIPPET_MATCH_START}${text.slice(start, start + length)}${SNIPPET_MATCH_END}${text.slice(start + length, to)}${to < text.length ? "…" : ""}`;
}

function encodeCursor(modifiedAt: number, sid: number): string {
	return Buffer.from(JSON.stringify([modifiedAt, sid])).toString("base64url");
}

function decodeCursor(cursor: string): [number, number] | null {
	try {
		const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		if (Array.isArray(value) && value.length === 2 && value.every((part) => Number.isFinite(part))) {
			return [value[0] as number, value[1] as number];
		}
	} catch {
		// Fall through: an unreadable cursor is rejected below.
	}
	return null;
}

interface ParsedLines {
	header?: SessionHeader & Record<string, unknown>;
	headerEnd?: number;
	entries: ProjectedEntry[];
	summary: SessionSummaryFields;
	/** Offset after the last consumed line. */
	consumedTo: number;
	tailOffset: number | null;
	lineCount: number;
	malformed: number;
	/** The first line is not a session header. */
	invalidHeader?: boolean;
}

export class SessionIndexStore {
	private readonly db: DatabaseSync;
	/** Directory mtimes from the last reconcile; in memory only, empty until the first reconcile. */
	private directories = new Map<string, TrackedDirectory>();

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	close(): void {
		if (this.db.isTransaction) this.db.exec("ROLLBACK");
		this.db.close();
	}

	setMeta(key: string, value: string): void {
		writeMeta(this.db, key, value);
	}

	addRoot(path: string, kind: "default" | "custom"): void {
		this.db
			.prepare(
				"INSERT INTO roots(path, kind, added_at) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET kind = CASE WHEN excluded.kind = 'default' THEN 'default' ELSE roots.kind END",
			)
			.run(path, kind, Date.now());
	}

	listRoots(): { path: string; kind: string }[] {
		return this.db
			.prepare("SELECT path, kind FROM roots ORDER BY added_at, path")
			.all()
			.map((row) => ({ path: String(row.path), kind: String(row.kind) }));
	}

	/** The root holding a file: its directory or that directory's parent. Unknown directories become custom roots. */
	private rootForFile(path: string): string {
		const directory = dirname(path);
		const parent = dirname(directory);
		for (const candidate of [directory, parent]) {
			if (this.db.prepare("SELECT 1 FROM roots WHERE path = ?").get(candidate)) return candidate;
		}
		this.addRoot(directory, "custom");
		return directory;
	}

	private getSource(path: string): SourceRow | undefined {
		const row = this.db.prepare("SELECT * FROM sources WHERE path = ?").get(path);
		return row as unknown as SourceRow | undefined;
	}

	/** Bring one file's rows up to date. Retries once when another writer changed the row meanwhile. */
	syncFile(path: string): SyncOutcome {
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				return this.syncOnce(path);
			} catch (error) {
				if (!(error instanceof SnapshotConflictError)) throw error;
			}
		}
		return "conflict";
	}

	private syncOnce(path: string): SyncOutcome {
		const row = this.getSource(path);
		const fp = statSessionFile(path);
		if (!fp) {
			if (!row) return "skipped";
			this.transaction(row, path, () => this.db.prepare("DELETE FROM sources WHERE path = ?").run(path));
			return "removed";
		}
		if (row && isUnchanged(row, fp)) return "skipped";
		// SessionManager writes empty files transiently (header rewrite); keep old rows until content returns.
		if (fp.size === 0) return this.markPending(row, path, fp, "empty file");

		if (row && this.canAppend(row, fp)) return this.append(row, path, fp);
		return this.rebuild(row, path, fp);
	}

	private canAppend(row: SourceRow, fp: FileFingerprint): boolean {
		if (row.status !== "ok" || row.id_scheme !== "entry" || !isCurrentProjection(row)) return false;
		if (fp.size < row.indexed_offset || row.header_end === null || row.header_hash === null) return false;
		if (hashFileRange(row.path, 0, row.header_end) !== row.header_hash) return false;
		if (row.tail_offset !== null && hashFileRange(row.path, row.tail_offset, row.indexed_offset) !== row.tail_hash) {
			return false;
		}
		return true;
	}

	private transaction(snapshot: SourceRow | undefined, path: string, body: () => void): void {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			if (!sameSnapshot(snapshot, this.getSource(path))) throw new SnapshotConflictError();
			body();
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	private markPending(row: SourceRow | undefined, path: string, fp: FileFingerprint, reason: string): SyncOutcome {
		this.transaction(row, path, () => {
			if (row) {
				this.db
					.prepare("UPDATE sources SET status = 'pending', error = ?, indexed_at = ? WHERE path = ?")
					.run(reason, Date.now(), path);
			} else {
				this.insertSource(path, fp, { status: "pending", error: reason });
			}
		});
		return "pending";
	}

	private insertSource(
		path: string,
		fp: FileFingerprint,
		values: Partial<Omit<SourceRow, "path" | "root" | "size" | "mtime_ms" | "dev_ino">> & {
			status: SourceRow["status"];
		},
	): void {
		this.db
			.prepare(
				`INSERT INTO sources(path, root, session_id, size, mtime_ms, dev_ino, indexed_offset, line_count,
					header_end, header_hash, tail_offset, tail_hash, header_version, id_scheme, projector_version,
					status, error, indexed_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				path,
				this.rootForFile(path),
				values.session_id ?? null,
				fp.size,
				Math.trunc(fp.mtimeMs),
				fp.devIno,
				values.indexed_offset ?? 0,
				values.line_count ?? 0,
				values.header_end ?? null,
				values.header_hash ?? null,
				values.tail_offset ?? null,
				values.tail_hash ?? null,
				values.header_version ?? null,
				values.id_scheme ?? null,
				values.projector_version ?? null,
				values.status,
				values.error ?? null,
				Date.now(),
			);
	}

	/**
	 * Parse lines into projected entries. A final unterminated line is
	 * consumed only when it is complete JSON; otherwise a writer may still be
	 * producing it and it is left for the next sync.
	 */
	private parseLines(
		lines: readonly RawLine[],
		options: {
			header?: SessionHeader;
			firstLineNo: number;
			summary: SessionSummaryFields;
			fallbackTs: number;
			startOffset: number;
		},
	): ParsedLines {
		const result: ParsedLines = {
			header: options.header as ParsedLines["header"],
			entries: [],
			summary: options.summary,
			consumedTo: options.startOffset,
			tailOffset: null,
			lineCount: 0,
			malformed: 0,
		};
		let previousId: string | null = null;
		let lineNo = options.firstLineNo - 1;
		for (const line of lines) {
			lineNo++;
			const value = parseJsonObjectLine(line.bytes);
			if (!line.terminated && value === null && line.bytes.toString("utf8").trim()) break;
			result.lineCount++;
			result.consumedTo = line.end;
			if (value === null) {
				if (line.bytes.toString("utf8").trim()) result.malformed++;
				continue;
			}
			result.tailOffset = line.start;
			if (!result.header) {
				if (!isSessionHeader(value)) {
					result.invalidHeader = true;
					return result;
				}
				result.header = value;
				result.headerEnd = line.end;
				continue;
			}
			const scheme = entryIdSchemeFor(result.header);
			const entry = normalizeEntry(value, scheme, lineNo, previousId);
			if (!entry) continue;
			previousId = entry.id;
			foldSessionSummaryEntry(result.summary, entry);
			const projected = projectEntry(entry, options.fallbackTs);
			if (projected) result.entries.push(projected);
		}
		return result;
	}

	private rebuild(row: SourceRow | undefined, path: string, fp: FileFingerprint): SyncOutcome {
		const lines = readLines(path, 0, fp.size);
		const parsed = this.parseLines(lines, {
			firstLineNo: 1,
			summary: createSessionSummary(),
			fallbackTs: Math.trunc(fp.mtimeMs),
			startOffset: 0,
		});
		if (parsed.invalidHeader) {
			this.transaction(row, path, () => {
				this.db.prepare("DELETE FROM sources WHERE path = ?").run(path);
				this.insertSource(path, fp, { status: "error", error: "first entry is not a session header" });
			});
			return "error";
		}
		const header = parsed.header;
		// No complete header yet: the file is being created or rewritten.
		if (!header || parsed.headerEnd === undefined) return this.markPending(row, path, fp, "incomplete header");

		const headerEnd = parsed.headerEnd;
		const headerHash = hashFileRange(path, 0, headerEnd);
		const createdAt = Date.parse(header.timestamp);
		const tailHash = parsed.tailOffset !== null ? hashFileRange(path, parsed.tailOffset, parsed.consumedTo) : null;
		this.transaction(row, path, () => {
			this.db.prepare("DELETE FROM sources WHERE path = ?").run(path);
			this.insertSource(path, fp, {
				status: "ok",
				error: parsed.malformed > 0 ? `skipped ${parsed.malformed} malformed line(s)` : null,
				indexed_offset: parsed.consumedTo,
				line_count: parsed.lineCount,
				header_end: headerEnd,
				header_hash: headerHash,
				tail_offset: parsed.tailOffset,
				tail_hash: tailHash,
				session_id: header.id,
				header_version: headerVersion(header),
				id_scheme: entryIdSchemeFor(header),
				projector_version: PROJECTOR_VERSION,
			});
			const sessionRow = this.db
				.prepare(
					`INSERT INTO sessions(path, session_id, cwd, name, parent_session, origin, created_at, modified_at,
						last_activity_at, message_count, first_message)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING sid`,
				)
				.get(
					path,
					header.id,
					typeof header.cwd === "string" ? header.cwd : "",
					parsed.summary.name ?? null,
					typeof header.parentSession === "string" ? header.parentSession : null,
					isChildAgentSession(header) ? CHILD_SESSION_ORIGIN : null,
					Number.isNaN(createdAt) ? Math.trunc(fp.mtimeMs) : createdAt,
					resolveSessionModifiedTime(header, parsed.summary.lastActivityTime, Math.trunc(fp.mtimeMs)),
					parsed.summary.lastActivityTime ?? null,
					parsed.summary.messageCount,
					parsed.summary.firstMessage || null,
				);
			this.insertEntries(num(sessionRow?.sid), parsed.entries);
		});
		return "indexed";
	}

	private append(row: SourceRow, path: string, fp: FileFingerprint): SyncOutcome {
		const session = this.db
			.prepare(
				"SELECT sid, session_id, cwd, name, created_at, last_activity_at, message_count, first_message FROM sessions WHERE path = ?",
			)
			.get(path) as unknown as SessionRow | undefined;
		if (!session) return this.rebuild(row, path, fp);
		const summary: SessionSummaryFields = {
			name: session.name ?? undefined,
			firstMessage: session.first_message ?? "",
			messageCount: session.message_count,
			lastActivityTime: session.last_activity_at ?? undefined,
		};
		const lines = readLines(path, row.indexed_offset, fp.size);
		const parsed = this.parseLines(lines, {
			// Only the entry id scheme appends, so the header is needed only to select it.
			header: { type: "session", id: session.session_id, timestamp: "", cwd: session.cwd, version: 3 },
			firstLineNo: row.line_count + 1,
			summary,
			fallbackTs: Math.trunc(fp.mtimeMs),
			startOffset: row.indexed_offset,
		});
		const tailOffset = parsed.tailOffset ?? row.tail_offset;
		const tailHash =
			parsed.tailOffset !== null ? hashFileRange(path, parsed.tailOffset, parsed.consumedTo) : row.tail_hash;
		const fallbackMtime = Math.trunc(fp.mtimeMs);
		const modifiedAt =
			typeof summary.lastActivityTime === "number" && summary.lastActivityTime > 0
				? summary.lastActivityTime
				: session.created_at;
		const malformedNote = parsed.malformed > 0 ? `skipped ${parsed.malformed} malformed line(s)` : row.error;
		this.transaction(row, path, () => {
			this.db
				.prepare(
					`UPDATE sources SET size = ?, mtime_ms = ?, dev_ino = ?, indexed_offset = ?, line_count = ?,
						tail_offset = ?, tail_hash = ?, projector_version = min(projector_version, ?), error = ?,
						indexed_at = ? WHERE path = ?`,
				)
				.run(
					fp.size,
					fallbackMtime,
					fp.devIno,
					parsed.consumedTo,
					row.line_count + parsed.lineCount,
					tailOffset,
					tailHash,
					// Appending with an older projector marks the file for a newer binary to re-project.
					PROJECTOR_VERSION,
					malformedNote,
					Date.now(),
					path,
				);
			this.db
				.prepare(
					`UPDATE sessions SET name = ?, modified_at = ?, last_activity_at = ?, message_count = ?, first_message = ?
					WHERE sid = ?`,
				)
				.run(
					summary.name ?? null,
					modifiedAt,
					summary.lastActivityTime ?? null,
					summary.messageCount,
					summary.firstMessage || null,
					session.sid,
				);
			this.insertEntries(session.sid, parsed.entries);
		});
		return "appended";
	}

	private insertEntries(sid: number, entries: readonly ProjectedEntry[]): void {
		if (entries.length === 0) return;
		// OR IGNORE: duplicate ids in a damaged file keep the first occurrence, as SessionManager does.
		const insert = this.db.prepare(
			"INSERT OR IGNORE INTO entries(sid, entry_id, parent_id, entry_type, role, ts, text) VALUES (?, ?, ?, ?, ?, ?, ?)",
		);
		for (const entry of entries) {
			insert.run(sid, entry.entryId, entry.parentId, entry.type, entry.role, entry.ts, entry.text);
		}
	}

	/**
	 * Compare every root with the sources table. Rows are deleted only when
	 * their root was listed successfully and the file is gone.
	 */
	planReconcile(): ReconcilePlan {
		const candidates: { path: string; mtimeMs: number }[] = [];
		let total = 0;
		let removed = 0;
		const directories = new Map<string, TrackedDirectory>();
		for (const root of this.listRoots()) {
			let scan: SessionRootScan;
			try {
				scan = scanSessionRoot(root.path);
			} catch {
				// Unreadable root (permissions, network mount): keep its rows rather than treat them as deleted.
				continue;
			}
			for (const [path, mtimeMs] of scan.directories) {
				directories.set(path, { mtimeMs, isRoot: path === root.path });
			}
			const files = scan.files;
			const known = new Map<string, SourceRow>();
			for (const row of this.db.prepare("SELECT * FROM sources WHERE root = ?").all(root.path)) {
				known.set(String(row.path), row as unknown as SourceRow);
			}
			for (const file of files) {
				const fp = statSessionFile(file);
				if (!fp) continue;
				total++;
				const row = known.get(file);
				known.delete(file);
				if (!row || !isUnchanged(row, fp)) candidates.push({ path: file, mtimeMs: fp.mtimeMs });
			}
			for (const missing of known.keys()) {
				if (statSessionFile(missing)) continue;
				this.db.prepare("DELETE FROM sources WHERE path = ?").run(missing);
				removed++;
			}
		}
		candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
		// Seeded from the listing that produced this plan, so refreshRecent only reports directories changed since.
		this.directories = directories;
		return { toSync: candidates.map((candidate) => candidate.path), total, removed };
	}

	/**
	 * Cheap pre-query freshness pass: re-sync the most recently modified known
	 * files, then pick up files created in directories whose mtime moved since
	 * the last reconcile. Deletions are left to the next reconcile. Returns
	 * false when the deadline cut the pass short.
	 */
	refreshRecent(deadline: number, sync: (path: string) => void, recentLimit = REFRESH_RECENT_FILES): boolean {
		const recent = this.db.prepare("SELECT path FROM sources ORDER BY mtime_ms DESC LIMIT ?").all(recentLimit);
		for (const row of recent) {
			if (Date.now() >= deadline) return false;
			sync(String(row.path));
		}
		// Roots missing or unreadable at the last reconcile still need watching: SessionManager creates them lazily.
		for (const root of this.listRoots()) {
			if (!this.directories.has(root.path)) this.directories.set(root.path, { mtimeMs: -1, isRoot: true });
		}
		// Live iteration: subdirectories discovered under a root below are visited later in this same pass.
		for (const [directory, tracked] of this.directories) {
			if (Date.now() >= deadline) return false;
			let complete: boolean;
			try {
				complete = this.refreshDirectory(directory, tracked, deadline, sync);
			} catch {
				// Unreadable directory (permissions, network mount): the search goes ahead and the next pass retries it.
				continue;
			}
			if (!complete) return false;
		}
		return true;
	}

	private refreshDirectory(
		directory: string,
		tracked: TrackedDirectory,
		deadline: number,
		sync: (path: string) => void,
	): boolean {
		const mtimeMs = statDirectoryMtime(directory);
		if (mtimeMs === null) {
			if (!tracked.isRoot) this.directories.delete(directory);
			return true;
		}
		if (mtimeMs === tracked.mtimeMs) return true;
		if (tracked.isRoot) {
			for (const child of listSubdirectories(directory)) {
				// -1 never equals a real mtime, so a new directory is always listed.
				if (!this.directories.has(child)) this.directories.set(child, { mtimeMs: -1, isRoot: false });
			}
		}
		for (const file of listJsonlFiles(directory) ?? []) {
			if (Date.now() >= deadline) return false;
			const row = this.getSource(file);
			const fp = row ? statSessionFile(file) : undefined;
			if (!row || (fp && !isUnchanged(row, fp))) sync(file);
		}
		// Recorded only once the directory was fully processed; a cut-short pass retries it.
		this.directories.set(directory, { mtimeMs, isRoot: tracked.isRoot });
		return true;
	}

	/** Drop every indexed session while keeping registered roots. */
	clearSources(): void {
		this.db.exec("DELETE FROM sources");
	}

	counts(): { total: number; indexed: number; pending: number; errors: number } {
		const row = this.db
			.prepare(
				`SELECT count(*) AS total,
					coalesce(sum(status = 'ok'), 0) AS indexed,
					coalesce(sum(status = 'pending'), 0) AS pending,
					coalesce(sum(status = 'error'), 0) AS errors
				FROM sources`,
			)
			.get();
		return {
			total: num(row?.total ?? 0),
			indexed: num(row?.indexed ?? 0),
			pending: num(row?.pending ?? 0),
			errors: num(row?.errors ?? 0),
		};
	}

	coverage(discoveredTotal: number): SessionIndexCoverage {
		const counts = this.counts();
		return { indexed: counts.indexed, total: Math.max(counts.total, discoveredTotal) };
	}

	search(query: SessionIndexQuery, now = Date.now()): SessionIndexHit[] {
		const tokens = query.text.trim().split(/\s+/u).filter(Boolean);
		const limit = Math.max(0, Math.floor(query.limit));
		if (tokens.length === 0 || limit === 0) return [];
		return tokens.every((token) => [...token].length >= MIN_FTS_QUERY_CHARS)
			? this.searchFts(query, tokens, limit)
			: this.searchShort(query, tokens, limit, now);
	}

	private entryTypeFilter(query: SessionIndexQuery, column: string, params: SQLInputValue[]): string {
		if (!query.entryTypes) return "";
		if (query.entryTypes.length === 0) return " AND 0";
		params.push(...query.entryTypes);
		return ` AND ${column} IN (${query.entryTypes.map(() => "?").join(", ")})`;
	}

	private searchFts(query: SessionIndexQuery, tokens: readonly string[], limit: number): SessionIndexHit[] {
		const match = tokens.map(ftsPhrase).join(" AND ");
		const hits: SessionIndexHit[] = [];

		if (!query.entryTypes) {
			const params: SQLInputValue[] = [SNIPPET_MATCH_START, SNIPPET_MATCH_END, match];
			let where = `sessions_fts MATCH ? AND ${USER_SESSION}`;
			if (query.cwd !== undefined) {
				where += " AND s.cwd = ?";
				params.push(query.cwd);
			}
			if (query.since !== undefined) {
				where += " AND s.modified_at >= ?";
				params.push(query.since);
			}
			params.push(limit);
			const rows = this.db
				.prepare(
					`SELECT s.path, s.session_id, s.cwd, s.modified_at,
						snippet(sessions_fts, -1, ?, ?, '…', ${FTS_SNIPPET_TOKENS}) AS snippet, bm25(sessions_fts) AS score
					FROM sessions_fts JOIN sessions s ON s.sid = sessions_fts.rowid
					WHERE ${where} ORDER BY score LIMIT ?`,
				)
				.all(...params);
			for (const row of rows) {
				hits.push({
					sessionPath: String(row.path),
					sessionId: String(row.session_id),
					cwd: String(row.cwd),
					entryId: null,
					entryType: "session",
					ts: num(row.modified_at),
					snippet: String(row.snippet),
					score: Number(row.score),
				});
			}
		}

		const params: SQLInputValue[] = [SNIPPET_MATCH_START, SNIPPET_MATCH_END, match];
		let where = `entries_fts MATCH ? AND ${USER_SESSION}`;
		if (query.cwd !== undefined) {
			where += " AND s.cwd = ?";
			params.push(query.cwd);
		}
		if (query.since !== undefined) {
			where += " AND e.ts >= ?";
			params.push(query.since);
		}
		where += this.entryTypeFilter(query, "e.entry_type", params);
		params.push(limit);
		const rows = this.db
			.prepare(
				`SELECT s.path, s.session_id, s.cwd, e.entry_id, e.entry_type, e.role, e.ts,
					snippet(entries_fts, 0, ?, ?, '…', ${FTS_SNIPPET_TOKENS}) AS snippet, bm25(entries_fts) AS score
				FROM entries_fts JOIN entries e ON e.eid = entries_fts.rowid JOIN sessions s ON s.sid = e.sid
				WHERE ${where} ORDER BY score LIMIT ?`,
			)
			.all(...params);
		for (const row of rows) {
			hits.push({
				sessionPath: String(row.path),
				sessionId: String(row.session_id),
				cwd: String(row.cwd),
				entryId: String(row.entry_id),
				entryType: String(row.entry_type),
				role: row.role === null ? undefined : String(row.role),
				ts: num(row.ts),
				snippet: String(row.snippet),
				score: Number(row.score),
			});
		}
		return hits.slice(0, limit);
	}

	/**
	 * Queries with a token shorter than a trigram scan `entries.text` with LIKE,
	 * bounded to recent sessions so cost stays independent of history size.
	 */
	private searchShort(
		query: SessionIndexQuery,
		tokens: readonly string[],
		requestedLimit: number,
		now: number,
	): SessionIndexHit[] {
		const limit = Math.min(requestedLimit, SHORT_QUERY_MAX_HITS);
		const since = query.since ?? (query.cwd === undefined ? now - SHORT_QUERY_DEFAULT_WINDOW_MS : undefined);
		const candidateParams: SQLInputValue[] = [];
		const candidateWhere: string[] = ["origin IS NULL"];
		if (query.cwd !== undefined) {
			candidateWhere.push("cwd = ?");
			candidateParams.push(query.cwd);
		}
		if (since !== undefined) {
			candidateWhere.push("modified_at >= ?");
			candidateParams.push(since);
		}
		const candidates = `SELECT sid FROM sessions WHERE ${candidateWhere.join(" AND ")}
			ORDER BY modified_at DESC LIMIT ${SHORT_QUERY_MAX_SESSIONS}`;
		const patterns = tokens.map((token) => `%${escapeLike(token)}%`);
		const hits: SessionIndexHit[] = [];

		if (!query.entryTypes) {
			const titleMatch = patterns
				.map(() => "(coalesce(s.name, '') LIKE ? ESCAPE '\\' OR coalesce(s.first_message, '') LIKE ? ESCAPE '\\')")
				.join(" AND ");
			const rows = this.db
				.prepare(
					`SELECT s.path, s.session_id, s.cwd, s.name, s.first_message, s.modified_at
					FROM sessions s WHERE s.sid IN (${candidates}) AND ${titleMatch}
					ORDER BY s.modified_at DESC LIMIT ?`,
				)
				.all(...candidateParams, ...patterns.flatMap((pattern) => [pattern, pattern]), limit);
			for (const row of rows) {
				const title = row.name === null ? "" : String(row.name);
				const text = tokens.some((token) => title.toLowerCase().includes(token.toLowerCase()))
					? title
					: String(row.first_message ?? "");
				hits.push({
					sessionPath: String(row.path),
					sessionId: String(row.session_id),
					cwd: String(row.cwd),
					entryId: null,
					entryType: "session",
					ts: num(row.modified_at),
					snippet: textSnippet(text, tokens),
					score: 0,
				});
			}
		}

		const params: SQLInputValue[] = [...candidateParams, ...patterns];
		let where = `e.sid IN (${candidates}) AND ${patterns.map(() => "e.text LIKE ? ESCAPE '\\'").join(" AND ")}`;
		if (since !== undefined) {
			where += " AND e.ts >= ?";
			params.push(since);
		}
		where += this.entryTypeFilter(query, "e.entry_type", params);
		params.push(limit);
		const rows = this.db
			.prepare(
				`SELECT s.path, s.session_id, s.cwd, e.entry_id, e.entry_type, e.role, e.ts, e.text
				FROM entries e JOIN sessions s ON s.sid = e.sid
				WHERE ${where} ORDER BY e.ts DESC LIMIT ?`,
			)
			.all(...params);
		for (const row of rows) {
			hits.push({
				sessionPath: String(row.path),
				sessionId: String(row.session_id),
				cwd: String(row.cwd),
				entryId: String(row.entry_id),
				entryType: String(row.entry_type),
				role: row.role === null ? undefined : String(row.role),
				ts: num(row.ts),
				snippet: textSnippet(String(row.text), tokens),
				score: 0,
			});
		}
		return hits.slice(0, limit);
	}

	listSessions(query: SessionListQuery): SessionListPage {
		const limit = Math.max(1, Math.floor(query.limit));
		const params: SQLInputValue[] = [];
		const where: string[] = ["origin IS NULL"];
		if (query.cwd !== undefined) {
			where.push("cwd = ?");
			params.push(query.cwd);
		}
		if (query.cursor !== undefined) {
			const cursor = decodeCursor(query.cursor);
			if (!cursor) throw new Error("Invalid session list cursor.");
			where.push("(modified_at < ? OR (modified_at = ? AND sid < ?))");
			params.push(cursor[0], cursor[0], cursor[1]);
		}
		params.push(limit + 1);
		const rows = this.db
			.prepare(
				`SELECT sid, path, session_id, cwd, name, parent_session, created_at, modified_at, message_count, first_message
				FROM sessions WHERE ${where.join(" AND ")}
				ORDER BY modified_at DESC, sid DESC LIMIT ?`,
			)
			.all(...params);
		const page = rows.slice(0, limit);
		const sessions: SessionListItem[] = page.map((row) => ({
			path: String(row.path),
			id: String(row.session_id),
			cwd: String(row.cwd),
			name: row.name === null ? undefined : String(row.name),
			parentSessionPath: row.parent_session === null ? undefined : String(row.parent_session),
			created: new Date(num(row.created_at)),
			modified: new Date(num(row.modified_at)),
			messageCount: num(row.message_count),
			firstMessage: row.first_message === null ? "(no messages)" : String(row.first_message),
		}));
		const last = page.at(-1);
		return {
			sessions,
			nextCursor: rows.length > limit && last ? encodeCursor(num(last.modified_at), num(last.sid)) : undefined,
		};
	}
}
