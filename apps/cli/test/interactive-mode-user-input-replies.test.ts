import { Container } from "@step-harness/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createHarness } from "../../../packages/coding-agent/test/suite/harness.ts";
import { InteractiveMode } from "../src/ui/interactive-mode.ts";
import type { RuntimeContext } from "../src/ui/runtime/context.ts";
import { wireKeyHandlers } from "../src/ui/runtime/input-dispatch.ts";

/**
 * Every way the user hands Step input must go through `promptUserInput`, which
 * marks the window in which a warning is that input's reply and stays inline.
 * An entry point that calls `session.prompt` directly sends its replies to the
 * footer badge, where the user who just pressed a key never sees them.
 */

function method<T>(name: string): T {
	return Reflect.get(InteractiveMode.prototype, name) as T;
}

describe("user input reaches the kernel through promptUserInput", () => {
	it("cycles the permission preset from Shift+Tab as user input", () => {
		const actions = new Map<string, () => void>();
		const ctx = {
			defaultEditor: { onAction: (name: string, handler: () => void) => actions.set(name, handler) },
			ui: {},
			options: { tuiStyle: "step" },
			session: { extensionRunner: { getCommand: (name: string) => (name === "permissions" ? {} : undefined) } },
			promptUserInput: vi.fn(async () => {}),
			cycleThinkingLevel: vi.fn(),
			showWarningList: vi.fn(),
		};

		wireKeyHandlers(ctx as unknown as RuntimeContext);
		actions.get("app.thinking.cycle")?.();
		actions.get("app.warnings.open")?.();

		expect(ctx.promptUserInput).toHaveBeenCalledWith("/permissions --cycle");
		expect(ctx.cycleThinkingLevel).not.toHaveBeenCalled();
		expect(ctx.showWarningList).toHaveBeenCalledOnce();
	});

	it.each([
		["a command during compaction", { isCompacting: true, isStreaming: false }, "/goal status", undefined],
		[
			"a follow-up during a turn",
			{ isCompacting: false, isStreaming: true },
			"also check the tests",
			{ streamingBehavior: "followUp", images: undefined },
		],
	] as const)("sends %s from Alt+Enter as user input", async (_label, state, text, options) => {
		const prompt = vi.fn(async () => {});
		const host = {
			editor: { getText: () => text, setText: vi.fn(), addToHistory: vi.fn() },
			session: { ...state, prompt },
			isExtensionCommand: () => true,
			pastedImages: { scan: () => [], reset: () => {} },
			settingsManager: { getImageAutoResize: () => false },
			promptUserInput: vi.fn(async () => {}),
			updatePendingMessagesDisplay: vi.fn(),
			redraw: { requestRender: vi.fn() },
		};

		await method<(this: typeof host) => Promise<void>>("handleFollowUp").call(host);

		expect(host.promptUserInput).toHaveBeenCalledWith(text, ...(options ? [options] : []));
		expect(prompt).not.toHaveBeenCalled();
	});

	it("sends the launch message as user input", async () => {
		const harness = await createHarness();
		try {
			const promptUserInput = vi.fn(async () => {});
			const context = {
				init: vi.fn(async () => {}),
				options: { initialMessage: "/goal status", initialMessages: ["/cron list"] },
				chatContainer: new Container(),
				outputPad: 1,
				ui: { requestRender: vi.fn() },
				redraw: { requestRender: vi.fn() },
				version: "test",
				showWarning: vi.fn(),
				recordWarning: vi.fn(),
				showError: vi.fn(),
				session: harness.session,
				promptUserInput,
				checkForPackageUpdates: vi.fn().mockResolvedValue([]),
				checkTmuxKeyboardSetup: vi.fn().mockResolvedValue(undefined),
				maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(),
				getUserInput: vi.fn(() => new Promise<string>(() => {})),
			};

			void method<(this: typeof context) => Promise<void>>("run").call(context);

			await vi.waitFor(() => expect(promptUserInput).toHaveBeenCalledTimes(2));
			expect(promptUserInput).toHaveBeenNthCalledWith(1, "/goal status", { images: undefined });
			expect(promptUserInput).toHaveBeenNthCalledWith(2, "/cron list");
		} finally {
			harness.cleanup();
		}
	});
});
