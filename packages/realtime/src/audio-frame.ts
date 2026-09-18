// AudioFrame — one chunk of audio on the realtime channel. Neutral contract only:
// no device, no vendor SDK, no AI dependency (packages/realtime is a zero-dependency
// contract layer; the mic/playback implementation lives in extensions/realtime-voice).

/** How the samples in an {@link AudioFrame} are encoded. */
export type AudioEncoding = "pcm16" | "pcm32f" | "mulaw" | "opus";

/** A single chunk of captured or to-be-played audio. */
export interface AudioFrame {
	/** Sample encoding of {@link AudioFrame.data}. */
	readonly encoding: AudioEncoding;
	/** Samples per second (e.g. 16000, 24000, 48000). */
	readonly sampleRate: number;
	/** Channel count (1 = mono). */
	readonly channels: number;
	/** Encoded audio bytes for this frame. */
	readonly data: Uint8Array;
	/** Capture/playback timestamp, epoch milliseconds. */
	readonly timestamp: number;
}
