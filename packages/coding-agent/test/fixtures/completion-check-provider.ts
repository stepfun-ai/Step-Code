import { appendFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider } from "@step-harness/providers";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";

/** Offline provider for the real CLI completion-check tests. */
export default function completionCheckProvider(pi: ExtensionAPI): void {
	const faux = fauxProvider({ provider: "completion-offline" });
	faux.setResponses(
		Array.from({ length: 5 }, () => () => {
			const callLog = process.env.COMPLETION_CHECK_CALL_LOG;
			if (!callLog) throw new Error("completion-check fixture requires a call log");
			appendFileSync(callLog, "model call\n");
			return fauxAssistantMessage("CLI offline final");
		}),
	);
	pi.registerProvider(faux.provider);
}
