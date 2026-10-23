import { defaultHttpInstance } from "@larksuiteoapi/node-sdk";
import { describe, expect, it, vi } from "vitest";
import { LarkTransport } from "../src/transport.ts";

describe("installed Lark SDK lifecycle", () => {
	it("does not treat the real SDK's early start return as a successful handshake", async () => {
		let fail: (value: unknown) => void = () => {};
		const request = vi.spyOn(defaultHttpInstance, "request").mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					fail = resolve;
				}),
		);
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
		const rejected = expect(startup).rejects.toThrow("Lark transport failed to start");
		try {
			await Promise.resolve();
			await Promise.resolve();
			expect(request).toHaveBeenCalledTimes(1);
			expect(ready).not.toHaveBeenCalled();
			expect(state).not.toHaveBeenCalled();
			fail({ code: 100004, msg: "fixture rejected", data: {} });
			await rejected;
			expect(ready).not.toHaveBeenCalled();
		} finally {
			transport.close();
			request.mockRestore();
		}
	});

	it("releases SDK timers when closed before startup without writing diagnostics", () => {
		vi.useFakeTimers();
		const baseline = vi.getTimerCount();
		const output = ["log", "info", "warn", "error", "debug"].map((method) =>
			vi.spyOn(console, method as "log" | "info" | "warn" | "error" | "debug").mockImplementation(() => {}),
		);
		try {
			const transport = new LarkTransport({
				credentials: { appId: "cli_0123456789abcdef", appSecret: "fixture", brand: "feishu" },
				botId: "bot",
				onMessage: vi.fn(),
				onCardAction: vi.fn(),
				onState: vi.fn(),
			});
			transport.close();
			transport.close();
			expect(vi.getTimerCount()).toBe(baseline);
			for (const spy of output) expect(spy).not.toHaveBeenCalled();
		} finally {
			for (const spy of output) spy.mockRestore();
			vi.useRealTimers();
		}
	});
});
