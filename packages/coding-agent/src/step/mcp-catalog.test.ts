import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay, setImmediate as yieldToEventLoop } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult, ListToolsResult, Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { Agent } from "@step-harness/agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type ToolCall,
	validateToolArguments,
} from "@step-harness/providers";
import { afterEach, expect, test, vi } from "vitest";
import { createTestExtensionsResult, createTestResourceLoader, stepModel } from "../../test/utilities.ts";
import { createEventBus } from "../core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../core/extensions/loader.ts";
import type { ExtensionMode, ToolDefinition } from "../core/extensions/types.ts";
import { createAgentSession } from "../core/sdk.ts";
import { SessionManager } from "../core/session-manager.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { wrapToolDefinition } from "../core/tools/tool-definition-wrapper.ts";
import type { StepConfigDocument } from "./config-toml.ts";
import { connectStepMcpServer, createStepMcpExtension, getStepMcpStatuses } from "./mcp.ts";
import { invokeRemoteMcpTool } from "./mcp-client.ts";
import { createStepToolProfile } from "./tool-profile.ts";

const config = vi.hoisted(() => ({ value: {} as StepConfigDocument }));
vi.mock("./config-toml.ts", () => ({ readGlobalStepConfig: () => config.value }));
vi.mock("./plugins.ts", () => ({
	defaultStepPluginsDir: () => "/unused-test-plugins",
	listStepPluginDirectories: async () => [],
	ensureBuiltinPluginsInstalled: async () => ({ installed: [], warnings: [] }),
	provisionBuiltinPlugin: async () => undefined,
}));
vi.mock("./mcp-oauth.ts", () => ({ hasStoredMcpOAuthCredential: () => false }));

const cleanups: Array<() => Promise<unknown>> = [];
const releases: Array<() => void> = [];
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

function gate() {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	releases.push(release);
	return { promise, release };
}

function tool(name: string, description = name, inputSchema: McpTool["inputSchema"] = { type: "object" }): McpTool {
	return { name, description, inputSchema };
}

type ListHandler = (cursor: string | undefined, request: number) => ListToolsResult | Promise<ListToolsResult>;

/** A real HTTP/SSE peer exercises the pinned SDK's requests and notification routing. */
async function catalogServer(initial: ListToolsResult[], initializedResponse?: Promise<void>) {
	let pages = initial;
	let initializedRequested = false;
	let initializedResponded = false;
	const streams = new Set<ServerResponse>();
	const requests: Array<string | undefined> = [];
	const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
	let onCall = async (_args: { name: string; arguments: Record<string, unknown> }): Promise<CallToolResult> => ({
		content: [{ type: "text", text: "called" }],
	});
	let listing = 0;
	let maxConcurrentLists = 0;
	let onList: ListHandler = (cursor) => pages[cursor === undefined ? 0 : Number(cursor)];
	const server = createServer(async (req, res) => {
		if (req.method === "GET") {
			res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
			res.flushHeaders();
			streams.add(res);
			res.on("close", () => streams.delete(res));
			return;
		}
		if (req.method !== "POST") {
			res.writeHead(405).end();
			return;
		}
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const message = JSON.parse(Buffer.concat(chunks).toString()) as {
			id?: number;
			method: string;
			params?: { cursor?: string; name: string; arguments: Record<string, unknown> };
		};
		if (message.id === undefined) {
			if (message.method === "notifications/initialized") {
				initializedRequested = true;
				await initializedResponse;
				initializedResponded = true;
			}
			res.writeHead(202).end();
			return;
		}
		try {
			let result: unknown;
			if (message.method === "initialize") {
				result = {
					protocolVersion: "2025-03-26",
					capabilities: { tools: { listChanged: true } },
					serverInfo: { name: "catalog-test", version: "1" },
				};
			} else if (message.method === "tools/list") {
				requests.push(message.params?.cursor);
				listing++;
				maxConcurrentLists = Math.max(maxConcurrentLists, listing);
				try {
					result = await onList(message.params?.cursor, requests.length);
				} finally {
					listing--;
				}
			} else if (message.method === "tools/call") {
				calls.push(message.params!);
				result = await onCall(message.params!);
			} else {
				throw new Error(`Unexpected method ${message.method}`);
			}
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
		} catch (error) {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: message.id,
					error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
				}),
			);
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing test port");
	cleanups.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return {
		url: `http://127.0.0.1:${address.port}/mcp`,
		requests,
		calls,
		maxConcurrentLists: () => maxConcurrentLists,
		initializedRequested: () => initializedRequested,
		initializedResponded: () => initializedResponded,
		setPages(next: ListToolsResult[]) {
			pages = next;
		},
		setListHandler(handler: ListHandler) {
			onList = handler;
		},
		setCallHandler(handler: typeof onCall) {
			onCall = handler;
		},
		async notify(count = 1) {
			await vi.waitFor(() => expect(streams.size).toBeGreaterThan(0));
			const notification = `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`;
			for (const stream of streams) stream.write(notification.repeat(count));
		},
	};
}

async function setup(mode: ExtensionMode = "print") {
	const runtime = createExtensionRuntime();
	const extension = await loadExtensionFromFactory(createStepMcpExtension(), process.cwd(), createEventBus(), runtime);
	const notify = vi.fn();
	const ctx = { cwd: process.cwd(), mode, isProjectTrusted: () => true, ui: { notify } };
	const batches: string[][] = [];
	runtime.refreshTools = () => batches.push([...extension.tools.keys()].sort());
	const start = () => extension.handlers.get("session_start")![0]({ type: "session_start" }, ctx);
	const stop = () => extension.handlers.get("session_shutdown")![0]({ type: "session_shutdown" }, ctx);
	cleanups.push(stop);
	return { start, stop, extension, runtime, batches, notify };
}

test.each(["print", "rpc"] as const)(
	"%s readiness waits for all pages, including an empty continuation page",
	async (mode) => {
		const lastPage = gate();
		const server = await catalogServer([]);
		server.setListHandler(async (cursor) => {
			if (cursor === undefined) return { tools: [tool("first")], nextCursor: "1" };
			if (cursor === "1") return { tools: [], nextCursor: "2" };
			await lastPage.promise;
			return { tools: [tool("last")] };
		});
		config.value = { mcp_servers: { pages: { url: server.url } } };
		const harness = await setup(mode);
		let ready = false;
		const starting = harness.start().then(() => {
			ready = true;
		});
		await vi.waitFor(() => expect(server.requests).toEqual([undefined, "1", "2"]));
		expect(ready).toBe(false);
		expect(harness.extension.tools.size).toBe(0);
		expect(harness.batches).toEqual([]);
		lastPage.release();
		await starting;
		expect(harness.batches).toEqual([["pages__first", "pages__last"]]);
		expect(getStepMcpStatuses()).toEqual([{ name: "pages", status: "connected", toolCount: 2 }]);
	},
);

test("the one-shot remote client consumes empty continuation pages too", async () => {
	const server = await catalogServer([
		{ tools: [tool("first")], nextCursor: "1" },
		{ tools: [], nextCursor: "2" },
		{ tools: [tool("last")] },
	]);
	const result = await invokeRemoteMcpTool({
		serverName: "pages",
		serverUrl: server.url,
		toolName: "last",
		arguments: {},
	});
	expect(result).toEqual({ content: "called" });
	expect(server.requests).toEqual([undefined, "1", "2"]);
});

test.each(["timeout", "caller cancellation"])(
	"one-shot handshake honors %s while the initialized notification response is withheld",
	async (kind) => {
		const withheld = gate();
		const server = await catalogServer([{ tools: [tool("check")] }], withheld.promise);
		const controller = new AbortController();
		let outcome: { error: unknown } | { result: unknown } | undefined;
		const invocation = invokeRemoteMcpTool({
			serverName: "handshake",
			serverUrl: server.url,
			toolName: "check",
			arguments: {},
			timeoutMs: kind === "timeout" ? 100 : 30_000,
			signal: controller.signal,
		}).then(
			(result) => {
				outcome = { result };
			},
			(error: unknown) => {
				outcome = { error };
			},
		);
		// Release only in cleanup so a hung baseline settles without leaking a client.
		cleanups.push(async () => {
			withheld.release();
			await invocation;
		});
		await vi.waitFor(() => expect(server.initializedRequested()).toBe(true));
		if (kind === "caller cancellation") controller.abort();
		await vi.waitFor(() => expect(outcome).toEqual({ error: expect.any(Error) }), { timeout: 700, interval: 10 });
		expect(outcome).toMatchObject({
			error: { message: expect.stringContaining("MCP tool handshake.check failed:") },
		});
		expect(server.initializedResponded()).toBe(false);
		expect(server.requests).toEqual([]);
		expect(server.calls).toEqual([]);
	},
);

test("one-shot handshake rejects an already-aborted caller before starting the client", async () => {
	const server = await catalogServer([{ tools: [tool("check")] }]);
	const connecting = vi.spyOn(Client.prototype, "connect");
	const controller = new AbortController();
	controller.abort(new Error("cancelled before connect"));
	await expect(
		invokeRemoteMcpTool({
			serverName: "handshake",
			serverUrl: server.url,
			toolName: "check",
			arguments: {},
			signal: controller.signal,
		}),
	).rejects.toThrow("cancelled before connect");
	expect(connecting).not.toHaveBeenCalled();
	expect(server.initializedRequested()).toBe(false);
	expect(server.requests).toEqual([]);
	expect(server.calls).toEqual([]);
});

test.each(["session", "one-shot"])("%s rejects repeated cursors before requesting a page twice", async (kind) => {
	const server = await catalogServer([]);
	server.setListHandler((cursor, request) => {
		if (request > 4) throw new Error("test stopped an unbounded pagination loop");
		return { tools: [tool("first")], nextCursor: cursor === "1" ? "2" : "1" };
	});
	if (kind === "session") {
		const connecting = connectStepMcpServer({ name: "cycle", declaration: { url: server.url } }).then((connected) => {
			cleanups.push(() => connected.client.close());
			return connected;
		});
		await expect(connecting).rejects.toThrow(/cursor/i);
	} else {
		await expect(
			invokeRemoteMcpTool({ serverName: "cycle", serverUrl: server.url, toolName: "missing", arguments: {} }),
		).rejects.toThrow(/cursor/i);
	}
	expect(server.requests).toEqual([undefined, "1", "2"]);
});

test("an empty string cursor is opaque and is still followed", async () => {
	const server = await catalogServer([]);
	server.setListHandler((cursor) =>
		cursor === undefined ? { tools: [], nextCursor: "" } : { tools: [tool("last")] },
	);
	const connecting = await connectStepMcpServer({ name: "opaque", declaration: { url: server.url } });
	cleanups.push(() => connecting.client.close());
	expect(connecting.tools.map((entry) => entry.name)).toEqual(["last"]);
	expect(server.requests).toEqual([undefined, ""]);
});

test("one startup deadline covers the handshake and all catalog pages", async () => {
	const server = await catalogServer([]);
	server.setListHandler(async (cursor) => {
		await delay(600);
		return cursor === undefined ? { tools: [tool("first")], nextCursor: "1" } : { tools: [tool("last")] };
	});
	const connecting = connectStepMcpServer({
		name: "deadline",
		declaration: { url: server.url, startup_timeout_sec: 1 },
	}).then((connected) => {
		cleanups.push(() => connected.client.close());
		return connected;
	});
	await expect(connecting).rejects.toThrow(/timeout|timed out|aborted/i);
	expect(server.requests).toEqual([undefined, "1"]);
});

test("session abort cancels a later page and never publishes a partial catalog", async () => {
	const pending = gate();
	const server = await catalogServer([]);
	server.setListHandler(async (cursor) => {
		if (cursor === undefined) return { tools: [tool("first")], nextCursor: "1" };
		await pending.promise;
		return { tools: [tool("late")] };
	});
	config.value = { mcp_servers: { abort: { url: server.url } } };
	const harness = await setup("tui");
	await harness.start();
	await vi.waitFor(() => expect(server.requests).toEqual([undefined, "1"]));
	await harness.stop();
	pending.release();
	await yieldToEventLoop();
	expect(harness.batches).toEqual([]);
	expect(harness.extension.tools.size).toBe(0);
	expect(harness.notify).not.toHaveBeenCalled();
});

test("list changes add, update and remove filtered tools in one complete batch", async () => {
	const server = await catalogServer([{ tools: [tool("keep", "old"), tool("remove"), tool("denied")] }]);
	config.value = {
		mcp_servers: {
			live: { url: server.url, enabled_tools: ["keep", "remove", "add", "denied"], disabled_tools: ["denied"] },
		},
	};
	const harness = await setup();
	await harness.start();
	const schema = {
		type: "object" as const,
		properties: { limit: { type: "integer", minimum: 2 } },
		required: ["limit"],
	};
	server.setPages([
		{ tools: [tool("keep", "updated", schema), tool("denied"), tool("unlisted")], nextCursor: "1" },
		{ tools: [tool("add")] },
	]);
	await server.notify();
	await vi.waitFor(() => expect([...harness.extension.tools.keys()].sort()).toEqual(["live__add", "live__keep"]));
	expect(harness.batches).toEqual([
		["live__keep", "live__remove"],
		["live__add", "live__keep"],
	]);
	expect(harness.extension.tools.get("live__keep")!.definition).toMatchObject({
		description: "updated",
		parameters: schema,
	});
	expect(getStepMcpStatuses()).toEqual([{ name: "live", status: "connected", toolCount: 2 }]);
});

test("a successful empty refresh removes the server's entire registered catalog", async () => {
	const server = await catalogServer([{ tools: [tool("old")] }]);
	config.value = { mcp_servers: { live: { url: server.url } } };
	const harness = await setup();
	await harness.start();
	server.setPages([{ tools: [] }]);
	await server.notify();
	await vi.waitFor(() => expect(harness.extension.tools.size).toBe(0));
	expect(harness.batches).toEqual([["live__old"], []]);
	expect(getStepMcpStatuses()).toEqual([{ name: "live", status: "connected", toolCount: 0 }]);
});

test("a failed later refresh page keeps the last good catalog and a later notification can recover", async () => {
	const server = await catalogServer([{ tools: [tool("good")] }]);
	config.value = { mcp_servers: { live: { url: server.url } } };
	const harness = await setup();
	await harness.start();
	const original = harness.extension.tools.get("live__good");
	server.setListHandler((cursor) => {
		if (cursor === undefined) return { tools: [tool("partial")], nextCursor: "1" };
		throw new Error("catalog unavailable");
	});
	await server.notify();
	await vi.waitFor(() =>
		expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("catalog unavailable"), "warning"),
	);
	expect(harness.extension.tools.get("live__good")).toBe(original);
	expect(harness.batches).toEqual([["live__good"]]);
	expect(getStepMcpStatuses()).toEqual([{ name: "live", status: "connected", toolCount: 1 }]);
	server.setListHandler(() => ({ tools: [tool("recovered")] }));
	await server.notify();
	await vi.waitFor(() => expect(harness.extension.tools.has("live__recovered")).toBe(true));
	expect(harness.batches).toEqual([["live__good"], ["live__recovered"]]);
});

test("notification bursts coalesce to one running refresh and one follow-up", async () => {
	const server = await catalogServer([{ tools: [tool("initial")] }]);
	config.value = { mcp_servers: { live: { url: server.url } } };
	const harness = await setup();
	await harness.start();
	const pending = gate();
	server.setListHandler(async (_cursor, request) => {
		if (request === 2) {
			await pending.promise;
			return { tools: [tool("middle")] };
		}
		return { tools: [tool("latest")] };
	});
	await server.notify(30);
	await vi.waitFor(() => expect(server.requests).toHaveLength(2));
	await server.notify(30);
	// Give notification routing an event-loop turn while the request is held.
	await delay(30);
	expect(server.requests).toHaveLength(2);
	pending.release();
	await vi.waitFor(() => expect(harness.extension.tools.has("live__latest")).toBe(true));
	expect(server.requests).toHaveLength(3);
	expect(server.maxConcurrentLists()).toBe(1);
	expect(harness.batches.at(-1)).toEqual(["live__latest"]);
});

test("a notification during initial listing is retained for a follow-up refresh", async () => {
	const initial = gate();
	const server = await catalogServer([]);
	server.setListHandler(async (_cursor, request) => {
		if (request === 1) {
			await initial.promise;
			return { tools: [tool("initial")] };
		}
		return { tools: [tool("latest")] };
	});
	config.value = { mcp_servers: { live: { url: server.url } } };
	const harness = await setup("tui");
	await harness.start();
	await vi.waitFor(() => expect(server.requests).toHaveLength(1));
	await server.notify();
	await delay(30);
	initial.release();
	await vi.waitFor(() => expect(harness.extension.tools.has("live__latest")).toBe(true));
	expect(server.requests).toHaveLength(2);
});

test.each(["shutdown", "disconnect"])("%s removes its catalog and ignores a late refresh result", async (action) => {
	const connecting = vi.spyOn(Client.prototype, "connect");
	const server = await catalogServer([{ tools: [tool("initial")] }]);
	config.value = { mcp_servers: { live: { url: server.url } } };
	const harness = await setup();
	await harness.start();
	const client = connecting.mock.contexts[0] as Client;
	const late = gate();
	// A response already in userland may settle after SDK cancellation/close.
	server.setPages([{ tools: [tool("late")] }]);
	const request = client.request.bind(client);
	const listing = vi.spyOn(client, "request").mockImplementationOnce(async (...args) => {
		const result = await request(...args);
		await late.promise;
		return result;
	});
	await server.notify();
	await vi.waitFor(() => expect(listing).toHaveBeenCalledTimes(1));
	if (action === "shutdown") await harness.stop();
	else await client.close();
	expect(harness.extension.tools.size).toBe(0);
	late.release();
	await yieldToEventLoop();
	await yieldToEventLoop();
	expect(harness.batches).toEqual([["live__initial"], []]);
	expect(harness.notify).not.toHaveBeenCalled();
	if (action === "shutdown") expect(getStepMcpStatuses()).toEqual([]);
	else expect(getStepMcpStatuses()).toEqual([{ name: "live", status: "failed", toolCount: 0 }]);
});

const complexSchema: McpTool["inputSchema"] = {
	type: "object",
	properties: {
		count: { type: "integer", minimum: 1, maximum: 10 },
		config: {
			type: "object",
			properties: {
				mode: { enum: ["fast", "slow", null] },
				paths: { type: "array", items: { type: "string", minLength: 2 }, minItems: 1, uniqueItems: true },
			},
			required: ["mode", "paths"],
			additionalProperties: false,
		},
		choice: {
			oneOf: [
				{ type: "string", const: "auto" },
				{ type: "integer", minimum: 3 },
			],
		},
		target: { anyOf: [{ type: "string", pattern: "^ok:" }, { type: "null" }] },
		range: { allOf: [{ type: "integer", minimum: 2 }, { maximum: 5 }] },
		window: { $ref: "#/definitions/window" },
	},
	required: ["count", "config", "choice", "target", "range", "window"],
	additionalProperties: false,
	definitions: {
		window: {
			type: "object",
			properties: { size: { type: "integer", minimum: 1 } },
			required: ["size"],
			additionalProperties: false,
		},
	},
};

function validArguments() {
	return {
		count: 2,
		config: { mode: "fast", paths: ["ab"] },
		choice: "auto",
		target: "ok:yes",
		range: 3,
		window: { size: 2 },
	};
}

async function schemaTool(schema = complexSchema) {
	const server = await catalogServer([{ tools: [tool("check", "Validate complex arguments", schema)] }]);
	config.value = { mcp_servers: { schema: { url: server.url } } };
	const harness = await setup();
	await harness.start();
	return { server, definition: harness.extension.tools.get("schema__check")!.definition };
}

function validate(definition: ToolDefinition, args: Record<string, unknown>) {
	return validateToolArguments(definition, {
		type: "toolCall",
		id: "schema-call",
		name: definition.name,
		arguments: args,
	});
}

test("MCP input schemas survive registration with their original JSON semantics", async () => {
	const { definition } = await schemaTool();
	expect(JSON.parse(JSON.stringify(definition.parameters))).toEqual(complexSchema);
	expect(validate(definition, validArguments())).toEqual(validArguments());
});

test("nullable enum members remain valid through provider argument validation", async () => {
	const { definition } = await schemaTool();
	const args = { ...validArguments(), config: { mode: null, paths: ["ab"] } };
	expect(validate(definition, args)).toEqual(args);
});

test.each([
	["integer", { count: 1.5 }],
	["minimum", { count: 0 }],
	["maximum", { count: 11 }],
	["nested required", { config: { paths: ["ab"] } }],
	["nested additionalProperties", { config: { mode: "fast", paths: ["ab"], extra: true } }],
	["enum", { config: { mode: "invalid", paths: ["ab"] } }],
	["item minLength", { config: { mode: "fast", paths: ["a"] } }],
	["uniqueItems", { config: { mode: "fast", paths: ["ab", "ab"] } }],
	["minItems", { config: { mode: "fast", paths: [] } }],
	["oneOf", { choice: "manual" }],
	["anyOf", { target: "bad:value" }],
	["allOf", { range: 6 }],
	["local definitions", { window: { size: 1.5 } }],
	["root additionalProperties", { extra: true }],
])("provider validation enforces the preserved %s constraint", async (_name, invalid) => {
	const { definition } = await schemaTool();
	expect(() => validate(definition, { ...validArguments(), ...invalid })).toThrow(/Validation failed/);
});

test("local $defs references remain enforceable", async () => {
	const schema: McpTool["inputSchema"] = {
		type: "object",
		properties: { count: { $ref: "#/$defs/count" } },
		required: ["count"],
		$defs: { count: { type: "integer", minimum: 2 } },
	};
	const { definition } = await schemaTool(schema);
	expect(validate(definition, { count: 3 })).toEqual({ count: 3 });
	expect(() => validate(definition, { count: 1.5 })).toThrow(/Validation failed/);
});

test("the agent loop rejects invalid MCP arguments before a remote call", async () => {
	const { definition, server } = await schemaTool();
	const model = stepModel();
	let turn = 0;
	const agent = new Agent({
		initialState: { model, tools: [wrapToolDefinition(definition)] },
		streamFn: () => {
			const stream = createAssistantMessageEventStream();
			const toolCall = (id: string, args: Record<string, unknown>): ToolCall => ({
				type: "toolCall",
				id,
				name: definition.name,
				arguments: args,
			});
			const content: AssistantMessage["content"] =
				turn++ === 0
					? [toolCall("invalid", { ...validArguments(), count: 1.5 }), toolCall("valid", validArguments())]
					: [{ type: "text", text: "done" }];
			const message: AssistantMessage = {
				role: "assistant",
				content,
				api: model.api,
				model: model.id,
				provider: model.provider,
				stopReason: turn === 1 ? "toolUse" : "stop",
				timestamp: Date.now(),
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
			stream.end(message);
			return stream;
		},
	});
	await agent.prompt("Check the arguments");
	expect(server.calls).toEqual([{ name: "check", arguments: validArguments() }]);
	const invalid = agent.state.messages.find(
		(message) => message.role === "toolResult" && message.toolCallId === "invalid",
	);
	expect(invalid).toMatchObject({
		isError: true,
		content: [{ type: "text", text: expect.stringContaining("Validation failed") }],
	});
});

function outputTool(name: string, valueType: "integer" | "string", description = name): McpTool {
	return {
		...tool(name, description),
		outputSchema: {
			// Catalog generations may reuse a schema ID with a different definition.
			$id: "urn:catalog-test:output",
			type: "object",
			properties: { value: { type: valueType } },
			required: ["value"],
		},
	};
}

test.each(["session", "one-shot"])("%s validates an output schema from the first catalog page", async (kind) => {
	const server = await catalogServer([
		{ tools: [outputTool("first", "integer")], nextCursor: "1" },
		{ tools: [tool("last")] },
	]);
	server.setCallHandler(async () => ({ content: [], structuredContent: { value: "invalid integer" } }));
	if (kind === "session") {
		config.value = { mcp_servers: { output: { url: server.url } } };
		const harness = await setup();
		await harness.start();
		const registered = harness.extension.tools.get("output__first")!.definition;
		await expect(registered.execute("output", {}, undefined, undefined, undefined as never)).rejects.toThrow(
			/output schema/,
		);
	} else {
		await expect(
			invokeRemoteMcpTool({ serverName: "output", serverUrl: server.url, toolName: "first", arguments: {} }),
		).rejects.toThrow(/output schema/);
	}
	expect(server.requests).toEqual([undefined, "1"]);
});

test.each(["session", "one-shot"])(
	"%s rejects required-task tools from the first catalog page before execution",
	async (kind) => {
		const server = await catalogServer([
			{ tools: [{ ...tool("required"), execution: { taskSupport: "required" } }], nextCursor: "1" },
			{ tools: [tool("last")] },
		]);
		if (kind === "session") {
			config.value = { mcp_servers: { tasks: { url: server.url } } };
			const harness = await setup();
			await harness.start();
			const registered = harness.extension.tools.get("tasks__required")!.definition;
			await expect(registered.execute("task", {}, undefined, undefined, undefined as never)).rejects.toThrow(
				/requires task-based execution/,
			);
		} else {
			await expect(
				invokeRemoteMcpTool({ serverName: "tasks", serverUrl: server.url, toolName: "required", arguments: {} }),
			).rejects.toThrow(/requires task-based execution/);
		}
		expect(server.calls).toEqual([]);
		expect(server.requests).toEqual([undefined, "1"]);
	},
);

test("a failed refresh cannot replace the output validation of the last good tool", async () => {
	const server = await catalogServer([{ tools: [outputTool("check", "integer", "old")] }]);
	config.value = { mcp_servers: { output: { url: server.url } } };
	const harness = await setup();
	await harness.start();
	const registered = harness.extension.tools.get("output__check")!.definition;
	server.setListHandler((cursor) => {
		if (cursor === undefined) return { tools: [outputTool("check", "string", "new")], nextCursor: "1" };
		throw new Error("second page failed");
	});
	await server.notify();
	await vi.waitFor(() =>
		expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("second page failed"), "warning"),
	);
	expect(harness.extension.tools.get("output__check")!.definition).toBe(registered);
	server.setCallHandler(async () => ({ content: [], structuredContent: { value: "new schema only" } }));
	await expect(registered.execute("old", {}, undefined, undefined, undefined as never)).rejects.toThrow(
		/output schema/,
	);
});

test("a pending call validates against its captured schema after a catalog update reuses the schema ID", async () => {
	const server = await catalogServer([{ tools: [outputTool("check", "integer", "old")] }]);
	config.value = { mcp_servers: { output: { url: server.url } } };
	const harness = await setup();
	await harness.start();
	const pending = gate();
	server.setCallHandler(async () => {
		await pending.promise;
		return { content: [], structuredContent: { value: 2 } };
	});
	const original = harness.extension.tools.get("output__check")!.definition;
	const execution = original.execute("pending", {}, undefined, undefined, undefined as never);
	void execution.catch(() => undefined);
	await vi.waitFor(() => expect(server.calls).toHaveLength(1));
	server.setPages([{ tools: [outputTool("check", "string", "new")] }]);
	await server.notify();
	await vi.waitFor(() => expect(harness.extension.tools.get("output__check")!.definition.description).toBe("new"));
	pending.release();
	await expect(execution).resolves.toMatchObject({ details: { structuredContent: { value: 2 } } });
	const updated = harness.extension.tools.get("output__check")!.definition;
	await expect(updated.execute("updated", {}, undefined, undefined, undefined as never)).rejects.toThrow(
		/output schema/,
	);
});

test.each(["session", "one-shot"])(
	"%s still requires structured output on successful schema-bearing calls",
	async (kind) => {
		const server = await catalogServer([{ tools: [outputTool("check", "integer")] }]);
		if (kind === "session") {
			config.value = { mcp_servers: { output: { url: server.url } } };
			const harness = await setup();
			await harness.start();
			const registered = harness.extension.tools.get("output__check")!.definition;
			await expect(registered.execute("output", {}, undefined, undefined, undefined as never)).rejects.toThrow(
				/structured content/,
			);
		} else {
			await expect(
				invokeRemoteMcpTool({ serverName: "output", serverUrl: server.url, toolName: "check", arguments: {} }),
			).rejects.toThrow(/structured content/);
		}
	},
);

test("find_tools sees a late MCP catalog and stops returning tools removed by the server", async () => {
	const initial = gate();
	const server = await catalogServer([]);
	server.setListHandler(async (_cursor, request) => {
		if (request === 1) {
			await initial.promise;
			return {
				tools: [
					tool("calendar", "Read calendar events", {
						type: "object",
						properties: { calendar_id: { type: "string" } },
						required: ["calendar_id"],
					}),
				],
			};
		}
		return { tools: [] };
	});
	config.value = { mcp_servers: { live: { url: server.url } } };
	const cwd = await mkdtemp(join(tmpdir(), "mcp-discovery-"));
	cleanups.push(() => rm(cwd, { recursive: true, force: true }));
	const extensionsResult = await createTestExtensionsResult([createStepMcpExtension()], cwd);
	const { session } = await createAgentSession({
		cwd,
		agentDir: join(cwd, "agent"),
		model: stepModel(),
		sessionManager: SessionManager.inMemory(),
		settingsManager: SettingsManager.inMemory(),
		resourceLoader: createTestResourceLoader({ extensionsResult }),
		customTools: createStepToolProfile(cwd),
	});
	const runner = session.extensionRunner;
	cleanups.push(async () => {
		await runner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	});
	await session.bindExtensions({ mode: "tui" });
	const find = session.agent.state.tools.find((entry) => entry.name === "find_tools")!;
	const search = async () => {
		const result = await find.execute("find", { query: "calendar" });
		return result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
	};
	expect(await search()).toBe("(no matching tools)");
	initial.release();
	await vi.waitFor(() => expect(session.getActiveToolNames()).toContain("live__calendar"));
	expect(await search()).toContain("live__calendar");
	expect(await search()).toContain('"calendar_id"');
	await server.notify();
	await vi.waitFor(() => expect(session.getActiveToolNames()).not.toContain("live__calendar"));
	expect(await search()).toBe("(no matching tools)");
});

test("input schema preservation retains the provider's existing coercion and format limits", async () => {
	const schema: McpTool["inputSchema"] = {
		type: "object",
		properties: {
			count: { type: "integer" },
			email: { type: "string", format: "email" },
			custom: { type: "string", format: "unregistered-catalog-test-format" },
		},
		required: ["count", "email", "custom"],
	};
	const { definition } = await schemaTool(schema);
	expect(JSON.parse(JSON.stringify(definition.parameters))).toEqual(schema);
	expect(validate(definition, { count: "2", email: "test@example.org", custom: "arbitrary" })).toEqual({
		count: 2,
		email: "test@example.org",
		custom: "arbitrary",
	});
	expect(() => validate(definition, { count: 2, email: "not-an-email", custom: "arbitrary" })).toThrow(
		/Validation failed/,
	);
});

test("a refresh with an unusable output schema keeps the old executable catalog", async () => {
	const server = await catalogServer([{ tools: [outputTool("check", "integer", "old")] }]);
	config.value = { mcp_servers: { output: { url: server.url } } };
	const harness = await setup();
	await harness.start();
	const original = harness.extension.tools.get("output__check")!.definition;
	server.setPages([
		{
			tools: [
				{
					...tool("check", "invalid"),
					outputSchema: { type: "object", properties: { value: { $ref: "#/missing" } } },
				},
			],
		},
	]);
	await server.notify();
	await vi.waitFor(() =>
		expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("catalog refresh failed"), "warning"),
	);
	expect(harness.extension.tools.get("output__check")!.definition).toBe(original);
	expect(harness.batches).toHaveLength(1);
	server.setCallHandler(async () => ({ content: [], structuredContent: { value: 2 } }));
	await expect(original.execute("old", {}, undefined, undefined, undefined as never)).resolves.toMatchObject({
		details: { structuredContent: { value: 2 } },
	});
});
