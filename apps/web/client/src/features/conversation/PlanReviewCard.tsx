/**
 * `.plan-review`: the proposal an `exit_plan_mode` call submitted, shown when
 * the host has no review dialog of its own.
 *
 * Planning is investigation plus a written proposal, and exiting reports that
 * the investigation finished — it never authorizes the work. So the card asks
 * the user, in two ways the kernel already understands:
 *
 * - "request changes" sends the notes through `/plan`, so the revision round is
 *   planned again and produces a new proposal to review (plan mode itself is
 *   already off when this card is shown);
 * - "approve and run" sends a normal message that authorizes implementation.
 *
 * Both are ordinary user messages: the decision lands in the transcript, starts
 * one turn, and needs no special execution channel. The state projection marks
 * only the newest undecided proposal actionable; older cards stay inert (see
 * `settlePlanReviews`).
 */

import { useState } from "react";
import { useT } from "../../i18n";
import type { PlanReview } from "../../state/types";
import { Icon } from "../../ui";
import { sendMessage } from "../composer/actions";

export function PlanReviewCard({ review }: { readonly review: PlanReview }) {
	const t = useT();
	const [expanded, setExpanded] = useState(false);
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

	const actionable = review.pending && !settled;
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
				<button
					type="button"
					className="plan-review-more"
					onClick={() => setExpanded((value) => !value)}
					aria-expanded={expanded}
				>
					{t(expanded ? "planReviewCollapse" : "planReviewExpand")}
					<Icon name="chevron" size="2xs" />
				</button>
			</header>
			<div className="plan-review-body">
				<pre className="plan-review-contents" id={id("planReviewContents", actionable)} hidden={!expanded}>
					{review.planContents}
				</pre>
				{expanded ? null : (
					<p className="plan-review-summary" id={id("planReviewSummary", actionable)}>
						{firstParagraph(review.planContents)}
					</p>
				)}
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
							<button
								type="button"
								className="plan-review-button approve"
								id={id("planApprove", actionable)}
								disabled={busy}
								onClick={() => void send(t("planApproveMessage"))}
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

/** The proposal's opening paragraph, or its first lines when it has none. */
function firstParagraph(contents: string): string {
	const blocks = contents
		.split(/\n\s*\n/u)
		.map((block) => block.replace(/^#+\s*/u, "").trim())
		.filter(Boolean);
	return blocks[0] ?? contents.trim();
}
