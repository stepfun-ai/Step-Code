// The three-channel host event model.
//
// A host observes a session through three distinct concerns, modeled separately
// rather than merged into one over-loaded event type:
//   1. "live"      — real-time AgentEvents (session-handle.ts)
//   2. "record"    — record-visibility entries (session-record.ts)
//   3. "telemetry" — measurement/observability signals (defined here)
//
// HostEvent is the tagged union over all three. Kept self-contained: no runtime
// dependency on the telemetry package (that is the concrete emitter; this is the
// host-facing shape).

import type { AgentEvent } from "./session-handle.ts";
import type { SessionEntry } from "./session-record.ts";

/** Discriminator for the three host event channels. */
export type HostEventChannel = "live" | "record" | "telemetry";

/** Channel 3: a single telemetry signal projected to the host. */
export interface HostTelemetryEvent {
	/** Dotted metric/span name, e.g. "step.compaction.contextProjection". */
	readonly name: string;
	/** Epoch millis when the signal was recorded. */
	readonly timestamp: number;
	/** Flat attribute bag. Values are primitives to stay serialization-agnostic. */
	readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * A host event tagged by channel and correlated to a session. The three variants
 * carry, respectively, a live AgentEvent, an appended record entry, and a
 * telemetry signal.
 */
export type HostEvent =
	| { readonly channel: "live"; readonly sessionId: string; readonly event: AgentEvent }
	| { readonly channel: "record"; readonly sessionId: string; readonly entry: SessionEntry }
	| { readonly channel: "telemetry"; readonly sessionId: string; readonly telemetry: HostTelemetryEvent };
