import { stripTerminalSequences, visibleWidth } from "@step-harness/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initTheme, Theme } from "../../../packages/coding-agent/src/theme/theme.ts";
import {
	BIRD_SPRITE_FRAMES,
	BIRD_SPRITE_PALETTE,
	BIRD_SPRITE_STATIC,
} from "../src/ui/view/chrome/step-logo-sprite.generated.ts";
import {
	BIRD_COLUMNS,
	BIRD_ROWS,
	createStepLogoTheme,
	renderBirdFrame,
	renderBirdStatic,
} from "../src/ui/view/chrome/step-logo.ts";

/** Decode actual SGR + half-block output, including both independently colored halves. */
function decodeLine(line: string): (string | undefined)[] {
	let fg: string | undefined;
	let bg: string | undefined;
	let underline = false;
	let overline = false;
	let inverse = false;
	const pixels: (string | undefined)[] = [];
	for (const token of line.match(/\x1b\[[\d;]+m|[^\x1b]/gu) ?? []) {
		if (token.startsWith("\x1b")) {
			const codes = token.slice(2, -1).split(";").map(Number);
			if (codes[0] === 39) fg = undefined;
			else if (codes[0] === 49) bg = undefined;
			else if (codes[0] === 7) inverse = true;
			else if (codes[0] === 27) inverse = false;
			else if (codes[0] === 4) underline = true;
			else if (codes[0] === 24) underline = false;
			else if (codes[0] === 53) overline = true;
			else if (codes[0] === 55) overline = false;
			else {
				expect(codes[1]).toBe(2);
				const hex = `#${codes.slice(2).map((v) => v.toString(16).padStart(2, "0")).join("")}`;
				if (codes[0] === 38) fg = hex;
				else if (codes[0] === 48) bg = hex;
				else throw new Error(`Unexpected SGR: ${token}`);
			}
		} else {
			expect(" ▀▄").toContain(token);
			// Edge decoration is confined to the opaque half; no style leaks
			// into a transparent cell or the following welcome facts.
			expect(underline).toBe(token === "▄");
			expect(overline).toBe(token === "▀" && bg === undefined);
			const ink = inverse ? bg : fg;
			const paper = inverse ? fg : bg;
			pixels.push(token === "▀" ? ink : paper);
			pixels.push(token === "▄" ? ink : paper);
		}
	}
	expect(fg).toBeUndefined();
	expect(bg).toBeUndefined();
	expect(underline).toBe(false);
	expect(overline).toBe(false);
	expect(inverse).toBe(false);
	return pixels;
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	initTheme("dark");
});

describe("approved pelican sprite", () => {
	it("retains every pixel and transparent hole in all frames and the PNG", () => {
		initTheme("step-blue");
		vi.spyOn(Theme.prototype, "getColorMode").mockReturnValue("truecolor");
		const painter = createStepLogoTheme();
		expect([BIRD_COLUMNS, BIRD_ROWS]).toEqual([20, 9]);
		const sources = [...BIRD_SPRITE_FRAMES, BIRD_SPRITE_STATIC];
		const rendered = [...BIRD_SPRITE_FRAMES.map((_, i) => renderBirdFrame(painter, i)), renderBirdStatic(painter)];
		for (const [index, rows] of rendered.entries()) {
			expect(rows).toHaveLength(9);
			for (const [y, line] of rows.entries()) {
				expect(visibleWidth(line)).toBe(20);
				expect(decodeLine(line)).toEqual(
					Array.from(sources[index]![y]!, (digit) => BIRD_SPRITE_PALETTE[Number.parseInt(digit, 16) - 1]),
				);
			}
		}
		expect(rendered[0]).toEqual(renderBirdStatic(painter));
		expect(rendered[7]).not.toEqual(renderBirdStatic(painter));
	});

	it("keeps a single lower-right eye highlight and a connected tail in every frame", () => {
		initTheme("step-blue");
		vi.spyOn(Theme.prototype, "getColorMode").mockReturnValue("truecolor");
		const painter = createStepLogoTheme();
		for (let frame = 0; frame < BIRD_SPRITE_FRAMES.length; frame++) {
			const rows = renderBirdFrame(painter, frame).map(decodeLine);
			expect(rows[2]!.slice(12, 16)).toEqual(["#242132", "#242132", "#242132", "#fff6dc"]);
			expect(rows[3]!.slice(4, 10)).toEqual(Array(6).fill("#aa91f0"));
		}
	});

	it("joins same-color vertical seams without filling wheel holes", () => {
		initTheme("step-blue");
		const painter = createStepLogoTheme();
		for (const [frameIndex, source] of BIRD_SPRITE_FRAMES.entries()) {
			const rendered = renderBirdFrame(painter, frameIndex);
			for (const [y, row] of source.entries()) {
				let connected = 0;
				for (let x = 0; x < row.length; x += 2) {
					if (row[x] !== "0" && row[x + 1] === "0" && source[y - 1]?.[x + 1] === row[x]) connected++;
				}
				expect(rendered[y]!.split("\x1b[7m").length - 1).toBe(connected);
			}
		}
	});

	it("keeps the same glyph geometry across terminal brands and color depths", () => {
		initTheme("step-blue");
		const mode = vi.spyOn(Theme.prototype, "getColorMode").mockReturnValue("truecolor");
		const painter = createStepLogoTheme();
		const reference = renderBirdStatic(painter);
		for (const terminal of ["Apple_Terminal", "iTerm.app", "WezTerm", "ghostty", "vscode"]) {
			vi.stubEnv("TERM_PROGRAM", terminal);
			expect(renderBirdStatic(painter)).toEqual(reference);
		}
		mode.mockReturnValue("256color");
		const reduced = renderBirdStatic(painter);
		expect(reduced.map(stripTerminalSequences)).toEqual(reference.map(stripTerminalSequences));
		expect(reduced.join("")).toContain("\x1b[38;5;");
		expect(reduced.join("")).toContain("\x1b[48;5;");
		expect(reduced.join("")).not.toContain(";2;");
	});
});
