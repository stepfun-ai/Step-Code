import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

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
		const host = createStepLoginHost.call({ ui, editor, editorContainer });

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
