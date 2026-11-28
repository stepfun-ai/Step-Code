import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@step-harness/providers";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ModelFetch, ModelFetchFactory, ModelFetchRequest } from "../src/core/model-fetch.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const BASE = "https://api.example.test/v1";
const IDLE_TIMEOUT_MS = 300;
/** Longer than the idle bound: only a hold keeps the stream alive through it. */
const HELD_WAIT_MS = IDLE_TIMEOUT_MS * 2 + 200;

function sse(text: string): Response {
	const chunk = (body: Record<string, unknown>) =>
		`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "hook-model", ...body })}\n\n`;
	return new Response(
		chunk({ choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }) +
			chunk({
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			}) +
			"data: [DONE]\n\n",
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

/** A request the server never answers, not even with headers, until it is aborted. */
function noAnswer(signal: AbortSignal | null | undefined): Promise<Response> {
	return new Promise((_resolve, reject) => {
		signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("model fetch hook", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	async function runPrompt(modelFetch: ModelFetchFactory, events?: AgentSessionEvent[]) {
		tempDir = join(tmpdir(), `pi-model-fetch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		const settingsManager = SettingsManager.inMemory({
			retry: { enabled: false, provider: { streamIdleTimeoutMs: IDLE_TIMEOUT_MS, maxRetries: 0 } },
		});
		expect(settingsManager.getProviderRetrySettings().streamIdleTimeoutMs).toBe(IDLE_TIMEOUT_MS);
		// In memory: a file-backed store can persist after the test removed its directory.
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify("hook-test", async () => ({ type: "api_key", key: "sk-test" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(agentDir, "models.json"),
		});
		modelRuntime.registerProvider("hook-test", {
			baseUrl: BASE,
			api: "openai-completions",
			models: [
				{
					id: "hook-model",
					name: "Hook model",
					api: "openai-completions",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 32_000,
					maxTokens: 1_000,
					baseUrl: BASE,
				},
			],
		});
		const model = modelRuntime.getModel("hook-test", "hook-model");
		expect(model).toBeDefined();
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			modelRuntime,
			resourceLoader,
			modelFetch,
		});
		const unsubscribe = events ? session.subscribe((event) => events.push(event)) : undefined;
		try {
			await session.prompt("hello");
			return session.messages.at(-1) as AssistantMessage;
		} finally {
			unsubscribe?.();
			session.dispose();
		}
	}

	/**
	 * A wrapper that, like a host holding a request before the provider answers,
	 * keeps the watchdog held for `HELD_WAIT_MS` and then sends to `server`.
	 */
	function heldThenSend(
		server: (init: RequestInit | undefined) => Response | Promise<Response>,
		seen: ModelFetchRequest[],
	): ModelFetchFactory {
		return (request) => {
			seen.push(request);
			const fetch: ModelFetch = async (_input, init) => {
				const release = request.holdIdleWatchdog();
				try {
					await sleep(HELD_WAIT_MS);
				} finally {
					release();
				}
				return server(init);
			};
			return fetch;
		};
	}

	it("routes every model request through the host fetch", async () => {
		const seen: ModelFetchRequest[] = [];
		const urls: string[] = [];
		const last = await runPrompt((request) => {
			seen.push(request);
			return async (input, init) => {
				urls.push(new Request(input, init).url);
				return sse("wrapped answer");
			};
		});
		expect(last.stopReason).toBe("stop");
		expect(last.content).toEqual([{ type: "text", text: "wrapped answer" }]);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.model.id).toBe("hook-model");
		expect(seen[0]?.signal.aborted).toBe(false);
		expect(typeof seen[0]?.fetch).toBe("function");
		expect(urls).toEqual([`${BASE}/chat/completions`]);
	});

	it("leaves the request unchanged when the factory returns undefined", async () => {
		const original = globalThis.fetch;
		const urls: string[] = [];
		globalThis.fetch = async (input, init) => {
			urls.push(new Request(input, init).url);
			return sse("plain answer");
		};
		try {
			const last = await runPrompt(() => undefined);
			expect(last.content).toEqual([{ type: "text", text: "plain answer" }]);
			expect(urls).toEqual([`${BASE}/chat/completions`]);
		} finally {
			globalThis.fetch = original;
		}
	});

	it("does not time out a request while the host holds the idle watchdog", async () => {
		const seen: ModelFetchRequest[] = [];
		const last = await runPrompt(heldThenSend(() => sse("held answer"), seen));
		expect(last.stopReason).toBe("stop");
		expect(last.content).toEqual([{ type: "text", text: "held answer" }]);
	});

	it("keeps the request under the idle bound once the hold is released", async () => {
		const seen: ModelFetchRequest[] = [];
		const last = await runPrompt(heldThenSend((init) => noAnswer(init?.signal), seen));
		expect(last.stopReason).toBe("error");
		expect(last.errorMessage).toMatch(/stream idle timeout/);
		// The watchdog cancels through the signal the host was handed.
		expect(seen[0]?.signal.aborted).toBe(true);
	});

	it("times out a held wait when the host never holds the watchdog", async () => {
		const last = await runPrompt((request) => async () => {
			await Promise.race([sleep(HELD_WAIT_MS), noAnswer(request.signal)]);
			return sse("too late");
		});
		expect(last.stopReason).toBe("error");
		expect(last.errorMessage).toMatch(/stream idle timeout/);
	});

	it("publishes the wrapper's queue reports as model_queue session events", async () => {
		const events: AgentSessionEvent[] = [];
		const last = await runPrompt(
			(request) => async () => {
				request.reportQueue("call-1", { state: "waiting", position: 2 });
				request.reportQueue("call-1", { state: "waiting" });
				request.reportQueue("call-1", { state: "ready" });
				request.reportQueue("call-1", null);
				return sse("reported");
			},
			events,
		);
		expect(last.stopReason).toBe("stop");
		expect(events.filter((event) => event.type === "model_queue")).toEqual([
			{ type: "model_queue", queueId: "call-1", queue: { state: "waiting", position: 2 } },
			{ type: "model_queue", queueId: "call-1", queue: { state: "waiting" } },
			{ type: "model_queue", queueId: "call-1", queue: { state: "ready" } },
			{ type: "model_queue", queueId: "call-1", queue: null },
		]);
	});
});
