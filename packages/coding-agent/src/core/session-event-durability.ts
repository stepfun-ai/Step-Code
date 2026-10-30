/**
 * Session-event durability.
 *
 * A session event has two possible audiences, and they disagree about volume:
 *
 * - Hosts that render a live view (the TUI, a web client over SSE) need frequent
 *   progress. They read it in process, one frame replaces the previous one, and
 *   dropping an intermediate frame costs nothing.
 * - Hosts that keep a record (the `json`/`rpc` stdout a harness redirects to a
 *   file) need one entry per fact. They never replay progress, and every extra
 *   frame is permanent bytes.
 *
 * Treating those as the same stream is what turned a subagent's live progress
 * into a GB-scale log: progress was written once per streamed delta, and each
 * entry carried the child's whole transcript. The fix is not a smaller payload
 * per producer — it is to say which events are worth persisting at all, and to
 * have every serialized transport agree.
 * Every serialized transport must filter on this classification, unless its
 * caller explicitly opts into live frames. In-process subscribers receive both.
 *
 * The classification is an allowlist of *ephemeral* types, so an event added
 * later is durable by default: forgetting to classify a new event cannot
 * silently opt it into the log.
 */

import type { AgentSessionEvent } from "./agent-session.ts";

/** Whether an event is a fact to persist or a frame to render. */
export type SessionEventDurability = "durable" | "ephemeral";

/**
 * Events whose payload is a cumulative snapshot of in-flight work.
 *
 * Each one's successor carries the authoritative value — `message_end` for a
 * streamed message, `tool_execution_end` for a tool — so a reader that skips
 * them can still reconstruct the run exactly. This is the same boundary other
 * harnesses draw between a stream fragment and the replayable value.
 *
 * The successor test is what keeps `bash_execution_update` out: it carries a
 * delta, not a snapshot, and a user-issued `!` command has no message event that
 * would restate its output. Dropping it would lose the output, not repeat it.
 */
const EPHEMERAL_SESSION_EVENT_TYPES: ReadonlySet<AgentSessionEvent["type"]> = new Set([
	"message_update",
	"tool_execution_update",
]);

export function sessionEventDurability(event: Pick<AgentSessionEvent, "type">): SessionEventDurability {
	return EPHEMERAL_SESSION_EVENT_TYPES.has(event.type) ? "ephemeral" : "durable";
}

export function isEphemeralSessionEvent(event: Pick<AgentSessionEvent, "type">): boolean {
	return sessionEventDurability(event) === "ephemeral";
}
