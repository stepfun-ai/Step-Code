import { type AppState, getState, setState } from "./store";

/** Page-local input ownership; session creation adopts the existing draft identity. */
type InputState = Pick<AppState, "attachments" | "modes">;
const inputs = new Map<string, InputState>();
const sessionDrafts = new Map<string, string>();
const pendingWork = new Map<string, number>();

/** Unsaved inputs cannot be revisited once replaced, unless creation is still adopting them. */
export function releaseUnusedComposerDraft(id: string): void {
	if (
		!id.startsWith("draft:") ||
		getState().composerDraftId === id ||
		pendingWork.has(id) ||
		[...sessionDrafts.values()].includes(id)
	)
		return;
	inputs.delete(id);
	forgetInputContent(id);
}

/** Keep an async operation's input reachable until its callbacks and recovery have settled. */
export function retainComposerDraftWork(id: string): () => void {
	pendingWork.set(id, (pendingWork.get(id) ?? 0) + 1);
	return () => {
		const remaining = (pendingWork.get(id) ?? 1) - 1;
		if (remaining) pendingWork.set(id, remaining);
		else pendingWork.delete(id);
		releaseUnusedComposerDraft(id);
	};
}

export function composerDraftPatch(id: string): Pick<AppState, "composerDraftId"> & InputState {
	const state = getState();
	inputs.set(state.composerDraftId, { attachments: state.attachments, modes: state.modes });
	if (state.composerDraftId !== id) queueMicrotask(() => releaseUnusedComposerDraft(state.composerDraftId));
	return {
		composerDraftId: id,
		...(inputs.get(id) ?? { attachments: [], modes: { goal: false, plan: false, ultraloop: false } }),
	};
}

export function sessionComposerDraft(id: string, adoptId?: string): string {
	const existing = sessionDrafts.get(id);
	if (existing) return existing;
	// An independently opened session already owns its input; no later adoption may replace it.
	// A draft can belong to only one session, even if more than one caller completes creation.
	const draftId = adoptId && ![...sessionDrafts.values()].includes(adoptId) ? adoptId : `session:${id}`;
	sessionDrafts.set(id, draftId);
	return draftId;
}

/** Late image reads and failed sends update only the input that owns them. */
export function updateDraftAttachments(
	id: string,
	update: (attachments: AppState["attachments"]) => AppState["attachments"],
): void {
	if (getState().composerDraftId === id) {
		setState((state) => ({ attachments: update(state.attachments) }));
		return;
	}
	const input = inputs.get(id);
	if (input) inputs.set(id, { ...input, attachments: update(input.attachments) });
}

export function updateDraftModes(id: string, update: (modes: AppState["modes"]) => AppState["modes"]): void {
	if (getState().composerDraftId === id) {
		setState((state) => ({ modes: update(state.modes) }));
		return;
	}
	const input = inputs.get(id);
	if (input) inputs.set(id, { ...input, modes: update(input.modes) });
}

let forgetInputContent: (id: string) => void = () => {};

/** The composer installs DOM cleanup without making state depend on a feature. */
export function installComposerDraftCleanup(forget: (id: string) => void): void {
	forgetInputContent = forget;
}

export function forgetComposerDraft(sessionId: string): string {
	const id = sessionComposerDraft(sessionId);
	inputs.delete(id);
	sessionDrafts.delete(sessionId);
	forgetInputContent(id);
	return id;
}
