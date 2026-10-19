import { describe, expect, it, vi } from "vitest";
import { refreshStepLoginState, type StepCliLoginState } from "../src/step-provider/index.ts";

const AUTH_BASE_URL = "https://auth.example.test";

function state(overrides: Partial<StepCliLoginState> = {}): StepCliLoginState {
	return {
		accessToken: "access-jwt",
		refreshToken: "refresh-jwt",
		deviceId: "device-1",
		appId: "10300",
		...overrides,
	};
}

function ok(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function signedIn(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		accessToken: { raw: "new-access-jwt", duration: 1800, mode: 2 },
		refreshToken: { raw: "new-refresh-jwt" },
		...overrides,
	};
}

describe("refreshStepLoginState", () => {
	it("rebuilds the Oasis cookie from the two stored tokens", async () => {
		const fetchImpl = vi.fn(async (_input: string | URL, init?: RequestInit) => {
			expect(String(_input)).toBe(`${AUTH_BASE_URL}/passport/proto.api.passport.v1.PassportService/RefreshToken`);
			const headers = new Headers(init?.headers);
			expect(headers.get("cookie")).toBe("Oasis-Token=access-jwt...refresh-jwt");
			expect(headers.get("Oasis-appID")).toBe("10300");
			expect(headers.get("Oasis-Platform")).toBe("web");
			expect(headers.get("Oasis-Webid")).toBe("device-1");
			expect(init?.body).toBe("{}");
			return ok(signedIn());
		});
		vi.stubGlobal("fetch", fetchImpl);

		await expect(refreshStepLoginState({ authBaseUrl: AUTH_BASE_URL, state: state() })).resolves.toEqual({
			accessToken: "new-access-jwt",
			refreshToken: "new-refresh-jwt",
			deviceId: "device-1",
			appId: "10300",
			expiresIn: 1800,
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("keeps the device and app identity across refreshes", async () => {
		vi.stubGlobal("fetch", async () => ok(signedIn()));
		const refreshed = await refreshStepLoginState({
			authBaseUrl: AUTH_BASE_URL,
			state: state({ deviceId: "device-9", appId: "20700" }),
		});
		expect(refreshed.deviceId).toBe("device-9");
		expect(refreshed.appId).toBe("20700");
	});

	it("falls back to a default lifetime when the server reports none", async () => {
		vi.stubGlobal("fetch", async () => ok(signedIn({ accessToken: { raw: "new-access-jwt", mode: 2 } })));
		const refreshed = await refreshStepLoginState({ authBaseUrl: AUTH_BASE_URL, state: state() });
		expect(refreshed.expiresIn).toBe(1800);
	});

	it("treats an anonymous refresh as unredeemable, not as a new session", async () => {
		vi.stubGlobal("fetch", async () => ok(signedIn({ accessToken: { raw: "anon", duration: 1800, mode: 1 } })));
		await expect(refreshStepLoginState({ authBaseUrl: AUTH_BASE_URL, state: state() })).rejects.toMatchObject({
			name: "StepLoginRefreshError",
			failure: "unredeemable",
		});
	});

	it("treats a missing refresh token as a still-valid session, not a dead one", async () => {
		// The refresh token is not rotated today, so a response without one says
		// nothing about the session being dead.
		vi.stubGlobal("fetch", async () => ok({ accessToken: { raw: "new-access-jwt", duration: 1800, mode: 2 } }));
		await expect(refreshStepLoginState({ authBaseUrl: AUTH_BASE_URL, state: state() })).resolves.toMatchObject({
			accessToken: "new-access-jwt",
			refreshToken: "refresh-jwt",
		});
	});

	it("treats an unexpected 200 body as transient rather than a dead session", async () => {
		// A gateway or proxy answering 200 with its own envelope must not cost the
		// user their long-lived credential.
		for (const body of ['{"code":1,"msg":"busy"}', "[]", "null", '"text"', "{}"]) {
			vi.stubGlobal(
				"fetch",
				async () => new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
			);
			await expect(refreshStepLoginState({ authBaseUrl: AUTH_BASE_URL, state: state() })).rejects.toMatchObject({
				failure: "transient",
			});
		}
	});

	it("treats every HTTP failure as transient, because only the mode proves a dead session", async () => {
		// A 4xx here is far more likely to be a gateway, region or WAF rejection
		// than a dead session, and dropping a long-lived refresh token on that
		// guess would sign the user out for no reason.
		for (const status of [400, 401, 403, 404, 405, 408, 409, 429, 500, 503]) {
			vi.stubGlobal("fetch", async () => new Response("", { status }));
			await expect(refreshStepLoginState({ authBaseUrl: AUTH_BASE_URL, state: state() })).rejects.toMatchObject({
				failure: "transient",
				httpStatus: status,
			});
		}
	});

	it("treats an unreadable body as transient", async () => {
		vi.stubGlobal("fetch", async () => new Response("not json", { status: 200 }));
		await expect(refreshStepLoginState({ authBaseUrl: AUTH_BASE_URL, state: state() })).rejects.toMatchObject({
			failure: "transient",
		});
	});

	it("never puts a token in the URL", async () => {
		const calls: Array<string | URL> = [];
		vi.stubGlobal("fetch", async (input: string | URL) => {
			calls.push(input);
			return ok(signedIn());
		});
		await refreshStepLoginState({ authBaseUrl: AUTH_BASE_URL, state: state() });
		const url = String(calls[0]);
		expect(url).not.toContain("access-jwt");
		expect(url).not.toContain("refresh-jwt");
	});

	it("refuses a plain-HTTP developer center", async () => {
		await expect(refreshStepLoginState({ authBaseUrl: "http://auth.example.test", state: state() })).rejects.toThrow(
			/must use https/,
		);
	});
});
