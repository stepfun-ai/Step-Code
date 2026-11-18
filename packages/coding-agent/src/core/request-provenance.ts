import type { AssistantMessage } from "@step-harness/providers/compat";

/** Session custom entry type for one model request's provenance. */
export const USAGE_PROVENANCE_ENTRY_TYPE = "step.usage_provenance";

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
	/**
	 * HTTP responses the provider received for this request, counting the
	 * provider's own retries inside it (they produce no extra message). Absent
	 * when no response arrived at all.
	 */
	transportAttempts?: number;
}

/** Why a request that produced no conversation reply was made. */
export type RequestPurpose = "compaction" | "branch_summary";

const provenance = new WeakMap<AssistantMessage, RequestUsageProvenance>();
export function rememberRequestUsage(message: AssistantMessage, value: RequestUsageProvenance): void {
	provenance.set(message, value);
}
export function readRequestUsage(message: AssistantMessage): RequestUsageProvenance | undefined {
	return provenance.get(message);
}

/** A settled request; `purpose` is set for summary requests. */
export interface SettledRequest {
	readonly provenance: RequestUsageProvenance;
	readonly purpose?: RequestPurpose;
}

/** Settled requests nobody has claimed yet; bounded so a host that never claims them cannot grow it. */
const LEDGER_LIMIT = 64;

/**
 * Every model request a session's stream function settled, until the session claims it.
 *
 * Provenance normally rides on the assistant message itself. Two cases need the
 * ledger instead: a request that failed before its stream existed, whose error
 * message the agent loop builds itself (so it carries no provenance), and a
 * summary request (compaction, branch summary), which produces no conversation
 * message at all. The session sets `purpose` while it summarizes, so those
 * requests are tagged at dispatch and never mistaken for a reply's.
 */
export class RequestLedger {
	/** Purpose stamped on requests dispatched from now on; set by the session around a summary. */
	purpose: RequestPurpose | undefined;
	private readonly settled: SettledRequest[] = [];

	record(value: RequestUsageProvenance, purpose: RequestPurpose | undefined): void {
		this.settled.push(purpose ? { provenance: value, purpose } : { provenance: value });
		if (this.settled.length > LEDGER_LIMIT) this.settled.shift();
	}

	/** The provenance of the request that produced `message`, claiming it. */
	claimReply(message: AssistantMessage): RequestUsageProvenance | undefined {
		const attached = readRequestUsage(message);
		if (attached) {
			const index = this.settled.findIndex((entry) => entry.provenance.requestId === attached.requestId);
			if (index >= 0) this.settled.splice(index, 1);
			return attached;
		}
		if (message.stopReason !== "error" && message.stopReason !== "aborted") return undefined;
		// The loop synthesized this message after its request failed; that request is
		// the latest failed, untagged one still unclaimed. A successful request always
		// has its message, so it is never taken here.
		for (let index = this.settled.length - 1; index >= 0; index--) {
			const entry = this.settled[index];
			if (entry && !entry.purpose && entry.provenance.outcome !== "ok") {
				this.settled.splice(index, 1);
				return entry.provenance;
			}
		}
		return undefined;
	}

	/** Claim every settled request with `purpose`, oldest first. */
	claimPurpose(purpose: RequestPurpose): RequestUsageProvenance[] {
		const claimed: RequestUsageProvenance[] = [];
		for (let index = 0; index < this.settled.length; ) {
			const entry = this.settled[index];
			if (entry?.purpose === purpose) {
				claimed.push(entry.provenance);
				this.settled.splice(index, 1);
			} else {
				index++;
			}
		}
		return claimed;
	}
}
