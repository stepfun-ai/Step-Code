import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/ui/interactive-mode.ts";
import { writeStepLoginCredential } from "../../../packages/coding-agent/src/step/login-flow.ts";
import { resolveStepLoginProfiles } from "../../../packages/coding-agent/src/step/onboarding.ts";

const handleLoginCommand = (
	InteractiveMode.prototype as unknown as {
		handleLoginCommand(this: unknown, providerRef?: string): Promise<void>;
	}
).handleLoginCommand;
const handleStepLogoutCommand = (
	InteractiveMode.prototype as unknown as {
		handleStepLogoutCommand(this: unknown): Promise<void>;
	}
).handleStepLogoutCommand;
const createStepLoginHost = (
	InteractiveMode.prototype as unknown as {
		createStepLoginHost(this: unknown): {
			addChild(child: unknown): void;
			setFocus(child: unknown): void;
			stop(): void | Promise<void>;
		};
	}
).createStepLoginHost;

describe("Step login command routing", () => {
	it("uses the shared Step login flow when only the Step provider is allowed", async () => {
		const stepLogin = vi.fn(async () => ({ kind: "exit" as const }));
		const context = {
			options: {
				tuiStyle: "step",
				allowedAuthProviders: ["step"],
				stepLogin,
			},
			showStatus: vi.fn(),
			showError: vi.fn(),
			createStepLoginHost: () => ({}),
		};

		await handleLoginCommand.call(context);

		expect(stepLogin).toHaveBeenCalledTimes(1);
	});

	it("owns the full TUI viewport while Step login is active", () => {
		const view = { focused: false, invalidate: vi.fn(), render: vi.fn(() => ["login"]), handleInput: vi.fn() };
		const overlay = { hide: vi.fn(), focus: vi.fn() };
		let overlayComponent: unknown;
		const showOverlay = vi.fn((component: unknown) => {
			overlayComponent = component;
			return overlay;
		});
		const ui = {
			showOverlay,
			setFocus: vi.fn(),
			requestRender: vi.fn(),
			terminal: { rows: 3 },
		};
		const editor = { invalidate: vi.fn(), render: vi.fn(() => ["editor"]) };
		const editorContainer = {
			children: [editor],
			clear: vi.fn(),
			addChild: vi.fn(),
		};
		const host = createStepLoginHost.call({
			ui,
			editor,
			editorContainer,
			redraw: { requestRender: () => ui.requestRender(), forceRender: () => ui.requestRender(true), renderNow: vi.fn() },
		});

		host.addChild(view);
		host.setFocus(view);

		expect(showOverlay).toHaveBeenCalledTimes(1);
		expect((overlayComponent as { render(width: number): string[] }).render(10)).toEqual([
			"login",
			"          ",
			"          ",
		]);
		(overlayComponent as { focused: boolean }).focused = true;
		expect(view.focused).toBe(true);
		expect(overlay.focus).toHaveBeenCalledTimes(1);

		host.stop();
		expect(overlay.hide).toHaveBeenCalledTimes(1);
	});

	it("does not start Step login during an active turn", async () => {
		const stepLogin = vi.fn(async () => ({ kind: "exit" as const }));
		const showWarning = vi.fn();
		const context = {
			runtimeHost: { session: { isStreaming: true, isCompacting: false } },
			options: { stepLogin },
			showWarning,
			showStatus: vi.fn(),
			showError: vi.fn(),
		};

		await handleLoginCommand.call(context);

		expect(stepLogin).not.toHaveBeenCalled();
		expect(showWarning).toHaveBeenCalledWith("Wait for the active turn to finish before signing in");
	});

	it("does not reopen the Step login panel when already signed in", async () => {
		const root = await mkdtemp(join(tmpdir(), "interactive-step-login-auth-"));
		const stepLogin = vi.fn(async () => ({ kind: "exit" as const }));
		const showStatus = vi.fn();
		try {
			const authPath = join(root, "auth.json");
			await writeStepLoginCredential({ authPath, profile: "step_plan", apiKey: "stored-key" });
			const context = {
				options: { stepLogin, authPath },
				showStatus,
				showWarning: vi.fn(),
				showError: vi.fn(),
				createStepLoginHost: vi.fn(),
			};

			await handleLoginCommand.call(context);

			expect(stepLogin).not.toHaveBeenCalled();
			expect(context.createStepLoginHost).not.toHaveBeenCalled();
			// The profile title carries its sign-in URL; read it back rather than
			// restating it, so editing a title is not a test change.
			const title = resolveStepLoginProfiles().find((profile) => profile.id === "step_plan")?.title;
			expect(showStatus).toHaveBeenCalledWith(
				`Already signed in with ${title}. Run \`/logout\` before signing in again.`,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("uses the shared Step logout flow and shuts down the session", async () => {
		const stepLogout = vi.fn(async () => ({ removed: true, remainingSource: null }));
		const shutdown = vi.fn(async () => {});
		const context = {
			options: { stepLogout },
			session: { isStreaming: false, isCompacting: false },
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
			shutdown,
		};

		await handleStepLogoutCommand.call(context);

		expect(stepLogout).toHaveBeenCalledTimes(1);
		expect(shutdown).toHaveBeenCalledTimes(1);
	});
});
