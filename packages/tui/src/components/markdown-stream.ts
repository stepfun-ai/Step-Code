import type { Token } from "marked";

/**
 * Block-level math opener at the start of a physical line.
 *
 * This is the single definition of "where a block-math token may start": the
 * Marked `start()` hint and the streaming hazard scan both use it, so the two
 * cannot drift apart and silently drop an opener.
 */
const BLOCK_MATH_START = /(?:^|\n) {0,3}(?:\$\$|\\\[)/;

/**
 * Offset of the first block-math opener in `source`, or `undefined`.
 *
 * The substring pre-check keeps ordinary documents off the regex: Marked calls
 * the block extension's `start()` at every paragraph boundary with the whole
 * unconsumed remainder, so running the pattern there unconditionally costs
 * `O(paragraphs x remaining length)` per render.
 */
export function findBlockMathStart(source: string): number | undefined {
	if (!source.includes("$$") && !source.includes("\\[")) {
		return undefined;
	}
	const match = BLOCK_MATH_START.exec(source);
	return match ? match.index + (match[0].startsWith("\n") ? 1 : 0) : undefined;
}

/**
 * Top-level token types whose rendering only depends on the token itself, its
 * immediate neighbour type, and the document-wide no-wrap set. Anything else
 * makes the incremental path bail out instead of guessing.
 */
const LOCAL_TOKEN_TYPES: ReadonlySet<string> = new Set([
	"space",
	"paragraph",
	"text",
	"heading",
	"list",
	"code",
	"table",
	"blockquote",
	"hr",
	"html",
	"latexBlock",
]);

/** Inline `<a ...>` and `<pre|code|kbd|script>` openers keep lexer state alive. */
const INLINE_LINK_OPENER = /<a\s/gi;
const INLINE_LINK_CLOSER = /<\/a>/gi;
const INLINE_RAW_OPENER = /<(?:pre|code|kbd|script)[\s>]/gi;
const INLINE_RAW_CLOSER = /<\/(?:pre|code|kbd|script)>/gi;

/**
 * Facts about the certified prefix that the tail parse depends on but cannot
 * observe from its own source text.
 */
export interface StreamGuard {
	/**
	 * Offset up to which the text has been scanned for block-math openers. Always
	 * a line start, so a scan continuation cannot miss a `^`-anchored match.
	 */
	mathScanEnd: number;
	/** A block-math opener was seen, so no prefix of this document is reusable. */
	blockMath: boolean;
	/** A line-start `[` is still open and could become a reference definition. */
	openReferenceLabel: boolean;
	/** Depth of inline `<a ...>` openers in the certified prefix. */
	openLinkTags: number;
	/** Depth of inline `<pre|code|kbd|script>` openers in the certified prefix. */
	openRawTags: number;
}

export function createStreamGuard(): StreamGuard {
	return {
		mathScanEnd: 0,
		blockMath: false,
		openReferenceLabel: false,
		openLinkTags: 0,
		openRawTags: 0,
	};
}

export function cloneStreamGuard(guard: StreamGuard): StreamGuard {
	return { ...guard };
}

/**
 * Continue the block-math scan over `text`.
 *
 * Only text appended since the previous call is scanned, so the cost stays
 * proportional to the delta even though the decision is document-wide. The scan
 * starts at a physical line start and reuses `findBlockMathStart`, so the hazard
 * decision and the tokenizer hint share one predicate.
 */
export function scanBlockMath(text: string, guard: StreamGuard): void {
	if (guard.blockMath || guard.mathScanEnd >= text.length) {
		return;
	}
	const lineStart = lineStartAt(text, guard.mathScanEnd);
	if (findBlockMathStart(text.slice(lineStart)) !== undefined) {
		// `tokenizeBlockLatex` can turn this into a token that runs to the end of the
		// document, and its `start()` hint re-clips the paragraph in front of it, so
		// blocks certified earlier are no longer final.
		guard.blockMath = true;
		return;
	}
	// Leave the last line unscanned: it has no line ending yet, so the next delta can
	// still complete an opener there.
	const lastNewline = text.lastIndexOf("\n");
	guard.mathScanEnd = lastNewline < 0 ? guard.mathScanEnd : Math.max(guard.mathScanEnd, lastNewline + 1);
}

/**
 * Update the inline-tag depth for the tokens being certified.
 *
 * Marked keeps `inLink`/`inRawBlock` on the lexer for the whole document, so an
 * unbalanced `<a ...>` in the certified prefix changes how the tail is parsed.
 * Fenced code is skipped because its content never reaches the inline tokenizer;
 * inline code spans are deliberately not skipped, which can only make this check
 * more conservative.
 */
export function applyInlineTagDepth(tokens: readonly Token[], guard: StreamGuard): void {
	let link = guard.openLinkTags;
	let raw = guard.openRawTags;
	for (const token of tokens) {
		if (token.type === "code") {
			continue;
		}
		link = applyTagDepth(token.raw, INLINE_LINK_OPENER, INLINE_LINK_CLOSER, link);
		raw = applyTagDepth(token.raw, INLINE_RAW_OPENER, INLINE_RAW_CLOSER, raw);
	}
	guard.openLinkTags = link;
	guard.openRawTags = raw;
}

/**
 * Track a line-start `[` that could still become a reference definition.
 *
 * Marked tries `def` before `paragraph`, and a definition label may span blank
 * lines, so an unclosed label in the certified prefix can reinterpret it later.
 * Escaped brackets and any `]` clear the candidate.
 */
export function scanReferenceLabels(text: string, guard: StreamGuard): void {
	let open = guard.openReferenceLabel;
	let lineStart = 0;
	let backslashes = 0;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (char === "\n") {
			lineStart = index + 1;
			backslashes = 0;
			continue;
		}
		if (char === "\\") {
			backslashes++;
			continue;
		}
		if (char === "]" && backslashes % 2 === 0) {
			open = false;
		} else if (char === "[" && backslashes % 2 === 0 && index - lineStart <= 3 && isBlank(text, lineStart, index)) {
			open = true;
		}
		backslashes = 0;
	}
	guard.openReferenceLabel = open;
}

/** Whether the guard permits certifying a prefix that ends here. */
export function guardIsClean(guard: StreamGuard): boolean {
	return !guard.blockMath && !guard.openReferenceLabel && guard.openLinkTags === 0 && guard.openRawTags === 0;
}

/**
 * Index of the first token that must stay mutable, or `undefined` when no prefix
 * can be certified.
 *
 * A candidate is only accepted directly after a top-level `space` token: Marked
 * folds a single line ending into the previous token, so a `space` token always
 * covers a real blank line and therefore separates two self-contained blocks.
 * The token after it must start a new top-level block instead of continuing the
 * previous one: a paragraph or heading that begins at column 0 once its first
 * physical line has ended. An unfinished first line is rejected because it can
 * still turn into a list item, a setext underline, or a table delimiter, all of
 * which reach back across the blank line. Lists, quotes, tables, fences, and
 * indented code are rejected because they can absorb what follows a blank line
 * and would then rewrite the tokens before the candidate.
 */
export function findCertifiedCut(tokens: readonly Token[]): number | undefined {
	for (let cut = tokens.length - 1; cut >= 2; cut--) {
		if (tokens[cut - 1]?.type !== "space") {
			continue;
		}
		const witness = tokens[cut];
		if (!witness || !isCertifyingWitness(witness, cut + 1 < tokens.length)) {
			continue;
		}
		if (!isLocalPrefix(tokens, cut)) {
			continue;
		}
		return cut;
	}
	return undefined;
}

/**
 * Raw length of `tokens[0..count)`.
 *
 * Callers must have verified that the raws concatenate back to the source slice;
 * Marked drops repeated reference definitions and normalises some trailing
 * whitespace, so the sum is only meaningful when that check passed.
 */
export function rawLengthOf(tokens: readonly Token[], count: number): number {
	let total = 0;
	for (let index = 0; index < count; index++) {
		total += tokens[index]?.raw.length ?? 0;
	}
	return total;
}

/** Whether the token raws reproduce `source` exactly. */
export function rawsCoverSource(tokens: readonly Token[], source: string): boolean {
	let offset = 0;
	for (const token of tokens) {
		const raw = token.raw;
		if (!source.startsWith(raw, offset)) {
			return false;
		}
		offset += raw.length;
	}
	return offset === source.length;
}

function isCertifyingWitness(token: Token, hasFollowingToken: boolean): boolean {
	if (token.type !== "paragraph" && token.type !== "heading") {
		return false;
	}
	const raw = token.raw;
	if (raw.length === 0) {
		return false;
	}
	const first = raw.charCodeAt(0);
	if (first === 32 || first === 9) {
		return false;
	}
	// An incomplete first line can still become a list marker, a setext underline,
	// or a table delimiter, all of which reach back to earlier blocks.
	if (raw.indexOf("\n") > 0) {
		return true;
	}
	// A single-line token has no trailing newline of its own; the line ending is
	// folded into the following `space` token, so anything after it proves the line
	// is closed.
	return hasFollowingToken && !raw.includes("\n");
}

function isLocalPrefix(tokens: readonly Token[], count: number): boolean {
	for (let index = 0; index < count; index++) {
		const token = tokens[index];
		if (!token || !LOCAL_TOKEN_TYPES.has(token.type)) {
			return false;
		}
	}
	return true;
}

function applyTagDepth(text: string, opener: RegExp, closer: RegExp, depth: number): number {
	let next = depth;
	const events: Array<{ index: number; delta: number }> = [];
	opener.lastIndex = 0;
	for (let match = opener.exec(text); match !== null; match = opener.exec(text)) {
		events.push({ index: match.index, delta: 1 });
	}
	closer.lastIndex = 0;
	for (let match = closer.exec(text); match !== null; match = closer.exec(text)) {
		events.push({ index: match.index, delta: -1 });
	}
	events.sort((left, right) => left.index - right.index);
	for (const event of events) {
		next = Math.max(0, next + event.delta);
	}
	return next;
}

function lineStartAt(text: string, offset: number): number {
	const newline = text.lastIndexOf("\n", Math.max(0, offset - 1));
	return newline < 0 ? 0 : newline + 1;
}

function isBlank(text: string, from: number, to: number): boolean {
	for (let index = from; index < to; index++) {
		if (text.charCodeAt(index) !== 32) {
			return false;
		}
	}
	return true;
}
