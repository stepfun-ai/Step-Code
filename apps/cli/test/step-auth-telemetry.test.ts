import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/ui/interactive-mode.ts";

type LoginContext = {
	session: {
		modelRuntime: { login: (providerId: string, method: string, options: unknown) => Promise<unknown> };
	};
	runtimeHost: {
		session: {
			modelRuntime: { login: (providerId: string, method: string, options: unknown) => Promise<unknown> };
		};
	};
	options: { onCredentialAuthenticated?: (details: { providerId: string; uid?: string }) => void };
	showAuthPrompt: (dialog: unknown, prompt: unknown) => Promise<string>;
	notifyAuthDialog: (dialog: unknown, event: unknown) => void;
	notifyCredentialAuthenticated: (providerId: string, credential: unknown) => void;
};

type LoginProvider = (
	this: LoginContext,
	dialog: { signal: AbortSignal },
	providerId: string,
	method: "api_key" | "oauth",
) => Promise<void>;

const loginProvider = (InteractiveMode.prototype as unknown as { loginProvider: LoginProvider }).loginProvider;
const notifyCredentialAuthenticated = (
	InteractiveMode.prototype as unknown as {
		notifyCredentialAuthenticated(this: LoginContext, providerId: string, credential: unknown): void;
	}
).notifyCredentialAuthenticated;

describe("InteractiveMode credential telemetry hook", () => {
	it("forwards only the provider id and uid after login", async () => {
		const onCredentialAuthenticated = vi.fn();
		const login = vi.fn(async () => ({
			type: "oauth",
			access: "secret",
			refresh: "refresh",
			expires: 1,
			uid: "uid-1",
		}));
		const context = {
			session: { modelRuntime: { login } },
			runtimeHost: { session: { modelRuntime: { login } } },
			options: { onCredentialAuthenticated },
			showAuthPrompt: vi.fn(async () => ""),
			notifyAuthDialog: vi.fn(),
			notifyCredentialAuthenticated,
		};

		await loginProvider.call(context, { signal: new AbortController().signal }, "step", "oauth");

		expect(login).toHaveBeenCalledWith("step", "oauth", expect.objectContaining({ signal: expect.any(AbortSignal) }));
		expect(onCredentialAuthenticated).toHaveBeenCalledWith({ providerId: "step", uid: "uid-1" });
	});
});
