import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@step-harness/providers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { resolveStepModelQueueEnabled } from "../src/step/model-queue.ts";
import { createStepAgentSession } from "../src/step/sdk.ts";
import { createStepSettingsManager } from "../src/step/settings-manager.ts";

/** The Step Plan endpoint the product ships; requests never leave the process (fetch is stubbed). */
const STEP_PLAN = "https://api.stepfun.com/step_plan/v1";

const dirs: string[] = [];

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(globalToml: string, projectToml?: string) {
	const root = join(tmpdir(), `pi-step-queue-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	dirs.push(root);
	const cwd = join(root, "project");
	mkdirSync(join(cwd, ".stepcode"), { recursive: true });
	const paths = { global: join(root, "config.toml"), project: join(cwd, ".stepcode", "config.toml") };
	writeFileSync(paths.global, globalToml);
	if (projectToml !== undefined) writeFileSync(paths.project, projectToml);
	return { root, cwd, paths };
}

function sse(text: string): Response {
	const chunk = (body: Record<string, unknown>) =>
		`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "queue-model", ...body })}\n\n`;
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

describe("model_queue setting", () => {
	it("reads model_queue globally, lets a trusted project override it, and ignores an untrusted one", () => {
		const { cwd, paths } = fixture("model_queue = true\n", "model_queue = false\n");
		const trusted = createStepSettingsManager(cwd, undefined, { paths, projectTrusted: true });
		expect(trusted.getStepSettings().modelQueue).toBe(false);
		expect(resolveStepModelQueueEnabled({ env: {}, settings: trusted.getStepSettings() })).toEqual({
			enabled: false,
			source: "settings",
		});
		const untrusted = createStepSettingsManager(cwd, undefined, { paths, projectTrusted: false });
		expect(untrusted.getStepSettings().modelQueue).toBe(true);
		// Unset everywhere: the queue is on.
		const unset = fixture("");
		const plain = createStepSettingsManager(unset.cwd, undefined, { paths: unset.paths, projectTrusted: true });
		expect(plain.getStepSettings().modelQueue).toBeUndefined();
		expect(resolveStepModelQueueEnabled({ env: {}, settings: plain.getStepSettings() })).toEqual({
			enabled: true,
			source: "default",
		});
		// The flat spelling is the same switch.
		const flat = fixture("modelQueue = true\n");
		const flatSettings = createStepSettingsManager(flat.cwd, undefined, { paths: flat.paths, projectTrusted: true });
		expect(flatSettings.getStepSettings().modelQueue).toBe(true);
	});

	it("persists the switch and rejects a non-boolean value", () => {
		const { cwd, paths } = fixture("");
		const settings = createStepSettingsManager(cwd, undefined, { paths, projectTrusted: true });
		settings.setStepSettings({ modelQueue: true });
		const reread = createStepSettingsManager(cwd, undefined, { paths, projectTrusted: true });
		expect(reread.getStepSettings().modelQueue).toBe(true);
		expect(() => settings.setStepSettings({ modelQueue: "yes" as unknown as boolean })).toThrow(/modelQueue/);
	});

	it("ignores a non-boolean value with a settings warning", () => {
		const { cwd, paths } = fixture('model_queue = "yes"\n');
		const settings = createStepSettingsManager(cwd, undefined, { paths, projectTrusted: true });
		expect(settings.getStepSettings().modelQueue).toBeUndefined();
		const messages = settings.drainErrors().map((entry) => entry.error.message);
		expect(messages).toContain('model_queue must be true or false; ignoring "yes"');
	});
});

describe("Step sessions install the queue", () => {
	async function prompt(globalToml: string, server: typeof globalThis.fetch) {
		const { root, cwd, paths } = fixture(globalToml);
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		vi.stubGlobal("fetch", server);
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify("step", async () => ({ type: "api_key", key: "sk-test" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(agentDir, "models.json"),
		});
		// The official Step provider id, at a stubbed endpoint.
		modelRuntime.registerProvider("step", {
			baseUrl: STEP_PLAN,
			api: "openai-completions",
			models: [
				{
					id: "queue-model",
					name: "Queue model",
					api: "openai-completions",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 32_000,
					maxTokens: 1_000,
					baseUrl: STEP_PLAN,
				},
			],
		});
		const settingsManager = createStepSettingsManager(cwd, agentDir, { paths, projectTrusted: true });
		// Session retries stay on: a closed place must not be retried by the session or the SDK.
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } });
		const { session } = await createStepAgentSession({
			cwd,
			agentDir,
			model: modelRuntime.getModel("step", "queue-model"),
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			modelRuntime,
		});
		const events: AgentSessionEvent[] = [];
		const unsubscribe = session.subscribe((event) => events.push(event));
		try {
			await session.prompt("hello");
			return { last: session.messages.at(-1) as AssistantMessage, events };
		} finally {
			unsubscribe();
			session.dispose();
		}
	}

	const queuedAnswer = (position: number) =>
		new Response("{}", {
			status: 429,
			headers: {
				"X-StepCode-Queue-State": "waiting",
				"X-StepCode-Queue-Position": String(position),
				"Retry-After-Ms": "20",
			},
		});

	it("queues a request to Step's host when the setting turns the queue on", async () => {
		vi.stubEnv("STEPCODE_MODEL_QUEUE", "");
		const calls: Array<{ method: string; url: string; id: string | null }> = [];
		const replies = [
			() => queuedAnswer(2),
			() => Response.json({ state: "ready", position: 0, retry_after_ms: 20, reason: "" }),
			() => sse("after the line"),
		];
		const { last, events } = await prompt("model_queue = true\n", async (input, init) => {
			const request = new Request(input, init);
			calls.push({ method: request.method, url: request.url, id: request.headers.get("X-StepCode-Queue-ID") });
			const reply = replies.shift();
			if (!reply) throw new Error(`unexpected ${request.method} ${request.url}`);
			return reply();
		});
		expect(last.content).toEqual([{ type: "text", text: "after the line" }]);
		expect(calls.map((call) => call.method)).toEqual(["POST", "GET", "POST"]);
		expect(calls[0]?.id).toMatch(/^[0-9a-f-]{36}$/u);
		expect(calls[1]?.url).toBe("https://api.stepfun.com/stepcode/v1/queue");
		expect(calls[1]?.id).toBe(calls[0]?.id);
		expect(calls[2]?.id).toBe(calls[0]?.id);
		expect(events.filter((event) => event.type === "model_queue").map((event) => event.queue)).toEqual([
			{ position: 2 },
			null,
		]);
	});

	it("queues by default, with no setting and no environment override", async () => {
		vi.stubEnv("STEPCODE_MODEL_QUEUE", "");
		const calls: string[] = [];
		const replies = [
			() => queuedAnswer(1),
			() => Response.json({ state: "ready", position: 0, retry_after_ms: 20, reason: "" }),
			() => sse("by default"),
		];
		const { last } = await prompt("", async (input, init) => {
			const request = new Request(input, init);
			calls.push(`${request.method} ${new URL(request.url).pathname}`);
			const reply = replies.shift();
			if (!reply) throw new Error(`unexpected ${request.method} ${request.url}`);
			return reply();
		});
		expect(last.content).toEqual([{ type: "text", text: "by default" }]);
		expect(calls).toEqual([
			"POST /step_plan/v1/chat/completions",
			"GET /stepcode/v1/queue",
			"POST /step_plan/v1/chat/completions",
		]);
	});

	it("leaves the request alone when the queue is off", async () => {
		vi.stubEnv("STEPCODE_MODEL_QUEUE", "");
		const ids: Array<string | null> = [];
		const { last } = await prompt("model_queue = false\n", async (input, init) => {
			ids.push(new Request(input, init).headers.get("X-StepCode-Queue-ID"));
			return sse("direct");
		});
		expect(last.content).toEqual([{ type: "text", text: "direct" }]);
		expect(ids).toEqual([null]);
	});

	it("ends a closed place with one readable error that neither the SDK nor the session retries", async () => {
		vi.stubEnv("STEPCODE_MODEL_QUEUE", "");
		const calls: string[] = [];
		const { last, events } = await prompt("model_queue = true\n", async (input, init) => {
			const request = new Request(input, init);
			calls.push(`${request.method} ${new URL(request.url).pathname}`);
			if (request.method === "GET")
				return Response.json({ state: "closed", position: 0, retry_after_ms: 20, reason: "queue_full" });
			return queuedAnswer(9);
		});
		expect(calls).toEqual(["POST /step_plan/v1/chat/completions", "GET /stepcode/v1/queue"]);
		expect(last.stopReason).toBe("error");
		expect(last.errorMessage).toContain("The request queue is full. Try again later. (queue_full)");
		expect(events.filter((event) => event.type === "auto_retry_start")).toEqual([]);
		expect(events.filter((event) => event.type === "model_queue").at(-1)).toMatchObject({
			queue: null,
			closedReason: "queue_full",
		});
	});
});
