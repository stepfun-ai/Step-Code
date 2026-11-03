/**
 * OS microphone permission, behind `requestMicrophoneAccess` / `openMicrophoneSettings`.
 *
 * Pure over an injected `MicrophoneSystem` so it is tested without Electron; `ipc.ts` passes
 * `systemPreferences`. The page asks before recording because a refused microphone does not
 * always reject `getUserMedia`: a hardened-runtime macOS build without the audio-input
 * entitlement recorded silence and the failure surfaced as a transcription error.
 */

import type { DesktopMicrophoneAccess } from "@step-harness/web/desktop-bridge";

/** Electron's `getMediaAccessStatus` result. */
export type MediaAccessStatus = "not-determined" | "granted" | "denied" | "restricted" | "unknown";

export interface MicrophoneSystem {
	readonly platform: NodeJS.Platform;
	/** `systemPreferences.getMediaAccessStatus("microphone")` (macOS, Windows). */
	status(): MediaAccessStatus;
	/** `systemPreferences.askForMediaAccess("microphone")` (macOS only). */
	ask(): Promise<boolean>;
}

/**
 * The permission to record with, prompting on macOS when it is still undecided.
 *
 * Anything the OS cannot tell (`unknown`, Windows `not-determined`, Linux) is `granted`: the
 * page then calls `getUserMedia`, which reports its own failure. Only a definite refusal stops
 * the recording before it starts.
 */
export async function requestMicrophoneAccess(system: MicrophoneSystem): Promise<DesktopMicrophoneAccess> {
	if (system.platform !== "darwin" && system.platform !== "win32") return "granted";
	const status = system.status();
	if (status === "denied" || status === "restricted") return status;
	if (status === "not-determined" && system.platform === "darwin") return (await system.ask()) ? "granted" : "denied";
	return "granted";
}

/** The OS microphone privacy page, or undefined where there is none. Fixed URLs: the page names nothing. */
export function microphoneSettingsUrl(platform: NodeJS.Platform): string | undefined {
	if (platform === "darwin") return "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
	if (platform === "win32") return "ms-settings:privacy-microphone";
	return undefined;
}
