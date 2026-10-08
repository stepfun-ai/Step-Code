import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readStepLoginCredential, runStepLogin } from "../src/step/login-flow.ts";
import type { StepOnboardingView } from "../src/step/onboarding-view.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import * as browser from "../src/utils/open-browser.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("Step login browser launch and URL fallback", () => {
	it.each([
		{ name: "opens the local browser by default", noBrowser: false },
		{ name: "only displays the URL with --no-browser", noBrowser: true },
	])("$name", async ({ noBrowser }) => {
		const root = await mkdtemp(join(tmpdir(), "step-login-browser-"));
		const authPath = join(root, "auth.json");
		const authUrl = `https://platform.stepfun.com/cli-login-remote?flow_id=${"a".repeat(32)}`;
		let view: StepOnboardingView | undefined;
		let resolvePoll!: (response: Response) => void;
		const pollResponse = new Promise<Response>((resolve) => {
			resolvePoll = resolve;
		});
		let pollStarted!: () => void;
		const polling = new Promise<void>((resolve) => {
			pollStarted = resolve;
		});
		const openBrowser = vi.spyOn(browser, "openBrowser").mockImplementation((url) => {
			expect(url).toBe(authUrl);
			// Render the complete URL before even attempting to launch a browser.
			expect(view?.render(40).map(stripAnsi).join("")).toContain(authUrl);
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (url.endsWith("/init"))
					return new Response(
						JSON.stringify({
							status: 0,
							flow_id: "a".repeat(32),
							poll_interval_sec: 2,
							expires_at: Date.now() / 1000 + 600,
						}),
					);
				pollStarted();
				return pollResponse;
			}),
		);
		const login = runStepLogin({
			authPath,
			env: {},
			...(noBrowser ? { noBrowser: true } : {}),
			createHost: () => ({
				addChild: (child) => {
					view = child as StepOnboardingView;
				},
				setFocus: () => {},
				requestRender: () => {},
				stop: () => {},
				start: () => view?.handleInput("1"),
			}),
		});
		try {
			await polling;
			await vi.waitFor(() =>
				expect(view?.getStep()).toMatchObject({
					kind: "continueInBrowser",
					authUrl,
				}),
			);
			expect(openBrowser).toHaveBeenCalledTimes(noBrowser ? 0 : 1);
			expect(view?.render(40).map(stripAnsi).join("")).toContain(authUrl);
			resolvePoll(
				new Response(
					JSON.stringify({ status: 0, state: "ready", uid: "123", credential: { api_key: "test-step-key" } }),
				),
			);
			await expect(login).resolves.toMatchObject({ kind: "completed" });
			expect(readStepLoginCredential(authPath)).toMatchObject({ access: "test-step-key", profile: "step_plan" });
		} finally {
			view?.handleInput("\x03");
			resolvePoll(new Response(JSON.stringify({ status: 0, state: "failed", reason: "denied" })));
			await login;
			await rm(root, { recursive: true, force: true });
		}
	});
});
