import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createEventBus } from "../core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../core/extensions/loader.ts";
import type { StepConfigDocument } from "./config-toml.ts";
import {
	closeStepMcpPool,
	configureStepMcpPool,
	createStepMcpExtension,
	createStepMcpHostWarmup,
	getStepMcpPoolSnapshot,
	stdioServerCwd,
} from "./mcp.ts";

const config = vi.hoisted(() => ({ value: {} as StepConfigDocument }));
vi.mock("./config-toml.ts", () => ({ readGlobalStepConfig: () => config.value }));
vi.mock("./plugins.ts", () => ({
	defaultStepPluginsDir: () => "/unused-test-plugins",
	listStepPluginDirectories: async () => [],
	readStepPluginManifest: async () => ({ manifest: undefined, errors: [] }),
	ensureBuiltinPluginsInstalled: async () => ({ installed: [], warnings: [] }),
	provisionBuiltinPlugin: async () => undefined,
}));
vi.mock("./mcp-oauth.ts", () => ({ hasStoredMcpOAuthCredential: () => false }));

const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
	config.value = {};
});
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	await closeStepMcpPool();
});

/** A Streamable HTTP MCP peer that counts `initialize` requests, one per client connection. */
async function countingServer() {
	let initializations = 0;
	const server = createServer(async (req, res) => {
		if (req.method !== "POST") return void res.writeHead(405).end();
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const message = JSON.parse(Buffer.concat(chunks).toString()) as { id?: number; method: string };
		if (message.id === undefined) return void res.writeHead(202).end();
		let result: unknown;
		if (message.method === "initialize") {
			initializations++;
			result = {
				protocolVersion: "2025-03-26",
				capabilities: { tools: {} },
				serverInfo: { name: "count", version: "1" },
			};
		} else {
			result = { tools: [{ name: "probe", inputSchema: { type: "object", properties: {} } }] };
		}
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing test port");
	cleanups.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return { url: `http://127.0.0.1:${address.port}/mcp`, initializations: () => initializations };
}

/** One session: its own extension instance and context, as each Web chat or `/new` creates. */
async function session() {
	const runtime = createExtensionRuntime();
	const extension = await loadExtensionFromFactory(createStepMcpExtension(), process.cwd(), createEventBus(), runtime);
	const ctx = { cwd: process.cwd(), mode: "rpc", isProjectTrusted: () => false, ui: { notify: vi.fn() } };
	let stopped = false;
	const stop = async (reason: "quit" | "new" = "quit") => {
		if (stopped) return;
		stopped = true;
		await extension.handlers.get("session_shutdown")![0]({ type: "session_shutdown", reason }, ctx);
	};
	cleanups.push(() => stop());
	await extension.handlers.get("session_start")![0]({ type: "session_start" }, ctx);
	const beforeAgentStart = () => extension.handlers.get("before_agent_start")![0]({ type: "before_agent_start" }, ctx);
	return { extension, stop, beforeAgentStart };
}

test("sessions in one process share one connection per server", async () => {
	const server = await countingServer();
	config.value = { mcp_servers: { docs: { url: server.url } } };
	const first = await session();
	const second = await session();
	expect(first.extension.tools.has("docs__probe")).toBe(true);
	expect(second.extension.tools.has("docs__probe")).toBe(true);
	expect(server.initializations()).toBe(1);
	expect(getStepMcpPoolSnapshot()).toEqual([{ name: "docs", leases: 2, connected: true }]);

	// One session quitting must not close the connection the other still uses.
	await first.stop();
	expect(getStepMcpPoolSnapshot()).toEqual([{ name: "docs", leases: 1, connected: true }]);
	await second.stop();
	expect(getStepMcpPoolSnapshot()).toEqual([]);
});

test("a replacement session reuses the connection the previous one released", async () => {
	const server = await countingServer();
	config.value = { mcp_servers: { docs: { url: server.url } } };
	const first = await session();
	await first.stop("new");
	const replacement = await session();
	expect(replacement.extension.tools.has("docs__probe")).toBe(true);
	expect(server.initializations()).toBe(1);
});

test("shared = false gives each session its own connection", async () => {
	const server = await countingServer();
	config.value = { mcp_servers: { browser: { url: server.url, shared: false } } };
	const first = await session();
	const second = await session();
	expect(first.extension.tools.has("browser__probe")).toBe(true);
	expect(second.extension.tools.has("browser__probe")).toBe(true);
	expect(server.initializations()).toBe(2);
	// A private connection closes with its session even on replacement: nobody else can reuse it.
	await first.stop("new");
	expect(getStepMcpPoolSnapshot()).toHaveLength(1);
});

test("host warmup connects global servers before any session and sessions reuse them", async () => {
	const server = await countingServer();
	config.value = { mcp_servers: { docs: { url: server.url } } };
	const warmup = createStepMcpHostWarmup();
	cleanups.push(() => warmup.release());
	await warmup.sync(process.cwd());
	await vi.waitFor(() => expect(getStepMcpPoolSnapshot()).toEqual([{ name: "docs", leases: 1, connected: true }]));
	expect(server.initializations()).toBe(1);

	const chat = await session();
	expect(chat.extension.tools.has("docs__probe")).toBe(true);
	expect(server.initializations()).toBe(1);
	// The host keeps the server up after the chat quits.
	await chat.stop();
	expect(getStepMcpPoolSnapshot()).toEqual([{ name: "docs", leases: 1, connected: true }]);
});

test("host warmup releases servers removed from the configuration", async () => {
	configureStepMcpPool({ idleMs: 0 });
	cleanups.push(async () => configureStepMcpPool({ idleMs: 30_000 }));
	const kept = await countingServer();
	const removed = await countingServer();
	config.value = { mcp_servers: { kept: { url: kept.url }, removed: { url: removed.url } } };
	const warmup = createStepMcpHostWarmup();
	cleanups.push(() => warmup.release());
	await warmup.sync(process.cwd());
	await vi.waitFor(() => expect(getStepMcpPoolSnapshot().filter((entry) => entry.connected)).toHaveLength(2));

	config.value = { mcp_servers: { kept: { url: kept.url } } };
	await warmup.sync(process.cwd());
	await vi.waitFor(() => expect(getStepMcpPoolSnapshot().map((entry) => entry.name)).toEqual(["kept"]));
});

test("host warmup skips servers that must not be shared", async () => {
	const server = await countingServer();
	config.value = { mcp_servers: { browser: { url: server.url, shared: false } } };
	const warmup = createStepMcpHostWarmup();
	cleanups.push(() => warmup.release());
	await warmup.sync(process.cwd());
	expect(getStepMcpPoolSnapshot()).toEqual([]);
	expect(server.initializations()).toBe(0);
});

test("a stdio server starts in the host's directory by path, or in home once that path is gone", () => {
	const cwd = vi.spyOn(process, "cwd");
	try {
		cwd.mockReturnValue(tmpdir());
		expect(stdioServerCwd()).toBe(tmpdir());
		// A Desktop dev host's directory deleted by a rebuild and not recreated.
		cwd.mockReturnValue(join(tmpdir(), "stepcode-deleted-host-cwd-does-not-exist"));
		expect(stdioServerCwd()).toBe(homedir());
		cwd.mockImplementation(() => {
			throw Object.assign(new Error("uv_cwd"), { code: "ENOENT" });
		});
		expect(stdioServerCwd()).toBe(homedir());
	} finally {
		cwd.mockRestore();
	}
});

test("a server added mid-session reuses the connection another session already holds", async () => {
	const server = await countingServer();
	const open = await session();
	config.value = { mcp_servers: { docs: { url: server.url } } };
	const other = await session();
	expect(server.initializations()).toBe(1);

	await open.beforeAgentStart();
	expect(open.extension.tools.has("docs__probe")).toBe(true);
	expect(server.initializations()).toBe(1);
	expect(getStepMcpPoolSnapshot()).toEqual([{ name: "docs", leases: 2, connected: true }]);
	await other.stop();
});

test("a server removed mid-session is released at once but stays open for a session still holding it", async () => {
	const server = await countingServer();
	config.value = { mcp_servers: { docs: { url: server.url } } };
	const first = await session();
	const second = await session();

	config.value = {};
	await first.beforeAgentStart();
	expect(first.extension.tools.has("docs__probe")).toBe(false);
	expect(getStepMcpPoolSnapshot()).toEqual([{ name: "docs", leases: 1, connected: true }]);

	await second.beforeAgentStart();
	expect(second.extension.tools.has("docs__probe")).toBe(false);
	// No idle grace: the identity is no longer configured, so nothing will reuse it.
	expect(getStepMcpPoolSnapshot()).toEqual([]);
});
