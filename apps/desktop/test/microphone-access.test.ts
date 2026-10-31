import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type MediaAccessStatus,
	type MicrophoneSystem,
	microphoneSettingsUrl,
	requestMicrophoneAccess,
} from "../src/microphone-access.ts";

function system(platform: NodeJS.Platform, status: MediaAccessStatus, answer = true) {
	const asked: number[] = [];
	const value: MicrophoneSystem = {
		platform,
		status: () => status,
		ask: async () => {
			asked.push(1);
			return answer;
		},
	};
	return { value, asked };
}

test("a decided permission is reported without prompting", async () => {
	for (const platform of ["darwin", "win32"] as const) {
		for (const status of ["granted", "denied", "restricted"] as const) {
			const { value, asked } = system(platform, status);
			assert.equal(await requestMicrophoneAccess(value), status, `${platform} ${status}`);
			assert.equal(asked.length, 0);
		}
	}
});

test("macOS prompts once when undecided and reports the answer", async () => {
	const yes = system("darwin", "not-determined", true);
	assert.equal(await requestMicrophoneAccess(yes.value), "granted");
	assert.equal(yes.asked.length, 1);
	// A build without the audio-input entitlement answers false without showing a prompt.
	const no = system("darwin", "not-determined", false);
	assert.equal(await requestMicrophoneAccess(no.value), "denied");
});

test("what the OS cannot tell is left to getUserMedia", async () => {
	for (const [platform, status] of [
		["win32", "not-determined"],
		["win32", "unknown"],
		["darwin", "unknown"],
		["linux", "denied"],
	] as const) {
		const { value, asked } = system(platform, status);
		assert.equal(await requestMicrophoneAccess(value), "granted", `${platform} ${status}`);
		assert.equal(asked.length, 0);
	}
});

test("the settings page is a fixed OS URL, none on Linux", () => {
	assert.equal(
		microphoneSettingsUrl("darwin"),
		"x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
	);
	assert.equal(microphoneSettingsUrl("win32"), "ms-settings:privacy-microphone");
	assert.equal(microphoneSettingsUrl("linux"), undefined);
});
