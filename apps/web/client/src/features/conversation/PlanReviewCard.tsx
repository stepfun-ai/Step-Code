/**
 * `.plan-review`: the proposal an `exit_plan_mode` call submitted, shown when
 * the host has no review dialog of its own.
 *
 * The proposal is a submission, not an approval: plan mode stays on until the
 * user answers, so the model cannot authorize itself and an ordinary question
 * does not count as consent. The card asks with the two verbs the kernel owns:
 *
 * - "request changes" sends the notes through `/plan`, which keeps planning and
 *   produces a new proposal to review;
 * - "approve and run" sends `/plan approve`, which leaves plan mode and starts
 *   the implementation turn as one decision.
 *
 * Both are ordinary user messages: the decision lands in the transcript, starts
 * one turn, and needs no special execution channel. The state projection marks
 * only the newest undecided proposal actionable; older cards stay inert (see
 * `settlePlanReviews`).
 */

import { useState } from "react";
import { useT } from "../../i18n";
import { useAppStore } from "../../state/store";
import type { PlanReview } from "../../state/types";
import { Icon } from "../../ui";
import { leavePlanMode, sendMessage } from "../composer/actions";
import { openFile } from "../files/actions";

export function PlanReviewCard({ review }: { readonly review: PlanReview }) {
	const t = useT();
	const [notes, setNotes] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [settled, setSettled] = useState(false);

	const send = async (text: string): Promise<void> => {
		if (busy || !text.trim()) return;
		setBusy(true);
		try {
			// One decision per card: the proposal it answered is no longer current.
			if (await sendMessage(text)) setSettled(true);
		} finally {
			setBusy(false);
		}
	};

	// `review.pending` is already decided against the session's one waiting
	// snapshot (see `settlePlanReviews`), and it names a single card: a resubmitted
	// proposal can carry byte-identical text, so comparing hashes here would make
	// every earlier round with the same text actionable too. Both places that draw
	// the card agree because they read the same projection.
	const actionable = review.pending && !settled;
	// The plan file lives inside the session's workspace, so the preview can read
	// it by its workspace-relative path.
	const previewCwd = useAppStore((state) => state.current?.cwd ?? "");
	// A transcript keeps the cards of earlier rounds as their record. The ids stay
	// on the one card that can be answered, so they name a single element.
	const id = (name: string, show: boolean): string | undefined => (show ? name : undefined);

	return (
		<section className="plan-review" id={id("planReviewCard", actionable)}>
			<header className="plan-review-heading">
				<span className="plan-review-dot" aria-hidden="true" />
				<span className="plan-review-heading-title">
					{t(actionable ? "planReviewPending" : "planReviewSettled")}
				</span>
				{/* The proposal is a Markdown file that outlives the round, so reading it
				 * in full belongs in the file preview rather than in a card that has to
				 * scroll inside the conversation. */}
				<button
					type="button"
					className="plan-review-more"
					id={id("planReviewOpen", actionable)}
					onClick={() => void openFile(previewCwd, review.planFilePath, true)}
				>
					{t("planReviewOpen")}
					<Icon name="chevron" size="2xs" />
				</button>
			</header>
			<div className="plan-review-body">
				<p className="plan-review-summary" id={id("planReviewSummary", actionable)}>
					{firstParagraph(review.planContents)}
				</p>
			</div>
			{actionable ? (
				<footer className="plan-review-actions">
					{notes === null ? (
						<>
							<button
								type="button"
								className="plan-review-button"
								id={id("planRequestChanges", actionable)}
								disabled={busy}
								onClick={() => setNotes("")}
							>
								<Icon name="pencil" size="xs" />
								{t("planRequestChanges")}
							</button>
							{/* Leaving without running is the third answer, applied now: a
							 * queued one would arrive after the turn it meant to interrupt. */}
							<button
								type="button"
								className="plan-review-button"
								id={id("planExit", actionable)}
								disabled={busy}
								onClick={() => void leavePlanMode()}
							>
								{t("planExit")}
							</button>
							<button
								type="button"
								className="plan-review-button approve"
								id={id("planApprove", actionable)}
								disabled={busy}
								onClick={() => void send("/plan approve")}
							>
								{t("planApprove")}
							</button>
						</>
					) : (
						<div className="plan-review-notes">
							<textarea
								id={id("planReviewNotes", actionable)}
								className="plan-review-textarea"
								value={notes}
								placeholder={t("planChangePlaceholder")}
								aria-label={t("planChangePlaceholder")}
								onChange={(event) => setNotes(event.target.value)}
								rows={3}
							/>
							<div className="plan-review-note-actions">
								<button type="button" className="plan-review-button" onClick={() => setNotes(null)}>
									{t("goalCancel")}
								</button>
								<button
									type="button"
									className="plan-review-button approve"
									id={id("planSendChanges", actionable)}
									disabled={busy || !notes.trim()}
									onClick={() => void send(`/plan ${t("planChangePrefix")}\n\n${notes.trim()}`)}
								>
									{t("planSendChanges")}
								</button>
							</div>
						</div>
					)}
				</footer>
			) : null}
		</section>
	);
}

/**
 * The proposal the page is waiting on, as the stream's last element.
 *
 * Same card as the transcript record, in the place the questionnaire uses: the
 * decision is the one thing the page is blocked on, so it sits where the user is
 * looking rather than scrolling back to the tool row that produced it.
 */
export function PlanReviewPanel() {
	const review = useAppStore((state) => state.pendingPlanReview);
	return (
		<section className="plan-review-panel" hidden={!review}>
			{review ? <PlanReviewCard review={review} /> : null}
		</section>
	);
}

/** The proposal's opening paragraph, or its first lines when it has none. */
function firstParagraph(contents: string): string {
	const blocks = contents
		.split(/\n\s*\n/u)
		.map((block) => block.replace(/^#+\s*/u, "").trim())
		.filter(Boolean);
	return blocks[0] ?? contents.trim();
}
