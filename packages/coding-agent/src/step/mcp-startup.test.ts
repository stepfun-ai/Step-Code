import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, test, vi } from "vitest";
import { createEventBus } from "../core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../core/extensions/loader.ts";
import type { ExtensionMode } from "../core/extensions/types.ts";
import type { StepConfigDocument } from "./config-toml.ts";
import {
	ambiguousPluginServerNames,
	bareServerName,
	createStepMcpExtension,
	describeMcpStartFailure,
	discoverStepMcpServers,
	expandHeaderTemplate,
	getStepMcpStatuses,
	resolveStepMcpServer,
} from "./mcp.ts";

const config = vi.hoisted(() => ({ value: {} as StepConfigDocument }));
vi.mock("./config-toml.ts", () => ({ readGlobalStepConfig: () => config.value }));
const pluginMocks = vi.hoisted(() => ({
	dirs: [] as string[],
	manifests: new Map<string, unknown>(),
}));
vi.mock("./plugins.ts", () => ({
	defaultStepPluginsDir: () => "/unused-test-plugins",
	listStepPluginDirectories: async () => pluginMocks.dirs,
	readStepPluginManifest: async (dir: string) => ({ manifest: pluginMocks.manifests.get(dir), errors: [] }),
	ensureBuiltinPluginsInstalled: async () => ({ installed: [], warnings: [] }),
	provisionBuiltinPlugin: async () => undefined,
}));
vi.mock("./mcp-oauth.ts", () => ({ hasStoredMcpOAuthCredential: () => false }));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	pluginMocks.dirs = [];
	pluginMocks.manifests.clear();
	config.value = {};
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

/** The literal `${VAR}` / `${VAR:-fallback}` text a plugin writes in a header value. */
function placeholder(name: string, fallback?: string): string {
	const body = fallback === undefined ? name : `${name}:-${fallback}`;
	return `${"$"}${"{"}${body}${"}"}`;
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

test("discovers a remote plugin server declared with a url and no command", async () => {
	const server = await slowServer(2);
	const dir = "/mock-plugins/remote";
	pluginMocks.dirs = [dir];
	pluginMocks.manifests.set(dir, {
		id: "remote",
		mcpServers: { docs: { type: "http", url: server.url } },
	});
	// Gate on a url instead of a command: a plugin server with no command used to
	// be skipped silently, so the same entry worked from config.toml but not here.
	const harness = await setup("tui");
	await harness.start();
	server.release();
	await vi.waitFor(() => expect(harness.extension.tools.size).toBe(2));
	expect(getStepMcpStatuses()).toContainEqual({ name: "remote__docs", status: "connected", toolCount: 2 });
});

test("carries Claude plugin headers, including environment interpolation", async () => {
	process.env.STEP_TEST_HEADER_VALUE = "from-env";
	const seen: Array<string | undefined> = [];
	const received = createServer(async (req, res) => {
		if (req.method !== "POST") {
			// The transport probes with GET/HEAD; only the JSON-RPC POST carries a body.
			res.writeHead(405).end();
			return;
		}
		seen.push(req.headers["x-from-env"] as string | undefined);
		seen.push(req.headers.authorization as string | undefined);
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const message = JSON.parse(Buffer.concat(chunks).toString()) as { id?: number; method: string };
		if (message.id === undefined) {
			res.writeHead(202).end();
			return;
		}
		const result =
			message.method === "initialize"
				? {
						protocolVersion: "2025-03-26",
						capabilities: { tools: {} },
						serverInfo: { name: "headers-test", version: "1" },
					}
				: { tools: [] };
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
	});
	await new Promise<void>((resolve) => received.listen(0, "127.0.0.1", resolve));
	const address = received.address();
	if (!address || typeof address === "string") throw new Error("Missing test port");
	cleanups.push(async () => {
		received.closeAllConnections();
		await new Promise<void>((resolve) => received.close(() => resolve()));
		delete process.env.STEP_TEST_HEADER_VALUE;
	});

	const dir = "/mock-plugins/headers";
	pluginMocks.dirs = [dir];
	pluginMocks.manifests.set(dir, {
		id: "headers",
		mcpServers: {
			docs: {
				type: "http",
				url: `http://127.0.0.1:${address.port}/mcp`,
				// The Claude plugin spelling, with an unset variable behind a default.
				// Built by concatenation so the literal placeholder text is the
				// fixture rather than something a template literal would interpolate.
				headers: {
					Authorization: `Bearer ${placeholder("CONTEXT7_API_KEY", "")}`,
					"X-From-Env": placeholder("STEP_TEST_HEADER_VALUE"),
				},
			},
		},
	});
	const harness = await setup("tui");
	await harness.start();
	await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
	expect(seen).toContain("from-env");
	// The unset key expands to nothing, so no Authorization header is sent at all
	// rather than the malformed `Bearer ` an empty default would produce.
	expect(seen).not.toContain("Bearer");
	expect(seen).toContain(undefined);
});

test("expands header templates and reports a variable with no fallback", () => {
	process.env.STEP_TEST_PRESENT = "value";
	expect(expandHeaderTemplate("literal")).toBe("literal");
	expect(expandHeaderTemplate(placeholder("STEP_TEST_PRESENT"))).toBe("value");
	expect(expandHeaderTemplate(`Bearer ${placeholder("STEP_TEST_PRESENT")}`)).toBe("Bearer value");
	expect(expandHeaderTemplate(`Bearer ${placeholder("STEP_TEST_ABSENT", "anonymous")}`)).toBe("Bearer anonymous");
	// No fallback and no variable: the caller omits the header rather than
	// sending the template text to the server.
	expect(expandHeaderTemplate(`Bearer ${placeholder("STEP_TEST_ABSENT")}`)).toBeUndefined();
	// The empty default a plugin uses to mean "omit when unset". A plain
	// interpolation would produce the malformed `Bearer ` instead.
	expect(expandHeaderTemplate(`Bearer ${placeholder("STEP_TEST_ABSENT", "")}`)).toBeUndefined();
	expect(expandHeaderTemplate(`cost: ${"$$"}5 ${placeholder("STEP_TEST_PRESENT")}`)).toBe("cost: $5 value");
	delete process.env.STEP_TEST_PRESENT;
});

test("a plugin stdio server runs from the plugin root unless it names an absolute cwd", async () => {
	const dir = "/mock-plugins/local";
	pluginMocks.dirs = [dir];
	pluginMocks.manifests.set(dir, {
		id: "local",
		mcpServers: {
			bare: { command: "node", args: ["server/index.mjs"] },
			dot: { command: "node", cwd: "." },
			nested: { command: "node", cwd: "server" },
			escapes: { command: "node", cwd: ".." },
			absolute: { command: "node", cwd: "/opt/elsewhere" },
			remote: { url: "https://example.test/mcp" },
		},
	});
	const discovered = await discoverStepMcpServers(process.cwd(), false);
	const cwdOf = (server: string) => discovered.find((entry) => entry.name === `local__${server}`)?.declaration.cwd;
	expect(cwdOf("bare")).toBe(dir);
	expect(cwdOf("dot")).toBe(dir);
	expect(cwdOf("nested")).toBe(join(dir, "server"));
	expect(cwdOf("escapes")).toBe(dir);
	expect(cwdOf("absolute")).toBe("/opt/elsewhere");
	// A remote server is never spawned, so it is given no working directory.
	expect(cwdOf("remote")).toBeUndefined();
});

test("a plugin stdio server with a relative script starts when step runs elsewhere", async () => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "mcp-plugin-cwd-"));
	cleanups.push(async () => rm(root, { recursive: true, force: true }));
	const dir = join(root, "plugin");
	await mkdir(join(dir, "server"), { recursive: true });
	// A minimal newline-delimited JSON-RPC server: enough for the handshake and one tool.
	await writeFile(
		join(dir, "server", "index.mjs"),
		`import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
	const { id, method, params } = JSON.parse(line);
	if (id === undefined) return;
	if (method === "initialize") {
		send({ id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1" } } });
	} else if (method === "tools/list") {
		send({ id, result: { tools: [{ name: "where", inputSchema: { type: "object" } }] } });
	} else {
		send({ id, error: { code: -32601, message: method } });
	}
});
`,
	);
	pluginMocks.dirs = [dir];
	pluginMocks.manifests.set(dir, {
		id: "local",
		mcpServers: { probe: { command: process.execPath, args: ["server/index.mjs"] } },
	});
	// The test process is not in the plugin directory, which is the whole point.
	expect(process.cwd()).not.toBe(dir);

	const harness = await setup("tui");
	await harness.start();
	await vi.waitFor(() => expect(harness.extension.tools.size).toBe(1));
	expect(getStepMcpStatuses()).toContainEqual({ name: "local__probe", status: "connected", toolCount: 1 });
});

test("resolves a plugin whose mcpServers points at a sibling .mcp.json", async () => {
	const server = await slowServer(1);
	// The string form names a real file, so this needs a real directory on disk.
	const root = await mkdtemp(join(await realpath(tmpdir()), "mcp-plugin-file-"));
	cleanups.push(async () => rm(root, { recursive: true, force: true }));
	const dir = join(root, "external");
	await mkdir(dir, { recursive: true });
	// The Claude layout: the manifest names the file rather than carrying the map.
	pluginMocks.dirs = [dir];
	pluginMocks.manifests.set(dir, { id: "external", mcpServers: ".mcp.json" });
	await writeFile(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { docs: { type: "http", url: server.url } } }));
	const harness = await setup("tui");
	await harness.start();
	server.release();
	await vi.waitFor(() => expect(harness.extension.tools.size).toBe(1));
	expect(getStepMcpStatuses()).toContainEqual({ name: "external__docs", status: "connected", toolCount: 1 });
});

test("ignores an mcpServers path that escapes the plugin", async () => {
	// Write a perfectly valid file outside the plugin, then point at it.
	const root = await mkdtemp(join(await realpath(tmpdir()), "mcp-plugin-escape-"));
	cleanups.push(async () => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "outside.json"), JSON.stringify({ mcpServers: { evil: { command: "false" } } }));
	const dir = join(root, "plugin");
	await mkdir(dir, { recursive: true });
	pluginMocks.dirs = [dir];
	pluginMocks.manifests.set(dir, { id: "escapes", mcpServers: "../outside.json" });

	const harness = await setup("tui");
	await harness.start();
	// Nothing is read from outside the plugin directory.
	expect(getStepMcpStatuses()).toEqual([]);
	expect(harness.extension.tools.size).toBe(0);
});

test("resolves a plugin server by its bare name as well as its published one", async () => {
	const dir = "/mock-plugins/named";
	pluginMocks.dirs = [dir];
	pluginMocks.manifests.set(dir, {
		id: "context7",
		mcpServers: { context7: { type: "http", url: "https://example.invalid/mcp" } },
	});

	// `step mcp login context7` is what a user reaches for, and what the start
	// failure now suggests; the qualifier is only there to disambiguate.
	const bare = await resolveStepMcpServer("context7");
	expect(bare?.name).toBe("context7__context7");
	expect(bare?.declaration.url).toBe("https://example.invalid/mcp");

	// The published spelling keeps working for callers that have it.
	const published = await resolveStepMcpServer("context7__context7");
	expect(published?.declaration.url).toBe("https://example.invalid/mcp");
});

test("a bare name still resolves when the plugin and server names differ", async () => {
	const dir = "/mock-plugins/mismatched";
	pluginMocks.dirs = [dir];
	pluginMocks.manifests.set(dir, {
		id: "claude-plugins-official",
		mcpServers: { docs: { url: "https://example.invalid/docs" } },
	});
	const resolved = await resolveStepMcpServer("docs");
	expect(resolved?.name).toBe("claude-plugins-official__docs");
});

test("an ambiguous bare name resolves to nothing instead of picking one", async () => {
	const alpha = "/mock-plugins/alpha";
	const beta = "/mock-plugins/beta";
	pluginMocks.dirs = [alpha, beta];
	pluginMocks.manifests.set(alpha, { id: "alpha", mcpServers: { docs: { url: "https://alpha.invalid/mcp" } } });
	pluginMocks.manifests.set(beta, { id: "beta", mcpServers: { docs: { url: "https://beta.invalid/mcp" } } });

	// Two plugins declare `docs`. Logging into whichever discovery reached first
	// would be a silent coin flip, so the bare name is reported as ambiguous.
	expect(await resolveStepMcpServer("docs")).toBeUndefined();
	expect(await ambiguousPluginServerNames("docs")).toEqual(["alpha__docs", "beta__docs"]);

	// The qualified spellings stay unambiguous.
	expect((await resolveStepMcpServer("alpha__docs"))?.declaration.url).toBe("https://alpha.invalid/mcp");
	// A single match is not reported as ambiguous.
	expect(await ambiguousPluginServerNames("nothing-here")).toEqual([]);
});

test("an unqualified name does not match a server whose own name ends with it", async () => {
	const dir = "/mock-plugins/notasuffix";
	pluginMocks.dirs = [dir];
	pluginMocks.manifests.set(dir, { id: "other", mcpServers: { mydocs: { url: "https://example.invalid/x" } } });
	// `docs` must not match `other__mydocs`: the separator is what makes the
	// trailing segment a name rather than an arbitrary suffix.
	expect(await resolveStepMcpServer("docs")).toBeUndefined();
	expect((await resolveStepMcpServer("mydocs"))?.name).toBe("other__mydocs");
});

test("prefers a config entry over a plugin server of the same name", async () => {
	const dir = "/mock-plugins/shadowed";
	pluginMocks.dirs = [dir];
	pluginMocks.manifests.set(dir, {
		id: "shared",
		mcpServers: { docs: { url: "https://from-plugin.invalid/mcp" } },
	});
	config.value = { mcp_servers: { shared__docs: { url: "https://from-config.invalid/mcp" } } };

	const resolved = await resolveStepMcpServer("shared__docs");
	expect(resolved?.declaration.url).toBe("https://from-config.invalid/mcp");
});

test("reports an unknown name as undefined rather than throwing", async () => {
	expect(await resolveStepMcpServer("nothing-here")).toBeUndefined();
});

test("the auth hint prints the bare server name", () => {
	// The 401 path is keyed on the transport's own error type, which is what a
	// real unauthenticated remote server raises.
	const hint = describeMcpStartFailure({
		name: "context7__context7",
		command: "https://mcp.context7.com/mcp",
		error: new StreamableHTTPError(401, "Authentication required."),
	});
	expect(hint).toContain("step mcp login context7, then restart Step.");

	// An unrelated server keeps its own name unchanged.
	expect(bareServerName("figma-mcp")).toBe("figma-mcp");
	expect(bareServerName("context7__context7")).toBe("context7");
	// Only the plugin qualifier is stripped. A declared name may itself contain
	// the separator, and splitting at the last one would mangle it.
	expect(bareServerName("acme__my__service")).toBe("my__service");
});

test("a config.toml http_headers value is sent verbatim, not interpolated", async () => {
	// The documented config surface is a literal string map. Expanding `${...}`
	// here would silently rewrite values that already worked.
	const literal = `Bearer ${placeholder("NOT_SET")}`;
	config.value = {
		mcp_servers: { literal: { url: "https://example.invalid/mcp", http_headers: { Authorization: literal } } },
	};
	const discovered = await discoverStepMcpServers(process.cwd(), false);
	const found = discovered.find((server) => server.name === "literal");
	expect(found?.declaration.http_headers?.Authorization).toBe(literal);
});
