import { afterEach, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import {
	resolveWorkflowRegistration,
	WORKFLOW_VM_UNAVAILABLE_WARNING,
} from "../src/features/workflow/registration-gate.ts";
import { createStepWorkflowExtension } from "../src/features/workflow/step-workflow.ts";
import type * as VmModule from "../src/features/workflow/vm.ts";

const runtime = vi.hoisted(() => ({ vmHostable: true }));

vi.mock("../src/features/workflow/vm.ts", async (importOriginal) => ({
	...(await importOriginal<object>()),
	isIsolatedVmAvailable: () => false,
	isIsolatedVmHostable: () => runtime.vmHostable,
}));

afterEach(() => {
	vi.unstubAllEnvs();
	runtime.vmHostable = true;
});

describe("resolveWorkflowRegistration", () => {
	test("registers by default and reports why registration was refused", () => {
		vi.stubEnv("STEP_ENABLE_WORKFLOW", "");
		vi.stubEnv("STEP_DISABLE_WORKFLOW", "");
		// Default-on (Claude Code parity): no option and no env var registers.
		expect(resolveWorkflowRegistration({}, true)).toEqual({ enabled: true });
		expect(resolveWorkflowRegistration({ enabled: true }, true)).toEqual({ enabled: true });

		// Embedder opt-out; STEP_ENABLE_WORKFLOW is no longer read and cannot override it.
		expect(resolveWorkflowRegistration({ enabled: false }, true)).toEqual({
			enabled: false,
			reason: "not-enabled",
		});
		vi.stubEnv("STEP_ENABLE_WORKFLOW", "1");
		expect(resolveWorkflowRegistration({ enabled: false }, true)).toEqual({
			enabled: false,
			reason: "not-enabled",
		});

		// The env kill switch beats both the default and an explicit enable.
		vi.stubEnv("STEP_DISABLE_WORKFLOW", "1");
		expect(resolveWorkflowRegistration({}, true)).toEqual({ enabled: false, reason: "disabled-by-env" });
		expect(resolveWorkflowRegistration({ enabled: true }, true)).toEqual({
			enabled: false,
			reason: "disabled-by-env",
		});

		// The default-on path still requires a VM (or an injected executor standing in for it).
		vi.stubEnv("STEP_DISABLE_WORKFLOW", "");
		expect(resolveWorkflowRegistration({}, false)).toEqual({ enabled: false, reason: "vm-unavailable" });
		// A non-V8 runtime (the shipped bun binary) can never load the V8-native
		// isolated-vm, but the bundled QuickJS WebAssembly executor runs there, so
		// registration proceeds instead of failing silently.
		expect(resolveWorkflowRegistration({}, false, false)).toEqual({ enabled: true });
		expect(resolveWorkflowRegistration({ vmExecutor: () => {} }, false)).toEqual({ enabled: true });
		// An injected executor wins on either runtime.
		expect(resolveWorkflowRegistration({ vmExecutor: () => {} }, false, false)).toEqual({ enabled: true });
	});
});

describe("isIsolatedVmHostable", () => {
	test("keys off the real runtime, not the file-wide mock", async () => {
		// The file mocks vm.ts, so pull the real predicate to exercise its body -
		// the one-line detection this whole change hinges on. A plain import here
		// would return the mock and test nothing.
		const { isIsolatedVmHostable } = await vi.importActual<typeof VmModule>("../src/features/workflow/vm.ts");
		// vitest runs on Node (V8), which never carries a `bun` key.
		expect("bun" in process.versions).toBe(false);
		expect(isIsolatedVmHostable()).toBe(true);
		// Simulate the shipped bun binary. bun also fakes a node-compat
		// process.versions.v8, so the predicate must key off `bun`, not `v8`.
		const versions = process.versions as Record<string, string | undefined>;
		try {
			versions.bun = "1.2.18";
			expect(isIsolatedVmHostable()).toBe(false);
		} finally {
			delete versions.bun;
		}
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

	test("a default-registered workflow with no VM warns once at session start", () => {
		vi.stubEnv("STEP_DISABLE_WORKFLOW", "");
		const h = harness();
		createStepWorkflowExtension({})(h.api);
		expect(h.tools.size).toBe(0);
		for (const handler of h.handlers.get("session_start") ?? []) handler({ type: "session_start" }, h.ctx);
		for (const handler of h.handlers.get("session_start") ?? []) handler({ type: "session_start" }, h.ctx);
		expect(h.notifications).toEqual([{ message: WORKFLOW_VM_UNAVAILABLE_WARNING, level: "warning" }]);
		expect(h.notifications[0]?.message).toContain("isolated-vm");
	});

	test("a non-V8 runtime registers through the QuickJS executor and stays silent", () => {
		vi.stubEnv("STEP_DISABLE_WORKFLOW", "");
		runtime.vmHostable = false;
		const h = harness();
		createStepWorkflowExtension({})(h.api);
		// isolated-vm can never load here, but the bundled QuickJS WebAssembly
		// executor can, so the tool registers and there is nothing to warn about.
		// This is the path every released executable takes.
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

		vi.stubEnv("STEP_DISABLE_WORKFLOW", "1");
		const envOff = harness();
		createStepWorkflowExtension({})(envOff.api);
		expect(envOff.tools.size).toBe(0);
		expect(envOff.handlers.size).toBe(0);
	});

	test("an injected vmExecutor keeps default registration working without the native module", () => {
		vi.stubEnv("STEP_DISABLE_WORKFLOW", "");
		const h = harness();
		createStepWorkflowExtension({
			vmExecutor: async () => ({ value: null, meta: {} }),
		})(h.api);
		expect(h.tools.has("workflow")).toBe(true);
	});
});
