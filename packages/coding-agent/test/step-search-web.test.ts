import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { resetSearchCooldowns } from "../src/step/search/scheduler.ts";
import {
	createSearchWebTool,
	resolveSearchWebApiKey,
	resolveSearchWebServerUrl,
	type SearchWebInvocation,
} from "../src/step/search-web-tool.ts";

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

describe("Step search_web tool", () => {
	beforeEach(() => {
		// Cooldowns are process-wide so a new session does not repeat a call that
		// already failed; tests need a clean slate per case.
		resetSearchCooldowns();
	});

	it("resolves endpoint origins and preserves explicit paths", () => {
		expect(resolveSearchWebServerUrl("https://search.example.com")).toBe(
			"https://search.example.com/v1/mcp/web_search/mcp",
		);
		expect(resolveSearchWebServerUrl("https://search.example.com/custom/mcp/")).toBe(
			"https://search.example.com/custom/mcp",
		);
		expect(
			resolveSearchWebServerUrl(undefined, {
				STEPCODE_SEARCH_WEB_MCP_URL: "https://first.example.com",
			}),
		).toBe("https://first.example.com/v1/mcp/web_search/mcp");
		expect(resolveSearchWebServerUrl(undefined, {}, "step_plan")).toBe(
			"https://api.stepfun.com/step_plan/v1/mcp/web_search/mcp",
		);
		expect(resolveSearchWebServerUrl(undefined, {}, "platform_cn")).toBe(
			"https://api.stepfun.com/v1/mcp/web_search/mcp",
		);
		expect(resolveSearchWebServerUrl(undefined, {}, "platform_oversea")).toBe(
			"https://api.stepfun.ai/v1/mcp/web_search/mcp",
		);
		expect(resolveSearchWebServerUrl(undefined, {}, "step_plan_oversea")).toBe(
			"https://api.stepfun.ai/step_plan/v1/mcp/web_search/mcp",
		);
		expect(resolveSearchWebServerUrl(undefined, {}, "unknown")).toBe("https://api.stepfun.com/v1/mcp/web_search/mcp");
	});

	it("completes an origin-only override with the path of the profile's own endpoint", () => {
		// A host-only override must not silently move a plan login onto the
		// platform path, which would bill the searches to the API account.
		expect(resolveSearchWebServerUrl("https://proxy.example.com", {}, "step_plan")).toBe(
			"https://proxy.example.com/step_plan/v1/mcp/web_search/mcp",
		);
		expect(
			resolveSearchWebServerUrl(
				undefined,
				{ STEPCODE_SEARCH_WEB_MCP_URL: "https://proxy.example.com/" },
				"step_plan_oversea",
			),
		).toBe("https://proxy.example.com/step_plan/v1/mcp/web_search/mcp");
		expect(resolveSearchWebServerUrl("https://proxy.example.com", {}, "platform_cn")).toBe(
			"https://proxy.example.com/v1/mcp/web_search/mcp",
		);
		// A full override still wins outright, path included.
		expect(resolveSearchWebServerUrl("https://proxy.example.com/custom/mcp", {}, "step_plan")).toBe(
			"https://proxy.example.com/custom/mcp",
		);
	});

	it("keeps credentials that carry no login profile on the platform endpoint", async () => {
		// `--api-key` and `STEPCODE_SEARCH_API_KEY` persist without a profile.
		// Step Plan credentials cannot reach this path: they only come from
		// `/login`, which always records one. Routing these to the plan endpoint
		// would spend a stranger's plan quota on a platform key.
		const root = await mkdtemp(join(tmpdir(), "step-search-web-no-profile-"));
		const authPath = join(root, "auth.json");
		try {
			await writeFile(authPath, JSON.stringify({ step: { type: "api_key", key: "stored-key" } }), "utf8");
			let serverUrl = "";
			const tool = createSearchWebTool({ env: {}, authPath }, async (input) => {
				serverUrl = input.serverUrl;
				return { structuredContent: { results: [] } };
			});

			await tool.execute("no-profile-call", { query: "query" }, undefined, undefined, undefined as never);
			expect(serverUrl).toBe("https://api.stepfun.com/v1/mcp/web_search/mcp");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("prefers search credentials, then auth.json, and ignores the model credential", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-search-web-"));
		const authPath = join(root, "auth.json");
		try {
			await writeFile(authPath, JSON.stringify({ step: { type: "oauth", access: "stored-key" } }), "utf8");
			expect(
				resolveSearchWebApiKey({
					apiKey: "explicit-key",
					env: { STEPCODE_SEARCH_API_KEY: "search-key" },
					authPath,
				}),
			).toBe("explicit-key");
			expect(
				resolveSearchWebApiKey({
					env: { STEPCODE_SEARCH_API_KEY: "search-key", STEP_API_KEY: "model-key" },
					authPath,
				}),
			).toBe("search-key");
			// STEP_API_KEY targets the model gateway injected by StepCode, not the fixed
			// search endpoint, so it must never be used as the search bearer token.
			expect(resolveSearchWebApiKey({ env: { STEP_API_KEY: "model-key" }, authPath })).toBe("stored-key");
			expect(resolveSearchWebApiKey({ env: {}, authPath })).toBe("stored-key");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("calls the remote tool with a bearer header and compacts results", async () => {
		const calls: SearchWebInvocation[] = [];
		const tool = createSearchWebTool(
			{ url: "https://search.example.com", apiKey: "search-key", env: {}, provider: "step" },
			async (input) => {
				calls.push(input);
				return {
					structuredContent: {
						results: [
							{
								position: 1,
								title: "Example result",
								url: "https://example.com",
								snippet: "short snippet",
								content: "full page content must not reach the model",
							},
							{
								position: 2,
								title: "Long result",
								url: "https://example.org",
								snippet: "x".repeat(450),
							},
						],
					},
				};
			},
		);

		const result = await tool.execute(
			"call-1",
			{ query: "  current information  " },
			undefined,
			undefined,
			undefined as never,
		);
		const call = calls[0];
		expect(call).toMatchObject({
			serverName: "stepsearch",
			serverUrl: "https://search.example.com/v1/mcp/web_search/mcp",
			toolName: "web_search",
			arguments: { query: "current information", n: 10 },
			headers: { Authorization: "Bearer search-key" },
		});
		expect(text(result)).toContain("[Example result](https://example.com)");
		expect(text(result)).toContain("short snippet");
		expect(text(result)).not.toContain("full page content must not reach the model");
		expect(text(result)).not.toContain("x".repeat(401));
		expect(JSON.stringify(result)).not.toContain("search-key");
		expect(result.details).toEqual({
			query: "current information",
			resultCount: 2,
			urls: ["https://example.com", "https://example.org"],
			provider: "stepfun",
			degraded: false,
		});
	});

	it("selects the endpoint of the persisted login profile and never bills plan searches to the platform", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-search-web-profile-"));
		const authPath = join(root, "auth.json");
		const expectedByProfile = {
			step_plan: "https://api.stepfun.com/step_plan/v1/mcp/web_search/mcp",
			step_plan_oversea: "https://api.stepfun.ai/step_plan/v1/mcp/web_search/mcp",
			platform_cn: "https://api.stepfun.com/v1/mcp/web_search/mcp",
			platform_oversea: "https://api.stepfun.ai/v1/mcp/web_search/mcp",
			// Logins written before profiles existed; `readStepLoginProfile` maps
			// them to `step_plan`, so they are plan users and bill the plan pool.
			step: "https://api.stepfun.com/step_plan/v1/mcp/web_search/mcp",
		};
		try {
			for (const [profile, expected] of Object.entries(expectedByProfile)) {
				await writeFile(
					authPath,
					JSON.stringify({ step: { type: "oauth", access: "search-key", profile } }),
					"utf8",
				);
				let serverUrl = "";
				const tool = createSearchWebTool({ env: {}, authPath, provider: "step" }, async (input) => {
					serverUrl = input.serverUrl;
					return { structuredContent: { results: [] } };
				});

				await tool.execute("profile-call", { query: "query" }, undefined, undefined, undefined as never);
				expect(serverUrl, `profile ${profile}`).toBe(expected);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("forwards the caller signal to the remote invoker", async () => {
		const controller = new AbortController();
		let receivedSignal: AbortSignal | undefined;
		const tool = createSearchWebTool({ apiKey: "search-key", env: {}, provider: "step" }, async (input) => {
			receivedSignal = input.signal;
			// Abort while the call is in flight; the invoker still sees the caller's
			// own signal, not a copy.
			controller.abort();
			throw new Error("aborted");
		});

		await expect(
			tool.execute("call-2", { query: "query" }, controller.signal, undefined, undefined as never),
		).rejects.toThrow(/cancelled/u);
		expect(receivedSignal).toBe(controller.signal);
	});

	it("does not contact a provider when the caller already cancelled", async () => {
		const controller = new AbortController();
		controller.abort();
		let called = false;
		const tool = createSearchWebTool({ apiKey: "search-key", env: {}, provider: "step" }, async () => {
			called = true;
			return { structuredContent: { results: [] } };
		});

		await expect(
			tool.execute("call-2b", { query: "query" }, controller.signal, undefined, undefined as never),
		).rejects.toThrow(/cancelled/u);
		// A cancelled call must not spend money or hit a free provider.
		expect(called).toBe(false);
	});

	it("fails before making a request when no credential is available", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-search-web-"));
		try {
			let called = false;
			const tool = createSearchWebTool(
				{ env: {}, authPath: join(root, "missing-auth.json"), provider: "step" },
				async () => {
					called = true;
					return { structuredContent: { results: [] } };
				},
			);

			await expect(
				tool.execute("call-3", { query: "query" }, undefined, undefined, undefined as never),
			).rejects.toThrow(/requires a credential/);
			expect(called).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("turns remote MCP errors into tool failures that name the billed endpoint", async () => {
		const tool = createSearchWebTool({ apiKey: "search-key", env: {}, provider: "step" }, async () => ({
			isError: true,
			content: "502 Bad Gateway",
		}));

		await expect(
			tool.execute("call-4", { query: "query" }, undefined, undefined, undefined as never),
		).rejects.toThrow("502 Bad Gateway (endpoint https://api.stepfun.com/v1/mcp/web_search/mcp)");
	});

	it("preserves transport failures as diagnostic tool errors", async () => {
		const tool = createSearchWebTool({ apiKey: "search-key", env: {}, provider: "step" }, async () => {
			throw new Error("transport unavailable");
		});

		await expect(
			tool.execute("call-5", { query: "query" }, undefined, undefined, undefined as never),
		).rejects.toThrow("transport unavailable");
	});

	it("keeps the paid endpoint's own numbering and shows entries without a URL", async () => {
		const tool = createSearchWebTool({ apiKey: "search-key", env: {}, provider: "step" }, async () => ({
			structuredContent: {
				results: [
					// The provider skips 2: the reported numbering must survive.
					{ position: 1, title: "First", url: "https://example.com/1" },
					{ position: 3, title: "Third", url: "https://example.com/3" },
					{ position: 4, title: "No link" },
					{ title: "Unnumbered" },
				],
			},
		}));

		const result = await tool.execute("call-pos", { query: "q" }, undefined, undefined, undefined as never);
		const body = text(result);

		expect(body).toContain("1. [First](https://example.com/1)");
		expect(body).toContain("3. [Third](https://example.com/3)");
		// An entry without a URL is still reported, not silently dropped.
		expect(body).toContain("4. No link");
		// A missing position falls back to the array index, matching the old renderer.
		expect(body).toContain("4. Unnumbered");
		expect(result.details.urls).toEqual(["https://example.com/1", "https://example.com/3"]);
		expect(result.details.resultCount).toBe(4);
	});

	it("searches with a free provider when no Step credential exists", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-search-free-"));
		const urls: string[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			urls.push(url);
			return new Response(
				`event: message\ndata: ${JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					result: {
						content: [{ type: "text", text: "Title: Free\nURL: https://free.example/doc\nHighlights:\nsnippet" }],
					},
				})}\n\n`,
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		}) as typeof fetch;

		try {
			let stepCalls = 0;
			// A random source near 1 leaves the declared order untouched, so the
			// first free candidate is the Exa-shaped fixture below.
			const tool = createSearchWebTool(
				{ env: {}, authPath: join(root, "missing-auth.json"), random: () => 0.99 },
				async () => {
					stepCalls += 1;
					return { structuredContent: { results: [] } };
				},
			);

			const result = await tool.execute("call-free", { query: "query" }, undefined, undefined, undefined as never);

			// The paid endpoint is never contacted: no credential means it cannot succeed.
			expect(stepCalls).toBe(0);
			expect(urls.length).toBe(1);
			expect(text(result)).toContain("[Free](https://free.example/doc)");
			expect(result.details).toMatchObject({ provider: "exa", degraded: true, resultCount: 1 });
		} finally {
			globalThis.fetch = originalFetch;
			await rm(root, { recursive: true, force: true });
		}
	});

	it("falls back to a free provider when the paid tier reports exhausted quota", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(
				`event: message\ndata: ${JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					result: {
						content: [
							{ type: "text", text: "Title: Fallback\nURL: https://free.example/fallback\nHighlights:\nx" },
						],
					},
				})}\n\n`,
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			)) as typeof fetch;

		try {
			const tool = createSearchWebTool(
				{ env: {}, apiKey: "search-key", provider: "auto", random: () => 0.99 },
				async () => ({ isError: true, content: "You reached your daily Plan search limit" }),
			);

			const result = await tool.execute(
				"call-fallback",
				{ query: "query" },
				undefined,
				undefined,
				undefined as never,
			);

			expect(text(result)).toContain("https://free.example/fallback");
			// The answer must say it came from a free provider, not the paid tier.
			expect(result.details).toMatchObject({ provider: "exa", degraded: true });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
