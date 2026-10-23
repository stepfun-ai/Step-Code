/**
 * Build identity of a packaged desktop app.
 *
 * `scripts/package.mjs` writes `stepcode-release.json` beside the staged
 * server's package.json. The installer ships it inside `resources/server`, so
 * the kernel's version and feedback code can report the exact artifact without
 * embedding endpoints or release metadata in this repository.
 *
 * A source checkout has no envelope: `launchWebServer` then leaves the
 * inherited environment alone and the kernel keeps its dev/fallback identity.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const RELEASE_ENVELOPE_FILE = "stepcode-release.json";

/** Limits mirror the kernel boundaries in `packages/coding-agent/src/step/`. */
const MAX_VERSION_LENGTH = 64;
const MAX_COMMIT_LENGTH = 40;
const MAX_BUILD_TIME_LENGTH = 40;
const MAX_INSTALL_SOURCE_LENGTH = 32;
const MAX_ENDPOINT_LENGTH = 2048;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const PRODUCT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const INSTALL_SOURCE = /^[a-z0-9._-]{1,32}$/iu;

export interface ReleaseEnvelope {
	readonly version: string;
	readonly channel: "release";
	readonly commit?: string;
	/** ISO timestamp of the packaging run. */
	readonly buildTime?: string;
	/** How this artifact is installed (`dmg`, `nsis`). */
	readonly installSource?: string;
	readonly feedbackEndpoint?: string;
	readonly feedbackBundleEndpoint?: string;
}

/**
 * Environment keys that describe a build. A packaged envelope replaces all of
 * them (including legacy aliases) so a shell exported for a source run cannot
 * mix into a shipped build's report.
 */
const RELEASE_IDENTITY_ENV_KEYS = [
	"STEPCODE_BUILD_VERSION",
	"STEPCODE_VERSION_OVERRIDE",
	"STEPCODE_BUILD_CHANNEL",
	"STEP_HARNESS_BUILD_CHANNEL",
	"STEPCODE_BUILD_COMMIT",
	"STEP_HARNESS_BUILD_COMMIT",
	"STEPCODE_COMMIT",
	"STEP_HARNESS_COMMIT",
	"STEPCODE_BUILD_TIME",
	"STEP_HARNESS_BUILD_TIME",
	"STEPCODE_INSTALL_SOURCE",
	"STEPCODE_DISTRIBUTION",
	"STEPCODE_FEEDBACK_ENDPOINT",
	"STEP_HARNESS_FEEDBACK_ENDPOINT",
	"STEPCODE_FEEDBACK_BUNDLE_ENDPOINT",
	"STEP_HARNESS_FEEDBACK_BUNDLE_ENDPOINT",
] as const;

/**
 * Validate an envelope read from JSON, or a parsed object.
 *
 * The version and `channel: "release"` mark the file as a packaged build;
 * anything else is treated as no envelope. Optional fields that fail their own
 * check are dropped, because a missing commit or endpoint is recoverable while
 * a wrong one would mislabel every report.
 */
export function parseReleaseEnvelope(value: unknown): ReleaseEnvelope | undefined {
	const record = asRecord(value);
	if (record === undefined) return undefined;
	const version = normalizeReleaseVersion(record.version);
	if (version === undefined || record.channel !== "release") return undefined;

	const commit = boundedString(record.commit, MAX_COMMIT_LENGTH);
	const buildTime = normalizeBuildTime(record.buildTime);
	const installSource = normalizeInstallSource(record.installSource);
	const feedbackEndpoint = normalizeEndpoint(record.feedbackEndpoint);
	const feedbackBundleEndpoint = normalizeEndpoint(record.feedbackBundleEndpoint);
	return {
		version,
		channel: "release",
		...(commit === undefined ? {} : { commit }),
		...(buildTime === undefined ? {} : { buildTime }),
		...(installSource === undefined ? {} : { installSource }),
		...(feedbackEndpoint === undefined ? {} : { feedbackEndpoint }),
		...(feedbackBundleEndpoint === undefined ? {} : { feedbackBundleEndpoint }),
	};
}

/**
 * Read the envelope beside a server entry. A missing file is the normal
 * source/dev case; an unreadable or malformed one is logged and ignored so a
 * broken package still starts and simply reports fallback identity.
 */
export function readReleaseEnvelope(
	directory: string,
	warn: (message: string) => void = () => undefined,
): ReleaseEnvelope | undefined {
	const path = join(directory, RELEASE_ENVELOPE_FILE);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (!isMissingFile(error)) warn(`cannot read ${path}: ${errorMessage(error)}`);
		return undefined;
	}
	const envelope = parseReleaseEnvelope(text);
	if (envelope === undefined) warn(`ignoring malformed release envelope ${path}`);
	return envelope;
}

/**
 * Overlay a packaged envelope on the inherited server environment.
 *
 * Envelope values win, and absent optional fields remove inherited values
 * rather than letting a user's exported identity stand in for a release one.
 * Without an envelope the environment is returned unchanged (dev identity).
 */
export function withReleaseIdentity(base: NodeJS.ProcessEnv, envelope: ReleaseEnvelope | undefined): NodeJS.ProcessEnv {
	if (envelope === undefined) return { ...base };
	const environment: NodeJS.ProcessEnv = { ...base };
	for (const key of RELEASE_IDENTITY_ENV_KEYS) delete environment[key];
	environment.STEPCODE_BUILD_VERSION = envelope.version;
	environment.STEPCODE_BUILD_CHANNEL = envelope.channel;
	if (envelope.commit !== undefined) environment.STEPCODE_BUILD_COMMIT = envelope.commit;
	if (envelope.buildTime !== undefined) environment.STEPCODE_BUILD_TIME = envelope.buildTime;
	if (envelope.installSource !== undefined) environment.STEPCODE_INSTALL_SOURCE = envelope.installSource;
	if (envelope.feedbackEndpoint !== undefined) environment.STEPCODE_FEEDBACK_ENDPOINT = envelope.feedbackEndpoint;
	if (envelope.feedbackBundleEndpoint !== undefined) {
		environment.STEPCODE_FEEDBACK_BUNDLE_ENDPOINT = envelope.feedbackBundleEndpoint;
	}
	return environment;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return undefined;
		}
	}
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Same tag normalization as the kernel, so both report one canonical version. */
function normalizeReleaseVersion(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value
		.trim()
		.replace(/^refs\/tags\//iu, "")
		.replace(/^(?:step|pi)-v/iu, "")
		.replace(/^v(?=\d)/iu, "");
	if (
		!normalized ||
		normalized.length > MAX_VERSION_LENGTH ||
		CONTROL_CHARACTERS.test(normalized) ||
		!PRODUCT_VERSION.test(normalized)
	) {
		return undefined;
	}
	return normalized;
}

function normalizeBuildTime(value: unknown): string | undefined {
	const bounded = boundedString(value, MAX_BUILD_TIME_LENGTH);
	if (bounded === undefined || !Number.isFinite(Date.parse(bounded))) return undefined;
	return new Date(bounded).toISOString();
}

function normalizeInstallSource(value: unknown): string | undefined {
	const bounded = boundedString(value, MAX_INSTALL_SOURCE_LENGTH);
	return bounded !== undefined && INSTALL_SOURCE.test(bounded) ? bounded.toLowerCase() : undefined;
}

/** Feedback routes are network endpoints: http(s), host, no embedded credentials. */
function normalizeEndpoint(value: unknown): string | undefined {
	const bounded = boundedString(value, MAX_ENDPOINT_LENGTH);
	if (bounded === undefined) return undefined;
	try {
		const url = new URL(bounded);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		if (url.username || url.password) return undefined;
		return url.toString();
	} catch {
		return undefined;
	}
}

function boundedString(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > maxLength || CONTROL_CHARACTERS.test(trimmed)) return undefined;
	return trimmed;
}

function isMissingFile(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
