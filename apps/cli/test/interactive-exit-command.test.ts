import { describe, expect, it, vi } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../../../packages/coding-agent/src/core/slash-commands.ts";
import type { RuntimeContext } from "../src/ui/runtime/context.ts";
import { wireSubmitHandler } from "../src/ui/runtime/input-dispatch.ts";

describe("interactive exit commands", () => {
	it("advertises /exit in slash-command discovery", () => {
		expect(BUILTIN_SLASH_COMMANDS.some((command) => command.name === "exit")).toBe(true);
	});

	it.each([
		{ name: "idle", isStreaming: false, isCompacting: false },
		{ name: "streaming", isStreaming: true, isCompacting: false },
		{ name: "compacting", isStreaming: false, isCompacting: true },
	])("exits immediately while $name instead of queuing a prompt", async (state) => {
		for (const command of ["/exit", "/quit", "  /exit  "]) {
			const editor = { setText: vi.fn(), onSubmit: undefined as ((text: string) => Promise<void>) | undefined };
			const shutdown = vi.fn(async () => {});
			const prompt = vi.fn();
			const unknown = vi.fn(() => "exit");
			const showError = vi.fn();
			const queueCompactionMessage = vi.fn();
			const context = {
				defaultEditor: editor, editor, shutdown,
				session: { ...state, prompt },
				getUnknownSlashCommandName: unknown, showError, queueCompactionMessage,
			} as unknown as RuntimeContext;
			wireSubmitHandler(context);
			await editor.onSubmit!(command);
			expect(shutdown).toHaveBeenCalledOnce();
			expect(editor.setText).toHaveBeenCalledWith("");
			expect(unknown).not.toHaveBeenCalled();
			expect(showError).not.toHaveBeenCalled();
			expect(prompt).not.toHaveBeenCalled();
			expect(queueCompactionMessage).not.toHaveBeenCalled();
		}
	});
});
