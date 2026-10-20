import { describe, expect, it, vi } from "vitest";
import { LarkDecisions } from "../src/decisions.ts";

describe("Lark decision arbitration", () => {
	it("accepts only a current token, allowed option and bound chat", () => {
		const decisions = new LarkDecisions();
		const resolve = vi.fn();
		const token = decisions.open("chat", ["Yes", "No"], resolve);
		expect(decisions.choose(token, "other", "Yes")).toBe(false);
		expect(decisions.choose(token, "chat", "allow-all")).toBe(false);
		expect(decisions.choose(token, "chat", "Yes")).toBe(true);
		expect(decisions.choose(token, "chat", "No")).toBe(false);
		expect(resolve).toHaveBeenCalledExactlyOnceWith("Yes");
	});

	it("local completion invalidates the remote token without another decision", () => {
		const decisions = new LarkDecisions();
		const resolve = vi.fn();
		const token = decisions.open("chat", ["Yes"], resolve);
		decisions.dismiss(token);
		expect(decisions.choose(token, "chat", "Yes")).toBe(false);
		expect(resolve).not.toHaveBeenCalled();
	});

	it("teardown invalidates every old token and cannot reopen", () => {
		const decisions = new LarkDecisions();
		const token = decisions.open("chat", ["Yes"], vi.fn());
		decisions.close();
		expect(decisions.choose(token, "chat", "Yes")).toBe(false);
		expect(() => decisions.open("chat", ["Yes"], vi.fn())).toThrow("closed");
	});
});
