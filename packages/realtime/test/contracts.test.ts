import { describe, expect, it } from "vitest";
import type { AudioFrame, RealtimeDriverCapability, Turn, VadEvent } from "../src/index.ts";

// packages/realtime is a pure contract layer (no runtime code), so this smoke test
// pins the contract shapes: representative literals must satisfy the exported types
// (the types themselves are checked by tsgo; this guards the shapes stay usable).
describe("realtime contracts", () => {
	it("models an AudioFrame", () => {
		const frame: AudioFrame = {
			encoding: "pcm16",
			sampleRate: 16000,
			channels: 1,
			data: new Uint8Array([0, 1]),
			timestamp: 0,
		};
		expect(frame.sampleRate).toBe(16000);
		expect(frame.encoding).toBe("pcm16");
	});

	it("models a Turn, a VadEvent, and a driver capability", () => {
		const turn: Turn = { id: "t1", speaker: "user", state: "speaking", startedAt: 0 };
		const vad: VadEvent = { state: "speech", at: 0 };
		const capability: RealtimeDriverCapability = {
			sampleRates: [16000, 24000],
			nativeVad: false,
			echoCancellation: false,
		};
		expect(turn.speaker).toBe("user");
		expect(vad.state).toBe("speech");
		expect(capability.sampleRates).toContain(16000);
	});
});
