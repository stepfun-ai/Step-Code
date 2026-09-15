// @step-harness/voice-agent — the voice channel (S6-3). Peer of coding-agent: it
// attaches to an existing session handle and never imports coding-agent. Implements
// the VoiceInteraction contract (packages/contracts) over the neutral realtime
// contracts (packages/realtime). First phase = stub; device driver + composition-root
// wiring (S6-4) are deferred.

export { type AudioSession, createAudioSession } from "./audio-session.ts";
export { createVoiceInteraction, VoiceAgentInteraction } from "./interaction.ts";
export { VOICE_SYSTEM_PROMPT_FRAGMENT } from "./prompt/index.ts";
export { createTurnTakingPolicy, type TurnTakingPolicy } from "./turn-taking/index.ts";
