import { type AppState, getState, type RightPanelId, setState, setUi } from "./store";

/** File entry points remain authoritative when they open the existing preview. */
export function activeRightPanel(state: AppState): RightPanelId | null {
	return state.preview.open ? state.preview.mode : state.ui.rightPanel;
}

/**
 * The turn that actually produced summary content, or null.
 *
 * A task tool call alone is not content: a call that was refused, or one whose
 * result names no task, leaves the board's checklist and agent list empty, and
 * opening the board over the answer for that was pure interruption. Only these
 * reveal it:
 *
 * - a task call whose result names a task (`task_create` / `task_update`),
 * - a subagent call or a background lane that reported per-task results.
 *
 * The board still opens from its rail button and from a Summary entry point, so
 * nothing becomes unreachable; it just stops opening itself.
 */
export function summaryActivityTurn(state: AppState): string | null {
	if (!state.current) return null;
	let activity = false;
	for (let index = state.timelineItems.length - 1; index >= 0; index--) {
		const item = state.timelineItems[index];
		if (item.kind === "message" && item.role === "user") return activity ? item.itemId : null;
		if (item.kind !== "tool") continue;
		// A task call only becomes a checklist row once the result names its subject.
		const created =
			(item.toolName === "task_create" || item.toolName === "task_update") && item.outputSummary.trim().length > 0;
		// Only actual running agents fill the summary. Control calls and settled
		// dispatches stay reachable in the conversation without opening an empty board.
		const laneResults =
			item.toolName !== "agent_send" && Boolean(item.subagentTasks?.some((task) => task.status === "running"));
		if (created || laneResults) activity = true;
	}
	return activity ? "history" : null;
}

export function openRightPanel(panel: RightPanelId | null): void {
	setState((state) => ({
		preview: {
			...state.preview,
			open: panel === "files" || panel === "changes",
			mode: panel === "changes" ? "changes" : panel === "files" ? "files" : state.preview.mode,
		},
		ui: { ...state.ui, rightPanel: panel, rightPanelExpanded: false, rightPanelMenu: false, changesMenu: null },
	}));
}

export function closeRightPanel(): void {
	const panel = activeRightPanel(getState());
	openRightPanel(null);
	if (typeof document !== "undefined" && panel) {
		requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-right-panel="${panel}"]`)?.focus());
	}
}

export function toggleRightPanel(panel: RightPanelId): void {
	if (activeRightPanel(getState()) === panel) closeRightPanel();
	else openRightPanel(panel);
}

export function toggleRightPanelExpanded(): void {
	setUi((ui) => ({ rightPanelExpanded: !ui.rightPanelExpanded }));
}
