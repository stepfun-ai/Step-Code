/**
 * Feedback dialog state and actions (legacy app.js 2107-2185, `state.feedback`).
 *
 * The vote buttons live in the stream and the dialog is a separate slot, so the
 * state is a small feature-local store rather than component state.
 *
 * One submission path for both entries: the vote buttons and `/feedback` open
 * this dialog, the host prepares the evidence, and the dialog names what will be
 * sent before the user confirms.
 */

import { useSyncExternalStore } from "react";
import { t } from "../../i18n";
import { api, apiSend, errorMessage } from "../../lib/api";
import { showError } from "../../state/session";
import { createStore, getState } from "../../state/store";

/** Topic ids, mirroring FEEDBACK_TOPICS on the server. */
export const FEEDBACK_TOPICS = [
	"taskResult",
	"instructionFollowing",
	"productInteraction",
	"stabilitySpeed",
	"resourceCost",
	"safetyPrivacy",
	"other",
] as const;

export type FeedbackTopic = (typeof FEEDBACK_TOPICS)[number];
export type Sentiment = "up" | "down";

/** Labels used when a locale has no `feedbackTopic.*` entry (legacy FEEDBACK_TOPIC_LABELS). */
export const FEEDBACK_TOPIC_LABELS: Readonly<Record<FeedbackTopic, string>> = {
	taskResult: "任务结果",
	instructionFollowing: "指令理解与遵循",
	productInteraction: "产品功能与交互",
	stabilitySpeed: "稳定性和速度",
	resourceCost: "资源使用与费用",
	safetyPrivacy: "安全隐私与权限",
	other: "其他",
};

/** One archived file the host prepared, with the bound or truncation the kernel applied. */
export interface FeedbackPreviewFile {
	readonly name: string;
	readonly bytes: number;
	readonly note?: string;
}

/** What the host says a submission carries, so the dialog can name it before sending. */
export interface FeedbackPreview {
	readonly surface: "web" | "desktop";
	readonly version: string;
	readonly channel: "dev" | "release";
	readonly sessionId?: string;
	/** The content-free session summary (counts, usage, plan/goal/task state). */
	readonly summary: boolean;
	/** The host log excerpt read from the storage root. */
	readonly diagnostics: boolean;
	readonly archive?: readonly FeedbackPreviewFile[];
	/** Why the archive is absent, when the kernel skipped it. */
	readonly archiveNote?: string;
}

/**
 * The evidence the host prepared for this report.
 *
 * The token travels back with the submission, so what leaves the machine is
 * exactly what the dialog named.
 */
export interface FeedbackDraft {
	readonly token: string;
	readonly preview: FeedbackPreview;
}

export interface FeedbackState {
	readonly open: boolean;
	/** Null when the dialog was opened without a vote (`/feedback`): the user picks one there. */
	readonly sentiment: Sentiment | null;
	readonly topic: FeedbackTopic | null;
	readonly comment: string;
	readonly submitting: boolean;
	/** Incremented on every open so the dialog can focus the comment box. */
	readonly openSeq: number;
	/** The prepared report, or null until the host answers. */
	readonly draft: FeedbackDraft | null;
	readonly previewError: string | null;
}

const feedbackStore = createStore<FeedbackState>({
	open: false,
	sentiment: null,
	topic: null,
	comment: "",
	submitting: false,
	openSeq: 0,
	draft: null,
	previewError: null,
});

export function useFeedbackState(): FeedbackState {
	return useSyncExternalStore(feedbackStore.subscribe, feedbackStore.getState, feedbackStore.getState);
}

/**
 * Open the dialog. The vote buttons pass their sentiment; `/feedback` opens it
 * neutral and lets the user choose before submitting, and `/feedback <text>`
 * passes the text, so the product dialog stays the single entry point.
 */
export function openFeedback(sentiment?: Sentiment, comment = ""): void {
	feedbackStore.setState((state) => ({
		open: true,
		sentiment: sentiment ?? null,
		topic: null,
		comment,
		openSeq: state.openSeq + 1,
		draft: null,
		previewError: null,
	}));
	void loadFeedbackPreview();
}

/** Choose a sentiment inside an already-open dialog (`/feedback`). */
export function setFeedbackSentiment(sentiment: Sentiment): void {
	feedbackStore.setState({ sentiment });
}

export function closeFeedback(): void {
	feedbackStore.setState({ open: false });
}

/** Clicking the selected topic clears it. */
export function toggleFeedbackTopic(topic: FeedbackTopic): void {
	feedbackStore.setState((state) => ({ topic: state.topic === topic ? null : topic }));
}

export function setFeedbackComment(comment: string): void {
	feedbackStore.setState({ comment });
}

/** Ask the host what a report about the current session would carry. */
export async function loadFeedbackPreview(): Promise<void> {
	const current = getState().current;
	if (!current) return;
	try {
		const draft = await api<FeedbackDraft>(`/api/v1/sessions/${current.id}/feedback/evidence`);
		// The dialog can close, or the page can switch sessions, while it loads.
		if (feedbackStore.getState().open) feedbackStore.setState({ draft, previewError: null });
	} catch (error) {
		if (feedbackStore.getState().open) feedbackStore.setState({ draft: null, previewError: errorMessage(error) });
	}
}

/** POST the feedback for the current session (legacy `submitFeedback`, 2165-2185). */
export async function submitFeedback(): Promise<void> {
	const current = getState().current;
	const feedback = feedbackStore.getState();
	if (!current || !feedback.sentiment) return;
	feedbackStore.setState({ submitting: true });
	try {
		const result = await apiSend<{ message?: string }>(`/api/v1/sessions/${current.id}/feedback`, "POST", {
			sentiment: feedback.sentiment,
			comment: feedback.comment,
			...(feedback.topic ? { topic: feedback.topic } : {}),
			// The evidence the dialog named. Absent for a caller that never asked for
			// a preview; the host then prepares its own, as it always did.
			...(feedback.draft ? { token: feedback.draft.token } : {}),
		});
		closeFeedback();
		// The neutral tone: a filed report is a confirmation, and the danger
		// toast reads as a failure.
		showError(result.message || t("feedbackSubmitted"), false);
	} catch (error) {
		const message = errorMessage(error);
		// The prepared evidence expired or was cleared (a fork, a `/new`). The
		// dialog closed on the user's behalf only because the report could not be
		// sent as reviewed; offer them a fresh review instead of a dead end.
		if (/expired before sending/i.test(message)) {
			feedbackStore.setState({ submitting: false });
			openFeedback(feedback.sentiment ?? undefined, feedback.comment);
		}
		showError(message);
	} finally {
		feedbackStore.setState({ submitting: false });
	}
}
