import { normalizeStepDeviceId, normalizeStepUid, normalizeStepWireSessionId } from "../build-identity.ts";
import { readStepDeviceId } from "../device-id.ts";
import { readTelemetryUsername } from "../telemetry-runtime.ts";
import { readStepRuntimeVersion, resolveStepHarnessVersion } from "../version.ts";
import { readFeedbackBuildEnv } from "./build-env.ts";
import type { FeedbackContext } from "./types.ts";

export async function resolveFeedbackContext(input: {
	storageRootDir: string;
	sessionId?: string;
	uid?: string;
	username?: string;
	env?: NodeJS.ProcessEnv;
}): Promise<FeedbackContext> {
	const env = input.env ?? process.env;
	const { channel, commit } = readFeedbackBuildEnv(env);
	const deviceId = normalizeStepDeviceId(await readStepDeviceId(input.storageRootDir));
	const username = readTelemetryUsername(env, input.username);
	const sessionId = normalizeStepWireSessionId(input.sessionId);
	const uid = normalizeStepUid(input.uid);
	const runtimeVersion = readStepRuntimeVersion(env);
	return {
		channel,
		version: runtimeVersion ?? resolveStepHarnessVersion(env).value,
		platform: process.platform,
		...(commit ? { commit } : {}),
		...(sessionId ? { sessionId } : {}),
		...(deviceId ? { deviceId } : {}),
		...(uid ? { uid } : {}),
		...(username ? { username } : {}),
	};
}
