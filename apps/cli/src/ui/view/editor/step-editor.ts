import type { KeybindingsManager } from "@step-harness/coding-agent";
import { CustomEditor, theme } from "@step-harness/coding-agent";
import {
	CURSOR_MARKER,
	type EditorOptions,
	type EditorTheme,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@step-harness/pi-tui";
import { paintStepWordmarkBorder } from "../chrome/step-wordmark.ts";

/** The hint shown before the first prompt is typed. */
export const STEP_EDITOR_PLACEHOLDER = "Ask Step to do anything (/ for commands, @ for files, ! for shell)";

/** The hints shown while the editor holds only a bash prefix. */
const STEP_BASH_PLACEHOLDER = "run a shell command (Esc to exit)";
const STEP_BASH_EXCLUDED_PLACEHOLDER = "run a shell command, hidden from the model (Esc to exit)";

/** The two-cell inset the frame keeps on each side of the content. */
const STEP_EDITOR_CHROME_WIDTH = 4;

/**
 * The frame insets its content but draws no side rails. A terminal text
 * selection copies whole screen rows, so rails would be dragged into the
 * clipboard with the prompt and pasted back as `│` noise.
 */
const STEP_EDITOR_CONTENT_INSET = "  ";

/**
 * The prompt marker on the first framed row. It is exactly as wide as the
 * inset it replaces, so the content column, the wrap width, and the native
 * cursor position are all unchanged. The gap is a plain space rather than a
 * no-break space so a copied prompt stays free of invisible characters.
 */
const STEP_EDITOR_PROMPT_MARKER = "❯ ";

/** A frame this narrow is less useful than pi-tui's compact native editor. */
const STEP_EDITOR_MIN_FRAME_WIDTH = 8;

/**
 * The native editor needs two content cells to lay out a wide grapheme. A
 * smaller layout makes its word-wrap fallback recurse forever for a single
 * CJK grapheme; use the compact full-width fallback before reaching that
 * state.
 */
const STEP_EDITOR_MIN_NATIVE_CONTENT_WIDTH = 3;

/** Strip SGR sequences while keeping the structural box-drawing characters. */
function stripSgr(line: string): string {
	// eslint-disable-next-line no-control-regex
	return line.replaceAll(/\x1b\[[0-9;]*m/g, "");
}

/**
 * pi-tui's editor uses a horizontal rule for both edges of its input. The
 * scroll indicators use the same rule prefix, so they count as an edge too.
 */
function isEditorRule(line: string): boolean {
	const plain = stripSgr(line);
	return /^─+$/.test(plain) || plain.startsWith("─── ↑") || plain.startsWith("─── ↓");
}

/** Keep the selected command prominent while leaving its description muted. */
function createStepSelectListTheme(editorTheme: EditorTheme): EditorTheme["selectList"] {
	// Bold on top of the accent color: color alone was too easy to miss next to
	// the default-foreground rows (feedback issue-07fd7c41454f62cc follow-up).
	const selected = (text: string) => theme.bold(theme.fg("accent", text));
	const muted = (text: string) => theme.fg("muted", text);
	return {
		selectedPrefix: (text) => selected(text),
		selectedText: (text) => {
			const arrow = text.startsWith("→ ") ? "→ " : "";
			const rest = arrow ? text.slice(arrow.length) : text;
			const gap = rest.indexOf("  ");
			if (gap === -1) return selected(text);
			return `${selected(`${arrow}${rest.slice(0, gap)}`)}${muted(rest.slice(gap))}`;
		},
		description: (text) => editorTheme.selectList.description(text),
		scrollInfo: (text) => editorTheme.selectList.scrollInfo(text),
		noMatch: (text) => editorTheme.selectList.noMatch(text),
	};
}

/**
 * The Step composer keeps pi-tui's editor and input state machine intact and
 * changes only its presentation. In particular, `handleInput` and the native
 * editor color/cursor behavior are inherited from `CustomEditor`; all key
 * decoding, IME/paste buffering, history, autocomplete, undo, and submit
 * behavior therefore remains the native path.
 */
export class StepEditor extends CustomEditor {
	private readonly placeholder: string;
	private highlightedText = "";
	private highlights = new Map<number, { start: number; end: number; shimmer: boolean }[]>();
	private keywordCount = 0;
	private shimmerFrame = -1;
	private shimmerTimer?: ReturnType<typeof setInterval>;

	constructor(
		tui: TUI,
		editorTheme: EditorTheme,
		keybindings: KeybindingsManager,
		options: EditorOptions & { placeholder?: string } = {},
	) {
		const { placeholder, ...editorOptions } = options;
		const fallbackBorderColor = editorTheme.borderColor;
		const stepTheme: EditorTheme = {
			...editorTheme,
			selectList: createStepSelectListTheme(editorTheme),
		};
		// The old Step composer used the brand tone for both rounded edges and
		// the narrow-terminal fallback. Keep the supplied select-list theme and
		// replace only the editor rule color.
		super(
			tui,
			{
				...stepTheme,
				borderColor: (text: string) => {
					try {
						return paintStepWordmarkBorder(text);
					} catch {
						return fallbackBorderColor(text);
					}
				},
			},
			keybindings,
			editorOptions,
		);
		this.placeholder = placeholder ?? STEP_EDITOR_PLACEHOLDER;
	}

	override render(width: number): string[] {
		this.updateHighlights();
		const safeWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
		const innerWidth = safeWidth - STEP_EDITOR_CHROME_WIDTH;
		const minimumNativeWidth = this.minimumNativeWidth();
		if (safeWidth < STEP_EDITOR_MIN_FRAME_WIDTH || innerWidth < minimumNativeWidth) {
			return this.clampToWidth(this.renderNative(safeWidth), safeWidth);
		}

		// Render the native editor in the interior width. The autocomplete rows
		// are appended after the bottom rule by pi-tui and are deliberately kept
		// outside the rounded frame.
		const inner = this.renderNative(innerWidth);
		return this.clampToWidth(this.frameBox(inner, safeWidth), safeWidth);
	}

	override handleInput(data: string): void {
		super.handleInput(data);
		this.updateHighlights();
	}

	override setText(text: string): void {
		super.setText(text);
		this.updateHighlights();
	}

	dispose(): void {
		if (this.shimmerTimer) clearInterval(this.shimmerTimer);
		this.shimmerTimer = undefined;
		this.shimmerFrame = -1;
	}

	private updateHighlights(): void {
		const text = this.getText();
		if (!this.focused) this.dispose();
		if (text === this.highlightedText) return;
		this.highlightedText = text;
		this.highlights.clear();
		let keywordCount = 0;
		for (const [line, source] of this.getLines().entries()) {
			const spans: { start: number; end: number; shimmer: boolean }[] = [];
			const command = line === 0 ? /^\s*(\/[\w-]+)(?=\s|$)/u.exec(source) : null;
			if (command) {
				const start = command[0].length - command[1].length;
				spans.push({ start, end: command[0].length, shimmer: false });
			}
			for (const match of source.matchAll(/\bultracode\b/giu)) {
				if (spans.some((span) => match.index < span.end)) continue;
				spans.push({ start: match.index, end: match.index + match[0].length, shimmer: true });
				keywordCount++;
			}
			if (spans.length > 0) this.highlights.set(line, spans);
		}
		if (keywordCount === 0) this.dispose();
		if (keywordCount > this.keywordCount && this.focused) {
			this.dispose();
			this.shimmerFrame = 0;
			this.shimmerTimer = setInterval(() => {
				if (!this.focused || !/\bultracode\b/iu.test(this.getText())) {
					this.dispose();
					return;
				}
				this.shimmerFrame++;
				if (this.shimmerFrame >= 10) this.dispose();
				this.tui.requestRender();
			}, 60);
			this.shimmerTimer.unref();
		}
		this.keywordCount = keywordCount;
	}

	protected override styleText(text: string, line: number, startIndex: number): string {
		const spans = this.highlights.get(line);
		if (!spans || !text) return text;
		const cursor = this.getCursor();
		let painted = "";
		let offset = 0;
		for (const span of spans) {
			if (cursor.line === line && cursor.col >= span.start && cursor.col < span.end) continue;
			const start = Math.max(0, span.start - startIndex);
			const end = Math.min(text.length, span.end - startIndex);
			if (start >= end) continue;
			painted += text.slice(offset, start);
			const highlighted = text.slice(start, end);
			const glint = span.start + this.shimmerFrame - startIndex - start;
			if (span.shimmer && this.shimmerFrame >= 0 && glint >= 0 && glint < highlighted.length) {
				painted +=
					theme.fg("accent", highlighted.slice(0, glint)) +
					theme.bold(theme.fg("text", highlighted.slice(glint, glint + 1))) +
					theme.fg("accent", highlighted.slice(glint + 1));
			} else {
				painted += theme.fg("accent", highlighted);
			}
			offset = end;
		}
		return painted + text.slice(offset);
	}

	/**
	 * Render at a width the native editor can safely lay out. This is only used
	 * by the narrow-terminal fallback; normal Step frames pass their exact
	 * interior width through to pi-tui unchanged.
	 */
	private renderNative(width: number): string[] {
		const safeWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
		return this.applyPlaceholder(super.render(Math.max(safeWidth, this.minimumNativeWidth())));
	}

	/**
	 * Return the smallest native width that leaves room for the widest ordinary
	 * terminal atom (a tab is three cells) and the editor's end cursor cell.
	 */
	private minimumNativeWidth(): number {
		const padding = this.getPaddingX();
		const contentWidth = padding * 2 + STEP_EDITOR_MIN_NATIVE_CONTENT_WIDTH;
		// With zero padding pi reserves one extra column for its cursor in the
		// layout width; padded layouts already account for that cell separately.
		return padding === 0 ? contentWidth + 1 : contentWidth;
	}

	/** Insert the hint into pi-tui's already padded empty content row. */
	private applyPlaceholder(lines: string[]): string[] {
		const text = this.getText();
		// A bare `!`/`!!` prefix keeps a bash-mode hint after the typed prefix.
		const bashHint =
			text === "!" ? STEP_BASH_PLACEHOLDER : text === "!!" ? STEP_BASH_EXCLUDED_PLACEHOLDER : undefined;
		if ((text.length !== 0 && !bashHint) || lines.length < 2) {
			return lines;
		}

		const contentRow = lines[1] ?? "";
		const trailingSpaces = /( *)$/.exec(contentRow)?.[1]?.length ?? 0;
		// Keep one cell after the hint and one cell for the editor cursor.
		const budget = trailingSpaces - 2;
		if (budget < 8) {
			return lines;
		}

		const placeholder = truncateToWidth(bashHint ?? this.placeholder, budget);
		const placeholderWidth = visibleWidth(placeholder);
		if (placeholderWidth === 0) {
			return lines;
		}

		const kept = contentRow.slice(0, contentRow.length - trailingSpaces);
		const padding = " ".repeat(Math.max(0, trailingSpaces - 1 - placeholderWidth));
		const result = [...lines];
		result[1] = `${kept} ${theme.fg("muted", placeholder)}${padding}`;
		return result;
	}

	/**
	 * Widen pi-tui's two horizontal rules to the full terminal width, paint them
	 * with the Step border tone, and inset the rows between them. The first row
	 * carries the prompt marker in place of its inset. The scan stops at the last
	 * rule before autocomplete, so completion rows remain native and are not
	 * accidentally indented.
	 */
	private frameBox(inner: string[], width: number): string[] {
		if (inner.length < 2) {
			return inner;
		}

		let bottom = -1;
		for (let index = inner.length - 1; index >= 1; index -= 1) {
			if (isEditorRule(inner[index] ?? "")) {
				bottom = index;
				break;
			}
		}
		if (bottom === -1) {
			return inner;
		}

		// The frame follows the editor's borderColor so mode changes (bash mode,
		// thinking level) recolor the composer; StepEditor's constructor pins the
		// brand tone and InteractiveMode updates it per state.
		const border = this.borderColor;
		const interiorWidth = Math.max(0, width - STEP_EDITOR_CHROME_WIDTH);
		const rule = border("─".repeat(Math.max(0, width)));
		const framed: string[] = [rule];
		for (let index = 1; index < bottom; index += 1) {
			const row = inner[index] ?? "";
			const padding = " ".repeat(Math.max(0, interiorWidth - visibleWidth(row)));
			const lead = index === 1 ? border(STEP_EDITOR_PROMPT_MARKER) : STEP_EDITOR_CONTENT_INSET;
			framed.push(`${lead}${row}${padding}${STEP_EDITOR_CONTENT_INSET}`);
		}
		framed.push(rule);

		// Preserve pi-tui's autocomplete block byte-for-byte after the frame.
		for (let index = bottom + 1; index < inner.length; index += 1) {
			framed.push(inner[index] ?? "");
		}
		return framed;
	}

	/** Guard the renderer contract if a styled row is unexpectedly too wide. */
	private clampToWidth(lines: string[], width: number): string[] {
		const safeWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
		let result: string[] | undefined;
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index] ?? "";
			if (visibleWidth(line) > safeWidth) {
				result ??= [...lines];
				result[index] = this.truncateLinePreservingCursor(line, safeWidth);
			}
		}
		return result ?? lines;
	}

	/**
	 * pi-tui's cursor marker is zero-width but semantically required by the
	 * renderer for IME positioning. Keep it when a narrow fallback needs to
	 * clip a row; the generic truncator is allowed to discard everything after
	 * the visible boundary and would otherwise silently remove the marker.
	 */
	private truncateLinePreservingCursor(line: string, width: number): string {
		const markerIndex = line.indexOf(CURSOR_MARKER);
		if (markerIndex === -1) {
			return truncateToWidth(line, width, "", false);
		}

		const beforeMarker = line.slice(0, markerIndex);
		const afterMarker = line.slice(markerIndex + CURSOR_MARKER.length);
		const beforeWidth = visibleWidth(beforeMarker);
		if (beforeWidth >= width) {
			return `${truncateToWidth(beforeMarker, width, "", false)}${CURSOR_MARKER}`;
		}

		const remainingWidth = width - beforeWidth;
		return `${beforeMarker}${CURSOR_MARKER}${truncateToWidth(afterMarker, remainingWidth, "", false)}`;
	}
}
