import { Container } from "@step-harness/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntimeDiagnostic } from "../../../../../packages/coding-agent/src/core/agent-session-services.ts";
import { InteractiveMode } from "../../../src/ui/interactive-mode.ts";
import { initTheme } from "../../../../../packages/coding-agent/src/theme/theme.ts";
import { createHarness } from "../../../../../packages/coding-agent/test/suite/harness.ts";

function render(container: Container): string {
	return container.children.flatMap((child) => child.render(120)).join("\n");
}

describe("issue #7829 invalid settings warning", () => {
	beforeAll(() => initTheme("dark"));

	it("renders startup diagnostics inside the transcript", async () => {
		const harness = await createHarness();
		try {
			const chatContainer = new Container();
			const startupDiagnostics: AgentSessionRuntimeDiagnostic[] = [
				{
					type: "warning",
					message: "Invalid settings file /tmp/settings.json: malformed JSON",
				},
			];
			const context = {
				init: vi.fn(async () => {}),
				options: { startupDiagnostics },
				chatContainer,
				outputPad: 1,
				ui: { requestRender: vi.fn() },
				redraw: { requestRender: vi.fn() },
				version: "test",
				showWarning: (InteractiveMode.prototype as unknown as { showWarning(message: string): void }).showWarning,
				session: harness.session,
				checkForPackageUpdates: vi.fn().mockResolvedValue([]),
				checkTmuxKeyboardSetup: vi.fn().mockResolvedValue(undefined),
				maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(),
				getUserInput: vi.fn(() => new Promise<string>(() => {})),
			};
			const run = (InteractiveMode.prototype as unknown as { run(this: typeof context): Promise<void> }).run;

			void run.call(context);

			await vi.waitFor(() => {
				expect(render(chatContainer)).toContain(
					"Warning: Invalid settings file /tmp/settings.json: malformed JSON",
				);
			});
		} finally {
			harness.cleanup();
		}
	});
});
