import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@step-harness/providers";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";

/**
 * Offline provider plus a streaming tool, for the real CLI tests that check what
 * a `--mode json` run writes to stdout.
 *
 * The tool streams several progress frames and then returns. Those frames are
 * the exact shape that turned a subagent's live progress into a GB-scale log, so
 * the transport's default (durable events only) is asserted on this stream.
 */
export default function streamingProvider(pi: ExtensionAPI): void {
	const faux = fauxProvider({ provider: "stream-offline" });
	let turn = 0;
	faux.setResponses([
		() => {
			turn += 1;
			return fauxAssistantMessage(fauxToolCall("stream_probe", { label: "probe" }), { stopReason: "toolUse" });
		},
		() => fauxAssistantMessage(`CLI offline final (turn ${turn})`),
	]);
	pi.registerProvider(faux.provider);

	pi.registerTool({
		name: "stream_probe",
		label: "Stream probe",
		description: "Emits progress frames, then returns.",
		parameters: {
			type: "object",
			properties: { label: { type: "string" } },
			required: ["label"],
			additionalProperties: false,
		} as never,
		execute: async (_toolCallId, _params, _signal, onUpdate) => {
			for (let index = 0; index < 5; index += 1) {
				onUpdate?.({ content: [{ type: "text", text: `frame ${index}` }], details: { index } });
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			return { content: [{ type: "text", text: "probe done" }], details: { index: 5 } };
		},
	});
}
