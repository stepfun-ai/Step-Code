/**
 * Voice dictation relay: the host side of the composer's microphone button.
 *
 * The browser records the microphone and posts PCM16 chunks here; the relay
 * buffers them for the one active session and, on stop, transcribes the whole
 * recording with StepFun's ASR service and returns the text. The model
 * credential is resolved on the host and never leaves it: the browser talks to
 * this host only, and the status route reports the source and channel, never
 * the key.
 *
 * Design notes:
 * - Single session: the desktop app is single-user, so one dictation at a
 *   time; a second `start` answers 409 rather than stealing the first.
 * - Whole-recording transcription: the ASR service takes one file and returns
 *   the complete text, which is exactly what a composer draft needs. There is
 *   no streaming transcript to relay, so there is no SSE stream either — the
 *   text arrives in the `stop` response.
 * - Credentials: an environment key or the stored `step` login. A custom
 *   provider in `models.json` (an imported model proxy) is deliberately not
 *   accepted: whether such a proxy speaks the ASR service is unknowable from
 *   here, and the button stays hidden instead of failing at the first click.
 */

import { randomUUID } from "node:crypto";
import { getStepAuthPath, readStoredCredential } from "@step-harness/coding-agent";

/** Which StepFun service a voice credential belongs to; reported for guidance. */
export type VoiceChannel = "step_plan" | "platform";

/** Where the key came from; reported to the client, which shows guidance from it. */
export type VoiceKeySource = "environment" | "auth.json";

/** A resolved voice credential. The key stays inside the host process. */
export interface VoiceCredential {
	readonly key: string;
	readonly keySource: VoiceKeySource;
	readonly channel: VoiceChannel;
}

/** Why voice is unavailable; the client turns these into localised guidance. */
export type VoiceUnavailableReason = "no-credential";

/** What `GET /api/v1/voice` reports. No field can carry the key. */
export interface VoiceStatus {
	readonly available: boolean;
	readonly reason?: VoiceUnavailableReason;
	readonly channel?: VoiceChannel;
	readonly keySource?: VoiceKeySource;
}

/** An operation the route layer answers with an HTTP status. */
export class VoiceError extends Error {
	readonly status: number;
	readonly code: string;
	constructor(message: string, status: number, code: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

/** Largest accepted audio chunk (base64-decoded); the client sends 100 ms slices. */
export const MAX_VOICE_CHUNK_BYTES = 512 * 1024;
/** One dictation may not run longer than this; the relay then drops the session. */
export const MAX_VOICE_SESSION_MS = 10 * 60 * 1000;
/** Total audio per session, so a stuck client cannot stream forever. */
export const MAX_VOICE_SESSION_BYTES = 64 * 1024 * 1024;

/**
 * The WAV header carries the capture rate, and only the client knows it: the
 * browser may hand back a context at another rate than the one requested, and a
 * header that disagrees with the samples makes the recogniser hear the wrong
 * thing rather than fail. Values outside this range are not a sample rate any
 * microphone produced, so a bad value falls back instead of corrupting the file.
 */
export const MIN_VOICE_SAMPLE_RATE = 8000;
export const MAX_VOICE_SAMPLE_RATE = 192000;

/**
 * The ASR service: one multipart upload, the complete text back. Verified
 * against the live service on 2026-10-25 (Step Plan login token, 24 kHz mono
 * WAV, ~470 ms for a 3.5 s clip).
 */
const ASR_URL = "https://api.stepfun.com/v1/audio/transcriptions";
const ASR_MODEL = "stepaudio-2.5-asr";
/** The client's capture rate; the WAV header carries it so the service knows. */
const CAPTURE_SAMPLE_RATE = 24000;
const ASR_TIMEOUT_MS = 30_000;

/** Environment override, for pointing at another ASR endpoint without a rebuild. */
const ENV_ASR_URL = "STEP_VOICE_ASR_URL";

/** Credential resolution inputs, overridable so tests never touch the real files. */
export interface VoiceCredentialOptions {
	readonly env?: Record<string, string | undefined>;
	readonly authPath?: string;
	/**
	 * One stored credential entry, as `auth.json` holds it. Defaults to the
	 * coding agent's reader, whose `Credential` shape is this JSON object.
	 */
	readonly readCredential?: (providerId: string, authPath: string) => Record<string, unknown> | undefined;
}

/** The `step` entry of `auth.json` as the relay needs it: secret plus profile. */
interface StepAuthEntry {
	readonly secret: string;
	readonly profile?: string;
	readonly oauth: boolean;
}

/**
 * Read the `step` entry of `auth.json` — the same file `step login` and the
 * web sign-in page write. Only the host ever sees the secret.
 */
function stepAuthEntry(
	authPath: string,
	readCredential: (providerId: string, authPath: string) => Record<string, unknown> | undefined,
): StepAuthEntry | undefined {
	const entry = readCredential("step", authPath);
	if (!entry) return undefined;
	const profile = typeof entry.profile === "string" && entry.profile.trim() ? entry.profile.trim() : undefined;
	if (entry.type === "oauth") {
		const access = typeof entry.access === "string" ? entry.access.trim() : "";
		return access ? { secret: access, profile, oauth: true } : undefined;
	}
	if (entry.type === "api_key") {
		const key = typeof entry.key === "string" ? entry.key.trim() : "";
		return key ? { secret: key, profile, oauth: false } : undefined;
	}
	return undefined;
}

/**
 * Resolve the credential voice dictation uses, in priority order:
 *
 * 1. `STEP_API_KEY` / `STEPFUN_API_KEY` in the environment (a platform key).
 * 2. The stored `step` credential in `auth.json`; its login profile picks the
 *    channel (Step Plan vs the open platform) for the status report.
 *
 * Custom providers from `models.json` are not consulted on purpose — see the
 * module note.
 */
export function resolveVoiceCredential(options: VoiceCredentialOptions = {}): VoiceCredential | undefined {
	const env = options.env ?? process.env;
	const authPath = options.authPath ?? getStepAuthPath(env);
	// The credential reader's `Credential` union is this JSON entry; the cast
	// keeps the option injectable with plain records in tests.
	const readCredential =
		options.readCredential ??
		((providerId: string, path: string) =>
			readStoredCredential(providerId, path) as Record<string, unknown> | undefined);

	const envKey = (env.STEP_API_KEY ?? "").trim() || (env.STEPFUN_API_KEY ?? "").trim();
	if (envKey) {
		return { key: envKey, keySource: "environment", channel: "platform" };
	}
	const stored = stepAuthEntry(authPath, readCredential);
	if (!stored) return undefined;
	// The recorded profile decides the channel for the status report only: the
	// ASR endpoint and model are the same for both.
	if (stored.profile === "step_plan_oversea" || stored.oauth || stored.profile === "step_plan") {
		return { key: stored.secret, keySource: "auth.json", channel: "step_plan" };
	}
	return { key: stored.secret, keySource: "auth.json", channel: "platform" };
}

/** Wrap raw PCM16 mono in a RIFF/WAVE container so the service knows the rate. */
function wrapWav(pcm: Buffer, sampleRate: number): Buffer {
	const header = Buffer.alloc(44);
	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write("WAVE", 8, "ascii");
	header.write("fmt ", 12, "ascii");
	header.writeUInt32LE(16, 16); // fmt chunk size
	header.writeUInt16LE(1, 20); // PCM
	header.writeUInt16LE(1, 22); // mono
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * 2, 28); // byte rate
	header.writeUInt16LE(2, 32); // block align
	header.writeUInt16LE(16, 34); // bits per sample
	header.write("data", 36, "ascii");
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}

/**
 * The client's sample rate, or the capture default when it is absent or not a
 * rate a microphone could have produced. Only used for the WAV header.
 */
function readSampleRate(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return CAPTURE_SAMPLE_RATE;
	const rate = Math.round(value);
	if (rate < MIN_VOICE_SAMPLE_RATE || rate > MAX_VOICE_SAMPLE_RATE) return CAPTURE_SAMPLE_RATE;
	return rate;
}

/** One dictation: buffered chunks, the capture rate, and the clock the limits are checked against. */
interface ActiveVoiceSession {
	readonly id: string;
	readonly startedAt: number;
	/** The client's real `AudioContext.sampleRate`; the WAV header must state it. */
	readonly sampleRate: number;
	readonly chunks: Buffer[];
	bytes: number;
}

/** What `stop` returns: the transcript, empty when nothing was recognised. */
export interface VoiceTranscript {
	readonly text: string;
}

/** The `fetch` subset the relay drives; tests inject a scripted fake. */
export type VoiceFetch = (
	url: string,
	options: {
		method: string;
		headers: Record<string, string>;
		body: FormData;
		signal: AbortSignal;
	},
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface VoiceRelayOptions {
	/** Defaults to {@link resolveVoiceCredential} against this process's environment. */
	readonly resolveCredential?: () => VoiceCredential | undefined;
	/** Defaults to the built-in `fetch`; tests inject a scripted fake. */
	readonly fetch?: VoiceFetch;
	/** Injectable clock for tests. */
	readonly now?: () => number;
	readonly env?: Record<string, string | undefined>;
	/** Overrides for the session limits, so tests need not stream megabytes. */
	readonly maxSessionBytes?: number;
	readonly maxSessionMs?: number;
}

export class VoiceRelay {
	private readonly resolveCredential: () => VoiceCredential | undefined;
	private readonly fetch: VoiceFetch;
	private readonly now: () => number;
	private readonly env: Record<string, string | undefined>;
	private readonly maxSessionBytes: number;
	private readonly maxSessionMs: number;
	private session: ActiveVoiceSession | undefined;

	constructor(options: VoiceRelayOptions = {}) {
		this.resolveCredential =
			options.resolveCredential ??
			(() =>
				resolveVoiceCredential({
					...(options.env ? { env: options.env } : {}),
				}));
		this.fetch = options.fetch ?? ((url, options_) => globalThis.fetch(url, options_));
		this.now = options.now ?? Date.now;
		this.env = options.env ?? process.env;
		this.maxSessionBytes = options.maxSessionBytes ?? MAX_VOICE_SESSION_BYTES;
		this.maxSessionMs = options.maxSessionMs ?? MAX_VOICE_SESSION_MS;
	}

	/** The button's availability snapshot; never carries the key. */
	status(): VoiceStatus {
		const credential = this.resolveCredential();
		if (!credential) return { available: false, reason: "no-credential" };
		return { available: true, channel: credential.channel, keySource: credential.keySource };
	}

	/**
	 * Open the buffering session; 409 when one is already active.
	 *
	 * `sampleRate` is the client's real capture rate. A session left behind by a
	 * client that vanished — a closed tab, a killed process — can never be
	 * cancelled, and the size and duration limits are only consulted when audio
	 * arrives, so nothing else would ever end it. A session past its own duration
	 * limit is therefore treated as gone rather than refusing the next start
	 * forever.
	 */
	start(input: { sampleRate?: unknown } = {}): { sessionId: string } {
		if (this.session && this.now() - this.session.startedAt > this.maxSessionMs) this.session = undefined;
		if (this.session) throw new VoiceError("A voice session is already active", 409, "session-active");
		this.session = {
			id: randomUUID(),
			startedAt: this.now(),
			sampleRate: readSampleRate(input.sampleRate),
			chunks: [],
			bytes: 0,
		};
		return { sessionId: this.session.id };
	}

	/** Buffer one base64 PCM16 chunk for the active session. */
	append(base64: unknown): void {
		const session = this.session;
		if (!session) throw new VoiceError("No active voice session", 404, "no-session");
		if (typeof base64 !== "string" || !base64) throw new VoiceError("Audio data is required", 400, "invalid-audio");
		const bytes = Math.floor((base64.length * 3) / 4);
		if (bytes > MAX_VOICE_CHUNK_BYTES) {
			throw new VoiceError(`Audio chunk exceeds the ${MAX_VOICE_CHUNK_BYTES} byte limit`, 413, "chunk-too-large");
		}
		const elapsed = this.now() - session.startedAt;
		if (elapsed > this.maxSessionMs || session.bytes + bytes > this.maxSessionBytes) {
			this.session = undefined;
			throw new VoiceError("Voice session exceeded its size or duration limit", 413, "session-limit");
		}
		session.bytes += bytes;
		session.chunks.push(Buffer.from(base64, "base64"));
	}

	/**
	 * Transcribe the buffered recording and end the session. An empty result
	 * (nothing recognised) is a valid answer, not an error; the client decides
	 * how to present it.
	 */
	async stop(): Promise<VoiceTranscript> {
		const session = this.session;
		if (!session) throw new VoiceError("No active voice session", 404, "no-session");
		this.session = undefined;
		const credential = this.resolveCredential();
		if (!credential) throw new VoiceError("Voice credential is no longer available", 409, "no-credential");
		const pcm = Buffer.concat(session.chunks);
		if (pcm.length === 0) return { text: "" };
		return this.transcribe(credential, wrapWav(pcm, session.sampleRate));
	}

	/** Discard the session without transcribing (the cancel action). */
	cancel(): void {
		this.session = undefined;
	}

	/** Shutdown hook: drop the buffered session without transcribing. */
	stopAll(): void {
		this.session = undefined;
	}

	private async transcribe(credential: VoiceCredential, wav: Buffer): Promise<VoiceTranscript> {
		const url = (this.env[ENV_ASR_URL] ?? "").trim() || ASR_URL;
		const form = new FormData();
		form.append("model", ASR_MODEL);
		form.append("response_format", "json");
		form.append("file", new Blob([wav], { type: "audio/wav" }), "dictation.wav");
		try {
			const response = await this.fetch(url, {
				method: "POST",
				headers: { Authorization: `Bearer ${credential.key}` },
				body: form,
				signal: AbortSignal.timeout(ASR_TIMEOUT_MS),
			});
			if (!response.ok) {
				throw new VoiceError(`Voice service answered ${response.status}`, 502, "asr-failed");
			}
			const payload = (await response.json()) as { text?: unknown };
			const text = typeof payload?.text === "string" ? payload.text.trim() : "";
			return { text };
		} catch (error) {
			if (error instanceof VoiceError) throw error;
			// A network-level failure (timeout, connection refused) reads as unreachable.
			throw new VoiceError(error instanceof Error ? error.message : String(error), 502, "unreachable");
		}
	}
}
