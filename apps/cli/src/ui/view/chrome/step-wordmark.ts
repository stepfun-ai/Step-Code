/**
 * Chamfered block letterforms with inset highlights for "STEP CODE".
 *
 * Four-column stems and two-row bars carry the violet→gold gradient. Half-block
 * corners and highlights stay inside the face; undefined cells are transparent.
 */
import { paintStepLogoColor } from "./step-logo.ts";

const WORD = "STEP CODE";

const GLYPHS: Record<string, string[]> = {
	S: [
		"▄█████████ ",
		"██████████ ",
		"████       ",
		"█████████▄ ",
		"▀█████████ ",
		"      ████ ",
		"██████████ ",
		"█████████▀ ",
		"           ",
	],
	T: [
		"▄██████████▄ ",
		"████████████ ",
		"    ████     ",
		"    ████     ",
		"    ████     ",
		"    ████     ",
		"    ████     ",
		"    ▀██▀     ",
		"             ",
	],
	E: [
		"▄████████▄ ",
		"██████████ ",
		"████       ",
		"███████▄   ",
		"███████▀   ",
		"████       ",
		"██████████ ",
		"▀████████▀ ",
		"           ",
	],
	P: [
		"█████████▄ ",
		"██████████ ",
		"████  ████ ",
		"████  ████ ",
		"██████████ ",
		"█████████▀ ",
		"████       ",
		"▀██▀       ",
		"           ",
	],
	C: [
		"▄████████▄ ",
		"██████████ ",
		"████       ",
		"████       ",
		"████       ",
		"████       ",
		"██████████ ",
		"▀████████▀ ",
		"           ",
	],
	L: [
		"▄██▄       ",
		"████       ",
		"████       ",
		"████       ",
		"████       ",
		"████       ",
		"██████████ ",
		"▀████████▀ ",
		"           ",
	],
	I: ["▄██▄ ", "████ ", "████ ", "████ ", "████ ", "████ ", "████ ", "▀██▀ ", "     "],
	O: [
		"▄████████▄ ",
		"██████████ ",
		"████  ████ ",
		"████  ████ ",
		"████  ████ ",
		"████  ████ ",
		"████  ████ ",
		"▀████████▀ ",
		"           ",
	],
	D: [
		"█████████▄ ",
		"██████████ ",
		"████    ██ ",
		"████    ██ ",
		"████    ██ ",
		"████    ██ ",
		"████    ██ ",
		"▀████████▀ ",
		"           ",
	],
	" ": ["   ", "   ", "   ", "   ", "   ", "   ", "   ", "   ", "   "],
};

export const STEP_WORDMARK_ROWS = 9;

/** Visible width of the wordmark, including one space between letters. */
function wordmarkWidth(): number {
	let w = 0;
	for (const ch of WORD) w += GLYPHS[ch]![0]!.length + 1;
	return w - 1;
}

export const STEP_WORDMARK_COLUMNS = wordmarkWidth();

/** Hex color mixed from violet to gold by t in [0, 1]. */
function mixVioletToGold(t: number, lightness = 0): string {
	const from = [0xaa, 0x91, 0xf0];
	const to = [0xf4, 0xd5, 0x6b];
	const channel = (start: number, end: number): string => {
		const base = Math.round(start + (end - start) * Math.min(1, Math.max(0, t)));
		return Math.round(lightness >= 0 ? base + (255 - base) * lightness : base * (1 + lightness))
			.toString(16)
			.padStart(2, "0");
	};
	return `#${channel(from[0]!, to[0]!)}${channel(from[1]!, to[1]!)}${channel(from[2]!, to[2]!)}`;
}

export function paintStepWordmarkBorder(text: string): string {
	const letters = WORD.replaceAll(" ", "");
	return paintStepLogoColor(mixVioletToGold(letters.indexOf("P") / (letters.length - 1)), text);
}

/**
 * Composite-ready cells of the wordmark (undefined = blank). Exposed top edges
 * receive a half-cell highlight without changing the solid face geometry.
 */
export function renderStepWordmarkCells(): (string | undefined)[][] {
	const letters = WORD.split("");
	const colored = letters.filter((ch) => ch !== " ");
	const rows: (string | undefined)[][] = Array.from({ length: STEP_WORDMARK_ROWS }, () => []);
	let seen = 0;
	for (const ch of letters) {
		const glyph = GLYPHS[ch]!;
		const ink = mixVioletToGold(seen / (colored.length - 1));
		const highlight = mixVioletToGold(seen / (colored.length - 1), 0.42);
		const leftFace = mixVioletToGold(seen / (colored.length - 1), 0.12);
		const rightFace = mixVioletToGold(seen / (colored.length - 1), -0.24);
		const lowerFace = mixVioletToGold(seen / (colored.length - 1), -0.32);
		for (let gy = 0; gy < STEP_WORDMARK_ROWS; gy += 1) {
			for (let column = 0; column < glyph[gy]!.length; column += 1) {
				const cell = glyph[gy]![column]!;
				const above = glyph[gy - 1]?.[column];
				const below = glyph[gy + 1]?.[column];
				if (cell === " ") rows[gy]!.push(undefined);
				else if (cell === "█") {
					const left = glyph[gy]![column - 1];
					const right = glyph[gy]![column + 1];
					const face = !right || right === " " ? rightFace : !left || left === " " ? leftFace : ink;
					const upper = above === "█" || above === "▄" ? face : highlight;
					const lower = below === "█" || below === "▀" ? face : lowerFace;
					rows[gy]!.push(
						upper === lower
							? paintStepLogoColor(upper, " ", "bg")
							: paintStepLogoColor(upper, `\x1b[4m${paintStepLogoColor(lower, "▄")}\x1b[24m`, "bg"),
					);
				} else if (cell === "▄") {
					rows[gy]!.push(`\x1b[4m${paintStepLogoColor(highlight, "▄")}\x1b[24m`);
				} else {
					rows[gy]!.push(
						above === "█" || above === "▄"
							? `\x1b[7m\x1b[4m${paintStepLogoColor(lowerFace, "▄")}\x1b[24m\x1b[27m`
							: `\x1b[53m${paintStepLogoColor(lowerFace, "▀")}\x1b[55m`,
					);
				}
			}
		}
		if (ch !== " ") seen += 1;
		for (let gy = 0; gy < STEP_WORDMARK_ROWS; gy += 1) rows[gy]!.push(undefined);
	}
	for (let gy = 0; gy < STEP_WORDMARK_ROWS; gy += 1) rows[gy]!.pop();
	return rows;
}
