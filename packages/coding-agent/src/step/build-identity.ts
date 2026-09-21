/**
 * Shared build and wire-identity boundaries.
 *
 * Feedback and telemetry are separate domains, but they deliberately carry
 * the same ambient identity. Keep the resolution rules here so an empty
 * primary alias, a legacy alias, or a host-supplied identifier cannot make
 * the two envelopes disagree.
 */

export type StepBuildChannel = "dev" | "release";

export interface StepBuildIdentity {
	readonly channel: StepBuildChannel;
	readonly commit?: string;
}

const MAX_COMMIT_LENGTH = 40;
const MAX_DEVICE_ID_LENGTH = 64;
const MAX_SESSION_ID_LENGTH = 128;
const MAX_UID_LENGTH = 64;
const CONTROL_OR_LINE_SEPARATOR = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const PLAUSIBLE_UID = /^[\w.@:-]+$/u;

// Bun's --env compiler substitutes literal process.env.NAME reads. Keep these
// captures in the shared resolver so both feedback and telemetry retain the
// release identity when the compiled process has no runtime environment.
const INLINED_CLI_BUILD_CHANNEL = process.env.STEPCODE_BUILD_CHANNEL;
const INLINED_LEGACY_BUILD_CHANNEL = process.env.STEP_HARNESS_BUILD_CHANNEL;
const INLINED_CLI_BUILD_COMMIT = process.env.STEPCODE_BUILD_COMMIT;
const INLINED_LEGACY_BUILD_COMMIT = process.env.STEP_HARNESS_BUILD_COMMIT;

/** Resolve the channel and commit using one precedence rule for both domains. */
export function readStepBuildIdentity(env: NodeJS.ProcessEnv = process.env): StepBuildIdentity {
	const useEmbeddedValues = env === process.env;
	const channelValue = firstNonBlank(
		env.STEPCODE_BUILD_CHANNEL,
		env.STEP_HARNESS_BUILD_CHANNEL,
		useEmbeddedValues ? INLINED_CLI_BUILD_CHANNEL : undefined,
		useEmbeddedValues ? INLINED_LEGACY_BUILD_CHANNEL : undefined,
	);
	const commitValue = firstNonBlank(
		env.STEPCODE_BUILD_COMMIT,
		env.STEP_HARNESS_BUILD_COMMIT,
		env.STEPCODE_COMMIT,
		env.STEP_HARNESS_COMMIT,
		useEmbeddedValues ? INLINED_CLI_BUILD_COMMIT : undefined,
		useEmbeddedValues ? INLINED_LEGACY_BUILD_COMMIT : undefined,
	);
	const commit = normalizeStepCommit(commitValue);
	return {
		channel: channelValue === "release" ? "release" : "dev",
		...(commit ? { commit } : {}),
	};
}

/** Keep an opaque commit inside the collector's VARCHAR(40) boundary. */
export function normalizeStepCommit(value: unknown): string | undefined {
	return normalizeBoundedPrintable(value, MAX_COMMIT_LENGTH);
}

/** Keep an opaque install id inside the collector's VARCHAR(64) boundary. */
export function normalizeStepDeviceId(value: unknown): string | undefined {
	return normalizeBoundedPrintable(value, MAX_DEVICE_ID_LENGTH);
}

/**
 * Normalize a session id at the wire boundary.
 *
 * Session ids are also used as local path segments by the session manager, but
 * the legacy wire contract is intentionally wider (for example,
 * `team/agent one`). Do not apply the local filename grammar here; only reject
 * values that are empty, control-bearing, or larger than the server column.
 */
export function normalizeStepWireSessionId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > MAX_SESSION_ID_LENGTH || CONTROL_OR_LINE_SEPARATOR.test(trimmed)) {
		return undefined;
	}
	return trimmed;
}

/** Apply the same callback boundary to UIDs read from credentials or hosts. */
export function normalizeStepUid(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > MAX_UID_LENGTH || !PLAUSIBLE_UID.test(trimmed)) return undefined;
	return trimmed;
}

function firstNonBlank(...values: readonly (string | undefined)[]): string | undefined {
	for (const value of values) {
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (trimmed) return trimmed;
	}
	return undefined;
}

function normalizeBoundedPrintable(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > maxLength || CONTROL_OR_LINE_SEPARATOR.test(trimmed)) return undefined;
	return trimmed;
}
