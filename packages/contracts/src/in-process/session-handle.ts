// Host-facing session surface: the handle an app drives, the events it observes,
// the inputs it sends, and the tool-approval round-trip. These types are the
// stable contract between a host (CLI/TUI) and an agent product; they are
// modeled after the loop's AgentEvent (packages/agent-core) and AgentSession's
// AgentSessionEvent (packages/coding-agent) but kept fully self-contained so the
// contracts package carries zero runtime dependencies.

/** Disposes a subscription. Safe to call more than once. */
export type Unsubscribe = () => void;

/** A minimal image attachment carried on an AgentInput. */
export interface AgentInputImage {
	readonly mimeType: string;
	/** Base64-encoded image bytes. */
	readonly data: string;
}

/** Canonical text input a host sends into a session. */
export interface AgentInput {
	readonly text: string;
	readonly images?: readonly AgentInputImage[];
}

/**
 * Host-visible preview of a transcript message. Content is intentionally opaque
 * (`unknown`) at the contract boundary: the concrete AgentMessage shape lives in
 * the AI/agent-loop packages, which the contracts package must not depend on.
 */
export interface AgentMessagePreview {
	readonly role: "user" | "assistant" | "toolResult" | "custom";
	readonly content: unknown;
}

/**
 * Channel 1 of the host event model: real-time lifecycle events.
 *
 * A host-facing projection of the agent loop's AgentEvent union. Record-visibility
 * entries and telemetry are modeled separately (see session-record.ts and
 * host-event.ts) so the three concerns never share one over-loaded type.
 */
export type AgentEvent =
	| { readonly type: "agent_start" }
	| { readonly type: "agent_end"; readonly willRetry: boolean }
	| { readonly type: "agent_settled" }
	| { readonly type: "turn_start" }
	| { readonly type: "turn_end"; readonly message: AgentMessagePreview }
	| { readonly type: "message_start"; readonly message: AgentMessagePreview }
	| { readonly type: "message_update"; readonly message: AgentMessagePreview }
	| { readonly type: "message_end"; readonly message: AgentMessagePreview }
	| {
			readonly type: "tool_execution_start";
			readonly toolCallId: string;
			readonly toolName: string;
			readonly args: unknown;
	  }
	| {
			readonly type: "tool_execution_update";
			readonly toolCallId: string;
			readonly toolName: string;
			readonly partialResult: unknown;
	  }
	| {
			readonly type: "tool_execution_end";
			readonly toolCallId: string;
			readonly toolName: string;
			readonly result: unknown;
			readonly isError: boolean;
	  };

/** Listener invoked for every real-time AgentEvent on a session. */
export type AgentEventListener = (event: AgentEvent) => void;

/**
 * The stable handle a host holds for one live agent session. Mirrors §2.3 of the
 * architecture redesign: the app never reaches into product internals, it only
 * drives this surface.
 */
export interface AgentSessionHandle {
	readonly sessionId: string;
	/** Submit a new user input, starting a run if idle. */
	send(input: AgentInput): Promise<void>;
	/** Inject a steering message mid-run without interrupting the current turn. */
	steer(input: AgentInput): Promise<void>;
	/** Request a graceful interrupt of the in-flight run. */
	interrupt(reason?: string): Promise<void>;
	/** Subscribe to real-time AgentEvents. Returns an unsubscribe handle. */
	subscribe(listener: AgentEventListener): Unsubscribe;
	/** Release the session and its resources. */
	close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Tool approval round-trip
//
// A host approves or denies tool calls that the product routes to it. The three
// identifiers (requestId / sessionId / toolCallId) let a host correlate a request
// with the session and the exact tool call, and a timeout rule governs what
// happens when no decision arrives in time.
// ---------------------------------------------------------------------------

/** A pending request for the host to approve or deny a single tool call. */
export interface ApprovalRequest {
	/** Unique id for this approval round-trip; echoed back in the decision. */
	readonly requestId: string;
	/** Session the tool call belongs to. */
	readonly sessionId: string;
	/** The specific tool call awaiting a decision. */
	readonly toolCallId: string;
	readonly toolName: string;
	/** Validated tool arguments, opaque at the contract boundary. */
	readonly args: unknown;
	/** Epoch millis when the request was raised. */
	readonly createdAt: number;
	/**
	 * Optional deadline. If no decision is received within this many milliseconds
	 * from `createdAt`, the request is auto-cancelled (see ApprovalCancellation)
	 * and the tool call is treated as denied.
	 */
	readonly timeoutMs?: number;
}

/** The verdict a host returns for an ApprovalRequest. */
export type ApprovalVerdict = "approve" | "approve_for_session" | "deny";

/** A host's decision for a specific ApprovalRequest. */
export interface ApprovalDecision {
	readonly requestId: string;
	readonly sessionId: string;
	readonly toolCallId: string;
	readonly verdict: ApprovalVerdict;
	/** Optional human-readable reason, surfaced to the model on denial. */
	readonly reason?: string;
}

/** Why a pending ApprovalRequest was cancelled before a decision arrived. */
export type ApprovalCancellationReason = "timeout" | "interrupted" | "superseded";

/**
 * Cancellation of a still-pending ApprovalRequest. A `timeout` cancellation is
 * emitted when `timeoutMs` elapses; the product then proceeds as if the tool call
 * were denied. `interrupted` covers session interrupt/close, `superseded` a newer
 * request replacing this one.
 */
export interface ApprovalCancellation {
	readonly requestId: string;
	readonly sessionId: string;
	readonly toolCallId: string;
	readonly reason: ApprovalCancellationReason;
}

/** Terminal outcome of an approval round-trip: either a decision or a cancellation. */
export type ApprovalOutcome =
	| { readonly kind: "decided"; readonly decision: ApprovalDecision }
	| { readonly kind: "cancelled"; readonly cancellation: ApprovalCancellation };
