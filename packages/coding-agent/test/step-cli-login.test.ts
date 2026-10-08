import { Server } from "node:net";
import type { OAuthLoginCallbacks } from "@step-harness/providers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	initStepCliLogin,
	isRetryableStepCliLoginError,
	loginStepOAuth,
	MIN_STEP_POLL_INTERVAL_MS,
	pollStepCliLogin,
	resolveStepProviderOptions,
	STEP_CLI_LOGIN_PATH_PREFIX,
	StepCliLoginRequestError,
	waitForStepCliLogin,
} from "../src/features/step-provider/index.ts";

const AUTH_BASE_URL = "https://auth.example.test";
const CLIENT = { name: "stepcode", version: "1.2.3", platform: "darwin-arm64" } as const;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function initBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		status: 0,
		desc: "",
		flow_id: "flow-1",
		poll_interval_sec: 2,
		expires_at: Math.floor(Date.now() / 1000) + 600,
		...overrides,
	};
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

describe("Step CLI login init", () => {
	it("sends the poll token in the header only and never in the URL", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			expect(url).toBe(`${AUTH_BASE_URL}${STEP_CLI_LOGIN_PATH_PREFIX}/init`);
			expect(url).not.toContain("poll-token-value");
			expect(init?.method).toBe("POST");
			expect(url).toBe(`${AUTH_BASE_URL}/api/stdhttp/v1/cli-login/init`);
			expect(init?.redirect).toBe("error");
			expect(init?.credentials).toBe("omit");
			const headers = init?.headers as Record<string, string>;
			expect(headers.authorization).toBe("Bearer poll-token-value");
			expect(JSON.parse(String(init?.body))).toEqual({
				profile: "step_plan",
				origin: AUTH_BASE_URL,
				client: CLIENT,
			});
			return json(initBody());
		});

		const init = await initStepCliLogin({
			authBaseUrl: AUTH_BASE_URL,
			pollToken: "poll-token-value",
			profile: "step_plan",
			client: CLIENT,
			fetch: fetchMock,
		});

		expect(init.flowId).toBe("flow-1");
		expect(init.authorizeUrl).toBe(`${AUTH_BASE_URL}/cli-login-remote?flow_id=flow-1`);
		expect(init.pollIntervalSec).toBe(2);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("constructs the authorization URL from the selected developer-center origin", async () => {
		const init = await initStepCliLogin({
			authBaseUrl: AUTH_BASE_URL,
			pollToken: "token",
			profile: "step_plan",
			client: CLIENT,
			fetch: async () => json(initBody({ authorize_url: "https://evil.example.test/phishing" })),
		});
		expect(init.authorizeUrl).toBe(`${AUTH_BASE_URL}/cli-login-remote?flow_id=flow-1`);
	});

	it("uses the overseas developer center and profile for overseas login", async () => {
		const authBaseUrl = "https://platform.stepfun.ai";
		const init = await initStepCliLogin({
			authBaseUrl,
			pollToken: "oversea-poll-token",
			profile: "step_plan_oversea",
			client: CLIENT,
			fetch: async (input, options) => {
				expect(String(input)).toBe(`${authBaseUrl}${STEP_CLI_LOGIN_PATH_PREFIX}/init`);
				expect(JSON.parse(String(options?.body))).toEqual({
					profile: "step_plan_oversea",
					origin: authBaseUrl,
					client: CLIENT,
				});
				return json(initBody());
			},
		});

		expect(init.authorizeUrl).toBe(`${authBaseUrl}/cli-login-remote?flow_id=flow-1`);
	});

	it("rejects a missing flow_id, a sub-second interval and a missing expiry", async () => {
		const bad = [{ flow_id: "" }, { flow_id: "has spaces" }, { poll_interval_sec: 0.5 }, { expires_at: 0 }];
		for (const overrides of bad) {
			await expect(
				initStepCliLogin({
					authBaseUrl: AUTH_BASE_URL,
					pollToken: "token",
					profile: "step_plan",
					client: CLIENT,
					fetch: async () => json(initBody(overrides)),
				}),
			).rejects.toMatchObject({ kind: "protocol" });
		}
	});

	it("clamps an absurd poll interval instead of parking the terminal", async () => {
		const init = await initStepCliLogin({
			authBaseUrl: AUTH_BASE_URL,
			pollToken: "token",
			profile: "step_plan",
			client: CLIENT,
			fetch: async () => json(initBody({ poll_interval_sec: 86_400 })),
		});
		expect(init.pollIntervalSec).toBe(60);
	});

	it("reports the HTTP status before looking at the envelope", async () => {
		const error = await initStepCliLogin({
			authBaseUrl: AUTH_BASE_URL,
			pollToken: "token",
			profile: "step_plan",
			client: CLIENT,
			fetch: async () => json({ status: 40301, desc: "no plan" }, 403),
		}).catch((caught: unknown) => caught);
		expect(error).toMatchObject({ kind: "http", httpStatus: 403 });
		expect((error as Error).message).toContain("no plan");
	});

	it("refuses a response larger than the cap", async () => {
		const huge = JSON.stringify({ status: 0, desc: "x".repeat(70 * 1024) });
		await expect(
			initStepCliLogin({
				authBaseUrl: AUTH_BASE_URL,
				pollToken: "token",
				profile: "step_plan",
				client: CLIENT,
				fetch: async () => new Response(huge, { status: 200, headers: { "content-type": "application/json" } }),
			}),
		).rejects.toMatchObject({ kind: "protocol" });
	});

	it("never sends a poll token over plain HTTP", async () => {
		const fetchMock = vi.fn();
		await expect(
			initStepCliLogin({
				authBaseUrl: "http://auth.example.test",
				pollToken: "token",
				profile: "step_plan",
				client: CLIENT,
				fetch: fetchMock,
			}),
		).rejects.toThrow(/https/u);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("keeps HTTP retry semantics even when the error body is oversized", async () => {
		await expect(
			initStepCliLogin({
				authBaseUrl: AUTH_BASE_URL,
				pollToken: "token",
				profile: "step_plan",
				client: CLIENT,
				fetch: async () => new Response("x".repeat(70 * 1024), { status: 503 }),
			}),
		).rejects.toMatchObject({ kind: "http", httpStatus: 503 });
	});

	it("bounds a request that never resolves and aborts its transport", async () => {
		vi.useFakeTimers();
		try {
			let signal: AbortSignal | undefined;
			const result = initStepCliLogin({
				authBaseUrl: AUTH_BASE_URL,
				pollToken: "token",
				profile: "step_plan",
				client: CLIENT,
				fetch: async (_, options) => {
					signal = options?.signal ?? undefined;
					return new Promise<Response>(() => {});
				},
			}).catch((error: unknown) => error);
			await vi.advanceTimersByTimeAsync(15_000);
			expect(await result).toMatchObject({ kind: "transport" });
			expect(signal?.aborted).toBe(true);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("bounds a stalled response body too", async () => {
		vi.useFakeTimers();
		try {
			const result = initStepCliLogin({
				authBaseUrl: AUTH_BASE_URL,
				pollToken: "token",
				profile: "step_plan",
				client: CLIENT,
				fetch: async () => new Response(new ReadableStream<Uint8Array>()),
			}).catch((error: unknown) => error);
			await vi.advanceTimersByTimeAsync(15_000);
			expect(await result).toMatchObject({ kind: "transport" });
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("Step CLI login poll", () => {
	it("maps pending, ready and failed states", async () => {
		const read = (body: unknown) =>
			pollStepCliLogin({
				authBaseUrl: AUTH_BASE_URL,
				pollToken: "token",
				flowId: "flow-1",
				fetch: async (input, init) => {
					expect(String(input)).toBe(`${AUTH_BASE_URL}${STEP_CLI_LOGIN_PATH_PREFIX}/poll/flow-1`);
					expect((init?.headers as Record<string, string>).authorization).toBe("Bearer token");
					return json(body);
				},
			});

		await expect(read({ status: 0, state: "pending" })).resolves.toEqual({ state: "pending" });
		await expect(
			read({ status: 0, state: "ready", uid: "u-1", profile: "step_plan", credential: { api_key: "sk-step" } }),
		).resolves.toEqual({ state: "ready", apiKey: "sk-step", uid: "u-1" });
		await expect(read({ status: 0, state: "failed", reason: "denied" })).resolves.toEqual({
			state: "failed",
			reason: "denied",
		});
		await expect(read({ status: 0, state: "failed", reason: "something-new" })).resolves.toEqual({
			state: "failed",
			reason: "unknown",
		});
	});

	it("treats a ready response without an api_key as a protocol error", async () => {
		await expect(
			pollStepCliLogin({
				authBaseUrl: AUTH_BASE_URL,
				pollToken: "token",
				flowId: "flow-1",
				fetch: async () => json({ status: 0, state: "ready", credential: {} }),
			}),
		).rejects.toMatchObject({ kind: "protocol" });
	});

	it("classifies retryable and fatal failures", () => {
		const make = (kind: "http" | "protocol" | "transport", httpStatus?: number) =>
			new StepCliLoginRequestError(kind, "boom", httpStatus === undefined ? {} : { httpStatus });
		expect(isRetryableStepCliLoginError(make("http", 429))).toBe(true);
		expect(isRetryableStepCliLoginError(make("http", 503))).toBe(true);
		expect(isRetryableStepCliLoginError(make("http", 408))).toBe(true);
		expect(isRetryableStepCliLoginError(make("transport"))).toBe(true);
		expect(isRetryableStepCliLoginError(make("http", 404))).toBe(false);
		expect(isRetryableStepCliLoginError(make("protocol"))).toBe(false);
		expect(isRetryableStepCliLoginError(new Error("unrelated"))).toBe(false);
	});

	it("classifies interrupted response bodies as retryable transport failures", async () => {
		const result = pollStepCliLogin({
			authBaseUrl: AUTH_BASE_URL,
			pollToken: "token",
			flowId: "flow-1",
			fetch: async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.error(new Error("socket closed"));
						},
					}),
				),
		}).catch((error: unknown) => error);
		expect(await result).toMatchObject({ kind: "transport" });
		expect(isRetryableStepCliLoginError(await result)).toBe(true);
	});
});

describe("Step CLI login polling loop", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());
	const defaults = () => ({
		init: { flowId: "flow-1", authorizeUrl: AUTH_BASE_URL, pollIntervalSec: 2, expiresAt: Date.now() / 1000 + 600 },
		authBaseUrl: AUTH_BASE_URL,
		pollToken: "token",
	});

	it("keeps polling through transient failures until a credential arrives", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(json({ desc: "busy" }, 429))
			.mockResolvedValueOnce(json({ state: "pending" }))
			.mockResolvedValueOnce(json({ state: "ready", credential: { api_key: "key" } }));
		const result = waitForStepCliLogin({ ...defaults(), fetch });
		await vi.advanceTimersByTimeAsync(4_000);
		expect(await result).toEqual({ state: "ready", apiKey: "key" });
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("never polls faster than the floor", async () => {
		const input = defaults();
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(json({ state: "pending" }))
			.mockResolvedValueOnce(json({ state: "ready", credential: { api_key: "key" } }));
		const result = waitForStepCliLogin({ ...input, init: { ...input.init, pollIntervalSec: 0 }, fetch });
		await vi.advanceTimersByTimeAsync(MIN_STEP_POLL_INTERVAL_MS - 1);
		expect(fetch).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(await result).toMatchObject({ apiKey: "key" });
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("stops at the server expiry", async () => {
		const input = defaults();
		const fetch = vi.fn(async () => json({ state: "pending" }));
		const result = waitForStepCliLogin({
			...input,
			init: { ...input.init, expiresAt: Date.now() / 1000 + 5 },
			fetch,
		}).catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(await result).toBeInstanceOf(Error);
		expect(await result).toMatchObject({ message: expect.stringContaining("timed out") });
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("surfaces a denied flow immediately", async () => {
		await expect(
			waitForStepCliLogin({ ...defaults(), fetch: async () => json({ state: "failed", reason: "denied" }) }),
		).rejects.toThrow("Sign-in was denied in the browser.");
	});

	it("does not retry a fatal poll failure", async () => {
		const fetch = vi.fn(async () => json({ desc: "gone" }, 404));
		await expect(waitForStepCliLogin({ ...defaults(), fetch })).rejects.toMatchObject({ httpStatus: 404 });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("cancels during the wait between polls", async () => {
		const controller = new AbortController();
		const fetch = vi.fn(async () => json({ state: "pending" }));
		const result = waitForStepCliLogin({ ...defaults(), fetch, signal: controller.signal }).catch(
			(error: unknown) => error,
		);
		await vi.advanceTimersByTimeAsync(0);
		controller.abort(new Error("cancelled by user"));
		expect(await result).toMatchObject({ message: "cancelled by user" });
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("expires even while a poll is hung", async () => {
		const input = defaults();
		let signal: AbortSignal | undefined;
		const result = waitForStepCliLogin({
			...input,
			init: { ...input.init, expiresAt: Date.now() / 1000 + 2 },
			fetch: async (_, options) => {
				signal = options?.signal ?? undefined;
				return new Promise<Response>(() => {});
			},
		}).catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(await result).toMatchObject({ message: expect.stringContaining("timed out") });
		expect(signal?.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("rejects a ready result that races with cancellation", async () => {
		const controller = new AbortController();
		await expect(
			waitForStepCliLogin({
				...defaults(),
				signal: controller.signal,
				fetch: async () => {
					controller.abort(new Error("cancelled"));
					return json({ state: "ready", credential: { api_key: "key" } });
				},
			}),
		).rejects.toThrow("cancelled");
	});
});

describe("Step cloud-only login", () => {
	afterEach(() => vi.restoreAllMocks());

	it("generates a fresh token per login and reuses it only for that flow", async () => {
		const existingApiKey = "a".repeat(64);
		const tokens: string[] = [];
		const fetchMock = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
			const headers = new Headers(options?.headers);
			const bearer = headers.get("authorization") ?? "";
			tokens.push(bearer);
			expect(headers.has("cookie")).toBe(false);
			expect(headers.has("oasis-token")).toBe(false);
			expect(options?.credentials).toBe("omit");
			expect(String(url)).not.toContain(bearer.slice(7));
			expect(String(options?.body ?? "")).not.toContain(bearer.slice(7));
			return String(url).endsWith("/init")
				? json(initBody())
				: json({ state: "ready", credential: { api_key: "key" } });
		});
		const options = { authBaseUrl: AUTH_BASE_URL, env: { STEP_API_KEY: existingApiKey }, fetch: fetchMock };
		await loginStepOAuth(callbacks(), options);
		await loginStepOAuth(callbacks(), options);
		expect(tokens).toHaveLength(4);
		expect(tokens[0]).toMatch(/^Bearer [0-9a-f]{64}$/u);
		expect(tokens[0]).toBe(tokens[1]);
		expect(tokens[2]).toBe(tokens[3]);
		expect(tokens[0]).not.toBe(tokens[2]);
		expect(tokens).not.toContain(`Bearer ${existingApiKey}`);
	});

	it("opens the fixed approval path on the selected developer-center origin", async () => {
		const authorizeUrl = `${AUTH_BASE_URL}/cli-login-remote?flow_id=flow-1`;
		const onAuth = vi.fn();
		await loginStepOAuth(callbacks({ onAuth }), {
			authBaseUrl: AUTH_BASE_URL,
			fetch: async (url) =>
				String(url).endsWith("/init")
					? json(initBody())
					: json({ status: 0, state: "ready", credential: { api_key: "polled-key" } }),
		});
		expect(onAuth).toHaveBeenCalledWith(expect.objectContaining({ url: authorizeUrl }));
	});

	function forbidLocalServer() {
		return vi.spyOn(Server.prototype, "listen").mockImplementation(() => {
			throw new Error("Step login must never listen on a local port");
		});
	}

	it.each([undefined, "loopback", "auto", "poll"])(
		"uses the cloud regardless of removed mode setting %s",
		async (legacyMode) => {
			const listen = forbidLocalServer();
			const fetchMock = vi.fn(async (input: string | URL | Request) =>
				String(input).endsWith("/init")
					? json(initBody())
					: json({ status: 0, state: "ready", uid: "u-9", credential: { api_key: "polled-key" } }),
			);
			const onAuth = vi.fn();
			const options = resolveStepProviderOptions({
				authBaseUrl: AUTH_BASE_URL,
				loginProfile: "step_plan",
				client: CLIENT,
				env: { STEPCODE_CLI_LOGIN_MODE: legacyMode, STEP_OAUTH_CALLBACK_PORT: "invalid-old-setting" },
				fetch: fetchMock,
			});
			const credential = await loginStepOAuth(callbacks({ onAuth }), options);
			expect(credential.access).toBe("polled-key");
			expect(credential.uid).toBe("u-9");
			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(listen).not.toHaveBeenCalled();
			for (const removed of [
				"cliLoginMode",
				"callbackHost",
				"callbackPort",
				"createState",
				"createCallbackServer",
				"allowManualCallback",
				"createPollToken",
			]) {
				expect(options).not.toHaveProperty(removed);
			}
			expect(onAuth).toHaveBeenCalledWith(
				expect.objectContaining({ url: `${AUTH_BASE_URL}/cli-login-remote?flow_id=flow-1` }),
			);
		},
	);

	it.each([404, 405, 501])("reports unsupported cloud HTTP %s without opening a local server", async (status) => {
		const listen = forbidLocalServer();
		const onAuth = vi.fn();
		await expect(
			loginStepOAuth(callbacks({ onAuth }), {
				authBaseUrl: AUTH_BASE_URL,
				fetch: async () => json({ desc: "not supported" }, status),
			}),
		).rejects.toMatchObject({ httpStatus: status });
		expect(onAuth).not.toHaveBeenCalled();
		expect(listen).not.toHaveBeenCalled();
	});

	it.each(["protocol", "transport"])("surfaces an init %s failure without fallback", async (kind) => {
		const listen = forbidLocalServer();
		const onAuth = vi.fn();
		await expect(
			loginStepOAuth(callbacks({ onAuth }), {
				authBaseUrl: AUTH_BASE_URL,
				fetch: async () => {
					if (kind === "transport") throw new Error("network unavailable");
					return new Response("<html>Unsupported endpoint</html>");
				},
			}),
		).rejects.toMatchObject({ kind });
		expect(onAuth).not.toHaveBeenCalled();
		expect(listen).not.toHaveBeenCalled();
	});

	it("surfaces a denied cloud flow", async () => {
		const listen = forbidLocalServer();
		await expect(
			loginStepOAuth(callbacks(), {
				authBaseUrl: AUTH_BASE_URL,
				fetch: async (url) =>
					String(url).endsWith("/init")
						? json(initBody())
						: json({ status: 0, state: "failed", reason: "denied" }),
			}),
		).rejects.toThrow("Sign-in was denied in the browser.");
		expect(listen).not.toHaveBeenCalled();
	});

	it("includes init in the login deadline", async () => {
		vi.useFakeTimers();
		try {
			const listen = forbidLocalServer();
			const result = loginStepOAuth(callbacks(), {
				authBaseUrl: AUTH_BASE_URL,
				timeoutMs: 1_000,
				fetch: async () => new Promise<Response>(() => {}),
			}).catch((error: unknown) => error);
			await vi.advanceTimersByTimeAsync(1_000);
			expect(await result).toMatchObject({ message: expect.stringContaining("timed out") });
			expect(listen).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not use echoed profile metadata as an authentication check", async () => {
		await expect(
			loginStepOAuth(callbacks(), {
				authBaseUrl: AUTH_BASE_URL,
				loginProfile: "step_plan",
				fetch: async (url) =>
					String(url).endsWith("/init")
						? json(initBody())
						: json({
								status: 0,
								state: "ready",
								profile: "step_plan_oversea",
								credential: { api_key: "wrong-region" },
							}),
			}),
		).resolves.toMatchObject({ access: "wrong-region" });
	});
});
