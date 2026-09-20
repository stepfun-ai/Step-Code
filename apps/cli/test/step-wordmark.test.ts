import { stripTerminalSequences, visibleWidth } from "@step-harness/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initTheme, Theme } from "../../../packages/coding-agent/src/theme/theme.ts";
import {
	renderStepWordmarkCells,
	STEP_WORDMARK_COLUMNS,
	STEP_WORDMARK_ROWS,
} from "../src/ui/view/chrome/step-wordmark.ts";

beforeEach(() => {
	initTheme("step-blue");
	vi.spyOn(Theme.prototype, "getColorMode").mockReturnValue("truecolor");
});
afterEach(() => {
	vi.restoreAllMocks();
	initTheme("dark");
});

describe("wordmark half-cell seams", () => {
	it("fills connected upper corners from the cell background and clears the lower half", () => {
		const cells = renderStepWordmarkCells();
		for (const [row, column] of [[4, 0], [7, 9], [7, 16], [7, 19], [4, 33], [7, 26], [7, 35]]) {
			const cell = cells[row!]![column!]!;
			expect(cell).toContain("\x1b[7m\x1b[4m");
			expect(stripTerminalSequences(cell)).toBe("▄");
			expect(cell).toMatch(/\x1b\[24m\x1b\[27m$/u);
		}
	});

	it("seals lower corners and keeps the highlighted upper half separate from the base", () => {
		const cells = renderStepWordmarkCells();
		expect(cells[0]![0]).toBe("\x1b[4m\x1b[38;2;206;191;246m▄\x1b[39m\x1b[24m");
		expect(cells[0]![1]).toBe(
			"\x1b[48;2;206;191;246m\x1b[4m\x1b[38;2;170;145;240m▄\x1b[39m\x1b[24m\x1b[49m",
		);
		expect(cells[1]![1]).toBe("\x1b[48;2;170;145;240m \x1b[49m");
	});

	it("lights the left rim and shades the right and bottom inside the existing face", () => {
		const cells = renderStepWordmarkCells();
		expect(cells[2]![0]).toBe("\x1b[48;2;180;158;242m \x1b[49m");
		expect(cells[2]![1]).toBe("\x1b[48;2;170;145;240m \x1b[49m");
		expect(cells[2]![3]).toBe("\x1b[48;2;129;110;182m \x1b[49m");
		expect(cells[7]![1]).toBe(
			"\x1b[48;2;170;145;240m\x1b[4m\x1b[38;2;116;99;163m▄\x1b[39m\x1b[24m\x1b[49m",
		);
		expect(cells[7]![9]).toContain("\x1b[38;2;116;99;163m");
		expect(cells[2]![4]).toBeUndefined();
		// The trailing E stem reaches the word's end (the gold letter of the
		// gradient); its exact face bytes are covered by the S-cell assertions.
		expect(cells[2]![93]).toBeDefined();
	});

	it("preserves dimensions, holes and transparent spacing at both color depths", () => {
		const truecolor = renderStepWordmarkCells();
		expect(truecolor).toHaveLength(STEP_WORDMARK_ROWS);
		expect(STEP_WORDMARK_COLUMNS).toBe(101);
		expect(truecolor[8]!.every((cell) => cell === undefined)).toBe(true);
		expect(truecolor[2]!.slice(4, 12).every((cell) => cell === undefined)).toBe(true);
		for (const row of truecolor) {
			expect(row).toHaveLength(STEP_WORDMARK_COLUMNS);
			for (const cell of row) if (cell !== undefined) expect(visibleWidth(cell)).toBe(1);
		}
		vi.mocked(Theme.prototype.getColorMode).mockReturnValue("256color");
		const reduced = renderStepWordmarkCells();
		expect(reduced.map((row) => row.map((cell) => cell === undefined ? undefined : stripTerminalSequences(cell)))).toEqual(
			truecolor.map((row) => row.map((cell) => cell === undefined ? undefined : stripTerminalSequences(cell))),
		);
		expect(reduced.flat().join("")).not.toContain(";2;");
	});
});
