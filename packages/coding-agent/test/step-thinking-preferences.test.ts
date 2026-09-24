import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "@step-harness/agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createStepExtension } from "../src/features/step.ts";
import { stepThinkingLevelMap } from "../src/features/step-provider/index.ts";
import { createStepSettingsManager } from "../src/step/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader, stepModel } from "./utilities.ts";

const roots: string[] = [];
const sessions: AgentSession[] = [];
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "step-thinking-preferences-"));
	roots.push(root);
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	return { root, cwd, agentDir };
}
async function makeSession(f: ReturnType<typeof fixture>, settings: SettingsManager, thinkingLevel?: ThinkingLevel) {
	const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
	const result = await createAgentSession({
		cwd: f.cwd,
		agentDir: f.agentDir,
		settingsManager: settings,
		sessionManager: SessionManager.inMemory(f.cwd),
		resourceLoader: createTestResourceLoader(),
		modelRuntime: getModelRuntime(registry),
		model: stepModel({ thinkingLevelMap: stepThinkingLevelMap(["low", "medium", "high"]) }),
		thinkingLevel,
		noTools: "all",
	});
	sessions.push(result.session);
	return result.session;
}
function stepEffortHooks(session: AgentSession) {
	const on = vi.fn();
	createStepExtension({ permission: { env: {} } })({
		registerProvider: vi.fn(),
		registerCommand: vi.fn(),
		sendUserMessage: vi.fn(),
		on,
		setThinkingLevel: (level: ThinkingLevel) => session.setThinkingLevel(level),
		getThinkingLevel: () => session.thinkingLevel,
	} as unknown as ExtensionAPI);
	const ctx = {
		get model() {
			return session.model;
		},
		get thinkingLevel() {
			return session.thinkingLevel;
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
		},
	} as unknown as ExtensionContext;
	return {
		async start(reason = "startup") {
			// The first registered session_start handler is the real effort enrichment hook.
			await on.mock.calls.find(([name]) => name === "session_start")![1]({ type: "session_start", reason }, ctx);
		},
		async select() {
			await on.mock.calls.find(([name]) => name === "model_select")![1](
				{ type: "model_select", model: session.model, source: "set" },
				ctx,
			);
		},
	};
}
afterEach(() => {
	vi.restoreAllMocks();
	for (const session of sessions.splice(0)) session.dispose();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Step thinking preferences", () => {
	it("CLI parsing and the core SDK honor --thinking medium before the Step hook", async () => {
		const f = fixture();
		const parsed = parseArgs(["--thinking", "medium"]);
		expect(parsed.thinking).toBe("medium");
		const session = await makeSession(f, SettingsManager.inMemory({ defaultThinkingLevel: "high" }), parsed.thinking);
		expect(session.thinkingLevel).toBe("medium");
	});

	it("Step startup must preserve the explicit --thinking medium option", async () => {
		const f = fixture();
		const parsed = parseArgs(["--thinking", "medium"]);
		const session = await makeSession(f, SettingsManager.inMemory({ defaultThinkingLevel: "high" }), parsed.thinking);
		expect(session.thinkingLevel).toBe("medium");
		await stepEffortHooks(session).start();
		expect(session.thinkingLevel).toBe("medium");
	});

	it("a saved default survives disk roundtrip and must still apply after startup", async () => {
		const f = fixture();
		const saved = createStepSettingsManager(f.cwd, f.agentDir);
		saved.setDefaultThinkingLevel("medium");
		await saved.flush();
		const reloaded = createStepSettingsManager(f.cwd, f.agentDir);
		expect(reloaded.getDefaultThinkingLevel()).toBe("medium");
		const session = await makeSession(f, reloaded);
		expect(session.thinkingLevel).toBe("medium");
		await stepEffortHooks(session).start();
		expect(reloaded.getDefaultThinkingLevel()).toBe("medium");
		expect(session.thinkingLevel).toBe("medium");
	});

	it("Step startup must preserve a saved per-model thinking preference", async () => {
		const f = fixture();
		const saved = createStepSettingsManager(f.cwd, f.agentDir);
		saved.setDefaultThinkingLevel("high");
		saved.setModelThinkingLevel("step", "step-5-preview", "low");
		await saved.flush();
		const reloaded = createStepSettingsManager(f.cwd, f.agentDir);
		const session = await makeSession(f, reloaded);
		expect(session.thinkingLevel).toBe("low");
		await stepEffortHooks(session).start();
		expect(session.thinkingLevel).toBe("low");
	});

	it("model_select must preserve the effort already resolved by the session", async () => {
		const f = fixture();
		const session = await makeSession(f, SettingsManager.inMemory(), "medium");
		await stepEffortHooks(session).select();
		expect(session.thinkingLevel).toBe("medium");
	});

	it("an explicit resume lifecycle does not trigger the override", async () => {
		const f = fixture();
		const session = await makeSession(f, SettingsManager.inMemory(), "medium");
		await stepEffortHooks(session).start("resume");
		expect(session.thinkingLevel).toBe("medium");
	});

	it("preserves a newer user choice while capability discovery is pending", async () => {
		const f = fixture();
		const session = await makeSession(f, SettingsManager.inMemory(), "medium");
		const model = session.model!;
		delete model.thinkingLevelMap;
		let respond!: (response: Response) => void;
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
			() =>
				new Promise((resolve) => {
					respond = resolve;
				}),
		);
		await stepEffortHooks(session).start();
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
		session.setThinkingLevel("low");
		respond(new Response(JSON.stringify({ reasoning_effort_support_list: ["low", "medium", "high"] })));
		await vi.waitFor(() => expect(model.thinkingLevelMap).toBeDefined());
		expect(session.thinkingLevel).toBe("low");
	});

	it("does not change the active model's effort when an earlier model's discovery finishes", async () => {
		const f = fixture();
		const session = await makeSession(f, SettingsManager.inMemory(), "medium");
		const previousModel = session.model!;
		delete previousModel.thinkingLevelMap;
		let respond!: (response: Response) => void;
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
			() =>
				new Promise((resolve) => {
					respond = resolve;
				}),
		);
		await stepEffortHooks(session).start();
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
		session.agent.state.model = stepModel({
			id: "other-model",
			thinkingLevelMap: stepThinkingLevelMap(["low", "medium"]),
		});
		session.setThinkingLevel("low");
		respond(new Response(JSON.stringify({ reasoning_effort_support_list: ["high"] })));
		await vi.waitFor(() => expect(previousModel.thinkingLevelMap).toBeDefined());
		expect(session.thinkingLevel).toBe("low");
	});

	it("clamps only unsupported choices after discovering the active model's capabilities", async () => {
		const f = fixture();
		const session = await makeSession(f, SettingsManager.inMemory(), "medium");
		const model = session.model!;
		delete model.thinkingLevelMap;
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ reasoning_effort_support_list: ["low", "high"] })),
		);
		await stepEffortHooks(session).start();
		await vi.waitFor(() => expect(model.thinkingLevelMap).toBeDefined());
		expect(session.thinkingLevel).toBe("high");
	});
});
