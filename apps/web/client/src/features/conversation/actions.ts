/**
 * Conversation actions that call the host API (legacy app.js 2187-2204, 2315-2343).
 */

import { t } from "../../i18n";
import { ApiError, apiSend, errorMessage } from "../../lib/api";
import { closeRightPanel, openRightPanel } from "../../state/right-panel";
import { forgetApproval, openSession, refreshSessions, renderSnapshot, showError } from "../../state/session";
import { getState, setUi } from "../../state/store";
import type { TurnRevertResult } from "../../state/types";
import type { PromptFile } from "../composer/prompt-editor";

export type ApprovalVerdict = "deny" | "approve" | "approve_for_session";

/**
 * Show `sessionId` and scroll to `entryId` in it (a search hit). The stream
 * scrolls once the entry is rendered; an entry it does not show (a summary, a
 * branch not on the current path) leaves the view at the end.
 */
export async function openSessionAtEntry(sessionId: string, entryId: string | null): Promise<void> {
	setUi({ revealEntry: entryId ? { sessionId, entryId } : null });
	await openSession(sessionId);
}

/**
 * Show a child agent of the current session over its conversation. The
 * session stays selected in the sidebar; the child is only read.
 */
export function openChildAgent(sessionId: string, label: string): void {
	const parentId = getState().current?.id;
	if (parentId) {
		setUi({ childView: { parentId, childId: sessionId, label } });
		openRightPanel("subagent");
	}
}

export function openSubagentTask(toolItemId: string, taskIndex: number): void {
	const parentId = getState().current?.id;
	if (parentId) {
		setUi({ childView: { parentId, childId: null, label: t("subagent"), toolItemId, taskIndex } });
		openRightPanel("subagent");
	}
}

/** Show the agents of workflow run `runId`, the first one selected once the list loads. */
export function openWorkflowAgents(runId: string, label: string): void {
	const parentId = getState().current?.id;
	if (parentId) {
		setUi({ childView: { parentId, childId: null, workflowRun: runId, label } });
		openRightPanel("subagent");
	}
}

export function closeChildAgent(): void {
	const selection = getState().ui.childView;
	closeRightPanel();
	setUi({ childView: null });
	if (selection?.toolItemId && typeof document !== "undefined") {
		requestAnimationFrame(() => {
			if (getState().ui.childView || getState().current?.id !== selection.parentId) return;
			document
				.querySelector<HTMLButtonElement>(
					`.lane-row[data-subagent-tool-id="${CSS.escape(selection.toolItemId ?? "")}"][data-subagent-task-index="${selection.taskIndex}"]`,
				)
				?.focus();
		});
	}
}

/** Branch the current session at `entryId` (or at its end) and follow the fork (legacy `forkAtEntry`). */
export async function forkAtEntry(entryId: string | undefined): Promise<void> {
	const current = getState().current;
	if (!current) return;
	try {
		const result = await apiSend<{ cancelled?: boolean; sessionId: string }>(
			`/api/v1/sessions/${current.id}/fork`,
			"POST",
			{ ...(entryId ? { entryId } : {}) },
		);
		if (result.cancelled) {
			showError(t("forkCancelled"));
			return;
		}
		// The fork binds a new session underneath; follow it.
		await openSession(result.sessionId);
		await refreshSessions();
	} catch (error) {
		showError(errorMessage(error));
	}
}

/**
 * Send an approval verdict for the current session. Resolves true when the
 * server accepted it; errors are reported in the toast (legacy `buildApproval` click handler).
 */
export async function decideApproval(approvalId: string, verdict: ApprovalVerdict): Promise<boolean> {
	try {
		const current = getState().current;
		if (!current) throw new Error("No current session");
		await apiSend(`/api/v1/sessions/${current.id}/approvals/decision`, "POST", { id: approvalId, verdict });
		forgetApproval(approvalId);
		return true;
	} catch (error) {
		showError(errorMessage(error));
		return false;
	}
}

/** The toast for a refused revert (host `TurnRevertError` codes). */
export function revertFailure(error: unknown): string {
	const body = error instanceof ApiError ? error.body : {};
	const path = typeof body.path === "string" ? body.path : "";
	if (body.code === "conflict") return t("turnRevertConflict", { path });
	if (body.code === "modified") return t("turnRevertModified", { path });
	if (body.code === "missing") return t("turnRevertMissing", { path });
	if (body.code === "busy") return t("turnRevertBusy");
	return t("turnRevertFailed", { reason: errorMessage(error) });
}

/**
 * Undo the file changes of the turn that starts at user entry `turnId`. The
 * host refuses (409) when a file changed since; the reason lands in the toast.
 */
export async function revertTurn(turnId: string): Promise<boolean> {
	const current = getState().current;
	if (!current) return false;
	try {
		const result = await apiSend<TurnRevertResult>(
			`/api/v1/sessions/${current.id}/turns/${encodeURIComponent(turnId)}/revert`,
			"POST",
		);
		if (getState().current?.id === current.id) renderSnapshot(result.snapshot, { fromAction: true });
		const count = result.paths.length;
		const skipped = [...new Set(result.skipped.map((change) => change.path))];
		// Files without a recorded diff stay as they are; say so instead of a plain success.
		showError(
			skipped.length
				? t("turnRevertedSkippedToast", { count, paths: skipped.join(", ") })
				: t("turnRevertedToast", { count }),
			false,
		);
		return true;
	} catch (error) {
		showError(revertFailure(error));
		return false;
	}
}

/**
 * Rewrite the latest prompt: fork the session to just before it, then send
 * the edited text — the model answers the reworked prompt on a fresh branch.
 * `before` is the entry the fork ends on (undefined forks from the head).
 */
export async function rewritePrompt(
	before: string | undefined,
	text: string,
	files?: readonly PromptFile[],
): Promise<void> {
	const current = getState().current;
	if (!current || !text.trim()) return;
	try {
		const result = await apiSend<{ sessionId: string }>(`/api/v1/sessions/${current.id}/fork`, "POST", {
			...(before ? { entryId: before } : {}),
		});
		await openSession(result.sessionId);
		const { sendMessage } = await import("../composer/actions");
		await sendMessage(text, files);
	} catch (error) {
		showError(errorMessage(error));
	}
}
