import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { type StepLoginState, saveStepLoginState } from "../src/step/login-state.ts";
import { getStepLoginStatus } from "../src/step/login-status.ts";

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Isolate the account session as well, or a real `~/.stepcode` would leak in. */
async function isolatedEnv(): Promise<Record<string, string | undefined>> {
	const dir = await mkdtemp(join(tmpdir(), "step-status-"));
	dirs.push(dir);
	return { STEPCODE_LOGIN_STATE_PATH: join(dir, "step-login.json") };
}

function response(status: number): Response {
	return new Response(null, { status });
}

function session(overrides: Partial<StepLoginState> = {}): StepLoginState {
	const now = Math.floor(Date.now() / 1000);
	return {
		version: 1,
		profile: "step_plan",
		appId: "10300",
		deviceId: "device-1",
		accessToken: "access",
		refreshToken: "refresh",
		accessExpiresAt: now + 1800,
		refreshExpiresAt: now + 30 * 24 * 60 * 60,
		...overrides,
	};
}

describe("Step login status", () => {
	test("reports missing credentials", async () => {
		const dir = await mkdtemp(join(tmpdir(), "step-status-"));
		dirs.push(dir);
		expect(
			await getStepLoginStatus({
				authPath: join(dir, "auth.json"),
				env: { STEPCODE_LOGIN_STATE_PATH: join(dir, "step-login.json") },
			}),
		).toEqual({
			loggedIn: false,
			loginMethod: null,
			validity: "missing",
			session: { state: "missing" },
		});
	});

	test("checks OAuth file credentials and keeps account metadata", async () => {
		const dir = await mkdtemp(join(tmpdir(), "step-status-"));
		dirs.push(dir);
		const authPath = join(dir, "auth.json");
		await AuthStorage.create(authPath).modify("step", async () => ({
			type: "oauth",
			access: "secret-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
			uid: "user-123",
		}));
		const status = await getStepLoginStatus({
			authPath,
			fetch: async () => response(200),
		});
		expect(status).toMatchObject({
			loggedIn: true,
			loginMethod: "step_plan",
			account: "user-123",
			validity: "valid",
		});
	});

	test("distinguishes invalid and unavailable environment credentials", async () => {
		const invalid = await getStepLoginStatus({
			authPath: "/missing",
			env: { STEP_API_KEY: "env-secret" },
			fetch: async () => response(401),
		});
		expect(invalid).toMatchObject({ loginMethod: "api_key", validity: "invalid" });
		const unavailable = await getStepLoginStatus({
			authPath: "/missing",
			env: { STEP_API_KEY: "env-secret" },
			fetch: async () => {
				throw new Error("offline");
			},
		});
		expect(unavailable).toMatchObject({ loginMethod: "api_key", validity: "unavailable" });
	});

	test("validates an overseas plan credential against the overseas endpoint", async () => {
		const dir = await mkdtemp(join(tmpdir(), "step-status-"));
		dirs.push(dir);
		const authPath = join(dir, "auth.json");
		await AuthStorage.create(authPath).modify("step", async () => ({
			type: "oauth",
			access: "oversea-token",
			refresh: "step-static-credential",
			expires: Number.MAX_SAFE_INTEGER,
			profile: "step_plan_oversea",
			uid: "user-456",
		}));
		let requestedUrl = "";
		const status = await getStepLoginStatus({
			authPath,
			env: await isolatedEnv(),
			fetch: async (input) => {
				requestedUrl = String(input);
				return response(200);
			},
		});
		expect(status).toEqual({
			loggedIn: true,
			loginMethod: "step_plan_oversea",
			profile: "step_plan_oversea",
			account: "user-456",
			validity: "valid",
			session: { state: "missing" },
		});
		expect(requestedUrl).toBe("https://api.stepfun.ai/step_plan/v1/models");
	});

	test("recognizes an API key stored in the OAuth-shaped auth file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "step-status-"));
		dirs.push(dir);
		const authPath = join(dir, "auth.json");
		await AuthStorage.create(authPath).modify("step", async () => ({
			type: "oauth",
			access: "stored-key",
			refresh: "step-static-credential",
			expires: Number.MAX_SAFE_INTEGER,
			profile: "platform_oversea",
		}));
		let requestedUrl = "";
		const status = await getStepLoginStatus({
			authPath,
			env: await isolatedEnv(),
			fetch: async (input) => {
				requestedUrl = String(input);
				return response(200);
			},
		});
		expect(status).toMatchObject({ loggedIn: true, loginMethod: "api_key", validity: "valid" });
		expect(requestedUrl).toBe("https://api.stepfun.ai/v1/models");
	});

	test("reports the account session beside the key, never instead of it", async () => {
		const dir = await mkdtemp(join(tmpdir(), "step-status-"));
		dirs.push(dir);
		const authPath = join(dir, "auth.json");
		const env = { STEPCODE_LOGIN_STATE_PATH: join(dir, "step-login.json") };
		await AuthStorage.create(authPath).modify("step", async () => ({
			type: "oauth",
			access: "secret-token",
			refresh: "step-static-credential",
			expires: Number.MAX_SAFE_INTEGER,
			profile: "step_plan",
			uid: "user-123",
		}));

		// A user who signed in before account sessions existed: the key works and
		// there is simply no session. That is not a fault worth warning about.
		expect(await getStepLoginStatus({ authPath, env, fetch: async () => response(200) })).toMatchObject({
			validity: "valid",
			session: { state: "missing" },
		});

		const now = Math.floor(Date.now() / 1000);
		for (const [state, expected] of [
			["ready", { state: "ready", refreshExpiresAt: now + 30 * 24 * 60 * 60 }],
			["expiring", { state: "expiring" }],
			["expired", { state: "expired", refreshExpiresAt: now - 1 }],
		] as const) {
			await saveStepLoginState(
				session({
					accessExpiresAt: state === "expiring" ? now + 60 : now + 1800,
					refreshExpiresAt: state === "expired" ? now - 1 : now + 30 * 24 * 60 * 60,
				}),
				env,
			);
			expect(await getStepLoginStatus({ authPath, env, fetch: async () => response(200) })).toMatchObject({
				validity: "valid",
				session: expected,
			});
		}
	});
});
