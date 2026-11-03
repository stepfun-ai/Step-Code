import type { AssistantMessage } from "@step-harness/providers/compat";

/**
 * What the kernel observed about one model request.
 *
 * Persisted as `step.usage_provenance`, which makes a feedback report joinable
 * with the server-side request log. The optional members were added after the
 * first version: a session written by an older build simply lacks them, so
 * every reader must treat them as unknown rather than missing-but-expected.
 */
export interface RequestUsageProvenance {
	requestId: string;
	sessionId: string;
	sourceLeafId: string | null;
	reasoningAtDispatch: string;
	requestedProvider: string;
	requestedModel: string;
	/** API dialect the request used; a wrong-looking reply usually starts here. */
	api?: string;
	/** Catalog limits at dispatch, which a later config change would hide. */
	contextWindow?: number;
	maxTokens?: number;
	/** Provider that actually handled the request (auth or proxy may redirect it). */
	responseProvider?: string;
	responseModel?: string;
	/** HTTP status of the attempt; 0 or absent when the request never got one. */
	statusCode?: number;
	/** Wall-clock duration of the attempt. */
	durationMs?: number;
	/** Time to the first stream event. Absent means no event ever arrived. */
	ttftMs?: number | null;
	/** `ok`, or which side of the wire failed; a user stop is a transport outcome. */
	outcome?: "ok" | "http_error" | "transport_error";
	/**
	 * How far the attempt got before it settled. An attempt the user stopped
	 * while the model was still thinking has only `thinking`.
	 */
	reached?: "thinking" | "text" | "toolCall";
}
const provenance = new WeakMap<AssistantMessage, RequestUsageProvenance>();
export function rememberRequestUsage(message: AssistantMessage, value: RequestUsageProvenance): void {
	provenance.set(message, value);
}
export function readRequestUsage(message: AssistantMessage): RequestUsageProvenance | undefined {
	return provenance.get(message);
}
