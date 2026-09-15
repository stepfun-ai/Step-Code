# @step-harness/voice-agent

The voice channel for step-harness (S6-3): "a mouth and ears, not a second agent." It
implements the `VoiceInteraction` contract (from `@step-harness/contracts`) over the
neutral realtime contracts (`@step-harness/realtime`) — `attach(session)` connects to an
**existing** agent session and turns voice into `AgentInput` / session events into speech.
It never creates a session, never holds coding tools, and is a peer of `coding-agent`
(no import edge in either direction). First phase ships stub turn-taking / audio-session /
prompt logic; the device driver and composition-root wiring land in S6-4.
