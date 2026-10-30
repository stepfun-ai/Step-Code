import { installComposerDraftCleanup } from "../../state/composer-drafts";
import type { ContextPackage, StagedPick } from "./actions";

/** Detached live nodes keep in-flight upload callbacks attached to their original chip. */
export interface ComposerDraft {
	readonly id: string;
	readonly parked: HTMLDivElement;
	editor: HTMLDivElement | null;
	sending?: boolean;
	refresh?: () => void;
	contextPackages: readonly ContextPackage[];
	stagedPicks: readonly StagedPick[];
}

const drafts = new Map<string, ComposerDraft>();
installComposerDraftCleanup((id) => {
	const draft = drafts.get(id);
	if (draft) {
		draft.editor?.replaceChildren();
		draft.parked.replaceChildren();
		draft.contextPackages = [];
		draft.stagedPicks = [];
	}
	drafts.delete(id);
});

export function composerDraft(id: string): ComposerDraft {
	let draft = drafts.get(id);
	if (!draft) {
		draft = { id, parked: document.createElement("div"), editor: null, contextPackages: [], stagedPicks: [] };
		drafts.set(id, draft);
	}
	return draft;
}
