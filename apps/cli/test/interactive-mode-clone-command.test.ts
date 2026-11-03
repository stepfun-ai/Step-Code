import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/ui/interactive-mode.ts";
import { createFakeInteractiveContext } from "./support/fake-interactive-context.ts";

type CloneCommandContext = {
	sessionManager: { getLeafId: () => string | null };
	runtimeHost: {
		fork: (entryId: string, options?: { position?: "before" | "at" }) => Promise<{ cancelled: boolean }>;
	};
};

type InteractiveModePrototype = {
	handleCloneCommand(this: unknown): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

describe("InteractiveMode /clone", () => {
	it("clones the current leaf into a new session", async () => {
		const fork = vi.fn(async () => ({ cancelled: false }));

		const context = createFakeInteractiveContext<CloneCommandContext>({
			sessionManager: { getLeafId: () => "leaf-123" },
			runtimeHost: { fork },
		});

		await interactiveModePrototype.handleCloneCommand.call(context);

		expect(fork).toHaveBeenCalledWith("leaf-123", { position: "at" });
		expect(context.renderCurrentSessionState).not.toHaveBeenCalled();
		expect(context.editor.setText).toHaveBeenCalledWith("");
		expect(context.showStatus).toHaveBeenCalledWith("Cloned to new session");
		expect(context.showError).not.toHaveBeenCalled();
		expect(context.ui.requestRender).not.toHaveBeenCalled();
	});

	it("shows a status message when there is nothing to clone", async () => {
		const fork = vi.fn(async () => ({ cancelled: false }));

		const context = createFakeInteractiveContext<CloneCommandContext>({
			sessionManager: { getLeafId: () => null },
			runtimeHost: { fork },
		});

		await interactiveModePrototype.handleCloneCommand.call(context);

		expect(fork).not.toHaveBeenCalled();
		expect(context.showStatus).toHaveBeenCalledWith("Nothing to clone yet");
		expect(context.showError).not.toHaveBeenCalled();
	});
});
