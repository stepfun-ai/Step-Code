import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetSearchCooldowns } from "../src/step/search/scheduler.ts";
import { createSearchWebTool } from "../src/step/search-web-tool.ts";

/**
 * End-to-end scenarios for the tool as a model actually calls it.
 *
 * These drive `createSearchWebTool().execute()` rather than the chain builder,
 * so they cover the wiring between configuration, credential resolution, the
 * ordered chain and rendering.
 */

const originalFetch = globalThis.fetch;

/** A provider answer in the shape the transport expects for each adapter. */
function answerFor(url: string): Response {
	if (url.includes("exa.ai")) {
		return sseResult("Title: Exa hit\nURL: https://exa.example/1\nHighlights:\nexa snippet");
	}
	if (url.includes("firecrawl")) {
		return sseResult(
			JSON.stringify({
				success: true,
				data: { web: [{ url: "https://firecrawl.example/1", title: "FC", description: "fc snippet" }] },
			}),
		);
	}
	if (url.includes("parallel.ai")) {
		return Response.json({
			jsonrpc: "2.0",
			id: 1,
			result: {
				structuredContent: {
					search_id: "s",
					results: [{ url: "https://parallel.example/1", title: "P", excerpts: ["p snippet"] }],
				},
				content: [{ type: "text", text: "{}" }],
			},
		});
	}
	if (url.includes("tinyfish")) {
		return Response.json({
			jsonrpc: "2.0",
			id: 1,
			result: {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							results: [{ url: "https://tinyfish.example/1", title: "T", snippet: "t snippet" }],
						}),
					},
				],
			},
		});
	}
	if (url.includes("tavily")) {
		return Response.json({ results: [{ url: "https://tavily.example/1", title: "TV", content: "tv snippet" }] });
	}
	return new Response("unexpected endpoint", { status: 500 });
}

function sseResult(text: string): Response {
	return new Response(
		`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } })}\n\n`,
		{
			status: 200,
			headers: { "content-type": "text/event-stream" },
		},
	);
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

function textHit(result: { content: Array<{ type: string; text?: string }> }): string | undefined {
	return text(result).match(/\((https:\/\/[^)]+)\)/u)?.[1];
}

/** Record every endpoint the tool contacts, answering the way that provider does. */
function installFetch(fail: (url: string) => Response | undefined = () => undefined): string[] {
	const urls: string[] = [];
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		urls.push(url);
		return fail(url) ?? answerFor(url);
	}) as typeof fetch;
	return urls;
}

beforeEach(() => {
	resetSearchCooldowns();
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("search_web scenarios", () => {
	it("auto without a Step credential uses the free providers only", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-search-scenario-"));
		const urls = installFetch();
		try {
			let stepCalls = 0;
			const tool = createSearchWebTool(
				{ env: {}, authPath: join(root, "missing.json"), random: () => 0.99 },
				async () => {
					stepCalls += 1;
					return { structuredContent: { results: [] } };
				},
			);

			const result = await tool.execute("call", { query: "q" }, undefined, undefined, undefined as never);

			// The paid endpoint cannot succeed without a credential, so it is absent
			// from the chain rather than attempted-and-failed.
			expect(stepCalls).toBe(0);
			expect(urls).toHaveLength(1);
			expect(result.details?.degraded).toBe(true);
			expect(textHit(result)).toBeTruthy();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("auto with a Step credential tries the paid tier first", async () => {
		const urls = installFetch();
		const order: string[] = [];
		const tool = createSearchWebTool({ env: {}, apiKey: "search-key", random: () => 0.99 }, async () => {
			order.push("stepfun");
			return { structuredContent: { results: [{ title: "Paid", url: "https://paid.example/1" }] } };
		});

		const result = await tool.execute("call", { query: "q" }, undefined, undefined, undefined as never);

		expect(order).toEqual(["stepfun"]);
		// A paid answer must not touch a free provider.
		expect(urls).toHaveLength(0);
		expect(result.details?.provider).toBe("stepfun");
		expect(result.details?.degraded).toBe(false);
		expect(textHit(result)).toBe("https://paid.example/1");
	});

	it("falls back to free providers when the paid tier reports an exhausted quota", async () => {
		installFetch();
		const tool = createSearchWebTool({ env: {}, apiKey: "search-key", random: () => 0.99 }, async () => ({
			isError: true,
			content: "quota exceeded for this billing period",
		}));

		const result = await tool.execute("call", { query: "q" }, undefined, undefined, undefined as never);

		expect(result.details?.provider).not.toBe("stepfun");
		expect(result.details?.degraded).toBe(true);
		expect(textHit(result)).toBeTruthy();
	});

	it("falls back when the paid tier is unreachable", async () => {
		installFetch();
		const tool = createSearchWebTool({ env: {}, apiKey: "search-key", random: () => 0.99 }, async () => {
			throw new Error("connect ECONNREFUSED 127.0.0.1:443");
		});

		const result = await tool.execute("call", { query: "q" }, undefined, undefined, undefined as never);
		expect(result.details?.degraded).toBe(true);
	});

	it("pins a configured provider and never falls back to another", async () => {
		const urls = installFetch((url) => (url.includes("exa.ai") ? new Response("gone", { status: 503 }) : undefined));
		const tool = createSearchWebTool({ env: {}, provider: "exa" });

		await expect(tool.execute("call", { query: "q" }, undefined, undefined, undefined as never)).rejects.toThrow(
			/exa/u,
		);
		// Only the pinned provider is contacted, even though four others are healthy.
		expect(urls.every((url) => url.includes("exa.ai"))).toBe(true);
	});

	it("refuses the call when search is configured off", async () => {
		const urls = installFetch();
		const tool = createSearchWebTool({ env: {}, provider: "off" });

		await expect(tool.execute("call", { query: "q" }, undefined, undefined, undefined as never)).rejects.toThrow(
			/disabled/u,
		);
		expect(urls).toHaveLength(0);
	});

	it("treats an unrecognized provider setting as auto", async () => {
		const urls = installFetch();
		const tool = createSearchWebTool({ env: { STEPCODE_SEARCH_PROVIDER: "not-a-provider" }, random: () => 0.99 });

		const result = await tool.execute("call", { query: "q" }, undefined, undefined, undefined as never);

		expect(urls.length).toBeGreaterThan(0);
		expect(textHit(result)).toBeTruthy();
	});

	it("fails with an empty query before contacting anything", async () => {
		const urls = installFetch();
		const tool = createSearchWebTool({ env: {} });

		await expect(tool.execute("call", { query: "   " }, undefined, undefined, undefined as never)).rejects.toThrow(
			/must not be empty/u,
		);
		expect(urls).toHaveLength(0);
	});

	it("walks every free provider and names each failure when all of them fail", async () => {
		const attempted: string[] = [];
		installFetch((url) => {
			attempted.push(url);
			return new Response("upstream exploded", { status: 503 });
		});
		const tool = createSearchWebTool({ env: {}, random: () => 0.99 });

		const error = await tool
			.execute("call", { query: "q" }, undefined, undefined, undefined as never)
			.then(() => undefined)
			.catch((cause: unknown) => cause);

		expect(String(error)).toMatch(/failed after 5 attempt/u);
		expect(attempted).toHaveLength(5);
		// The report must name each provider so a user can tell which one is broken.
		for (const id of ["exa", "firecrawl", "parallel", "tavily", "tinyfish"]) {
			expect(String(error)).toContain(id);
		}
	});

	it("skips a provider that is cooling down on the next call", async () => {
		const attempted: string[] = [];
		const failAll = true;
		installFetch((url) => {
			attempted.push(url);
			return failAll ? new Response("rate limited", { status: 429, headers: { "retry-after": "60" } }) : undefined;
		});
		const tool = createSearchWebTool({ env: {}, random: () => 0.99 });

		await tool.execute("call-1", { query: "q" }, undefined, undefined, undefined as never).catch(() => undefined);
		expect(attempted).toHaveLength(5);

		// Every provider is now cooling down: the next call must not repeat them.
		const again: string[] = [];
		installFetch((url) => {
			again.push(url);
			return undefined;
		});
		const error = await tool
			.execute("call-2", { query: "q" }, undefined, undefined, undefined as never)
			.then(() => undefined)
			.catch((cause: unknown) => cause);

		expect(again).toHaveLength(0);
		expect(String(error)).toContain("cooling down");
	});

	it("accepts a second search after the budget-limited first one", async () => {
		// Two sequential calls must both work: shared state must not leak a
		// failure into a later, independent search.
		installFetch();
		const tool = createSearchWebTool({ env: {}, random: () => 0.99 });

		const first = await tool.execute("c1", { query: "one" }, undefined, undefined, undefined as never);
		const second = await tool.execute("c2", { query: "two" }, undefined, undefined, undefined as never);

		expect(textHit(first)).toBeTruthy();
		expect(textHit(second)).toBeTruthy();
		expect(first.details?.query).toBe("one");
		expect(second.details?.query).toBe("two");
	});
});
