import type { Api, Context, Model, SimpleStreamOptions } from "@step-harness/providers";
import { afterEach, describe, expect, test, vi } from "vitest";
import { streamSimple as messagesStream } from "../../providers/src/api/anthropic-messages.ts";
import { streamSimple as responsesStream } from "../../providers/src/api/openai-responses.ts";
import runtimeInfo from "../examples/extensions/runtime-info.ts";
import type {
	ContextUsage,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionEvent,
	SessionCompactEvent,
} from "../src/core/extensions/types.ts";

type Hook = (event: ExtensionEvent, ctx: ExtensionContext) => unknown;
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

type Report = {
	type: "runtime-info";
	event: string;
	model: {
		id: string | null;
		provider: string | null;
		api: string | null;
		contextWindow: number | null;
		configuredMaxTokens: number | null;
	};
	thinkingLevel: string | null;
	contextUsage: { tokens: number | null; contextWindow: number | null; percent: number | null };
	lastRequest: {
		max_output_tokens: number | null;
		max_tokens: number | null;
		max_completion_tokens: number | null;
	} | null;
};

function model(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "test-model",
		name: "Test model",
		provider: "test-provider",
		api: "openai-responses",
		baseUrl: "https://model.invalid/secret-endpoint",
		headers: { Authorization: "Bearer model-secret" },
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 32_000,
		...overrides,
	};
}

function harness(options: { flag?: boolean | string; mode?: ExtensionContext["mode"] } = {}) {
	const hooks = new Map<string, Hook[]>();
	const commands = new Map<string, Command>();
	const flags = new Map<string, Parameters<ExtensionAPI["registerFlag"]>[1]>();
	const state = {
		model: model() as Model<Api> | undefined,
		thinkingLevel: "medium" as ExtensionContext["thinkingLevel"],
		usage: { tokens: 96_000, contextWindow: 128_000, percent: 75 } as ContextUsage | undefined,
		sessionId: "session-one",
		flag: options.flag,
	};
	const stderr: string[] = [];
	const notifications: string[] = [];
	const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	vi.spyOn(process.stderr, "write").mockImplementation((text) => {
		stderr.push(String(text));
		return true;
	});
	const forbidden = {
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
		appendEntry: vi.fn(),
		setModel: vi.fn(),
		setThinkingLevel: vi.fn(),
		setActiveTools: vi.fn(),
		registerTool: vi.fn(),
		registerTools: vi.fn(),
		exec: vi.fn(),
		compact: vi.fn(),
		abort: vi.fn(),
		shutdown: vi.fn(),
		newSession: vi.fn(),
		fork: vi.fn(),
		navigateTree: vi.fn(),
		switchSession: vi.fn(),
		reload: vi.fn(),
		getSystemPrompt: vi.fn(),
		getSystemPromptOptions: vi.fn(),
	};
	const getContextUsage = vi.fn(() => state.usage);
	const getSessionId = vi.fn(() => state.sessionId);
	const getThinkingLevel = vi.fn(() => state.thinkingLevel);
	const getFlag = vi.fn(() => state.flag);
	const api = {
		...forbidden,
		on(event: string, handler: Hook) {
			hooks.set(event, [...(hooks.get(event) ?? []), handler]);
		},
		registerCommand(name: string, command: Command) {
			commands.set(name, command);
		},
		registerFlag(name: string, flag: Parameters<ExtensionAPI["registerFlag"]>[1]) {
			flags.set(name, flag);
		},
		getFlag,
		getThinkingLevel,
	} as unknown as ExtensionAPI;
	const mode = options.mode ?? "json";
	const ctx: ExtensionCommandContext = {
		...forbidden,
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		ui: {
			notify(text: string) {
				notifications.push(text);
			},
		} as ExtensionContext["ui"],
		cwd: "/synthetic-workspace",
		sessionManager: { getSessionId } as unknown as ExtensionContext["sessionManager"],
		modelRegistry: {} as ExtensionContext["modelRegistry"],
		get model() {
			return state.model;
		},
		get thinkingLevel() {
			return state.thinkingLevel;
		},
		scopedModels: [],
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		hasPendingMessages: () => false,
		waitForIdle: async () => {},
		getContextUsage,
	};
	runtimeInfo(api);
	const emit = async (event: ExtensionEvent) => {
		const results: unknown[] = [];
		for (const handler of hooks.get(event.type) ?? []) results.push(await handler(event, ctx));
		return results;
	};
	return {
		state,
		ctx,
		hooks,
		flags,
		commands,
		stderr,
		notifications,
		stdout,
		forbidden,
		getContextUsage,
		getSessionId,
		getThinkingLevel,
		getFlag,
		emit,
		start: () => emit({ type: "session_start", reason: "startup" }),
		request: (payload: unknown) => emit({ type: "before_provider_request", payload }),
		async command(args = "") {
			const command = commands.get("runtime-info");
			expect(command, "extension registers /runtime-info").toBeDefined();
			await command!.handler(args, ctx);
		},
		reports: (): Report[] => [...stderr, ...notifications].map((line) => JSON.parse(line)),
		last: (): Report => {
			const line = [...stderr, ...notifications].at(-1);
			expect(line, "an opted-in diagnostic report was emitted").toBeDefined();
			return JSON.parse(line!);
		},
	};
}

const compacted: SessionCompactEvent = {
	type: "session_compact",
	compactionEntry: {
		type: "compaction",
		id: "compaction-one",
		parentId: null,
		timestamp: "2026-10-11T00:00:00.000Z",
		summary: "private compaction summary",
		firstKeptEntryId: "entry-two",
		tokensBefore: 96_000,
	},
	fromExtension: false,
	reason: "manual",
	willRetry: false,
};

afterEach(() => vi.restoreAllMocks());

describe("runtime-info example extension", () => {
	test("registers only extension-local opt-ins without reading runtime state in the factory", () => {
		const h = harness();
		expect([...h.commands.keys()]).toEqual(["runtime-info"]);
		expect([...h.flags.entries()]).toEqual([
			["runtime-info", { description: expect.any(String), type: "boolean", default: false }],
		]);
		expect(h.getFlag).not.toHaveBeenCalled();
		expect(h.getContextUsage).not.toHaveBeenCalled();
		expect(h.getThinkingLevel).not.toHaveBeenCalled();
		expect(h.reports()).toEqual([]);
	});

	test.each([undefined, false, "true"])("stays inactive without a boolean opt-in (%s)", async (flag) => {
		const h = harness({ flag });
		await h.start();
		const payload = Object.defineProperty({}, "max_output_tokens", {
			get: () => {
				throw new Error("inactive diagnostics must not inspect the payload");
			},
		});
		await h.emit({ type: "context", messages: [] });
		await h.request(payload);
		await h.emit(compacted);
		await h.emit({ type: "model_select", model: h.state.model!, previousModel: undefined, source: "set" });
		expect(h.reports()).toEqual([]);
		expect(h.getContextUsage).not.toHaveBeenCalled();
		expect(h.getSessionId).not.toHaveBeenCalled();
		expect(h.getThinkingLevel).not.toHaveBeenCalled();
		expect(h.stdout).not.toHaveBeenCalled();
	});

	test("reports the resolved runtime after flags are available at session_start", async () => {
		const h = harness();
		h.state.flag = true;
		await h.start();
		expect(h.reports()).toEqual([
			{
				type: "runtime-info",
				event: "session_start",
				model: {
					id: "test-model",
					provider: "test-provider",
					api: "openai-responses",
					contextWindow: 128_000,
					configuredMaxTokens: 32_000,
				},
				thinkingLevel: "medium",
				contextUsage: { tokens: 96_000, contextWindow: 128_000, percent: 75 },
				lastRequest: null,
			},
		]);
	});

	test.each(["tui", "rpc", "print", "json"] as const)(
		"/runtime-info inspects locally in %s without a model call or execution turn",
		async (mode) => {
			const h = harness({ mode });
			await h.start();
			const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network call"));
			await h.command();
			expect(h.reports()).toHaveLength(1);
			expect(h.last().event).toBe("command");
			expect(h.last().lastRequest).toBeNull();
			expect(h.notifications).toHaveLength(mode === "tui" || mode === "rpc" ? 1 : 0);
			expect(h.stderr).toHaveLength(mode === "print" || mode === "json" ? 1 : 0);
			for (const method of Object.values(h.forbidden)) expect(method).not.toHaveBeenCalled();
			expect(fetch).not.toHaveBeenCalled();
			expect(h.stdout).not.toHaveBeenCalled();
		},
	);

	test.each([
		["openai-responses", "max_output_tokens", 16],
		["anthropic-messages", "max_tokens", 4096],
		["openai-completions", "max_completion_tokens", 2048],
		["openai-completions", "max_tokens", 1024],
	] as const)("reports %s request %s separately from the configured ceiling", async (api, field, ceiling) => {
		const h = harness({ flag: true });
		h.state.model = model({ api });
		await h.start();
		const payload = Object.freeze({ model: "wire-model-alias", [field]: ceiling, stream: true });
		expect(await h.request(payload)).toEqual([undefined]);
		expect(h.last().model.configuredMaxTokens).toBe(32_000);
		expect(h.last().model.id).toBe("test-model");
		expect(h.last().lastRequest).toEqual({
			max_output_tokens: null,
			max_tokens: null,
			max_completion_tokens: null,
			[field]: ceiling,
		});
		await h.command();
		expect(h.last().lastRequest?.[field]).toBe(ceiling);
		expect(payload[field]).toBe(ceiling);
	});

	test("a command opts into future hooks and off stops observation", async () => {
		const h = harness();
		await h.start();
		await h.request({ max_output_tokens: 10_000 });
		await h.command();
		expect(h.last().lastRequest).toBeNull();
		await h.request({ max_output_tokens: 2000 });
		expect(h.last().lastRequest?.max_output_tokens).toBe(2000);
		await h.command("off");
		const count = h.reports().length;
		h.getContextUsage.mockClear();
		await h.request({ max_output_tokens: 1000 });
		await h.emit({ type: "context", messages: [] });
		expect(h.reports()).toHaveLength(count);
		expect(h.getContextUsage).not.toHaveBeenCalled();
		await h.command();
		expect(h.last().lastRequest).toBeNull();
	});

	test("clears the last request for a new context without reading or changing messages", async () => {
		const h = harness({ flag: true });
		await h.start();
		await h.request({ max_output_tokens: 2000 });
		const event = Object.defineProperty({ type: "context" }, "messages", {
			get: () => {
				throw new Error("private message bodies must not be read");
			},
		}) as ExtensionEvent;
		expect(await h.emit(event)).toEqual([undefined]);
		expect(h.last().event).toBe("context");
		expect(h.last().lastRequest).toBeNull();
	});

	test("missing model, reasoning and context values stay unknown", async () => {
		const h = harness({ flag: true });
		h.state.model = undefined;
		h.state.thinkingLevel = undefined;
		h.state.usage = undefined;
		await h.start();
		expect(h.last().model).toEqual({
			id: null,
			provider: null,
			api: null,
			contextWindow: null,
			configuredMaxTokens: null,
		});
		expect(h.last().thinkingLevel).toBeNull();
		expect(h.last().contextUsage).toEqual({ tokens: null, contextWindow: null, percent: null });
		await h.request({ max_output_tokens: 2000 });
		expect(h.last().lastRequest).toEqual({ max_output_tokens: null, max_tokens: null, max_completion_tokens: null });
	});

	test("compaction and tree navigation discard request info and preserve unknown usage", async () => {
		const h = harness({ flag: true });
		await h.start();
		await h.request({ max_output_tokens: 2000 });
		h.state.usage = { tokens: null, contextWindow: 128_000, percent: null };
		expect(await h.emit(compacted)).toEqual([undefined]);
		expect(h.last().event).toBe("session_compact");
		expect(h.last().contextUsage).toEqual({ tokens: null, contextWindow: 128_000, percent: null });
		expect(h.last().lastRequest).toBeNull();
		await h.request({ max_output_tokens: 1000 });
		await h.emit({ type: "session_tree", oldLeafId: "one", newLeafId: "two" });
		expect(h.last().lastRequest).toBeNull();
	});

	test.each(["new", "resume", "fork", "reload"] as const)(
		"session_start (%s) clears request state",
		async (reason) => {
			const h = harness({ flag: true });
			await h.start();
			await h.request({ max_output_tokens: 2000 });
			await h.emit({ type: "session_start", reason, previousSessionFile: "/private/session.jsonl" });
			expect(h.last().lastRequest).toBeNull();
			await h.command();
			expect(h.last().lastRequest).toBeNull();
		},
	);

	test("command opt-in does not survive session replacement or shutdown", async () => {
		const h = harness();
		await h.start();
		await h.command();
		await h.request({ max_output_tokens: 2000 });
		await h.emit({ type: "session_shutdown", reason: "new" });
		const count = h.reports().length;
		await h.request({ max_output_tokens: 1000 });
		h.state.sessionId = "session-two";
		await h.emit({ type: "session_start", reason: "new" });
		await h.request({ max_output_tokens: 1000 });
		expect(h.reports()).toHaveLength(count);
		await h.command();
		expect(h.last().lastRequest).toBeNull();
	});

	test("model selection clears old requests even when the same model is selected again", async () => {
		const h = harness({ flag: true });
		await h.start();
		await h.request({ max_output_tokens: 2000 });
		await h.emit({ type: "model_select", model: h.state.model!, previousModel: h.state.model, source: "set" });
		expect(h.last().lastRequest).toBeNull();
	});

	test.each(["id", "provider", "api", "contextWindow", "maxTokens", "session", "thinking"] as const)(
		"live %s changes cannot inherit stale request info even without a hook",
		async (field) => {
			const h = harness({ flag: true });
			await h.start();
			await h.request({ max_output_tokens: 2000 });
			if (field === "session") h.state.sessionId = "session-two";
			else if (field === "thinking") h.state.thinkingLevel = "high";
			else {
				const changed = {
					id: "other-model",
					provider: "other-provider",
					api: "anthropic-messages",
					contextWindow: 64_000,
					maxTokens: 8000,
				};
				h.state.model = model({ [field]: changed[field] });
			}
			await h.command();
			expect(h.last().lastRequest).toBeNull();
		},
	);

	test.each([undefined, null, "2000", 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, true, {}, 2000n])(
		"does not coerce invalid request ceilings (%s) or reuse a previous value",
		async (value) => {
			const h = harness({ flag: true });
			await h.start();
			await h.request({ max_output_tokens: 2000 });
			await h.request({ max_output_tokens: value });
			expect(h.last().lastRequest?.max_output_tokens).toBeNull();
		},
	);

	test.each([
		null,
		undefined,
		"private body",
		[],
		{ body: { max_output_tokens: 2000 } },
		Object.create({ max_output_tokens: 2000 }),
	])("unknown payload shapes have unknown ceilings", async (payload) => {
		const h = harness({ flag: true });
		await h.start();
		await h.request(payload);
		expect(h.last().lastRequest).toEqual({ max_output_tokens: null, max_tokens: null, max_completion_tokens: null });
	});

	test("ignores accessors and unrecognized APIs instead of guessing a ceiling", async () => {
		const h = harness({ flag: true });
		await h.start();
		const getter = vi.fn(() => 2000);
		await h.request(Object.defineProperty({}, "max_output_tokens", { get: getter }));
		expect(getter).not.toHaveBeenCalled();
		expect(h.last().lastRequest?.max_output_tokens).toBeNull();
		h.state.model = model({ api: "custom-api" });
		await h.request({ max_output_tokens: 2000, max_tokens: 2000, max_completion_tokens: 2000 });
		expect(h.last().lastRequest).toEqual({ max_output_tokens: null, max_tokens: null, max_completion_tokens: null });
	});

	test("emits only allowlisted primitives and never reads secret-bearing payload or model fields", async () => {
		const h = harness({ flag: true });
		const readSecret = vi.fn(() => {
			throw new Error("private field read");
		});
		Object.defineProperty(h.state.model!, "baseUrl", { get: readSecret });
		Object.defineProperty(h.state.model!, "headers", { get: readSecret });
		await h.start();
		const payload = {
			max_output_tokens: 2000,
			model: "secret-wire-model",
			apiKey: "secret-api-key",
			headers: { Authorization: "Bearer secret-header" },
			baseUrl: "https://secret.invalid/endpoint",
			input: [{ content: "secret-input" }],
			messages: [{ role: "user", content: "secret-message" }],
			prompt: "secret-prompt",
			reasoning: { effort: "secret-reasoning" },
			metadata: { user: "secret-user" },
			toJSON: readSecret,
		};
		Object.defineProperty(payload, "instructions", { get: readSecret });
		Object.freeze(payload);
		expect(await h.request(payload)).toEqual([undefined]);
		await h.command();
		expect(readSecret).not.toHaveBeenCalled();
		expect(h.last().lastRequest).toEqual({ max_output_tokens: 2000, max_tokens: null, max_completion_tokens: null });
		expect(h.stderr.join("")).not.toMatch(
			/secret|Authorization|apiKey|headers|baseUrl|input|messages|prompt|metadata|session-one/,
		);
		for (const method of Object.values(h.forbidden)) expect(method).not.toHaveBeenCalled();
	});

	test("omits invalid or oversized identifiers and numbers instead of serializing arbitrary values", async () => {
		const h = harness({ flag: true });
		h.state.model = {
			...model(),
			id: "x".repeat(100_000),
			provider: "https://secret.invalid/path",
			api: "bad\napi",
			contextWindow: -1,
			maxTokens: "secret-ceiling",
		} as unknown as Model<Api>;
		h.state.thinkingLevel = "secret-level" as ExtensionContext["thinkingLevel"];
		h.state.usage = { tokens: NaN, contextWindow: 0, percent: Infinity };
		await h.start();
		expect(h.last().model).toEqual({
			id: null,
			provider: null,
			api: null,
			contextWindow: null,
			configuredMaxTokens: null,
		});
		expect(h.last().thinkingLevel).toBeNull();
		expect(h.last().contextUsage).toEqual({ tokens: null, contextWindow: null, percent: null });
		expect(h.stderr.join("")).not.toContain("secret");
		expect(Buffer.byteLength(h.stderr[0])).toBeLessThanOrEqual(2048);
		expect(h.stderr[0].split("\n")).toHaveLength(2);
	});

	test("preserves known zero usage and reads the effective thinking level on every report", async () => {
		const h = harness({ flag: true });
		h.state.usage = { tokens: 0, contextWindow: 128_000, percent: 0 };
		h.state.thinkingLevel = "off";
		await h.start();
		expect(h.last().contextUsage).toEqual(h.state.usage);
		expect(h.last().thinkingLevel).toBe("off");
		await h.request({ max_output_tokens: 2000 });
		h.state.thinkingLevel = "low";
		await h.emit({ type: "thinking_level_select", level: "low", previousLevel: "off" });
		expect(h.last().thinkingLevel).toBe("low");
		expect(h.last().lastRequest).toBeNull();
	});

	test.each(["model_select", "thinking_level_select", "live-model"] as const)(
		"does not attribute a pending request to a changed runtime (%s)",
		async (change) => {
			const h = harness({ flag: true });
			await h.start();
			await h.emit({ type: "context", messages: [] });
			if (change === "thinking_level_select") {
				h.state.thinkingLevel = "high";
				await h.emit({ type: "thinking_level_select", level: "high", previousLevel: "medium" });
			} else {
				h.state.model = model({ id: "new-model" });
				if (change === "model_select") {
					await h.emit({ type: "model_select", model: h.state.model, previousModel: model(), source: "set" });
				}
			}
			await h.request({ max_output_tokens: 2000 });
			expect(h.last().lastRequest).toBeNull();
			await h.emit({ type: "context", messages: [] });
			await h.request({ max_output_tokens: 1000 });
			expect(h.last().lastRequest?.max_output_tokens).toBe(1000);
		},
	);

	test.each([
		{ api: "openai-responses", field: "max_output_tokens", contextWindow: 8192, inputTokens: 8192, ceiling: 16 },
		{ api: "anthropic-messages", field: "max_tokens", contextWindow: 16384, inputTokens: 10240, ceiling: 2048 },
	] as const)("observes the real $api serializer's context clamp without changing the request", async (fixture) => {
		const h = harness({ flag: true });
		h.state.model = model({ api: fixture.api, contextWindow: fixture.contextWindow });
		h.state.thinkingLevel = "off";
		await h.start();
		const context: Context = {
			messages: [{ role: "user", content: "private fixture prompt", timestamp: 0 }],
			estimatedInputTokens: fixture.inputTokens,
		};
		await h.emit({ type: "context", messages: context.messages });
		let wireBody: Record<string, unknown> | undefined;
		const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
			wireBody = JSON.parse(init!.body as string);
			return new Response(JSON.stringify({ error: { message: "fixture request complete" } }), {
				status: 400,
				headers: { "content-type": "application/json" },
			});
		});
		const options: SimpleStreamOptions = {
			apiKey: "fixture-key",
			maxRetries: 0,
			fetch,
			onPayload: async (payload) => {
				expect(await h.request(Object.freeze(payload))).toEqual([undefined]);
			},
		};
		const stream =
			fixture.api === "openai-responses"
				? responsesStream(h.state.model as Model<"openai-responses">, context, options)
				: messagesStream(h.state.model as Model<"anthropic-messages">, context, options);
		await stream.result();
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(wireBody?.[fixture.field]).toBe(fixture.ceiling);
		expect(h.last().model.configuredMaxTokens).toBe(32_000);
		expect(h.last().lastRequest?.[fixture.field]).toBe(wireBody?.[fixture.field]);
		expect(h.stderr.join("")).not.toMatch(/private fixture prompt|fixture-key/);
	});
});
