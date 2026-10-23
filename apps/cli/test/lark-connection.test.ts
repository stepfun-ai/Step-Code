import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, UIDecisionRequest } from "@step-harness/coding-agent";
import type * as LarkAdapter from "@step-harness/lark-adapter";
import { createLarkConnectionExtension } from "../src/ui/runtime/lark-connection.ts";

const fixture = vi.hoisted(() => ({
	begin: vi.fn(), wait: vi.fn(), identity: vi.fn(), close: vi.fn(async () => {}),
	start: vi.fn(async () => {}), stop: vi.fn(), send: vi.fn(async (_chat: string, _card: unknown) => "card"), update: vi.fn(async () => {}),
	options: {} as Record<string, unknown>,
}));
vi.mock("@step-harness/lark-adapter", async () => ({
	...await vi.importActual<typeof LarkAdapter>("@step-harness/lark-adapter"),
	LarkRegistration: class { begin = fixture.begin; waitForAuthorization = fixture.wait; },
	LarkApi: class { getBotIdentity = fixture.identity; close = fixture.close; sendCard = fixture.send; updateCard = fixture.update; },
	LarkTransport: class {
		constructor(options: Record<string, unknown>) { fixture.options = options; }
		start = fixture.start;
		chatId: string | undefined = "chat";
		close() { this.chatId = undefined; fixture.stop(); }
	},
}));

describe("current-session Lark connection", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		fixture.begin.mockResolvedValue({ deviceCode: "device", verificationUrl: "https://open.feishu.cn/page/cli", expiresInSeconds: 30, pollIntervalSeconds: 2 });
		fixture.wait.mockResolvedValue({ status: "authorized", credentials: { appId: "app", appSecret: "fixture", brand: "feishu" } });
		fixture.identity.mockResolvedValue({ openId: "bot", name: "Step" });
	});

	function setup(mode: "tui" | "print" = "tui") {
		let command: (args: string, context: ExtensionCommandContext) => Promise<void> = async () => {};
		const submit = vi.fn();
		const notify = vi.fn();
		const widget = vi.fn();
		const status = vi.fn();
		const handlers = new Map<string, (...args: unknown[]) => unknown>();
		let decision: ((request: UIDecisionRequest) => void) | undefined;
		const unsubscribe = vi.fn(() => { decision = undefined; });
		const pi = {
			registerCommand: (_name: string, options: { handler: typeof command }) => { command = options.handler; },
			on: (name: string, handler: (...args: unknown[]) => unknown) => { handlers.set(name, handler); },
			sendUserMessage: submit,
		} as unknown as ExtensionAPI;
		const context = { mode, sessionManager: { getSessionId: () => "session-fixture" }, model: { id: "step-3.5-flash" }, thinkingLevel: "high", ui: { notify, setStatus: status, setWidget: widget, onDecision: (listener: (request: UIDecisionRequest) => void) => { decision = listener; return unsubscribe; } } } as unknown as ExtensionCommandContext;
		createLarkConnectionExtension()(pi);
		return { command: (args: string) => command(args, context), context, submit, notify, widget, status, handlers, decision: (request: UIDecisionRequest) => decision?.(request), unsubscribe };
	}

	it("shows callback setup only after connecting and removes it on disconnect", async () => {
		const harness = setup();
		await harness.command("lark");
		await vi.waitFor(() => expect(harness.widget).toHaveBeenCalledWith("lark-pairing", [
			"Lark connected. Enable card callbacks for remote approvals:",
			expect.stringContaining("https://open.feishu.cn/page/launcher?clientID=app&addons="),
			"Confirm card.action.trigger in the browser. Keep this terminal connected.",
		]));
		expect(JSON.stringify(harness.widget.mock.calls)).not.toContain("fixture");
		expect(harness.status).toHaveBeenCalledWith("lark", "lark · connected · @Step · session-fixture");
		expect(harness.notify).toHaveBeenCalledWith("connect · lark · connected · @Step · session-fixture");
		await harness.command("off");
		expect(harness.widget).toHaveBeenLastCalledWith("lark-pairing", undefined);
		expect(harness.status).toHaveBeenLastCalledWith("lark", undefined);
	});

	it.each(["off", "lark off"])("notifies the bound chat before closing on %s", async (command) => {
		const harness = setup();
		await harness.command("lark");
		await vi.waitFor(() => expect(fixture.start).toHaveBeenCalled());
		await harness.command(command);
		expect(fixture.send).toHaveBeenCalledExactlyOnceWith("chat", expect.objectContaining({
			elements: [{ tag: "div", text: { tag: "plain_text", content: "Terminal disconnected. This session no longer receives messages or handles remote approvals." } }],
		}));
		expect(fixture.send.mock.invocationCallOrder[0]).toBeLessThan(fixture.close.mock.invocationCallOrder[0]!);
	});

	it("cleans up even when the disconnect notification fails", async () => {
		const harness = setup();
		await harness.command("lark");
		await vi.waitFor(() => expect(fixture.start).toHaveBeenCalled());
		fixture.send.mockRejectedValueOnce(new Error("private SDK response"));
		await harness.command("off");
		expect(fixture.close).toHaveBeenCalledTimes(1);
		expect(harness.notify).toHaveBeenLastCalledWith("connect · lark · disconnected");
		expect(JSON.stringify(harness.notify.mock.calls)).not.toContain("private SDK response");
	});

	it("updates the bound output card when terminal model and effort selections change", async () => {
		const harness = setup();
		await harness.command("lark");
		await vi.waitFor(() => expect(fixture.start).toHaveBeenCalled());
		harness.handlers.get("before_agent_start")?.({ prompt: "hello" }, harness.context);
		await vi.waitFor(() => expect(fixture.send).toHaveBeenCalled());
		expect(JSON.stringify(fixture.send.mock.calls)).toContain("Model: step-3.5-flash | Effort: high");
		harness.handlers.get("model_select")?.({ model: { id: "new-model" } }, harness.context);
		await vi.waitFor(() => expect(JSON.stringify(fixture.update.mock.calls)).toContain("Model: new-model | Effort: high"));
		harness.context.model = { id: "new-model" } as typeof harness.context.model;
		harness.handlers.get("thinking_level_select")?.({ level: "low" }, harness.context);
		await vi.waitFor(() => expect(JSON.stringify(fixture.update.mock.calls)).toContain("Model: new-model | Effort: low"));
		await harness.command("off");
		const count = fixture.update.mock.calls.length;
		harness.handlers.get("thinking_level_select")?.({ level: "high" }, harness.context);
		await Promise.resolve();
		expect(fixture.update).toHaveBeenCalledTimes(count);
	});

	it("installs a full pairing component and does not announce success before the handshake", async () => {
		let ready: () => void = () => {};
		fixture.start.mockReturnValueOnce(new Promise<void>((resolve) => { ready = resolve; }));
		const harness = setup();
		await harness.command("lark");
		await vi.waitFor(() => expect(fixture.start).toHaveBeenCalled());
		expect(harness.widget).toHaveBeenCalledWith("lark-pairing", expect.any(Function));
		expect(harness.notify).not.toHaveBeenCalledWith(expect.stringContaining("connect · lark · connected"));
		ready();
		await vi.waitFor(() => expect(harness.notify).toHaveBeenCalledWith("connect · lark · connected · @Step · session-fixture"));
		await harness.command("off");
	});

	it("disconnects during startup without announcing late success", async () => {
		let ready: () => void = () => {};
		fixture.start.mockReturnValueOnce(new Promise<void>((resolve) => { ready = resolve; }));
		const harness = setup();
		await harness.command("lark");
		await vi.waitFor(() => expect(fixture.start).toHaveBeenCalled());
		await harness.command("off");
		ready();
		await Promise.resolve();
		expect(harness.notify).not.toHaveBeenCalledWith(expect.stringContaining("connect · lark · connected"));
		expect(harness.status).toHaveBeenLastCalledWith("lark", undefined);
		await harness.command("lark");
		await vi.waitFor(() => expect(harness.notify).toHaveBeenCalledWith("connect · lark · connected · @Step · session-fixture"));
		await harness.command("off");
	});

	it("cleans up a failed handshake and permits a new connection", async () => {
		fixture.start.mockRejectedValueOnce(new Error("fixture handshake failed"));
		const harness = setup();
		await harness.command("lark");
		await vi.waitFor(() => expect(harness.notify).toHaveBeenCalledWith("Lark connection failed during WebSocket handshake. Retry /connect lark.", "warning"));
		expect(fixture.stop).toHaveBeenCalledTimes(1);
		expect(fixture.close).toHaveBeenCalledTimes(1);
		expect(harness.status).toHaveBeenLastCalledWith("lark", undefined);
		await harness.command("lark");
		await vi.waitFor(() => expect(harness.notify).toHaveBeenCalledWith("connect · lark · connected · @Step · session-fixture"));
		expect(fixture.begin).toHaveBeenCalledTimes(2);
		await harness.command("off");
	});

	it("submits accepted input without a reaction API and rejects input during a dialog", async () => {
		const harness = setup();
		await harness.command("lark");
		await vi.waitFor(() => expect(fixture.start).toHaveBeenCalled());
		const message = fixture.options.onMessage as (message: unknown) => void;
		message({ id: "accepted", chatId: "chat", text: "hello", imageKeys: [], files: [] });
		await vi.waitFor(() => expect(harness.submit).toHaveBeenCalledTimes(1));
		harness.handlers.get("ui_prompt_start")?.({});
		message({ id: "blocked", chatId: "chat", text: "blocked", imageKeys: [], files: [] });
		await vi.waitFor(() => expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("terminal dialog"), "warning"));
		expect(harness.submit).toHaveBeenCalledTimes(1);
		await harness.command("off");
	});

	it("continues delivering queued input while an earlier reply card is pending", async () => {
		const harness = setup();
		await harness.command("lark");
		await vi.waitFor(() => expect(fixture.start).toHaveBeenCalled());
		const message = fixture.options.onMessage as (message: unknown) => void;
		message({ id: "first", chatId: "chat", text: "first", imageKeys: [], files: [] });
		await vi.waitFor(() => expect(harness.submit).toHaveBeenCalledTimes(1));
		let deliver: (id: string) => void = () => {};
		fixture.send.mockReturnValueOnce(new Promise((resolve) => { deliver = resolve; }));
		harness.handlers.get("before_agent_start")?.({ prompt: "first" }, harness.context);
		await vi.waitFor(() => expect(fixture.send).toHaveBeenCalled());
		message({ id: "second", chatId: "chat", text: "second", imageKeys: [], files: [] });
		await vi.waitFor(() => expect(harness.submit).toHaveBeenCalledTimes(2));
		deliver("reply");
		await Promise.resolve();
		harness.handlers.get("before_agent_start")?.({ prompt: "second" }, harness.context);
		await vi.waitFor(() => expect(fixture.send).toHaveBeenCalledTimes(2));
		expect(JSON.stringify(fixture.send.mock.calls[1])).toContain("second");
		await harness.command("lark off");
		expect(harness.status).toHaveBeenLastCalledWith("lark", undefined);
		expect(harness.notify).toHaveBeenLastCalledWith("connect · lark · disconnected");
	});

	it("does not report an old turn's failed card as an output failure for the new turn", async () => {
		const harness = setup();
		await harness.command("lark");
		await vi.waitFor(() => expect(fixture.start).toHaveBeenCalled());
		let fail: (error: Error) => void = () => {};
		fixture.send.mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }));
		harness.handlers.get("before_agent_start")?.({ prompt: "first" }, harness.context);
		await vi.waitFor(() => expect(fixture.send).toHaveBeenCalledTimes(1));
		harness.handlers.get("before_agent_start")?.({ prompt: "second" }, harness.context);
		fail(new Error("old card failure"));
		await vi.waitFor(() => expect(fixture.send).toHaveBeenCalledTimes(2));
		expect(harness.status).not.toHaveBeenCalledWith("lark", "Lark: output failed");
		await harness.command("off");
	});

	it.each([
		["begin", "pairing initialization"],
		["wait", "authorization polling"],
		["identity", "bot identity lookup"],
		["start", "WebSocket handshake"],
	] as const)("reports the %s failure stage without exposing raw errors", async (operation, stage) => {
		fixture[operation].mockRejectedValueOnce(new Error("sensitive app_secret and request body"));
		const harness = setup();
		await harness.command("lark");
		await vi.waitFor(() => expect(harness.notify).toHaveBeenCalledWith(`Lark connection failed during ${stage}. Retry /connect lark.`, "warning"));
		expect(JSON.stringify(harness.notify.mock.calls)).not.toContain("sensitive");
		expect(harness.unsubscribe).toHaveBeenCalledTimes(1);
	});

	it.each(["expired", "denied"])("reports %s authorization separately from connection failures", async (status) => {
		fixture.wait.mockResolvedValueOnce({ status });
		const harness = setup();
		await harness.command("lark");
		await vi.waitFor(() => expect(harness.notify).toHaveBeenCalledWith(`Lark pairing ${status}. Retry /connect lark.`, "warning"));
		expect(fixture.identity).not.toHaveBeenCalled();
	});

	it("mirrors typed approvals, rejects invalid clicks and revokes local-completed cards", async () => {
		const harness = setup();
		await harness.command("lark");
		await vi.waitFor(() => expect(fixture.start).toHaveBeenCalled());
		const controller = new AbortController();
		const choose = vi.fn(() => { controller.abort(); return true; });
		harness.decision({ kind: "confirm", title: "Approve bash", message: "Run a harmless fixture", options: ["Yes", "No"], signal: controller.signal, choose });
		await vi.waitFor(() => expect(fixture.send).toHaveBeenCalled());
		const card = fixture.send.mock.calls[0]?.[1] as { elements: { actions?: { value: { token: string; option: string } }[] }[] };
		const token = card.elements[1]?.actions?.[0]?.value.token;
		const action = fixture.options.onCardAction as (value: unknown) => void;
		action({ token, chatId: "other", option: "Yes" });
		action({ token, chatId: "chat", option: "invalid" });
		expect(choose).not.toHaveBeenCalled();
		action({ token, chatId: "chat", option: "Yes" });
		action({ token, chatId: "chat", option: "No" });
		expect(choose).toHaveBeenCalledExactlyOnceWith("Yes");
		await vi.waitFor(() => expect(fixture.update).toHaveBeenCalled());
		const local = new AbortController();
		const localChoice = vi.fn(() => true);
		harness.decision({ kind: "select", title: "Choose", options: ["one"], signal: local.signal, choose: localChoice });
		await vi.waitFor(() => expect(fixture.send).toHaveBeenCalledTimes(2));
		const second = fixture.send.mock.calls[1]?.[1] as typeof card;
		local.abort();
		action({ token: second.elements[1]?.actions?.[0]?.value.token, chatId: "chat", option: "one" });
		expect(localChoice).not.toHaveBeenCalled();
		await harness.command("off");
		expect(harness.unsubscribe).toHaveBeenCalledTimes(1);
	});

	it("does not begin pairing outside interactive mode", async () => {
		const harness = setup("print");
		await harness.command("lark");
		expect(fixture.begin).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledWith("Lark connection requires interactive terminal mode.", "warning");
	});

	it("disconnect revokes pending remote approvals without resolving the terminal request", async () => {
		const harness = setup();
		await harness.command("lark");
		await vi.waitFor(() => expect(fixture.start).toHaveBeenCalled());
		const controller = new AbortController();
		const choose = vi.fn(() => true);
		harness.decision({ kind: "confirm", title: "Approve", options: ["Yes", "No"], signal: controller.signal, choose });
		await vi.waitFor(() => expect(fixture.send).toHaveBeenCalled());
		const card = fixture.send.mock.calls[0]?.[1] as { elements: { actions?: { value: { token: string } }[] }[] };
		const action = fixture.options.onCardAction as (value: unknown) => void;
		await harness.command("off");
		action({ token: card.elements[1]?.actions?.[0]?.value.token, chatId: "chat", option: "Yes" });
		expect(choose).not.toHaveBeenCalled();
		expect(controller.signal.aborted).toBe(false);
		controller.abort();
	});

	it("does not offer truncated approval content", async () => {
		const harness = setup();
		await harness.command("lark");
		await vi.waitFor(() => expect(fixture.start).toHaveBeenCalled());
		harness.decision({ kind: "confirm", title: "Approve", message: "x".repeat(8001), options: ["Yes", "No"], signal: new AbortController().signal, choose: vi.fn(() => true) });
		expect(fixture.send).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("review it in full"), "warning");
		await harness.command("off");
	});

	it("cancels pairing and ignores authorization arriving after disconnect", async () => {
		let authorize: (value: unknown) => void = () => {};
		fixture.wait.mockReturnValueOnce(new Promise((resolve) => { authorize = resolve; }));
		const harness = setup();
		await harness.command("lark");
		await vi.waitFor(() => expect(fixture.wait).toHaveBeenCalled());
		const signal = fixture.wait.mock.calls[0]?.[1] as AbortSignal;
		await harness.command("off");
		expect(signal.aborted).toBe(true);
		expect(fixture.send).not.toHaveBeenCalled();
		authorize({ status: "authorized", credentials: { appId: "app", appSecret: "fixture", brand: "feishu" } });
		await Promise.resolve();
		expect(fixture.identity).not.toHaveBeenCalled();
		expect(fixture.start).not.toHaveBeenCalled();
	});

	it("closes on session shutdown and prevents duplicate connections", async () => {
		const harness = setup();
		await harness.command("lark");
		await vi.waitFor(() => expect(fixture.start).toHaveBeenCalled());
		await harness.command("lark");
		expect(fixture.begin).toHaveBeenCalledTimes(1);
		await harness.handlers.get("session_shutdown")?.();
		expect(fixture.send).not.toHaveBeenCalled();
		const message = fixture.options.onMessage as (message: unknown) => void;
		message({ id: "late", chatId: "chat", text: "late", imageKeys: [], files: [] });
		await Promise.resolve();
		expect(harness.submit).not.toHaveBeenCalled();
		expect(fixture.stop).toHaveBeenCalledTimes(1);
		expect(fixture.close).toHaveBeenCalledTimes(1);
	});

	it.each(["session_compact", "session_compact_failed"])("rejects input during compaction and recovers after %s", async (event) => {
		const harness = setup();
		await harness.command("lark");
		await vi.waitFor(() => expect(fixture.start).toHaveBeenCalled());
		const message = fixture.options.onMessage as (message: unknown) => void;
		harness.handlers.get("session_before_compact")?.({});
		message({ id: "during", chatId: "chat", text: "during", imageKeys: [], files: [] });
		await vi.waitFor(() => expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("compaction is active"), "warning"));
		expect(harness.submit).not.toHaveBeenCalled();
		harness.handlers.get(event)?.({});
		message({ id: "after", chatId: "chat", text: "after", imageKeys: [], files: [] });
		await vi.waitFor(() => expect(harness.submit).toHaveBeenCalledTimes(1));
		await harness.command("off");
	});

	it("pairs, submits through the existing session action and ignores late input after disconnect", async () => {
		const harness = setup();
		await harness.command("lark");
		await vi.waitFor(() => expect(fixture.start).toHaveBeenCalled());
		const message = fixture.options.onMessage as (message: unknown) => void;
		message({ id: "m1", chatId: "chat", text: "hello", imageKeys: [], files: [] });
		await vi.waitFor(() => expect(harness.submit).toHaveBeenCalledWith([{ type: "text", text: "hello" }], { deliverAs: "followUp", expandPromptTemplates: false }));
		harness.handlers.get("before_agent_start")?.({ prompt: "hello" }, harness.context);
		await vi.waitFor(() => expect(fixture.send).toHaveBeenCalled());
		harness.handlers.get("message_end")?.({ message: { role: "assistant", content: [{ type: "text", text: "answer" }] } });
		harness.handlers.get("agent_settled")?.({});
		await vi.waitFor(() => expect(fixture.update).toHaveBeenCalledWith("card", expect.objectContaining({ header: expect.objectContaining({ title: { tag: "plain_text", content: "StepCode: done" } }) })));
		await harness.command("off");
		message({ id: "m2", chatId: "chat", text: "late", imageKeys: [], files: [] });
		expect(harness.submit).toHaveBeenCalledTimes(1);
		expect(fixture.stop).toHaveBeenCalledTimes(1);
		expect(fixture.close).toHaveBeenCalledTimes(1);
	});
});
