import { isRetryableAssistantError } from "@step-harness/providers";
import type { ExtensionAPI } from "../core/extensions/types.ts";
import type { CustomMessage } from "../core/messages.ts";

/** Change the next request after an incomplete response without owning retries. */
export function registerStepStreamRecovery(pi: ExtensionAPI): void {
	pi.on("context", (event, ctx) => {
		// Native retries remove the failed response from agent context but retain
		// it in session history. Read the active branch so navigation and new user
		// messages cannot inherit stale in-memory recovery state.
		const latest = ctx.sessionManager
			.getBranch()
			.slice()
			.reverse()
			.find((entry) => entry.type === "message");
		if (
			latest?.message.role !== "assistant" ||
			!isRetryableAssistantError(latest.message) ||
			!/\bstream ended (?:before|without)\b/i.test(latest.message.errorMessage ?? "")
		) {
			return;
		}

		const recovery: CustomMessage = {
			role: "custom",
			customType: "step-stream-recovery",
			display: false,
			timestamp: latest.message.timestamp,
			content: [
				"[Step runtime recovery] The previous model response was interrupted before completion.",
				"Tool calls in that failed response were not executed. Preserve work confirmed by earlier tool results.",
				"Continue the original task with a smaller response: choose one focused tool call, keeping generated code or text to roughly 50 lines or a few kilobytes when practical.",
				"If the task involves large files or reports, build them incrementally across separate responses using the available write/edit tools. Do not resend an entire large file or move the same large payload into a shell command.",
				"Check current file contents when needed, then continue the remaining work and validation. Existing permissions and user constraints still apply.",
			].join("\n"),
		};
		// Projection only: no synthetic user message or recovery note is persisted.
		return { messages: [...event.messages, recovery] };
	});
}
