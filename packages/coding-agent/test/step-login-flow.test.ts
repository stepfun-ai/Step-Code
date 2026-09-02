import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getCurrentThemeName } from "../src/modes/interactive/theme/theme.ts";
import {
	needsStepLoginBeforeInteractive,
	readStepLoginCredential,
	readStepLoginProfile,
	runStepLogin,
	writeStepLoginCredential,
} from "../src/step/login-flow.ts";

describe("shared Step login flow storage", () => {
	it("resolves an automatic Step theme before rendering standalone login", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-login-theme-"));
		const authPath = join(root, "agent", "auth.json");
		let view: { handleInput(data: string): void } | undefined;
		try {
			await runStepLogin({
				authPath,
				themeName: "step-light/step",
				env: {},
				createHost: () => ({
					addChild: (child) => {
						view = child as { handleInput(data: string): void };
					},
					setFocus: () => {},
					requestRender: () => {},
					start: () => view?.handleInput("q"),
					stop: () => {},
				}),
			});

			expect(getCurrentThemeName()).toBe("step");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("writes a profile-tagged credential and reads the profile back", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-login-flow-"));
		const authPath = join(root, "agent", "auth.json");
		try {
			await writeStepLoginCredential({ authPath, profile: "platform_oversea", apiKey: "secret-key", uid: "uid-1" });

			expect(await readStepLoginProfile(authPath)).toBe("platform_oversea");
			expect(JSON.parse(await readFile(authPath, "utf8"))).toMatchObject({
				step: { type: "oauth", access: "secret-key", profile: "platform_oversea", uid: "uid-1" },
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("gates only interactive startup when no stored or environment credential exists", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-login-gate-"));
		const authPath = join(root, "agent", "auth.json");
		try {
			expect(needsStepLoginBeforeInteractive({ authPath, interactive: true, env: {} })).toBe(true);
			expect(needsStepLoginBeforeInteractive({ authPath, interactive: false, env: {} })).toBe(false);
			expect(
				needsStepLoginBeforeInteractive({ authPath, interactive: true, env: { STEP_API_KEY: "env-key" } }),
			).toBe(false);
			await writeStepLoginCredential({ authPath, profile: "step_plan", apiKey: "stored-key" });
			expect(await readStepLoginCredential(authPath)).toMatchObject({ access: "stored-key" });
			expect(needsStepLoginBeforeInteractive({ authPath, interactive: true, env: {} })).toBe(false);
			expect(await readStepLoginProfile(authPath)).toBe("step_plan");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("runs the API-key page through the same host contract", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-login-runner-"));
		const authPath = join(root, "agent", "auth.json");
		let view: { handleInput(data: string): void } | undefined;
		let clearScreenCalls = 0;
		try {
			const outcome = await runStepLogin({
				authPath,
				createHost: () => ({
					addChild: (child) => {
						view = child as { handleInput(data: string): void };
					},
					setFocus: () => {},
					requestRender: () => {},
					start: () => {
						view?.handleInput("\x1b[B");
						view?.handleInput("\r");
						view?.handleInput("platform-key");
						view?.handleInput("\r");
					},
					stop: () => {},
					clearScreen: () => {
						clearScreenCalls += 1;
					},
				}),
			});

			expect(outcome.kind).toBe("completed");
			expect(await readStepLoginProfile(authPath)).toBe("platform_cn");
			expect(clearScreenCalls).toBe(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
