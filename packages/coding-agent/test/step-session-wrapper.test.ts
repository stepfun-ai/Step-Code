import { chmodSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { runMigrations } from "../src/migrations.ts";
import {
	continueStepSession,
	createStepSessionManager,
	createStepSessionManagerFactory,
	forkStepSession,
	isStepSessionManager,
	listAllStepSessions,
	listStepSessions,
	openStepSession,
	StepSessionManager,
	wrapStepSessionManager,
} from "../src/step/session.ts";
import { createStepToolProfile } from "../src/step/tool-profile.ts";
import { getToolPath } from "../src/utils/tools-manager.ts";

const roots: string[] = [];

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Step Pi storage wrappers", () => {
	async function persistHeader(manager: SessionManager): Promise<string> {
		const path = manager.getSessionFile();
		if (!path) throw new Error("expected a persisted session file");
		await writeFile(path, `${JSON.stringify(manager.getHeader())}\n`);
		return path;
	}

	test("uses Pi's per-cwd session layout below the Step agent directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-session-wrapper-"));
		roots.push(root);
		const cwd = join(root, "workspace");
		const agentDir = join(root, ".stepcode", "agent");
		await mkdir(cwd, { recursive: true });

		const manager = createStepSessionManager(cwd, { agentDir });
		const safeCwd = `--${cwd.replace(/^[/\\]/u, "").replace(/[/\\:]/gu, "-")}--`;
		const expectedDir = join(agentDir, "sessions", safeCwd);

		expect(manager.getSessionDir()).toBe(expectedDir);
		expect(manager.getSessionFile()?.startsWith(`${expectedDir}/`)).toBe(true);
		expect(manager.getSessionFile()).not.toContain(`${join(root, ".pi")}/`);
		expect(existsSync(join(root, ".pi"))).toBe(false);
	});

	test("wraps native managers without changing their prototype or session behavior", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-session-instance-wrapper-"));
		roots.push(root);
		const cwd = join(root, "workspace");
		const agentDir = join(root, ".stepcode", "agent");
		await mkdir(cwd, { recursive: true });

		const native = SessionManager.create(cwd, join(agentDir, "sessions", "encoded"), { id: "native" });
		const wrapped = wrapStepSessionManager(native, { agentDir });

		expect(wrapped).toBeInstanceOf(SessionManager);
		expect(isStepSessionManager(wrapped)).toBe(true);
		expect(wrapStepSessionManager(wrapped, { agentDir })).toBe(wrapped);
		expect(wrapped.getSessionId()).toBe("native");
		expect(wrapped.usesDefaultSessionDir()).toBe(false);

		const defaultManager = createStepSessionManager(cwd, { agentDir, newSession: { id: "default" } });
		expect(defaultManager.usesDefaultSessionDir()).toBe(true);
		defaultManager.newSession({ id: "default-replaced" });
		expect(defaultManager.getSessionId()).toBe("default-replaced");
		expect(defaultManager.usesDefaultSessionDir()).toBe(true);
	});

	test("keeps factory-created replacement managers in the Step namespace", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-session-factory-wrapper-"));
		roots.push(root);
		const cwd = join(root, "workspace");
		const agentDir = join(root, ".stepcode", "agent");
		await mkdir(cwd, { recursive: true });

		const factory = createStepSessionManagerFactory(agentDir);
		const manager = factory.create(cwd, undefined, { id: "factory" });
		const inMemory = factory.inMemory(cwd, { id: "memory" });

		expect(isStepSessionManager(manager)).toBe(true);
		expect(manager.usesDefaultSessionDir()).toBe(true);
		expect(isStepSessionManager(inMemory)).toBe(true);
		expect(inMemory.getSessionFile()).toBeUndefined();
		expect(existsSync(join(root, ".pi"))).toBe(false);
	});

	test("honors an explicit session root without changing Pi's manager semantics", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-session-wrapper-explicit-"));
		roots.push(root);
		const cwd = join(root, "workspace");
		const sessionDir = join(root, ".stepcode", "sessions");
		await mkdir(cwd, { recursive: true });

		const manager = createStepSessionManager(cwd, { sessionDir });

		expect(manager.getSessionDir()).toBe(sessionDir);
		expect(manager.getSessionFile()?.startsWith(`${sessionDir}/`)).toBe(true);
	});

	test("resolves managed fd/rg binaries lazily from the active Step agent directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-tool-wrapper-"));
		roots.push(root);
		const agentDir = join(root, ".stepcode", "agent");
		const rgPath = join(agentDir, "bin", process.platform === "win32" ? "rg.exe" : "rg");
		await mkdir(join(agentDir, "bin"), { recursive: true });
		await writeFile(rgPath, "placeholder");

		expect(getToolPath("rg", agentDir)).toBe(rgPath);
		expect(getToolPath("rg", agentDir)).not.toContain(`${join(root, ".pi")}/`);
	});

	test("keeps all native session operations inside the Step namespace", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-session-facade-"));
		roots.push(root);
		const firstCwd = join(root, "first");
		const secondCwd = join(root, "second");
		const stepAgentDir = join(root, ".stepcode", "agent");
		const piAgentDir = join(root, ".pi", "agent");
		await Promise.all([mkdir(firstCwd), mkdir(secondCwd)]);

		const source = StepSessionManager.create(firstCwd, {
			agentDir: stepAgentDir,
			newSession: { id: "step-source" },
		});
		const sourcePath = await persistHeader(source);
		const piOnly = SessionManager.create(firstCwd, join(piAgentDir, "sessions"), { id: "pi-only" });
		await persistHeader(piOnly);

		await expect(listStepSessions(firstCwd, { agentDir: stepAgentDir })).resolves.toMatchObject([
			{ id: "step-source" },
		]);
		await expect(listAllStepSessions({ agentDir: stepAgentDir })).resolves.toMatchObject([{ id: "step-source" }]);
		expect(continueStepSession(firstCwd, { agentDir: stepAgentDir }).getSessionId()).toBe("step-source");
		expect(openStepSession(sourcePath).getSessionDir()).toBe(source.getSessionDir());
		expect(openStepSession(sourcePath, { agentDir: stepAgentDir }).getSessionDir()).toBe(source.getSessionDir());

		const fork = forkStepSession(sourcePath, secondCwd, {
			agentDir: stepAgentDir,
			newSession: { id: "step-fork" },
		});
		expect(fork.getSessionDir()).toContain(`${join(stepAgentDir, "sessions")}/`);
		expect(fork.getSessionDir()).not.toContain(`${join(root, ".pi")}/`);
	});

	test("accepts Pi's positional static-session signatures", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-session-positional-"));
		roots.push(root);
		const cwd = join(root, "workspace");
		const agentDir = join(root, ".stepcode", "agent");
		await mkdir(cwd, { recursive: true });
		vi.stubEnv("STEP_CODING_AGENT_DIR", agentDir);

		const manager = StepSessionManager.create(cwd, undefined, { id: "positional" });
		const path = await persistHeader(manager);
		const progress = vi.fn();

		await expect(StepSessionManager.list(cwd, undefined, progress)).resolves.toMatchObject([{ id: "positional" }]);
		await expect(StepSessionManager.listAll(undefined, progress)).resolves.toMatchObject([{ id: "positional" }]);
		expect(progress).toHaveBeenCalled();
		expect(StepSessionManager.open(path, undefined, cwd).getSessionDir()).toBe(manager.getSessionDir());
		expect(StepSessionManager.continueRecent(cwd, manager.getSessionDir()).getSessionId()).toBe("positional");
		expect(StepSessionManager.create(cwd, manager.getSessionDir(), { id: "second" }).getSessionDir()).toBe(
			manager.getSessionDir(),
		);
		expect(manager.getSessionDir()).toContain(join(root, ".stepcode"));
	});

	test("binds every static session operation to one Step agent root", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-session-factory-"));
		roots.push(root);
		const firstCwd = join(root, "first");
		const secondCwd = join(root, "second");
		const agentDir = join(root, ".stepcode", "agent");
		await Promise.all([mkdir(firstCwd), mkdir(secondCwd)]);

		const factory = createStepSessionManagerFactory(agentDir);
		const source = factory.create(firstCwd, undefined, { id: "factory-source" });
		const sourcePath = await persistHeader(source);
		const opened = factory.open(sourcePath);
		const fork = factory.forkFrom(sourcePath, secondCwd, undefined, { id: "factory-fork" });
		await persistHeader(fork);

		expect(opened.getSessionDir()).toBe(source.getSessionDir());
		expect(fork.getSessionDir()).toContain(join(agentDir, "sessions"));
		expect(await factory.list(firstCwd)).toMatchObject([{ id: "factory-source" }]);
		expect(await factory.listAll()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "factory-source" }),
				expect.objectContaining({ id: "factory-fork" }),
			]),
		);
		expect(factory.continueRecent(firstCwd).getSessionId()).toBe("factory-source");
		expect(factory.inMemory(firstCwd).getSessionFile()).toBeUndefined();
		expect(fork.getSessionDir()).not.toContain(`${join(root, ".pi")}/`);
	});

	test("honors the Step agent environment without mutating Pi's environment", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-session-env-"));
		roots.push(root);
		const cwd = join(root, "workspace");
		const agentDir = join(root, ".stepcode", "agent");
		await mkdir(cwd, { recursive: true });
		vi.stubEnv("STEP_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("PI_CODING_AGENT_DIR", join(root, ".pi", "agent"));

		const manager = StepSessionManager.create(cwd, { newSession: { id: "env-step" } });
		expect(manager.getSessionDir()).toContain(`${join(agentDir, "sessions")}/`);
		expect(process.env.PI_CODING_AGENT_DIR).toBe(join(root, ".pi", "agent"));
	});

	test("Step tool profile keeps managed binaries in the Step root by default", async () => {
		if (process.platform === "win32") return;
		const root = await mkdtemp(join(tmpdir(), "step-tool-profile-env-"));
		roots.push(root);
		const cwd = join(root, "workspace");
		const agentDir = join(root, ".stepcode", "agent");
		await mkdir(cwd, { recursive: true });
		await writeFile(join(cwd, "sample.txt"), "sample\n");
		vi.stubEnv("STEP_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("PI_CODING_AGENT_DIR", join(root, ".pi", "agent"));
		vi.stubEnv("PATH", join(root, "empty-path"));

		const profile = createStepToolProfile(cwd);
		const find = profile.find((tool) => tool.name === "find_files")!;
		await mkdir(join(agentDir, "bin"), { recursive: true });
		const binaryPath = join(agentDir, "bin", "fd");
		await writeFile(binaryPath, "#!/bin/sh\nprintf '%s\\n' 'sample.txt'\n");
		chmodSync(binaryPath, 0o755);

		const result = await find.execute(
			"find",
			{ pattern: "*.txt", path: "." },
			undefined,
			undefined,
			undefined as never,
		);
		const output = result.content
			.filter((block) => block.type === "text")
			.map((block) => block.text ?? "")
			.join("\n");
		expect(output).toContain("sample.txt");
		expect(existsSync(join(root, ".pi", "agent", "bin", "fd"))).toBe(false);
	});

	test("moves managed tools within the injected agent directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-tool-migration-"));
		roots.push(root);
		const cwd = join(root, "workspace");
		const agentDir = join(root, ".stepcode", "agent");
		await Promise.all([mkdir(cwd), mkdir(join(agentDir, "tools"), { recursive: true })]);
		await writeFile(join(agentDir, "tools", "fd"), "step-fd");

		runMigrations(cwd, { agentDir, configDirName: ".stepcode" });

		await expect(readFile(join(agentDir, "bin", "fd"), "utf8")).resolves.toBe("step-fd");
		expect(existsSync(join(root, ".pi", "agent", "bin", "fd"))).toBe(false);
	});
});
