import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type Tool as McpTool, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AgentToolResult } from "@step-harness/agent-core";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "../core/extensions/types.ts";
import { theme } from "../theme/theme.ts";
import { readGlobalStepConfig } from "./config-toml.ts";
import { createMcpToolCaller, listAllMcpTools } from "./mcp-client.ts";
import { resolveStepMcpEnvironment } from "./mcp-environment.ts";
import { createStoredMcpOAuthProvider, hasStoredMcpOAuthCredential } from "./mcp-oauth.ts";
import { type StepMcpLease, StepMcpPool } from "./mcp-pool.ts";
import { isPathContained } from "./path-containment.ts";
import {
	defaultStepPluginsDir,
	ensureBuiltinPluginsInstalled,
	listStepPluginDirectories,
	provisionInstallCommand,
	readStepPluginManifest,
	type StepPluginProvision,
} from "./plugins.ts";
import { ensureStepPageReady, isManagedStepPageCommand } from "./steppage-provision.ts";
import { STEPCODE_VERSION } from "./version.ts";

export { resolveStepMcpEnvironment } from "./mcp-environment.ts";

const MCP_STARTUP_TIMEOUT_SEC = 30;
const MCP_CALL_TIMEOUT_SEC = 300;
const CLIENT_INFO = { name: "step-harness", version: STEPCODE_VERSION.value } as const;
/** Joins a plugin id to the server name it declares, e.g. `context7__context7`. */
const PLUGIN_SERVER_SEPARATOR = "__";
const STEPPAGE_SERVER_NAME = `steppage${PLUGIN_SERVER_SEPARATOR}steppage`;
const STEPPAGE_DEPLOY_TOOL_NAME = "page_deploy";
const STEPPAGE_MANAGEMENT_URL = "https://platform.stepfun.com/sites";

interface ConnectedServer {
	pluginId?: string;
	readonly name: string;
	readonly client: Client;
	readonly transport: StdioClientTransport | StreamableHTTPClientTransport;
	tools: McpTool[];
	/** Ends when this connection closes or its session shuts down. */
	readonly signal: AbortSignal;
	readonly catalogTimeoutMs: number;
	/** Per-call timeout for this server, from `tool_timeout_sec`. */
	readonly callTimeoutMs: number;
}

interface ServerDeclaration {
	command?: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	url?: string;
	bearer_token_env_var?: string;
	http_headers?: Record<string, string>;
	env_http_headers?: Record<string, string>;
	enabled?: boolean;
	startup_timeout_sec?: number;
	tool_timeout_sec?: number;
	enabled_tools?: string[];
	disabled_tools?: string[];
	/** False keeps one connection per session (stateful servers such as a browser or REPL). */
	shared?: boolean;
	oauth?: {
		client_id?: string;
		client_secret?: string;
		scopes?: string[];
		callback_port?: number;
	};
}

interface DiscoveredServer {
	pluginId?: string;
	name: string;
	declaration: ServerDeclaration;
	provision?: StepPluginProvision;
}

export interface StepMcpStatus {
	name: string;
	status: "connecting" | "connected" | "failed" | "disabled";
	toolCount: number;
	/** Why the server failed to start, as reported to the user. */
	error?: string;
}

let currentMcpStatuses: StepMcpStatus[] = [];
const sessionMcpStatuses = new WeakMap<object, StepMcpStatus[]>();
const currentMcpToolOwners = new WeakMap<object, Map<string, string>>();
export function getStepMcpToolOwner(toolName: string, session: object): string | undefined {
	return currentMcpToolOwners.get(session)?.get(toolName);
}
function publishMcpToolOwners(
	owners: Map<string, string>,
	server: ConnectedServer,
	tools: readonly McpTool[],
	previous: readonly McpTool[] = [],
): void {
	for (const tool of previous) owners.delete(remoteToolName(server, tool));
	if (server.pluginId) for (const tool of tools) owners.set(remoteToolName(server, tool), server.pluginId);
}

/**
 * MCP server statuses. With a session (its `sessionManager`), the statuses that
 * session sees; without one, those of the session that started last in this
 * process, which is what a single-session host such as the TUI shows.
 */
export function getStepMcpStatuses(session?: object): StepMcpStatus[] {
	const statuses = session ? (sessionMcpStatuses.get(session) ?? []) : currentMcpStatuses;
	return statuses.map((status) => ({ ...status }));
}

export function formatStepMcpStatuses(statuses: readonly StepMcpStatus[] = currentMcpStatuses): string {
	const lines =
		statuses.length === 0
			? ["No MCP servers configured."]
			: statuses.map((server) => {
					const connected = server.status === "connected";
					const bullet = connected ? theme.fg("success", "•") : theme.fg("dim", "•");
					const state = connected ? theme.fg("success", "connected") : theme.fg("dim", server.status);
					return `${bullet} ${server.name}: ${state} ${theme.fg("dim", `(${server.toolCount} tools)`)}`;
				});
	return ["MCP Tools", ...lines].join("\n");
}

/**
 * One connection per server identity for the whole process. Sessions lease
 * from it, so `/new`, `/resume` and every open Web/Desktop chat reuse the
 * servers already running instead of spawning another set.
 */
const stepMcpPool = new StepMcpPool<DiscoveredServer, ConnectedServer>({
	key: stepMcpServerKey,
	connect: async (item, signal, onToolsChanged) => {
		const server = await connectStepMcpServer(item, signal, onToolsChanged);
		server.pluginId = item.pluginId;
		return server;
	},
	listTools: async (server, item) =>
		selectDeclaredTools(
			await listAllMcpTools(server.client, server.signal, server.catalogTimeoutMs),
			item.declaration,
		),
	close: closeStepMcpServer,
});

/**
 * How a session's `quit` shutdown releases its pooled servers. `immediate`
 * (the default) closes a server no other session holds, which suits a process
 * about to exit. A host that keeps running after closing one of many sessions
 * (Web, Desktop) chooses `idle`, so reopening a chat reuses the running servers.
 * Session replacement (`/new`, `/resume`, `/fork`, reload) always idles.
 */
export interface StepMcpPoolPolicy {
	quitRelease?: "immediate" | "idle";
	/** Grace before an unused server closes, in milliseconds. */
	idleMs?: number;
}

let quitRelease: "immediate" | "idle" = "immediate";

export function configureStepMcpPool(policy: StepMcpPoolPolicy): void {
	if (policy.quitRelease) quitRelease = policy.quitRelease;
	if (policy.idleMs !== undefined) stepMcpPool.setIdleMs(policy.idleMs);
}

/** Close every pooled MCP connection. Hosts call this once on process shutdown. */
export function closeStepMcpPool(): Promise<void> {
	return stepMcpPool.closeAll();
}

/**
 * Connections a long-running host (Web, Desktop) holds itself, so the global
 * servers are connected before the first chat starts and stay up between chats.
 * The host's leases cover user-level servers only: project plugins depend on a
 * session's folder and trust, and those sessions still lease them on demand.
 */
export interface StepMcpHostWarmup {
	/**
	 * Connect the global servers `cwd` discovers and drop the ones that are no
	 * longer configured. Call at startup and after MCP or plugin settings change.
	 * Failures are not reported here: a session that needs the server retries it
	 * and reports the error in its own status.
	 */
	sync(cwd: string): Promise<void>;
	/** Release every host lease; idle connections then follow the pool's grace. */
	release(): Promise<void>;
}

export function createStepMcpHostWarmup(): StepMcpHostWarmup {
	const held = new Map<string, StepMcpLease<ConnectedServer>>();
	let tail: Promise<void> = Promise.resolve();
	let released = false;
	const sync = async (cwd: string) => {
		if (released) return;
		try {
			await ensureBuiltinPluginsInstalled();
		} catch {
			// Best-effort: discovery still runs with whatever is already installed.
		}
		const discovered = (await discoverStepMcpServers(cwd, false)).filter(
			// A private server is per session by definition; the host has none.
			(item) => item.declaration.shared !== false,
		);
		if (released) return;
		const wanted = new Map(discovered.map((item) => [stepMcpServerKey(item), item]));
		for (const [key, lease] of held) {
			if (wanted.has(key)) continue;
			held.delete(key);
			void lease.release();
		}
		for (const [key, item] of wanted) {
			if (held.has(key)) continue;
			const lease = stepMcpPool.acquire(item, {
				// A closed connection leaves the pool; the next sync or session reconnects it.
				onClosed: () => {
					if (held.get(key) === lease) held.delete(key);
					void lease.release();
				},
			});
			held.set(key, lease);
			lease.ready().catch(() => {
				if (held.get(key) === lease) held.delete(key);
				void lease.release({ immediate: true });
			});
		}
	};
	return {
		// Serialized: a settings change during startup must not race the first sync.
		sync: (cwd) => {
			tail = tail.then(() => sync(cwd)).catch(() => undefined);
			return tail;
		},
		release: async () => {
			released = true;
			await tail;
			const leases = [...held.values()];
			held.clear();
			await Promise.all(leases.map((lease) => lease.release()));
		},
	};
}

/** Pooled connections and their lease counts; for diagnostics and tests. */
export function getStepMcpPoolSnapshot(): Array<{ name: string; leases: number; connected: boolean }> {
	return stepMcpPool.snapshot().map(({ key, leases, connected }) => ({
		name: (JSON.parse(key.replace(/#[0-9a-f-]+$/u, "")) as { name: string }).name,
		leases,
		connected,
	}));
}

/**
 * Identity of a server connection: its published name plus everything that
 * shapes the process or request. Edited settings produce a new key, so a new
 * session connects with them while sessions on the old key keep theirs.
 */
function stepMcpServerKey(item: DiscoveredServer): string {
	const identity = stableStringify({
		name: item.name,
		declaration: item.declaration,
		provision: item.provision ?? null,
		credentials: credentialFingerprint(item),
	});
	// An unshared server gets a key no other lease can match: a private connection per session.
	return item.declaration.shared === false ? `${identity}#${randomUUID()}` : identity;
}

/**
 * What a connection was started with beyond its declaration: the resolved
 * child environment (it carries the Step login key) and whether a stored OAuth
 * credential applies. A sign-in or `step mcp login` while the process runs then
 * yields a new key, so later sessions connect with the new credential instead
 * of reusing one started without it. Only a digest enters the key.
 */
function credentialFingerprint(item: DiscoveredServer): string {
	const material = item.declaration.command
		? stableStringify(resolveStepMcpEnvironment(item.declaration.env))
		: item.declaration.url
			? String(hasStoredMcpOAuthCredential(item.name, item.declaration.url, process.env))
			: "";
	return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

function stableStringify(value: unknown): string {
	return JSON.stringify(value, (_key, entry: unknown) =>
		isRecord(entry)
			? Object.fromEntries(
					Object.keys(entry)
						.sort()
						.map((key) => [key, entry[key]]),
				)
			: entry,
	);
}

/** One server a session uses: its lease on the pooled connection and what it published from it. */
interface SessionServer {
	readonly item: DiscoveredServer;
	/**
	 * The server's identity without the per-lease suffix a private server's pool
	 * key carries; a change re-leases the server under its new identity.
	 */
	readonly identity: string;
	readonly lease: StepMcpLease<ConnectedServer>;
	readonly shared: boolean;
	/** Stops this server's wait alone; session shutdown stops it through the session controller. */
	readonly controller: AbortController;
	status: StepMcpStatus;
	/** The pooled connection, once this lease is ready. */
	server?: ConnectedServer;
	/** Settles, never rejects, once the lease has published its catalog or failed. */
	ready: Promise<void>;
}

/** MCP state owned by one session, from `session_start` until its `session_shutdown`. */
interface SessionMcpState {
	readonly controller: AbortController;
	readonly servers: Map<string, SessionServer>;
	/** Tools this session registered, per connection, so it removes exactly what it added. */
	readonly published: Map<ConnectedServer, McpTool[]>;
	readonly owners: Map<string, string>;
	/** The array status readers hold; rewritten in place so its identity stays stable. */
	readonly statuses: StepMcpStatus[];
	disabled: string[];
	/** Settles once the initial discovery list is applied; its servers may still be connecting. */
	listed: Promise<void>;
	/** Settles once every initially discovered server has published or failed. */
	startup: Promise<void>;
	/** Tail of the serialized reconciliation passes. */
	reconciling: Promise<void>;
}

function serverIdentity(item: DiscoveredServer): string {
	return stableStringify({
		name: item.name,
		pluginId: item.pluginId ?? null,
		declaration: item.declaration,
		provision: item.provision ?? null,
		credentials: credentialFingerprint(item),
	});
}

async function settleServers(servers: Iterable<SessionServer>): Promise<void> {
	await Promise.all([...servers].map((server) => server.ready));
}

/** Wait for `work`, but return as soon as `signal` aborts; the work itself keeps running. */
async function waitUnlessAborted(work: Promise<unknown>, signal: AbortSignal | undefined): Promise<void> {
	if (!signal) {
		await work;
		return;
	}
	if (signal.aborted) return;
	await new Promise<void>((resolve) => {
		const done = () => {
			signal.removeEventListener("abort", done);
			resolve();
		};
		signal.addEventListener("abort", done, { once: true });
		void work.then(done, done);
	});
}

/**
 * Load installed declarative MCP servers and expose their tools to Pi.
 *
 * Servers are leased on `session_start`. Before each prompt, and after each
 * turn that ran tools, the session re-reads the declarations and reconciles:
 * it leases new servers, re-leases changed ones, and releases removed or
 * disabled ones. A server installed while the session runs therefore reaches
 * the next model request without a new session. A request already sent keeps
 * its tools.
 */
export function createStepMcpExtension(): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		let session: SessionMcpState | undefined;

		const publishStatuses = (state: SessionMcpState): void => {
			state.statuses.splice(
				0,
				state.statuses.length,
				...[...state.servers.values()].map((server) => server.status),
				...state.disabled.map((name): StepMcpStatus => ({ name, status: "disabled", toolCount: 0 })),
			);
		};

		const unpublish = (state: SessionMcpState, connection: ConnectedServer): void => {
			const tools = state.published.get(connection);
			if (!tools) return;
			state.published.delete(connection);
			publishMcpToolOwners(state.owners, connection, [], tools);
			pi.registerTools([], { remove: tools.map((tool) => remoteToolName(connection, tool)) });
		};

		const startServer = (state: SessionMcpState, ctx: ExtensionContext, item: DiscoveredServer): SessionServer => {
			const controller = new AbortController();
			const signal = AbortSignal.any([state.controller.signal, controller.signal]);
			const isCurrent = () => state.servers.get(item.name) === entry && !signal.aborted;
			const setStatus = (status: StepMcpStatus) => {
				// A replaced entry must not overwrite its successor's status.
				if (state.servers.get(item.name) !== entry) return;
				entry.status = status;
				publishStatuses(state);
			};
			const lease = stepMcpPool.acquire(item, {
				onToolsChanged: (tools) => {
					const connection = entry.server;
					if (!connection || !isCurrent()) return;
					const previous = state.published.get(connection);
					if (!previous) return;
					pi.registerTools(
						tools.map((tool) => createRemoteTool(connection, tool)),
						{ remove: previous.map((tool) => remoteToolName(connection, tool)) },
					);
					publishMcpToolOwners(state.owners, connection, tools, previous);
					state.published.set(connection, [...tools]);
					setStatus({ name: item.name, status: "connected", toolCount: tools.length });
				},
				onRefreshFailed: (error) => {
					if (!isCurrent()) return;
					ctx.ui.notify(
						`MCP server '${item.name}' catalog refresh failed; keeping the previous tools: ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
				},
				onClosed: () => {
					// Shutdown and a reconciliation stop remove the tools themselves.
					if (!isCurrent()) return;
					if (entry.server) unpublish(state, entry.server);
					setStatus({ name: item.name, status: "failed", toolCount: 0 });
					// The pooled connection is gone; this lease no longer holds anything.
					void lease.release();
				},
			});
			const entry: SessionServer = {
				item,
				identity: serverIdentity(item),
				lease,
				shared: item.declaration.shared !== false,
				controller,
				status: { name: item.name, status: "connecting", toolCount: 0 },
				ready: Promise.resolve(),
			};
			state.servers.set(item.name, entry);
			publishStatuses(state);
			entry.ready = (async () => {
				try {
					const server = await lease.ready(signal);
					entry.server = server;
					// Publishing a server's catalog refreshes the registry and the
					// Step prompt once. Yield first so a server that finished while
					// the loop was busy cannot preempt input or rendering.
					await yieldToEventLoop();
					signal.throwIfAborted();
					server.signal.throwIfAborted();
					// Read after the yield: a refresh may have replaced the catalog meanwhile.
					const tools = [...server.tools];
					pi.registerTools(tools.map((tool) => createRemoteTool(server, tool)));
					publishMcpToolOwners(state.owners, server, tools);
					state.published.set(server, tools);
					setStatus({ name: item.name, status: "connected", toolCount: tools.length });
				} catch (error) {
					if (signal.aborted) return;
					await lease.release({ immediate: true });
					const failure = describeMcpStartFailure({
						name: item.name,
						command: item.declaration.command ?? item.declaration.url ?? "configured server",
						provision: item.provision,
						error,
					});
					setStatus({ name: item.name, status: "failed", toolCount: 0, error: failure });
					ctx.ui.notify(failure, "warning");
				}
			})();
			return entry;
		};

		/**
		 * Withdraw a server's tools and release its lease at once: its declaration
		 * is gone or changed, so nothing will lease this identity again. A
		 * connection another session or the host still holds stays open.
		 */
		const stopServer = async (state: SessionMcpState, entry: SessionServer): Promise<void> => {
			entry.controller.abort();
			if (entry.server) unpublish(state, entry.server);
			await entry.ready;
			await entry.lease.release({ immediate: true });
		};

		const reconcileNow = async (
			state: SessionMcpState,
			ctx: ExtensionContext,
			signal: AbortSignal | undefined,
		): Promise<void> => {
			await state.listed;
			const cancelled = () => state.controller.signal.aborted || signal?.aborted === true;
			if (cancelled()) return;
			const discovered = await discoverStepMcpServers(ctx.cwd, ctx.isProjectTrusted());
			if (cancelled()) return;
			const next = new Map(discovered.map((item) => [item.name, item]));
			const disabled = disabledGlobalServerNames();
			const stopping: SessionServer[] = [];
			const restarting: DiscoveredServer[] = [];
			for (const [name, entry] of state.servers) {
				const item = next.get(name);
				if (!item) {
					stopping.push(entry);
				} else if (serverIdentity(item) !== entry.identity) {
					stopping.push(entry);
					restarting.push(item);
				}
			}
			const added = discovered.filter((item) => !state.servers.has(item.name));
			const disabledChanged = disabled.join("\0") !== state.disabled.join("\0");
			// An unchanged declaration set leaves the registry and prompt untouched; a
			// server that failed with the same declaration is not retried every turn.
			if (stopping.length === 0 && added.length === 0 && !disabledChanged) return;
			for (const entry of stopping) if (!next.has(entry.item.name)) state.servers.delete(entry.item.name);
			state.disabled = disabled;
			publishStatuses(state);
			// Withdraw a changed server's tools before its replacement registers the same names.
			await Promise.all(stopping.map((entry) => stopServer(state, entry)));
			if (state.controller.signal.aborted) return;
			const started = [...restarting, ...added].map((item) => startServer(state, ctx, item));
			if (started.length === 0) return;
			ctx.ui.notify(`Connecting MCP: ${started.map((entry) => entry.item.name).join(", ")}`, "info");
			// Only the servers this pass started gate the request; an initial server
			// still connecting in the background keeps the TUI's non-blocking start.
			await waitUnlessAborted(settleServers(started), signal);
		};

		const reconcile = async (ctx: ExtensionContext): Promise<void> => {
			const state = session;
			if (!state || state.controller.signal.aborted) return;
			const run = state.reconciling.then(() => reconcileNow(state, ctx, ctx.signal));
			state.reconciling = run.catch(() => undefined);
			try {
				await run;
			} catch (error) {
				if (!state.controller.signal.aborted)
					ctx.ui.notify(
						`MCP refresh failed: ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
			}
		};

		pi.on("session_start", async (_event, ctx) => {
			if (session) return;
			const state: SessionMcpState = {
				controller: new AbortController(),
				servers: new Map(),
				published: new Map(),
				owners: new Map(),
				statuses: [],
				disabled: [],
				listed: Promise.resolve(),
				startup: Promise.resolve(),
				reconciling: Promise.resolve(),
			};
			session = state;
			currentMcpStatuses = state.statuses;
			if (ctx.sessionManager) {
				sessionMcpStatuses.set(ctx.sessionManager, state.statuses);
				currentMcpToolOwners.set(ctx.sessionManager, state.owners);
			}
			const signal = state.controller.signal;
			state.listed = (async () => {
				// Finish mounting the interactive session before doing discovery or
				// spawning processes. Awaiting Promise.all in session_start kept the
				// entire initialization path behind the slowest server.
				await yieldToEventLoop();
				if (signal.aborted) return;
				// The old marker records manifest/uninstall intent only. Executable
				// readiness is checked for each installed built-in before connecting.
				try {
					const preinstalled = await ensureBuiltinPluginsInstalled();
					if (signal.aborted) return;
					for (const warning of preinstalled.warnings) ctx.ui.notify(warning, "warning");
				} catch {
					// Best-effort: discovery still runs with whatever is already installed.
				}
				if (signal.aborted) return;
				const discovered = await discoverStepMcpServers(ctx.cwd, ctx.isProjectTrusted());
				if (signal.aborted) return;
				state.disabled = disabledGlobalServerNames();
				for (const item of discovered) startServer(state, ctx, item);
				publishStatuses(state);
			})().catch((error: unknown) => {
				if (!signal.aborted)
					ctx.ui.notify(
						`MCP discovery failed: ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
			});
			state.startup = state.listed.then(() => settleServers(state.servers.values()));
			// Print/RPC callers expect the initial tool catalog before submitting
			// work. Only the interactive TUI detaches startup from session binding.
			if (ctx.mode !== "tui") await state.startup;
		});

		// Both events are awaited before the next model request snapshots its tools:
		// a prompt's first request, and each follow-up request after tool results.
		pi.on("before_agent_start", async (_event, ctx) => {
			await reconcile(ctx);
		});
		pi.on("turn_end", async (event, ctx) => {
			// Only a turn that ran tools continues to another request in this run;
			// changes made outside the session are picked up on the next prompt.
			if (event.toolResults.length > 0) await reconcile(ctx);
		});

		pi.on("session_shutdown", async (event) => {
			const state = session;
			if (!state) return;
			state.controller.abort();
			// Settle the exact promise `session_start` awaits first, then yield a
			// macrotask, so a binding still waiting on startup resumes and the
			// runner's later `session_start` handlers run before this shutdown
			// finishes; finishing first let those handlers start work after their
			// own shutdown handler had already stopped it.
			await state.startup;
			await yieldToEventLoop();
			await state.reconciling;
			await settleServers(state.servers.values());
			const releasing = [...state.servers.values()];
			const closing = [...state.published];
			state.published.clear();
			session = undefined;
			for (const [server, tools] of closing) publishMcpToolOwners(state.owners, server, [], tools);
			if (currentMcpStatuses === state.statuses) currentMcpStatuses = [];
			pi.registerTools([], {
				remove: closing.flatMap(([server, tools]) => tools.map((tool) => remoteToolName(server, tool))),
			});
			// A replacement session in this process is about to lease the same
			// servers; only a quit may close them at once.
			const reason = event.reason ?? "quit";
			const immediate = reason === "quit" && quitRelease === "immediate";
			// A private connection has nobody to reuse it, so it never idles.
			await Promise.all(releasing.map(({ lease, shared }) => lease.release({ immediate: immediate || !shared })));
			// Servers an earlier `/new` or `/resume` left idle would otherwise only
			// end with the process; close them now. Held connections stay open.
			if (immediate) await stepMcpPool.closeIdle();
		});
	};
}

async function closeStepMcpServer(server: Pick<ConnectedServer, "client" | "transport">): Promise<void> {
	try {
		await server.client.close();
	} catch {
		await server.transport.close().catch(() => undefined);
	}
}

/** The server name a plugin declared, stripped of the plugin qualifier. */
export function bareServerName(published: string): string {
	// The plugin qualifier is the *first* segment; a declared server name may
	// itself contain the separator (`acme__my__service` names the server
	// `my__service`). Splitting at the last one would mangle that into `service`,
	// which resolves to nothing.
	const separator = published.indexOf(PLUGIN_SERVER_SEPARATOR);
	return separator > 0 ? published.slice(separator + PLUGIN_SERVER_SEPARATOR.length) : published;
}

/**
 * Look up one configured MCP server by the name the runtime reports for it.
 *
 * `step mcp login|logout` is handed a name from a start-failure message, which is
 * the *discovered* name. Config entries keep their own name, but a plugin's
 * servers are published as `<pluginId>__<serverName>` because the manifest nests
 * them — so a login command that only read `config.toml` could never resolve the
 * very name its own error message printed.
 *
 * Discovery is consulted only as a fallback: a config entry with the same name
 * still wins, matching the precedence used everywhere else.
 */
export async function resolveStepMcpServer(
	name: string,
	options: { cwd?: string; projectTrusted?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<DiscoveredServer | undefined> {
	const env = options.env ?? process.env;
	const config = readGlobalStepConfig(env);
	const entry = config.mcp_servers?.[name];
	if (isRecord(entry) && entry.enabled !== false) return { name, declaration: normalizeDeclaration(entry) };
	const discovered = await discoverStepMcpServers(options.cwd ?? process.cwd(), options.projectTrusted ?? false);
	const exact = discovered.find((server) => server.name === name);
	if (exact) return exact;
	// A plugin's server is published as `<pluginId>__<serverName>`, but the part
	// that identifies it to the user is the server name the manifest declared.
	// Accept that bare name too, so `step mcp login context7` works on the
	// `context7__context7` server — the qualifier only disambiguates.
	const qualified = `${PLUGIN_SERVER_SEPARATOR}${name}`;
	const matches = discovered.filter((server) => server.name.endsWith(qualified));
	// Two plugins can declare a server of the same name. Picking whichever
	// discovery reached first would log the user into an arbitrary one, so an
	// ambiguous bare name resolves to nothing; the caller reports it as ambiguous.
	return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The published names of plugin servers whose declared name matches `name`.
 *
 * A caller needs this to tell "no such server" from "several plugins declare
 * one": an ambiguous bare name must be reported, not resolved to a guess. Empty
 * means nothing matched; two or more means the name needs qualifying.
 */
export async function ambiguousPluginServerNames(name: string): Promise<string[]> {
	const discovered = await discoverStepMcpServers(process.cwd(), false);
	const qualified = `${PLUGIN_SERVER_SEPARATOR}${name}`;
	const matches = discovered.filter((server) => server.name.endsWith(qualified)).map((server) => server.name);
	return matches.length > 1 ? matches : [];
}

/** Servers that global config.toml declares with `enabled = false`; discovery skips them. */
function disabledGlobalServerNames(): string[] {
	const config = readGlobalStepConfig(process.env);
	return Object.entries(config.mcp_servers ?? {})
		.filter(([, declaration]) => isRecord(declaration) && declaration.enabled === false)
		.map(([name]) => name);
}

export async function discoverStepMcpServers(cwd: string, projectTrusted: boolean): Promise<DiscoveredServer[]> {
	const roots = [defaultStepPluginsDir(process.env)];
	if (projectTrusted) roots.push(defaultStepPluginsDir(process.env, { cwd, project: true }));
	const result: DiscoveredServer[] = [];
	const globalServers = new Map<string, DiscoveredServer>();
	const seen = new Set<string>();
	const config = readGlobalStepConfig(process.env);
	for (const [name, declaration] of Object.entries(config.mcp_servers ?? {})) {
		if (!isRecord(declaration)) continue;
		if (declaration.enabled === false) {
			seen.add(name);
			continue;
		}
		if (typeof declaration.command !== "string" && typeof declaration.url !== "string") continue;
		const normalized = normalizeDeclaration(declaration);
		if (typeof normalized.command !== "string" && typeof normalized.url !== "string") continue;
		seen.add(name);
		const server = { name, declaration: normalized };
		result.push(server);
		globalServers.set(name, server);
	}
	for (const root of roots) {
		for (const pluginDir of await listStepPluginDirectories(root)) {
			const parsed = await readStepPluginManifest(pluginDir);
			if (!parsed.manifest) continue;
			const declared = await resolveDeclaredServers(pluginDir, parsed.manifest?.mcpServers);
			if (!declared) continue;
			for (const [serverName, value] of Object.entries(declared)) {
				// A declared server may be stdio (command) or remote (url). Requiring
				// `command` here dropped remote servers silently, even though the
				// global-config path and `normalizeDeclaration` both accept a url —
				// so the same server worked from config.toml but not from a plugin.
				if (!isRecord(value)) continue;
				const name = `${parsed.manifest.id}${PLUGIN_SERVER_SEPARATOR}${serverName}`;
				if (seen.has(name)) {
					const global = globalServers.get(name);
					if (
						name === STEPPAGE_SERVER_NAME &&
						global &&
						isManagedStepPageCommand(global.declaration, parsed.manifest.provision) &&
						isManagedStepPageCommand(value, parsed.manifest.provision)
					) {
						global.provision = parsed.manifest.provision;
						global.pluginId = parsed.manifest.id;
					}
					continue;
				}
				if (value.enabled === false) {
					seen.add(name);
					continue;
				}
				if (!hasTransport(value)) continue;
				seen.add(name);
				const discovered: DiscoveredServer = {
					pluginId: parsed.manifest.id,
					name,
					declaration: anchorPluginServerCwd(
						pluginDir,
						applyPluginHeaderAliases(normalizeDeclaration(value), value),
					),
				};
				if (parsed.manifest.provision) discovered.provision = parsed.manifest.provision;
				result.push(discovered);
			}
		}
	}
	return result;
}

/** A plugin-declared MCP server as a settings screen lists it, disabled ones included. */
export interface StepPluginMcpServerEntry {
	/** Runtime name, `<pluginId>__<server>`; the key a `config.toml` override uses. */
	readonly name: string;
	readonly pluginId: string;
	readonly pluginName: string;
	readonly transport: "stdio" | "http";
	/** False when the plugin declares it disabled or `config.toml` sets `enabled = false` for its runtime name. */
	readonly enabled: boolean;
}

/**
 * List every MCP server the installed plugins declare, including disabled ones,
 * without connecting. Discovery (`discoverStepMcpServers`) drops disabled
 * servers, so a host that offers an enable switch needs this view instead.
 */
export async function listStepPluginMcpServers(
	cwd: string,
	projectTrusted: boolean,
): Promise<StepPluginMcpServerEntry[]> {
	const roots = [defaultStepPluginsDir(process.env)];
	if (projectTrusted) roots.push(defaultStepPluginsDir(process.env, { cwd, project: true }));
	const overrides = readGlobalStepConfig(process.env).mcp_servers ?? {};
	const result: StepPluginMcpServerEntry[] = [];
	const seen = new Set<string>();
	for (const root of roots) {
		for (const pluginDir of await listStepPluginDirectories(root)) {
			const parsed = await readStepPluginManifest(pluginDir);
			if (!parsed.manifest) continue;
			const declared = await resolveDeclaredServers(pluginDir, parsed.manifest.mcpServers);
			if (!declared) continue;
			for (const [serverName, value] of Object.entries(declared)) {
				if (!isRecord(value) || !hasTransport(value)) continue;
				const name = `${parsed.manifest.id}${PLUGIN_SERVER_SEPARATOR}${serverName}`;
				if (seen.has(name)) continue;
				seen.add(name);
				const override = overrides[name];
				result.push({
					name,
					pluginId: parsed.manifest.id,
					pluginName: parsed.manifest.name ?? parsed.manifest.id,
					transport: typeof value.command === "string" && value.command.trim() ? "stdio" : "http",
					enabled: value.enabled !== false && !(isRecord(override) && override.enabled === false),
				});
			}
		}
	}
	return result;
}

/**
 * Run a plugin's stdio server from the plugin root.
 *
 * Without this the child inherited the directory `step` was launched from, so a
 * manifest such as `{"command":"node","args":["server/index.mjs"]}` could not
 * find its own script. A relative `cwd` is read against the plugin root, and one
 * that escapes the plugin falls back to the root; an absolute `cwd` is the
 * author's explicit choice and is kept. This stays out of `normalizeDeclaration`
 * because `config.toml` shares it, and there a relative `cwd` keeps meaning the
 * process directory.
 */
function anchorPluginServerCwd(pluginDir: string, declaration: ServerDeclaration): ServerDeclaration {
	if (typeof declaration.command !== "string") return declaration;
	const declared = declaration.cwd ?? "";
	if (path.isAbsolute(declared)) return declaration;
	const resolved = path.resolve(pluginDir, declared);
	return { ...declaration, cwd: isPathContained(pluginDir, resolved) ? resolved : path.resolve(pluginDir) };
}

/** True when a declaration names either transport: a stdio command or a url. */
function hasTransport(value: Record<string, unknown>): boolean {
	const command = typeof value.command === "string" ? value.command.trim() : "";
	const url = typeof value.url === "string" ? value.url.trim() : "";
	return command.length > 0 || url.length > 0;
}

/**
 * Expand the environment interpolation Claude Code plugins use in header values:
 * `${VAR}` inserts the variable, `${VAR:-fallback}` falls back when it is unset
 * or empty, and `$$` escapes a literal dollar sign.
 *
 * Returns undefined when there is no value to send, so the caller omits the
 * header entirely. That covers two cases a plugin uses interchangeably to mean
 * "no credential configured": a variable with no fallback at all, and an empty
 * fallback as in `Authorization: "Bearer ${CONTEXT7_API_KEY:-}"`. The second is
 * not equivalent to sending `Bearer ` — that is a malformed credential, and a
 * server rejecting it reads as a broken plugin rather than an unset key.
 */
export function expandHeaderTemplate(template: string): string | undefined {
	const pattern = /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/gu;
	let missing = false;
	const expanded = template.replace(pattern, (match, name: string | undefined, fallback: string | undefined) => {
		if (match === "$$") return "$";
		const value = name === undefined ? undefined : process.env[name];
		if (value !== undefined && value !== "") return value;
		if (fallback !== undefined && fallback !== "") return fallback;
		// Unset with no usable fallback: the header has no value, and the literal
		// template must never reach the server.
		missing = true;
		return "";
	});
	return missing ? undefined : expanded;
}

/**
 * Resolve a manifest's `mcpServers` into a server map.
 *
 * The field is either the map itself or a path to a file holding it. The path
 * form is how Claude Code plugins keep MCP config in a sibling `.mcp.json`, and
 * `readPluginManifestAtPath` fills it in automatically when it finds that file —
 * so a plugin reaching this point with a string is the normal Claude layout, not
 * a malformed one. Treating it as unsupported dropped every such plugin's
 * servers without a word.
 */
async function resolveDeclaredServers(
	pluginDir: string,
	declared: unknown,
): Promise<Record<string, unknown> | undefined> {
	if (isRecord(declared)) return declared;
	if (typeof declared !== "string" || !declared.trim()) return undefined;
	const resolved = path.resolve(pluginDir, declared);
	if (!isPathContained(pluginDir, resolved)) return undefined;
	try {
		const raw = JSON.parse(await readFile(resolved, "utf8")) as unknown;
		// The file may hold the map directly or wrap it under `mcpServers`, the
		// shape `.mcp.json` itself uses.
		if (isRecord(raw) && isRecord(raw.mcpServers)) return raw.mcpServers;
		return isRecord(raw) ? raw : undefined;
	} catch {
		// A missing, unreadable, or non-file target (a directory rejects with
		// EISDIR). Nothing to declare either way.
		return undefined;
	}
}

/**
 * Apply the Claude-plugin header spelling to an already-normalized declaration.
 *
 * Kept separate from {@link normalizeDeclaration} because the two entries have
 * different contracts. A plugin's `.mcp.json` may write `headers` and interpolate
 * the environment (`"Bearer ${API_KEY:-}"`), which is Claude's format. A
 * `config.toml` entry documents `http_headers` as a literal string map, so its
 * values are sent verbatim — expanding them here would silently rewrite or drop
 * headers that already worked.
 */
function applyPluginHeaderAliases(declaration: ServerDeclaration, value: Record<string, unknown>): ServerDeclaration {
	if (!isRecord(value.headers)) return declaration;
	const headers: Record<string, string> = {};
	for (const [name, entry] of Object.entries(value.headers)) {
		if (typeof entry !== "string") continue;
		const expanded = expandHeaderTemplate(entry);
		// A header whose variable is unset and has no fallback has no value to send,
		// and the literal template must never reach the server.
		if (expanded !== undefined) headers[name] = expanded;
	}
	// An explicit `http_headers` still wins: it is the more specific spelling, and
	// a manifest that carries both should not have one silently discarded.
	if (Object.keys(headers).length === 0 || declaration.http_headers !== undefined) return declaration;
	return { ...declaration, http_headers: headers };
}

function normalizeDeclaration(value: Record<string, unknown>): ServerDeclaration {
	const declaration: ServerDeclaration = {};
	if (typeof value.command === "string" && value.command.trim()) declaration.command = value.command.trim();
	if (typeof value.url === "string" && value.url.trim()) declaration.url = value.url.trim();
	if (Array.isArray(value.args)) declaration.args = value.args.filter(isString);
	if (typeof value.cwd === "string" && value.cwd.trim()) declaration.cwd = value.cwd.trim();
	if (isRecord(value.env)) {
		const env: Record<string, string> = {};
		for (const [key, entry] of Object.entries(value.env)) if (typeof entry === "string") env[key] = entry;
		declaration.env = env;
	}
	for (const key of ["bearer_token_env_var", "startup_timeout_sec", "tool_timeout_sec"] as const) {
		if (key === "bearer_token_env_var" && typeof value[key] === "string")
			declaration.bearer_token_env_var = value[key];
		if (key === "startup_timeout_sec" && typeof value[key] === "number") declaration.startup_timeout_sec = value[key];
		if (key === "tool_timeout_sec" && typeof value[key] === "number") declaration.tool_timeout_sec = value[key];
	}
	if (isRecord(value.http_headers))
		declaration.http_headers = Object.fromEntries(
			Object.entries(value.http_headers).filter(([, v]) => typeof v === "string"),
		) as Record<string, string>;
	for (const key of ["env_http_headers"] as const) {
		if (isRecord(value[key]))
			declaration[key] = Object.fromEntries(
				Object.entries(value[key]).filter(([, v]) => typeof v === "string"),
			) as Record<string, string>;
	}
	if (typeof value.shared === "boolean") declaration.shared = value.shared;
	for (const key of ["enabled_tools", "disabled_tools"] as const) {
		if (Array.isArray(value[key])) declaration[key] = value[key].filter(isString);
	}
	if (isRecord(value.oauth)) {
		declaration.oauth = {
			...(typeof value.oauth.client_id === "string" ? { client_id: value.oauth.client_id } : {}),
			...(typeof value.oauth.client_secret === "string" ? { client_secret: value.oauth.client_secret } : {}),
			...(Array.isArray(value.oauth.scopes) ? { scopes: value.oauth.scopes.filter(isString) } : {}),
			...(typeof value.oauth.callback_port === "number" ? { callback_port: value.oauth.callback_port } : {}),
		};
	}
	return declaration;
}

export async function connectStepMcpServer(
	input: DiscoveredServer,
	abortSignal?: AbortSignal,
	onToolsChanged?: () => void,
): Promise<ConnectedServer> {
	abortSignal?.throwIfAborted();
	const timeout = timeoutMs(input.declaration.startup_timeout_sec, MCP_STARTUP_TIMEOUT_SEC);
	const callTimeoutMs = timeoutMs(input.declaration.tool_timeout_sec, MCP_CALL_TIMEOUT_SEC);
	let transport: StdioClientTransport | StreamableHTTPClientTransport;
	if (input.declaration.command) {
		const env = resolveStepMcpEnvironment(input.declaration.env);
		let command = input.declaration.command;
		if (input.name === STEPPAGE_SERVER_NAME && isManagedStepPageCommand(input.declaration, input.provision)) {
			// The trusted installer needs host setup variables (proxy/installer URL).
			// The MCP transport still receives only the restricted server environment.
			const readiness = await ensureStepPageReady({ env: { ...process.env, ...env }, signal: abortSignal });
			if (readiness.error) throw new Error(readiness.error);
			command = readiness.command ?? command;
		}
		transport = new StdioClientTransport({
			command,
			args: input.declaration.args,
			cwd: input.declaration.cwd ?? stdioServerCwd(),
			env,
			stderr: "pipe",
		});
		transport.stderr?.on("data", () => undefined);
	} else if (input.declaration.url) {
		const headers = resolveHttpHeaders(input.declaration);
		transport = new StreamableHTTPClientTransport(new URL(input.declaration.url), {
			requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
			...(hasStoredMcpOAuthCredential(input.name, input.declaration.url, process.env)
				? {
						authProvider: createStoredMcpOAuthProvider(input.name, input.declaration.url, process.env),
					}
				: {}),
		});
	} else {
		throw new Error("MCP server must define command or url");
	}
	const client = new Client(CLIENT_INFO, { capabilities: {} });
	const closed = new AbortController();
	client.onclose = () => closed.abort(new Error("MCP connection closed"));
	const lifetime = AbortSignal.any([closed.signal, ...(abortSignal ? [abortSignal] : [])]);
	if (onToolsChanged) client.setNotificationHandler(ToolListChangedNotificationSchema, onToolsChanged);
	const signal = AbortSignal.any([AbortSignal.timeout(timeout), lifetime]);
	const closeOnAbort = () => {
		void closeStepMcpServer({ client, transport });
	};
	signal.addEventListener("abort", closeOnAbort, { once: true });
	try {
		signal.throwIfAborted();
		await client.connect(transport, { timeout, signal });
		const tools = await listAllMcpTools(client, signal, timeout);
		signal.throwIfAborted();
		return {
			name: input.name,
			client,
			transport,
			tools: selectDeclaredTools(tools, input.declaration),
			signal: lifetime,
			catalogTimeoutMs: timeout,
			callTimeoutMs,
		};
	} catch (error) {
		await closeStepMcpServer({ client, transport });
		throw error;
	} finally {
		signal.removeEventListener("abort", closeOnAbort);
	}
}

/**
 * Working directory for a stdio server that declares none: the host's own, by
 * path. Inheriting it implicitly breaks once that directory is removed and
 * recreated (a Desktop dev host runs from apps/web/dist, which every web build
 * deletes): the child starts inside the deleted directory and Node exits on
 * its first process.cwd(), so the handshake ends in "MCP connection closed".
 * Node keeps the cwd path, so passing it re-resolves to the directory there
 * now; a path that no longer exists falls back to the home directory.
 */
export function stdioServerCwd(): string {
	let cwd: string | undefined;
	try {
		cwd = process.cwd();
	} catch {
		// uv_cwd fails when the directory is gone and the path was never cached.
	}
	return cwd && existsSync(cwd) ? cwd : homedir();
}

/** Clamp a declared timeout to a usable range, falling back to the product default. */
function timeoutMs(declared: number | undefined, fallbackSec: number): number {
	const seconds = typeof declared === "number" && Number.isFinite(declared) && declared > 0 ? declared : fallbackSec;
	return Math.max(1_000, seconds * 1_000);
}

/**
 * Apply the server's allow/deny lists.
 *
 * These are a safety control: a user who lists `enabled_tools` expects every
 * other tool to stay unreachable, so filter here, before the catalog reaches
 * the registry, rather than relying on the model to avoid a name.
 */
function selectDeclaredTools(tools: readonly McpTool[], declaration: ServerDeclaration): McpTool[] {
	const allowed = declaration.enabled_tools;
	const denied = new Set(declaration.disabled_tools ?? []);
	return tools.filter((tool) => {
		if (denied.has(tool.name)) return false;
		return allowed === undefined || allowed.includes(tool.name);
	});
}

function resolveHttpHeaders(declaration: ServerDeclaration): Record<string, string> {
	const headers = { ...(declaration.http_headers ?? {}) };
	for (const [name, envName] of Object.entries(declaration.env_http_headers ?? {})) {
		// The value is the name of an environment variable, not the header value.
		// Fail loudly, as `bearer_token_env_var` does: dropping the header would
		// send an unauthenticated request and report an opaque server error.
		const value = process.env[envName]?.trim();
		if (!value) throw new Error(`MCP header environment variable '${envName}' for '${name}' is missing`);
		headers[name] = value;
	}
	if (declaration.bearer_token_env_var) {
		const token = process.env[declaration.bearer_token_env_var]?.trim();
		if (!token)
			throw new Error(`MCP bearer token environment variable '${declaration.bearer_token_env_var}' is missing`);
		headers.Authorization = `Bearer ${token}`;
	}
	return headers;
}

/** Turn a failed server start into a message the user can act on. */
export function describeMcpStartFailure(input: {
	name: string;
	command: string;
	provision?: StepPluginProvision;
	error: unknown;
	env?: NodeJS.ProcessEnv;
}): string {
	const detail = input.error instanceof Error ? input.error.message : String(input.error);
	if (
		input.error instanceof UnauthorizedError ||
		(input.error instanceof StreamableHTTPError && input.error.code === 401)
	) {
		// Print the bare server name, not the `<pluginId>__<serverName>` form the
		// runtime publishes: the qualifier is an implementation detail of how
		// plugin servers are namespaced, and `login` accepts either spelling.
		const bare = bareServerName(input.name);
		const quoted = /^[\w.-]+$/u.test(bare) ? bare : `'${bare.replace(/'/gu, "'\\''")}'`;
		return `MCP server '${input.name}' could not start: ${detail}\nAuthenticate with: step mcp login ${quoted}, then start a new session or restart Step.`;
	}
	if (!isMissingExecutable(input.error)) return `MCP server '${input.name}' could not start: ${detail}`;
	const install = input.provision ? provisionInstallCommand(input.provision, input.env ?? process.env) : undefined;
	const remedy = install
		? `Install it with: ${install}, then start a new session or restart Step.`
		: "Install it, then start a new session or restart Step.";
	return `MCP server '${input.name}' could not start: '${input.command}' is not installed or not on PATH. ${remedy}`;
}

/** A spawn that failed because the executable is absent, rather than because the server misbehaved. */
function isMissingExecutable(error: unknown): boolean {
	if (isRecord(error) && (error.code === "ENOENT" || error.errno === -2)) return true;
	return error instanceof Error && /\bENOENT\b/u.test(error.message);
}

interface McpCallResult {
	content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>;
	structuredContent?: unknown;
	isError?: boolean;
}

/**
 * Convert one MCP call result into model-facing content. Image blocks
 * (screenshot-style tools) must survive to the model: the host resizes them
 * and downgrades them to a text placeholder for non-vision models downstream,
 * so dropping them here would blind the model to its own captures.
 */
export function convertMcpCallResult(serverName: string, toolName: string, result: McpCallResult) {
	if (result.isError === true) {
		const errorText = (result.content ?? [])
			.filter((item) => item.type === "text" && typeof item.text === "string")
			.map((item) => item.text as string)
			.join("\n\n")
			.trim();
		throw new Error(errorText || `MCP tool '${toolName}' failed.`);
	}
	const text = (result.content ?? [])
		.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text as string)
		.join("\n\n");
	const images = (result.content ?? []).filter(
		(item): item is { type: "image"; data: string; mimeType: string } =>
			item.type === "image" &&
			typeof item.data === "string" &&
			item.data.length > 0 &&
			typeof item.mimeType === "string",
	);
	// Without this note an image-only result falls into the JSON fallback,
	// which pastes the base64 payload into the text block.
	const fallback = images.length > 0 ? "(see attached image)" : JSON.stringify(result.structuredContent ?? result);
	const renderedText = appendStepPageManagementHint(serverName, toolName, text || fallback);
	return {
		content: [
			{ type: "text" as const, text: renderedText },
			...images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
		],
		details: result,
	};
}

function remoteToolName(server: Pick<ConnectedServer, "name">, remote: McpTool): string {
	return `${server.name}${PLUGIN_SERVER_SEPARATOR}${sanitizeName(remote.name)}`;
}

function createRemoteTool(server: ConnectedServer, remote: McpTool) {
	const name = remoteToolName(server, remote);
	const call = createMcpToolCaller(server.client, remote);
	return {
		name,
		label: remote.title?.trim() || remote.name,
		description: remote.description?.trim() || `MCP tool '${remote.name}' from server '${server.name}'.`,
		// The provider boundary accepts JSON Schema directly. Reconstructing it
		// as TypeBox types loses constraints, local references and combinators.
		parameters: remote.inputSchema,
		execute: async (
			_toolCallId: string,
			params: unknown,
			signal: AbortSignal | undefined,
		): Promise<AgentToolResult<unknown>> => {
			const result = await call(isRecord(params) ? params : {}, {
				timeout: server.callTimeoutMs,
				resetTimeoutOnProgress: true,
				signal: signal ? AbortSignal.any([signal, server.signal]) : server.signal,
			});
			return convertMcpCallResult(server.name, remote.name, result);
		},
	};
}

export function appendStepPageManagementHint(serverName: string, toolName: string, text: string): string {
	if (serverName !== STEPPAGE_SERVER_NAME || toolName !== STEPPAGE_DEPLOY_TOOL_NAME) return text;
	return `${text}\n\nTo manage your deployed pages, visit ${STEPPAGE_MANAGEMENT_URL}`;
}

function sanitizeName(value: string): string {
	const normalized = value.replace(/[^a-zA-Z0-9_]+/gu, "_").replace(/^_+|_+$/gu, "");
	return normalized || "tool";
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
