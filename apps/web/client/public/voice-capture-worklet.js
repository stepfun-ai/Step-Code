/**
 * Voice capture worklet: the microphone's Float32 frames to PCM16 chunks.
 *
 * Loaded by `actions.ts` through `audioContext.audioWorklet.addModule`, so
 * Vite bundles this file as-is. The main thread receives one message per
 * chunk (`{ data, level }`: base64 PCM16 plus a 0..1 input level that drives
 * the recording waveform), 100 ms of audio at the context's rate, which the
 * host forwards to the realtime service unchanged.
 *
 * Two environment facts shape this file:
 *
 * - The AudioWorklet global scope in the app's Chromium build has no `btoa`
 *   (verified 2026-10-25: `typeof btoa === "undefined"`), so the base64
 *   encoder below is written by hand. Calling a missing global here does not
 *   log anywhere useful — it kills the processor silently, which is how a
 *   whole dictation once produced zero chunks with a healthy-looking button.
 * - An exception in `process` ends the processor just as silently, so the
 *   body reports failures to the main thread instead of dying quietly.
 *
 * The worklet holds no state beyond the partial chunk: a stop closes the
 * stream from the main thread, and the browser discards the processor.
 */

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 of little-endian bytes; `btoa` is unavailable in this scope. */
function encodeBase64(bytes) {
	let encoded = "";
	for (let index = 0; index < bytes.length; index += 3) {
		const remaining = bytes.length - index;
		const first = bytes[index];
		const second = remaining >= 2 ? bytes[index + 1] : 0;
		const third = remaining >= 3 ? bytes[index + 2] : 0;
		encoded += BASE64_ALPHABET[first >> 2];
		encoded += BASE64_ALPHABET[((first & 0x03) << 4) | (second >> 4)];
		encoded += remaining >= 2 ? BASE64_ALPHABET[((second & 0x0f) << 2) | (third >> 6)] : "=";
		encoded += remaining >= 3 ? BASE64_ALPHABET[third & 0x3f] : "=";
	}
	return encoded;
}

/**
 * RMS of the chunk, scaled into 0..1 for a waveform. Speech sits far below
 * full scale, so the gain lifts it; quiet rooms still read near the floor.
 */
function chunkLevel(samples) {
	let total = 0;
	for (let index = 0; index < samples.length; index++) total += samples[index] * samples[index];
	const rms = Math.sqrt(total / samples.length);
	return Math.max(0, Math.min(1, rms * 6));
}

class CaptureProcessor extends AudioWorkletProcessor {
	/** Samples per 100 ms at the context's rate (24 kHz expected, like the plugin). */
	chunkSamples = Math.max(1, Math.round(sampleRate / 10));
	buffer = new Int16Array(this.chunkSamples);
	levelBuffer = new Float32Array(this.chunkSamples);
	filled = 0;

	/** One rendering quantum (128 frames). Returns true to stay alive. */
	process(inputs) {
		try {
			const channel = inputs[0]?.[0];
			if (!channel) return true;
			for (let index = 0; index < channel.length; index++) {
				const sample = Math.max(-1, Math.min(1, channel[index]));
				this.levelBuffer[this.filled] = sample;
				// -1 maps to -32768, +1 to +32767; the asymmetric scale is PCM16's.
				this.buffer[this.filled++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
				if (this.filled < this.chunkSamples) continue;
				const bytes = new Uint8Array(this.buffer.buffer);
				this.port.postMessage({
					data: encodeBase64(bytes),
					level: chunkLevel(this.levelBuffer),
				});
				this.filled = 0;
			}
			return true;
		} catch (error) {
			// The main thread turns this into a visible failure; without it the
			// recording would sit silent forever.
			this.port.postMessage({ error: error instanceof Error ? error.message : String(error) });
			return false;
		}
	}
}

registerProcessor("capture-processor", CaptureProcessor);
