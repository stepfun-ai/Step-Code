import { afterEach, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { resolveWorkflowRegistration } from "../src/features/workflow/registration-gate.ts";
import { createStepWorkflowExtension } from "../src/features/workflow/step-workflow.ts";

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("resolveWorkflowRegistration", () => {
	test("registers by default and reports why registration was refused", () => {
		vi.stubEnv("STEP_ENABLE_WORKFLOW", "");
		vi.stubEnv("STEP_DISABLE_WORKFLOW", "");
		// Default-on (Claude Code parity): no option and no env var registers. The
		// sandbox ships with the package, so no runtime can withhold it.
		expect(resolveWorkflowRegistration()).toEqual({ enabled: true });
		expect(resolveWorkflowRegistration({})).toEqual({ enabled: true });
		expect(resolveWorkflowRegistration({ enabled: true })).toEqual({ enabled: true });

		// Embedder opt-out; STEP_ENABLE_WORKFLOW is no longer read and cannot override it.
		expect(resolveWorkflowRegistration({ enabled: false })).toEqual({ enabled: false, reason: "not-enabled" });
		vi.stubEnv("STEP_ENABLE_WORKFLOW", "1");
		expect(resolveWorkflowRegistration({ enabled: false })).toEqual({ enabled: false, reason: "not-enabled" });

		// The env kill switch beats both the default and an explicit enable.
		vi.stubEnv("STEP_DISABLE_WORKFLOW", "1");
		expect(resolveWorkflowRegistration()).toEqual({ enabled: false, reason: "disabled-by-env" });
		expect(resolveWorkflowRegistration({ enabled: true })).toEqual({ enabled: false, reason: "disabled-by-env" });
	});
});

describe("workflow registration", () => {
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

	test("registers the tool on every runtime without warning", () => {
		vi.stubEnv("STEP_DISABLE_WORKFLOW", "");
		const h = harness();
		createStepWorkflowExtension({})(h.api);
		// This is the path every released executable takes: the sandbox is bundled
		// QuickJS, so there is no environment left to degrade into, and nothing to
		// warn about at session start.
		expect(h.tools.has("workflow")).toBe(true);
		for (const handler of h.handlers.get("session_start") ?? []) handler({ type: "session_start" }, h.ctx);
		expect(h.notifications).toEqual([]);
	});

	test("a workflow turned off by option or env registers nothing and stays silent", () => {
		vi.stubEnv("STEP_DISABLE_WORKFLOW", "");
		const optedOut = harness();
		createStepWorkflowExtension({ enabled: false })(optedOut.api);
		expect(optedOut.tools.size).toBe(0);
		expect(optedOut.handlers.size).toBe(0);
		expect(optedOut.notifications).toEqual([]);

		vi.stubEnv("STEP_DISABLE_WORKFLOW", "1");
		const envOff = harness();
		createStepWorkflowExtension({})(envOff.api);
		expect(envOff.tools.size).toBe(0);
		expect(envOff.handlers.size).toBe(0);
		expect(envOff.notifications).toEqual([]);
	});

	test("an injected vmExecutor still overrides the bundled sandbox", () => {
		vi.stubEnv("STEP_DISABLE_WORKFLOW", "");
		const h = harness();
		createStepWorkflowExtension({
			vmExecutor: async () => ({ value: null, meta: {} }),
		})(h.api);
		expect(h.tools.has("workflow")).toBe(true);
	});
});
