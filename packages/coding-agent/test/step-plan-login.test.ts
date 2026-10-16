import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loginStepOAuth } from "../src/features/step-provider/index.ts";
import {
	checkStepPlanBeforeInteractive,
	readStepLoginCredential,
	runStepLogin,
	writeStepLoginCredential,
} from "../src/step/login-flow.ts";
import type { StepLoginProfileId } from "../src/step/onboarding.ts";
import type { StepOnboardingView } from "../src/step/onboarding-view.ts";
import { PlanUsageController, resolvePlanUsageAccount } from "../src/step/usage/account.ts";
import type { PlanUsageSnapshot } from "../src/step/usage/types.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import * as browser from "../src/utils/open-browser.ts";

vi.mock("../src/features/step-provider/index.ts", async (original) => ({
	...(await original<typeof import("../src/features/step-provider/index.ts")>()),
	loginStepOAuth: vi.fn(async () => ({
		access: "plan-key",
		refresh: "static",
		expires: Number.MAX_SAFE_INTEGER,
		uid: "123",
	})),
}));

function snapshot(family: "none" | "coding" | "token" = "none"): PlanUsageSnapshot {
	return {
		schema_version: 1,
		observed_at_ms: Date.now(),
		scope: "personal_account",
		account: { id: "123" },
		plan: {
			state: "known",
			family,
			name: family === "none" ? null : "Pro",
			subscription: family === "coding" ? { id: "7", expires_at_ms: null } : null,
		},
		quota: {
			state: "known",
			allowed: family !== "none",
			reason: family === "none" ? "no_active_subscription" : null,
			windows:
				family === "coding"
					? [
							{ id: "five_hour", limited: true, used_percent: 25, resets_at_ms: null },
							{ id: "weekly", limited: true, used_percent: 50, resets_at_ms: null },
						]
					: [],
			credit_buckets:
				family === "token"
					? [
							{
								type: "topup",
								total: "10",
								remaining: "5",
								used_percent: 50,
								resets_at_ms: null,
								expires_at_ms: null,
							},
						]
					: [],
		},
	};
}

describe("Step Plan login availability", () => {
	let root: string;
	let authPath: string;
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "step-plan-login-"));
		authPath = join(root, "auth.json");
		vi.mocked(loginStepOAuth).mockClear();
		vi.spyOn(browser, "openBrowser").mockImplementation(() => {});
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await rm(root, { recursive: true, force: true });
	});
	function controller(fetcher: typeof fetch) {
		return new PlanUsageController(() => resolvePlanUsageAccount(authPath, {}), fetcher, Date.now, 100);
	}
	function start(planUsage: PlanUsageController, requiredPlan?: "step_plan" | "step_plan_oversea") {
		let view!: StepOnboardingView;
		const stop = vi.fn();
		const login = runStepLogin({
			authPath,
			env: {},
			noBrowser: true,
			planUsage,
			requiredPlan,
			createHost: () => ({
				addChild: (child) => {
					view = child as StepOnboardingView;
				},
				setFocus: () => {},
				requestRender: () => {},
				start: () => {},
				stop,
			}),
		});
		return { login, view, stop };
	}

	it.each(["step_plan", "step_plan_oversea"] as const)(
		"checks the stored %s account in its own region",
		async (profile) => {
			await writeStepLoginCredential({ authPath, profile, apiKey: "plan-key", uid: "123" });
			const before = await readFile(authPath, "utf8");
			const fetcher = vi.fn<typeof fetch>(async () => Response.json(snapshot()));
			const result = await checkStepPlanBeforeInteractive({
				authPath,
				interactive: true,
				env: {},
				planUsage: controller(fetcher),
			});
			expect(result).toEqual({ requiredPlan: profile, warning: undefined });
			expect(fetcher.mock.calls[0][0]).toBe(
				`https://api.stepfun.${profile === "step_plan" ? "com" : "ai"}/step_plan/v1/usage`,
			);
			expect(await readFile(authPath, "utf8")).toBe(before);
		},
	);

	it.each(["coding", "token"] as const)(
		"keeps a usable %s account, including top-up-only accounts",
		async (family) => {
			await writeStepLoginCredential({ authPath, profile: "step_plan", apiKey: "plan-key", uid: "123" });
			const fetcher = vi.fn<typeof fetch>(async () => Response.json(snapshot(family)));
			expect(
				(
					await checkStepPlanBeforeInteractive({
						authPath,
						interactive: true,
						env: {},
						planUsage: controller(fetcher),
					})
				).requiredPlan,
			).toBeUndefined();
		},
	);

	it("does not treat an exhausted plan as a missing subscription", async () => {
		await writeStepLoginCredential({ authPath, profile: "step_plan", apiKey: "plan-key", uid: "123" });
		const data = snapshot("coding");
		data.quota.allowed = false;
		data.quota.reason = "week_limit_exceeded";
		const planUsage = controller(vi.fn<typeof fetch>(async () => Response.json(data)));
		expect(
			(await checkStepPlanBeforeInteractive({ authPath, interactive: true, env: {}, planUsage })).requiredPlan,
		).toBeUndefined();
	});

	it.each([401, 403, 404, 429, 500, 503])("keeps credentials and reports uncertainty for HTTP %s", async (status) => {
		await writeStepLoginCredential({ authPath, profile: "step_plan_oversea", apiKey: "plan-key", uid: "123" });
		const before = await readFile(authPath, "utf8");
		const result = await checkStepPlanBeforeInteractive({
			authPath,
			interactive: true,
			env: {},
			planUsage: controller(vi.fn<typeof fetch>(async () => new Response("", { status }))),
		});
		expect(result.requiredPlan).toBeUndefined();
		expect(result.warning).toContain("Could not verify Step Plan availability");
		expect(await readFile(authPath, "utf8")).toBe(before);
	});

	it.each(["network", "invalid", "mismatch", "timeout", "partial", "unconfirmed"])(
		"does not redirect on %s",
		async (kind) => {
			await writeStepLoginCredential({ authPath, profile: "step_plan", apiKey: "plan-key", uid: "123" });
			const fetcher = vi.fn<typeof fetch>(async () => {
				if (kind === "network") throw new Error("offline");
				if (kind === "timeout") return new Promise(() => {});
				if (kind === "invalid") return Response.json({ data: [] });
				const data = snapshot(kind === "partial" ? "token" : "none");
				if (kind === "mismatch") data.account.id = "456";
				if (kind === "unconfirmed") data.plan.state = "unavailable";
				if (kind === "partial") {
					data.quota.state = "partial";
					data.quota.credit_buckets = null;
				}
				return Response.json(data);
			});
			const result = await checkStepPlanBeforeInteractive({
				authPath,
				interactive: true,
				env: {},
				planUsage: controller(fetcher),
			});
			expect(result.requiredPlan).toBeUndefined();
			if (kind !== "partial") expect(result.warning).toBeTruthy();
		},
	);

	it.each(["platform_cn", "platform_oversea", "headless", "environment", "missing"])(
		"skips Plan requests for %s",
		async (kind) => {
			if (kind !== "missing")
				await writeStepLoginCredential({
					authPath,
					profile: kind.startsWith("platform") ? (kind as StepLoginProfileId) : "step_plan",
					apiKey: "key",
				});
			const fetcher = vi.fn<typeof fetch>();
			expect(
				await checkStepPlanBeforeInteractive({
					authPath,
					interactive: kind !== "headless",
					env: kind === "environment" ? { STEP_API_KEY: "env-key" } : {},
					planUsage: controller(fetcher),
				}),
			).toEqual({});
			expect(fetcher).not.toHaveBeenCalled();
		},
	);

	it.each([
		["step_plan", "1", "platform_cn", "api.stepfun.com"],
		["step_plan_oversea", "2", "platform_oversea", "api.stepfun.ai"],
	] as const)(
		"offers an API key after %s browser login and preserves the region",
		async (profile, choice, platform, host) => {
			const fetcher = vi.fn<typeof fetch>(async () => Response.json(snapshot()));
			const { login, view, stop } = start(controller(fetcher));
			try {
				view.handleInput(choice);
				await vi.waitFor(() => expect(view.getStep()).toEqual({ kind: "planRequired", choice: profile }));
				expect(view.render(100).map(stripAnsi).join("\n")).toContain(
					"No active Step Plan subscription or usable top-up credits",
				);
				expect(fetcher.mock.calls[0][0]).toContain(host);
				view.handleInput("1");
				expect(view.getStep()).toMatchObject({ kind: "apiKeyEntry", choice: platform });
				view.handleInput("platform-test-key");
				view.handleInput("\r");
				await expect(login).resolves.toMatchObject({ kind: "completed", profile: { id: platform } });
				expect(readStepLoginCredential(authPath)).toMatchObject({ access: "platform-test-key", profile: platform });
				expect(readStepLoginCredential(authPath)).not.toHaveProperty("uid");
				expect(fetcher).toHaveBeenCalledTimes(1);
				expect(stop).toHaveBeenCalledOnce();
			} finally {
				view.handleInput("\x03");
				await login;
			}
		},
	);

	it("rechecks subscription purchase without another browser login", async () => {
		await writeStepLoginCredential({ authPath, profile: "step_plan", apiKey: "plan-key", uid: "123" });
		const fetcher = vi.fn<typeof fetch>(async () => Response.json(snapshot("coding")));
		const { login, view } = start(controller(fetcher), "step_plan");
		try {
			view.handleInput("3");
			await expect(login).resolves.toMatchObject({ kind: "completed", profile: { id: "step_plan" } });
			expect(loginStepOAuth).not.toHaveBeenCalled();
		} finally {
			view.handleInput("\x03");
			await login;
		}
	});

	it("cancels a pending check and ignores its late response", async () => {
		await writeStepLoginCredential({ authPath, profile: "step_plan", apiKey: "plan-key", uid: "123" });
		let respond!: (value: Response) => void;
		const fetcher = vi.fn<typeof fetch>(
			() =>
				new Promise((resolve) => {
					respond = resolve;
				}),
		);
		const { login, view, stop } = start(controller(fetcher), "step_plan");
		view.handleInput("3");
		expect(view.getStep().kind).toBe("checkingPlan");
		view.handleInput("\x03");
		await expect(login).resolves.toEqual({ kind: "exit" });
		expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
		respond(Response.json(snapshot("coding")));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(view.getStep().kind).toBe("exit");
		expect(stop).toHaveBeenCalledOnce();
	});

	it("preserves the Plan credential when API-key entry is cancelled", async () => {
		await writeStepLoginCredential({ authPath, profile: "step_plan_oversea", apiKey: "plan-key", uid: "123" });
		const before = await readFile(authPath, "utf8");
		const { login, view } = start(controller(vi.fn<typeof fetch>()), "step_plan_oversea");
		view.handleInput("1");
		view.handleInput("unsubmitted-key");
		view.handleInput("\x03");
		await expect(login).resolves.toEqual({ kind: "exit" });
		expect(await readFile(authPath, "utf8")).toBe(before);
	});

	it("reports unavailable quota after login without replacing a valid credential", async () => {
		const { login, view } = start(controller(vi.fn<typeof fetch>(async () => new Response("", { status: 404 }))));
		try {
			view.handleInput("2");
			await expect(login).resolves.toMatchObject({
				kind: "completed",
				warning: expect.stringContaining("Could not verify Step Plan availability"),
			});
			expect(readStepLoginCredential(authPath)).toMatchObject({ access: "plan-key", profile: "step_plan_oversea" });
		} finally {
			view.handleInput("\x03");
			await login;
		}
	});
});
