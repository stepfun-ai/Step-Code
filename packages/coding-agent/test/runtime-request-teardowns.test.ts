import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@step-harness/providers/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ModelFetchFactory } from "../src/core/model-fetch.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DEFAULT_REQUEST_TEARDOWN_LIMIT_MS } from "../src/core/request-teardowns.ts";
import { getDefaultSessionDir, SessionManager } from "../src/core/session-manager.ts";

/**
 * Disposing a runtime waits for the work its sessions' model requests still
 * owe (registered through `ModelFetchRequest.registerTeardown`), with a bound,
 * and does not wait at all when there is none.
 */
describe("runtime dispose and request teardowns", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function runtimeWith(modelFetch: ModelFetchFactory) {
		const tempDir = join(tmpdir(), `pi-runtime-teardown-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("one")]);
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(tempDir, "models.json"),
		});
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [
				{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				},
			],
		});
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: tempDir,
				modelRuntime,
				resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true },
				modelFetch,
			});
			return {
				...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model })),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir, getDefaultSessionDir(tempDir, tempDir)),
		});
		cleanups.push(() => {
			faux.unregister();
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		});
		return runtimeHost;
	}

	it("waits for registered work, and no longer than the bound when it hangs", async () => {
		let factoryCalls = 0;
		const runtimeHost = await runtimeWith((request) => {
			factoryCalls++;
			// A teardown that never settles: a cancel request the server never answers.
			request.registerTeardown(new Promise(() => {}));
			return undefined;
		});
		await runtimeHost.session.prompt("hello");
		expect(factoryCalls).toBeGreaterThan(0);
		const started = performance.now();
		await runtimeHost.dispose();
		const elapsed = performance.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(DEFAULT_REQUEST_TEARDOWN_LIMIT_MS - 50);
		expect(elapsed).toBeLessThan(DEFAULT_REQUEST_TEARDOWN_LIMIT_MS + 1_000);
	});

	it("waits for work that settles, and only that long", async () => {
		let settledAt = 0;
		const runtimeHost = await runtimeWith((request) => {
			request.registerTeardown(
				new Promise<void>((resolve) =>
					setTimeout(() => {
						settledAt = performance.now();
						resolve();
					}, 100),
				),
			);
			return undefined;
		});
		await runtimeHost.session.prompt("hello");
		await runtimeHost.dispose();
		expect(settledAt).toBeGreaterThan(0);
	});

	it("does not wait when nothing was registered", async () => {
		const runtimeHost = await runtimeWith(() => undefined);
		await runtimeHost.session.prompt("hello");
		const started = performance.now();
		await runtimeHost.dispose();
		expect(performance.now() - started).toBeLessThan(500);
	});
});
