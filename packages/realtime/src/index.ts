// @step-harness/realtime — neutral realtime-audio contract layer (S6-1).
// Zero runtime dependencies: only type/state-machine contracts for audio frames,
// turns, interrupts, VAD, and the device-driver capability. No device code, no
// vendor SDK, no AI dependency.

export type { AudioEncoding, AudioFrame } from "./audio-frame.ts";
export type {
	CaptureHandlers,
	CaptureSession,
	RealtimeDriver,
	RealtimeDriverCapability,
} from "./capability.ts";
export type { InterruptSignal, InterruptSource } from "./interrupt.ts";
export type { Turn, TurnSpeaker, TurnState } from "./turn.ts";
export type { VadEvent, VadState, VadThresholds } from "./vad.ts";
