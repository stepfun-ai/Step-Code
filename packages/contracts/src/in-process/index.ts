// Barrel for the in-process (host-facing) contract surface.
// Exported as the package root ("@step-harness/contracts").

export type {
	AgentCapabilitySnapshot,
	AgentProduct,
	AgentProductId,
	CreateAgentSessionOptions,
	InteractionSurface,
} from "./agent-product.ts";
export type { HostEvent, HostEventChannel, HostTelemetryEvent } from "./host-event.ts";
export type {
	AgentEvent,
	AgentEventListener,
	AgentInput,
	AgentInputImage,
	AgentMessagePreview,
	AgentSessionHandle,
	ApprovalCancellation,
	ApprovalCancellationReason,
	ApprovalDecision,
	ApprovalOutcome,
	ApprovalRequest,
	ApprovalVerdict,
	Unsubscribe,
} from "./session-handle.ts";
export type { SessionEntry, SessionEntryRole, SessionRecord, SessionRecordStats } from "./session-record.ts";
