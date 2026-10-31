import { expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ClarificationQuestion } from "../src/core/extensions/clarification.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
	ToolDefinition,
} from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { registerStepClarifyUserExtension } from "../src/features/step-questionnaire.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

test.each([false, true])("host clarification brackets user-wait lifecycle (reject=%s)", async (reject) => {
	const runner = new ExtensionRunner(
		[],
		createExtensionRuntime(),
		"/tmp",
		SessionManager.inMemory(),
		await createInMemoryModelRegistry(AuthStorage.inMemory()),
	);
	const events = vi.spyOn(runner, "emit");
	const result = { answers: [], cancelled: true };
	const clarify = vi.fn(async (_questions: ClarificationQuestion[], _signal?: AbortSignal) => {
		if (reject) throw new Error("dialog failed");
		return result;
	});
	runner.setUIContext({ ...runner.getUIContext(), clarify } as ExtensionUIContext, "rpc");
	const signal = new AbortController().signal;
	const ui = runner.getUIContext() as ExtensionUIContext & { clarify: typeof clarify };
	const pending = ui.clarify([], signal);
	if (reject) await expect(pending).rejects.toThrow("dialog failed");
	else await expect(pending).resolves.toEqual(result);
	await Promise.resolve();
	expect(clarify).toHaveBeenCalledWith([], signal);
	expect(events).toHaveBeenNthCalledWith(1, { type: "ui_prompt_start", reason: "ui_prompt", kind: "custom" });
	expect(events).toHaveBeenNthCalledWith(2, { type: "ui_prompt_end", reason: "ui_prompt", kind: "custom" });
});

test("clarify_user uses a native host capability in rpc mode", async () => {
	let tool!: ToolDefinition;
	registerStepClarifyUserExtension({
		registerTool: (value: ToolDefinition) => {
			tool = value;
		},
	} as ExtensionAPI);
	const clarify = vi.fn(async (_questions: ClarificationQuestion[], _signal?: AbortSignal) => ({
		answers: [{ id: "q1", value: "yes", label: "Yes", wasCustom: false, index: 1 }],
		cancelled: false,
	}));
	const signal = new AbortController().signal;
	const context = { mode: "rpc", hasUI: true, ui: { clarify } } as unknown as ExtensionContext;
	const result = await tool.execute(
		"call-1",
		{ question: "Continue?", options: [{ label: "Yes", value: "yes" }] },
		signal,
		undefined,
		context,
	);
	expect(clarify).toHaveBeenCalledTimes(1);
	expect(clarify.mock.calls[0]?.[1]).toBe(signal);
	expect(result.details).toMatchObject({ cancelled: false, answers: [{ value: "yes" }] });
});
