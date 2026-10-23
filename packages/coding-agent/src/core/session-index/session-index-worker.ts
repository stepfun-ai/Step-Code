import { parentPort, workerData } from "node:worker_threads";
import { openIndexDatabase } from "./schema.ts";
import { SessionIndexStore } from "./store.ts";
import type { SessionIndexQuery, SessionIndexStatus, SessionListQuery } from "./types.ts";

/**
 * Index worker: the only owner of the SQLite connection. Requests are served
 * between file syncs, so a long backfill never blocks a search for more than
 * one file.
 */

export interface SessionIndexWorkerData {
	dbPath: string;
	roots: { path: string; kind: "default" | "custom" }[];
	/** Reconcile every root in the background after opening. */
	backfill: boolean;
}

export type WorkerRequest =
	| { id: number; op: "sync"; paths: string[] }
	| { id: number; op: "search"; query: SessionIndexQuery }
	| { id: number; op: "list"; query: SessionListQuery }
	| { id: number; op: "status" }
	| { id: number; op: "reindex"; full: boolean }
	| { id: number; op: "addRoot"; path: string }
	| { id: number; op: "cancel"; target: number }
	| { id: number; op: "close" };

export type WorkerMessage =
	| { type: "ready" }
	| { type: "degraded"; reason: string }
	| { type: "result"; id: number; result: unknown }
	| { type: "error"; id: number; error: string }
	| { type: "progress"; id: number; indexed: number; total: number };

const YIELD_EVERY_MS = 20;
const REFRESH_BUDGET_MS = 30;

const yieldToEvents = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Corruption makes every later statement unreliable; the client falls back to scanning. */
function isFatalDatabaseError(error: unknown): boolean {
	const message = errorMessage(error);
	return /malformed|not a database|SQLITE_CORRUPT|SQLITE_NOTADB|disk I\/O error/iu.test(message);
}

async function main(port: NonNullable<typeof parentPort>, data: SessionIndexWorkerData): Promise<void> {
	const post = (message: WorkerMessage): void => port.postMessage(message);

	// node:sqlite still warns as experimental on Node 22; keep that off the host's stderr.
	const emitWarning = process.emitWarning.bind(process);
	process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
		const text = typeof warning === "string" ? warning : warning.message;
		if (/SQLite/iu.test(text)) return;
		(emitWarning as (...args: unknown[]) => void)(warning, ...rest);
	}) as typeof process.emitWarning;

	let store: SessionIndexStore;
	try {
		// Imported after the warning filter is installed; a static import would load first.
		const { DatabaseSync } = await import("node:sqlite");
		store = new SessionIndexStore(openIndexDatabase(DatabaseSync, data.dbPath).db);
		for (const root of data.roots) store.addRoot(root.path, root.kind);
	} catch (error) {
		post({ type: "degraded", reason: errorMessage(error) });
		return;
	}

	let closed = false;
	let discoveredTotal = 0;
	let reconcile: Promise<void> | undefined;
	const pendingSyncs = new Set<string>();
	let draining: Promise<void> | undefined;
	const cancelled = new Set<number>();

	const fail = (error: unknown): void => {
		if (closed) return;
		closed = true;
		try {
			store.close();
		} catch {
			// The connection is already unusable; the client is told to degrade below.
		}
		post({ type: "degraded", reason: errorMessage(error) });
	};

	const syncOne = (path: string): void => {
		try {
			store.syncFile(path);
		} catch (error) {
			if (isFatalDatabaseError(error)) throw error;
			// A single unreadable file stays stale; the next reconcile retries it.
		}
	};

	const runReconcile = async (full: boolean, onProgress?: (indexed: number, total: number) => void) => {
		// Persisted so an interrupted backfill is visible after a restart; reconcile resumes from `sources`.
		store.setMeta("backfill_state", "running");
		if (full) store.clearSources();
		const plan = store.planReconcile();
		discoveredTotal = plan.total;
		let done = plan.total - plan.toSync.length;
		let lastYield = Date.now();
		onProgress?.(done, plan.total);
		for (const path of plan.toSync) {
			if (closed) return;
			syncOne(path);
			done++;
			if (Date.now() - lastYield >= YIELD_EVERY_MS) {
				onProgress?.(done, plan.total);
				await yieldToEvents();
				lastYield = Date.now();
			}
		}
		if (closed) return;
		store.setMeta("backfill_state", "done");
		store.setMeta("last_reconcile_at", String(Date.now()));
		onProgress?.(done, plan.total);
	};

	/** Serialise reconciles; a request made during one runs after it. */
	const scheduleReconcile = (full: boolean, onProgress?: (indexed: number, total: number) => void) => {
		const previous = reconcile ?? Promise.resolve();
		const next = previous.then(() => (closed ? undefined : runReconcile(full, onProgress)));
		reconcile = next.finally(() => {
			if (reconcile === tracked) reconcile = undefined;
		});
		const tracked = reconcile;
		return next;
	};

	const drainSyncs = (): Promise<void> => {
		draining ??= (async () => {
			while (pendingSyncs.size > 0 && !closed) {
				const [path] = pendingSyncs;
				pendingSyncs.delete(path);
				syncOne(path);
				await yieldToEvents();
			}
		})().finally(() => {
			draining = undefined;
		});
		return draining;
	};

	/**
	 * Writers in other processes do not notify this worker. Check the newest
	 * files and changed directories within a small budget before answering;
	 * when the budget runs out, a background reconcile finishes the job.
	 */
	const refreshBeforeQuery = (): void => {
		const complete = store.refreshRecent(Date.now() + REFRESH_BUDGET_MS, syncOne);
		if (!complete && !reconcile) void scheduleReconcile(false).catch(fail);
	};

	const status = (): SessionIndexStatus => {
		const counts = store.counts();
		return {
			state: reconcile ? "backfilling" : "ready",
			indexed: counts.indexed,
			total: Math.max(counts.total, discoveredTotal),
			pending: counts.pending,
			errors: counts.errors,
			dbPath: data.dbPath,
		};
	};

	const handle = async (request: WorkerRequest): Promise<unknown> => {
		switch (request.op) {
			case "sync":
				for (const path of request.paths) pendingSyncs.add(path);
				await drainSyncs();
				return undefined;
			case "search":
				refreshBeforeQuery();
				return { hits: store.search(request.query), coverage: store.coverage(discoveredTotal) };
			case "list":
				refreshBeforeQuery();
				return store.listSessions(request.query);
			case "status":
				return status();
			case "addRoot":
				store.addRoot(request.path, "custom");
				void scheduleReconcile(false).catch(fail);
				return undefined;
			case "reindex":
				await scheduleReconcile(request.full, (indexed, total) => {
					if (!cancelled.has(request.id)) post({ type: "progress", id: request.id, indexed, total });
				});
				return status();
			case "cancel":
				cancelled.add(request.target);
				return undefined;
			case "close": {
				closed = true;
				await Promise.allSettled([reconcile, draining]);
				store.close();
				return undefined;
			}
		}
	};

	port.on("message", (request: WorkerRequest) => {
		if (closed && request.op !== "close") {
			post({ type: "error", id: request.id, error: "Session index is closed." });
			return;
		}
		void handle(request).then(
			(result) => {
				cancelled.delete(request.id);
				post({ type: "result", id: request.id, result });
				if (request.op === "close") port.close();
			},
			(error: unknown) => {
				cancelled.delete(request.id);
				if (isFatalDatabaseError(error)) fail(error);
				post({ type: "error", id: request.id, error: errorMessage(error) });
			},
		);
	});

	post({ type: "ready" });
	if (data.backfill) void scheduleReconcile(false).catch(fail);
}

if (parentPort) void main(parentPort, workerData as SessionIndexWorkerData);
