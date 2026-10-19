import { describe, expect, it, vi } from "vitest";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import { type UIDecisionRequest, UIDecisions } from "../src/core/extensions/ui-decisions.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("typed UI decisions", () => {
	it("exposes only opt-in dialogs through the runner and invalidates their resolvers", async () => {
		const runner = new ExtensionRunner(
			[],
			createExtensionRuntime(),
			process.cwd(),
			SessionManager.inMemory(),
			{} as ModelRegistry,
		);
		const confirm = vi.fn(async () => false);
		const select = vi.fn(() => new Promise<string | undefined>(() => {}));
		runner.setUIContext({ confirm, select } as unknown as ExtensionUIContext, "tui");
		const ui = runner.getUIContext();
		const requests: UIDecisionRequest[] = [];
		ui.onDecision?.((request) => requests.push(request));
		await expect(ui.confirm("Login", "Private fixture")).resolves.toBe(false);
		expect(requests).toHaveLength(0);
		const approval = ui.confirm("Approve", "Harmless command", { mirror: true });
		expect(requests[0]?.choose("Yes")).toBe(true);
		await expect(approval).resolves.toBe(true);
		const selection = ui.select("Choose", ["one", "two"], { mirror: true });
		runner.invalidate();
		await expect(selection).resolves.toBeUndefined();
		expect(requests[1]?.choose("two")).toBe(false);
	});
	it("accepts the first legal remote choice and dismisses the real local dialog", async () => {
		const decisions = new UIDecisions();
		let request: UIDecisionRequest | undefined;
		decisions.subscribe((value) => {
			request = value;
		});
		let localSignal: AbortSignal | undefined;
		const result = decisions.run({ kind: "confirm", title: "Approve", options: ["Yes", "No"] }, (signal) => {
			localSignal = signal;
			return new Promise((resolve) => signal.addEventListener("abort", () => resolve(undefined), { once: true }));
		});
		expect(request?.choose("invalid")).toBe(false);
		expect(request?.choose("Yes")).toBe(true);
		expect(request?.choose("No")).toBe(false);
		expect(localSignal?.aborted).toBe(true);
		await expect(result).resolves.toBe("Yes");
	});

	it("revokes remote choices when the terminal wins", async () => {
		const decisions = new UIDecisions();
		let request: UIDecisionRequest | undefined;
		decisions.subscribe((value) => {
			request = value;
		});
		const result = decisions.run({ kind: "select", title: "Choose", options: ["one", "two"] }, async () => "two");
		await expect(result).resolves.toBe("two");
		expect(request?.signal.aborted).toBe(true);
		expect(request?.choose("one")).toBe(false);
	});

	it("fails closed when the local selector returns an invalid option", async () => {
		const decisions = new UIDecisions();
		let request: UIDecisionRequest | undefined;
		decisions.subscribe((value) => {
			request = value;
		});
		await expect(
			decisions.run({ kind: "select", title: "Choose", options: ["one"] }, async () => "invalid"),
		).resolves.toBeUndefined();
		expect(request?.signal.aborted).toBe(true);
		expect(request?.choose("one")).toBe(false);
		expect(Object.isFrozen(request)).toBe(true);
		expect(Object.isFrozen(request?.options)).toBe(true);
	});

	it("fails closed on cancellation or runtime teardown", async () => {
		const decisions = new UIDecisions();
		const requests: UIDecisionRequest[] = [];
		decisions.subscribe((value) => requests.push(value));
		const controller = new AbortController();
		const local = vi.fn(() => new Promise<string | undefined>(() => {}));
		const first = decisions.run(
			{ kind: "confirm", title: "Approve", options: ["Yes", "No"] },
			local,
			controller.signal,
		);
		controller.abort();
		await expect(first).resolves.toBeUndefined();
		const second = decisions.run({ kind: "confirm", title: "Approve", options: ["Yes", "No"] }, local);
		decisions.close();
		await expect(second).resolves.toBeUndefined();
		for (const request of requests) expect(request.choose("Yes")).toBe(false);
	});
});
