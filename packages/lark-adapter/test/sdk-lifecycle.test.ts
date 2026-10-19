import { describe, expect, it, vi } from "vitest";
import { LarkTransport } from "../src/transport.ts";

describe("installed Lark SDK lifecycle", () => {
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
