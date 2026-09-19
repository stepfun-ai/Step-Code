/**
 * ANSI-shadow letterforms for the dragged "STEP CLI" wordmark.
 *
 * Each glyph mixes solid blocks (█, the ink) with box-drawing shadow strokes
 * (╔ ═ ╗ ║ ╚ ╝, the cast shadow) — the classic figlet "ANSI Shadow" look. The
 * renderer colors ink with a per-letter violet→gold gradient and the shadow
 * strokes dim, and emits composite-ready cells (undefined = blank) for the
 * welcome strip.
 */
import { stepLogoColorOpen } from "./step-logo.ts";

const WORD = "STEP CLI";

const GLYPHS: Record<string, string[]> = {
	S: ["███████╗", "██╔════╝", "██╔════╝", "███████╗", "╚════██║", "╚════██║", "███████║", "╚══════╝"],
	T: ["████████╗", "╚══██╔══╝", "╚══██╔══╝", "   ██║   ", "   ██║   ", "   ██║   ", "   ██║   ", "   ╚═╝   "],
	E: ["███████╗", "██╔════╝", "██╔════╝", "█████╗  ", "██╔══╝  ", "██╔══╝  ", "███████╗", "╚══════╝"],
	P: ["██████╗ ", "██╔══██╗", "██████╔╝", "██╔═══╝ ", "██║     ", "██║     ", "╚═╝     ", "        "],
	C: [" █████╗ ", "██╔══██╗", "██║     ", "██║     ", "██║     ", "██║     ", "╚██████╗", " ╚═════╝ "],
	L: ["██╗     ", "██║     ", "██║     ", "██║     ", "██║     ", "██║     ", "███████╗", "╚══════╝"],
	I: ["██╗", "██║", "██║", "██║", "██║", "██║", "██╗", "╚═╝"],
	" ": ["   ", "   ", "   ", "   ", "   ", "   ", "   ", "   "],
};

export const STEP_WORDMARK_ROWS = 8;

/** Visible width of the wordmark, including one space between letters. */
function wordmarkWidth(): number {
	let w = 0;
	for (const ch of WORD) w += GLYPHS[ch]![0]!.length + 1;
	return w - 1;
}

export const STEP_WORDMARK_COLUMNS = wordmarkWidth();

/** Hex color mixed from violet to gold by t in [0, 1]. */
function mixVioletToGold(t: number): string {
	const from = [0xaa, 0x91, 0xf0];
	const to = [0xf4, 0xd5, 0x6b];
	const channel = (a: number, b: number): string =>
		Math.round(a + (b - a) * Math.min(1, Math.max(0, t)))
			.toString(16)
			.padStart(2, "0");
	return `#${channel(from[0]!, to[0]!)}${channel(from[1]!, to[1]!)}${channel(from[2]!, to[2]!)}`;
}

/**
 * Composite-ready cells of the wordmark (undefined = blank). Ink blocks carry
 * the per-letter gradient; shadow strokes are dim.
 */
export function renderStepWordmarkCells(): (string | undefined)[][] {
	const letters = WORD.split("");
	const colored = letters.filter((ch) => ch !== " ");
	const dimOpen = "\x1b[90m";
	const rows: (string | undefined)[][] = Array.from({ length: STEP_WORDMARK_ROWS }, () => []);
	let seen = 0;
	for (const ch of letters) {
		const glyph = GLYPHS[ch]!;
		const inkOpen = ch === " " ? "" : stepLogoColorOpen(mixVioletToGold(seen / (colored.length - 1)));
		for (let gy = 0; gy < STEP_WORDMARK_ROWS; gy += 1) {
			for (const c of glyph[gy]!) {
				if (c === " ") rows[gy]!.push(undefined);
				else if (c === "█") rows[gy]!.push(`${inkOpen}█\x1b[39m`);
				else rows[gy]!.push(`${dimOpen}${c}\x1b[39m`);
			}
		}
		if (ch !== " ") seen += 1;
		for (let gy = 0; gy < STEP_WORDMARK_ROWS; gy += 1) rows[gy]!.push(undefined);
	}
	for (let gy = 0; gy < STEP_WORDMARK_ROWS; gy += 1) rows[gy]!.pop();
	return rows;
}
