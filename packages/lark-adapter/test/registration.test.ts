import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { LarkRegistration, larkCallbackSetupUrl } from "../src/registration.ts";

describe("Lark device registration", () => {
	it.each(["feishu", "lark"] as const)(
		"builds the official prefilled callback launcher for %s without credentials",
		(brand) => {
			const url = new URL(larkCallbackSetupUrl({ appId: "cli_fixture", appSecret: "sensitive", brand }));
			expect(url.origin).toBe(brand === "feishu" ? "https://open.feishu.cn" : "https://open.larksuite.com");
			expect(url.pathname).toBe("/page/launcher");
			expect(url.searchParams.get("clientID")).toBe("cli_fixture");
			const addons = JSON.parse(
				gunzipSync(Buffer.from(url.searchParams.get("addons") ?? "", "base64url")).toString(),
			);
			expect(addons).toEqual({ callbacks: { items: ["card.action.trigger"] } });
			expect(url.href).not.toContain("sensitive");
		},
	);
	it("continues polling after an HTTP 400 authorization-pending response", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch");
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					error: "authorization_pending",
					user_info: { tenant_brand: "larksuite" },
					client_id: "untrusted",
					client_secret: "untrusted",
				}),
				{ status: 400 },
			),
		);
		fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ client_id: "app", client_secret: "fixture" })));
		try {
			const registration = new LarkRegistration({ version: "test" });
			const signal = new AbortController().signal;
			expect(await registration.poll("device", signal)).toEqual({ status: "pending" });
			expect(await registration.poll("device", signal)).toMatchObject({ status: "authorized" });
			expect(fetchMock.mock.calls[1]?.[0]).toBe("https://accounts.larksuite.com/oauth/v1/app/registration");
		} finally {
			fetchMock.mockRestore();
		}
	});

	it.each(["authorization_pending", "slow_down", "access_denied", "expired_token"])(
		"parses HTTP 400 %s without accepting credentials from failed requests",
		async (error) => {
			const fetchMock = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValueOnce(new Response(JSON.stringify({ error }), { status: 400 }));
			try {
				const registration = new LarkRegistration({ version: "test" });
				expect(await registration.poll("device", new AbortController().signal)).toMatchObject({
					status: {
						authorization_pending: "pending",
						slow_down: "slow-down",
						access_denied: "denied",
						expired_token: "expired",
					}[error],
				});
			} finally {
				fetchMock.mockRestore();
			}
		},
	);

	it.each([400, 401, 500])("rejects unrecognized HTTP %s responses without echoing response data", async (status) => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ client_id: "app", client_secret: "sensitive" }), { status }),
			);
		try {
			const registration = new LarkRegistration({ version: "test" });
			await expect(registration.poll("device", new AbortController().signal)).rejects.toThrow(
				`Lark pairing request failed (HTTP ${status})`,
			);
		} finally {
			fetchMock.mockRestore();
		}
	});

	it("begins on Feishu and builds a CLI verification URL", async () => {
		const post = vi.fn(async (_url: string, _form: Record<string, string>, _signal: AbortSignal) => ({
			device_code: "device",
			user_code: "code",
			expires_in: 120,
			interval: 2,
		}));
		const registration = new LarkRegistration({ version: "0.84.4", post });
		const result = await registration.begin(new AbortController().signal);
		expect(post.mock.calls[0]?.[0]).toBe("https://accounts.feishu.cn/oauth/v1/app/registration");
		expect(result).toMatchObject({ deviceCode: "device", expiresInSeconds: 120, pollIntervalSeconds: 2 });
		expect(new URL(result.verificationUrl).searchParams.get("user_code")).toBe("code");
		expect(new URL(result.verificationUrl).searchParams.get("from")).toBe("cli");
	});

	it("switches brand when the first response carrying tenant information arrives", async () => {
		const responses = [
			{ error: "authorization_pending" },
			{ error: "authorization_pending", user_info: { tenant_brand: "larksuite" } },
			{ client_id: "app", client_secret: "secret", user_info: { tenant_brand: "feishu" } },
		];
		const urls: string[] = [];
		const registration = new LarkRegistration({
			version: "0.84.4",
			post: async (url) => {
				urls.push(url);
				return responses.shift() ?? {};
			},
		});
		const signal = new AbortController().signal;
		await registration.poll("device", signal);
		await registration.poll("device", signal);
		expect(await registration.poll("device", signal)).toEqual({
			status: "authorized",
			credentials: { appId: "app", appSecret: "secret", brand: "lark" },
		});
		expect(urls[2]).toBe("https://accounts.larksuite.com/oauth/v1/app/registration");
	});

	it("returns slow-down, denial and expiry as distinct outcomes", async () => {
		for (const [error, status] of [
			["slow_down", "slow-down"],
			["access_denied", "denied"],
			["expired_token", "expired"],
		] as const) {
			const registration = new LarkRegistration({ version: "test", post: async () => ({ error }) });
			expect(await registration.poll("device", new AbortController().signal)).toMatchObject({ status });
		}
	});

	it("rejects malformed begin data without echoing secrets", async () => {
		const registration = new LarkRegistration({
			version: "test",
			post: async () => ({ client_secret: "sensitive" }),
		});
		await expect(registration.begin(new AbortController().signal)).rejects.toThrow("Invalid Lark pairing response");
	});

	it("rejects invalid lifetimes rather than creating a tight poll loop", async () => {
		const registration = new LarkRegistration({
			version: "test",
			post: async () => ({ device_code: "device", user_code: "code", interval: 0, expires_in: -1 }),
		});
		await expect(registration.begin(new AbortController().signal)).rejects.toThrow("Invalid Lark pairing response");
	});

	it("does not start a request after cancellation", async () => {
		const post = vi.fn(async () => ({}));
		const registration = new LarkRegistration({ version: "test", post });
		const controller = new AbortController();
		controller.abort();
		await expect(registration.begin(controller.signal)).rejects.toThrow();
		expect(post).not.toHaveBeenCalled();
	});

	it("waits between polls and increases the interval after slow-down", async () => {
		vi.useFakeTimers();
		try {
			const post = vi.fn(async () => ({ error: "slow_down" }));
			const registration = new LarkRegistration({ version: "test", post });
			const controller = new AbortController();
			const result = registration.waitForAuthorization(
				{
					deviceCode: "device",
					verificationUrl: "https://open.feishu.cn",
					expiresInSeconds: 30,
					pollIntervalSeconds: 2,
				},
				controller.signal,
			);
			const cancelled = expect(result).rejects.toThrow();
			await vi.advanceTimersByTimeAsync(1999);
			expect(post).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(post).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(6999);
			expect(post).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(post).toHaveBeenCalledTimes(2);
			controller.abort();
			await cancelled;
		} finally {
			vi.useRealTimers();
		}
	});

	it("returns authorized credentials and expires without polling after the deadline", async () => {
		vi.useFakeTimers();
		try {
			const code = {
				deviceCode: "device",
				verificationUrl: "https://open.feishu.cn",
				expiresInSeconds: 3,
				pollIntervalSeconds: 2,
			};
			const post = vi.fn(async () => ({ client_id: "app", client_secret: "fixture" }));
			const registration = new LarkRegistration({ version: "test", post });
			const result = registration.waitForAuthorization(code, new AbortController().signal);
			await vi.advanceTimersByTimeAsync(2000);
			expect(await result).toMatchObject({ status: "authorized", credentials: { appId: "app" } });
			post.mockClear();
			const expired = registration.waitForAuthorization(
				{ ...code, pollIntervalSeconds: 5 },
				new AbortController().signal,
			);
			await vi.advanceTimersByTimeAsync(3000);
			expect(await expired).toEqual({ status: "expired" });
			expect(post).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});
