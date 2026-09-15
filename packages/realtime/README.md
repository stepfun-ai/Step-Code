# @step-harness/realtime

Neutral realtime-audio contracts for the step-harness voice capability (S6-1): audio
frames, conversational turns, interrupts, VAD events/thresholds, and the device-driver
capability + `RealtimeDriver` interface. **Zero runtime dependencies** — this is a
contract layer only, with no device code, no vendor SDK, and no AI dependency. The
microphone/playback implementation lives in `extensions/realtime-voice`; the voice
channel that consumes these contracts lives in `packages/voice-agent`.
