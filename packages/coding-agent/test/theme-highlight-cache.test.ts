import { afterEach, describe, expect, it, vi } from "vitest";
import {
	clearHighlightCache,
	getMarkdownTheme,
	getThemeByName,
	highlightCode,
	initTheme,
	setRegisteredThemes,
} from "../src/theme/theme.ts";
import * as syntax from "../src/utils/syntax-highlight.ts";

/**
 * Highlighted lines are memoized on (theme instance, language, source).
 *
 * The renderer treats a theme as a set of pure functions, so it cannot deduplicate
 * this work itself: a fenced block is highlighted while it is being streamed, and
 * any document that still renders whole re-highlights every finished block on every
 * frame. That makes a stale or shared entry a visible colour bug rather than a
 * slowdown, so the cases below are the ones where an entry could be served for the
 * wrong inputs.
 *
 * Colours are asserted through the theme's own `syntaxKeyword`, so no ANSI literal
 * is hard-coded here.
 */

const CODE = "export function greet(name: string): string {\n  return name;\n}";

/** Re-register the built-in themes a theme-switch case replaced. */
function refreshRegisteredThemes(): void {
	const builtin = ["dark", "light"]
		.map((name) => getThemeByName(name))
		.filter((theme): theme is NonNullable<typeof theme> => theme !== undefined);
	setRegisteredThemes(builtin);
}

function keywordColour(themeName: string): string {
	const t = getThemeByName(themeName);
	expect(t, `theme ${themeName} should be registered`).toBeDefined();
	return t!.fg("syntaxKeyword", "KEYWORD");
}

afterEach(() => {
	initTheme("dark");
	// Every case starts from a cold memo, so none of them depends on another's keys.
	clearHighlightCache();
	// The theme-switch case replaces the registry; leaving it replaced would make a
	// later file's assertions depend on run order.
	refreshRegisteredThemes();
});

describe("highlight memo", () => {
	it("serves a repeated call without re-highlighting", () => {
		initTheme("dark");
		// Two requests, because the memo stores on the second miss (see below).
		const first = highlightCode(CODE, "typescript");
		expect(first.length).toBeGreaterThan(1);
		expect(highlightCode(CODE, "typescript")).toEqual(first);

		// Counting invocations is the only way to tell "memoized" from "deterministic".
		const spy = vi.spyOn(syntax, "highlight");
		expect(highlightCode(CODE, "typescript")).toEqual(first);
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});

	it("does not serve a cached unlabelled fence after the theme changes", () => {
		// Unlabelled fences are restyled line by line from the theme, so they are the
		// cheapest thing to memoize and the easiest to serve stale.
		initTheme("dark");
		const dark = highlightCode("plain fence body", undefined).join("\n");

		const themes = ["dark", "light"].map((name) => getThemeByName(name)).filter((t) => t !== undefined);
		setRegisteredThemes(themes);
		initTheme("light");

		const light = highlightCode("plain fence body", undefined).join("\n");
		expect(light).not.toEqual(dark);
		expect(light).toContain("plain fence body");
	});

	it("does not serve a cached entry after the theme changes", () => {
		initTheme("dark");
		const darkLines = highlightCode(CODE, "typescript");
		const darkKeyword = keywordColour("dark");

		// Register both themes so the switch below is a real theme replacement.
		const themes = ["dark", "light"].map((name) => getThemeByName(name)).filter((t) => t !== undefined);
		setRegisteredThemes(themes);
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
		expect(explicitLines.join("\n")).not.toEqual(globalLines.join("\n"));

		// Asking again in the other order must not flip either result.
		expect(getMarkdownTheme(explicit!).highlightCode!(CODE, "typescript")).toEqual(explicitLines);
		expect(getMarkdownTheme().highlightCode!(CODE, "typescript")).toEqual(globalLines);
	});

	it("returns a private array so a mutating caller cannot corrupt the memo", () => {
		initTheme("dark");
		// Snapshot by value: comparing against another call's return value would alias
		// the memo entry and hide exactly the corruption this test exists to catch.
		const expected = [...highlightCode(CODE, "typescript")];

		// Mirrors core/tools/write.ts, which stores the result and then appends to it.
		const mutated = highlightCode(CODE, "typescript");
		mutated[0] = "corrupted";
		mutated.push("extra");

		expect([...highlightCode(CODE, "typescript")]).toEqual(expected);
	});

	it("keys on language as well as source", () => {
		initTheme("dark");
		expect(highlightCode(CODE, "json")).not.toEqual(highlightCode(CODE, "typescript"));
	});

	it("does not spend the budget on keys that are seen only once", () => {
		// A fence that is still being written yields a new key on every delta, and each
		// prefix is dead as soon as the next one arrives. Retaining those would fill the
		// budget with intermediate versions of one block and evict the finished blocks
		// the memo exists to serve.
		//
		// Unlabelled fences keep this cheap: they are restyled line by line and never
		// reach the highlighter, so the test measures retention rather than hljs.
		initTheme("dark");
		const theme = getMarkdownTheme();
		// The block under test is labelled, so a miss is observable through the
		// highlighter; the flood below is unlabelled, which is cheap and never calls it.
		theme.highlightCode!(CODE, "typescript");
		theme.highlightCode!(CODE, "typescript");

		// Enough distinct one-off sources to exceed the whole payload budget.
		const line = "a plain fence row that is long enough to be worth measuring";
		const prefix = (index: number) => Array.from({ length: 500 }, (_, row) => `${index}-${row} ${line}`).join("\n");
		// ~6 MB of one-off payload, well past the whole budget.
		for (let index = 0; index < 200; index++) theme.highlightCode!(prefix(index), undefined);

		const spy = vi.spyOn(syntax, "highlight");
		theme.highlightCode!(CODE, "typescript");
		expect(spy, "one-off keys consumed the budget and evicted a finished block").not.toHaveBeenCalled();
		spy.mockRestore();
	});

	it("recomputes after the grammar set changes", () => {
		// `highlight.js` resolves embedded sub-languages through one registry, so the
		// same source and language highlight differently before and after the remaining
		// grammars load. A key without the grammar revision would freeze the pre-load
		// result for a block that streams during startup.
		initTheme("dark");
		const source = 'const t = html`<div class="x">hello</div>`;';
		highlightCode(source, "javascript");
		highlightCode(source, "javascript");

		const startRevision = syntax.highlightGrammarRevision();
		const spy = vi.spyOn(syntax, "highlight");
		const revision = vi.spyOn(syntax, "highlightGrammarRevision").mockReturnValue(startRevision + 1);
		highlightCode(source, "javascript");
		revision.mockRestore();
		expect(spy, "the pre-load result was served after the grammar set changed").toHaveBeenCalled();
		spy.mockRestore();
	});

	it("re-highlights a huge source instead of retaining it", () => {
		initTheme("dark");
		const huge = Array.from({ length: 8000 }, (_, index) => `const value${index} = ${index};`).join("\n");
		expect(huge.length).toBeGreaterThan(64 * 1024);

		// The memo needs two requests before it stores anything, so ask twice first.
		highlightCode(huge, "typescript");
		highlightCode(huge, "typescript");

		const spy = vi.spyOn(syntax, "highlight");
		expect(highlightCode(huge, "typescript").length).toBe(8000);
		expect(spy, "a source above the size limit was retained").toHaveBeenCalled();
		spy.mockRestore();
	});

	it("evicts by payload budget rather than entry count", () => {
		initTheme("dark");
		const blocks = Array.from({ length: 200 }, (_, index) =>
			Array.from({ length: 40 }, (_, row) => `const value${index}_${row} = ${row};`).join("\n"),
		);
		// Two requests each, so every block is eligible for storage.
		for (const block of blocks) highlightCode(block, "typescript");
		for (const block of blocks) highlightCode(block, "typescript");

		// The earliest blocks must have been evicted to stay inside the budget, and
		// recomputing them must still be correct.
		const spy = vi.spyOn(syntax, "highlight");
		expect(highlightCode(blocks[0]!, "typescript").join("\n")).toContain("value0_0");
		expect(spy, "nothing was evicted, so the budget is not enforced").toHaveBeenCalled();
		spy.mockRestore();
	});

	it("uses the same fallback on both entry points", () => {
		// One memo, two callers: if their `catch` branches differed, the stored value
		// would depend on which one ran first.
		initTheme("dark");
		const boom = vi.spyOn(syntax, "highlight").mockImplementation(() => {
			throw new Error("highlighter exploded");
		});
		const viaModule = highlightCode(CODE, "typescript");
		const viaTheme = getMarkdownTheme().highlightCode!(CODE, "typescript");
		boom.mockRestore();
		expect(viaTheme).toEqual(viaModule);
	});

	it("agrees between the module entry point and the markdown theme", () => {
		initTheme("dark");
		expect(getMarkdownTheme().highlightCode!(CODE, "typescript")).toEqual(highlightCode(CODE, "typescript"));
	});

	it("returns plain code when the language is unknown", () => {
		initTheme("dark");
		const lines = highlightCode("not code at all", "definitely-not-a-language");
		expect(lines).toEqual([expect.stringContaining("not code at all")]);
	});
});
