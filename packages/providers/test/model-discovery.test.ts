import { describe, expect, it } from "vitest";
import {
	DEFAULT_DISCOVERY_API,
	discoverModels,
	ModelDiscoveryError,
	modelListingUrl,
	normalizeProviderBaseUrl,
	readModelListing,
} from "../src/model-discovery.ts";

/** The code a rejection carried, or a readable failure when it is not one of ours. */
async function rejectionCode(work: () => Promise<unknown>): Promise<ModelDiscoveryError> {
	try {
		await work();
	} catch (error) {
		if (error instanceof ModelDiscoveryError) return error;
		throw error;
	}
	throw new Error("expected a ModelDiscoveryError, but the call succeeded");
}

describe("modelListingUrl", () => {
	it("joins as a prefix rather than resolving, so deployment paths keep their segments", () => {
		expect(modelListingUrl("https://gateway.example/openai/v1", "openai-completions")).toBe(
			"https://gateway.example/openai/v1/models",
		);
		expect(modelListingUrl("https://gateway.example/v1/", "openai-responses")).toBe(
			"https://gateway.example/v1/models",
		);
	});

	it("strips one trailing /v1 for Anthropic, since both spellings name the same root", () => {
		expect(modelListingUrl("https://api.example/v1", "anthropic-messages")).toBe(
			"https://api.example/v1/models?limit=1000",
		);
		expect(modelListingUrl("https://api.example", "anthropic-messages")).toBe(
			"https://api.example/v1/models?limit=1000",
		);
		expect(modelListingUrl("https://gateway.example/proxy/anthropic", "anthropic-messages")).toBe(
			"https://gateway.example/proxy/anthropic/v1/models?limit=1000",
		);
	});

	it("defaults to the protocol the composer also defaults to", () => {
		expect(DEFAULT_DISCOVERY_API).toBe("openai-completions");
	});

	it("lists a bare gateway root under /v1 for the OpenAI protocols", () => {
		expect(modelListingUrl("https://gateway.example", "openai-completions")).toBe(
			"https://gateway.example/v1/models",
		);
		expect(modelListingUrl("https://gateway.example/", "openai-responses")).toBe("https://gateway.example/v1/models");
	});
});

describe("normalizeProviderBaseUrl", () => {
	it("maps both spellings of a gateway root to what each protocol's client appends to", () => {
		for (const typed of [
			"https://gw.example",
			"https://gw.example/",
			"https://gw.example/v1",
			"https://gw.example/v1/",
		]) {
			expect(normalizeProviderBaseUrl(typed, "openai-completions")).toBe("https://gw.example/v1");
			expect(normalizeProviderBaseUrl(typed, "openai-responses")).toBe("https://gw.example/v1");
			expect(normalizeProviderBaseUrl(typed, "anthropic-messages")).toBe("https://gw.example");
		}
	});

	it("keeps a deployment path the OpenAI protocols cannot guess", () => {
		expect(normalizeProviderBaseUrl("https://ark.example/api/v3", "openai-completions")).toBe(
			"https://ark.example/api/v3",
		);
		expect(normalizeProviderBaseUrl("https://gw.example/openai/", "openai-responses")).toBe(
			"https://gw.example/openai",
		);
	});

	it("strips only one trailing /v1 for Anthropic and keeps other paths", () => {
		expect(normalizeProviderBaseUrl("https://gw.example/proxy/anthropic/v1", "anthropic-messages")).toBe(
			"https://gw.example/proxy/anthropic",
		);
		expect(normalizeProviderBaseUrl("https://gw.example/v1/v1", "anthropic-messages")).toBe("https://gw.example/v1");
	});

	it("returns a value that is not a URL trimmed, for the caller to reject", () => {
		expect(normalizeProviderBaseUrl("  not a url ", "openai-completions")).toBe("not a url");
	});
});

describe("readModelListing", () => {
	it("reads a data array, with capabilities from the common field spellings", () => {
		expect(
			readModelListing({
				data: [
					{ id: "a", name: "A", contextWindow: 1000, maxTokens: 100 },
					{ id: "b", display_name: "B", context_length: 2000, max_output_tokens: 200 },
					{ id: "c", displayName: "C", max_input_tokens: 3000, top_provider: { max_completion_tokens: 300 } },
					{ id: "d", limit: { context: 4000, output: 400 } },
				],
			}),
		).toEqual([
			{ id: "a", name: "A", contextWindow: 1000, maxTokens: 100 },
			{ id: "b", name: "B", contextWindow: 2000, maxTokens: 200 },
			{ id: "c", name: "C", contextWindow: 3000, maxTokens: 300 },
			{ id: "d", name: "d", contextWindow: 4000, maxTokens: 400 },
		]);
	});

	it("skips an entry with no usable id and drops an unusable capacity", () => {
		expect(
			readModelListing({
				data: [
					{ name: "no id" },
					{ id: "ok", contextWindow: -1, maxTokens: 1.5 },
					{ id: "", name: "empty id" },
					"not an object",
				],
			}),
		).toEqual([{ id: "ok", name: "ok" }]);
	});

	it("uses each key of a models map as the id the endpoint accepts, and ignores primitives", () => {
		expect(
			readModelListing({
				models: {
					alias: { id: "canonical", name: "Alias" },
					"empty-key-target": {},
					directory: "metadata, not a model",
					list: [1, 2],
				},
			}),
		).toEqual([
			{ id: "alias", name: "Alias" },
			{ id: "empty-key-target", name: "empty-key-target" },
		]);
	});

	it("prefers the data array when both shapes are present", () => {
		expect(readModelListing({ data: [{ id: "from-data" }], models: { "from-map": {} } })).toEqual([
			{ id: "from-data", name: "from-data" },
		]);
	});

	it("refuses anything that is not a model listing", () => {
		for (const body of [{ hello: "world" }, {}, [], "text", null, undefined]) {
			expect(() => readModelListing(body)).toThrow(ModelDiscoveryError);
		}
	});
});

describe("discoverModels", () => {
	it("reports an unreadable protocol, address or reply rather than guessing", async () => {
		expect(
			(await rejectionCode(() => discoverModels({ baseUrl: "https://x.example/v1", api: "google-generative-ai" })))
				.code,
		).toBe("unsupported-api");
		expect((await rejectionCode(() => discoverModels({ baseUrl: "  " }))).code).toBe("invalid-base-url");
		expect((await rejectionCode(() => discoverModels({ baseUrl: "file:///tmp/models.json" }))).code).toBe(
			"invalid-base-url",
		);
		expect(
			(
				await rejectionCode(() =>
					discoverModels({
						baseUrl: "https://x.example/v1",
						fetch: async () => new Response("<html>", { status: 200 }),
					}),
				)
			).code,
		).toBe("not-json");
	});

	it("carries the HTTP status and points at the key when the endpoint refuses", async () => {
		for (const [status, expectsHint] of [
			[401, true],
			[500, false],
		] as const) {
			const error = await rejectionCode(() =>
				discoverModels({ baseUrl: "https://x.example/v1", fetch: async () => new Response("{}", { status }) }),
			);
			expect(error.code).toBe("http");
			expect(error.status).toBe(status);
			expect(error.message.includes("check the API key")).toBe(expectsHint);
		}
	});

	it("separates an unreachable endpoint from a cancelled probe", async () => {
		const unreachable = await rejectionCode(() =>
			discoverModels({
				baseUrl: "https://x.example/v1",
				fetch: async () => {
					throw new Error("ECONNREFUSED");
				},
			}),
		);
		expect(unreachable.code).toBe("unreachable");

		const controller = new AbortController();
		controller.abort();
		const aborted = await rejectionCode(() =>
			discoverModels({
				baseUrl: "https://x.example/v1",
				signal: controller.signal,
				fetch: async () => {
					throw new Error("aborted");
				},
			}),
		);
		expect(aborted.code).toBe("aborted");
	});

	it("sends the auth header the protocol expects and keeps declared headers", async () => {
		const seen: Array<Record<string, string>> = [];
		const capture: typeof fetch = async (_input, init) => {
			seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
			return new Response(JSON.stringify({ data: [] }), { status: 200 });
		};

		await discoverModels({
			baseUrl: "https://x.example/v1",
			api: "openai-completions",
			apiKey: "sk-1",
			headers: { "x-custom": "kept" },
			fetch: capture,
		});
		expect(seen[0]?.authorization).toBe("Bearer sk-1");
		expect(seen[0]?.accept).toBe("application/json");
		expect(seen[0]?.["x-custom"]).toBe("kept");

		await discoverModels({
			baseUrl: "https://x.example/v1",
			api: "anthropic-messages",
			apiKey: "sk-2",
			fetch: capture,
		});
		expect(seen[1]?.["x-api-key"]).toBe("sk-2");
		expect(seen[1]?.["anthropic-version"]).toBe("2023-06-01");
		// Anthropic-compatible gateways (e.g. StepFun) list models only for Bearer auth.
		expect(seen[1]?.authorization).toBe("Bearer sk-2");

		// A declared authorization header is not overridden.
		await discoverModels({
			baseUrl: "https://x.example/v1",
			api: "anthropic-messages",
			apiKey: "sk-2",
			headers: { authorization: "Bearer gateway" },
			fetch: capture,
		});
		expect(seen[2]?.["x-api-key"]).toBe("sk-2");
		expect(seen[2]?.authorization).toBe("Bearer gateway");

		// A keyless endpoint is still probeable: no auth header is invented.
		await discoverModels({ baseUrl: "http://localhost:11434/v1", fetch: capture });
		expect(seen[3]?.authorization).toBeUndefined();
		expect(seen[3]?.["x-api-key"]).toBeUndefined();
	});

	it("refuses an over-large reply instead of truncating it", async () => {
		const declared = await rejectionCode(() =>
			discoverModels({
				baseUrl: "https://x.example/v1",
				fetch: async () =>
					new Response(JSON.stringify({ data: [] }), {
						status: 200,
						headers: { "content-length": String(5 * 1024 * 1024) },
					}),
			}),
		);
		expect(declared.code).toBe("too-large");

		// A server that under-declares is caught by the bytes actually read.
		const streamed = await rejectionCode(() =>
			discoverModels({
				baseUrl: "https://x.example/v1",
				fetch: async () =>
					new Response(
						new ReadableStream({
							start(controller) {
								const chunk = new Uint8Array(1024 * 1024);
								for (let index = 0; index < 5; index++) controller.enqueue(chunk);
								controller.close();
							},
						}),
						{ status: 200 },
					),
			}),
		);
		expect(streamed.code).toBe("too-large");
	});
});
