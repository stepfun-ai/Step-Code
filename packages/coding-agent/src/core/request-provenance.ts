import type { AssistantMessage } from "@step-harness/providers/compat";

export interface RequestUsageProvenance {
	requestId: string;
	sessionId: string;
	sourceLeafId: string | null;
	reasoningAtDispatch: string;
	requestedProvider: string;
	requestedModel: string;
}
const provenance = new WeakMap<AssistantMessage, RequestUsageProvenance>();
export function rememberRequestUsage(message: AssistantMessage, value: RequestUsageProvenance): void {
	provenance.set(message, value);
}
export function readRequestUsage(message: AssistantMessage): RequestUsageProvenance | undefined {
	return provenance.get(message);
}
