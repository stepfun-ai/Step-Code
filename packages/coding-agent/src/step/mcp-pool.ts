import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Process-wide MCP connection pool.
 *
 * Every Step session in one process (the TUI after `/new` or `/resume`, each
 * Web/Desktop chat) discovers the same configured servers. Connecting per
 * session spawned one stdio child per server per open chat; the pool keeps one
 * connection per server identity and hands sessions leases on it instead.
 *
 * Ownership:
 * - The pool owns each connection, its catalog refreshes and its close.
 * - A session owns only its lease: it publishes the shared catalog into its own
 *   tool registry and releases the lease on `session_shutdown`.
 * - A connection whose last lease is released closes immediately for a quit
 *   (the process or session is going away) or after an idle grace for a session
 *   replacement, so the next session in the same process reuses it.
 *
 * A failed or closed connection leaves the pool at once, so the next session
 * that needs the server connects again rather than inheriting the failure.
 * Separate processes (subagent RPC children, a second `step`) keep separate pools.
 */

/** The part of a connection the pool needs to manage it. */
export interface StepMcpPoolConnection {
	/** Aborts when the connection closes, for any reason. */
	readonly signal: AbortSignal;
	/** The current, already filtered catalog. The pool replaces it on refresh. */
	tools: McpTool[];
}

export interface StepMcpPoolAdapter<TItem, TConnection extends StepMcpPoolConnection> {
	/** Identity of a server; equal keys share one connection. */
	key(item: TItem): string;
	/** Connect and list the initial catalog; `signal` is the pool-owned lifetime. */
	connect(item: TItem, signal: AbortSignal, onToolsChanged: () => void): Promise<TConnection>;
	/** List the filtered catalog again after a `tools/list_changed` notification. */
	listTools(connection: TConnection, item: TItem): Promise<McpTool[]>;
	close(connection: TConnection): Promise<void>;
}

/** Callbacks one lease receives about its shared connection. */
export interface StepMcpLeaseListener {
	/** The catalog changed; `previous` is what the lease last saw. */
	onToolsChanged?(tools: readonly McpTool[], previous: readonly McpTool[]): void;
	/** A catalog refresh failed; the previous tools stay published. */
	onRefreshFailed?(error: unknown): void;
	/** The connection closed while this lease held it. */
	onClosed?(): void;
}

export interface StepMcpLease<TConnection> {
	/** Settles with the shared connection, or its startup failure. Aborting `signal` only stops this wait. */
	ready(signal?: AbortSignal): Promise<TConnection>;
	/**
	 * Drop this lease. `immediate` closes a connection no other lease holds now;
	 * otherwise it idles for the pool's grace period first. Settles once a
	 * close it caused has finished. Releasing twice is a no-op.
	 */
	release(options?: { immediate?: boolean }): Promise<void>;
}

/** How long a connection with no leases stays open for the next session. */
export const DEFAULT_STEP_MCP_IDLE_MS = 30_000;

interface PoolEntry<TItem, TConnection extends StepMcpPoolConnection> {
	readonly key: string;
	readonly item: TItem;
	readonly controller: AbortController;
	readonly ready: Promise<TConnection>;
	readonly listeners: Set<StepMcpLeaseListener>;
	connection?: TConnection;
	idleTimer?: NodeJS.Timeout;
	closing?: Promise<void>;
	/** Close of a connection that finished its handshake after the entry was released. */
	abandoned?: Promise<void>;
	refreshPending: boolean;
	refreshing: boolean;
}

export class StepMcpPool<TItem, TConnection extends StepMcpPoolConnection> {
	private readonly adapter: StepMcpPoolAdapter<TItem, TConnection>;
	private readonly entries = new Map<string, PoolEntry<TItem, TConnection>>();
	private idleMs: number;

	constructor(adapter: StepMcpPoolAdapter<TItem, TConnection>, options: { idleMs?: number } = {}) {
		this.adapter = adapter;
		this.idleMs = options.idleMs ?? DEFAULT_STEP_MCP_IDLE_MS;
	}

	/** Change the idle grace; applies to connections that become idle afterwards. */
	setIdleMs(ms: number): void {
		this.idleMs = Math.max(0, ms);
	}

	/** Number of live (connecting or connected) pooled connections. */
	get size(): number {
		return this.entries.size;
	}

	/** Keys of live pooled connections with their lease counts, for diagnostics and tests. */
	snapshot(): Array<{ key: string; leases: number; connected: boolean }> {
		return [...this.entries.values()].map((entry) => ({
			key: entry.key,
			leases: entry.listeners.size,
			connected: entry.connection !== undefined,
		}));
	}

	acquire(item: TItem, listener: StepMcpLeaseListener = {}): StepMcpLease<TConnection> {
		const key = this.adapter.key(item);
		let entry = this.entries.get(key);
		if (!entry || entry.closing) entry = this.open(key, item);
		if (entry.idleTimer) {
			clearTimeout(entry.idleTimer);
			entry.idleTimer = undefined;
		}
		// A distinct object per lease, so one listener shared by two leases still counts twice.
		const own: StepMcpLeaseListener = {
			onToolsChanged: listener.onToolsChanged?.bind(listener),
			onRefreshFailed: listener.onRefreshFailed?.bind(listener),
			onClosed: listener.onClosed?.bind(listener),
		};
		entry.listeners.add(own);
		const held = entry;
		let released = false;
		return {
			ready: (signal) => raceAbort(held.ready, signal),
			release: async (options = {}) => {
				if (released) return;
				released = true;
				held.listeners.delete(own);
				if (held.listeners.size > 0 || held.closing) return held.closing;
				if (options.immediate || this.idleMs === 0) return this.closeEntry(held);
				held.idleTimer = setTimeout(() => {
					held.idleTimer = undefined;
					if (held.listeners.size === 0) void this.closeEntry(held);
				}, this.idleMs);
				// An idle connection must not keep the process alive on its own.
				held.idleTimer.unref?.();
			},
		};
	}

	/**
	 * Close connections no lease holds, without waiting for their idle grace.
	 * A quitting CLI session uses this so servers left idle by an earlier `/new`
	 * close gracefully before the process exits; held connections are untouched.
	 */
	async closeIdle(): Promise<void> {
		const idle = [...this.entries.values()].filter((entry) => entry.listeners.size === 0);
		await Promise.all(idle.map((entry) => this.closeEntry(entry)));
	}

	/** Close every pooled connection; hosts call this on process shutdown. */
	async closeAll(): Promise<void> {
		await Promise.all([...this.entries.values()].map((entry) => this.closeEntry(entry)));
	}

	private open(key: string, item: TItem): PoolEntry<TItem, TConnection> {
		const controller = new AbortController();
		let resolveReady: (connection: TConnection) => void = () => undefined;
		let rejectReady: (error: unknown) => void = () => undefined;
		const ready = new Promise<TConnection>((resolve, reject) => {
			resolveReady = resolve;
			rejectReady = reject;
		});
		// Leases observe a failure through their own `ready`; this only marks it handled.
		ready.catch(() => undefined);
		const entry: PoolEntry<TItem, TConnection> = {
			key,
			item,
			controller,
			ready,
			listeners: new Set<StepMcpLeaseListener>(),
			refreshPending: false,
			refreshing: false,
		};
		this.entries.set(key, entry);
		const onToolsChanged = () => {
			entry.refreshPending = true;
			void this.refresh(entry);
		};
		this.adapter.connect(item, controller.signal, onToolsChanged).then(
			(connection) => {
				if (controller.signal.aborted) {
					// Released while connecting: nobody will use this connection. `closing`
					// awaits this close, so shutdown does not outlive the child process.
					entry.abandoned = this.adapter.close(connection).catch(() => undefined);
					rejectReady(controller.signal.reason ?? new Error("MCP connection released"));
					return;
				}
				if (connection.signal.aborted) {
					// Closed between the handshake and this callback.
					if (this.entries.get(key) === entry) this.entries.delete(key);
					rejectReady(new Error("MCP connection closed"));
					return;
				}
				entry.connection = connection;
				connection.signal.addEventListener("abort", () => this.onConnectionClosed(entry), { once: true });
				resolveReady(connection);
				// Notifications that arrived during the handshake are applied now.
				void this.refresh(entry);
			},
			(error: unknown) => {
				// A failed start must not be inherited by the next session.
				if (this.entries.get(key) === entry) this.entries.delete(key);
				rejectReady(error);
			},
		);
		return entry;
	}

	/** Coalesce a notification burst into at most one in-flight list plus one follow-up. */
	private async refresh(entry: PoolEntry<TItem, TConnection>): Promise<void> {
		const connection = entry.connection;
		if (entry.refreshing || !connection || connection.signal.aborted) return;
		entry.refreshing = true;
		try {
			while (entry.refreshPending && !connection.signal.aborted) {
				await yieldToEventLoop();
				entry.refreshPending = false;
				try {
					const tools = await this.adapter.listTools(connection, entry.item);
					await yieldToEventLoop();
					if (connection.signal.aborted) return;
					const previous = connection.tools;
					connection.tools = tools;
					for (const listener of [...entry.listeners]) listener.onToolsChanged?.(tools, previous);
				} catch (error) {
					if (connection.signal.aborted) return;
					for (const listener of [...entry.listeners]) listener.onRefreshFailed?.(error);
				}
			}
		} finally {
			entry.refreshing = false;
		}
	}

	private onConnectionClosed(entry: PoolEntry<TItem, TConnection>): void {
		if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
		if (entry.idleTimer) clearTimeout(entry.idleTimer);
		// A deliberate close has no lease left to tell.
		if (entry.controller.signal.aborted) return;
		for (const listener of [...entry.listeners]) listener.onClosed?.();
	}

	private closeEntry(entry: PoolEntry<TItem, TConnection>): Promise<void> {
		if (entry.closing) return entry.closing;
		if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
		if (entry.idleTimer) {
			clearTimeout(entry.idleTimer);
			entry.idleTimer = undefined;
		}
		entry.controller.abort(new Error("MCP connection released"));
		entry.closing = entry.ready.then(
			(connection) => this.adapter.close(connection),
			// A failed connect closed its own transport; an abandoned one is closing in `abandoned`.
			() => entry.abandoned,
		);
		return entry.closing;
	}
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}
