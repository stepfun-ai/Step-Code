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

export interface FeedbackContext {
	channel: string;
	version: string;
	platform: string;
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
	feedbackId: string;
	category?: FeedbackCategory;
	comment: string;
	at: string;
	context: FeedbackContext;
	diagnostics?: FeedbackDiagnostics;
}

export interface FeedbackBundle {
	data: Uint8Array;
	files: readonly { name: string; bytes: number; note?: string }[];
	sessionId: string;
	lastActivityAt: Date;
}
