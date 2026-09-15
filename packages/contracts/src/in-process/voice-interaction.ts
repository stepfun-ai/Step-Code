import type { AgentSessionHandle } from "./session-handle.ts";

/**
 * Host-facing voice channel contract. Voice is "a mouth and ears", not a second
 * agent: it attaches to an EXISTING {@link AgentSessionHandle}, never creates a
 * session and never holds coding tools. `modelPolicy.toolCall` is the literal
 * `false` so any attempt to enable tools on the voice path is a compile-time error
 * (S6-5). Implemented by packages/voice-agent; declared here (contracts) so
 * voice-agent needs no reverse dependency on coding-agent and voice/coding never
 * share an "omni product" type.
 */
export interface VoiceInteraction {
	readonly id: "voice";
	readonly modelPolicy: { readonly toolCall: false };
	attach(session: AgentSessionHandle): Promise<VoiceInteractionHandle>;
}

/** A running voice interaction; `stop()` detaches it from the session. */
export interface VoiceInteractionHandle {
	stop(): Promise<void>;
}
