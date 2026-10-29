/**
 * Deterministic work counters for the markdown renderer.
 *
 * Streaming performance is a property of *how much work a frame does*, and wall
 * clock time cannot assert that: a loaded machine can fail a real optimization
 * and pass a regression. Tests therefore read these counters instead, and they
 * count the inputs a frame hands to the expensive stages rather than the time
 * spent in them.
 *
 * This is a diagnostic seam, not telemetry: nothing is reported off-process, and
 * the counters are only meaningful after `resetMarkdownWork()`.
 */
export interface MarkdownWork {
	/** Normalized source units handed to the block lexer. */
	lexUnits: number;
	/** Top-level tokens passed to the token renderer. */
	renderedTokens: number;
	/** Rows measured and wrapped for terminal width. */
	wrappedRows: number;
	/** Frames that re-rendered the whole document. */
	coldFrames: number;
	/** Frames that reused a certified prefix. */
	reusedFrames: number;
}

export const markdownWork: MarkdownWork = {
	lexUnits: 0,
	renderedTokens: 0,
	wrappedRows: 0,
	coldFrames: 0,
	reusedFrames: 0,
};

export function resetMarkdownWork(): void {
	markdownWork.lexUnits = 0;
	markdownWork.renderedTokens = 0;
	markdownWork.wrappedRows = 0;
	markdownWork.coldFrames = 0;
	markdownWork.reusedFrames = 0;
}
