import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as settingsManager from "../src/core/settings-manager.ts";
import { acquireSettingsLockSync } from "../src/core/settings-manager.ts";
import type { StepCliLoginState } from "../src/features/step-provider/index.ts";
import {
	buildStepLoginState,
	clearStepLoginState,
	getStepLoginStatePath,
	getStepLoginToken,
	readStepLoginState,
	type StepLoginState,
	saveStepLoginState,
} from "../src/step/login-state.ts";

/** Minimal unsigned JWTs; only `exp` is read, and only to schedule a refresh. */
let tokenCounter = 0;
function jwt(payload: Record<string, unknown>): string {
	const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString("base64url");
	// A per-call nonce keeps two tokens minted in the same second distinct, which
	// is what "has this session been replaced?" relies on.
	return `header.${encode({ ...payload, jti: `t${tokenCounter++}` })}.signature`;
}

function accessToken(expiresInSec: number): string {
	return jwt({ exp: Math.floor(Date.now() / 1000) + expiresInSec });
}

function refreshToken(expiresInSec = 30 * 24 * 60 * 60): string {
	return jwt({ exp: Math.floor(Date.now() / 1000) + expiresInSec });
}

function loginState(overrides: Partial<StepCliLoginState> = {}): StepCliLoginState {
	return {
		accessToken: accessToken(1800),
		refreshToken: refreshToken(),
		deviceId: "device-1",
		appId: "10300",
		expiresIn: 1800,
		...overrides,
	};
}

/** A signed-in refresh response. */
function signedIn(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		accessToken: { raw: accessToken(1800), duration: 1800, mode: 2 },
		refreshToken: { raw: refreshToken() },
		...overrides,
	};
}

/** A successful Connect-RPC envelope from passport. */
function ok(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function stored(overrides: Partial<StepLoginState> = {}): StepLoginState {
	return {
		version: 1,
		profile: "step_plan",
		appId: "10300",
		deviceId: "device-1",
		accessToken: accessToken(1800),
		refreshToken: refreshToken(),
		accessExpiresAt: Math.floor(Date.now() / 1000) + 1800,
		refreshExpiresAt: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
		...overrides,
	};
}

let dir: string;
let env: Record<string, string | undefined>;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "step-login-state-"));
	env = { STEPCODE_LOGIN_STATE_PATH: join(dir, "step-login.json") };
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	vi.unstubAllGlobals();
});

describe("step login state storage", () => {
	it("reports missing when nothing was ever signed in", () => {
		expect(readStepLoginState(env)).toBeUndefined();
	});

	it("round-trips a session and keeps the file owner-only", async () => {
		await saveStepLoginState(stored(), env);
		expect(readStepLoginState(env)).toMatchObject({ profile: "step_plan", appId: "10300", deviceId: "device-1" });
		// A refresh token lives here, so the mode is part of the contract.
		expect(statSync(getStepLoginStatePath(env)).mode & 0o777).toBe(0o600);
	});

	it("treats an unreadable or wrongly shaped file as no session", async () => {
		await saveStepLoginState(stored(), env);
		writeFileSync(getStepLoginStatePath(env), "{ not json", "utf8");
		expect(readStepLoginState(env)).toBeUndefined();

		await saveStepLoginState(stored(), env);
		writeFileSync(getStepLoginStatePath(env), JSON.stringify({ version: 1, appId: "10300" }), "utf8");
		expect(readStepLoginState(env)).toBeUndefined();
	});

	it("refuses a file written by a newer version", async () => {
		await saveStepLoginState(stored(), env);
		writeFileSync(
			getStepLoginStatePath(env),
			JSON.stringify({ ...stored(), version: 99, somethingNew: true }),
			"utf8",
		);
		// Reading a future shape as the current one would either pass by luck or
		// silently drop the session.
		expect(readStepLoginState(env)).toBeUndefined();
	});

	it("derives the session path from the credential path when only that is set", async () => {
		// A host that isolates auth.json must isolate the session too, or two
		// instances would overwrite each other's identity.
		const authPath = join(dir, "nested", "auth.json");
		expect(getStepLoginStatePath({ STEPCODE_AUTH_PATH: authPath })).toBe(join(dir, "nested", "step-login.json"));
		expect(getStepLoginStatePath({ STEPCODE_LOGIN_STATE_PATH: "/explicit.json" })).toBe("/explicit.json");
	});

	it("reports whether the session was actually removed", async () => {
		await saveStepLoginState(stored(), env);
		expect(await clearStepLoginState(env)).toBe(true);
		expect(readStepLoginState(env)).toBeUndefined();
		// Nothing left to remove is still a successful removal.
		expect(await clearStepLoginState(env)).toBe(true);

		await saveStepLoginState(stored(), env);
		const release = acquireSettingsLockSync(getStepLoginStatePath(env));
		try {
			expect(await clearStepLoginState(env)).toBe(false);
		} finally {
			release();
		}
		expect(readStepLoginState(env)).toBeDefined();
	});

	it("reports whether the session was actually written", async () => {
		expect(await saveStepLoginState(stored(), env)).toBe(true);
		expect(readStepLoginState(env)).toBeDefined();

		// Another process holds the lock: the caller must be able to tell that
		// nothing was written, or a sign-in would report success with a stale
		// session still on disk.
		const release = acquireSettingsLockSync(getStepLoginStatePath(env));
		try {
			expect(await saveStepLoginState(stored({ refreshToken: refreshToken() }), env)).toBe(false);
		} finally {
			release();
		}
	});

	it("drops the previous session when a new sign-in is persisted", async () => {
		const envA = { STEPCODE_LOGIN_STATE_PATH: join(dir, "a.json") };
		const envB = { STEPCODE_LOGIN_STATE_PATH: join(dir, "b.json") };
		await saveStepLoginState(stored({ refreshToken: refreshToken() }), envA);
		await saveStepLoginState(stored({ refreshToken: refreshToken(), profile: "step_plan_oversea" }), envB);
		// A stale session from another account must never outlive the new sign-in.
		await clearStepLoginState(envA);
		expect(readStepLoginState(envA)).toBeUndefined();
		expect(readStepLoginState(envB)).toMatchObject({ profile: "step_plan_oversea" });
	});

	it("keeps the api key out of this file's business: clearing only removes the session", async () => {
		await saveStepLoginState(stored(), env);
		await clearStepLoginState(env);
		expect(readStepLoginState(env)).toBeUndefined();
	});

	it("builds a stored session from what the login flow redeemed", () => {
		const now = Date.now();
		const state = buildStepLoginState(loginState(), "step_plan_oversea", now);
		expect(state.profile).toBe("step_plan_oversea");
		expect(state.accessExpiresAt).toBe(Math.floor(now / 1000) + 1800);
		expect(state.refreshExpiresAt).toBeGreaterThan(Math.floor(now / 1000));
	});

	it("falls back to a default lifetime when the server reports none", () => {
		const state = buildStepLoginState(loginState({ expiresIn: undefined }), "step_plan");
		expect(state.accessExpiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
	});
});

describe("getStepLoginToken", () => {
	it("returns missing without touching the network", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		expect(await getStepLoginToken({ env })).toEqual({ status: "missing" });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("returns a fresh token without refreshing", async () => {
		await saveStepLoginState(stored(), env);
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const outcome = await getStepLoginToken({ env });
		expect(outcome.status).toBe("ready");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("refreshes a token that is close to expiry and persists the result", async () => {
		const state = stored({
			accessExpiresAt: Math.floor(Date.now() / 1000) + 60,
			accessToken: accessToken(60),
		});
		await saveStepLoginState(state, env);
		const fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
			expect(String(url)).toContain("/passport/proto.api.passport.v1.PassportService/RefreshToken");
			const cookie = new Headers(init?.headers).get("cookie") ?? "";
			expect(cookie).toContain("Oasis-Token=");
			// The cookie carries both halves, joined the way passport joins them.
			expect(cookie.split("...")).toHaveLength(2);
			expect(new Headers(init?.headers).get("Oasis-appID")).toBe("10300");
			expect(new Headers(init?.headers).get("Oasis-Webid")).toBe("device-1");
			return new Response(
				JSON.stringify({
					accessToken: { raw: accessToken(1800), duration: 1800, mode: 2 },
					refreshToken: { raw: refreshToken() },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		vi.stubGlobal("fetch", fetchSpy);

		const outcome = await getStepLoginToken({ env });
		expect(outcome.status).toBe("ready");
		if (outcome.status !== "ready") return;
		expect(outcome.accessToken).toBe(readStepLoginState(env)?.accessToken);
		expect(readStepLoginState(env)?.accessExpiresAt).toBeGreaterThan(state.accessExpiresAt);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("drops the session when the refresh comes back anonymous", async () => {
		await saveStepLoginState(
			stored({ accessExpiresAt: Math.floor(Date.now() / 1000) + 60, accessToken: accessToken(60) }),
			env,
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							accessToken: { raw: accessToken(1800), duration: 1800, mode: 1 },
							refreshToken: { raw: refreshToken() },
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
			),
		);

		// Passport answers an unredeemable refresh with an anonymous session
		// instead of an error, so the mode is the only signal there is.
		expect(await getStepLoginToken({ env })).toEqual({
			status: "expired",
			reason: expect.stringContaining("no longer signed in"),
		});
		expect(readStepLoginState(env)).toBeUndefined();
	});

	it("keeps the session when the refresh fails transiently", async () => {
		// Already past expiry, so there is nothing valid to hand back.
		await saveStepLoginState(
			stored({ accessExpiresAt: Math.floor(Date.now() / 1000) - 1, accessToken: accessToken(-1) }),
			env,
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("", { status: 503 })),
		);

		expect(await getStepLoginToken({ env })).toEqual({
			status: "unavailable",
			reason: expect.stringContaining("503"),
		});
		expect(readStepLoginState(env)).toBeDefined();
	});

	it("hands back the still-valid token when a transient refresh fails", async () => {
		// Inside the refresh margin the access token is still good for minutes,
		// so reporting no identity at all would be a needless outage.
		await saveStepLoginState(
			stored({ accessExpiresAt: Math.floor(Date.now() / 1000) + 120, accessToken: accessToken(120) }),
			env,
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("", { status: 503 })),
		);

		const outcome = await getStepLoginToken({ env });
		expect(outcome.status).toBe("ready");
		expect(readStepLoginState(env)).toBeDefined();
	});

	it("does not resurrect a session that was signed out while the refresh was running", async () => {
		const state = stored({
			accessExpiresAt: Math.floor(Date.now() / 1000) + 60,
			accessToken: accessToken(60),
		});
		await saveStepLoginState(state, env);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				// The user signs out from another process mid-refresh.
				await clearStepLoginState(env);
				return new Response(
					JSON.stringify({
						accessToken: { raw: accessToken(1800), duration: 1800, mode: 2 },
						refreshToken: { raw: refreshToken() },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}),
		);

		expect(await getStepLoginToken({ env })).toEqual({ status: "missing" });
		expect(readStepLoginState(env)).toBeUndefined();
	});

	it("recomputes the refresh deadline from the token the server returned", async () => {
		// The refresh token is not rotated today. Once it is, inheriting the old
		// deadline would discard a session the server still considers live.
		const shortLived = stored({
			accessExpiresAt: Math.floor(Date.now() / 1000) + 60,
			accessToken: accessToken(60),
			refreshExpiresAt: Math.floor(Date.now() / 1000) + 3600,
		});
		await saveStepLoginState(shortLived, env);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				ok({
					accessToken: { raw: accessToken(1800), duration: 1800, mode: 2 },
					refreshToken: { raw: refreshToken(30 * 24 * 60 * 60) },
				}),
			),
		);

		expect((await getStepLoginToken({ env })).status).toBe("ready");
		const committed = readStepLoginState(env);
		expect(committed?.refreshExpiresAt).toBeGreaterThan(shortLived.refreshExpiresAt!);
	});

	it("keeps a session that was replaced while an unredeemable refresh was running", async () => {
		const dead = stored({
			accessExpiresAt: Math.floor(Date.now() / 1000) + 60,
			accessToken: accessToken(60),
		});
		await saveStepLoginState(dead, env);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				// Another account signs in from another process mid-refresh.
				await saveStepLoginState(
					stored({ accessToken: accessToken(1800), refreshToken: refreshToken(), profile: "step_plan_oversea" }),
					env,
				);
				return new Response(
					JSON.stringify({
						accessToken: { raw: "anon", duration: 1800, mode: 1 },
						refreshToken: { raw: refreshToken() },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}),
		);

		// The dead session is dropped, but the newer one must survive: deleting
		// unconditionally would silently sign the new account back out.
		expect(await getStepLoginToken({ env })).toMatchObject({ status: "ready", profile: "step_plan_oversea" });
		expect(readStepLoginState(env)?.profile).toBe("step_plan_oversea");
	});

	it("hands back the still-valid token when another process holds the commit lock", async () => {
		const state = stored({
			accessExpiresAt: Math.floor(Date.now() / 1000) + 120,
			accessToken: accessToken(120),
		});
		await saveStepLoginState(state, env);
		// Simulate losing the lock: the file stays, so the local token is still
		// usable and reporting "unavailable" would be a needless outage.
		const path = getStepLoginStatePath(env);
		const release = acquireSettingsLockSync(path);
		try {
			const outcome = await getStepLoginToken({
				env,
				fetch: (async () => new Response("", { status: 503 })) as typeof fetch,
			});
			expect(outcome.status).toBe("ready");
		} finally {
			release();
		}
	});

	it("does not overwrite a session that changed while the refresh was running", async () => {
		await saveStepLoginState(
			stored({ accessExpiresAt: Math.floor(Date.now() / 1000) + 60, accessToken: accessToken(60) }),
			env,
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				// Another account signs in from another process mid-refresh.
				await saveStepLoginState(
					stored({ accessToken: accessToken(1800), refreshToken: refreshToken(), profile: "step_plan_oversea" }),
					env,
				);
				return new Response(
					JSON.stringify({
						accessToken: { raw: accessToken(1800), duration: 1800, mode: 2 },
						refreshToken: { raw: refreshToken() },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}),
		);

		expect((await getStepLoginToken({ env })).status).toBe("ready");
		// The newer session survives; the stale refresh result is discarded.
		expect(readStepLoginState(env)?.profile).toBe("step_plan_oversea");
	});

	it("asks for a new sign-in once the refresh token itself has expired", async () => {
		await saveStepLoginState(
			stored({
				accessExpiresAt: Math.floor(Date.now() / 1000) + 60,
				accessToken: accessToken(60),
				// Past the clock skew, so a fast machine cannot keep it alive.
				refreshExpiresAt: Math.floor(Date.now() / 1000) - 2 * 60 * 60,
			}),
			env,
		);
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);

		expect((await getStepLoginToken({ env })).status).toBe("expired");
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(readStepLoginState(env)).toBeUndefined();
	});

	it("keeps a session whose refresh token only looks expired to a fast clock", async () => {
		// The deadline is server-issued; a machine running fast must not retire a
		// session the server still honours.
		await saveStepLoginState(
			stored({
				accessExpiresAt: Math.floor(Date.now() / 1000) + 60,
				accessToken: accessToken(60),
				refreshExpiresAt: Math.floor(Date.now() / 1000) - 60,
			}),
			env,
		);
		const fetchSpy = vi.fn(async () => ok(signedIn()));
		vi.stubGlobal("fetch", fetchSpy);

		expect((await getStepLoginToken({ env })).status).toBe("ready");
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(readStepLoginState(env)).toBeDefined();
	});

	it("reports expired even when removing the dead session fails outright", async () => {
		// A filesystem failure while discarding must not surface as a transient
		// error: the fallback would hand out a token the server just rejected.
		await saveStepLoginState(
			stored({ accessExpiresAt: Math.floor(Date.now() / 1000) + 60, accessToken: accessToken(60) }),
			env,
		);
		vi.spyOn(settingsManager, "acquireSettingsLockSync").mockImplementation(() => {
			throw Object.assign(new Error("permission denied"), { code: "EACCES" });
		});
		try {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () =>
					ok({ accessToken: { raw: "anon", duration: 1800, mode: 1 }, refreshToken: { raw: refreshToken() } }),
				),
			);
			expect(await getStepLoginToken({ env })).toMatchObject({ status: "expired" });
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("reports expired rather than ready when a dead session cannot be removed", async () => {
		await saveStepLoginState(
			stored({ accessExpiresAt: Math.floor(Date.now() / 1000) + 60, accessToken: accessToken(60) }),
			env,
		);
		const path = getStepLoginStatePath(env);
		// Hold the lock so the discard cannot proceed, then have the server say the
		// session is anonymous. Falling back to the stored token would hand out a
		// credential the server just rejected.
		const release = acquireSettingsLockSync(path);
		try {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () =>
					ok({ accessToken: { raw: "anon", duration: 1800, mode: 1 }, refreshToken: { raw: refreshToken() } }),
				),
			);
			expect(await getStepLoginToken({ env })).toMatchObject({ status: "expired" });
		} finally {
			release();
		}
	});
});
