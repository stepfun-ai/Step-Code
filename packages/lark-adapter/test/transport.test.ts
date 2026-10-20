import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LarkTransport } from "../src/transport.ts";

const sdk = vi.hoisted(() => ({
	options: {} as Record<string, unknown>,
	handlers: {} as Record<string, (event: unknown) => unknown>,
	start: vi.fn(async () => {}),
	close: vi.fn(),
}));
vi.mock("@larksuiteoapi/node-sdk", () => ({
	LoggerLevel: { error: 1 },
	WSClient: class {
		constructor(options: Record<string, unknown>) {
			sdk.options = options;
		}
		start = sdk.start;
		close = sdk.close;
	},
	EventDispatcher: class {
		register(handlers: typeof sdk.handlers) {
			sdk.handlers = handlers;
			return this;
		}
	},
}));

describe("Lark transport lifecycle", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		sdk.start.mockResolvedValue();
	});
	afterEach(() => vi.useRealTimers());
	it("reports connected and resolves startup only after the WebSocket handshake succeeds", async () => {
		const state = vi.fn();
		const transport = new LarkTransport({
			credentials: { appId: "cli_0123456789abcdef", appSecret: "fixture", brand: "feishu" },
			botId: "bot",
			onMessage: vi.fn(),
			onCardAction: vi.fn(),
			onState: state,
		});
		const ready = vi.fn();
		const startup = transport.start().then(ready);
		await Promise.resolve();
		expect(ready).not.toHaveBeenCalled();
		expect(state).not.toHaveBeenCalled();
		(sdk.options.onReady as () => void)();
		await startup;
		expect(ready).toHaveBeenCalledTimes(1);
		expect(state).toHaveBeenCalledExactlyOnceWith("connected");
		transport.close();
	});

	it("accepts card decisions only from the bound chat and suppresses late callbacks after close", async () => {
		const message = vi.fn();
		const action = vi.fn();
		const state = vi.fn();
		const transport = new LarkTransport({
			credentials: { appId: "cli_0123456789abcdef", appSecret: "fixture", brand: "lark" },
			botId: "bot",
			onMessage: message,
			onCardAction: action,
			onState: state,
		});
		const startup = transport.start();
		(sdk.options.onReady as () => void)();
		await startup;
		state.mockClear();
		const event = {
			sender: { sender_id: { open_id: "user" } },
			message: {
				message_id: "m1",
				chat_id: "chat",
				chat_type: "p2p",
				message_type: "text",
				create_time: String(Date.now()),
				content: '{"text":"hello"}',
			},
		};
		const decision = { context: { open_chat_id: "chat" }, action: { value: { token: "token", option: "yes" } } };
		for (const invalid of [null, {}, { action: { value: "bad" } }, { ...decision, action: { value: {} } }]) {
			expect(() => sdk.handlers["card.action.trigger"](invalid)).not.toThrow();
		}
		sdk.handlers["card.action.trigger"](decision);
		expect(action).not.toHaveBeenCalled();
		sdk.handlers["im.message.receive_v1"](event);
		sdk.handlers["card.action.trigger"]({ ...decision, context: { open_chat_id: "other" } });
		expect(action).not.toHaveBeenCalled();
		sdk.handlers["card.action.trigger"](decision);
		expect(action).toHaveBeenCalledExactlyOnceWith({ chatId: "chat", token: "token", option: "yes" });
		transport.close();
		transport.close();
		sdk.handlers["im.message.receive_v1"]({ ...event, message: { ...event.message, message_id: "m2" } });
		sdk.handlers["card.action.trigger"](decision);
		(sdk.options.onReconnected as () => void)();
		expect(message).toHaveBeenCalledTimes(1);
		expect(action).toHaveBeenCalledTimes(1);
		expect(state).not.toHaveBeenCalled();
		expect(sdk.close).toHaveBeenCalledExactlyOnceWith({ force: true });
		await expect(transport.start()).rejects.toThrow("cannot be restarted");
	});

	it.each(["error", "timeout", "close"])("settles %s during startup and suppresses late success", async (failure) => {
		vi.useFakeTimers();
		const state = vi.fn();
		const transport = new LarkTransport({
			credentials: { appId: "cli_0123456789abcdef", appSecret: "fixture", brand: "feishu" },
			botId: "bot",
			onMessage: vi.fn(),
			onCardAction: vi.fn(),
			onState: state,
		});
		const rejected = expect(transport.start()).rejects.toThrow("Lark transport failed to start");
		if (failure === "error") (sdk.options.onError as () => void)();
		else if (failure === "timeout") await vi.advanceTimersByTimeAsync(15_000);
		else transport.close();
		await rejected;
		(sdk.options.onReady as () => void)();
		(sdk.options.onReconnected as () => void)();
		expect(state).not.toHaveBeenCalled();
		expect(sdk.close).toHaveBeenCalledExactlyOnceWith({ force: true });
		expect(vi.getTimerCount()).toBe(0);
		await expect(transport.start()).rejects.toThrow("cannot be restarted");
	});

	it("clears the startup deadline and keeps an established connection on a health error", async () => {
		vi.useFakeTimers();
		const state = vi.fn();
		const transport = new LarkTransport({
			credentials: { appId: "cli_0123456789abcdef", appSecret: "fixture", brand: "feishu" },
			botId: "bot",
			onMessage: vi.fn(),
			onCardAction: vi.fn(),
			onState: state,
		});
		const startup = transport.start();
		(sdk.options.onReady as () => void)();
		await startup;
		expect(vi.getTimerCount()).toBe(0);
		(sdk.options.onError as () => void)();
		expect(state).toHaveBeenLastCalledWith("degraded");
		expect(sdk.close).not.toHaveBeenCalled();
		transport.close();
	});

	it("closes a failed startup without exposing the SDK error or allowing a retry", async () => {
		sdk.start.mockRejectedValueOnce(new Error("request contains fixture secret"));
		const transport = new LarkTransport({
			credentials: { appId: "cli_0123456789abcdef", appSecret: "fixture", brand: "feishu" },
			botId: "bot",
			onMessage: vi.fn(),
			onCardAction: vi.fn(),
			onState: vi.fn(),
		});
		await expect(transport.start()).rejects.toThrow("Lark transport failed to start");
		expect(sdk.close).toHaveBeenCalledExactlyOnceWith({ force: true });
		await expect(transport.start()).rejects.toThrow("cannot be restarted");
	});
});
