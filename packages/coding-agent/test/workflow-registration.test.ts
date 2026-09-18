import { afterEach, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import {
	resolveWorkflowRegistration,
	WORKFLOW_VM_UNAVAILABLE_WARNING,
} from "../src/features/workflow/registration-gate.ts";
import { createStepWorkflowExtension } from "../src/features/workflow/step-workflow.ts";

vi.mock("../src/features/workflow/vm.ts", async (importOriginal) => ({
	...(await importOriginal<object>()),
	isIsolatedVmAvailable: () => false,
}));

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("resolveWorkflowRegistration", () => {
	test("reports why registration was refused", () => {
		vi.stubEnv("STEP_ENABLE_WORKFLOW", "");
		vi.stubEnv("STEP_DISABLE_WORKFLOW", "");
		expect(resolveWorkflowRegistration({}, true)).toEqual({ enabled: false, reason: "not-enabled" });

		vi.stubEnv("STEP_DISABLE_WORKFLOW", "1");
		expect(resolveWorkflowRegistration({ enabled: true }, true)).toEqual({
			enabled: false,
			reason: "disabled-by-env",
		});

		vi.stubEnv("STEP_DISABLE_WORKFLOW", "");
		expect(resolveWorkflowRegistration({ enabled: true }, false)).toEqual({
			enabled: false,
			reason: "vm-unavailable",
		});
		// An injected executor stands in for the native module.
		expect(resolveWorkflowRegistration({ enabled: true, vmExecutor: () => {} }, false)).toEqual({ enabled: true });
		expect(resolveWorkflowRegistration({ enabled: true }, true)).toEqual({ enabled: true });
	});
});

describe("workflow registration warning", () => {
	function harness() {
		const tools = new Map<string, ToolDefinition>();
		const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
		const notifications: Array<{ message: string; level?: string }> = [];
		const ctx = {
			ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
		} as unknown as ExtensionContext;
		const api = {
			registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
			registerCommand: () => {},
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
		} as unknown as ExtensionAPI;
		return { api, tools, handlers, notifications, ctx };
	}

	test("an explicitly enabled workflow with no VM warns once at session start", () => {
		vi.stubEnv("STEP_DISABLE_WORKFLOW", "");
		const h = harness();
		createStepWorkflowExtension({ enabled: true })(h.api);
		expect(h.tools.size).toBe(0);
		for (const handler of h.handlers.get("session_start") ?? []) handler({ type: "session_start" }, h.ctx);
		for (const handler of h.handlers.get("session_start") ?? []) handler({ type: "session_start" }, h.ctx);
		expect(h.notifications).toEqual([{ message: WORKFLOW_VM_UNAVAILABLE_WARNING, level: "warning" }]);
		expect(h.notifications[0]?.message).toContain("isolated-vm");
	});

	test("a workflow that was never enabled stays silent", () => {
		vi.stubEnv("STEP_ENABLE_WORKFLOW", "");
		vi.stubEnv("STEP_DISABLE_WORKFLOW", "");
		const h = harness();
		createStepWorkflowExtension({})(h.api);
		expect(h.tools.size).toBe(0);
		expect(h.handlers.size).toBe(0);
	});

	test("an injected vmExecutor keeps registration working without the native module", () => {
		vi.stubEnv("STEP_DISABLE_WORKFLOW", "");
		const h = harness();
		createStepWorkflowExtension({
			enabled: true,
			vmExecutor: async () => ({ value: null, meta: {} }),
		})(h.api);
		expect(h.tools.has("workflow")).toBe(true);
	});
});
