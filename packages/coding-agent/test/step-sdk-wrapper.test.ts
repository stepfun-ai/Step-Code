import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createStepAgentSession, createStepAgentSessionServices } from "../src/step/sdk.ts";
import { isStepSessionManager } from "../src/step/session.ts";

describe("Step Pi session wrappers", () => {
	const roots: string[] = [];

	afterEach(async () => {
		vi.unstubAllEnvs();
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	});

	test("installs the Step settings decorator around Pi services", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-sdk-wrapper-"));
		roots.push(root);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		await Promise.all([mkdir(cwd), mkdir(agentDir)]);

		const piManager = SettingsManager.inMemory({}, { projectTrusted: true });
		const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
		const services = await createStepAgentSessionServices({
			cwd,
			agentDir,
			modelRuntime,
			settingsManager: piManager,
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
			stepSettingsPaths: {
				global: join(root, "step-global.json"),
				project: join(root, "step-project.json"),
			},
		});

		expect(services.settingsManager.getPiSettingsManager()).toBe(piManager);
		expect(services.settingsManager.getStepSettings()).toEqual({});
		expect(services.settingsManager.getStepSettingsPaths()).toEqual({
			global: join(root, "step-global.json"),
			project: join(root, "step-project.json"),
		});
		expect(services.settingsManager.getDefaultModel()).toBeUndefined();
	});

	test("does not mutate the host Pi environment when embedded", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-sdk-wrapper-env-"));
		roots.push(root);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		await Promise.all([mkdir(cwd), mkdir(agentDir)]);
		vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "host-pi-agent"));
		const before = process.env.PI_CODING_AGENT_DIR;
		const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });

		await createStepAgentSessionServices({
			cwd,
			agentDir,
			modelRuntime,
			settingsManager: SettingsManager.inMemory({}, { projectTrusted: true }),
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});

		expect(process.env.PI_CODING_AGENT_DIR).toBe(before);
	});

	test("keeps an explicit agent directory isolated from a stale session override", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-sdk-wrapper-session-root-"));
		roots.push(root);
		const cwd = join(root, "project");
		const agentDir = join(root, "explicit-agent");
		const staleSessionDir = join(root, "stale-session-root");
		await Promise.all([mkdir(cwd), mkdir(agentDir)]);
		vi.stubEnv("STEP_CODING_AGENT_SESSION_DIR", staleSessionDir);
		const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });

		const { session } = await createStepAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			settingsManager: SettingsManager.inMemory({}, { projectTrusted: true }),
		});

		try {
			expect(session.sessionManager.getSessionDir()).toContain(`${join(agentDir, "sessions")}/`);
			expect(session.sessionManager.getSessionDir()).not.toBe(staleSessionDir);
		} finally {
			session.dispose();
		}
	});

	test("decorates an explicitly supplied native session manager", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-sdk-session-manager-wrapper-"));
		roots.push(root);
		const cwd = join(root, "project");
		const agentDir = join(root, "step-agent");
		const nativeSessionDir = join(agentDir, "sessions", "native");
		await mkdir(cwd, { recursive: true });
		const nativeManager = SessionManager.create(cwd, nativeSessionDir, { id: "native" });
		const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });

		const { session } = await createStepAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			settingsManager: SettingsManager.inMemory({}, { projectTrusted: true }),
			sessionManager: nativeManager,
		});

		try {
			expect(session.sessionManager).toBeInstanceOf(SessionManager);
			expect(isStepSessionManager(session.sessionManager)).toBe(true);
			expect(session.sessionManager.usesDefaultSessionDir()).toBe(false);
		} finally {
			session.dispose();
		}
	});
});
