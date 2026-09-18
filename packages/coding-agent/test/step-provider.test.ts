import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthLoginCallbacks, RefreshModelsContext } from "@step-harness/providers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionAPI, InlineExtension } from "../src/core/extensions/types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../src/core/models-store.ts";
import type { StepCallbackResult } from "../src/features/step-provider/index.ts";
import {
	buildStepAuthorizationUrl,
	buildStepCallbackUrl,
	createStepProviderConfig,
	createStepProviderInlineExtension,
	fetchStepModelEfforts,
	fetchStepModels,
	loginStepOAuth,
	refreshStepOAuth,
	resolveStepProviderOptions,
	STEP_PROVIDER_ENV,
	STEP_PROVIDER_ID,
	STEP_STATIC_REFRESH_TOKEN,
	startStepCallbackServer,
	stepHighestEffort,
	stepModelsDetailBaseUrl,
	stepOpenAiBaseUrl,
	stepProviderInlineExtension,
	stepThinkingLevelMap,
} from "../src/features/step-provider/index.ts";

async function request(port: number, path: string): Promise<Response> {
	return fetch(`http://127.0.0.1:${port}${path}`);
}

function callbacks(overrides: Partial<OAuthLoginCallbacks> = {}): OAuthLoginCallbacks {
	return {
		onAuth: vi.fn(),
		onDeviceCode: vi.fn(),
		onPrompt: vi.fn(async () => ""),
		onSelect: vi.fn(async () => undefined),
		...overrides,
	};
}

describe("Step OAuth callback server", () => {
	it("accepts a credential only when state matches", async () => {
		const server = await startStepCallbackServer({ state: "state-1", timeoutMs: 5000 });
		try {
			const invalid = await request(server.port, "/callback?state=wrong&api_key=ignored");
			expect(invalid.status).toBe(400);

			const resultPromise = server.waitForResult();
			const valid = await request(server.port, "/callback?state=state-1&api_key=key%20123&uid=user-1");
			expect(valid.status).toBe(200);
			expect(await resultPromise).toEqual({
				kind: "credential",
				apiKey: "key 123",
				uid: "user-1",
			});
		} finally {
			await server.close();
		}
	});

	it("reports cancellation and timeout and closes idempotently", async () => {
		const controller = new AbortController();
		const cancelled = await startStepCallbackServer({ state: "cancel", signal: controller.signal, timeoutMs: 5000 });
		const cancelledResult = cancelled.waitForResult();
		controller.abort();
		expect(await cancelledResult).toEqual({ kind: "cancelled" });
		await cancelled.close();
		await cancelled.close();

		const timedOut = await startStepCallbackServer({ state: "timeout", timeoutMs: 5 });
		await expect(timedOut.waitForResult()).resolves.toEqual({ kind: "timeout" });
		await timedOut.close();
	});

	it("rejects non-loopback hosts and malformed state", async () => {
		await expect(startStepCallbackServer({ state: "" })).rejects.toThrow("state");
		await expect(startStepCallbackServer({ state: "ok", host: "0.0.0.0" })).rejects.toThrow("loopback");
	});

	it("builds authorization and callback URLs with encoded state", () => {
		const authUrl = buildStepAuthorizationUrl({
			authBaseUrl: "https://auth.example.test/root",
			port: 4321,
			state: "a state",
		});
		const parsed = new URL(authUrl);
		expect(parsed.pathname).toBe("/cli-login");
		expect(parsed.searchParams.get("port")).toBe("4321");
		expect(parsed.searchParams.get("state")).toBe("a state");
		expect(buildStepCallbackUrl({ host: "::1", port: 4321 })).toBe("http://[::1]:4321/callback");
	});
});

describe("Step provider extension", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("resolves endpoint and OAuth settings from injected environment", () => {
		const options = resolveStepProviderOptions({
			env: {
				[STEP_PROVIDER_ENV.apiBaseUrl]: "https://api.example.test/v1/",
				[STEP_PROVIDER_ENV.authBaseUrl]: "https://auth.example.test/",
				[STEP_PROVIDER_ENV.tokenUrl]: "https://auth.example.test/token",
				[STEP_PROVIDER_ENV.callbackPort]: "3210",
				[STEP_PROVIDER_ENV.timeoutMs]: "9000",
			},
		});
		expect(options.apiBaseUrl).toBe("https://api.example.test");
		expect(options.authBaseUrl).toBe("https://auth.example.test");
		expect(options.tokenUrl).toBe("https://auth.example.test/token");
		expect(options.callbackPort).toBe(3210);
		expect(options.timeoutMs).toBe(9000);
	});

	it("exports an inline extension and registers native pi provider config", () => {
		const registerProvider = vi.fn();
		const inline = stepProviderInlineExtension as InlineExtension;
		const factory = typeof inline === "function" ? inline : inline.factory;
		factory({ registerProvider } as unknown as ExtensionAPI);
		expect(typeof inline === "function" ? undefined : inline.hidden).toBe(true);
		expect(createStepProviderInlineExtension({ name: "Step test" }).name).toBe("Step test");
		expect(registerProvider).toHaveBeenCalledWith(STEP_PROVIDER_ID, expect.any(Object));
		const config = registerProvider.mock.calls[0]?.[1] as ReturnType<typeof createStepProviderConfig>;
		expect(config.api).toBe("openai-completions");
		expect(config.baseUrl).toBe("https://api.stepfun.com/step_plan/v1");
		// No built-in baseline; the catalog is discovered dynamically after login.
		expect(config.models).toEqual([]);
		expect(config.oauth?.name).toBe("Step Plan");
	});

	it.each([
		["https://api.example.test/step_plan", "https://api.example.test/step_plan"],
		["https://api.example.test/step_plan/v1", "https://api.example.test/step_plan"],
		["https://api.example.test/step_plan/v1/messages", "https://api.example.test/step_plan"],
		["https://api.example.test/step_plan/v1/v1/messages", "https://api.example.test/step_plan"],
		["https://api.example.test/step_plan/v1/messages/messages", "https://api.example.test/step_plan"],
	])("normalizes the Step endpoint %s to its route prefix", (input, expected) => {
		expect(resolveStepProviderOptions({ apiBaseUrl: input, env: {} }).apiBaseUrl).toBe(expected);
	});

	it("honors the legacy STEPFUN_MESSAGES_ENDPOINT override", () => {
		expect(
			resolveStepProviderOptions({
				env: { STEPFUN_MESSAGES_ENDPOINT: "https://api.example.test/step_plan/v1/messages" },
			}).apiBaseUrl,
		).toBe("https://api.example.test/step_plan");
	});

	it("uses the stored Step login profile endpoint hint after explicit overrides", () => {
		expect(
			resolveStepProviderOptions({
				env: { STEP_LOGIN_PROFILE_API_URL: "https://api.stepfun.ai/v1" },
			}).apiBaseUrl,
		).toBe("https://api.stepfun.ai");
	});

	it("defaults custom Step models to the OpenAI dialect without mutating input", () => {
		const models = [
			{
				id: "custom-step",
				name: "Custom Step",
				reasoning: false,
				input: ["text", "image"] as ("text" | "image")[],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 256_000,
				maxTokens: 256_000,
			},
		];
		const config = createStepProviderConfig({ models, env: {} });

		expect(config.models?.[0]?.api).toBe("openai-completions");
		expect(config.models?.[0]?.input).toEqual(["text", "image"]);
		expect(models[0]).not.toHaveProperty("api");
	});

	it("routes a stored Step login to the chat completions endpoint exactly once", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({
				[STEP_PROVIDER_ID]: {
					type: "oauth",
					access: "step-key",
					refresh: STEP_STATIC_REFRESH_TOKEN,
					expires: Number.MAX_SAFE_INTEGER,
				},
			}),
			modelsPath: null,
			refreshOnCreate: false,
		});
		runtime.registerProvider(
			STEP_PROVIDER_ID,
			createStepProviderConfig({
				env: {},
				models: [
					{
						id: "step-3.7-flash",
						name: "Step 3.7 Flash",
						reasoning: true,
						input: ["text", "image"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 256_000,
						maxTokens: 256_000,
					},
				],
			}),
		);
		const model = runtime.getModel(STEP_PROVIDER_ID, "step-3.7-flash");
		expect(model).toMatchObject({
			api: "openai-completions",
			baseUrl: "https://api.stepfun.com/step_plan/v1",
		});

		let requestUrl: string | undefined;
		let requestHeaders: Headers | undefined;
		const response = await runtime.completeSimple(
			model!,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				fetch: async (input, init) => {
					requestUrl = String(input);
					requestHeaders = new Headers(init?.headers);
					return new Response(null, { status: 401 });
				},
			},
		);

		expect(requestUrl).toBe("https://api.stepfun.com/step_plan/v1/chat/completions");
		expect(requestHeaders?.get("authorization")).toBe("Bearer step-key");
		expect(response.errorMessage).toContain("401");
	});

	it("normalizes stale models.json endpoint overrides for embedded hosts", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-provider-models-"));
		try {
			const modelsPath = join(root, "models.json");
			await writeFile(
				modelsPath,
				JSON.stringify({
					providers: {
						[STEP_PROVIDER_ID]: {
							api: "anthropic-messages",
							baseUrl: "https://api.stepfun.com/step_plan/v1",
							models: [
								{
									id: "step-3.7-flash",
									api: "anthropic-messages",
									// The dialect is already correct, but an old proxy host must
									// not survive as a model-level override.
									baseUrl: "https://models-proxy.example/v1/messages",
								},
							],
						},
					},
				}),
			);
			const runtime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory({
					[STEP_PROVIDER_ID]: {
						type: "oauth",
						access: "step-key",
						refresh: STEP_STATIC_REFRESH_TOKEN,
						expires: Number.MAX_SAFE_INTEGER,
					},
				}),
				modelsPath,
				modelsStore: new InMemoryCodingAgentModelsStore(),
				refreshOnCreate: false,
			});
			runtime.registerProvider(STEP_PROVIDER_ID, createStepProviderConfig({ env: {} }));
			const model = runtime.getModel(STEP_PROVIDER_ID, "step-3.7-flash");
			expect(model?.baseUrl).toBe("https://api.stepfun.com/step_plan/v1");

			let requestUrl: string | undefined;
			await runtime.completeSimple(
				model!,
				{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
				{
					fetch: async (input) => {
						requestUrl = String(input);
						return new Response(null, { status: 404 });
					},
				},
			);
			expect(requestUrl).toBe("https://api.stepfun.com/step_plan/v1/chat/completions");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("repairs stale OpenAI metadata for a built-in Step model", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-provider-models-openai-"));
		try {
			const modelsPath = join(root, "models.json");
			await writeFile(
				modelsPath,
				JSON.stringify({
					providers: {
						[STEP_PROVIDER_ID]: {
							api: "openai-completions",
							baseUrl: "https://models-proxy.example/v1/messages",
							models: [
								{
									id: "step-3.7-flash",
									api: "openai-completions",
									baseUrl: "https://models-proxy.example/v1/messages",
								},
							],
						},
					},
				}),
			);
			const runtime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory({
					[STEP_PROVIDER_ID]: {
						type: "oauth",
						access: "step-key",
						refresh: STEP_STATIC_REFRESH_TOKEN,
						expires: Number.MAX_SAFE_INTEGER,
					},
				}),
				modelsPath,
				modelsStore: new InMemoryCodingAgentModelsStore(),
				refreshOnCreate: false,
			});
			runtime.registerProvider(STEP_PROVIDER_ID, createStepProviderConfig({ env: {} }));
			const model = runtime.getModel(STEP_PROVIDER_ID, "step-3.7-flash");
			expect(model).toMatchObject({
				api: "openai-completions",
				baseUrl: "https://api.stepfun.com/step_plan/v1",
			});

			let requestUrl: string | undefined;
			await runtime.completeSimple(
				model!,
				{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
				{
					fetch: async (input) => {
						requestUrl = String(input);
						return new Response(null, { status: 401 });
					},
				},
			);
			expect(requestUrl).toBe("https://api.stepfun.com/step_plan/v1/chat/completions");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("converts a callback credential into OAuth credentials", async () => {
		const callback: StepCallbackResult = {
			kind: "credential",
			apiKey: "step-key",
			uid: "u-1",
		};
		const server = {
			port: 4321,
			waitForResult: vi.fn(async () => callback),
			close: vi.fn(async () => {}),
		};
		const onAuth = vi.fn();
		const result = await loginStepOAuth(
			callbacks({ onAuth }),
			resolveStepProviderOptions({
				authBaseUrl: "https://auth.example.test",
				createState: () => "fixed-state",
				createCallbackServer: async () => server,
			}),
		);
		expect(result.access).toBe("step-key");
		expect(result.refresh).toBe("step-static-credential");
		expect(result.uid).toBe("u-1");
		expect(onAuth).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "https://auth.example.test/cli-login?port=4321&state=fixed-state",
			}),
		);
		expect(server.close).toHaveBeenCalledTimes(1);
	});

	it("exchanges a callback code and uses the actual ephemeral port", async () => {
		const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			expect(init?.body).toBeInstanceOf(URLSearchParams);
			const body = init?.body as URLSearchParams;
			expect(body.get("redirect_uri")).toBe("http://127.0.0.1:5432/callback");
			return new Response(
				JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600, uid: "u-token" }),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);
		});
		const server = {
			port: 5432,
			waitForResult: vi.fn(async () => ({ kind: "code", code: "auth-code" }) as const),
			close: vi.fn(async () => {}),
		};
		const result = await loginStepOAuth(
			callbacks(),
			resolveStepProviderOptions({
				authBaseUrl: "https://auth.example.test",
				tokenUrl: "https://auth.example.test/token",
				createState: () => "fixed-state",
				createCallbackServer: async () => server,
				fetch: fetchMock,
			}),
		);
		expect(result.access).toBe("access");
		expect(result.refresh).toBe("refresh");
		expect(result.uid).toBe("u-token");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("preserves uid from a manually pasted callback URL", async () => {
		const server = {
			port: 5433,
			waitForResult: vi.fn(() => new Promise<StepCallbackResult>(() => {})),
			close: vi.fn(async () => {}),
		};
		const result = await loginStepOAuth(
			callbacks({
				onManualCodeInput: async () =>
					"http://127.0.0.1:5433/callback?state=fixed-state&api_key=access&uid=u-manual",
			}),
			resolveStepProviderOptions({
				authBaseUrl: "https://auth.example.test",
				allowManualCallback: true,
				createState: () => "fixed-state",
				createCallbackServer: async () => server,
			}),
		);
		expect(result).toMatchObject({ access: "access", uid: "u-manual" });
		expect(server.close).toHaveBeenCalledTimes(1);
	});

	it("does not refresh static Step keys", async () => {
		const credential = { access: "key", refresh: STEP_STATIC_REFRESH_TOKEN, expires: 0 };
		await expect(refreshStepOAuth(credential, { env: {} })).resolves.toMatchObject({
			access: "key",
			expires: Number.MAX_SAFE_INTEGER,
		});
	});

	it("retains the account uid when a refresh response omits it", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
		);
		const result = await refreshStepOAuth(
			{ access: "old-access", refresh: "old-refresh", expires: 1, uid: "u-existing" },
			{
				env: {},
				tokenUrl: "https://auth.example.test/token",
				fetch: fetchMock,
			},
		);
		expect(result).toMatchObject({ access: "new-access", uid: "u-existing" });
	});
});

describe("Step dynamic model discovery", () => {
	function refreshContext(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
		return {
			allowNetwork: true,
			signal: new AbortController().signal,
			publish: async () => true,
			...overrides,
		} as RefreshModelsContext;
	}

	it("derives the OpenAI base for each profile", () => {
		expect(stepOpenAiBaseUrl("https://api.stepfun.com/step_plan")).toBe("https://api.stepfun.com/step_plan/v1");
		expect(stepOpenAiBaseUrl("https://api.stepfun.com")).toBe("https://api.stepfun.com/v1");
		// Idempotent for a base that already carries a `/v1` suffix.
		expect(stepOpenAiBaseUrl("https://api.stepfun.com/v1")).toBe("https://api.stepfun.com/v1");
	});

	it("derives the domain-root /v1 for per-model detail lookups", () => {
		// The detail endpoint lives at the domain root, even for step_plan whose
		// chat/list base carries a /step_plan subpath (the subpath variant 404s).
		expect(stepModelsDetailBaseUrl("https://api.stepfun.com/step_plan/v1")).toBe("https://api.stepfun.com/v1");
		expect(stepModelsDetailBaseUrl("https://api.stepfun.com/v1")).toBe("https://api.stepfun.com/v1");
		expect(stepModelsDetailBaseUrl("https://api.stepfun.ai/step_plan/v1")).toBe("https://api.stepfun.ai/v1");
	});

	it("carries reasoning_effort_support_list from the list into thinkingLevelMap", async () => {
		const resolved = resolveStepProviderOptions({ env: {} });
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						data: [
							{
								id: "step-3.7-flash",
								model_type: "大语言模型",
								reasoning_effort_support_list: ["low", "medium", "high"],
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		const models = await fetchStepModels(
			refreshContext({ credential: { type: "oauth", access: "t", refresh: "", expires: 0 } }),
			{ ...resolved, fetch: fetchMock },
		);
		expect(models[0]?.reasoning).toBe(true);
		expect(models[0]?.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
			max: null,
		});
	});

	it("fetches models from {base}/v1/models with the bearer token", async () => {
		const resolved = resolveStepProviderOptions({ env: {} });
		let requestUrl: string | undefined;
		let authorization: string | null | undefined;
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			requestUrl = String(input);
			authorization = new Headers(init?.headers).get("authorization");
			return new Response(JSON.stringify({ data: [{ id: "step-3.5-flash" }, { id: "step-2" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		const models = await fetchStepModels(
			refreshContext({ credential: { type: "oauth", access: "tok", refresh: "", expires: 0 } }),
			{ ...resolved, fetch: fetchMock },
		);

		expect(requestUrl).toBe("https://api.stepfun.com/step_plan/v1/models");
		expect(authorization).toBe("Bearer tok");
		expect(models.map((m) => m.id)).toEqual(["step-3.5-flash", "step-2"]);
		expect(models[0]).toMatchObject({
			api: "openai-completions",
			baseUrl: "https://api.stepfun.com/step_plan/v1",
		});
	});

	it("keeps chat-capable models (LLM and router) when the endpoint tags model_type", async () => {
		const resolved = resolveStepProviderOptions({ env: {} });
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						data: [
							{ id: "step-3.5-flash", model_type: "大语言模型" },
							{ id: "step-router-v1", model_type: "路由模型" },
							{ id: "step-tts-mini", model_type: "语音合成" },
							{ id: "search-image" },
							{ id: "step-2", model_type: "大语言模型" },
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);

		const models = await fetchStepModels(
			refreshContext({ credential: { type: "oauth", access: "t", refresh: "", expires: 0 } }),
			{ ...resolved, fetch: fetchMock },
		);

		expect(models.map((m) => m.id)).toEqual(["step-3.5-flash", "step-router-v1", "step-2"]);
	});

	it("maps discovered capability fields onto the model config", async () => {
		const resolved = resolveStepProviderOptions({ env: {} });
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						data: [
							{
								id: "step-vision",
								model_type: "大语言模型",
								max_input_tokens: 131072,
								enable_reason: false,
								enable_vision_input: true,
							},
							{
								id: "step-text",
								model_type: "大语言模型",
								max_input_tokens: 262144,
								enable_reason: true,
								enable_vision_input: false,
							},
							{ id: "step-bare", model_type: "大语言模型" },
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);

		const models = await fetchStepModels(
			refreshContext({ credential: { type: "oauth", access: "t", refresh: "", expires: 0 } }),
			{ ...resolved, fetch: fetchMock },
		);

		expect(models).toEqual([
			expect.objectContaining({
				id: "step-vision",
				contextWindow: 131072,
				maxTokens: 131072,
				reasoning: false,
				input: ["text", "image"],
			}),
			expect.objectContaining({
				id: "step-text",
				contextWindow: 262144,
				maxTokens: 262144,
				reasoning: true,
				input: ["text"],
			}),
			expect.objectContaining({
				id: "step-bare",
				contextWindow: 256_000,
				maxTokens: 256_000,
				reasoning: false,
				input: ["text"],
			}),
		]);
	});

	it("returns no models when unauthenticated or offline", async () => {
		const resolved = resolveStepProviderOptions({ env: {} });
		expect(await fetchStepModels(refreshContext({ credential: undefined }), resolved)).toEqual([]);
		expect(
			await fetchStepModels(
				refreshContext({
					allowNetwork: false,
					credential: { type: "oauth", access: "t", refresh: "", expires: 0 },
				}),
				resolved,
			),
		).toEqual([]);
	});

	it("returns no models on a non-200 response", async () => {
		const resolved = resolveStepProviderOptions({ env: {} });
		const fetchMock = vi.fn(async () => new Response("nope", { status: 500 }));
		const models = await fetchStepModels(
			refreshContext({ credential: { type: "oauth", access: "t", refresh: "", expires: 0 } }),
			{ ...resolved, fetch: fetchMock },
		);
		expect(models).toEqual([]);
	});

	it("maps a reasoning_effort_support_list to a thinkingLevelMap", () => {
		expect(stepThinkingLevelMap(["low", "medium", "high"])).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
			max: null,
		});
	});

	it("reports the highest supported effort", () => {
		expect(stepHighestEffort(["low", "medium", "high"])).toBe("high");
		expect(stepHighestEffort(["low", "xhigh", "medium"])).toBe("xhigh");
		expect(stepHighestEffort([])).toBeUndefined();
	});

	it("fetches a model's supported efforts from /v1/models/{id}", async () => {
		let requestUrl: string | undefined;
		let authorization: string | null | undefined;
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			requestUrl = String(input);
			authorization = new Headers(init?.headers).get("authorization");
			return new Response(JSON.stringify({ id: "step-3.5-flash", reasoning_effort_support_list: ["low", "high"] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		const efforts = await fetchStepModelEfforts({
			baseUrl: "https://api.stepfun.com/step_plan/v1",
			modelId: "step-3.5-flash",
			apiKey: "tok",
			fetch: fetchMock,
		});

		expect(requestUrl).toBe("https://api.stepfun.com/step_plan/v1/models/step-3.5-flash");
		expect(authorization).toBe("Bearer tok");
		expect(efforts).toEqual(["low", "high"]);
	});

	it("returns undefined when the effort field is absent or the request fails", async () => {
		const missing = vi.fn(async () => new Response(JSON.stringify({ id: "m" }), { status: 200 }));
		expect(
			await fetchStepModelEfforts({ baseUrl: "https://x/v1", modelId: "m", apiKey: "t", fetch: missing }),
		).toBeUndefined();
		const failed = vi.fn(async () => new Response("no", { status: 404 }));
		expect(
			await fetchStepModelEfforts({ baseUrl: "https://x/v1", modelId: "m", apiKey: "t", fetch: failed }),
		).toBeUndefined();
	});
});
