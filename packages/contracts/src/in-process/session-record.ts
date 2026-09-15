// Channel 2 of the host event model: record visibility.
//
// A SessionRecord is the persisted, host-visible transcript of a session — the
// subset of state a host may render or resume from. It is modeled separately from
// the real-time AgentEvent stream (session-handle.ts) and from telemetry
// (host-event.ts): what is persisted/visible is not the same as what is emitted
// live nor what is measured. Kept self-contained (zero dependencies).

/** Role of a persisted transcript entry visible to a host. */
export type SessionEntryRole = "user" | "assistant" | "toolResult" | "note";

/** A single record-visible transcript entry. */
export interface SessionEntry {
	/** Stable id of this entry within the record. */
	readonly id: string;
	readonly role: SessionEntryRole;
	/** Epoch millis when the entry was appended. */
	readonly timestamp: number;
	/**
	 * Host-renderable content. Opaque (`unknown`) at the contract boundary: the
	 * concrete message shape lives in the AI/agent-loop packages, which contracts
	 * must not depend on.
	 */
	readonly content: unknown;
}

/** Token/cost accounting a host may surface for a session. */
export interface SessionRecordStats {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly totalTokens: number;
	readonly cost: number;
}

/** The persisted, host-visible view of one session. */
export interface SessionRecord {
	readonly sessionId: string;
	/** User-assigned or derived display name, if any. */
	readonly name?: string;
	/** Epoch millis when the session was created. */
	readonly createdAt: number;
	/** Epoch millis of the most recent update. */
	readonly updatedAt: number;
	/** Ordered transcript entries visible to the host. */
	readonly entries: readonly SessionEntry[];
	readonly stats?: SessionRecordStats;
}
