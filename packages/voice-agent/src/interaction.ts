import type { AgentSessionHandle, VoiceInteraction, VoiceInteractionHandle } from "@step-harness/contracts";
import { createAudioSession } from "./audio-session.ts";

/**
 * The voice channel (S6-3). It attaches to an EXISTING coding session and turns
 * voice turns into `AgentInput` / session `AgentEvent`s into speech — it does NOT
 * own an agent loop, coding tools, or the session's source of truth.
 *
 * First phase (this pass): a working stub that satisfies the `VoiceInteraction`
 * contract and exercises the wiring (subscribes to the session), but performs no
 * device I/O — the `RealtimeDriver` is injected by the composition root, which is
 * deferred to S6-4. `modelPolicy.toolCall` is the literal `false`: the voice model
 * never calls tools (S6-5).
 */
export class VoiceAgentInteraction implements VoiceInteraction {
	readonly id = "voice" as const;
	readonly modelPolicy = { toolCall: false } as const;

	async attach(session: AgentSessionHandle): Promise<VoiceInteractionHandle> {
		const audio = createAudioSession();
		// Subscribe so the attach wiring compiles and is exercised; voice-side
		// rendering (TTS / turn-taking) lands with the driver in S6-4.
		const unsubscribe = session.subscribe(() => {});
		return {
			async stop() {
				unsubscribe();
				await audio.dispose();
			},
		};
	}
}

/** Factory for the voice interaction the composition root registers (S6-4). */
export function createVoiceInteraction(): VoiceInteraction {
	return new VoiceAgentInteraction();
}
