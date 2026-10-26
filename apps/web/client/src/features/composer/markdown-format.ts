/**
 * Pure planning for the composer's Markdown formatting shortcuts: given the
 * prompt's text and selection, work out the marker runs to insert or delete and
 * the selection to restore. Nothing here touches the DOM, so the rules are
 * unit-testable; PromptInput applies the result to the contenteditable.
 *
 * Edits never replace the selected content: a wrap inserts a marker at each
 * boundary and an unwrap deletes the markers, so line breaks, inline chips and
 * the browser's undo stack all survive. A selection that contains a file chip is
 * refused — a chip is one U+FFFC in `promptText` and must never be split.
 */

/** A collapsed or extended selection in the prompt's plain text. */
export interface PromptRange {
	readonly text: string;
	readonly start: number;
	readonly end: number;
}

/** A run of the prompt to remove, or an empty run to insert `text` at `start`. */
export interface PromptEditRun {
	/** Offset in the caller's (pre-edit) text. */
	readonly start: number;
	/** End offset in the pre-edit text; equal to `start` for an insertion. */
	readonly end: number;
	readonly text: string;
}

/** The prompt after a formatting edit: resulting text, selection and the runs that produce it. */
export interface PlannedEdit {
	readonly text: string;
	readonly selectionStart: number;
	readonly selectionEnd: number;
	/** Applied highest-offset first, so an earlier run's offsets stay valid. */
	readonly runs: readonly PromptEditRun[];
}

/** The inline markers the shortcuts toggle; bold first so `**` is never read as two italics. */
export type InlineMarker = "**" | "*" | "`";

/** A file chip's stand-in in `promptText`. */
const CHIP = "\ufffc";

/** What a link's destination shows until the user pastes or types the real one. */
const URL_PLACEHOLDER = "url";
/** What an empty-selection link's label shows, selected so typing replaces it. */
const LABEL_PLACEHOLDER = "text";

function inRange(text: string, start: number, end: number): boolean {
	return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start && end <= text.length;
}

/**
 * Whether the adjacent text ends (or starts) in a run of two or more asterisks,
 * i.e. a bold pair rather than an italic marker.
 */
function boldPair(before: string, after: string): boolean {
	return /\*{2,}$/.test(before) || /^\*{2,}/.test(after);
}

function insert(at: number, text: string): PromptEditRun {
	return { start: at, end: at, text };
}

function remove(start: number, end: number): PromptEditRun {
	return { start, end, text: "" };
}

/**
 * Toggle `marker` around the selection:
 * - the pair is already outside the selection (or inside it, fully selected):
 *   delete it, with the caret where the pair was;
 * - a collapsed caret between an empty pair deletes both;
 * - otherwise insert the pair around the selection, keeping it selected; an
 *   empty selection gets an empty pair with the caret between its halves.
 *
 * A single `*` never touches a bold pair: wrapping beside `**` would produce
 * runs of three or more markers that no shortcut can undo cleanly, so it is a
 * no-op there instead.
 */
export function planInlineFormat(range: PromptRange, marker: InlineMarker): PlannedEdit | null {
	const { text, start, end } = range;
	if (!inRange(text, start, end)) return null;
	const selected = text.slice(start, end);
	if (selected.includes(CHIP)) return null;
	const before = text.slice(0, start);
	const after = text.slice(end);
	const width = marker.length;

	// The pair travels with the selection: `**bold**` selected whole.
	if (
		selected.length >= width * 2 &&
		selected.startsWith(marker) &&
		selected.endsWith(marker) &&
		!(marker === "*" && (selected.startsWith("**") || selected.endsWith("**")))
	) {
		const inner = selected.slice(width, -width);
		return {
			text: before + inner + after,
			selectionStart: start,
			selectionEnd: start + inner.length,
			runs: [remove(start, start + width), remove(end - width, end)],
		};
	}
	// The selection sits between the pair: `**bold**` with `bold` selected, or a bare caret.
	if (before.endsWith(marker) && after.startsWith(marker) && !(marker === "*" && boldPair(before, after))) {
		return {
			text: before.slice(0, -width) + selected + after.slice(width),
			selectionStart: start - width,
			selectionEnd: end - width,
			runs: [remove(start - width, start), remove(end, end + width)],
		};
	}
	// A single marker must not abut another asterisk; see the doc comment above.
	if (
		marker === "*" &&
		(/\*$/.test(before) || /^\*/.test(after) || selected.startsWith("*") || selected.endsWith("*"))
	) {
		return null;
	}
	// Collapsed and between nothing: one empty pair, caret in the middle.
	if (start === end) {
		return {
			text: before + marker + marker + after,
			selectionStart: start + width,
			selectionEnd: start + width,
			runs: [insert(start, marker + marker)],
		};
	}
	return {
		text: before + marker + selected + marker + after,
		selectionStart: start + width,
		selectionEnd: end + width,
		runs: [insert(start, marker), insert(end, marker)],
	};
}

/**
 * Turn the selection into a link by inserting the wrapper at its boundaries, so
 * the label's own line breaks and formatting stay untouched. The label is used
 * verbatim (no escaping), and the destination placeholder is selected so the
 * next paste or keystroke replaces it.
 */
export function planLink(range: PromptRange): PlannedEdit | null {
	const { text, start, end } = range;
	if (!inRange(text, start, end)) return null;
	const selected = text.slice(start, end);
	if (selected.includes(CHIP)) return null;
	const before = text.slice(0, start);
	const after = text.slice(end);
	if (start === end) {
		const source = `[${LABEL_PLACEHOLDER}](${URL_PLACEHOLDER})`;
		const labelStart = start + 1;
		return {
			text: before + source + after,
			selectionStart: labelStart,
			selectionEnd: labelStart + LABEL_PLACEHOLDER.length,
			runs: [insert(start, source)],
		};
	}
	const labelStart = start + 1;
	return {
		text: `${before}[${selected}](${URL_PLACEHOLDER})${after}`,
		selectionStart: labelStart + selected.length + 2,
		selectionEnd: labelStart + selected.length + 2 + URL_PLACEHOLDER.length,
		runs: [insert(start, "["), insert(end, `](${URL_PLACEHOLDER})`)],
	};
}
