import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/ui/interactive-mode.ts";
import * as themeModule from "../../../packages/coding-agent/src/theme/theme.ts";
import { createFakeInteractiveContext } from "./support/fake-interactive-context.ts";

type StartupLoginContext = {
	options: {
		startupLoginProvider?: string;
		disableBackgroundServices?: boolean;
		forceStartupLogin?: boolean;
	};
	session: {
		state: { messages: readonly unknown[] };
		model?: { provider: string };
		modelRuntime: {
			getProviderAuthStatus: (providerId: string) => { configured: boolean };
		};
	};
	getLoginProviderOptions: (authType?: "oauth" | "api_key") => readonly { id: string }[];
	startProviderLogin: (provider: { id: string }) => Promise<void>;
	handleLoginCommand: (providerId: string) => Promise<void>;
	showWarning?: (message: string) => void;
};

const completeProviderAuthentication = (
	InteractiveMode.prototype as unknown as {
		completeProviderAuthentication(this: unknown, ...args: unknown[]): Promise<void>;
	}
).completeProviderAuthentication;

const maybeRunStartupLogin = (
	InteractiveMode.prototype as unknown as {
		maybeRunStartupLogin(this: StartupLoginContext): Promise<void>;
	}
).maybeRunStartupLogin;

function createContext(overrides: Partial<StartupLoginContext> = {}): StartupLoginContext {
	return {
		options: { startupLoginProvider: "step" },
		session: {
			state: { messages: [] },
			model: { provider: "step" },
			modelRuntime: {
				getProviderAuthStatus: () => ({ configured: false }),
			},
		},
		getLoginProviderOptions: () => [{ id: "step" }],
		startProviderLogin: async () => {},
		handleLoginCommand: async () => {},
		showWarning: vi.fn(),
		...overrides,
	};
}

describe("InteractiveMode startup login", () => {
	it("starts the native OAuth path for an unconfigured Step model", async () => {
		const startProviderLogin = vi.fn(async () => {});
		const handleLoginCommand = vi.fn(async () => {});
		const context = createContext({ startProviderLogin, handleLoginCommand });

		await maybeRunStartupLogin.call(context);

		expect(startProviderLogin).toHaveBeenCalledWith({ id: "step" });
		expect(handleLoginCommand).not.toHaveBeenCalled();
	});

	it("can force the native OAuth path when a credential already exists", async () => {
		const startProviderLogin = vi.fn(async () => {});
		const context = createContext({
			options: { startupLoginProvider: "step", forceStartupLogin: true },
			session: {
				state: { messages: [] },
				model: { provider: "step" },
				modelRuntime: { getProviderAuthStatus: () => ({ configured: true }) },
			},
			startProviderLogin,
		});

		await maybeRunStartupLogin.call(context);

		expect(startProviderLogin).toHaveBeenCalledWith({ id: "step" });
	});

	it.each([
		[
			"a configured provider",
			{
				session: {
					state: { messages: [] },
					model: { provider: "step" },
					modelRuntime: { getProviderAuthStatus: () => ({ configured: true }) },
				},
			},
		],
		[
			"a non-empty session",
			{
				session: {
					state: { messages: ["existing"] },
					model: { provider: "step" },
					modelRuntime: {
						getProviderAuthStatus: () => ({ configured: false }),
					},
				},
			},
		],
		[
			"a different model",
			{
				session: {
					state: { messages: [] },
					model: { provider: "openai" },
					modelRuntime: {
						getProviderAuthStatus: () => ({ configured: false }),
					},
				},
			},
		],
	] as const)("skips startup login for %s", async (_label, overrides) => {
		const startProviderLogin = vi.fn(async () => {});
		const handleLoginCommand = vi.fn(async () => {});
		const context = createContext({
			...overrides,
			startProviderLogin,
			handleLoginCommand,
		});

		await maybeRunStartupLogin.call(context);

		expect(startProviderLogin).not.toHaveBeenCalled();
		expect(handleLoginCommand).not.toHaveBeenCalled();
	});

	it("still starts OAuth when only optional background services are disabled", async () => {
		const startProviderLogin = vi.fn(async () => {});
		const handleLoginCommand = vi.fn(async () => {});
		const context = createContext({
			options: { startupLoginProvider: "step", disableBackgroundServices: true },
			startProviderLogin,
			handleLoginCommand,
		});

		await maybeRunStartupLogin.call(context);

		expect(startProviderLogin).toHaveBeenCalledWith({ id: "step" });
		expect(handleLoginCommand).not.toHaveBeenCalled();
	});

	it("uses the regular login route when the requested provider has no OAuth method", async () => {
		const startProviderLogin = vi.fn(async () => {});
		const handleLoginCommand = vi.fn(async () => {});
		const context = createContext({
			getLoginProviderOptions: () => [],
			startProviderLogin,
			handleLoginCommand,
		});

		await maybeRunStartupLogin.call(context);

		expect(startProviderLogin).not.toHaveBeenCalled();
		expect(handleLoginCommand).toHaveBeenCalledWith("step");
	});

	it("selects and persists the Step model after login even when a migrated model is active", async () => {
		const stepModel = {
			provider: "step",
			id: "step-3.7-flash",
			name: "Step 3.7 Flash",
			api: "anthropic-messages",
			baseUrl: "https://api.stepfun.com/step_plan",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 256_000,
			maxTokens: 32_000,
		};
		const setModel = vi.fn(async () => {});
		const context = createFakeInteractiveContext({
			options: {
				defaultModelForProvider: (providerId: string) => (providerId === "step" ? "step-3.7-flash" : undefined),
				authPath: "/tmp/step-auth.json",
			},
			session: {
				modelRuntime: {
					getAvailableSnapshot: () => [stepModel],
					refresh: vi.fn(async () => ({ aborted: false, errors: new Map() })),
				},
				setModel,
			},
		});

		await completeProviderAuthentication.call(context, "step", "Step", "oauth", {
			provider: "models-proxy",
			id: "claude-opus-5",
		});

		expect(setModel).toHaveBeenCalledWith(stepModel, { persist: true });
	});

	it("propagates one-shot OAuth failures after cleaning up the TUI and runtime", async () => {
		const failure = new Error("OAuth callback failed");
		const stop = vi.fn();
		const dispose = vi.fn(async () => {});
		const stopThemeWatcher = vi.spyOn(themeModule, "stopThemeWatcher").mockImplementation(() => {});
		const context = {
			init: vi.fn(async () => {}),
			maybeRunStartupLogin: vi.fn(async () => {
				throw failure;
			}),
			options: { exitAfterStartupLogin: true },
			stop,
			runtimeHost: { dispose },
		};
		const run = (InteractiveMode.prototype as unknown as { run(this: typeof context): Promise<void> }).run;

		try {
			await expect(run.call(context)).rejects.toBe(failure);
			expect(stop).toHaveBeenCalledTimes(1);
			expect(dispose).toHaveBeenCalledTimes(1);
			expect(stopThemeWatcher).toHaveBeenCalledTimes(1);
		} finally {
			stopThemeWatcher.mockRestore();
		}
	});
});
