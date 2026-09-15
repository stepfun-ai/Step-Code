import type { AudioFrame, CaptureHandlers, CaptureSession } from "@step-harness/realtime";

/**
 * Microphone capture (S6-2). First-phase MOCK: no real audio device / native module
 * — returns a capture session that opens nothing and delivers no frames. The real
 * device capture is implemented when voice is actually built.
 */
export function createMockCapture(_handlers: CaptureHandlers): Promise<CaptureSession> {
	return Promise.resolve({
		async stop() {},
	});
}

export type { AudioFrame };
