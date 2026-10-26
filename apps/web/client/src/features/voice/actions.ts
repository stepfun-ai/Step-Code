/**
 * Voice dictation: capture the microphone, stream PCM16 to the host relay and
 * land the transcript in the composer.
 *
 * The host owns the transcription (see `apps/web/src/voice.ts`); this module
 * owns everything the browser side needs around it:
 *
 * - `GET /api/v1/voice` once, for the button's availability;
 * - `POST /api/v1/voice/start` before capture, `POST /audio` per chunk,
 *   `POST /stop` to transcribe, `POST /cancel` to discard;
 * - `getUserMedia` + an `AudioWorklet` that emits 100 ms PCM16 chunks, each
 *   `POST`ed to the host, which buffers them and transcribes the whole
 *   recording on stop.
 *
 * Nothing here keeps state beyond one recording: a second `start` while one
 * runs is refused by the host, and the controller refuses it locally first.
 */

import { api, errorMessage } from "../../lib/api";
import type { VoiceStatus } from "../../state/types";

const ROOT = "/api/v1/voice";

/** The composer's sample rate expectation (24 kHz, like the terminal plugin). */
const CAPTURE_SAMPLE_RATE = 24000;

/**
 * The capture worklet, served from the client's static directory (Vite
 * `public/`). A stable absolute URL on purpose: `addModule` must load a real
 * module file, and an inlined data URL is not something to rely on.
 */
const CAPTURE_WORKLET_URL = "/voice-capture-worklet.js";

/** The worklet's message: one base64 PCM16 chunk, field named like the host's audio body. */
interface CaptureChunk {
	readonly data?: string;
	/** Live input level 0..1 for the recording waveform; rides with `data`. */
	readonly level?: number;
	/** Set when the worklet's own processing failed; it stops itself after. */
	readonly error?: string;
}

/**
 * What the button shows; `error` settles back to `idle` after the toast.
 * `transcribing` is the pause between stopping the microphone and the host's
 * transcription reply landing.
 */
export type VoicePhase = "idle" | "connecting" | "listening" | "transcribing";

export interface VoiceHandlers {
	/** Phase changes for the button (connecting spinner, listening pulse). */
	readonly onPhase: (phase: VoicePhase) => void;
	/** Live input level 0..1, about ten times a second while listening. */
	readonly onLevel?: (level: number) => void;
	/** Final transcript: the caller inserts it into the composer. */
	readonly onFinal: (text: string) => void;
	/** A failure with a localisable reason code; the caller shows the toast. */
	readonly onError: (code: string, reason: string) => void;
}

/** Availability snapshot, fetched once when the composer mounts. */
export function voiceStatus(signal?: AbortSignal): Promise<VoiceStatus> {
	return api<VoiceStatus>(ROOT, { signal });
}

/**
 * The stop function of the recording that is live, so the shell's Escape
 * chain can end it without the feature reaching into component state.
 * `requestVoiceStop` is a no-op when nothing is recording.
 */
let activeStop: (() => Promise<void>) | undefined;

export function setVoiceStopHook(stop: (() => Promise<void>) | undefined): void {
	activeStop = stop;
}

/** Whether a dictation is live, so the shell's Escape chain can end it. */
export function voiceRecording(): boolean {
	return activeStop !== undefined;
}

export function requestVoiceStop(): void {
	void activeStop?.();
}

/**
 * One dictation session: microphone in, transcript out. A failed chunk is
 * retried once and then fails the whole recording, because a gap in the
 * audio is worse than stopping and letting the user start again.
 *
 * Stopping is a single request: the host transcribes the buffered recording
 * and answers with the text, so the button shows `transcribing` until the
 * reply lands. Cancelling answers immediately and discards the recording.
 */
export class VoiceRecorder {
	private readonly handlers: VoiceHandlers;
	private stream: MediaStream | undefined;
	private context: AudioContext | undefined;
	private worklet: AudioWorkletNode | undefined;
	private source: MediaStreamAudioSourceNode | undefined;
	private stopping = false;
	/** A cancel arrived while a start or a transcription was in flight. */
	private cancelled = false;
	/** Chunk uploads still on the wire; `stop` waits for them so the tail is not lost. */
	private readonly pending = new Set<Promise<void>>();

	constructor(handlers: VoiceHandlers) {
		this.handlers = handlers;
	}

	get active(): boolean {
		return this.stream !== undefined;
	}

	/**
	 * Open the microphone first, then the host session.
	 *
	 * The order matters twice over. A refused permission is the most common
	 * failure, and it must not leave a session behind that only the host can
	 * clear — the next click would then answer 409 forever. And the session needs
	 * the context's real `sampleRate` before it can label the WAV it will build,
	 * which is only known once the microphone is open.
	 */
	async start(): Promise<void> {
		// A stop or cancel still on the wire owns the microphone and the host
		// session; a second start would be torn down by its `finally`.
		if (this.active || this.stopping) return;
		this.cancelled = false;
		this.handlers.onPhase("connecting");
		try {
			const sampleRate = await this.openMicrophone();
			if (this.cancelled) {
				await this.teardown();
				return;
			}
			await api(`${ROOT}/start`, { method: "POST", body: JSON.stringify({ sampleRate }) });
			if (this.cancelled) {
				await this.releaseHost();
				await this.teardown();
				return;
			}
			this.handlers.onPhase("listening");
		} catch (error) {
			// Whatever was opened, give it back: a half-open microphone or a host
			// session nobody will ever stop is worse than starting over.
			await this.releaseHost();
			await this.teardown();
			this.handlers.onError(errorCode(error), errorMessage(error));
			this.handlers.onPhase("idle");
		}
	}

	/** Stop and transcribe: the reply carries the text for the composer. */
	async stop(): Promise<void> {
		if (!this.active || this.stopping) return;
		this.stopping = true;
		this.releaseMicrophone();
		this.handlers.onPhase("transcribing");
		try {
			// Every slice recorded has to reach the host before it is asked to
			// transcribe: the last one is the last syllable.
			await Promise.allSettled([...this.pending]);
			const transcript = await api<{ text: string }>(`${ROOT}/stop`, { method: "POST" });
			if (this.cancelled) return;
			if (transcript.text) this.handlers.onFinal(transcript.text);
			else this.handlers.onError("no-speech", "no-speech");
		} catch (error) {
			if (!this.cancelled) this.handlers.onError(errorCode(error), errorMessage(error));
		} finally {
			await this.teardown();
			this.stopping = false;
			this.cancelled = false;
		}
	}

	/**
	 * Discard the recording: nothing is transcribed, nothing is inserted.
	 *
	 * Also the way out of `connecting` and `transcribing`: the microphone may not
	 * be open yet, and a stop already on the wire has its text dropped instead of
	 * landing in the composer.
	 */
	async cancel(): Promise<void> {
		if (this.stopping) {
			// The stop request is in flight; its reply must not be inserted.
			this.cancelled = true;
			return;
		}
		this.cancelled = true;
		if (!this.active) {
			await this.releaseHost();
			await this.teardown();
			return;
		}
		this.stopping = true;
		this.releaseMicrophone();
		try {
			await this.releaseHost();
		} finally {
			await this.teardown();
			this.stopping = false;
			this.cancelled = false;
		}
	}

	/** Drop the host's buffered session; nothing to do when there is none. */
	private async releaseHost(): Promise<void> {
		await api(`${ROOT}/cancel`, { method: "POST" }).catch(() => {
			// The host may already have dropped the session; cancelling is local anyway.
		});
	}

	private releaseMicrophone(): void {
		for (const track of this.stream?.getTracks() ?? []) track.stop();
		this.stream = undefined;
		this.worklet?.port.close();
		this.worklet?.disconnect();
		this.worklet = undefined;
		this.source?.disconnect();
		this.source = undefined;
		if (this.context && this.context.state !== "closed") void this.context.close().catch(() => {});
		this.context = undefined;
	}

	private async openMicrophone(): Promise<number> {
		this.stream = await navigator.mediaDevices.getUserMedia({
			audio: { channelCount: 1, echoCancellation: true, autoGainControl: true, noiseSuppression: true },
		});
		this.context = new AudioContext({ sampleRate: CAPTURE_SAMPLE_RATE });
		await this.context.audioWorklet.addModule(CAPTURE_WORKLET_URL);
		this.source = this.context.createMediaStreamSource(this.stream);
		this.worklet = new AudioWorkletNode(this.context, "capture-processor");
		// The worklet is pulled through a muted gain: processing must run, the
		// microphone must never play back into the speakers.
		const mute = this.context.createGain();
		mute.gain.value = 0;
		this.source.connect(this.worklet);
		this.worklet.connect(mute);
		mute.connect(this.context.destination);
		this.worklet.port.onmessage = (event: MessageEvent<CaptureChunk>) => {
			// The worklet reports its own failures instead of dying silently.
			if (event.data.error) {
				void this.fail("capture-failed", event.data.error);
				return;
			}
			if (typeof event.data.level === "number") this.handlers.onLevel?.(event.data.level);
			if (event.data.data) this.track(this.sendChunk(event.data.data));
		};
		// The context's own rate, not the one asked for: a browser that refuses the
		// request would otherwise have its audio labelled at the wrong rate.
		return this.context.sampleRate;
	}

	/** Keep a chunk upload observable so `stop` can wait for the tail. */
	private track(task: Promise<void>): void {
		this.pending.add(task);
		void task.finally(() => this.pending.delete(task));
	}

	private async sendChunk(data: string): Promise<void> {
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				await api(`${ROOT}/audio`, { method: "POST", body: JSON.stringify({ data }) });
				return;
			} catch (error) {
				if (attempt === 1) {
					await this.fail("chunk-failed", errorMessage(error));
					return;
				}
			}
		}
	}

	/** A service-side failure ends the recording; the user may start again. */
	private async fail(code: string, reason: string): Promise<void> {
		if (this.stopping || !this.active) return;
		this.releaseMicrophone();
		// The host is holding a session that will never be stopped otherwise.
		await this.releaseHost();
		await this.teardown();
		this.handlers.onError(code, reason);
		this.handlers.onPhase("idle");
	}

	/** Release the microphone and the audio graph. */
	private async teardown(): Promise<void> {
		this.releaseMicrophone();
		this.handlers.onPhase("idle");
	}
}

function errorCode(error: unknown): string {
	if (error && typeof error === "object" && "body" in error) {
		const code = (error as { body?: { code?: unknown } }).body?.code;
		if (typeof code === "string") return code;
	}
	// getUserMedia rejection: NotAllowedError is the denied-permission case.
	if (error instanceof DOMException && error.name === "NotAllowedError") return "mic-denied";
	return "failed";
}
