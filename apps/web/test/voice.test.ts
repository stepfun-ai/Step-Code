import assert from "node:assert/strict";
import { test } from "node:test";
import {
	MAX_VOICE_CHUNK_BYTES,
	MAX_VOICE_SESSION_BYTES,
	resolveVoiceCredential,
	VoiceError,
	VoiceRelay,
	type VoiceCredential,
	type VoiceFetch,
} from "../src/voice.ts";

const testCredential: VoiceCredential = {
	key: "test-key",
	keySource: "auth.json",
	channel: "step_plan",
};

/** A relay whose resolver always finds `credential`. */
function relayWith(
	factory: VoiceFetch,
	credential: VoiceCredential | undefined = testCredential,
	now?: () => number,
): VoiceRelay {
	return new VoiceRelay({ resolveCredential: () => credential, fetch: factory, now });
}

/** A relay whose resolver finds nothing; `undefined` cannot be the default. */
function relayWithoutCredential(factory: VoiceFetch): VoiceRelay {
	return new VoiceRelay({ resolveCredential: () => undefined, fetch: factory });
}

interface FakeFetch {
	readonly fetch: VoiceFetch;
	readonly calls: { url: string; authorization: string; body: FormData }[];
}

/** Capture the ASR upload and answer with `payload`; `ok:false` fakes a service error. */
function fakeAsr(payload: unknown, ok = true, status = 200): FakeFetch {
	const calls: FakeFetch["calls"] = [];
	const fetch: VoiceFetch = async (url, options) => {
		calls.push({ url, authorization: options.headers.Authorization ?? "", body: options.body });
		return { ok, status, json: async () => payload };
	};
	return { fetch, calls };
}

/** Read the uploaded file back as a Buffer, for WAV header assertions. */
async function uploadedWav(form: FormData): Promise<Buffer> {
	const file = form.get("file");
	assert.ok(file instanceof Blob, "the upload carries a file part");
	return Buffer.from(await file.arrayBuffer());
}

/** Raw PCM16 bytes, base64 (zeros: silence). */
function chunk(length = 4800): string {
	return Buffer.alloc(length).toString("base64");
}

test("credential resolution: no credential anywhere reports unavailable", () => {
	assert.deepEqual(resolveVoiceCredential({ env: {}, readCredential: () => undefined }), undefined);
});

test("credential resolution: an environment key is the platform channel", () => {
	assert.deepEqual(
		resolveVoiceCredential({ env: { STEP_API_KEY: " env-key " }, readCredential: () => undefined }),
		{ key: "env-key", keySource: "environment", channel: "platform" },
	);
});

test("credential resolution: a stored oauth login is the Step Plan channel", () => {
	assert.deepEqual(
		resolveVoiceCredential({
			env: {},
			readCredential: () => ({ type: "oauth", access: " oauth-token ", profile: "step_plan" }),
		}),
		{ key: "oauth-token", keySource: "auth.json", channel: "step_plan" },
	);
});

test("credential resolution: a stored api key without a plan profile is the platform channel", () => {
	assert.deepEqual(
		resolveVoiceCredential({ env: {}, readCredential: () => ({ type: "api_key", key: "stored-key" }) }),
		{ key: "stored-key", keySource: "auth.json", channel: "platform" },
	);
});

test("credential resolution: a custom provider in models.json is deliberately not a voice credential", () => {
	// The button hides instead of failing on the first click, so a model
	// proxy that may not speak ASR must not resolve to a credential.
	assert.deepEqual(
		resolveVoiceCredential({
			env: {},
			readCredential: () => undefined,
			readProviders: () => ({ proxy: { baseUrl: "https://proxy.example/v1", apiKey: "$SOME_KEY" } }),
		}),
		undefined,
	);
});

test("status: unavailable carries the reason, never a key", () => {
	const relay = new VoiceRelay({ resolveCredential: () => undefined, fetch: fakeAsr({}).fetch });
	assert.deepEqual(relay.status(), { available: false, reason: "no-credential" });
});

test("status: available reports channel and source", () => {
	const relay = relayWith(fakeAsr({}).fetch);
	assert.deepEqual(relay.status(), { available: true, channel: "step_plan", keySource: "auth.json" });
});

test("start opens a buffering session; a second start is refused", () => {
	const relay = relayWith(fakeAsr({}).fetch);
	const session = relay.start();
	assert.ok(session.sessionId);
	assert.throws(
		() => relay.start(),
		(error: unknown) => error instanceof VoiceError && error.status === 409,
	);
});

test("append without a session is a 404", () => {
	const relay = relayWith(fakeAsr({}).fetch);
	assert.throws(
		() => relay.append(chunk()),
		(error: unknown) => error instanceof VoiceError && error.code === "no-session",
	);
});

test("append rejects empty data and oversized chunks", () => {
	const relay = relayWith(fakeAsr({}).fetch);
	relay.start();
	assert.throws(
		() => relay.append(""),
		(error: unknown) => error instanceof VoiceError && error.code === "invalid-audio",
	);
	assert.throws(
		() => relay.append(chunk(MAX_VOICE_CHUNK_BYTES + 64)),
		(error: unknown) => error instanceof VoiceError && error.code === "chunk-too-large",
	);
});

test("a session over its size limit is dropped", () => {
	let clock = 0;
	const relay = new VoiceRelay({
		resolveCredential: () => testCredential,
		fetch: fakeAsr({}).fetch,
		now: () => clock,
		maxSessionBytes: 10_000,
	});
	relay.start();
	relay.append(chunk(4800));
	relay.append(chunk(4800));
	assert.throws(
		() => relay.append(chunk(4800)),
		(error: unknown) => error instanceof VoiceError && error.code === "session-limit",
	);
	// The dropped session accepts a fresh start.
	assert.ok(relay.start().sessionId);
});

test("a session over its duration limit is dropped", () => {
	let clock = 0;
	const relay = new VoiceRelay({
		resolveCredential: () => testCredential,
		fetch: fakeAsr({}).fetch,
		now: () => clock,
		maxSessionMs: 1000,
	});
	relay.start();
	clock = 1001;
	assert.throws(
		() => relay.append(chunk()),
		(error: unknown) => error instanceof VoiceError && error.code === "session-limit",
	);
});

test("cancel discards without transcribing", async () => {
	const fake = fakeAsr({ text: "never" });
	const relay = relayWith(fake.fetch);
	relay.start();
	relay.append(chunk());
	relay.cancel();
	assert.equal(fake.calls.length, 0);
	await assert.rejects(
		() => relay.stop(),
		(error: unknown) => error instanceof VoiceError && error.code === "no-session",
	);
});

test("stopAll discards silently (the shutdown hook)", () => {
	const relay = relayWith(fakeAsr({}).fetch);
	relay.start();
	relay.stopAll();
	assert.throws(
		() => relay.append(chunk()),
		(error: unknown) => error instanceof VoiceError && error.code === "no-session",
	);
});

test("stop without a session is a 404", async () => {
	const relay = relayWith(fakeAsr({}).fetch);
	await assert.rejects(
		() => relay.stop(),
		(error: unknown) => error instanceof VoiceError && error.code === "no-session",
	);
});

test("an empty recording transcribes to nothing without calling the service", async () => {
	const fake = fakeAsr({ text: "unused" });
	const relay = relayWith(fake.fetch);
	relay.start();
	assert.deepEqual(await relay.stop(), { text: "" });
	assert.equal(fake.calls.length, 0);
});

test("the recording is uploaded as a WAV and the text comes back", async () => {
	const fake = fakeAsr({ text: "  你好世界  " });
	const relay = relayWith(fake.fetch);
	relay.start();
	relay.append(chunk(4800));
	relay.append(chunk(4800));
	const transcript = await relay.stop();

	assert.deepEqual(transcript, { text: "你好世界" });
	assert.equal(fake.calls.length, 1);
	const call = fake.calls[0];
	assert.equal(call.url, "https://api.stepfun.com/v1/audio/transcriptions");
	assert.equal(call.authorization, "Bearer test-key");
	assert.equal(call.body.get("model"), "stepaudio-2.5-asr");
	assert.equal(call.body.get("response_format"), "json");

	const wav = await uploadedWav(call.body);
	assert.equal(wav.length, 44 + 9600, "the WAV wraps both chunks");
	assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
	assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
	assert.equal(wav.subarray(36, 40).toString("ascii"), "data");
	assert.equal(wav.readUInt16LE(22), 1, "mono");
	assert.equal(wav.readUInt32LE(24), 24000, "24 kHz, the client's capture rate");
	assert.equal(wav.readUInt16LE(34), 16, "PCM16");
	assert.equal(wav.readUInt32LE(40), 9600, "data length");
});

test("a service error fails the stop with asr-failed", async () => {
	const relay = relayWith(fakeAsr({}, false, 500).fetch);
	relay.start();
	relay.append(chunk());
	await assert.rejects(
		() => relay.stop(),
		(error: unknown) => error instanceof VoiceError && error.code === "asr-failed" && error.status === 502,
	);
});

test("a network failure fails the stop with unreachable", async () => {
	const fetch: VoiceFetch = async () => {
		throw new Error("connect ECONNREFUSED");
	};
	const relay = relayWith(fetch);
	relay.start();
	relay.append(chunk());
	await assert.rejects(
		() => relay.stop(),
		(error: unknown) => error instanceof VoiceError && error.code === "unreachable",
	);
});

test("the credential must still resolve when the stop lands", async () => {
	const relay = relayWithoutCredential(fakeAsr({}).fetch);
	relay.start();
	relay.append(chunk());
	await assert.rejects(
		() => relay.stop(),
		(error: unknown) => error instanceof VoiceError && error.code === "no-credential",
	);
});

test("a finished session accepts a fresh start", async () => {
	const relay = relayWith(fakeAsr({ text: "一次" }).fetch);
	relay.start();
	relay.append(chunk());
	await relay.stop();
	relay.start();
	relay.append(chunk());
	assert.deepEqual(await relay.stop(), { text: "一次" });
});

test("the WAV header states the rate the client reported", async () => {
	// The browser may hand back an AudioContext at another rate than the one it
	// was asked for. A header that keeps claiming 24 kHz would make the service
	// hear the wrong pitch rather than fail, so the started session carries it.
	const fake = fakeAsr({ text: "ok" });
	const relay = relayWith(fake.fetch);
	relay.start({ sampleRate: 48000 });
	relay.append(chunk(9600));
	await relay.stop();
	const wav = await uploadedWav(fake.calls[0].body);
	assert.equal(wav.readUInt32LE(24), 48000, "sample rate");
	assert.equal(wav.readUInt32LE(28), 96000, "byte rate follows the sample rate");
});

test("a missing or implausible sample rate falls back to the capture default", async () => {
	for (const sampleRate of [undefined, null, "44100", Number.NaN, 0, -1, 1, 1_000_000]) {
		const fake = fakeAsr({ text: "ok" });
		const relay = relayWith(fake.fetch);
		relay.start({ sampleRate });
		relay.append(chunk());
		await relay.stop();
		const wav = await uploadedWav(fake.calls[0].body);
		assert.equal(wav.readUInt32LE(24), 24000, `rate for ${String(sampleRate)}`);
	}
});

test("a session whose client vanished does not refuse the next start forever", async () => {
	// The duration limit is only consulted when audio arrives, so a client that
	// closed or crashed mid-recording would otherwise hold the relay open for the
	// process's lifetime: every later click answered 409.
	let now = 1_000;
	const relay = relayWith(fakeAsr({ text: "ok" }).fetch, testCredential, () => now);
	relay.start();
	// Nothing arrives: the microphone permission dialog was never answered.
	now += 10 * 60 * 1000 + 1;
	assert.ok(relay.start(), "an expired session must not block a new one");
	assert.equal(relay.status().available, true);
	assert.equal((await relay.stop()).text, "", "the stale session contributed no audio");
});

test("a session inside its window still refuses a second start", () => {
	let now = 1_000;
	const relay = relayWith(fakeAsr({}).fetch, testCredential, () => now);
	relay.start();
	now += 1_000;
	assert.throws(
		() => relay.start(),
		(error: unknown) => error instanceof VoiceError && error.code === "session-active" && error.status === 409,
	);
});
