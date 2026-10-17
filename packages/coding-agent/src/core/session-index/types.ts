import type { SessionEntry, SessionFilePersistedEvent } from "../session-manager.ts";

export type { SessionFilePersistedEvent };

/** Marks the start and end of a matched span inside {@link SessionIndexHit.snippet}. */
export const SNIPPET_MATCH_START = "\u0002";
export const SNIPPET_MATCH_END = "\u0003";

export interface SessionIndexQuery {
	text: string;
	/** Only sessions whose header cwd equals this resolved path. */
	cwd?: string;
	/** Only entries (and, for short queries, sessions) at or after this epoch-ms time. */
	since?: number;
	limit: number;
	/** Product v3 entry types to search. Title hits are included only when omitted. */
	entryTypes?: readonly SessionEntry["type"][];
}

export interface SessionIndexHit {
	sessionPath: string;
	sessionId: string;
	cwd: string;
	/** Null for session-level hits: title matches and every JSONL-scan fallback hit. */
	entryId: string | null;
	entryType?: string;
	role?: string;
	ts: number;
	/** Excerpt with matches wrapped in SNIPPET_MATCH_START / SNIPPET_MATCH_END. */
	snippet: string;
	/** Lower is better (bm25); 0 when results are ordered by time. */
	score: number;
}

export interface SessionIndexCoverage {
	indexed: number;
	total: number;
}

export interface SessionIndexHitBatch {
	hits: SessionIndexHit[];
	coverage: SessionIndexCoverage;
}

export interface SessionListItem {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	parentSessionPath?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
}

export interface SessionListQuery {
	cwd?: string;
	limit: number;
	cursor?: string;
}

export interface SessionListPage {
	sessions: SessionListItem[];
	nextCursor?: string;
}

export interface SessionIndexStatus {
	state: "ready" | "backfilling" | "degraded";
	indexed: number;
	total: number;
	pending: number;
	errors: number;
	degradedReason?: string;
	dbPath?: string;
}

export interface ReindexProgress {
	indexed: number;
	total: number;
	done: boolean;
}

export interface ReindexOptions {
	/** Drop every indexed session and rebuild from the JSONL files. */
	full?: boolean;
	signal?: AbortSignal;
}

/** Search and list sessions through a derived index. JSONL files stay authoritative. */
export interface SessionIndex {
	search(query: SessionIndexQuery, signal?: AbortSignal): AsyncIterable<SessionIndexHitBatch>;
	listSessions(query: SessionListQuery, signal?: AbortSignal): Promise<SessionListPage>;
	status(): Promise<SessionIndexStatus>;
	/** Schedule a sync for a written session file. Debounced per path. */
	notifyPersisted(event: SessionFilePersistedEvent): void;
	/** Register a session directory, e.g. one passed with --session-dir. */
	addRoot(dir: string): Promise<void>;
	reindex(options?: ReindexOptions): AsyncIterable<ReindexProgress>;
	/** Wait for the in-flight batch, roll back open transactions, and stop the worker. */
	close(): Promise<void>;
}
