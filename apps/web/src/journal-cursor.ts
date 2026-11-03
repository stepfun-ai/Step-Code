/**
 * How far a session's stream has published its branch, so each kernel event can
 * carry only the entries appended since (`WebSession`'s `entries` event).
 *
 * A branch is one root-to-leaf path. When the published leaf is still where it
 * was, everything after it is new. Any other shape (navigating the tree,
 * rewinding, rebinding to another file) is not an extension of what the page
 * holds; the page then re-reads the whole snapshot instead of guessing.
 */
export class JournalCursor {
	private length: number;
	private leafId: string | undefined;

	constructor(branch: readonly { readonly id: string }[]) {
		this.length = branch.length;
		this.leafId = branch.at(-1)?.id;
	}

	/**
	 * Index of the first entry not yet published, `"reset"` when the branch no
	 * longer extends the published one, or undefined when nothing changed. The
	 * cursor moves to the end of `branch` in every case.
	 */
	advance(branch: readonly { readonly id: string }[]): number | "reset" | undefined {
		const leafId = branch.at(-1)?.id;
		if (branch.length === this.length && leafId === this.leafId) return undefined;
		const extended =
			branch.length > this.length && (this.length === 0 || branch[this.length - 1]?.id === this.leafId);
		const start = this.length;
		this.length = branch.length;
		this.leafId = leafId;
		return extended ? start : "reset";
	}
}
