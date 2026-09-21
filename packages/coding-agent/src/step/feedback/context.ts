import { normalizeStepDeviceId, normalizeStepUid, normalizeStepWireSessionId } from "../build-identity.ts";
import { readStepDeviceId } from "../device-id.ts";
import { resolveStepCodeVersion } from "../version.ts";
import { readFeedbackBuildEnv } from "./build-env.ts";
import type { FeedbackContext } from "./types.ts";

const MAX_USERNAME_LENGTH = 64;
const PLAUSIBLE_USERNAME = /^[\w.@:-]+$/u;

/** Read the launcher username within the feedback context boundary. */
export function readFeedbackUsername(env: NodeJS.ProcessEnv = process.env, explicit?: string): string | undefined {
	const value = explicit ?? env.STEPCODE_USER;
	if (typeof value !== "string") return undefined;
	const raw = value.trim();
	return raw && raw.length <= MAX_USERNAME_LENGTH && PLAUSIBLE_USERNAME.test(raw) ? raw : undefined;
}

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
	const username = readFeedbackUsername(env, input.username);
	const sessionId = normalizeStepWireSessionId(input.sessionId);
	const uid = normalizeStepUid(input.uid);
	return {
		channel,
		version: resolveStepCodeVersion(env).value,
		platform: process.platform,
		...(commit ? { commit } : {}),
		...(sessionId ? { sessionId } : {}),
		...(deviceId ? { deviceId } : {}),
		...(uid ? { uid } : {}),
		...(username ? { username } : {}),
	};
}
