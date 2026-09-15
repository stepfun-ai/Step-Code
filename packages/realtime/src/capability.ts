import type { AudioFrame } from "./audio-frame.ts";
import type { InterruptSignal } from "./interrupt.ts";
import type { VadEvent } from "./vad.ts";

/** A realtime driver's self-description: what the device / transport supports. */
export interface RealtimeDriverCapability {
	/** Sample rates (Hz) the driver can capture / play. */
	readonly sampleRates: readonly number[];
	/** Whether the driver performs its own voice-activity detection. */
	readonly nativeVad: boolean;
	/** Whether the driver performs acoustic echo cancellation. */
	readonly echoCancellation: boolean;
}

/** A handle to a running capture stream; `stop()` releases the microphone. */
export interface CaptureSession {
	stop(): Promise<void>;
}

/** Callbacks a capture stream delivers to its consumer. */
export interface CaptureHandlers {
	onFrame(frame: AudioFrame): void;
	onVad?(event: VadEvent): void;
	onInterrupt?(signal: InterruptSignal): void;
}

/**
 * The neutral device / transport contract that `extensions/realtime-voice`
 * implements (mic capture, playback, vendor bridge). The composition root is the
 * only place that constructs one, and only once a voice surface is selected — so a
 * normal coding startup never opens the microphone (`startCapture` is the sole call
 * that does). Depends only on the neutral audio/turn/interrupt/vad contract types.
 */
export interface RealtimeDriver {
	readonly capability: RealtimeDriverCapability;
	/** Open the microphone and stream frames + VAD / interrupt events. Only this opens the mic. */
	startCapture(handlers: CaptureHandlers): Promise<CaptureSession>;
	/** Enqueue a frame for playback. */
	play(frame: AudioFrame): Promise<void>;
	/** Release all driver resources. */
	dispose(): Promise<void>;
}
