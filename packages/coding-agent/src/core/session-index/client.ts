import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { JsonlScanSessionIndex } from "./fallback.ts";
import { getSessionIndexPath } from "./schema.ts";
import type { SessionIndexWorkerData, WorkerMessage, WorkerRequest } from "./session-index-worker.ts";
import type {
	ReindexOptions,
	ReindexProgress,
	SessionFilePersistedEvent,
	SessionIndex,
	SessionIndexHitBatch,
	SessionIndexQuery,
	SessionIndexStatus,
	SessionListPage,
	SessionListQuery,
} from "./types.ts";

export interface SessionIndexRoot {
	path: string;
	kind: "default" | "custom";
}

export interface OpenSessionIndexOptions {
	/** Agent directory; the index lives at `<agentDir>/index/session-search.v1.db`. */
	agentDir: string;
	/** Session roots to index. Defaults to `<agentDir>/sessions`. */
	roots?: readonly SessionIndexRoot[];
	/** Override the database path, e.g. for tests. */
	dbPath?: string;
	/** Reconcile all roots in the background after opening. Defaults to true. */
	backfill?: boolean;
	/** Coalesce persisted notifications per path. Defaults to 200ms. */
	debounceMs?: number;
	/** Fall back to scanning when the worker is not ready in time. Defaults to 5s. */
	readyTimeoutMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 200;
const DEFAULT_READY_TIMEOUT_MS = 5000;
const CLOSE_TIMEOUT_MS = 2000;

function resolveWorkerEntry(): string | URL {
	// Compiled Bun binaries embed the worker under its source path (see scripts/build-binaries.sh).
	if (typeof process.versions.bun === "string") return "./src/core/session-index/session-index-worker.ts";
	return new URL(
		import.meta.url.endsWith(".ts") ? "./session-index-worker.ts" : "./session-index-worker.js",
		import.meta.url,
	);
}

type Pending = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	onProgress?: (indexed: number, total: number) => void;
};

/** Thin RPC over the worker. Rejects every pending call once the worker fails. */
class WorkerConnection {
	private readonly worker: Worker;
	private readonly pending = new Map<number, Pending>();
	private nextId = 1;
	private failure: Error | undefined;
	onFailure: ((reason: string) => void) | undefined;

	private constructor(worker: Worker) {
		this.worker = worker;
		worker.on("message", (message: WorkerMessage) => this.receive(message));
		worker.on("error", (error) => this.fail(error.message));
		worker.on("exit", () => this.fail("Session index worker exited."));
	}

	static open(data: SessionIndexWorkerData, timeoutMs: number): Promise<WorkerConnection> {
		return new Promise((resolve, reject) => {
			let worker: Worker;
			try {
				worker = new Worker(resolveWorkerEntry(), { workerData: data });
			} catch (error) {
				reject(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			const timer = setTimeout(() => {
				cleanup();
				void worker.terminate();
				reject(new Error("Session index worker did not start in time."));
			}, timeoutMs);
			const onMessage = (message: WorkerMessage): void => {
				if (message.type === "ready") {
					cleanup();
					resolve(new WorkerConnection(worker));
				} else if (message.type === "degraded") {
					cleanup();
					void worker.terminate();
					reject(new Error(message.reason));
				}
			};
			const onError = (error: Error): void => {
				cleanup();
				reject(error);
			};
			const onExit = (): void => {
				cleanup();
				reject(new Error("Session index worker exited during startup."));
			};
			const cleanup = (): void => {
				clearTimeout(timer);
				worker.off("message", onMessage);
				worker.off("error", onError);
				worker.off("exit", onExit);
			};
			worker.on("message", onMessage);
			worker.once("error", onError);
			worker.once("exit", onExit);
		});
	}

	private receive(message: WorkerMessage): void {
		if (message.type === "degraded") {
			this.fail(message.reason);
			return;
		}
		if (message.type === "ready") return;
		const pending = this.pending.get(message.id);
		if (!pending) return;
		if (message.type === "progress") {
			pending.onProgress?.(message.indexed, message.total);
			return;
		}
		this.pending.delete(message.id);
		if (message.type === "result") pending.resolve(message.result);
		else pending.reject(new Error(message.error));
	}

	private fail(reason: string): void {
		if (this.failure) return;
		this.failure = new Error(reason);
		for (const pending of this.pending.values()) pending.reject(this.failure);
		this.pending.clear();
		void this.worker.terminate();
		this.onFailure?.(reason);
	}

	get failed(): boolean {
		return this.failure !== undefined;
	}

	call(
		request: DistributiveOmit<WorkerRequest, "id">,
		onProgress?: Pending["onProgress"],
	): { id: number; result: Promise<unknown> } {
		const id = this.nextId++;
		if (this.failure) return { id, result: Promise.reject(this.failure) };
		const result = new Promise<unknown>((resolve, reject) => {
			this.pending.set(id, { resolve, reject, onProgress });
		});
		this.worker.postMessage({ ...request, id });
		return { id, result };
	}

	async close(): Promise<void> {
		if (this.failure) return;
		// Stop the exit listener from reporting the requested shutdown as a failure.
		this.failure = new Error("Session index closed.");
		const id = this.nextId++;
		const closed = new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
			this.worker.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
		this.worker.postMessage({ op: "close", id });
		await closed;
		await this.worker.terminate();
	}
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * Main-thread SessionIndex backed by the worker. Switches permanently to the
 * JSONL scan when the worker fails; callers keep the same object.
 */
class SessionIndexClient implements SessionIndex {
	private connection: WorkerConnection | undefined;
	private fallback: JsonlScanSessionIndex | undefined;
	private readonly roots: string[];
	private readonly debounceMs: number;
	private readonly timers = new Map<string, NodeJS.Timeout>();
	private closed = false;

	constructor(connection: WorkerConnection | undefined, roots: string[], debounceMs: number, reason?: string) {
		this.roots = roots;
		this.debounceMs = debounceMs;
		if (connection) {
			this.connection = connection;
			connection.onFailure = (failure) => this.degrade(failure);
		} else {
			this.fallback = new JsonlScanSessionIndex(roots, reason ?? "Session index unavailable.");
		}
	}

	private degrade(reason: string): void {
		this.connection = undefined;
		this.fallback ??= new JsonlScanSessionIndex(this.roots, reason);
	}

	private async withWorker<T>(
		run: (connection: WorkerConnection) => Promise<T>,
		fallback: (index: JsonlScanSessionIndex) => Promise<T>,
	): Promise<T> {
		const connection = this.connection;
		if (connection) {
			try {
				return await run(connection);
			} catch (error) {
				if (!connection.failed) throw error;
			}
		}
		return fallback(this.fallback ?? new JsonlScanSessionIndex(this.roots, "Session index unavailable."));
	}

	async *search(query: SessionIndexQuery, signal?: AbortSignal): AsyncIterable<SessionIndexHitBatch> {
		if (signal?.aborted) return;
		const connection = this.connection;
		if (connection) {
			try {
				const batch = (await connection.call({ op: "search", query }).result) as SessionIndexHitBatch;
				if (!signal?.aborted) yield batch;
				return;
			} catch (error) {
				if (!connection.failed) throw error;
			}
		}
		yield* (this.fallback as JsonlScanSessionIndex).search(query, signal);
	}

	listSessions(query: SessionListQuery, signal?: AbortSignal): Promise<SessionListPage> {
		return this.withWorker(
			async (connection) => (await connection.call({ op: "list", query }).result) as SessionListPage,
			(index) => index.listSessions(query, signal),
		);
	}

	status(): Promise<SessionIndexStatus> {
		return this.withWorker(
			async (connection) => (await connection.call({ op: "status" }).result) as SessionIndexStatus,
			(index) => index.status(),
		);
	}

	notifyPersisted(event: SessionFilePersistedEvent): void {
		if (this.closed || !this.connection) return;
		const previous = this.timers.get(event.path);
		if (previous) clearTimeout(previous);
		const timer = setTimeout(() => {
			this.timers.delete(event.path);
			// Sync failures are recovered by the next reconcile; the session write already succeeded.
			this.connection?.call({ op: "sync", paths: [event.path] }).result.catch(() => {});
		}, this.debounceMs);
		timer.unref?.();
		this.timers.set(event.path, timer);
	}

	async addRoot(dir: string): Promise<void> {
		if (!this.roots.includes(dir)) this.roots.push(dir);
		await this.withWorker(
			async (connection) => {
				await connection.call({ op: "addRoot", path: dir }).result;
			},
			(index) => index.addRoot(dir),
		);
	}

	async *reindex(options: ReindexOptions = {}): AsyncIterable<ReindexProgress> {
		const connection = this.connection;
		if (!connection) {
			yield* (this.fallback as JsonlScanSessionIndex).reindex();
			return;
		}
		const queue: ReindexProgress[] = [];
		let wake: (() => void) | undefined;
		const { id, result } = connection.call({ op: "reindex", full: options.full === true }, (indexed, total) => {
			queue.push({ indexed, total, done: false });
			wake?.();
		});
		const abort = (): void => {
			connection.call({ op: "cancel", target: id }).result.catch(() => {});
			wake?.();
		};
		options.signal?.addEventListener("abort", abort, { once: true });
		let finished = false;
		let failure: unknown;
		let final: SessionIndexStatus | undefined;
		result.then(
			(status) => {
				final = status as SessionIndexStatus;
				finished = true;
				wake?.();
			},
			(error: unknown) => {
				failure = error;
				finished = true;
				wake?.();
			},
		);
		try {
			while (true) {
				while (queue.length > 0) yield queue.shift() as ReindexProgress;
				if (options.signal?.aborted) return;
				if (finished) break;
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
				wake = undefined;
			}
			if (failure) throw failure;
			if (final) yield { indexed: final.indexed, total: final.total, done: true };
		} finally {
			options.signal?.removeEventListener("abort", abort);
		}
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		for (const timer of this.timers.values()) clearTimeout(timer);
		const pathsToFlush = [...this.timers.keys()];
		this.timers.clear();
		const connection = this.connection;
		this.connection = undefined;
		if (!connection) return;
		if (pathsToFlush.length > 0) {
			await connection.call({ op: "sync", paths: pathsToFlush }).result.catch(() => {
				// Unflushed paths are picked up by the next reconcile.
			});
		}
		await connection.close();
	}
}

export function defaultSessionIndexRoots(agentDir: string): SessionIndexRoot[] {
	return [{ path: join(agentDir, "sessions"), kind: "default" }];
}

/**
 * Open the session index. Never rejects for index problems: when SQLite,
 * FTS5 trigram, or the worker is unavailable the returned index scans JSONL
 * and `status()` reports `degraded` with the reason.
 */
export async function openSessionIndex(options: OpenSessionIndexOptions): Promise<SessionIndex> {
	const roots = [...(options.roots ?? defaultSessionIndexRoots(options.agentDir))];
	const data: SessionIndexWorkerData = {
		dbPath: options.dbPath ?? getSessionIndexPath(options.agentDir),
		roots,
		backfill: options.backfill ?? true,
	};
	const rootPaths = roots.map((root) => root.path);
	const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
	try {
		const connection = await WorkerConnection.open(data, options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
		return new SessionIndexClient(connection, rootPaths, debounceMs);
	} catch (error) {
		return new SessionIndexClient(
			undefined,
			rootPaths,
			debounceMs,
			error instanceof Error ? error.message : String(error),
		);
	}
}
