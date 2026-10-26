import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeStepMcpPool } from "@step-harness/coding-agent";
import { type WebEvent, WebSessionStore } from "../src/runtime.ts";

async function listen(server: Server): Promise<string> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("fixture did not bind a port");
	return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** A Streamable HTTP MCP server whose `tools/list` answers only after `release`. */
async function startSlowMcp(): Promise<{ url: string; release: () => void; listed: () => boolean; stop(): Promise<void> }> {
	let release = () => {};
	const ready = new Promise<void>((resolve) => {
		release = resolve;
	});
	let listed = false;
	const server = createServer(async (request, response) => {
		if (request.method !== "POST") return response.writeHead(405).end();
		let raw = "";
		for await (const chunk of request) raw += chunk;
		const message = JSON.parse(raw) as { id?: number; method: string };
		if (message.id === undefined) return response.writeHead(202).end();
		let result: unknown;
		if (message.method === "initialize") {
			result = {
				protocolVersion: "2025-03-26",
				capabilities: { tools: {} },
				serverInfo: { name: "slow-fixture", version: "1" },
			};
		} else {
			listed = true;
			await ready;
			result = { tools: [{ name: "probe", description: "Fixture tool", inputSchema: { type: "object", properties: {} } }] };
		}
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
	});
	const origin = await listen(server);
	return {
		url: `${origin}/mcp`,
		release: () => release(),
		listed: () => listed,
		stop: async () => {
			release();
			await close(server);
		},
	};
}

/** An OpenAI-compatible endpoint that records each request's tool names and answers at once. */
async function startProvider(): Promise<{ baseUrl: string; toolNames: string[][]; stop(): Promise<void> }> {
	const toolNames: string[][] = [];
	const server = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		if (url.pathname.endsWith("/models")) {
			response.writeHead(200, { "content-type": "application/json" });
			return response.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
		}
		let raw = "";
		for await (const chunk of request) raw += chunk;
		const body = JSON.parse(raw) as { tools?: Array<{ function?: { name?: string } }> };
		toolNames.push((body.tools ?? []).map((tool) => tool.function?.name ?? ""));
		response.writeHead(200, { "content-type": "text/event-stream" });
		for (const [delta, finish] of [
			[{ content: "ok" }, null],
			[{}, "stop"],
		] as const)
			response.write(
				`data: ${JSON.stringify({
					id: "fixture",
					object: "chat.completion.chunk",
					model: "fixture-model",
					choices: [{ index: 0, delta, finish_reason: finish }],
				})}\n\n`,
			);
		response.end("data: [DONE]\n\n");
	});
	const origin = await listen(server);
	return { baseUrl: `${origin}/v1`, toolNames, stop: () => close(server) };
}

async function waitFor(check: () => boolean, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("condition did not become true before the deadline");
}

test("the first message waits for MCP startup, so its request already carries the MCP tools", { timeout: 60_000 }, async () => {
	const base = await mkdtemp(join(tmpdir(), "stepcode-web-extension-startup-"));
	const mcp = await startSlowMcp();
	const provider = await startProvider();
	const previous = {
		agentDir: process.env.STEP_CODING_AGENT_DIR,
		authPath: process.env.STEPCODE_AUTH_PATH,
		apiKey: process.env.STEP_API_KEY,
		loginState: process.env.STEPCODE_LOGIN_STATE_PATH,
		storageRoot: process.env.STEPCODE_STORAGE_ROOT_DIR,
	};
	process.env.STEP_CODING_AGENT_DIR = join(base, "agent");
	process.env.STEPCODE_AUTH_PATH = join(base, "auth.json");
	delete process.env.STEP_API_KEY;
	delete process.env.STEPCODE_LOGIN_STATE_PATH;
	// Plugins (and the built-in StepPage) install under the storage root: keep them out of the developer's home.
	process.env.STEPCODE_STORAGE_ROOT_DIR = join(base, "storage");
	await mkdir(join(base, "agent"), { recursive: true });
	await writeFile(
		join(base, "models.json"),
		`${JSON.stringify({
			providers: {
				mygw: {
					baseUrl: provider.baseUrl,
					api: "openai-completions",
					name: "Fixture",
					models: [{ id: "fixture-model" }],
				},
			},
		})}\n`,
	);
	await writeFile(join(base, "auth.json"), `${JSON.stringify({ mygw: { type: "api_key", key: "test-key" } })}\n`);
	await writeFile(
		join(base, "config.toml"),
		`defaultProvider = "mygw"\ndefaultModel = "fixture-model"\n\n[mcp_servers.slow]\nurl = "${mcp.url}"\n`,
	);
	const store = new WebSessionStore();
	try {
		const session = await store.create(base);
		const events: WebEvent[] = [];
		session.subscribe((event) => events.push(event));
		const sending = session.send("first message");
		await waitFor(() => mcp.listed());
		// MCP is still connecting: the message waits, the session reports a turn,
		// and a second message queues behind the first instead of racing it.
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(provider.toolNames.length, 0, "no model request may leave before MCP startup settles");
		assert.equal(session.isBusy(), true);
		session.enqueue({ text: "second message", attachments: [], files: [] });
		assert.equal(session.queueState().queued.length, 1);

		mcp.release();
		await sending;
		// The session title is generated by a separate request without tools; only turn requests carry them.
		const turns = () => provider.toolNames.filter((names) => names.length > 0);
		assert.ok(turns()[0]?.includes("slow__probe"), "the first request lists the MCP tool");
		await waitFor(() => turns().length === 2);
		assert.deepEqual(turns()[1], turns()[0], "the queued turn sees the same catalog");
		assert.ok(events.some((event) => event.type === "status" && event.status === "running"));
	} finally {
		await store.close();
		await closeStepMcpPool();
		await mcp.stop();
		await provider.stop();
		await rm(base, { recursive: true, force: true });
		process.env.STEP_CODING_AGENT_DIR = previous.agentDir;
		process.env.STEPCODE_AUTH_PATH = previous.authPath;
		if (previous.apiKey === undefined) delete process.env.STEP_API_KEY;
		else process.env.STEP_API_KEY = previous.apiKey;
		if (previous.loginState === undefined) delete process.env.STEPCODE_LOGIN_STATE_PATH;
		else process.env.STEPCODE_LOGIN_STATE_PATH = previous.loginState;
		if (previous.storageRoot === undefined) delete process.env.STEPCODE_STORAGE_ROOT_DIR;
		else process.env.STEPCODE_STORAGE_ROOT_DIR = previous.storageRoot;
	}
});
