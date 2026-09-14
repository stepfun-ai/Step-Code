import type { AudioFrame } from "@step-harness/realtime";
import { describe, expect, it } from "vitest";
import { createRealtimeVoiceDriver } from "../src/index.ts";

describe("realtime-voice mock driver (S6-2 mock acceptance)", () => {
	it("returns a RealtimeDriver with a capability and working stub methods", async () => {
		const driver = createRealtimeVoiceDriver();
		expect(driver.capability.sampleRates.length).toBeGreaterThan(0);

		const session = await driver.startCapture({ onFrame: () => {} });
		await expect(session.stop()).resolves.toBeUndefined();

		const frame: AudioFrame = { encoding: "pcm16", sampleRate: 16000, channels: 1, data: new Uint8Array(), timestamp: 0 };
		await expect(driver.play(frame)).resolves.toBeUndefined();
		await expect(driver.dispose()).resolves.toBeUndefined();
	});
});
