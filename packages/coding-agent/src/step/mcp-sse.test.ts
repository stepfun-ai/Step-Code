import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { afterEach, expect, test, vi } from "vitest";
import { connectStepMcpServer } from "./mcp.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("connects to an ACP SSE server with client headers on both HTTP legs", async () => {
	const transports = new Map<string, SSEServerTransport>();
	const requests: Array<{ method?: string; accept?: string; contentType?: string }> = [];
	const mcpServer = new McpServer({ name: "sse-test", version: "1.0.0" });
	mcpServer.registerTool("ping", { description: "Return pong" }, async () => ({
		content: [{ type: "text", text: "pong" }],
	}));

	const authorize = (req: IncomingMessage, res: ServerResponse): boolean => {
		if (req.headers["x-acp-key"] === "secret") return true;
		res.writeHead(401).end("missing client header");
		return false;
	};
	const httpServer = createServer((req, res) => {
		void (async () => {
			if (!authorize(req, res)) return;
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			if (req.method === "GET" && url.pathname === "/sse") {
				if (!req.headers.accept?.includes("text/event-stream")) {
					res.writeHead(406).end("SSE Accept header was overwritten");
					return;
				}
				requests.push({ method: req.method, accept: req.headers.accept });
				const transport = new SSEServerTransport("/messages", res);
				transports.set(transport.sessionId, transport);
				transport.onclose = () => transports.delete(transport.sessionId);
				await mcpServer.connect(transport);
				return;
			}
			if (req.method === "POST" && url.pathname === "/messages") {
				if (!req.headers["content-type"]?.includes("application/json")) {
					res.writeHead(415).end("JSON Content-Type header was overwritten");
					return;
				}
				const transport = transports.get(url.searchParams.get("sessionId") ?? "");
				if (!transport) {
					res.writeHead(404).end("unknown session");
					return;
				}
				requests.push({ method: req.method, contentType: req.headers["content-type"] });
				await transport.handlePostMessage(req, res);
				return;
			}
			res.writeHead(404).end();
		})().catch((error: unknown) => {
			if (!res.headersSent) res.writeHead(500).end(String(error));
			else res.end();
		});
	});
	await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
	cleanups.push(async () => {
		await mcpServer.close();
		await new Promise<void>((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));
	});
	const address = httpServer.address() as AddressInfo;

	const connection = await connectStepMcpServer({
		name: "legacy",
		declaration: {
			url: `http://127.0.0.1:${address.port}/sse`,
			transport: "sse",
			http_headers: { "X-ACP-Key": "secret" },
		},
	});
	cleanups.push(async () => {
		await connection.client.close();
	});

	expect(connection.tools.map((tool) => tool.name)).toEqual(["ping"]);
	expect(requests.some((request) => request.method === "GET")).toBe(true);
	expect(requests.some((request) => request.method === "POST")).toBe(true);
});
