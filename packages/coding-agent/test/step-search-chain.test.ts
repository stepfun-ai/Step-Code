import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { findAdapter, KEYLESS_ADAPTERS } from "../src/step/search/adapters.ts";
import { classifyFailure, parseRetryAfter } from "../src/step/search/errors.ts";
import { buildSearchChain } from "../src/step/search/routing.ts";
import { resetSearchCooldowns, runSearchChain } from "../src/step/search/scheduler.ts";
import type { SearchAttempt, SearchCandidate } from "../src/step/search/types.ts";

const FIXTURES = join(import.meta.dirname, "fixtures", "search");

function fixture(name: string): unknown {
	const recorded = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as {
		result?: unknown;
	};
	// Fixtures keep the whole recorded response; adapters receive the payload the
	// transport extracted from the JSON-RPC envelope.
	return recorded.result ?? recorded;
}

/** A random source that leaves the adapter order untouched. */
const identityRandom = () => 0;

function candidates(entries: readonly string[]): SearchCandidate[] {
	return entries.map((id) => {
		const adapter = findAdapter(id);
		if (!adapter) throw new Error(`unknown adapter ${id}`);
		return {
			id: adapter.id,
			tier: "keyless" as const,
			endpoint: adapter.endpoint,
			toolName: adapter.toolName,
			transport: adapter.transport,
			allowHandshake: true,
			...(adapter.headers ? { headers: adapter.headers } : {}),
		};
	});
}

describe("search adapters", () => {
	it.each(["exa", "firecrawl", "parallel", "tinyfish", "tavily"] as const)(
		"normalizes a recorded %s response into hits",
		(name) => {
			const adapter = findAdapter(name);
			expect(adapter).toBeDefined();
			const outcome = adapter!.parse(fixture(name));
			expect(outcome.hits.length).toBeGreaterThan(0);
			for (const hit of outcome.hits) {
				expect(hit.url).toMatch(/^https?:\/\//u);
				expect(hit.url).not.toContain("…");
			}
			expect(outcome.hits.length).toBeLessThanOrEqual(10);
		},
	);

	it("reads Firecrawl structured content before the text block", () => {
		const outcome = findAdapter("firecrawl")!.parse(fixture("firecrawl"));
		expect(outcome.hits[0]?.title).toBeTruthy();
		expect(outcome.hits[0]?.snippet).toBeTruthy();
	});

	it("keeps Exa's published date and drops the N/A placeholder", () => {
		const exa = findAdapter("exa")!;
		const withDate = exa.parse({
			content: [
				{
					type: "text",
					text: "Title: Dated\nURL: https://example.com/a\nPublished: 2024-05-01T00:00:00Z\nHighlights:\nsome text",
				},
			],
		});
		expect(withDate.hits[0]?.publishedAtMs).toBe(Date.parse("2024-05-01T00:00:00Z"));

		const withoutDate = exa.parse({
			content: [{ type: "text", text: "Title: Undated\nURL: https://example.com/b\nPublished: N/A" }],
		});
		expect(withoutDate.hits[0]).not.toHaveProperty("publishedAtMs");
	});

	it("detects Firecrawl's keyless quota message inside a 200 response", () => {
		const outcome = findAdapter("firecrawl")!.parse({
			structuredContent: { success: true, data: { web: [] } },
			content: [{ type: "text", text: "You have reached your daily limit of free credits." }],
		});
		// A quota message without hits must not look like an empty result set.
		expect(outcome.hits).toHaveLength(0);
		expect(outcome.text).toContain("daily limit");
	});

	it("requests ten results from every provider that accepts a count", () => {
		const exa = findAdapter("exa")!.buildRequest("q");
		expect(exa.args).toEqual({ query: "q", numResults: 10 });
		expect(findAdapter("firecrawl")!.buildRequest("q").args).toEqual({ query: "q", limit: 10 });
		expect(findAdapter("parallel")!.buildRequest("q").args).toEqual({
			objective: "q",
			search_queries: ["q"],
		});
		// Tavily is the only plain-HTTP provider; its body carries the search mode.
		const tavily = findAdapter("tavily")!.buildRequest("q");
		expect(tavily.transport).toBe("http");
		expect(tavily.args).toEqual({
			query: "q",
			search_depth: "basic",
			chunks_per_source: 3,
			max_results: 10,
		});
	});

	it("sends no credential to any free provider", () => {
		for (const adapter of KEYLESS_ADAPTERS) {
			const request = adapter.buildRequest("q");
			const headerNames = Object.keys(request.headers ?? {}).map((name) => name.toLowerCase());
			expect(headerNames).not.toContain("authorization");
			expect(headerNames).not.toContain("x-api-key");
		}
	});
});

describe("search failure classification", () => {
	it("classifies a 200 response carrying an error body", () => {
		expect(classifyFailure({ text: "web_search_exa error (401): Invalid API key", isError: true }).kind).toBe("auth");
		expect(
			classifyFailure({ text: "You reached the daily keyless limit. daily cap", status: 200, isError: true }).kind,
		).toBe("quota");
		expect(classifyFailure({ text: "rate limit exceeded", status: 200, isError: true }).kind).toBe("rate_limit");
	});

	it("recognizes every spelling of a daily ceiling", () => {
		// Observed live: Tavily answers 429 with `daily_cap_reached`.
		expect(classifyFailure({ status: 429, text: '{"error":{"code":"daily_cap_reached"}}' }).kind).toBe("quota");
		expect(classifyFailure({ text: "You reached the daily keyless Tavily limit.", isError: true }).kind).toBe(
			"quota",
		);
		expect(classifyFailure({ text: "daily limit reached", isError: true }).kind).toBe("quota");
		expect(classifyFailure({ text: "quota exceeded", isError: true }).kind).toBe("quota");
	});

	it("classifies by status when the body says nothing useful", () => {
		expect(classifyFailure({ status: 401, text: "" }).kind).toBe("auth");
		expect(classifyFailure({ status: 402, text: "" }).kind).toBe("quota");
		expect(classifyFailure({ status: 429, text: "" }).kind).toBe("rate_limit");
		expect(classifyFailure({ status: 503, text: "" }).kind).toBe("server");
	});

	it("treats an unrecognized failure as unknown but keeps the provider text", () => {
		const failure = classifyFailure({ status: 418, text: "teapot" });
		expect(failure.kind).toBe("unknown");
		expect(failure.detail).toBe("teapot");
	});

	it("reports cancellation as cancelled, never as a provider outage", () => {
		const failure = classifyFailure({ cancelled: true, networkError: "This operation was aborted" });
		expect(failure.kind).toBe("cancelled");
	});

	it("parses both Retry-After forms", () => {
		expect(parseRetryAfter("30")).toBe(30_000);
		const at = Date.parse("2030-01-01T00:00:00Z");
		expect(parseRetryAfter("2030-01-01T00:00:00Z", at - 5_000)).toBe(5_000);
		expect(parseRetryAfter(undefined)).toBeUndefined();
	});
});

describe("search candidate chain", () => {
	it("puts the paid tier first when a Step credential resolves", () => {
		const chain = buildSearchChain({
			mode: "auto",
			hasStepCredential: true,
			stepEndpoint: "https://api.stepfun.com/v1/mcp/web_search/mcp",
			random: identityRandom,
		});
		expect(chain.candidates[0]).toMatchObject({ id: "stepfun", tier: "stepfun" });
		expect(chain.candidates).toHaveLength(6);
	});

	it("omits the paid tier entirely without a credential", () => {
		const chain = buildSearchChain({
			mode: "auto",
			hasStepCredential: false,
			stepEndpoint: "https://api.stepfun.com/v1/mcp/web_search/mcp",
			random: identityRandom,
		});
		// Not "present then fails": the candidate is absent, so no doomed call is made.
		expect(chain.candidates.map((entry) => entry.id)).not.toContain("stepfun");
		expect(chain.candidates).toHaveLength(5);
		expect(chain.skippedPaidTier).toBe("no-step-credential");
	});

	it("shuffles the free providers so traffic does not always hit the first one", () => {
		const first = new Set<string>();
		for (let seed = 0; seed < 40; seed += 1) {
			const chain = buildSearchChain({
				mode: "auto",
				hasStepCredential: false,
				stepEndpoint: "https://api.stepfun.com/v1/mcp/web_search/mcp",
				random: () => ((seed * 37) % 101) / 101,
			});
			first.add(chain.candidates[0]!.id);
		}
		expect(first.size).toBeGreaterThan(1);
	});

	it("keeps every free provider in a shuffled chain", () => {
		const chain = buildSearchChain({
			mode: "auto",
			hasStepCredential: false,
			stepEndpoint: "https://api.stepfun.com/v1/mcp/web_search/mcp",
			random: () => 0.42,
		});
		expect(new Set(chain.candidates.map((entry) => entry.id))).toEqual(
			new Set(KEYLESS_ADAPTERS.map((adapter) => adapter.id)),
		);
	});

	it("builds a single-candidate chain for an explicit provider", () => {
		const chain = buildSearchChain({ mode: "firecrawl", hasStepCredential: true, stepEndpoint: "x" });
		expect(chain.candidates.map((entry) => entry.id)).toEqual(["firecrawl"]);
	});

	it("disables search when configured off", () => {
		expect(
			buildSearchChain({
				mode: "off",
				hasStepCredential: true,
				stepEndpoint: "https://api.stepfun.com/v1/mcp/web_search/mcp",
			}).disabled,
		).toBe(true);
	});
});

describe("search chain scheduling", () => {
	beforeEach(() => {
		resetSearchCooldowns();
	});

	it("falls through to the next provider when one fails", async () => {
		const tried: string[] = [];
		const result = await runSearchChain({
			chain: { candidates: candidates(["exa", "firecrawl"]) },
			query: "q",
			invoke: async (candidate) => {
				tried.push(candidate.id);
				if (candidate.id === "exa") {
					return { ok: false, failure: { kind: "quota", detail: "daily limit" } } satisfies SearchAttempt;
				}
				return { ok: true, outcome: { hits: [{ url: "https://example.com" }] } } satisfies SearchAttempt;
			},
		});
		expect(tried).toEqual(["exa", "firecrawl"]);
		expect(result.provider).toBe("firecrawl");
		expect(result.degraded).toBe(true);
	});

	it("reports a paid-tier answer as not degraded", async () => {
		const result = await runSearchChain({
			chain: {
				candidates: [
					{
						id: "stepfun",
						tier: "stepfun",
						endpoint: "https://api.stepfun.com/v1/mcp/web_search/mcp",
						toolName: "web_search",
						transport: "mcp",
						allowHandshake: false,
					},
				],
			},
			query: "q",
			invoke: async () => ({ ok: true, outcome: { hits: [{ url: "https://example.com" }] } }),
		});
		expect(result.degraded).toBe(false);
		expect(result.tier).toBe("stepfun");
	});

	it("stops immediately when the caller cancels", async () => {
		const controller = new AbortController();
		let calls = 0;
		await expect(
			runSearchChain({
				chain: { candidates: candidates(["exa", "firecrawl", "tavily"]) },
				query: "q",
				signal: controller.signal,
				invoke: async () => {
					calls += 1;
					controller.abort();
					return { ok: false, failure: { kind: "cancelled", detail: "cancelled" } };
				},
			}),
		).rejects.toThrow(/cancelled/u);
		// A cancelled kind must not advance: no other provider may be contacted.
		expect(calls).toBe(1);
	});

	it("skips a candidate that is cooling down instead of calling it again", async () => {
		const chain = { candidates: candidates(["exa", "firecrawl"]) };
		await expect(
			runSearchChain({
				chain,
				query: "q",
				invoke: async () => ({ ok: false, failure: { kind: "rate_limit", detail: "slow down" } }),
			}),
		).rejects.toThrow(/failed after 2/u);

		const tried: string[] = [];
		const error = await runSearchChain({
			chain,
			query: "q",
			invoke: async (candidate) => {
				tried.push(candidate.id);
				return { ok: true, outcome: { hits: [{ url: "https://example.com" }] } };
			},
		}).catch((cause: unknown) => cause);
		// Both providers are cooling down; the second call must not repeat them.
		expect(tried).toEqual([]);
		expect(String(error)).toContain("cooling down");
		expect(String(error)).toMatch(/retry in about \d+s/u);
	});

	it("lists every attempt and the skipped providers when nothing works", async () => {
		const error = await runSearchChain({
			chain: { candidates: candidates(["exa", "firecrawl"]) },
			query: "q",
			invoke: async (candidate) => ({
				ok: false,
				failure: { kind: "server", detail: `${candidate.id} is down` },
			}),
		}).catch((cause: unknown) => cause);
		expect(String(error)).toContain("exa");
		expect(String(error)).toContain("firecrawl");
		expect(String(error)).toContain("is down");
	});

	it("gives up when the shared budget is exhausted", async () => {
		let clock = 0;
		const tried: string[] = [];
		const error = await runSearchChain({
			chain: { candidates: candidates(["exa", "firecrawl", "tavily"]) },
			query: "q",
			budgetMs: 5_000,
			now: () => clock,
			invoke: async (candidate) => {
				tried.push(candidate.id);
				clock += 4_000;
				return { ok: false, failure: { kind: "network", detail: "timeout" } };
			},
		}).catch((cause: unknown) => cause);
		// 4s elapses on the first attempt, leaving 1s: below the 3s minimum, so the
		// remaining providers are never contacted.
		expect(tried).toEqual(["exa"]);
		expect(String(error)).toContain("budget");
	});
});
