/**
 * Memoizes the lines a component produces, so it can hand back the same array
 * instance until its inputs change.
 *
 * Returning a stable array is what lets a parent Container locate a change inside
 * a child instead of assuming the child changed from its first line
 * (see Container.renderDirtyStart): a long transcript then only re-renders,
 * re-normalizes and re-diffs the part that actually moved.
 *
 * Keyed by a content version that the owning component bumps whenever its inputs
 * change, plus the render width. Components that rebuild their children in
 * updateContent()/updateDisplay() bump it there; anything read from outside the
 * component (a spinner frame, an elapsed clock) belongs in the version too.
 */
export class RenderLineCache {
	private width = -1;
	private version: number | string = -1;
	private lines: string[] | undefined;

	/** True when the stored lines are still valid for this width and content version. */
	matches(width: number, version: number | string): boolean {
		return this.lines !== undefined && this.width === width && this.version === version;
	}

	get(): string[] {
		return this.lines ?? [];
	}

	/** Remember the lines produced for this width and content version. */
	store(width: number, version: number | string, lines: string[]): string[] {
		this.width = width;
		this.version = version;
		this.lines = lines;
		return lines;
	}

	/** Drop the memoized lines; the next render recomputes them. */
	clear(): void {
		this.lines = undefined;
	}
}
