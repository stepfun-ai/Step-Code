import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@step-harness/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { USAGE_PROVENANCE_ENTRY_TYPE } from "../src/core/request-provenance.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

const api: Api = "openai-completions";

const model: Model<Api> = {
	id: "trace-model",
	name: "Trace Model",
	api,
	provider: "trace-provider",
	baseUrl: "https://trace.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
};

function reply(text: string) {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text }],
		api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	stream.push({ type: "done", reason: "stop", message });
	stream.end(message);
	return stream;
}

type Step = (options: SimpleStreamOptions | undefined) => ReturnType<typeof reply>;

describe("step.usage_provenance written by the session", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "step-usage-provenance-"));
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function run(steps: Step[]): Promise<SessionEntry[]> {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		let call = 0;
		modelRegistry.registerProvider(model.provider, {
			api,
			streamSimple: (_model, _context, options) => {
				const step = steps[Math.min(call++, steps.length - 1)];
				if (!step) throw new Error("no scripted response");
				return step(options);
			},
		});
		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime: getModelRuntime(modelRegistry),
			settingsManager: SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } }),
			sessionManager,
		});
		try {
			await session.prompt("hi");
			return sessionManager.getEntries();
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	}

	function provenance(entries: SessionEntry[]): Record<string, unknown>[] {
		return entries
			.filter(
				(entry): entry is Extract<SessionEntry, { type: "custom" }> =>
					entry.type === "custom" && entry.customType === USAGE_PROVENANCE_ENTRY_TYPE,
			)
			.map((entry) => entry.data as Record<string, unknown>);
	}

	it("records a reply with its timing, its message and the provider's own retries", async () => {
		const entries = await run([
			(options) => {
				// One failed response the provider retried past, then the answer.
				void options?.onResponse?.({ status: 200, headers: {} }, model);
				return reply("hello");
			},
		]);
		const assistant = entries.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		const records = provenance(entries);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			version: 1,
			usageEntryId: assistant?.id,
			outcome: "ok",
			statusCode: 200,
			attempt: 1,
			transportAttempts: 1,
		});
		expect(typeof records[0]?.durationMs).toBe("number");
		expect(records[0]?.retryOfRequestId).toBeUndefined();
	});

	it("records a request that failed before its stream, and links the retry that followed", async () => {
		const entries = await run([
			() => {
				throw new Error("fetch failed");
			},
			() => reply("recovered"),
		]);
		const assistants = entries.filter((entry) => entry.type === "message" && entry.message.role === "assistant");
		const records = provenance(entries);
		expect(assistants).toHaveLength(2);
		expect(records).toHaveLength(2);
		expect(records[0]).toMatchObject({
			usageEntryId: assistants[0]?.id,
			outcome: "transport_error",
			ttftMs: null,
			attempt: 1,
		});
		expect(records[1]).toMatchObject({
			usageEntryId: assistants[1]?.id,
			outcome: "ok",
			attempt: 2,
			retryOfRequestId: records[0]?.requestId,
		});
	});
});
