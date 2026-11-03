import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import {
	AgentSessionRuntime,
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
	type CreateAgentSessionRuntimeResult,
} from "../src/core/agent-session-runtime.ts";
import { createExtensionRuntime } from "../src/core/extensions/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";

type SessionStub = AgentSession & { readonly dispose: ReturnType<typeof vi.fn> };
type RuntimeResultStub = Omit<CreateAgentSessionRuntimeResult, "session"> & { session: SessionStub };

function createSession(cwd: string, sessionId: string): SessionStub {
	const sessionManager = SessionManager.inMemory(cwd);
	return {
		sessionId,
		sessionFile: undefined,
		sessionManager,
		extensionRunner: {
			hasHandlers: () => false,
			emit: vi.fn(async () => undefined),
		},
		abort: vi.fn(async () => {}),
		dispose: vi.fn(),
		createReplacedSessionContext: vi.fn(() => ({})),
	} as unknown as SessionStub;
}

function createServices(cwd: string): AgentSessionServices {
	return {
		cwd,
		agentDir: cwd,
		modelRuntime: {} as AgentSessionServices["modelRuntime"],
		settingsManager: {} as AgentSessionServices["settingsManager"],
		resourceLoader: {} as AgentSessionServices["resourceLoader"],
		diagnostics: [] as AgentSessionRuntimeDiagnostic[],
	};
}

function createResult(cwd: string, sessionId: string): RuntimeResultStub {
	return {
		session: createSession(cwd, sessionId),
		extensionsResult: { extensions: [], errors: [], runtime: createExtensionRuntime() },
		services: createServices(cwd),
		diagnostics: [],
	};
}

describe("AgentSessionRuntime replacement coordination", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	test("serializes concurrent replacements in FIFO order", async () => {
		const cwd = join(tmpdir(), `pi-runtime-concurrency-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(cwd, { recursive: true });
		tempDirs.push(cwd);

		const initial = createSession(cwd, "initial");
		let releaseFirst!: () => void;
		let startFirst!: () => void;
		const started = new Promise<void>((resolve) => {
			startFirst = resolve;
		});
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let replacementNumber = 0;
		const created: SessionStub[] = [];
		const factory = vi.fn(async ({ cwd: targetCwd }: Parameters<CreateAgentSessionRuntimeFactory>[0]) => {
			const number = ++replacementNumber;
			if (number === 1) {
				startFirst();
				await firstGate;
			}
			const result = createResult(targetCwd, `replacement-${number}`);
			created.push(result.session);
			return result;
		});

		const runtime = new AgentSessionRuntime(initial, createServices(cwd), async (options) => factory(options));
		const first = runtime.newSession();
		await started;
		const second = runtime.newSession();
		expect(factory).toHaveBeenCalledTimes(1);

		releaseFirst();
		await expect(Promise.all([first, second])).resolves.toEqual([{ cancelled: false }, { cancelled: false }]);
		expect(factory).toHaveBeenCalledTimes(2);
		expect(runtime.session.sessionId).toBe("replacement-2");
		expect(created[0]?.dispose).toHaveBeenCalledTimes(1);
		await runtime.dispose();
		expect(initial.dispose).toHaveBeenCalledTimes(1);
		expect(created[1]?.dispose).toHaveBeenCalledTimes(1);
	});

	test("does not rebind or leak a replacement when dispose races its factory", async () => {
		const cwd = join(tmpdir(), `pi-runtime-dispose-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(cwd, { recursive: true });
		tempDirs.push(cwd);

		const initial = createSession(cwd, "initial");
		let releaseFactory!: () => void;
		let factoryStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			factoryStarted = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			releaseFactory = resolve;
		});
		let created: SessionStub | undefined;
		const factory = vi.fn(async ({ cwd: targetCwd }: { cwd: string }) => {
			factoryStarted();
			await gate;
			const result = createResult(targetCwd, "late-replacement");
			created = result.session;
			return result;
		});
		const runtime = new AgentSessionRuntime(initial, createServices(cwd), async (options) => factory(options));
		const rebind = vi.fn(async () => {});
		runtime.setRebindSession(rebind);

		const replacement = runtime.newSession();
		await started;
		const disposing = runtime.dispose();
		releaseFactory();

		await expect(replacement).resolves.toEqual({ cancelled: true });
		await disposing;
		expect(rebind).not.toHaveBeenCalled();
		expect(initial.dispose).toHaveBeenCalledTimes(1);
		expect(created?.dispose).toHaveBeenCalledTimes(1);
		await runtime.dispose();
		expect(initial.dispose).toHaveBeenCalledTimes(1);
	});
});
