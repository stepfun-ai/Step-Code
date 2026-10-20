import type { Api, AssistantMessage, Model } from "@step-harness/providers";
import { describe, expect, test, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import sessionTitleExtension, {
	buildSessionTitleSource,
	regenerateSessionTitle,
} from "../src/features/session-title.ts";

const model: Model<"openai-completions"> = {
	id: "test-model",
	name: "Test model",
	api: "openai-completions",
	provider: "test",
	baseUrl: "https://example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};

function response(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
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
		stopReason,
		timestamp: 0,
	};
}

function setup(mode: ExtensionContext["mode"] = "tui") {
	const on = vi.fn();
	const sessionManager = SessionManager.inMemory();
	const complete = vi.fn<(...args: unknown[]) => Promise<AssistantMessage>>();
	let resolve: (value: AssistantMessage) => void = () => {};
	complete.mockImplementation(
		() =>
			new Promise((done) => {
				resolve = done;
			}),
	);
	const setSessionName = vi.fn((name: string) => sessionManager.appendSessionInfo(name));
	sessionTitleExtension({
		on,
		setSessionName,
		getSessionName: () => sessionManager.getSessionName(),
	} as unknown as ExtensionAPI);
	const ctx = {
		mode,
		sessionManager,
		modelRegistry: { completeSimple: complete },
		model,
	} as unknown as ExtensionContext;
	return {
		ctx,
		complete,
		setSessionName,
		sessionManager,
		resolve: (value: AssistantMessage) => resolve(value),
		emit: (name: string, event: unknown = {}) => {
			const handler = on.mock.calls.find(([key]) => key === name)?.[1] as
				| ((event: unknown, ctx: ExtensionContext) => unknown)
				| undefined;
			return handler?.(event, ctx);
		},
	};
}

describe("Pi session title extension", () => {
	test("sets a fallback immediately without awaiting the model, then persists a short title", async () => {
		const h = setup();
		expect(
			h.emit("before_agent_start", { prompt: "Fix login timeout in the authentication service" }),
		).toBeUndefined();
		expect(h.sessionManager.getSessionName()).toBe("Fix login timeout in the authe");
		expect(h.complete).toHaveBeenCalledOnce();
		h.resolve(response('"Fix login timeout"'));
		await vi.waitFor(() => expect(h.sessionManager.getSessionName()).toBe("Fix login timeout"));
		expect(h.sessionManager.getEntries().filter((entry) => entry.type === "session_info")).toHaveLength(2);
	});

	test("generates only once, with a bounded prompt and no agent tools or history", () => {
		const h = setup();
		h.emit("before_agent_start", { prompt: "x".repeat(6000) });
		h.emit("before_agent_start", { prompt: "Follow-up" });
		expect(h.complete).toHaveBeenCalledOnce();
		const [, context, options] = h.complete.mock.calls[0] as [
			unknown,
			{ messages: { content: string }[]; tools?: unknown },
			{ maxTokens: number; signal: AbortSignal; reasoning?: unknown },
		];
		expect(context.messages).toHaveLength(1);
		expect(context.messages[0].content).toHaveLength(2000);
		expect(context.tools).toBeUndefined();
		expect(options.maxTokens).toBe(256);
		// Thinking off: no reasoning level is requested for the title call.
		expect(options).not.toHaveProperty("reasoning");
		h.emit("session_shutdown");
		expect(options.signal.aborted).toBe(true);
	});

	test("ignores a delayed metadata event from its own fallback", async () => {
		const h = setup();
		h.emit("before_agent_start", { prompt: "Fix login" });
		h.emit("session_info_changed", { name: "Fix login" });
		h.resolve(response("Login timeout fix"));
		await vi.waitFor(() => expect(h.sessionManager.getSessionName()).toBe("Login timeout fix"));
	});

	test("discards a manual rename even without a metadata event", async () => {
		const h = setup();
		h.emit("before_agent_start", { prompt: "Fix login" });
		h.sessionManager.appendSessionInfo("Fix login");
		h.resolve(response("Generated title"));
		await new Promise((done) => setTimeout(done, 0));
		expect(h.setSessionName).toHaveBeenCalledOnce();
	});

	test("keeps a fallback when no model is selected", () => {
		const h = setup();
		h.ctx.model = undefined;
		h.emit("before_agent_start", { prompt: "Fix login" });
		expect(h.sessionManager.getSessionName()).toBe("Fix login");
		expect(h.complete).not.toHaveBeenCalled();
	});

	test.each(["rpc", "json", "print"] as const)("does not issue title requests in %s mode", (mode) => {
		const h = setup(mode);
		h.emit("before_agent_start", { prompt: "Fix login" });
		expect(h.complete).not.toHaveBeenCalled();
		expect(h.setSessionName).not.toHaveBeenCalled();
	});

	test("preserves an existing name and an explicitly cleared name", () => {
		for (const name of ["Manual title", ""]) {
			const h = setup();
			h.sessionManager.appendSessionInfo(name);
			h.emit("before_agent_start", { prompt: "Fix login" });
			expect(h.complete).not.toHaveBeenCalled();
		}
	});

	test.each(["Manual title", "", "Fix login"])("does not overwrite a manual rename to '%s'", async (name) => {
		const h = setup();
		h.emit("before_agent_start", { prompt: "Fix login" });
		h.sessionManager.appendSessionInfo(name);
		h.emit("session_info_changed", { name });
		h.resolve(response("Generated title"));
		await new Promise((done) => setTimeout(done, 0));
		expect(h.setSessionName).toHaveBeenCalledOnce();
		expect(h.sessionManager.getSessionName()).toBe(name || undefined);
	});

	test.each(["session_start", "session_shutdown"])("discards a late title after %s", async (event) => {
		const h = setup();
		h.emit("before_agent_start", { prompt: "Fix login" });
		h.emit(event);
		h.resolve(response("Old session title"));
		await new Promise((done) => setTimeout(done, 0));
		expect(h.setSessionName).toHaveBeenCalledOnce();
	});

	test("checks session identity even if the host has not emitted lifecycle events yet", async () => {
		const h = setup();
		h.emit("before_agent_start", { prompt: "Fix login" });
		h.sessionManager.newSession();
		h.resolve(response("Old session title"));
		await new Promise((done) => setTimeout(done, 0));
		expect(h.sessionManager.getSessionName()).toBeUndefined();
	});

	test.each(["error", "aborted", "toolUse", "pending"] as const)(
		"keeps the fallback for %s responses",
		async (reason) => {
			const h = setup();
			h.emit("before_agent_start", { prompt: "Fix login" });
			h.resolve(response("Invalid title", reason));
			await new Promise((done) => setTimeout(done, 0));
			expect(h.setSessionName).toHaveBeenCalledOnce();
		},
	);

	test("keeps the fallback on provider failure", async () => {
		const h = setup();
		h.complete.mockRejectedValue(new Error("Provider unavailable"));
		h.emit("before_agent_start", { prompt: "Fix login" });
		await new Promise((done) => setTimeout(done, 0));
		expect(h.setSessionName).toHaveBeenCalledOnce();
	});

	test("normalizes control characters and truncates Unicode by code point", async () => {
		const h = setup();
		h.emit("before_agent_start", { prompt: "\x07Fix\nlogin\x9c" });
		expect(h.sessionManager.getSessionName()).toBe("Fix login");
		h.resolve(response(`\x07${"\u{20000}".repeat(40)}\x9c`));
		await vi.waitFor(() => expect(h.sessionManager.getSessionName()).toBe("\u{20000}".repeat(15)));
	});

	test("does nothing for an empty text prompt", () => {
		const h = setup();
		h.emit("before_agent_start", { prompt: "\n\t" });
		expect(h.complete).not.toHaveBeenCalled();
	});
	test("limits Chinese titles to 15 characters and strips trailing punctuation", async () => {
		const h = setup();
		h.emit("before_agent_start", { prompt: "修复登录接口超时" });
		h.resolve(response("排查并修复登录接口在高并发下的超时问题。\n第二行说明"));
		await vi.waitFor(() => expect(h.sessionManager.getSessionName()).toBe("排查并修复登录接口在高并发下的"));
	});

	test("keeps short titles whole after removing trailing punctuation", async () => {
		const h = setup();
		h.emit("before_agent_start", { prompt: "修复登录接口超时" });
		h.resolve(response("登录接口超时排查。"));
		await vi.waitFor(() => expect(h.sessionManager.getSessionName()).toBe("登录接口超时排查"));
	});
});

function userMessage(text: string) {
	return { role: "user" as const, content: text, timestamp: 0 };
}

describe("session title regeneration", () => {
	function regenerateTarget(reply: () => Promise<AssistantMessage>) {
		const sessionManager = SessionManager.inMemory();
		const completeSimple = vi.fn(reply);
		const target = {
			model: model as Model<Api> | undefined,
			modelRuntime: { completeSimple },
			sessionManager,
			setSessionName: (name: string) => sessionManager.appendSessionInfo(name),
		};
		return { target, sessionManager, completeSimple };
	}

	test("builds the source from the original request and the latest conversation", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(userMessage("修复登录接口超时"));
		sessionManager.appendMessage(response("已定位到连接池配置"));
		sessionManager.appendMessage(userMessage("x".repeat(9000)));
		const source = buildSessionTitleSource(sessionManager.getBranch()) ?? "";
		expect(source.startsWith("Original request:\n修复登录接口超时\n\nRecent conversation:\n")).toBe(true);
		expect(source.length).toBe(8000);
		expect(source.endsWith("x")).toBe(true);
		expect(buildSessionTitleSource([])).toBeUndefined();
	});

	test("renames from the conversation without reasoning", async () => {
		const h = regenerateTarget(async () => response("登录接口超时修复"));
		h.sessionManager.appendMessage(userMessage("修复登录接口超时"));
		h.sessionManager.appendSessionInfo("修复登录接口超时");
		await expect(regenerateSessionTitle(h.target)).resolves.toEqual({ status: "renamed", title: "登录接口超时修复" });
		expect(h.sessionManager.getSessionName()).toBe("登录接口超时修复");
		const [, , options] = h.completeSimple.mock.calls[0] as unknown as [unknown, unknown, Record<string, unknown>];
		expect(options).not.toHaveProperty("reasoning");
	});

	test("reports unchanged, empty, missing model, and failed generations", async () => {
		const same = regenerateTarget(async () => response("登录接口超时修复"));
		same.sessionManager.appendMessage(userMessage("修复登录接口超时"));
		same.sessionManager.appendSessionInfo("登录接口超时修复");
		await expect(regenerateSessionTitle(same.target)).resolves.toEqual({
			status: "unchanged",
			title: "登录接口超时修复",
		});

		const empty = regenerateTarget(async () => response("unused"));
		await expect(regenerateSessionTitle(empty.target)).resolves.toEqual({ status: "empty" });
		expect(empty.completeSimple).not.toHaveBeenCalled();

		const noModel = regenerateTarget(async () => response("unused"));
		noModel.sessionManager.appendMessage(userMessage("修复登录接口超时"));
		await expect(regenerateSessionTitle({ ...noModel.target, model: undefined })).resolves.toEqual({
			status: "no-model",
		});

		const failed = regenerateTarget(async () => {
			throw new Error("Provider unavailable");
		});
		failed.sessionManager.appendMessage(userMessage("修复登录接口超时"));
		await expect(regenerateSessionTitle(failed.target)).resolves.toEqual({ status: "failed" });

		const errored = regenerateTarget(async () => response("Ignored", "error"));
		errored.sessionManager.appendMessage(userMessage("修复登录接口超时"));
		await expect(regenerateSessionTitle(errored.target)).resolves.toEqual({ status: "failed" });
	});

	test("does not overwrite a name changed while the request runs", async () => {
		let resolve: (value: AssistantMessage) => void = () => {};
		const h = regenerateTarget(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		h.sessionManager.appendMessage(userMessage("修复登录接口超时"));
		const pending = regenerateSessionTitle(h.target);
		h.sessionManager.appendSessionInfo("人工标题");
		resolve(response("生成的标题"));
		await expect(pending).resolves.toEqual({ status: "superseded" });
		expect(h.sessionManager.getSessionName()).toBe("人工标题");
	});

	test("propagates cancellation and discards a response even when the provider ignores abort", async () => {
		let resolve: (value: AssistantMessage) => void = () => {};
		const h = regenerateTarget(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		h.sessionManager.appendMessage(userMessage("修复登录接口超时"));
		h.sessionManager.appendSessionInfo("原名称");
		const controller = new AbortController();
		const pending = regenerateSessionTitle(h.target, controller.signal);
		const [, , options] = h.completeSimple.mock.calls[0] as unknown as [unknown, unknown, { signal: AbortSignal }];
		controller.abort();
		expect(options.signal.aborted).toBe(true);
		resolve(response("迟到名称"));
		await expect(pending).resolves.toEqual({ status: "superseded" });
		expect(h.sessionManager.getSessionName()).toBe("原名称");
	});
});
