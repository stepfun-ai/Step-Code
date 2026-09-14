import type { AudioFrame } from "@step-harness/realtime";

/** Speaker playback (S6-2). First-phase MOCK: buffers frames, drives no device. */
export interface MockPlayback {
	enqueue(frame: AudioFrame): void;
	dispose(): Promise<void>;
}

export function createMockPlayback(): MockPlayback {
	const queue: AudioFrame[] = [];
	return {
		enqueue(frame) {
			queue.push(frame);
		},
		async dispose() {
			queue.length = 0;
		},
	};
}
