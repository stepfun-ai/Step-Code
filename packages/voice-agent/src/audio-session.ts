import type { AudioFrame, VadEvent } from "@step-harness/realtime";

/**
 * Voice-side LOCAL state — playback queue + VAD buffer. This is not the session's
 * source of truth (that stays in the coding session); it is only the audio-channel's
 * own state. First-phase stub: holds the shape and buffers frames, does no device I/O.
 */
export interface AudioSession {
	enqueue(frame: AudioFrame): void;
	onVad(event: VadEvent): void;
	dispose(): Promise<void>;
}

export function createAudioSession(): AudioSession {
	const playbackQueue: AudioFrame[] = [];
	return {
		enqueue(frame) {
			playbackQueue.push(frame);
		},
		onVad() {
			// Turn-taking reacts to VAD once the driver is wired (S6-4).
		},
		async dispose() {
			playbackQueue.length = 0;
		},
	};
}
