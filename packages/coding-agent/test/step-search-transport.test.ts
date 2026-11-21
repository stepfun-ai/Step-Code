import { afterEach, describe, expect, it } from "vitest";
import { findAdapter } from "../src/step/search/adapters.ts";
import { callSearchProvider } from "../src/step/search/transport.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function sse(body: unknown): string {
	return `event: message\ndata: ${JSON.stringify(body)}\n\n`;
}

function json(body: unknown): string {
	return JSON.stringify(body);
}

const exa = findAdapter("exa")!;

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): string[] {
	const urls: string[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		urls.push(url);
		return handler(url, init ?? {});
	}) as typeof fetch;
	return urls;
}

function searchOnce(options: { allowHandshake?: boolean; signal?: AbortSignal } = {}) {
	return callSearchProvider({
		request: exa.buildRequest("query"),
		parse: exa.parse,
		timeoutMs: 5_000,
		allowHandshake: options.allowHandshake ?? true,
		serverName: "exa",
		...(options.signal ? { signal: options.signal } : {}),
	});
}

describe("search transport", () => {
	it("calls the provider once, statelessly, without a credential", async () => {
		const urls = stubFetch(
			() =>
				new Response(
					sse({
						jsonrpc: "2.0",
						id: 1,
						result: {
							content: [
								{ type: "text", text: "Title: Doc\nURL: https://example.com/doc\nHighlights:\nbody text" },
							],
						},
					}),
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				),
		);

		const attempt = await searchOnce();
		expect(attempt.ok).toBe(true);
		if (!attempt.ok) return;
		expect(attempt.outcome.hits[0]).toMatchObject({ url: "https://example.com/doc", title: "Doc" });
		// One POST: no initialize, no tools/list.
		expect(urls).toEqual([exa.endpoint]);
	});

	it("sends a user-agent and no authorization header", async () => {
		let headers: Record<string, string> = {};
		stubFetch((_url, init) => {
			headers = (init.headers ?? {}) as Record<string, string>;
			return new Response(sse({ jsonrpc: "2.0", id: 1, result: { content: [] } }), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});

		await searchOnce();
		const names = Object.keys(headers).map((name) => name.toLowerCase());
		expect(names).toContain("user-agent");
		expect(names).not.toContain("authorization");
	});

	it("reads a provider error delivered inside a 200 response", async () => {
		stubFetch(
			() =>
				new Response(
					sse({
						jsonrpc: "2.0",
						id: 1,
						result: {
							isError: true,
							content: [{ type: "text", text: "You reached your daily limit of free credits." }],
						},
					}),
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				),
		);

		const attempt = await searchOnce();
		// A 200 must not be reported as "no results": the chain has to advance.
		expect(attempt.ok).toBe(false);
		if (attempt.ok) return;
		expect(attempt.failure.kind).toBe("quota");
	});

	it("retries through a handshake when the provider refuses a stateless call", async () => {
		const urls = stubFetch(() =>
			Response.json(
				{ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } },
				{ status: 404 },
			),
		);

		const attempt = await searchOnce();
		// The SDK client cannot reach the stubbed endpoint either, so this ends as a
		// network failure, but the important part is that a second call was made.
		expect(attempt.ok).toBe(false);
		expect(urls.length).toBeGreaterThan(1);
	});

	it("does not retry a rejected credential", async () => {
		const urls = stubFetch(
			() =>
				new Response(
					sse({
						jsonrpc: "2.0",
						id: 1,
						result: { isError: true, content: [{ type: "text", text: "Unauthorized: invalid API key" }] },
					}),
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				),
		);

		const attempt = await searchOnce();
		expect(attempt.ok).toBe(false);
		if (attempt.ok) return;
		expect(attempt.failure.kind).toBe("auth");
		// One attempt only: retrying a bad credential would double the latency.
		expect(urls.length).toBe(1);
	});

	it("reports a caller cancellation as cancelled, not as a provider outage", async () => {
		const controller = new AbortController();
		stubFetch(() => {
			controller.abort();
			return Promise.reject(new DOMException("This operation was aborted", "AbortError"));
		});

		const attempt = await searchOnce({ signal: controller.signal });
		expect(attempt.ok).toBe(false);
		if (attempt.ok) return;
		expect(attempt.failure.kind).toBe("cancelled");
	});

	it("rejects an oversized response instead of buffering it", async () => {
		stubFetch(
			() =>
				new Response(
					json({
						jsonrpc: "2.0",
						id: 1,
						result: { content: [{ type: "text", text: "x".repeat(2 * 1024 * 1024) }] },
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
		);

		const attempt = await searchOnce();
		expect(attempt.ok).toBe(false);
		if (attempt.ok) return;
		expect(attempt.failure.kind).toBe("parse");
		expect(attempt.failure.detail).toContain("exceeded");
	});

	it("returns real hits from a handshake retry, whose content arrives as one string", async () => {
		// The SDK client joins content blocks into a single string. Handing that
		// straight to an adapter parses as "no results" and ends the chain on a
		// false empty answer, so the transport must rebuild the block list first.
		let statelessRefused = false;
		stubFetch((_url, init) => {
			// The SDK also opens a GET stream; only POST bodies carry a JSON-RPC method.
			const body = init.body ? (JSON.parse(String(init.body)) as { id?: number; method?: string }) : undefined;
			if (!body?.method) return new Response(null, { status: 202 });
			if (!statelessRefused) {
				statelessRefused = true;
				return Response.json(
					{ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } },
					{ status: 404 },
				);
			}
			// The SDK needs a session id from initialize before it will call a tool.
			const headers = { "content-type": "application/json", "mcp-session-id": "test-session" };
			switch (body.method) {
				case "initialize":
					return Response.json(
						{
							jsonrpc: "2.0",
							id: body.id ?? 1,
							result: {
								protocolVersion: "2025-06-18",
								capabilities: { tools: {} },
								serverInfo: { name: "exa", version: "test" },
							},
						},
						{ headers },
					);
				case "tools/list":
					return Response.json(
						{
							jsonrpc: "2.0",
							id: body.id ?? 2,
							result: {
								tools: [
									{
										name: "web_search_exa",
										inputSchema: { type: "object", properties: { query: { type: "string" } } },
									},
								],
							},
						},
						{ headers },
					);
				case "tools/call":
					return Response.json(
						{
							jsonrpc: "2.0",
							id: body.id ?? 3,
							result: {
								content: [
									{
										type: "text",
										text: "Title: Retried\nURL: https://example.com/retried\nHighlights:\nbody",
									},
								],
							},
						},
						{ headers },
					);
				default:
					return new Response(null, { status: 202, headers: { "mcp-session-id": "test-session" } });
			}
		});

		const attempt = await searchOnce();
		expect(attempt.ok).toBe(true);
		if (!attempt.ok) return;
		expect(attempt.outcome.hits[0]).toMatchObject({ url: "https://example.com/retried", title: "Retried" });
	});

	it("posts Tavily's search body and parses its plain JSON results", async () => {
		const tavily = findAdapter("tavily")!;
		let body: unknown;
		let headers: Record<string, string> = {};
		stubFetch((_url, init) => {
			body = JSON.parse(String(init.body));
			headers = (init.headers ?? {}) as Record<string, string>;
			return Response.json({
				results: [
					{ url: "https://example.com/t", title: "T", content: "tavily snippet" },
					{ url: "https://example.com/u", title: "U", content: "second" },
				],
			});
		});

		const attempt = await callSearchProvider({
			request: tavily.buildRequest("query"),
			parse: tavily.parse,
			timeoutMs: 5_000,
			allowHandshake: false,
			serverName: "tavily",
		});

		expect(attempt.ok).toBe(true);
		if (!attempt.ok) return;
		expect(attempt.outcome.hits[0]).toMatchObject({ url: "https://example.com/t", snippet: "tavily snippet" });
		expect(body).toMatchObject({ query: "query", search_depth: "basic", max_results: 10 });
		// The access-mode header is what keeps Tavily keyless; without it the call 401s.
		expect(headers["X-Tavily-Access-Mode"]).toBe("keyless");
	});

	it("parses a plain JSON response as well as an event stream", async () => {
		stubFetch(
			() =>
				new Response(
					json({
						jsonrpc: "2.0",
						id: 1,
						result: {
							content: [{ type: "text", text: "Title: Plain\nURL: https://example.com/plain\nHighlights:\nx" }],
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);

		const attempt = await searchOnce();
		expect(attempt.ok).toBe(true);
		if (!attempt.ok) return;
		expect(attempt.outcome.hits[0]?.url).toBe("https://example.com/plain");
	});
});
