/**
 * The consent surface of a feedback report.
 *
 * What a report carries is decided by the kernel
 * (`packages/coding-agent/src/step/feedback`): the summary, the log excerpt and
 * the session archive are prepared there, redacted there, and bounded there. A
 * host never assembles its own payload — it only shows the user what was
 * prepared and sends exactly that.
 *
 * Preparing evidence reads and compresses the session file, so it happens once
 * per report: the preview the dialog renders is kept until the user confirms,
 * and the confirmation submits the same prepared evidence rather than rebuilding
 * something the user did not see.
 */

import { randomUUID } from "node:crypto";
import type { FeedbackEvidence } from "@step-harness/coding-agent";
import { formatFeedbackBundleSkipMessage } from "@step-harness/coding-agent";

/** One archived file, with the bound or truncation the kernel applied to it. */
export interface WebFeedbackArchiveFile {
	readonly name: string;
	readonly bytes: number;
	readonly note?: string;
}

/** What the user is told will be sent, in display-safe values only. */
export interface WebFeedbackPreview {
	readonly surface: "web" | "desktop";
	readonly version: string;
	readonly channel: "dev" | "release";
	readonly sessionId?: string;
	/** The content-free session summary (counts, usage, plan/goal/task state). */
	readonly summary: boolean;
	/** The host log excerpt the kernel read from the storage root. */
	readonly diagnostics: boolean;
	readonly archive?: readonly WebFeedbackArchiveFile[];
	/** Why the archive is absent, when the kernel skipped it. */
	readonly archiveNote?: string;
}

export interface WebFeedbackDraft {
	readonly token: string;
	readonly preview: WebFeedbackPreview;
}

/** How long a prepared report stays usable: a dialog left open overnight must not send yesterday's evidence. */
const DRAFT_TTL_MS = 10 * 60 * 1000;

/** A session files one report at a time; a handful of stale drafts is enough. */
const MAX_TRACKED_DRAFTS = 4;

interface TrackedDraft {
	readonly evidence: FeedbackEvidence;
	readonly preview: WebFeedbackPreview;
	readonly at: number;
}

/**
 * Prepared evidence held between the preview and the submission.
 *
 * The token is the contract: the client shows the preview it came with and the
 * server sends the evidence that token names. A submission without one (an older
 * client, a scripted caller) prepares its own evidence, which is the behavior
 * that existed before the preview.
 */
export class FeedbackDrafts {
	private readonly drafts = new Map<string, TrackedDraft>();
	private readonly describe: (evidence: FeedbackEvidence) => WebFeedbackPreview;
	private readonly now: () => number;

	constructor(describe: (evidence: FeedbackEvidence) => WebFeedbackPreview, now: () => number = Date.now) {
		this.describe = describe;
		this.now = now;
	}

	keep(evidence: FeedbackEvidence): WebFeedbackDraft {
		this.prune();
		const token = randomUUID();
		const preview = this.describe(evidence);
		this.drafts.set(token, { evidence, preview, at: this.now() });
		return { token, preview };
	}

	/**
	 * Take the evidence a preview prepared, or `undefined` when the token is
	 * unknown or stale. Taking (not reading) keeps one preview from paying for
	 * two submissions.
	 */
	take(token: string): FeedbackEvidence | undefined {
		const draft = this.drafts.get(token);
		this.drafts.delete(token);
		if (!draft) return undefined;
		if (this.now() - draft.at > DRAFT_TTL_MS) return undefined;
		return draft.evidence;
	}

	/** Forget every prepared report: they belong to one conversation branch. */
	clear(): void {
		this.drafts.clear();
	}

	private prune(): void {
		const now = this.now();
		for (const [token, draft] of this.drafts) {
			if (now - draft.at > DRAFT_TTL_MS) this.drafts.delete(token);
		}
		while (this.drafts.size >= MAX_TRACKED_DRAFTS) {
			const oldest = this.drafts.keys().next();
			if (oldest.done) return;
			this.drafts.delete(oldest.value);
		}
	}
}

/** Describe prepared evidence for the dialog, using the kernel's own wording for what it skipped. */
export function describeFeedbackEvidence(input: {
	evidence: FeedbackEvidence;
	surface: "web" | "desktop";
	version: string;
	channel: "dev" | "release";
}): WebFeedbackPreview {
	const { evidence } = input;
	const bundle = evidence.bundle;
	const archive = bundle?.status === "ready" ? bundle.bundle : undefined;
	return {
		surface: input.surface,
		version: input.version,
		channel: input.channel,
		...(evidence.sessionId ? { sessionId: evidence.sessionId } : {}),
		summary: evidence.summary !== undefined,
		diagnostics: evidence.diagnostics !== undefined,
		...(archive
			? {
					archive: archive.files.map((file) => ({
						name: file.name,
						bytes: file.bytes,
						...(file.note ? { note: file.note } : {}),
					})),
				}
			: {}),
		// No bundle at all means the host resolved no bundle endpoint, so nothing
		// was built: say so, rather than leaving the transcript silently behind.
		...(bundle === undefined
			? { archiveNote: "The session archive is not attached: this build has no bundle endpoint to receive it." }
			: {}),
		// The kernel states why an archive is absent; reusing its wording keeps one
		// explanation instead of two that drift.
		...(bundle?.status === "skipped" ? { archiveNote: formatFeedbackBundleSkipMessage(bundle) } : {}),
	};
}
