import { Marked, type Token, Tokenizer, type TokenizerExtension, type Tokens, type TokensList } from "marked";
import { renderLatex } from "../latex.ts";
import { getCapabilities, hyperlink, isImageLine } from "../terminal-image.ts";
import type { Component } from "../tui.ts";
import { applyBackgroundToLine, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils.ts";
import {
	applyInlineTagDepth,
	cloneStreamGuard,
	createStreamGuard,
	findBlockMathStart,
	findCertifiedCut,
	guardIsClean,
	rawLengthOf,
	rawsCoverSource,
	type StreamGuard,
	scanBlockMath,
	scanReferenceLabels,
} from "./markdown-stream.ts";
import { markdownWork } from "./markdown-work.ts";

const STRICT_STRIKETHROUGH_REGEX = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

class StrictStrikethroughTokenizer extends Tokenizer {
	override del(src: string): Tokens.Del | undefined {
		const match = STRICT_STRIKETHROUGH_REGEX.exec(src);
		if (!match) {
			return undefined;
		}

		const text = match[2];
		return {
			type: "del",
			raw: match[0],
			text,
			tokens: this.lexer.inlineTokens(text),
		};
	}
}

interface LatexToken extends Tokens.Generic {
	type: "latex" | "latexBlock";
	text: string;
	pending?: boolean;
}

function isEscaped(source: string, index: number): boolean {
	let backslashes = 0;
	for (let position = index - 1; position >= 0 && source[position] === "\\"; position--) {
		backslashes++;
	}
	return backslashes % 2 === 1;
}

function findClosingDelimiter(source: string, closing: string, start: number): number {
	let index = source.indexOf(closing, start);
	while (index >= 0 && isEscaped(source, index)) {
		index = source.indexOf(closing, index + closing.length);
	}
	return index;
}

function looksLikePendingDollarMath(source: string): boolean {
	return /\\[A-Za-z]+|[_^=+*/<>()[\]|±≤≥≠≈∈→⇒∞∫∑√-]/.test(source);
}

function tokenizeInlineLatex(source: string): LatexToken | undefined {
	let opening = "";
	let closing = "";
	if (source.startsWith("$$")) {
		opening = "$$";
		closing = "$$";
	} else if (source.startsWith("\\(")) {
		opening = "\\(";
		closing = "\\)";
	} else if (source.startsWith("\\[")) {
		opening = "\\[";
		closing = "\\]";
	} else if (source.startsWith("$") && !/^\$\s/.test(source)) {
		opening = "$";
		closing = "$";
	} else {
		return undefined;
	}

	const closingIndex = findClosingDelimiter(source, closing, opening.length);
	if (
		closingIndex >= 0 &&
		opening === "$" &&
		(/\s$/.test(source.slice(opening.length, closingIndex)) ||
			/^\d/.test(source.slice(closingIndex + 1)) ||
			(/^[A-Z_][A-Z0-9_]*(?:[^A-Za-z0-9_\s])?$/.test(source.slice(opening.length, closingIndex)) &&
				/^[A-Za-z_][A-Za-z0-9_]*/.test(source.slice(closingIndex + 1))) ||
			source.slice(opening.length, closingIndex).includes("`"))
	) {
		return undefined;
	}

	if (closingIndex < 0) {
		const pendingSource = source.slice(opening.length);
		if (opening.startsWith("\\") || looksLikePendingDollarMath(pendingSource)) {
			return { type: "latex", raw: source, text: pendingSource, pending: true };
		}
		return undefined;
	}

	const text = source.slice(opening.length, closingIndex);
	if (!text || text.includes("\n")) {
		return undefined;
	}

	const raw = source.slice(0, closingIndex + closing.length);
	return { type: "latex", raw, text };
}

function tokenizeBlockLatex(source: string): LatexToken | undefined {
	const dollarMatch = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*?)\$\$[ \t]*(?:\n|$)/.exec(source);
	if (dollarMatch?.[1]) {
		return { type: "latexBlock", raw: dollarMatch[0], text: dollarMatch[1].trim() };
	}

	const bracketMatch = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*?)\\\][ \t]*(?:\n|$)/.exec(source);
	if (bracketMatch?.[1]) {
		return { type: "latexBlock", raw: bracketMatch[0], text: bracketMatch[1].trim() };
	}

	const pendingBracket = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*)$/.exec(source);
	if (pendingBracket) {
		return { type: "latexBlock", raw: pendingBracket[0], text: pendingBracket[1], pending: true };
	}
	const pendingDollar = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*)$/.exec(source);
	if (pendingDollar?.[1] && looksLikePendingDollarMath(pendingDollar[1])) {
		return { type: "latexBlock", raw: pendingDollar[0], text: pendingDollar[1], pending: true };
	}
	return undefined;
}

const LATEX_MARKDOWN_EXTENSIONS: readonly TokenizerExtension[] = [
	{
		name: "latexBlock",
		level: "block",
		start(source) {
			// Marked calls this at every paragraph boundary with the unconsumed
			// remainder, so the shared predicate short-circuits before the pattern.
			return findBlockMathStart(source);
		},
		tokenizer: tokenizeBlockLatex,
	},
	{
		name: "latex",
		level: "inline",
		start(source) {
			const indices = [source.indexOf("$"), source.indexOf("\\("), source.indexOf("\\[")].filter(
				(index) => index >= 0,
			);
			return indices.length > 0 ? Math.min(...indices) : undefined;
		},
		tokenizer: tokenizeInlineLatex,
	},
];

function trimPartialClosingFences(tokens: readonly Token[]): void {
	const token = tokens[tokens.length - 1];
	if (token?.type === "list") {
		trimPartialClosingFences(token.items[token.items.length - 1]?.tokens ?? []);
		return;
	}
	if (token?.type === "blockquote") {
		trimPartialClosingFences(token.tokens ?? []);
		return;
	}
	if (token?.type !== "code") {
		return;
	}

	// Trim streamed partial closing fences so code blocks do not shrink/flicker
	// when the final fence character arrives. See https://github.com/earendil-works/pi/issues/5825.
	const marker = /^(`{3,}|~{3,})/.exec(token.raw)?.[1];
	const lastLine = token.raw.split("\n").pop();
	if (!marker || !lastLine || lastLine.length >= marker.length || lastLine !== marker[0]?.repeat(lastLine.length)) {
		return;
	}

	token.text = token.text.slice(0, -lastLine.length).replace(/\n$/, "");
}

const markdownParser = new Marked();
markdownParser.setOptions({
	tokenizer: new StrictStrikethroughTokenizer(),
});
markdownParser.use({ extensions: [...LATEX_MARKDOWN_EXTENSIONS] });

/**
 * Default text styling for markdown content.
 * Applied to all text unless overridden by markdown formatting.
 */
export interface DefaultTextStyle {
	/** Foreground color function */
	color?: (text: string) => string;
	/** Background color function */
	bgColor?: (text: string) => string;
	/** Bold text */
	bold?: boolean;
	/** Italic text */
	italic?: boolean;
	/** Strikethrough text */
	strikethrough?: boolean;
	/** Underline text */
	underline?: boolean;
}

/**
 * Theme functions for markdown elements.
 * Each function takes text and returns styled text with ANSI codes.
 */
export interface MarkdownTheme {
	heading: (text: string) => string;
	/** Dimmed `#` markers preceding heading text (falls back to heading style) */
	headingPrefix?: (text: string) => string;
	link: (text: string) => string;
	linkUrl: (text: string) => string;
	code: (text: string) => string;
	codeBlock: (text: string) => string;
	codeBlockBorder: (text: string) => string;
	quote: (text: string) => string;
	quoteBorder: (text: string) => string;
	hr: (text: string) => string;
	listBullet: (text: string) => string;
	/** Table header cell text (falls back to bold) */
	tableHeader?: (text: string) => string;
	bold: (text: string) => string;
	italic: (text: string) => string;
	strikethrough: (text: string) => string;
	underline: (text: string) => string;
	highlightCode?: (code: string, lang?: string) => string[];
	/** Prefix applied to each rendered code block line (default: "  ") */
	codeBlockIndent?: string;
}

export interface MarkdownOptions {
	/** Preserve source list markers instead of normalizing them. */
	preserveOrderedListMarkers?: boolean;
	/** Preserve source backslash escapes instead of normalizing escaped punctuation. */
	preserveBackslashEscapes?: boolean;
	/** Transform source Markdown before parsing, with the exact width available for content. */
	transform?: (markdown: string, availableWidth: number) => string;
	/** Render supported LaTeX math expressions as Unicode text (default: true). */
	renderLatex?: boolean;
}

interface InlineStyleContext {
	applyText: (text: string) => string;
	stylePrefix: string;
}

export class Markdown implements Component {
	private text: string;
	private paddingX: number; // Left/right padding
	private paddingY: number; // Top/bottom padding
	private defaultTextStyle?: DefaultTextStyle;
	private theme: MarkdownTheme;
	private options: MarkdownOptions;
	private defaultStylePrefix?: string;

	// Cache for rendered output
	private cachedText?: string;

	/**
	 * Lines emitted by fenced code blocks during the current render pass.
	 * Code is never soft-wrapped — an over-wide line is hard-clipped instead
	 * so indentation and structure survive copying (Codex TUI behavior).
	 */
	private nowrapLines = new Set<string>();
	private cachedWidth?: number;
	private cachedLines?: string[];

	/** Length of the certified source prefix; 0 when nothing may be reused. */
	private stableSourceEnd = 0;
	/** Padded output rows of the certified prefix. */
	private stablePaddedLines: string[] = [];
	/**
	 * Pre-wrap row text of prose rows in the certified prefix that were softly
	 * wrapped. A code row that arrives later with the same text would clip them.
	 */
	private stableWrappedProseRows = new Set<string>();
	/** Pre-wrap row text of fenced-code rows in the certified prefix. */
	private stableNoWrap = new Set<string>();
	/** Content width of the previous frame. */
	private layoutWidth = 0;
	/** Normalized source of the previous frame, for append detection. */
	private previousSource = "";
	/** First output row that may differ from the previous frame. */
	renderDirtyStart?: number;
	/** Facts the certified prefix leaves behind for the tail parse. */
	private guard: StreamGuard = createStreamGuard();

	constructor(
		text: string,
		paddingX: number,
		paddingY: number,
		theme: MarkdownTheme,
		defaultTextStyle?: DefaultTextStyle,
		options?: MarkdownOptions,
	) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.theme = theme;
		this.defaultTextStyle = defaultTextStyle;
		this.options = options ? { ...options } : {};
	}

	setText(text: string): void {
		this.text = text;
		// Only the outer cache is stale here: a caller that appends to a streamed
		// reply still has a valid prefix, and `render` decides whether to reuse it.
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	invalidate(): void {
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		// Theme, width, and option changes make previously rendered rows wrong, not
		// just stale, so the certified prefix cannot survive an invalidate.
		this.resetStream();
	}

	render(width: number): string[] {
		// Check cache
		if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
			return this.cachedLines;
		}

		// Calculate available width for content (subtract horizontal padding)
		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const text = this.options.transform?.(this.text, contentWidth) ?? this.text;

		// Don't render anything if there's no actual text
		if (!text || text.trim() === "") {
			const result: string[] = [];
			this.resetStream();
			// Update cache
			this.cachedText = this.text;
			this.cachedWidth = width;
			this.cachedLines = result;
			return result;
		}

		// Replace tabs with 3 spaces for consistent rendering
		const normalizedText = text.includes("\t") ? text.replace(/\t/g, "   ") : text;
		const contentLines = this.renderContent(normalizedText, contentWidth, width);

		// Add top/bottom padding (empty lines)
		const emptyLine = " ".repeat(width);
		const bgFn = this.defaultTextStyle?.bgColor;
		const emptyLines: string[] = [];
		for (let i = 0; i < this.paddingY; i++) {
			const line = bgFn ? applyBackgroundToLine(emptyLine, width, bgFn) : emptyLine;
			emptyLines.push(line);
		}

		// Combine top padding, content, and bottom padding
		const result = emptyLines.concat(contentLines, emptyLines);

		// Update cache
		this.cachedText = this.text;
		this.cachedWidth = width;
		this.cachedLines = result;

		return result.length > 0 ? result : [""];
	}

	/**
	 * Render the document, reusing the certified prefix when it is still valid.
	 *
	 * A streamed reply appends to the same document on every delta. Re-lexing and
	 * re-laying out everything that already ended makes the total cost quadratic in
	 * the message length, so the renderer keeps the rows of certified blocks and
	 * only re-renders the mutable tail. Certification is deliberately narrow: see
	 * `findCertifiedCut` for the exact conditions, and `renderFrom` for the cases
	 * that force a full re-render.
	 */
	private renderContent(normalizedText: string, contentWidth: number, width: number): string[] {
		const appendOnly =
			this.previousSource.length > 0 &&
			normalizedText.length >= this.previousSource.length &&
			normalizedText.startsWith(this.previousSource);
		if (!appendOnly || this.layoutWidth !== contentWidth) {
			this.resetStream();
		}
		this.previousSource = normalizedText;
		this.layoutWidth = contentWidth;

		if (!this.guard.blockMath) {
			scanBlockMath(normalizedText, this.guard);
		}
		if (this.guard.blockMath) {
			// A pending block-math token can re-clip the paragraph in front of it, so a
			// document that has one never reuses a prefix. The guard survives: it keeps
			// the hazard sticky and stops the scan from re-reading the document.
			this.dropPrefix();
			return this.renderFrom(normalizedText, contentWidth, width, 0, false);
		}

		return this.renderFrom(normalizedText, contentWidth, width, this.stableSourceEnd, true);
	}

	/**
	 * Render `normalizedText[base..]` and certify a new prefix out of it.
	 *
	 * `certifiable` is false when the document as a whole cannot be split (an
	 * uncertified parse, a reference definition, ...); the frame is then rendered
	 * whole and nothing is retained.
	 */
	private renderFrom(
		normalizedText: string,
		contentWidth: number,
		width: number,
		base: number,
		certifiable: boolean,
	): string[] {
		const tail = base === 0 ? normalizedText : normalizedText.slice(base);
		const tokens = this.parse(tail);

		if (tokens.links && Object.keys(tokens.links).length > 0) {
			// A definition is visible to every block, so nothing may be retained.
			if (base > 0) {
				this.resetStream();
				this.previousSource = normalizedText;
				return this.renderFrom(normalizedText, contentWidth, width, 0, false);
			}
			certifiable = false;
		}

		trimPartialClosingFences(tokens);

		// Code rows of the certified prefix still decide how identical rows elsewhere
		// are laid out, so the no-wrap set has to carry over.
		this.nowrapLines.clear();
		for (const row of this.stableNoWrap) {
			this.nowrapLines.add(row);
		}

		const rows = new Array<string[]>(tokens.length);
		const wrapped = new Array<string[]>(tokens.length);
		for (let index = 0; index < tokens.length; index++) {
			const token = tokens[index];
			rows[index] = this.renderToken(token, contentWidth, tokens[index + 1]?.type);
			markdownWork.renderedTokens++;
		}
		for (let index = 0; index < rows.length; index++) {
			wrapped[index] = this.wrapRows(rows[index], contentWidth);
		}

		if (base > 0 && this.collidesWithStableRows(tokens, rows)) {
			// A code row that arrived after a prose row was certified changes how that
			// prose row is laid out, so the retained rows are wrong. Re-rendering this
			// frame re-lays everything out with the complete no-wrap set.
			this.resetStream();
			this.previousSource = normalizedText;
			return this.renderFrom(normalizedText, contentWidth, width, 0, true);
		}

		if (base === 0) {
			markdownWork.coldFrames++;
		} else {
			markdownWork.reusedFrames++;
		}

		let cut: number | undefined = certifiable ? findCertifiedCut(tokens) : undefined;
		let nextGuard: StreamGuard | undefined;
		if (cut !== undefined) {
			const chunkSource = tail.slice(0, rawLengthOf(tokens, cut));
			if (!rawsCoverSource(tokens.slice(0, cut), chunkSource)) {
				cut = undefined;
			} else {
				const candidate = cloneStreamGuard(this.guard);
				scanReferenceLabels(chunkSource, candidate);
				applyInlineTagDepth(tokens.slice(0, cut), candidate);
				if (!guardIsClean(candidate)) {
					cut = undefined;
				} else {
					nextGuard = candidate;
				}
			}
		}

		const dirtyStart = this.stablePaddedLines.length;
		let firstTailToken = 0;
		if (cut !== undefined && nextGuard !== undefined) {
			for (let index = 0; index < cut; index++) {
				for (const row of rows[index]) {
					if (tokens[index].type === "code") {
						this.stableNoWrap.add(row);
					} else if (!this.nowrapLines.has(row)) {
						// Only a row that was softly wrapped can be changed by a code row
						// that arrives later; a clipped row stays clipped because the
						// no-wrap set only grows.
						this.stableWrappedProseRows.add(row);
					}
				}
				for (const line of this.padRows(wrapped[index], width)) {
					this.stablePaddedLines.push(line);
				}
			}
			this.stableSourceEnd += rawLengthOf(tokens, cut);
			this.guard = nextGuard;
			firstTailToken = cut;
		}

		const lines = this.stablePaddedLines.slice();
		for (let index = firstTailToken; index < tokens.length; index++) {
			for (const line of this.padRows(wrapped[index], width)) {
				lines.push(line);
			}
		}
		// A whole-document render keeps no comparable prefix: the top and bottom
		// padding rows are identical empty rows, but a changed style can still repaint
		// them, so nothing above the content may be reused.
		this.renderDirtyStart = base === 0 ? 0 : this.paddingY + dirtyStart;
		return lines;
	}

	/** Drop the certified prefix and everything derived from it. */
	private resetStream(): void {
		this.layoutWidth = 0;
		this.dropPrefix();
		this.guard = createStreamGuard();
	}

	private dropPrefix(): void {
		this.stableSourceEnd = 0;
		this.stablePaddedLines = [];
		this.stableWrappedProseRows.clear();
		this.stableNoWrap.clear();
	}

	private parse(source: string): TokensList {
		markdownWork.lexUnits += source.length;
		return markdownParser.lexer(source);
	}

	/**
	 * Whether a fenced-code row added by this frame is identical to a prose row
	 * that was already laid out.
	 *
	 * Code rows are never soft-wrapped, and the rule is applied by row text rather
	 * than by origin, so such a collision silently changes rows that are already
	 * on screen. Re-rendering the document is the only correct answer.
	 */
	private collidesWithStableRows(tokens: readonly Token[], rows: readonly string[][]): boolean {
		if (this.stableWrappedProseRows.size === 0) {
			return false;
		}
		for (let index = 0; index < tokens.length; index++) {
			if (tokens[index].type !== "code") {
				continue;
			}
			for (const row of rows[index]) {
				if (this.stableWrappedProseRows.has(row)) {
					return true;
				}
			}
		}
		return false;
	}

	/**
	 * Wrap rows for terminal width. Code-block rows skip soft wrapping and are
	 * clipped instead, keeping code copyable.
	 */
	private wrapRows(rows: readonly string[], contentWidth: number): string[] {
		const wrapped: string[] = [];
		for (const row of rows) {
			if (isImageLine(row)) {
				wrapped.push(row);
			} else if (this.nowrapLines.has(row)) {
				wrapped.push(visibleWidth(row) > contentWidth ? truncateToWidth(row, contentWidth, "", false) : row);
			} else {
				for (const wrappedRow of wrapTextWithAnsi(row, contentWidth)) {
					wrapped.push(wrappedRow);
				}
			}
		}
		markdownWork.wrappedRows += wrapped.length;
		return wrapped;
	}

	/** Add margins, background, and trailing padding to each rendered row. */
	private padRows(rows: readonly string[], width: number): string[] {
		const leftMargin = " ".repeat(this.paddingX);
		const rightMargin = " ".repeat(this.paddingX);
		const bgFn = this.defaultTextStyle?.bgColor;
		const padded: string[] = [];
		for (const row of rows) {
			if (isImageLine(row)) {
				padded.push(row);
				continue;
			}
			const lineWithMargins = leftMargin + row + rightMargin;
			if (bgFn) {
				padded.push(applyBackgroundToLine(lineWithMargins, width, bgFn));
			} else {
				const visibleLen = visibleWidth(lineWithMargins);
				padded.push(lineWithMargins + " ".repeat(Math.max(0, width - visibleLen)));
			}
		}
		return padded;
	}

	/**
	 * Apply default text style to a string.
	 * This is the base styling applied to all text content.
	 * NOTE: Background color is NOT applied here - it's applied at the padding stage
	 * to ensure it extends to the full line width.
	 */
	private applyDefaultStyle(text: string): string {
		if (!this.defaultTextStyle) {
			return text;
		}

		let styled = text;

		// Apply foreground color (NOT background - that's applied at padding stage)
		if (this.defaultTextStyle.color) {
			styled = this.defaultTextStyle.color(styled);
		}

		// Apply text decorations using this.theme
		if (this.defaultTextStyle.bold) {
			styled = this.theme.bold(styled);
		}
		if (this.defaultTextStyle.italic) {
			styled = this.theme.italic(styled);
		}
		if (this.defaultTextStyle.strikethrough) {
			styled = this.theme.strikethrough(styled);
		}
		if (this.defaultTextStyle.underline) {
			styled = this.theme.underline(styled);
		}

		return styled;
	}

	private getDefaultStylePrefix(): string {
		if (!this.defaultTextStyle) {
			return "";
		}

		if (this.defaultStylePrefix !== undefined) {
			return this.defaultStylePrefix;
		}

		const sentinel = "\u0000";
		let styled = sentinel;

		if (this.defaultTextStyle.color) {
			styled = this.defaultTextStyle.color(styled);
		}

		if (this.defaultTextStyle.bold) {
			styled = this.theme.bold(styled);
		}
		if (this.defaultTextStyle.italic) {
			styled = this.theme.italic(styled);
		}
		if (this.defaultTextStyle.strikethrough) {
			styled = this.theme.strikethrough(styled);
		}
		if (this.defaultTextStyle.underline) {
			styled = this.theme.underline(styled);
		}

		const sentinelIndex = styled.indexOf(sentinel);
		this.defaultStylePrefix = sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
		return this.defaultStylePrefix;
	}

	private getStylePrefix(styleFn: (text: string) => string): string {
		const sentinel = "\u0000";
		const styled = styleFn(sentinel);
		const sentinelIndex = styled.indexOf(sentinel);
		return sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
	}

	private getDefaultInlineStyleContext(): InlineStyleContext {
		return {
			applyText: (text: string) => this.applyDefaultStyle(text),
			stylePrefix: this.getDefaultStylePrefix(),
		};
	}

	private renderToken(
		token: Token,
		width: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
	): string[] {
		const lines: string[] = [];

		switch (token.type) {
			case "heading": {
				const headingLevel = token.depth;
				const headingPrefix = `${"#".repeat(headingLevel)} `;

				// Build a heading-specific style context so inline tokens (codespan, bold, etc.)
				// restore heading styling after their own ANSI resets instead of falling back to
				// the default text style.
				let headingStyleFn: (text: string) => string;
				if (headingLevel === 1) {
					headingStyleFn = (text: string) => this.theme.heading(this.theme.bold(this.theme.underline(text)));
				} else {
					headingStyleFn = (text: string) => this.theme.heading(this.theme.bold(text));
				}

				const headingStyleContext: InlineStyleContext = {
					applyText: headingStyleFn,
					stylePrefix: this.getStylePrefix(headingStyleFn),
				};

				const headingText = this.renderInlineTokens(token.tokens || [], headingStyleContext);
				// All levels keep the literal `#` markers, dimmed via headingPrefix so
				// the colored text (not the syntax) carries the hierarchy signal.
				const styledHeading =
					(this.theme.headingPrefix?.(headingPrefix) ?? headingStyleFn(headingPrefix)) + headingText;
				lines.push(styledHeading);
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after headings (unless space token follows)
				}
				break;
			}

			case "paragraph": {
				const paragraphText = this.renderInlineTokens(token.tokens || [], styleContext);
				lines.push(paragraphText);
				// Don't add spacing if next token is space or list
				if (nextTokenType && nextTokenType !== "list" && nextTokenType !== "space") {
					lines.push("");
				}
				break;
			}

			case "text":
				lines.push(this.renderInlineTokens([token], styleContext));
				break;

			case "latexBlock": {
				const latexToken = token as LatexToken;
				const rendered =
					!latexToken.pending && this.options.renderLatex !== false
						? (renderLatex(latexToken.text, { display: true }) ?? latexToken.raw.trim())
						: latexToken.raw.trim();
				for (const line of rendered.split("\n")) {
					lines.push(this.applyDefaultStyle(line));
				}
				if (nextTokenType && nextTokenType !== "space") {
					lines.push("");
				}
				break;
			}

			case "code": {
				const indent = this.theme.codeBlockIndent ?? "  ";
				lines.push(this.theme.codeBlockBorder(`\`\`\`${token.lang || ""}`));
				if (this.theme.highlightCode) {
					const highlightedLines = this.theme.highlightCode(token.text, token.lang);
					for (const hlLine of highlightedLines) {
						const row = `${indent}${hlLine}`;
						this.nowrapLines.add(row);
						lines.push(row);
					}
				} else {
					// Split code by newlines and style each line
					const codeLines = token.text.split("\n");
					for (const codeLine of codeLines) {
						const row = `${indent}${this.theme.codeBlock(codeLine)}`;
						this.nowrapLines.add(row);
						lines.push(row);
					}
				}
				lines.push(this.theme.codeBlockBorder("```"));
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after code blocks (unless space token follows)
				}
				break;
			}

			case "list": {
				const listLines = this.renderList(token as Tokens.List, 0, width, styleContext);
				lines.push(...listLines);
				// Don't add spacing after lists if a space token follows
				// (the space token will handle it)
				break;
			}

			case "table": {
				const tableLines = this.renderTable(token as Tokens.Table, width, nextTokenType, styleContext);
				lines.push(...tableLines);
				break;
			}

			case "blockquote": {
				const quoteStyle = (text: string) => this.theme.quote(this.theme.italic(text));
				const quoteStylePrefix = this.getStylePrefix(quoteStyle);
				const applyQuoteStyle = (line: string): string => {
					if (!quoteStylePrefix) {
						return quoteStyle(line);
					}
					const lineWithReappliedStyle = line.replace(/\x1b\[0m/g, `\x1b[0m${quoteStylePrefix}`);
					return quoteStyle(lineWithReappliedStyle);
				};

				// Calculate available width for quote content (subtract border "│ " = 2 chars)
				const quoteContentWidth = Math.max(1, width - 2);

				// Blockquotes contain block-level tokens (paragraph, list, code, etc.), so render
				// children with renderToken() instead of renderInlineTokens().
				// Default message style should not apply inside blockquotes.
				const quoteInlineStyleContext: InlineStyleContext = {
					applyText: (text: string) => text,
					stylePrefix: quoteStylePrefix,
				};
				const quoteTokens = token.tokens || [];
				const renderedQuoteLines: string[] = [];
				for (let i = 0; i < quoteTokens.length; i++) {
					const quoteToken = quoteTokens[i];
					const nextQuoteToken = quoteTokens[i + 1];
					renderedQuoteLines.push(
						...this.renderToken(quoteToken, quoteContentWidth, nextQuoteToken?.type, quoteInlineStyleContext),
					);
				}

				// Avoid rendering an extra empty quote line before the outer blockquote spacing.
				while (renderedQuoteLines.length > 0 && renderedQuoteLines[renderedQuoteLines.length - 1] === "") {
					renderedQuoteLines.pop();
				}

				for (const quoteLine of renderedQuoteLines) {
					const styledLine = applyQuoteStyle(quoteLine);
					const wrappedLines = wrapTextWithAnsi(styledLine, quoteContentWidth);
					for (const wrappedLine of wrappedLines) {
						lines.push(this.theme.quoteBorder("│ ") + wrappedLine);
					}
				}
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after blockquotes (unless space token follows)
				}
				break;
			}

			case "hr":
				lines.push(this.theme.hr("———"));
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after horizontal rules (unless space token follows)
				}
				break;

			case "html":
				// Render HTML as plain text (escaped for terminal)
				if ("raw" in token && typeof token.raw === "string") {
					lines.push(this.applyDefaultStyle(token.raw.trim()));
				}
				break;

			case "space":
				// Space tokens represent blank lines in markdown
				lines.push("");
				break;

			default:
				// Handle any other token types as plain text
				if ("text" in token && typeof token.text === "string") {
					lines.push(token.text);
				}
		}

		return lines;
	}

	private renderInlineTokens(tokens: Token[], styleContext?: InlineStyleContext): string {
		let result = "";
		const resolvedStyleContext = styleContext ?? this.getDefaultInlineStyleContext();
		const { applyText, stylePrefix } = resolvedStyleContext;
		const applyTextWithNewlines = (text: string): string => {
			const segments: string[] = text.split("\n");
			return segments.map((segment: string) => applyText(segment)).join("\n");
		};

		for (const token of tokens) {
			switch (token.type) {
				case "latex": {
					const latexToken = token as LatexToken;
					const rendered =
						!latexToken.pending && this.options.renderLatex !== false
							? (renderLatex(latexToken.text) ?? latexToken.raw)
							: latexToken.raw;
					result += applyTextWithNewlines(rendered);
					break;
				}

				case "escape":
					result += applyTextWithNewlines(this.options.preserveBackslashEscapes ? token.raw : token.text);
					break;

				case "text":
					// Text tokens in list items can have nested tokens for inline formatting
					if (token.tokens && token.tokens.length > 0) {
						result += this.renderInlineTokens(token.tokens, resolvedStyleContext);
					} else {
						result += applyTextWithNewlines(token.text);
					}
					break;

				case "paragraph":
					// Paragraph tokens contain nested inline tokens
					result += this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					break;

				case "strong": {
					const boldContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.theme.bold(boldContent) + stylePrefix;
					break;
				}

				case "em": {
					const italicContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.theme.italic(italicContent) + stylePrefix;
					break;
				}

				case "codespan":
					result += this.theme.code(token.text) + stylePrefix;
					break;

				case "link": {
					const linkText = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					const styledLink = this.theme.link(this.theme.underline(linkText));
					if (getCapabilities().hyperlinks) {
						// OSC 8: render as a clickable hyperlink. The URL is not printed inline,
						// so we always show only the link text regardless of whether it matches href.
						result += hyperlink(styledLink, token.href) + stylePrefix;
					} else {
						// Fallback: print URL in parentheses when text differs from href.
						// Compare raw token.text (not styled) against href for the equality check.
						// For mailto: links strip the prefix (autolinked emails use text="foo@bar.com"
						// but href="mailto:foo@bar.com").
						const hrefForComparison = token.href.startsWith("mailto:") ? token.href.slice(7) : token.href;
						if (token.text === token.href || token.text === hrefForComparison) {
							result += styledLink + stylePrefix;
						} else {
							result += styledLink + this.theme.linkUrl(` (${token.href})`) + stylePrefix;
						}
					}
					break;
				}

				case "br":
					result += "\n";
					break;

				case "del": {
					const delContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.theme.strikethrough(delContent) + stylePrefix;
					break;
				}

				case "html":
					// Render inline HTML as plain text
					if ("raw" in token && typeof token.raw === "string") {
						result += applyTextWithNewlines(token.raw);
					}
					break;

				default:
					// Handle any other inline token types as plain text
					if ("text" in token && typeof token.text === "string") {
						result += applyTextWithNewlines(token.text);
					}
			}
		}

		while (stylePrefix && result.endsWith(stylePrefix)) {
			result = result.slice(0, -stylePrefix.length);
		}

		return result;
	}

	private getOrderedListMarker(item: Tokens.ListItem): string | undefined {
		const match = /^(?: {0,3})(\d{1,9}[.)])[ \t]+/.exec(item.raw);
		return match ? `${match[1]} ` : undefined;
	}

	private getUnorderedListMarker(item: Tokens.ListItem): string | undefined {
		const match = /^(?: {0,3})([-+*])(?:[ \t]+|(?=\r?\n|$))/.exec(item.raw);
		return match ? `${match[1]} ` : undefined;
	}

	/**
	 * Render a list with proper nesting support
	 */
	private renderList(token: Tokens.List, depth: number, width: number, styleContext?: InlineStyleContext): string[] {
		const lines: string[] = [];
		const indent = "    ".repeat(depth);
		// Use the list's start property (defaults to 1 for ordered lists)
		const startNumber = typeof token.start === "number" ? token.start : 1;

		for (let i = 0; i < token.items.length; i++) {
			const item = token.items[i];
			const isLastItem = i === token.items.length - 1;
			const itemStartLine = lines.length;
			const bullet = token.ordered
				? this.options.preserveOrderedListMarkers
					? (this.getOrderedListMarker(item) ?? `${startNumber + i}. `)
					: `${startNumber + i}. `
				: this.options.preserveOrderedListMarkers
					? (this.getUnorderedListMarker(item) ?? "- ")
					: "- ";
			const taskMarker = item.task ? `[${item.checked ? "x" : " "}] ` : "";
			const marker = bullet + taskMarker;
			const firstPrefix = indent + this.theme.listBullet(marker);
			const continuationPrefix = indent + " ".repeat(visibleWidth(marker));
			const itemWidth = Math.max(1, width - visibleWidth(firstPrefix));
			let renderedAnyLine = false;

			for (const itemToken of item.tokens) {
				if (itemToken.type === "list") {
					lines.push(...this.renderList(itemToken as Tokens.List, depth + 1, width, styleContext));
					renderedAnyLine = true;
					continue;
				}

				const itemLines = this.renderToken(itemToken, itemWidth, undefined, styleContext);
				for (const line of itemLines) {
					for (const wrappedLine of wrapTextWithAnsi(line, itemWidth)) {
						const linePrefix = renderedAnyLine ? continuationPrefix : firstPrefix;
						lines.push(linePrefix + wrappedLine);
						renderedAnyLine = true;
					}
				}
			}

			if (!renderedAnyLine) {
				lines.push(firstPrefix);
			}

			// A multi-line item gets breathing room before the next item
			// (Codex TUI behavior); loose lists already insert blank lines.
			const itemLineCount = lines.length - itemStartLine;
			if (itemLineCount > 1 && !isLastItem && !token.loose) {
				lines.push("");
			}

			if (token.loose && !isLastItem) {
				lines.push("");
			}
		}

		return lines;
	}

	/**
	 * Get the visible width of the longest word in a string.
	 */
	private getLongestWordWidth(text: string, maxWidth?: number): number {
		const words = text.split(/\s+/).filter((word) => word.length > 0);
		let longest = 0;
		for (const word of words) {
			longest = Math.max(longest, visibleWidth(word));
		}
		if (maxWidth === undefined) {
			return longest;
		}
		return Math.min(longest, maxWidth);
	}

	/**
	 * Wrap a table cell to fit into a column.
	 *
	 * Delegates to wrapTextWithAnsi() so ANSI codes + long tokens are handled
	 * consistently with the rest of the renderer.
	 */
	private wrapCellText(text: string, maxWidth: number, stylePrefix = ""): string[] {
		const lines = wrapTextWithAnsi(text, Math.max(1, maxWidth));
		return lines.map((line, index) => {
			// Reset text styles after each non-final fragment, then restore the surrounding style before padding and borders.
			const styleReset = index < lines.length - 1 ? "\x1b[22;23;24;25;27;28;29;39m" : "";
			return `${line}${styleReset}${stylePrefix}`;
		});
	}

	/**
	 * Render a table with width-aware cell wrapping.
	 * Cells that don't fit are wrapped to multiple lines.
	 */
	private renderTable(
		token: Tokens.Table,
		availableWidth: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
	): string[] {
		const lines: string[] = [];
		const numCols = token.header.length;

		if (numCols === 0) {
			return lines;
		}

		// Calculate gutter overhead: (n-1) two-space gaps between columns
		const borderOverhead = 2 * (numCols - 1);
		const availableForCells = availableWidth - borderOverhead;
		if (availableForCells < numCols) {
			// Too narrow to render a stable table. Fall back to raw markdown.
			const fallbackLines = token.raw ? wrapTextWithAnsi(token.raw, availableWidth) : [];
			if (nextTokenType && nextTokenType !== "space") {
				fallbackLines.push("");
			}
			return fallbackLines;
		}

		const maxUnbrokenWordWidth = 30;

		// Calculate natural column widths (what each column needs without constraints)
		const naturalWidths: number[] = [];
		const minWordWidths: number[] = [];
		for (let i = 0; i < numCols; i++) {
			const headerText = this.renderInlineTokens(token.header[i].tokens || [], styleContext);
			naturalWidths[i] = visibleWidth(headerText);
			minWordWidths[i] = Math.max(1, this.getLongestWordWidth(headerText, maxUnbrokenWordWidth));
		}
		for (const row of token.rows) {
			for (let i = 0; i < row.length; i++) {
				const cellText = this.renderInlineTokens(row[i].tokens || [], styleContext);
				naturalWidths[i] = Math.max(naturalWidths[i] || 0, visibleWidth(cellText));
				minWordWidths[i] = Math.max(
					minWordWidths[i] || 1,
					this.getLongestWordWidth(cellText, maxUnbrokenWordWidth),
				);
			}
		}

		let minColumnWidths = minWordWidths;
		let minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);

		if (minCellsWidth > availableForCells) {
			minColumnWidths = new Array(numCols).fill(1);
			const remaining = availableForCells - numCols;

			if (remaining > 0) {
				const totalWeight = minWordWidths.reduce((total, width) => total + Math.max(0, width - 1), 0);
				const growth = minWordWidths.map((width) => {
					const weight = Math.max(0, width - 1);
					return totalWeight > 0 ? Math.floor((weight / totalWeight) * remaining) : 0;
				});

				for (let i = 0; i < numCols; i++) {
					minColumnWidths[i] += growth[i] ?? 0;
				}

				const allocated = growth.reduce((total, width) => total + width, 0);
				let leftover = remaining - allocated;
				for (let i = 0; leftover > 0 && i < numCols; i++) {
					minColumnWidths[i]++;
					leftover--;
				}
			}

			minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);
		}

		// Calculate column widths that fit within available width
		const totalNaturalWidth = naturalWidths.reduce((a, b) => a + b, 0) + borderOverhead;
		let columnWidths: number[];

		if (totalNaturalWidth <= availableWidth) {
			// Everything fits naturally
			columnWidths = naturalWidths.map((width, index) => Math.max(width, minColumnWidths[index]));
		} else {
			// Need to shrink columns to fit
			const totalGrowPotential = naturalWidths.reduce((total, width, index) => {
				return total + Math.max(0, width - minColumnWidths[index]);
			}, 0);
			const extraWidth = Math.max(0, availableForCells - minCellsWidth);
			columnWidths = minColumnWidths.map((minWidth, index) => {
				const naturalWidth = naturalWidths[index];
				const minWidthDelta = Math.max(0, naturalWidth - minWidth);
				let grow = 0;
				if (totalGrowPotential > 0) {
					grow = Math.floor((minWidthDelta / totalGrowPotential) * extraWidth);
				}
				return minWidth + grow;
			});

			// Adjust for rounding errors - distribute remaining space
			const allocated = columnWidths.reduce((a, b) => a + b, 0);
			let remaining = availableForCells - allocated;
			while (remaining > 0) {
				let grew = false;
				for (let i = 0; i < numCols && remaining > 0; i++) {
					if (columnWidths[i] < naturalWidths[i]) {
						columnWidths[i]++;
						remaining--;
						grew = true;
					}
				}
				if (!grew) {
					break;
				}
			}
		}

		// Render header with wrapping (Codex-style open table: no vertical
		// borders, heavy rule under the header, light rules between rows,
		// two-space column gutters — reads lighter than a closed box frame)
		const columnGap = "  ";
		const headerCellLines: string[][] = token.header.map((cell, i) => {
			const text = this.renderInlineTokens(cell.tokens || [], styleContext);
			return this.wrapCellText(text, columnWidths[i], styleContext?.stylePrefix);
		});
		const headerLineCount = Math.max(...headerCellLines.map((c) => c.length));

		const align = token.align ?? [];
		const padCell = (text: string, colIdx: number): string => {
			const cellWidth = columnWidths[colIdx];
			const textWidth = visibleWidth(text);
			const padding = Math.max(0, cellWidth - textWidth);
			const cellAlign = align[colIdx];
			if (cellAlign === "center") {
				const left = Math.floor(padding / 2);
				return " ".repeat(left) + text + " ".repeat(padding - left);
			}
			if (cellAlign === "right") {
				return " ".repeat(padding) + text;
			}
			return text + " ".repeat(padding);
		};

		for (let lineIdx = 0; lineIdx < headerLineCount; lineIdx++) {
			const rowParts = headerCellLines.map((cellLines, colIdx) => {
				const cell = padCell(cellLines[lineIdx] || "", colIdx);
				return this.theme.tableHeader ? this.theme.tableHeader(cell) : this.theme.bold(cell);
			});
			lines.push(rowParts.join(columnGap));
		}

		// Heavy rule under the header marks the head/body boundary
		const heavyRule = this.theme.hr(columnWidths.map((w) => "━".repeat(w)).join(columnGap));
		lines.push(heavyRule);

		// Render rows with wrapping
		const lightRule = this.theme.hr(columnWidths.map((w) => "─".repeat(w)).join(columnGap));
		for (let rowIndex = 0; rowIndex < token.rows.length; rowIndex++) {
			const row = token.rows[rowIndex];
			const rowCellLines: string[][] = row.map((cell, i) => {
				const text = this.renderInlineTokens(cell.tokens || [], styleContext);
				return this.wrapCellText(text, columnWidths[i], styleContext?.stylePrefix);
			});
			const rowLineCount = Math.max(...rowCellLines.map((c) => c.length));

			for (let lineIdx = 0; lineIdx < rowLineCount; lineIdx++) {
				const rowParts = rowCellLines.map((cellLines, colIdx) => padCell(cellLines[lineIdx] || "", colIdx));
				lines.push(rowParts.join(columnGap));
			}

			if (rowIndex < token.rows.length - 1) {
				lines.push(lightRule);
			}
		}

		if (nextTokenType && nextTokenType !== "space") {
			lines.push(""); // Add spacing after table
		}
		return lines;
	}
}
