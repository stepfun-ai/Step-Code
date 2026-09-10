import { createServer } from "node:http";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { createEventBus } from "../core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../core/extensions/loader.ts";
import type { ExtensionMode } from "../core/extensions/types.ts";
import type { StepConfigDocument } from "./config-toml.ts";
import { createStepMcpExtension, getStepMcpStatuses } from "./mcp.ts";

const config = vi.hoisted(() => ({ value: {} as StepConfigDocument }));
vi.mock("./config-toml.ts", () => ({ readGlobalStepConfig: () => config.value }));
vi.mock("./plugins.ts", () => ({
	defaultStepPluginsDir: () => "/unused-test-plugins",
	listStepPluginDirectories: async () => [],
}));
vi.mock("./mcp-oauth.ts", () => ({ hasStoredMcpOAuthCredential: () => false }));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function slowServer(toolCount = 1) {
	let release = () => {};
	const ready = new Promise<void>((resolve) => {
		release = resolve;
	});
	let requested = false;
	const server = createServer(async (req, res) => {
		if (req.method !== "POST") {
			res.writeHead(405).end();
			return;
		}
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const message = JSON.parse(Buffer.concat(chunks).toString()) as { id?: number; method: string };
		if (message.id === undefined) {
			res.writeHead(202).end();
			return;
		}
		let result: unknown;
		if (message.method === "initialize") {
			result = {
				protocolVersion: "2025-03-26",
				capabilities: { tools: {} },
				serverInfo: { name: "local-test", version: "1" },
			};
		} else {
			requested = true;
			await ready;
			result = {
				tools: Array.from({ length: toolCount }, (_, index) => ({
					name: `tool_${index}`,
					inputSchema: { type: "object", properties: {} },
				})),
			};
		}
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing test port");
	cleanups.push(async () => {
		release();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return { url: `http://127.0.0.1:${address.port}/mcp`, release, requested: () => requested };
}

async function setup(mode: ExtensionMode) {
	const runtime = createExtensionRuntime();
	const extension = await loadExtensionFromFactory(createStepMcpExtension(), process.cwd(), createEventBus(), runtime);
	const notify = vi.fn();
	const ctx = { cwd: process.cwd(), mode, isProjectTrusted: () => true, ui: { notify } };
	const start = () => extension.handlers.get("session_start")![0]({ type: "session_start" }, ctx);
	const stop = async () => {
		await extension.handlers.get("session_shutdown")![0]({ type: "session_shutdown" }, ctx);
	};
	cleanups.push(stop);
	return { start, stop, extension, runtime, notify };
}

test("TUI binding returns before slow discovery finishes and publishes fast peers independently", async () => {
	const slow = await slowServer();
	const fast = await slowServer(3);
	config.value = { mcp_servers: { slow: { url: slow.url }, fast: { url: fast.url } } };
	const harness = await setup("tui");
	await harness.start();
	await vi.waitFor(() => expect(slow.requested()).toBe(true));
	expect(getStepMcpStatuses().map((s) => s.status)).toEqual(["connecting", "connecting"]);
	fast.release();
	await vi.waitFor(() => expect(harness.extension.tools.size).toBe(3));
	expect(getStepMcpStatuses()).toContainEqual({ name: "fast", status: "connected", toolCount: 3 });
	expect(getStepMcpStatuses()).toContainEqual({ name: "slow", status: "connecting", toolCount: 0 });
	slow.release();
	await vi.waitFor(() => expect(harness.extension.tools.size).toBe(4));
	expect(harness.notify).not.toHaveBeenCalled();
});

test("a server publishes its whole catalog in a single tool-registry refresh", async () => {
	const server = await slowServer(40);
	config.value = { mcp_servers: { slow: { url: server.url } } };
	const harness = await setup("tui");
	// Each refresh rebuilds the registry and the Step system prompt. Registering
	// one tool at a time made that cost linear in catalog size on the startup
	// path; a server must cost exactly one refresh, with the catalog complete.
	const refreshSizes: number[] = [];
	harness.runtime.refreshTools = () => {
		refreshSizes.push(harness.extension.tools.size);
	};
	await harness.start();
	server.release();
	await vi.waitFor(() => expect(harness.extension.tools.size).toBe(40));
	expect(refreshSizes).toEqual([40]);
});

test("publication yields to the event loop before touching the tool registry", async () => {
	const server = await slowServer(40);
	config.value = { mcp_servers: { slow: { url: server.url } } };
	const harness = await setup("tui");
	let toolsWhenLoopRan: number | undefined;
	harness.runtime.refreshTools = () => undefined;
	await harness.start();
	server.release();
	// A turn queued the moment the handshake resolves must run before the
	// catalog lands, so terminal input is never behind a connecting server.
	setImmediate(() => {
		toolsWhenLoopRan ??= harness.extension.tools.size;
	});
	await vi.waitFor(() => expect(harness.extension.tools.size).toBe(40));
	expect(toolsWhenLoopRan).toBe(0);
});

test("shutdown cancels a pending HTTP handshake and prevents late publication", async () => {
	const server = await slowServer();
	config.value = { mcp_servers: { slow: { url: server.url } } };
	const harness = await setup("tui");
	await harness.start();
	await vi.waitFor(() => expect(server.requested()).toBe(true));
	await harness.stop();
	server.release();
	await yieldToEventLoop();
	expect(harness.extension.tools.size).toBe(0);
	expect(getStepMcpStatuses()).toEqual([]);
	expect(harness.notify).not.toHaveBeenCalled();
});

test("headless binding still waits for its initial MCP tools", async () => {
	const server = await slowServer();
	config.value = { mcp_servers: { slow: { url: server.url } } };
	const harness = await setup("print");
	let bound = false;
	const binding = harness.start().then(() => {
		bound = true;
	});
	await vi.waitFor(() => expect(server.requested()).toBe(true));
	expect(bound).toBe(false);
	server.release();
	await binding;
	expect(harness.extension.tools.size).toBe(1);
});

test("a declared allow list narrows the catalog and a deny entry wins over it", async () => {
	const server = await slowServer(4);
	// These lists are a safety control, not a hint: a tool the user denied must
	// never reach the registry, even when the allow list also names it.
	config.value = {
		mcp_servers: {
			filtered: { url: server.url, enabled_tools: ["tool_0", "tool_1", "tool_2"], disabled_tools: ["tool_1"] },
		},
	};
	const harness = await setup("tui");
	await harness.start();
	server.release();
	await vi.waitFor(() => expect(getStepMcpStatuses()[0]?.status).toBe("connected"));
	expect([...harness.extension.tools.keys()].sort()).toEqual(["filtered__tool_0", "filtered__tool_2"]);
});

test("a missing header environment variable fails the server instead of sending an unauthenticated request", async () => {
	const server = await slowServer();
	config.value = {
		mcp_servers: { headers: { url: server.url, env_http_headers: { "X-Api-Key": "STEP_TEST_ABSENT_HEADER" } } },
	};
	const harness = await setup("tui");
	await harness.start();
	await vi.waitFor(() => expect(getStepMcpStatuses()[0]?.status).toBe("failed"));
	expect(harness.notify).toHaveBeenCalledWith(
		expect.stringContaining("MCP header environment variable 'STEP_TEST_ABSENT_HEADER' for 'X-Api-Key' is missing"),
		"warning",
	);
	expect(harness.extension.tools.size).toBe(0);
});
