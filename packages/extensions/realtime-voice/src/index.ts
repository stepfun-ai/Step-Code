import type { CaptureHandlers, CaptureSession, RealtimeDriver, RealtimeDriverCapability } from "@step-harness/realtime";
import { createMockBridge } from "./bridge.ts";
import { createMockCapture } from "./capture.ts";
import { createMockPlayback } from "./playback.ts";

const MOCK_CAPABILITY: RealtimeDriverCapability = {
	sampleRates: [16000, 24000],
	nativeVad: false,
	echoCancellation: false,
};

/**
 * First-phase MOCK realtime driver (S6-2). Satisfies the `RealtimeDriver` contract
 * with no real audio device / vendor SDK — the concrete capture / playback / vendor
 * bridge (external audio SDK, ASR/TTS) is chosen and implemented when voice is
 * actually built; this pass does not pick vendors. This extension imports ONLY
 * `@step-harness/realtime`, registers nothing itself, and is registered only by the
 * composition root when a voice surface is selected (S6-4, deferred) — so a normal
 * coding startup never loads an audio SDK or opens the microphone.
 */
export function createRealtimeVoiceDriver(): RealtimeDriver {
	const playback = createMockPlayback();
	const bridge = createMockBridge();
	return {
		capability: MOCK_CAPABILITY,
		startCapture(handlers: CaptureHandlers): Promise<CaptureSession> {
			return createMockCapture(handlers);
		},
		async play(frame) {
			playback.enqueue(frame);
		},
		async dispose() {
			await playback.dispose();
			await bridge.dispose();
		},
	};
}
