import { afterEach, describe, expect, it, vi } from "vitest";
import { getMarkdownTheme, getThemeByName, highlightCode, initTheme, setRegisteredThemes } from "../src/theme/theme.ts";
import * as syntax from "../src/utils/syntax-highlight.ts";

/**
 * The highlight cache is a pure-function memo keyed on (theme instance, language,
 * source). Its whole point is to stop a streaming re-render from re-highlighting
 * fenced blocks that finished minutes ago, so the cases that matter are the ones
 * where a stale or shared entry would be served:
 *
 * - a theme switch must not serve the previous theme's ANSI;
 * - a caller that mutates the returned array must not reach the cache
 *   (`core/tools/write.ts` does exactly that while a file streams);
 * - an explicit theme passed to `getMarkdownTheme()` must not share entries with
 *   the global one;
 * - the two entry points keep their own error fallbacks.
 *
 * Colours are asserted through the theme's own `syntaxKeyword` so the test does not
 * hard-code ANSI.
 */

const CODE = "export function greet(name: string): string {\n  return name;\n}";

function keywordColour(themeName: string): string {
	const t = getThemeByName(themeName);
	expect(t, `theme ${themeName} should be registered`).toBeDefined();
	return t!.fg("syntaxKeyword", "KEYWORD");
}

afterEach(() => {
	initTheme("dark");
});

describe("highlight cache", () => {
	it("serves a repeated call from the cache instead of re-highlighting", () => {
		initTheme("dark");
		const first = highlightCode(CODE, "typescript");
		expect(first.length).toBeGreaterThan(1);

		// Counting invocations is the only way to tell "cached" from "deterministic".
		const spy = vi.spyOn(syntax, "highlight");
		const second = highlightCode(CODE, "typescript");
		expect(second).toEqual(first);
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});

	it("does not serve a cached entry after the theme changes", () => {
		initTheme("dark");
		const darkLines = highlightCode(CODE, "typescript");
		const darkKeyword = keywordColour("dark");

		// A theme whose keyword colour differs from the default, so a stale entry is visible.
		const themes = ["dark", "light"].map((name) => getThemeByName(name)).filter((t) => t !== undefined);
		setRegisteredThemes(themes as never);
		initTheme("light");

		const lightLines = highlightCode(CODE, "typescript");
		const lightKeyword = keywordColour("light");
		expect(lightKeyword).not.toEqual(darkKeyword);
		expect(lightLines.join("\n")).not.toEqual(darkLines.join("\n"));
		expect(lightLines.join("\n")).toContain("greet");
	});

	it("keeps entries for an explicitly passed theme separate from the global one", () => {
		initTheme("dark");
		const explicit = getThemeByName("light");
		expect(explicit).toBeDefined();

		const explicitLines = getMarkdownTheme(explicit!).highlightCode!(CODE, "typescript");
		const globalLines = getMarkdownTheme().highlightCode!(CODE, "typescript");

		// Both are correct for their own theme, so they must not be the same strings
		// once the themes render keywords differently.
		expect(explicitLines.join("\n")).not.toEqual(globalLines.join("\n"));

		// And asking again in the other order must not flip either of them.
		expect(getMarkdownTheme(explicit!).highlightCode!(CODE, "typescript")).toEqual(explicitLines);
		expect(getMarkdownTheme().highlightCode!(CODE, "typescript")).toEqual(globalLines);
	});

	it("returns a private array so a mutating caller cannot corrupt the cache", () => {
		initTheme("dark");
		// Snapshot by value: comparing against another call's return value would alias
		// the cache entry and hide exactly the corruption this test exists to catch.
		const expected = [...highlightCode(CODE, "typescript")];

		// Mirrors core/tools/write.ts, which stores the result and then appends to it.
		const mutated = highlightCode(CODE, "typescript");
		mutated[0] = "corrupted";
		mutated.push("extra");

		expect([...highlightCode(CODE, "typescript")]).toEqual(expected);
	});

	it("keys on language as well as source", () => {
		initTheme("dark");
		const asTs = highlightCode(CODE, "typescript");
		const asJson = highlightCode(CODE, "json");
		expect(asJson).not.toEqual(asTs);
	});

	it("still renders when the number of distinct blocks exceeds the cache size", () => {
		initTheme("dark");
		const blocks = Array.from({ length: 400 }, (_, i) => `const value${i} = ${i};\n`);
		for (const block of blocks) {
			const lines = highlightCode(block, "typescript");
			expect(lines.join("\n")).toContain(`value`);
		}
		// The first block must have been evicted, and recomputing it must still be correct.
		expect(highlightCode(blocks[0]!, "typescript").join("\n")).toContain("value0");
	});

	it("does not cache sources above the size limit but still renders them", () => {
		initTheme("dark");
		const huge = Array.from({ length: 8000 }, (_, i) => `const value${i} = ${i};`).join("\n");
		expect(huge.length).toBeGreaterThan(64 * 1024);
		const lines = highlightCode(huge, "typescript");
		expect(lines.length).toBe(8000);
	});

	it("does not let one entry point poison the other's result", () => {
		// The two entry points share the cache but keep their own try/catch fallbacks, so a
		// cached value must be the *highlighted* result, never a fallback produced by a
		// different path. Same input through both must agree.
		initTheme("dark");
		const bare = highlightCode(CODE, "typescript");
		const wrapped = getMarkdownTheme().highlightCode!(CODE, "typescript");
		expect(wrapped).toEqual(bare);
	});

	it("returns plain code when the language is unknown", () => {
		initTheme("dark");
		const lines = highlightCode("not code at all", "definitely-not-a-language");
		expect(lines).toEqual([expect.stringContaining("not code at all")]);
	});
});
