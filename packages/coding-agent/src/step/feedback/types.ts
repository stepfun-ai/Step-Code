import type { FeedbackRequestProvenance, FeedbackSessionSummary } from "./session-summary.ts";

export const FEEDBACK_CATEGORIES = ["bug", "bad_result", "good_result", "safety_check", "other"] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

export const FEEDBACK_CATEGORY_CLI_SPELLINGS: Readonly<Record<FeedbackCategory, string>> = {
	bug: "bug",
	bad_result: "bad-result",
	good_result: "good-result",
	safety_check: "safety-check",
	other: "other",
};

export const FEEDBACK_CATEGORY_PRESENTATION: Readonly<
	Record<FeedbackCategory, { label: string; description: string }>
> = {
	bug: { label: "bug", description: "Crash, error, hang, or broken behavior." },
	bad_result: { label: "bad result", description: "Incorrect, incomplete, or unhelpful output." },
	good_result: { label: "good result", description: "Helpful or high-quality result worth celebrating." },
	safety_check: { label: "safety check", description: "Benign usage blocked by a safety check." },
	other: { label: "other", description: "Suggestion, slowness, UX, or anything else." },
};

export const FEEDBACK_COMMENT_MAX_RUNES = 4000;
export const FEEDBACK_DIAGNOSTICS_MAX_LINES = 40;
export const FEEDBACK_DIAGNOSTICS_MAX_LINE_CHARS = 512;
export const FEEDBACK_DIAGNOSTICS_MAX_BYTES = 16 * 1024;
export const FEEDBACK_BUNDLE_MAX_BYTES = 8 * 1024 * 1024;
export const FEEDBACK_BUNDLE_CONTENT_TYPE = "application/gzip";

/**
 * How stale the newest session may be before a bare `step feedback` stops
 * guessing. A product decision, not a technical one: people file reports while
 * the thing that annoyed them is still on screen. Outside the window the answer
 * is "no bundle", never "the closest one" — attaching the wrong conversation is
 * a privacy incident, not a degraded report. `--session <id>` skips it.
 */
export const FEEDBACK_SESSION_RECENCY_WINDOW_MS = 10 * 60 * 1000;

/** Which product surface filed the report. A host states it; it is never guessed. */
export type FeedbackSurface = "cli" | "tui" | "web" | "desktop" | "sdk";

/** Bumped when the report shape gains fields a consumer may rely on. Additive only. */
export const FEEDBACK_SCHEMA_VERSION = 2;

/**
 * The runtime that produced the report. A native-module, ESM or packaged-app
 * failure is only diagnosable with these, and they are not derivable from the
 * product version.
 */
export interface FeedbackRuntime {
	/** Node version, also set when Node runs inside Electron (Electron's mode). */
	node?: string;
	/** Present only in the Desktop build. */
	electron?: string;
	/** Present only in a Bun-compiled binary. */
	bun?: string;
}

export interface FeedbackContext {
	channel: string;
	version: string;
	/**
	 * Where `version` came from: `override` (local env), `embedded` (release
	 * pipeline) or `fallback` (a source build with nothing injected). A fallback
	 * version does not identify a release, so triage must know.
	 */
	versionSource?: "override" | "embedded" | "fallback";
	/** ISO timestamp of the artifact, when the pipeline embedded one. */
	buildTime?: string;
	/** The interpreter/host the code ran under. */
	runtime?: FeedbackRuntime;
	platform: string;
	/** `process.arch`, so a native-module or binary report names the real target. */
	arch?: string;
	/** `os.release()`, which `platform` alone does not carry. */
	osRelease?: string;
	locale?: string;
	/** npm, brew, standalone, dmg, nsis — upgrade and path problems start here. */
	installSource?: string;
	commit?: string;
	sessionId?: string;
	deviceId?: string;
	uid?: string;
	username?: string;
}

export type FeedbackIdentity = Pick<FeedbackContext, "uid" | "username">;

export type FeedbackDiagnosticsSource = "stderr_dev_log" | "input_trace";

export interface FeedbackDiagnostics {
	source: FeedbackDiagnosticsSource;
	lines: readonly string[];
	truncated: boolean;
}

export interface FeedbackSubmission {
	/**
	 * Absent on reports written before v2 (a pending body on disk, an older
	 * client). Readers must treat a missing value as v1, never reject it.
	 */
	schemaVersion?: number;
	surface?: FeedbackSurface;
	feedbackId: string;
	category?: FeedbackCategory;
	comment: string;
	at: string;
	context: FeedbackContext;
	diagnostics?: FeedbackDiagnostics;
	/** Content-free session state; see `session-summary.ts`. */
	sessionSummary?: FeedbackSessionSummary;
	/**
	 * The newest model request id, repeated at the top level so a collector can
	 * index it without parsing the summary.
	 */
	request?: FeedbackRequestProvenance;
}

export interface FeedbackBundle {
	data: Uint8Array;
	files: readonly { name: string; bytes: number; note?: string }[];
	sessionId: string;
	lastActivityAt: Date;
}
