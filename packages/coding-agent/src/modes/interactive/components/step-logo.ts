/**
 * STEP brand marks for the welcome block.
 *
 * Two marks live here, chosen at render time by terminal capability:
 *
 * - **The riding bird** (`renderBirdFrame` / `renderBirdStatic`): a 22x8
 *   colored sprite in the brand's violet-and-gold, decoded from
 *   `logo-sprite.generated.ts`. Most terminals render it with CP437 half-block
 *   glyphs (`▀` foreground + background), which keeps the source art's native
 *   per-half-row color resolution. Apple Terminal opts out of block glyphs
 *   (its rasterizer leaves visible grid seams), so it and bg-less painters get
 *   the Braille dot rendering instead: every half-cell becomes a 2x2 group in
 *   a 2x4 Braille dot matrix, softer but quantized. Colors render as truecolor
 *   or quantized 256-color through `style.ts`. The welcome block plays the
 *   frames once, then settles on the static frame.
 *
 * - **The CP437 block mark** (`renderStepMark`): the previous 3x3 abstract-S,
 *   kept as the monochrome fallback. It uses only space/`█`/`▀`/`▄` and emits
 *   no SGR, so it renders byte-identically on every terminal — the right thing
 *   when the bird's color would garble (a <8-color terminal) or when the box is
 *   too narrow for the sprite.
 *
 * Why the bird is terminal cells and not a Kitty/iTerm2 inline image:
 * `scrollback-guard.ts` clips full redraws to the viewport, and an inline image
 * makes pi-tui reserve extra rows with cursor moves so its output no longer maps
 * one row per `\r\n`. Block and Braille glyphs are ordinary text cells and cost
 * the differential renderer nothing.
 *
 * The CP437 mark's own design constraints (four glyphs, no SGR, why the axes
 * step differently) are documented inline at `renderStepMark` below — they are
 * unchanged from when it was the only mark.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import {
	BIRD_SPRITE_COLUMNS,
	BIRD_SPRITE_FRAME_DURATIONS_MS,
	BIRD_SPRITE_FRAMES,
	BIRD_SPRITE_PALETTE,
	BIRD_SPRITE_ROWS,
	BIRD_SPRITE_STATIC,
} from "./step-logo-sprite.generated.ts";

/** Minimal painter needed by the logo renderer. */
export interface StepLogoTheme {
	fg(color: string, text: string): string;
	/** Background paint; when absent the renderer falls back to Braille cells. */
	bg?(color: string, text: string): string;
}

type RgbColor = { r: number; g: number; b: number };

/** Parse a six-digit source-art color. */
function parseHexColor(value: string): RgbColor | null {
	const digits = value.trim().replace(/^#/, "");
	if (!/^[0-9a-f]{6}$/iu.test(digits)) return null;
	return {
		r: Number.parseInt(digits.slice(0, 2), 16),
		g: Number.parseInt(digits.slice(2, 4), 16),
		b: Number.parseInt(digits.slice(4, 6), 16),
	};
}

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const;

function nearestCubeLevel(channel: number): number {
	let nearest = 0;
	for (let index = 1; index < CUBE_LEVELS.length; index += 1) {
		if (Math.abs(channel - CUBE_LEVELS[index]!) < Math.abs(channel - CUBE_LEVELS[nearest]!)) {
			nearest = index;
		}
	}
	return nearest;
}

/** Same nearest xterm cube mapping used by the former Step TUI style layer. */
function rgbToAnsi256({ r, g, b }: RgbColor): number {
	if (r === g && g === b) {
		if (r < 8) return 16;
		if (r > 248) return 231;
		return Math.round(((r - 8) / 247) * 24) + 232;
	}
	return 16 + 36 * nearestCubeLevel(r) + 6 * nearestCubeLevel(g) + nearestCubeLevel(b);
}

/** Paint an arbitrary sprite color at the active Pi theme color depth. */
export function paintStepLogoColor(color: string, text: string): string {
	const rgb = parseHexColor(color);
	if (rgb === null || text.length === 0) return text;
	let mode: "truecolor" | "256color" = "truecolor";
	try {
		mode = theme.getColorMode();
	} catch {
		// A renderer can be unit-tested before theme initialization; plain text is
		// preferable to making the welcome block fail in that case.
		return text;
	}
	const open = mode === "truecolor" ? `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m` : `\x1b[38;5;${rgbToAnsi256(rgb)}m`;
	return `${open}${text}\x1b[39m`;
}

/** Paint an arbitrary sprite background at the active Pi theme color depth. */
export function paintStepLogoBg(color: string, text: string): string {
	const rgb = parseHexColor(color);
	if (rgb === null || text.length === 0) return text;
	let mode: "truecolor" | "256color" = "truecolor";
	try {
		mode = theme.getColorMode();
	} catch {
		return text;
	}
	const open = mode === "truecolor" ? `\x1b[48;2;${rgb.r};${rgb.g};${rgb.b}m` : `\x1b[48;5;${rgbToAnsi256(rgb)}m`;
	return `${open}${text}\x1b[49m`;
}

/** Paint the small `STEP` badge background used by the old welcome block. */
export function paintStepBadge(text: string): string {
	let mode: "truecolor" | "256color" = "truecolor";
	try {
		mode = theme.getColorMode();
	} catch {
		return text;
	}
	const open = mode === "truecolor" ? "\x1b[48;2;30;26;56m" : `\x1b[48;5;${rgbToAnsi256({ r: 30, g: 26, b: 56 })}m`;
	return `${open}${text}\x1b[49m`;
}

/** Adapter matching the old renderer's handle-shaped API. */
export function createStepLogoTheme(): StepLogoTheme {
	return { fg: paintStepLogoColor, bg: paintStepLogoBg };
}

/** Terminal columns the riding-bird sprite occupies. */
export const BIRD_COLUMNS = BIRD_SPRITE_COLUMNS;
/** Terminal rows the riding-bird sprite occupies. */
export const BIRD_ROWS = BIRD_SPRITE_ROWS;
/** Number of animation frames in the launch loop. */
export const BIRD_FRAME_COUNT = BIRD_SPRITE_FRAMES.length;
/** Per-frame hold time (ms), matching the source GIF. */
export const BIRD_FRAME_DURATIONS_MS: readonly number[] = BIRD_SPRITE_FRAME_DURATIONS_MS;
/** Total run of one animation loop, in milliseconds. */
export const BIRD_ANIMATION_DURATION_MS = BIRD_SPRITE_FRAME_DURATIONS_MS.reduce((sum, ms) => sum + ms, 0);

/** Braille dot masks for two small square-ish samples in each half-cell. */
const BRAILLE_UPPER_MASK = 0b00011011;
const BRAILLE_LOWER_MASK = 0b11100100;
const BRAILLE_BASE = 0x2800;

/**
 * Renders a sprite (a frame or the static image) to colored Braille cells.
 *
 * Each source half-cell becomes a 2x2 group in the terminal's 2x4 Braille dot
 * matrix. The glyph uses foreground color only: transparent portions stay
 * transparent and no half-row expands into a full background cell. A terminal
 * cell can carry only one Braille foreground color, so when both halves have
 * different colors the upper sample wins while the full silhouette is kept.
 * Colors go through the theme handle, so `style.ts` downgrades them to the
 * terminal's color depth.
 */
function renderBrailleSprite(handle: StepLogoTheme, rows: readonly string[]): string[] {
	return rows.map((row) => {
		let line = "";
		for (let i = 0; i < row.length; i += 2) {
			const upper = Number.parseInt(row[i]!, 16);
			const lower = Number.parseInt(row[i + 1]!, 16);
			const upperHex = upper > 0 ? BIRD_SPRITE_PALETTE[upper - 1] : undefined;
			const lowerHex = lower > 0 ? BIRD_SPRITE_PALETTE[lower - 1] : undefined;
			const color = upperHex ?? lowerHex;
			const mask =
				(upperHex === undefined ? 0 : BRAILLE_UPPER_MASK) | (lowerHex === undefined ? 0 : BRAILLE_LOWER_MASK);
			line += color === undefined ? " " : handle.fg(color, String.fromCodePoint(BRAILLE_BASE | mask));
		}
		return line;
	});
}

/**
 * Renders a sprite with CP437 half-block glyphs — the source art's native
 * resolution. Each cell paints its upper and lower samples independently via
 * `▀` foreground/background, so every half-row keeps its own color instead of
 * being quantized into a shared Braille dot mask. Used whenever the painter
 * can set backgrounds; Apple Terminal opts out (see `prefersBrailleSprite`).
 */
function renderHalfBlockSprite(handle: StepLogoTheme, rows: readonly string[]): string[] {
	return rows.map((row) => {
		let line = "";
		for (let i = 0; i < row.length; i += 2) {
			const upper = Number.parseInt(row[i]!, 16);
			const lower = Number.parseInt(row[i + 1]!, 16);
			const upperHex = upper > 0 ? BIRD_SPRITE_PALETTE[upper - 1] : undefined;
			const lowerHex = lower > 0 ? BIRD_SPRITE_PALETTE[lower - 1] : undefined;
			if (upperHex === undefined && lowerHex === undefined) {
				line += " ";
				continue;
			}
			if (lowerHex === undefined) {
				line += handle.fg(upperHex!, "▀");
				continue;
			}
			if (upperHex === undefined) {
				line += handle.fg(lowerHex, "▄");
				continue;
			}
			// ▀ with the lower sample as background paints both halves in one cell.
			line += handle.bg!(lowerHex, handle.fg(upperHex, "▀"));
		}
		return line;
	});
}

/**
 * Apple Terminal rasterizes block glyphs with visible grid seams, which made
 * the half-block bird look stitched together. There the Braille rendering
 * stays the better trade: softer dots, no seams, identical everywhere else.
 */
function prefersBrailleSprite(): boolean {
	return process.env.TERM_PROGRAM === "Apple_Terminal";
}

function renderSprite(handle: StepLogoTheme, rows: readonly string[]): string[] {
	if (handle.bg && !prefersBrailleSprite()) {
		return renderHalfBlockSprite(handle, rows);
	}
	return renderBrailleSprite(handle, rows);
}

/** Renders animation frame `index` (wrapped into range) of the riding bird. */
export function renderBirdFrame(handle: StepLogoTheme, index: number): string[] {
	const frame =
		BIRD_SPRITE_FRAMES[((index % BIRD_FRAME_COUNT) + BIRD_FRAME_COUNT) % BIRD_FRAME_COUNT] ?? BIRD_SPRITE_STATIC;
	return renderSprite(handle, frame);
}

/** Renders the settled riding bird shown after the launch animation ends. */
export function renderBirdStatic(handle: StepLogoTheme): string[] {
	return renderSprite(handle, BIRD_SPRITE_STATIC);
}

/**
 * Monochrome CP437 fallback mark: a 3x3 grid of squares — `.XX / .X. / XX.`,
 * the abstract S — cut from the product logo.
 *
 * Two restrictions are deliberate, and both trade fidelity for rendering
 * identically on every terminal:
 *
 * - **Four glyphs only**: space, `█`, `▀`, `▄`. The three block characters are
 *   CP437, so every font a terminal has ever shipped draws them, at exactly one
 *   cell wide. The quadrant glyphs this mark used to need (`▖▗▘▝▚▞▙▟`,
 *   U+2596-U+259F) are Unicode-era additions: a font missing them substitutes
 *   a glyph of the wrong width, which shears every row below it.
 * - **No SGR at all**: the mark inherits the terminal foreground rather than
 *   painting one. The gradient it used to carry had to quantize to the
 *   terminal's color depth, so it looked different in every terminal; a
 *   hardcoded white would vanish on a light background. The default foreground
 *   is the only ink that is both byte-identical everywhere and correct on any
 *   theme.
 *
 * Restricting the glyphs also fixes the resolution of each axis, and the two
 * differ: columns step whole cells, because that is the only horizontal step
 * `█` allows, while rows step half-cells, because `▀` and `▄` split a cell
 * vertically. Blocks are 2 columns by 1 row. A terminal cell is roughly 2.5
 * times taller than wide once line spacing applies, so an exactly square block
 * would be 2.5 columns — unreachable in whole columns, leaving 2 (20% narrow)
 * and 3 (20% wide) as the candidates. 2 wins on size. Gaps are one column and
 * one half-row, which measure 1.0 and 1.25 cell-widths: within a quarter cell
 * of each other, and the finest step either axis offers.
 */

/** Filled cells per row of the 3x3 grid: `.XX / .X. / XX.`. */
const MARK_CELLS: readonly (readonly number[])[] = [[1, 2], [1], [0, 1]];

/** Block width, in whole terminal columns. */
const BLOCK_COLUMNS = 2;
/** Block height, in half-rows (two per text row). */
const BLOCK_HALF_ROWS = 2;
/** Gap between blocks, in whole terminal columns. */
const GAP_COLUMNS = 1;
/** Gap between blocks, in half-rows. */
const GAP_HALF_ROWS = 1;

/** Terminal columns the mark occupies. */
export const STEP_MARK_COLUMNS = 3 * BLOCK_COLUMNS + 2 * GAP_COLUMNS;

/** Mark height in half-rows, before pairing them into text rows. */
const MARK_HALF_ROWS = 3 * BLOCK_HALF_ROWS + 2 * GAP_HALF_ROWS;

/** Terminal rows the mark occupies. */
export const STEP_MARK_ROWS = Math.ceil(MARK_HALF_ROWS / 2);

/**
 * Glyph per half-row fill pattern of one cell, indexed by `upper<<1 | lower`.
 *
 * All four patterns have a dedicated character, so ink never needs a painted
 * background — which is what lets the mark sit on whatever background the
 * terminal uses.
 */
const HALF_ROW_GLYPHS: readonly string[] = [
	" ", // ....
	"▄", // ..lower
	"▀", // upper..
	"█", // upper lower
];

/** The `row,column` pairs of the 3x3 grid that carry ink. */
const FILLED_CELLS = new Set(MARK_CELLS.flatMap((columns, row) => columns.map((column) => `${row},${column}`)));

/** Grid index for a coordinate on one axis, or -1 when it falls in a gap. */
function trackAt(position: number, block: number, gap: number): number {
	for (let i = 0; i < 3; i += 1) {
		const start = i * (block + gap);
		if (position >= start && position < start + block) {
			return i;
		}
	}
	return -1;
}

/**
 * Whether half-row `halfRow` of column `column` carries ink. Coordinates past
 * the mark read as blank, so pairing an odd `MARK_HALF_ROWS` into text rows
 * would not need a bounds check of its own.
 */
function isInk(column: number, halfRow: number): boolean {
	const gridRow = trackAt(halfRow, BLOCK_HALF_ROWS, GAP_HALF_ROWS);
	const gridColumn = trackAt(column, BLOCK_COLUMNS, GAP_COLUMNS);
	if (gridRow < 0 || gridColumn < 0) {
		return false;
	}
	return FILLED_CELLS.has(`${gridRow},${gridColumn}`);
}

/**
 * Renders the STEP mark as plain lines, one string per terminal row.
 *
 * Lines are padded to the mark's full width and carry no styling of any kind,
 * so callers can place them anywhere and the output is byte-identical on every
 * run and every terminal — which lets pi-tui's differential renderer skip the
 * rows entirely after the first paint.
 */
export function renderStepMark(): string[] {
	const lines: string[] = [];
	for (let halfRow = 0; halfRow < MARK_HALF_ROWS; halfRow += 2) {
		let line = "";
		for (let column = 0; column < STEP_MARK_COLUMNS; column += 1) {
			const mask = (isInk(column, halfRow) ? 0b10 : 0) | (isInk(column, halfRow + 1) ? 0b01 : 0);
			line += HALF_ROW_GLYPHS[mask]!;
		}
		lines.push(line);
	}
	return lines;
}

/**
 * Lays `body` out to the right of `mark`, separated by `gap` spaces and
 * vertically centered against each other. Mark rows are padded to their visible
 * width — `renderStepMark` and the bird sprites already emit them uniform, but a
 * caller passing ragged input still gets a straight body column. Body lines
 * may carry their own ANSI styling and are never padded, so trailing width is
 * left to the caller.
 *
 * `markColumns` is the mark's visible width; pass it explicitly because the
 * bird sprite carries SGR that `styledVisibleWidth` would have to strip on
 * every ragged row otherwise, and callers already know the width.
 */
export function alignMarkWithBody(
	mark: readonly string[],
	body: readonly string[],
	options: { gap?: number; markColumns?: number } = {},
): string[] {
	const gap = " ".repeat(Math.max(0, options.gap ?? 2));
	const markColumns = options.markColumns ?? STEP_MARK_COLUMNS;
	const blankMark = " ".repeat(markColumns);

	const height = Math.max(mark.length, body.length);
	const markOffset = Math.floor((height - mark.length) / 2);
	const bodyOffset = Math.floor((height - body.length) / 2);

	const lines: string[] = [];
	for (let i = 0; i < height; i += 1) {
		const markLine = mark[i - markOffset];
		const paddedMark =
			markLine === undefined ? blankMark : markLine + " ".repeat(Math.max(0, markColumns - visibleWidth(markLine)));
		const bodyLine = body[i - bodyOffset] ?? "";
		lines.push(bodyLine === "" ? paddedMark.trimEnd() : `${paddedMark}${gap}${bodyLine}`);
	}
	return lines;
}
