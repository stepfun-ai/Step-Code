// Wire representation of the three host event channels.
//
// A WireEvent is the on-the-wire envelope for a HostEvent: it adds the fields a
// transport needs (sequence number, timestamp) around a channel-tagged payload.
// The in-process host types are the single source of truth for the payload
// shapes; this module only frames them for transport. Serialization of the
// envelope (CBOR/JSON) is out of scope — see ./frame.ts for the only I/O.

import type { HostTelemetryEvent } from "../in-process/host-event.ts";
import type { AgentEvent } from "../in-process/session-handle.ts";
import type { SessionEntry } from "../in-process/session-record.ts";

/** The three transport channels, matching HostEventChannel in-process. */
export type WireEventChannel = "live" | "record" | "telemetry";

/** Common envelope fields shared by every wire event. */
export interface WireEventEnvelope {
	/** Session the event belongs to. */
	readonly sessionId: string;
	/** Monotonic per-stream sequence number for ordering and gap detection. */
	readonly seq: number;
	/** Epoch millis when the event was emitted by the sender. */
	readonly timestamp: number;
}

/**
 * A channel-tagged wire event. The three variants mirror the in-process
 * HostEvent channels: real-time agent events, record-visibility entries, and
 * telemetry signals.
 */
export type WireEvent =
	| (WireEventEnvelope & { readonly channel: "live"; readonly event: AgentEvent })
	| (WireEventEnvelope & { readonly channel: "record"; readonly entry: SessionEntry })
	| (WireEventEnvelope & { readonly channel: "telemetry"; readonly telemetry: HostTelemetryEvent });
