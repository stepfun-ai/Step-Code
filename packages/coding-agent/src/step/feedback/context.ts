import { arch, release } from "node:os";
import { normalizeStepDeviceId, normalizeStepUid, normalizeStepWireSessionId } from "../build-identity.ts";
import { readStepDeviceId } from "../device-id.ts";
import { resolveStepCodeVersion } from "../version.ts";
import { readFeedbackBuildEnv } from "./build-env.ts";
import type { FeedbackContext, FeedbackRuntime } from "./types.ts";

const MAX_USERNAME_LENGTH = 64;
const PLAUSIBLE_USERNAME = /^[\w.@:-]+$/u;

/** Read the launcher username within the feedback context boundary. */
export function readFeedbackUsername(env: NodeJS.ProcessEnv = process.env, explicit?: string): string | undefined {
	const value = explicit ?? env.STEPCODE_USER;
	if (typeof value !== "string") return undefined;
	const raw = value.trim();
	return raw && raw.length <= MAX_USERNAME_LENGTH && PLAUSIBLE_USERNAME.test(raw) ? raw : undefined;
}

/**
 * A report names the surface it came from, the exact platform it ran on, and
 * how it was installed. `platform` alone ("darwin") cannot distinguish an
 * Apple Silicon dmg from an Intel npm install, which is the first question for
 * a native-module or upgrade report.
 */
export async function resolveFeedbackContext(input: {
	storageRootDir: string;
	sessionId?: string;
	uid?: string;
	username?: string;
	env?: NodeJS.ProcessEnv;
}): Promise<FeedbackContext> {
	const env = input.env ?? process.env;
	const { channel, commit, buildTime } = readFeedbackBuildEnv(env);
	const version = resolveStepCodeVersion(env);
	const deviceId = normalizeStepDeviceId(await readStepDeviceId(input.storageRootDir));
	const username = readFeedbackUsername(env, input.username);
	const sessionId = normalizeStepWireSessionId(input.sessionId);
	const uid = normalizeStepUid(input.uid);
	const installSource = readInstallSource(env);
	const locale = readLocale(env);
	return {
		channel,
		version: version.value,
		// A fallback version says nothing about which release this is, so a
		// report from a source build is not mistaken for a shipped one.
		versionSource: version.source,
		...(buildTime ? { buildTime } : {}),
		runtime: readRuntimeVersions(),
		platform: process.platform,
		arch: arch(),
		osRelease: release(),
		...(locale ? { locale } : {}),
		...(installSource ? { installSource } : {}),
		...(commit ? { commit } : {}),
		...(sessionId ? { sessionId } : {}),
		...(deviceId ? { deviceId } : {}),
		...(uid ? { uid } : {}),
		...(username ? { username } : {}),
	};
}

/** The interpreter the code is running under; desktop and binary builds differ. */
function readRuntimeVersions(): FeedbackRuntime {
	const node = process.versions.node;
	const electron = process.versions.electron;
	const bun = process.versions.bun;
	return {
		...(plausibleVersion(node) ? { node } : {}),
		...(plausibleVersion(electron) ? { electron } : {}),
		...(plausibleVersion(bun) ? { bun } : {}),
	};
}

/** A version string reaches a report, so bound it like every other context value. */
function plausibleVersion(value: string | undefined): value is string {
	return typeof value === "string" && /^[0-9][\w.+-]{0,31}$/u.test(value);
}

/** Where this binary came from, when the launcher or packaging recorded it. */
function readInstallSource(env: NodeJS.ProcessEnv): string | undefined {
	for (const name of ["STEPCODE_INSTALL_SOURCE", "STEPCODE_DISTRIBUTION"] as const) {
		const value = env[name]?.trim();
		if (value && /^[a-z0-9._-]{1,32}$/iu.test(value)) return value.toLowerCase();
	}
	return undefined;
}

function readLocale(env: NodeJS.ProcessEnv): string | undefined {
	const value = (env.LC_ALL || env.LC_MESSAGES || env.LANG || "").trim();
	const match = /^([a-z]{2,3})[-_]([A-Z]{2})/u.exec(value);
	return match ? `${match[1].toLowerCase()}-${match[2]}` : undefined;
}
