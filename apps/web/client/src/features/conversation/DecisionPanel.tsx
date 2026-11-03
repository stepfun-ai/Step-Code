/**
 * `.decision-panel`: the one question the page is waiting on.
 *
 * A plan review, a `clarify_user` questionnaire, and a tool approval are the same
 * thing from the user's side: the session is blocked until they answer, so the
 * composer must not accept anything else. They share one slot — the stream's last
 * element, above the composer — instead of scattering between the transcript and
 * separate overlays.
 *
 * At most one is pending in practice: a review ends the turn, an approval blocks
 * the call that asked, and a questionnaire replaces the turn it was issued in.
 * The order below is therefore a tie-break, not a queue.
 */

import { useAppStore } from "../../state/store";
import { ApprovalCard } from "./ApprovalCard";
import { ClarificationPanel } from "./ClarificationPanel";
import { PlanReviewPanel } from "./PlanReviewCard";
import "./decision-panel.css";

export function DecisionPanel() {
	const plan = useAppStore((state) => state.pendingPlanReview !== undefined);
	const clarification = useAppStore((state) => state.current?.pendingClarifications?.[0]);
	const approval = useAppStore((state) => state.current?.pendingApprovals?.[0]);

	return (
		<>
			{plan ? <PlanReviewPanel /> : null}
			{!plan && clarification ? <ClarificationPanel /> : null}
			{!plan && !clarification && approval ? (
				<div className="decision-panel" id="decisionPanel">
					<ApprovalCard approval={approval} />
				</div>
			) : null}
		</>
	);
}
