/**
 * `.goal-panel`: the goal's lifecycle surface in the right rail — status,
 * progress and the controls (pause / resume / reword / clear). The flow shows
 * the goal's prompt as an ordinary message; this panel is how the run is
 * steered, so goal-state notices no longer need to pop into the flow.
 */

import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { apiSend, errorMessage } from "../../lib/api";
import { useImeGuard } from "../../lib/ime";
import { refreshCurrent, showError } from "../../state/session";
import { useAppStore } from "../../state/store";
import type { GoalState } from "../../state/types";
import { Button, Icon } from "../../ui";

type GoalAction = "pause" | "resume" | "edit" | "clear";

/** Status text for the chip; `active` is the only running state. */
function statusKey(status: GoalState["status"]): string {
	switch (status) {
		case "active":
			return "goalActive";
		case "paused":
			return "goalPaused";
		case "blocked":
			return "goalBlocked";
		case "usage_limited":
			return "goalUsageLimited";
		case "budget_limited":
			return "goalBudgetLimited";
		case "complete":
			return "goalComplete";
	}
}

export function GoalPanel() {
	const t = useT();
	const goal = useAppStore((state) => state.current?.goal);
	const sessionId = useAppStore((state) => state.current?.id);
	const [editing, setEditing] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const editor = useRef<HTMLInputElement | null>(null);
	const ime = useImeGuard();

	// The edit form belongs to one goal; a replaced or cleared goal closes it.
	useEffect(() => {
		if (editing !== null && goal?.id !== editing) setEditing(null);
	}, [editing, goal]);
	useEffect(() => {
		if (editing !== null) editor.current?.focus();
	}, [editing]);

	const send = async (action: GoalAction, objective?: string): Promise<void> => {
		if (!sessionId || busy) return;
		setBusy(true);
		try {
			await apiSend(`/api/v1/sessions/${sessionId}/goal`, "PATCH", {
				action,
				...(objective === undefined ? {} : { objective }),
			});
			if (action === "edit") setEditing(null);
			// The goal is persisted state; re-read it rather than guessing the result.
			await refreshCurrent();
		} catch (error) {
			showError(errorMessage(error));
		} finally {
			setBusy(false);
		}
	};

	const submitEdit = (): void => {
		const text = draft.trim();
		if (text) void send("edit", text);
	};

	if (!goal) return <p className="goal-panel-empty">{t("goalNone")}</p>;
	const active = goal.status === "active";
	return (
		<section className="goal-panel" data-status={goal.status} aria-label={t("rightGoal")}>
			<header className="goal-panel-head">
				<span className="goal-panel-status">{t(statusKey(goal.status))}</span>
				{goal.rounds > 0 ? (
					<span className="goal-panel-rounds">{t("goalRounds", { rounds: goal.rounds })}</span>
				) : null}
			</header>
			{editing !== null ? (
				<div className="goal-panel-edit">
					<input
						ref={editor}
						className="goal-panel-input"
						value={draft}
						aria-label={t("goalEditLabel")}
						onChange={(event) => setDraft(event.target.value)}
						onKeyDown={(event) => {
							if (ime.isComposing(event)) return;
							if (event.key === "Enter") {
								event.preventDefault();
								submitEdit();
							}
							if (event.key === "Escape") {
								event.preventDefault();
								setEditing(null);
							}
						}}
					/>
					<div className="goal-panel-actions">
						<Button variant="primary" onClick={submitEdit} disabled={busy || !draft.trim()}>
							{t("goalSave")}
						</Button>
						<Button onClick={() => setEditing(null)} disabled={busy}>
							{t("goalCancel")}
						</Button>
					</div>
				</div>
			) : (
				<>
					<p className="goal-panel-objective">{goal.objective}</p>
					<p className="goal-panel-stats">
						{t("goalTokens", {
							used: goal.tokensUsed.toLocaleString(),
							budget: goal.tokenBudget === undefined ? t("goalUnbounded") : goal.tokenBudget.toLocaleString(),
						})}
					</p>
					<div className="goal-panel-actions">
						<Button
							onClick={() => void send(active ? "pause" : "resume")}
							disabled={busy || goal.status === "complete"}
						>
							<Icon name={active ? "stop" : "orbit"} size="2xs" />
							{t(active ? "goalPause" : "goalResume")}
						</Button>
						<Button
							onClick={() => {
								setDraft(goal.objective);
								setEditing(goal.id);
							}}
							disabled={busy}
						>
							<Icon name="pencil" size="2xs" />
							{t("goalEdit")}
						</Button>
						<Button onClick={() => void send("clear")} disabled={busy}>
							<Icon name="trash" size="2xs" />
							{t("goalDelete")}
						</Button>
					</div>
				</>
			)}
		</section>
	);
}
