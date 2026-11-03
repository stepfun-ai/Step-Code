import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { isChildAgentSession } from "../child-session.ts";
import { type SessionInfo, SessionManager } from "../session-manager.ts";
import { textSnippet } from "./store.ts";
import type {
	ReindexProgress,
	SessionIndex,
	SessionIndexHitBatch,
	SessionIndexQuery,
	SessionIndexStatus,
	SessionListPage,
	SessionListQuery,
} from "./types.ts";

/**
 * Used when the index worker is unavailable (no FTS5 trigram, foreign or
 * unwritable database, worker crash). Scans JSONL on each call and returns
 * only session-level hits (entryId null); it never writes anything.
 */
export class JsonlScanSessionIndex implements SessionIndex {
	private readonly roots: string[];
	private readonly reason: string;

	constructor(roots: readonly string[], reason: string) {
		this.roots = [...roots];
		this.reason = reason;
	}

	private async loadSessions(signal?: AbortSignal): Promise<SessionInfo[]> {
		const directories = new Set<string>();
		for (const root of this.roots) {
			directories.add(root);
			try {
				for (const entry of await readdir(root, { withFileTypes: true })) {
					if (entry.isDirectory() || entry.isSymbolicLink()) directories.add(join(root, entry.name));
				}
			} catch {
				// A missing or unreadable root simply contributes no sessions to the scan.
			}
		}
		const sessions: SessionInfo[] = [];
		for (const directory of directories) {
			if (signal?.aborted) break;
			sessions.push(...(await SessionManager.listAll(directory)));
		}
		const seen = new Set<string>();
		// Child-agent sessions are skipped, as in the index's queries.
		return sessions
			.filter((session) => !isChildAgentSession(session) && !seen.has(session.path) && seen.add(session.path))
			.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	}

	async *search(query: SessionIndexQuery, signal?: AbortSignal): AsyncIterable<SessionIndexHitBatch> {
		const tokens = query.text.trim().toLowerCase().split(/\s+/u).filter(Boolean);
		if (tokens.length === 0 || query.limit <= 0) return;
		const sessions = await this.loadSessions(signal);
		if (signal?.aborted) return;
		const hits: SessionIndexHitBatch["hits"] = [];
		for (const session of sessions) {
			if (query.cwd !== undefined && session.cwd !== query.cwd) continue;
			if (query.since !== undefined && session.modified.getTime() < query.since) continue;
			const fields = [session.name ?? "", session.firstMessage, session.allMessagesText];
			const haystack = fields.join("\n").toLowerCase();
			if (!tokens.every((token) => haystack.includes(token))) continue;
			const field = fields.find((text) => tokens.some((token) => text.toLowerCase().includes(token))) ?? "";
			hits.push({
				sessionPath: session.path,
				sessionId: session.id,
				cwd: session.cwd,
				entryId: null,
				entryType: "session",
				ts: session.modified.getTime(),
				snippet: textSnippet(field, tokens),
				score: 0,
			});
			if (hits.length >= query.limit) break;
		}
		yield { hits, coverage: { indexed: sessions.length, total: sessions.length } };
	}

	async listSessions(query: SessionListQuery, signal?: AbortSignal): Promise<SessionListPage> {
		const offset = query.cursor === undefined ? 0 : Number.parseInt(query.cursor, 10);
		if (!Number.isInteger(offset) || offset < 0) throw new Error("Invalid session list cursor.");
		const sessions = (await this.loadSessions(signal)).filter(
			(session) => query.cwd === undefined || session.cwd === query.cwd,
		);
		const limit = Math.max(1, Math.floor(query.limit));
		const page = sessions.slice(offset, offset + limit).map(({ allMessagesText: _text, ...item }) => item);
		return {
			sessions: page,
			nextCursor: offset + limit < sessions.length ? String(offset + limit) : undefined,
		};
	}

	async status(): Promise<SessionIndexStatus> {
		return { state: "degraded", indexed: 0, total: 0, pending: 0, errors: 0, degradedReason: this.reason };
	}

	notifyPersisted(): void {}

	async addRoot(dir: string): Promise<void> {
		if (!this.roots.includes(dir)) this.roots.push(dir);
	}

	reindex(): AsyncIterable<ReindexProgress> {
		const reason = this.reason;
		return {
			[Symbol.asyncIterator]: () => ({
				next: () => Promise.reject(new Error(`Session index unavailable: ${reason}`)),
			}),
		};
	}

	async close(): Promise<void> {}
}
