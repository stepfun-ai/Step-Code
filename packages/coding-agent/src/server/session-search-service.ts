import { isAbsolute, resolve } from "node:path";
import type {
	SessionIndex,
	SessionIndexHitBatch,
	SessionIndexQuery,
	SessionIndexStatus,
	SessionListItem,
	SessionListQuery,
} from "../core/session-index/index.ts";
import type { SessionEntry } from "../core/session-manager.ts";

/**
 * Transport-neutral host methods over the session index. A Web or Desktop
 * host maps its own framing (HTTP, stdio frames) onto {@link SessionSearchService.call};
 * params arrive as untrusted JSON and are validated here, results are JSON-safe.
 */

export const SESSION_SEARCH_METHODS = ["search.query", "sessions.list", "index.status"] as const;
export type SessionSearchMethod = (typeof SESSION_SEARCH_METHODS)[number];

export const SEARCH_QUERY_DEFAULT_LIMIT = 20;
export const SEARCH_QUERY_MAX_LIMIT = 100;
export const SEARCH_QUERY_MAX_CHARS = 500;
export const SESSIONS_LIST_DEFAULT_LIMIT = 50;
export const SESSIONS_LIST_MAX_LIMIT = 200;

const SEARCHABLE_ENTRY_TYPES: ReadonlySet<string> = new Set<SessionEntry["type"]>([
	"message",
	"thinking_level_change",
	"model_change",
	"compaction",
	"branch_summary",
	"custom",
	"custom_message",
	"label",
	"session_info",
]);

export class SessionSearchRequestError extends Error {
	readonly code: "unknown_method" | "invalid_params";

	constructor(code: "unknown_method" | "invalid_params", message: string) {
		super(message);
		this.name = "SessionSearchRequestError";
		this.code = code;
	}
}

/** {@link SessionListItem} with epoch-ms times so it survives JSON encoding. */
export interface SessionListItemWire extends Omit<SessionListItem, "created" | "modified"> {
	created: number;
	modified: number;
}

export interface SessionListPageWire {
	sessions: SessionListItemWire[];
	nextCursor?: string;
}

export interface SessionSearchService {
	/** search.query: hit batches in arrival order, each with the coverage at that point. */
	searchQuery(params: unknown, signal?: AbortSignal): AsyncIterable<SessionIndexHitBatch>;
	/** sessions.list: newest first; pass nextCursor back for the next page. */
	listSessions(params: unknown, signal?: AbortSignal): Promise<SessionListPageWire>;
	/** index.status */
	indexStatus(): Promise<SessionIndexStatus>;
	/** Dispatch by method name. Non-streaming methods yield exactly one result. */
	call(method: string, params: unknown, signal?: AbortSignal): AsyncIterable<unknown>;
}

function invalid(message: string): SessionSearchRequestError {
	return new SessionSearchRequestError("invalid_params", message);
}

function asRecord(value: unknown): Record<string, unknown> {
	if (value === undefined || value === null) return {};
	if (typeof value !== "object" || Array.isArray(value)) throw invalid("params must be an object.");
	return value as Record<string, unknown>;
}

function optionalLimit(value: unknown, fallback: number, max: number): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
		throw invalid(`limit must be an integer between 1 and ${max}.`);
	}
	return value;
}

function optionalCwd(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !isAbsolute(value)) throw invalid("cwd must be an absolute path.");
	return resolve(value);
}

export function parseSearchQueryParams(value: unknown): SessionIndexQuery {
	const params = asRecord(value);
	const text = params.q;
	if (typeof text !== "string" || text.trim().length === 0) throw invalid("q must be a non-empty string.");
	if ([...text].length > SEARCH_QUERY_MAX_CHARS)
		throw invalid(`q must be at most ${SEARCH_QUERY_MAX_CHARS} characters.`);
	const query: SessionIndexQuery = {
		text,
		limit: optionalLimit(params.limit, SEARCH_QUERY_DEFAULT_LIMIT, SEARCH_QUERY_MAX_LIMIT),
	};
	const cwd = optionalCwd(params.cwd);
	if (cwd !== undefined) query.cwd = cwd;
	if (params.since !== undefined) {
		if (typeof params.since !== "number" || !Number.isFinite(params.since) || params.since < 0) {
			throw invalid("since must be a non-negative epoch-ms number.");
		}
		query.since = params.since;
	}
	if (params.entryTypes !== undefined) {
		const types = params.entryTypes;
		if (
			!Array.isArray(types) ||
			!types.every((type) => typeof type === "string" && SEARCHABLE_ENTRY_TYPES.has(type))
		) {
			throw invalid(`entryTypes must be an array of: ${[...SEARCHABLE_ENTRY_TYPES].join(", ")}.`);
		}
		query.entryTypes = types as SessionEntry["type"][];
	}
	return query;
}

export function parseSessionListParams(value: unknown): SessionListQuery {
	const params = asRecord(value);
	const query: SessionListQuery = {
		limit: optionalLimit(params.limit, SESSIONS_LIST_DEFAULT_LIMIT, SESSIONS_LIST_MAX_LIMIT),
	};
	const cwd = optionalCwd(params.cwd);
	if (cwd !== undefined) query.cwd = cwd;
	if (params.cursor !== undefined) {
		if (typeof params.cursor !== "string" || params.cursor.length === 0) {
			throw invalid("cursor must be a non-empty string.");
		}
		query.cursor = params.cursor;
	}
	return query;
}

function toWire(item: SessionListItem): SessionListItemWire {
	return { ...item, created: item.created.getTime(), modified: item.modified.getTime() };
}

function isSessionSearchMethod(method: string): method is SessionSearchMethod {
	return (SESSION_SEARCH_METHODS as readonly string[]).includes(method);
}

/** The service does not own the index; the host opens and closes it. */
export function createSessionSearchService(index: SessionIndex): SessionSearchService {
	const service: SessionSearchService = {
		searchQuery(params, signal) {
			// Validated eagerly so a bad request fails before the caller starts iterating.
			const query = parseSearchQueryParams(params);
			return index.search(query, signal);
		},
		async listSessions(params, signal) {
			const page = await index.listSessions(parseSessionListParams(params), signal);
			return { sessions: page.sessions.map(toWire), nextCursor: page.nextCursor };
		},
		indexStatus: () => index.status(),
		async *call(method, params, signal) {
			if (!isSessionSearchMethod(method)) {
				throw new SessionSearchRequestError("unknown_method", `Unknown method: ${method}`);
			}
			switch (method) {
				case "search.query":
					yield* service.searchQuery(params, signal);
					return;
				case "sessions.list":
					yield await service.listSessions(params, signal);
					return;
				case "index.status":
					yield await service.indexStatus();
					return;
			}
		},
	};
	return service;
}
