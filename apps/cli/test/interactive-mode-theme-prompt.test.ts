import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/ui/interactive-mode.ts";

type ThemePromptContext = {
	options: {
		stepThemePrompt?: () => Promise<string | undefined>;
		exitAfterStartupLogin?: boolean;
		initialMessage?: string;
		initialMessages?: string[];
	};
	settingsManager: {
		getThemeSetting: () => string | undefined;
		setTheme: (theme: string) => void;
		flush: () => Promise<void>;
	};
	session: { state: { messages: readonly unknown[] } };
};

const maybeRunStepThemePrompt = (
	InteractiveMode.prototype as unknown as {
		maybeRunStepThemePrompt(this: ThemePromptContext): Promise<string | undefined>;
	}
).maybeRunStepThemePrompt;

function createContext(overrides: Partial<ThemePromptContext> = {}): ThemePromptContext {
	return {
		options: { stepThemePrompt: async () => "step-blue" },
		settingsManager: {
			getThemeSetting: () => undefined,
			setTheme: vi.fn(),
			flush: vi.fn(async () => {}),
		},
		session: { state: { messages: [] } },
		...overrides,
	};
}

describe("InteractiveMode first-run theme prompt", () => {
	it("persists the confirmed setting before the UI is built", async () => {
		const context = createContext();

		expect(await maybeRunStepThemePrompt.call(context)).toBeUndefined();
		expect(context.settingsManager.setTheme).toHaveBeenCalledWith("step-blue");
		expect(context.settingsManager.flush).toHaveBeenCalledTimes(1);
	});

	// A dismissed screen answers with the product default, so the written theme
	// is also the record that the question was put: nothing asks again.
	it("persists the default the dismissed screen answered with", async () => {
		const context = createContext({ options: { stepThemePrompt: async () => "step-blue" } });

		await maybeRunStepThemePrompt.call(context);

		expect(context.settingsManager.setTheme).toHaveBeenCalledWith("step-blue");
	});

	it("writes nothing when there was no question to put", async () => {
		const context = createContext({ options: { stepThemePrompt: async () => undefined } });

		expect(await maybeRunStepThemePrompt.call(context)).toBeUndefined();
		expect(context.settingsManager.setTheme).not.toHaveBeenCalled();
	});

	it("keeps the launch alive and reports a failed screen", async () => {
		const context = createContext({
			options: {
				stepThemePrompt: async () => {
					throw new Error("no terminal");
				},
			},
		});

		expect(await maybeRunStepThemePrompt.call(context)).toContain("no terminal");
		expect(context.settingsManager.setTheme).not.toHaveBeenCalled();
	});

	it.each([
		["a persisted theme", { settingsManager: { getThemeSetting: () => "sage", setTheme: vi.fn(), flush: vi.fn() } }],
		["a launch that carries a prompt", { options: { stepThemePrompt: vi.fn(), initialMessage: "fix the build" } }],
		["a launch that queues messages", { options: { stepThemePrompt: vi.fn(), initialMessages: ["go"] } }],
		["a non-empty session", { session: { state: { messages: ["existing"] } } }],
		["an auth-only command", { options: { stepThemePrompt: vi.fn(), exitAfterStartupLogin: true } }],
		["a product without the hook", { options: {} }],
	] as const)("skips the prompt for %s", async (_label, overrides) => {
		const stepThemePrompt = vi.fn(async () => "step-blue");
		const context = createContext(overrides as Partial<ThemePromptContext>);
		if (context.options.stepThemePrompt) context.options.stepThemePrompt = stepThemePrompt;

		await maybeRunStepThemePrompt.call(context);

		expect(stepThemePrompt).not.toHaveBeenCalled();
		expect(context.settingsManager.setTheme).not.toHaveBeenCalled();
	});
});
