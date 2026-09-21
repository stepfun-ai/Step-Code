import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
			"https://api.stepfun.com/v1/mcp/web_search/mcp",
		);
		expect(resolveSearchWebServerUrl(undefined, {}, "platform_cn")).toBe(
			"https://api.stepfun.com/v1/mcp/web_search/mcp",
		);
		expect(resolveSearchWebServerUrl(undefined, {}, "platform_oversea")).toBe(
			"https://api.stepfun.ai/v1/mcp/web_search/mcp",
		);
		expect(resolveSearchWebServerUrl(undefined, {}, "step_plan_oversea")).toBe(
			"https://api.stepfun.ai/v1/mcp/web_search/mcp",
		);
		expect(resolveSearchWebServerUrl(undefined, {}, "unknown")).toBe("https://api.stepfun.com/v1/mcp/web_search/mcp");
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
		const tool = createSearchWebTool({ url: "https://search.example.com", apiKey: "search-key" }, async (input) => {
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
		});

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
		});
	});

	it("selects the overseas endpoint from either persisted overseas login profile", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-search-web-profile-"));
		const authPath = join(root, "auth.json");
		try {
			for (const profile of ["platform_oversea", "step_plan_oversea"]) {
				await writeFile(
					authPath,
					JSON.stringify({ step: { type: "oauth", access: "search-key", profile } }),
					"utf8",
				);
				let serverUrl = "";
				const tool = createSearchWebTool({ env: {}, authPath }, async (input) => {
					serverUrl = input.serverUrl;
					return { structuredContent: { results: [] } };
				});

				await tool.execute("profile-call", { query: "query" }, undefined, undefined, undefined as never);
				expect(serverUrl).toBe("https://api.stepfun.ai/v1/mcp/web_search/mcp");
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("passes cancellation to the remote invoker", async () => {
		const controller = new AbortController();
		controller.abort();
		let receivedSignal: AbortSignal | undefined;
		const tool = createSearchWebTool({ apiKey: "search-key" }, async (input) => {
			receivedSignal = input.signal;
			return { structuredContent: { results: [] } };
		});

		await tool.execute("call-2", { query: "query" }, controller.signal, undefined, undefined as never);
		expect(receivedSignal).toBe(controller.signal);
	});

	it("fails before making a request when no credential is available", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-search-web-"));
		try {
			let called = false;
			const tool = createSearchWebTool({ env: {}, authPath: join(root, "missing-auth.json") }, async () => {
				called = true;
				return { structuredContent: { results: [] } };
			});

			await expect(
				tool.execute("call-3", { query: "query" }, undefined, undefined, undefined as never),
			).rejects.toThrow(/requires a credential/);
			expect(called).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("turns remote MCP errors into tool failures", async () => {
		const tool = createSearchWebTool({ apiKey: "search-key" }, async () => ({
			isError: true,
			content: "502 Bad Gateway",
		}));

		await expect(
			tool.execute("call-4", { query: "query" }, undefined, undefined, undefined as never),
		).rejects.toThrow("502 Bad Gateway");
	});

	it("preserves transport failures as diagnostic tool errors", async () => {
		const tool = createSearchWebTool({ apiKey: "search-key" }, async () => {
			throw new Error("transport unavailable");
		});

		await expect(
			tool.execute("call-5", { query: "query" }, undefined, undefined, undefined as never),
		).rejects.toThrow("transport unavailable");
	});
});
