import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { VoiceRecorder } from "../client/src/features/voice/actions.ts";

/**
 * The browser half of dictation, against a stateful fake of the host relay.
 *
 * The host keeps ONE buffering session and answers 409 while it is open (see
 * `src/voice.ts`). Anything that opens it and never closes it therefore breaks
 * every later recording until the process restarts, which is what these cases
 * guard: the microphone is the part most likely to fail, and it fails before the
 * host is told anything.
 */

const ROOT = "/api/v1/voice";

interface FakeHost {
	readonly calls: string[];
	readonly session: () => boolean;
	/** Chunk uploads wait for this promise, so a test can hold one in flight. */
	readonly holdChunks: (hold: Promise<void> | undefined) => void;
	restore(): void;
}

function fakeHost(): FakeHost {
	let active = false;
	let held: Promise<void> | undefined;
	const calls: string[] = [];
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		calls.push(`${method} ${url}`);
		const respond = (status: number, body: unknown) =>
			new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
		if (url === ROOT && method === "GET") return respond(200, { available: true, channel: "platform", keySource: "environment" });
		if (url === `${ROOT}/start`) {
			if (active) return respond(409, { error: "A voice session is already active", code: "session-active" });
			active = true;
			return respond(200, { sessionId: "s1" });
		}
		if (url === `${ROOT}/audio`) {
			await held;
			return respond(202, { ok: true });
		}
		if (url === `${ROOT}/cancel`) {
			active = false;
			return respond(200, { ok: true });
		}
		if (url === `${ROOT}/stop`) {
			active = false;
			return respond(200, { text: "hello" });
		}
		return respond(404, { error: "unknown" });
	}) as typeof fetch;
	return {
		calls,
		session: () => active,
		holdChunks: (hold) => {
			held = hold;
		},
		restore: () => {
			globalThis.fetch = original;
		},
	};
}

/** A stand-in for the browser's audio stack; only what `openMicrophone` touches. */
interface FakeMicrophone {
	allow(): void;
	deny(name?: string): void;
	/** Chunk size the worklet would emit; here a test pushes them by hand. */
	readonly contexts: number;
	restore(): void;
}

function fakeMicrophone(): FakeMicrophone {
	let allowed = false;
	let denial = "NotAllowedError";
	let contexts = 0;
	const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
	const originalAudioContext = (globalThis as { AudioContext?: unknown }).AudioContext;

	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: {
			mediaDevices: {
				getUserMedia: async () => {
					if (!allowed) throw new DOMException("Permission denied", denial);
					return { getTracks: () => [{ stop() {} }] } as unknown as MediaStream;
				},
			},
		},
	});
	// The real graph is not under test; `sampleRate` is what the host needs.
	class FakeAudioContext {
		static readonly requested: number[] = [];
		readonly sampleRate = 48000;
		readonly state = "running";
		readonly destination = {};
		readonly audioWorklet = { addModule: async () => {} };
		constructor(options?: { sampleRate?: number }) {
			contexts += 1;
			FakeAudioContext.requested.push(options?.sampleRate ?? 0);
		}
		createMediaStreamSource() {
			return { connect() {}, disconnect() {} };
		}
		createGain() {
			return { gain: { value: 1 }, connect() {}, disconnect() {} };
		}
		close() {
			return Promise.resolve();
		}
	}
	Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: FakeAudioContext });
	Object.defineProperty(globalThis, "AudioWorkletNode", {
		configurable: true,
		value: class {
			readonly port = { onmessage: null, close() {} };
			connect() {}
			disconnect() {}
		},
	});
	return {
		allow: () => {
			allowed = true;
		},
		deny: (name) => {
			allowed = false;
			denial = name ?? "NotAllowedError";
		},
		get contexts() {
			return contexts;
		},
		restore: () => {
			if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
			Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: originalAudioContext });
		},
	};
}

function recorder(): {
	errors: string[];
	phases: string[];
	final: string[];
	recorder: VoiceRecorder;
} {
	const errors: string[] = [];
	const phases: string[] = [];
	const final: string[] = [];
	return {
		errors,
		phases,
		final,
		recorder: new VoiceRecorder({
			onPhase: (phase) => phases.push(phase),
			onFinal: (text) => final.push(text),
			onError: (code) => errors.push(code),
		}),
	};
}

let cleanup: (() => void)[] = [];
afterEach(() => {
	for (const fn of cleanup) fn();
	cleanup = [];
});

test("a refused microphone leaves no host session behind, so the next click works", async () => {
	const host = fakeHost();
	const mic = fakeMicrophone();
	cleanup.push(() => host.restore(), () => mic.restore());
	mic.deny();
	const { errors, recorder: voice } = recorder();

	await voice.start();
	assert.deepEqual(errors, ["mic-denied"]);
	assert.equal(host.session(), false, "the host is still holding a session nobody will stop");

	// The user grants permission and clicks again: this must work.
	mic.allow();
	await voice.start();
	assert.equal(voice.active, true);
	assert.deepEqual(errors, ["mic-denied"], "the retry reported a stale failure");
	assert.equal(
		host.calls.filter((call) => call === `POST ${ROOT}/start`).length,
		1,
		"the host session opens once, after the microphone is ready",
	);
});

test("the host is told the context's real sample rate, not the requested one", async () => {
	const host = fakeHost();
	const mic = fakeMicrophone();
	cleanup.push(() => host.restore(), () => mic.restore());
	mic.allow();
	const bodies: string[] = [];
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		if (String(input) === `${ROOT}/start` && init?.body) bodies.push(String(init.body));
		return original(input as RequestInfo, init);
	}) as typeof fetch;
	cleanup.push(() => {
		globalThis.fetch = original;
	});
	const { recorder: voice } = recorder();

	await voice.start();
	assert.equal(bodies.length, 1);
	// The fake context reports 48 kHz while 24 kHz was requested: a browser that
	// refuses the request would otherwise have its audio labelled at the wrong rate.
	assert.deepEqual(JSON.parse(bodies[0]!), { sampleRate: 48000 });
	await voice.cancel();
});

test("stopping waits for the audio still on the wire before transcribing", async () => {
	const host = fakeHost();
	const mic = fakeMicrophone();
	cleanup.push(() => host.restore(), () => mic.restore());
	mic.allow();
	const { recorder: voice } = recorder();
	await voice.start();

	// One chunk upload is held; a stop that does not wait would be ordered before
	// it, and the host would transcribe a recording missing its last slice.
	let release: () => void = () => {};
	host.holdChunks(
		new Promise<void>((resolve) => {
			release = resolve;
		}),
	);
	// Push a chunk through the same path the worklet uses.
	const node = (voice as unknown as { worklet: { port: { onmessage: ((event: MessageEvent) => void) | null } } }).worklet;
	node.port.onmessage?.({ data: { data: "AAAA", level: 0.2 } } as MessageEvent);

	const stopping = voice.stop();
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(
		host.calls.includes(`POST ${ROOT}/stop`),
		false,
		"the transcription was requested before the last chunk arrived",
	);
	release();
	await stopping;
	const audioIndex = host.calls.indexOf(`POST ${ROOT}/audio`);
	const stopIndex = host.calls.indexOf(`POST ${ROOT}/stop`);
	assert.ok(audioIndex !== -1 && stopIndex > audioIndex, host.calls.join(", "));
});

/** A Desktop bridge exposing only the microphone permission; the recorder touches nothing else. */
function desktopMicrophone(access: () => Promise<string>): () => void {
	const original = Object.getOwnPropertyDescriptor(globalThis, "window");
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: { stepcodeDesktop: { platform: "darwin", requestMicrophoneAccess: access } },
	});
	return () => {
		if (original) Object.defineProperty(globalThis, "window", original);
		else delete (globalThis as { window?: unknown }).window;
	};
}

test("a Desktop microphone the OS refuses stops before recording silence", async () => {
	for (const [access, code] of [
		["denied", "mic-denied"],
		["restricted", "mic-restricted"],
	] as const) {
		const host = fakeHost();
		const mic = fakeMicrophone();
		// getUserMedia would succeed: macOS hands a refused app silent audio instead of rejecting.
		mic.allow();
		cleanup.push(
			() => host.restore(),
			() => mic.restore(),
			desktopMicrophone(async () => access),
		);
		const { errors, recorder: voice } = recorder();
		await voice.start();
		assert.deepEqual(errors, [code]);
		assert.equal(voice.active, false);
		assert.equal(mic.contexts, 0, "the microphone was opened anyway");
		assert.equal(host.calls.includes(`POST ${ROOT}/start`), false);
		for (const fn of cleanup) fn();
		cleanup = [];
	}
});

test("a granted or unanswerable Desktop permission records normally", async () => {
	for (const access of [async () => "granted", () => Promise.reject(new Error("no handler"))]) {
		const host = fakeHost();
		const mic = fakeMicrophone();
		mic.allow();
		cleanup.push(
			() => host.restore(),
			() => mic.restore(),
			desktopMicrophone(access),
		);
		const { errors, recorder: voice } = recorder();
		await voice.start();
		assert.deepEqual(errors, []);
		assert.equal(voice.active, true);
		await voice.cancel();
		for (const fn of cleanup) fn();
		cleanup = [];
	}
});

test("cancelling while the transcript is in flight drops the text", async () => {
	const host = fakeHost();
	const mic = fakeMicrophone();
	cleanup.push(() => host.restore(), () => mic.restore());
	mic.allow();
	const { final, recorder: voice } = recorder();
	await voice.start();

	const stopping = voice.stop();
	// The ✕/Escape during "transcribing" must not let the reply land afterwards.
	await voice.cancel();
	await stopping;
	assert.deepEqual(final, [], "a cancelled dictation inserted its text anyway");
	assert.equal(host.session(), false);
});
