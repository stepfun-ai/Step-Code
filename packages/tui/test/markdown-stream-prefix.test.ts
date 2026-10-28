import assert from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Markdown } from "../src/components/markdown.ts";
import { resetCapabilitiesCache, setCapabilities } from "../src/terminal-image.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";

/**
 * Streaming equivalence for the incremental renderer.
 *
 * A streamed reply calls `setText` with a growing prefix of the same document.
 * The renderer keeps the rows of blocks it has certified as final, so the oracle
 * has to be a *cold* instance: a freshly constructed `Markdown` has no certified
 * prefix and always renders the whole document.
 *
 * Every assertion compares complete line arrays byte for byte. Nothing is
 * trimmed or ANSI-stripped: a cache that changes one trailing space or one colour
 * escape is a regression, not a rounding error.
 */

function cold(text: string, width: number): string[] {
	return new Markdown(text, 0, 0, defaultMarkdownTheme, undefined, {}).render(width);
}

function checkPrefixes(document: string, width: number, label: string): void {
	const streamed = new Markdown("", 0, 0, defaultMarkdownTheme, undefined, {});
	for (let end = 1; end <= document.length; end++) {
		const prefix = document.slice(0, end);
		streamed.setText(prefix);
		assert.deepStrictEqual(
			streamed.render(width),
			cold(prefix, width),
			`${label}: prefix ${end}/${document.length} diverged at width ${width}`,
		);
	}
}

function firstChangedLine(previous: readonly string[], next: readonly string[]): number {
	const shared = Math.min(previous.length, next.length);
	for (let index = 0; index < shared; index++) {
		if (previous[index] !== next[index]) {
			return index;
		}
	}
	return shared;
}

/**
 * Fixtures that break a naive "freeze everything but the last block" cache.
 *
 * Each entry names the construct that would be corrupted: setext underlines that
 * reach back across blocks, lists that merge across blank lines, tables whose
 * column widths change with a later row, reference definitions that reinterpret
 * earlier links, and code rows that change how an identical prose row wraps.
 */
const HAZARDS: ReadonlyArray<readonly [string, string]> = [
	["setext-after-blank", "a\n\nb\n\nc\n=\n"],
	["setext-across-thematic-break", "a\n***\nb\n=\n"],
	["table-gains-a-row", "| a | b |\n| - | - |\n| 1 | 2 |\n\nprose\n\n| c | d |\n| - | - |\n| 3 | 4 |\n"],
	[
		"table-column-widens",
		"| a | b |\n| - | - |\n| 1 | 2 |\n\nprose\n\n| a | b |\n| - | - |\n| a much longer cell | 2 |\n",
	],
	["list-merges-across-blank", "- a\n\n- b\n\nprose\n\n- c\n\n- d\n"],
	["ordered-list-restarts", "1. one\ncontinuation\n\n1. two\n\nprose\n\n1. three\n"],
	["reference-definition-late", "use [x] now\n\nprose\n\n[x]: https://example.com\n\nuse [x] again\n"],
	["reference-definition-spans-blank", "[x\n\nword\n\nnext]: https://example.com\n\nafter\n"],
	["reference-definition-escaped-label", "prose\n\n[x\\]y]: https://example.com\n\ntail\n"],
	["html-block-unclosed", "prose\n\n<div>\nraw\n\nmore\n</div>\n\ntail\n"],
	["html-inline-anchor-open", 'intro <a href="x">open\n\nhttps://example.com\n\nmore\n'],
	["html-inline-anchor-closed", 'intro <a href="x">open</a>\n\nhttps://example.com\n\nmore\n'],
	["indented-code-continues", "prose\n\n    code line\n\n    more code\n\ntail\n"],
	[
		"code-row-collides-with-prose",
		"a paragraph that duplicates a code row\n\nprose\n\n```\na paragraph that duplicates a code row\n```\n\ntail\n",
	],
	[
		"code-row-collides-backwards",
		"```\na paragraph that duplicates a code row\n```\n\nprose\n\na paragraph that duplicates a code row\n\ntail\n",
	],
	["code-then-identical-prose", "```\nhello world\n```\n\nhello world\n\ntail\n"],
	["blockquote-lazy-continuation", "> a\nlazy\n\nprose\n\n> b\nlazy2\n"],
	["block-math-closed", "$$\nx\n$$\n\nprose\n\nmore\n"],
	["block-math-pending-flip", "a\n\n$$\n` \\\n$\\\n.$\n\n\n\n\n\\~`a>\n\nnext\n"],
	["inline-dollar-amount", "cost is $5 today\n\nprose\n"],
	["bracket-math-pending", "\\[\nE = mc^2\n\nmore\n"],
	["fence-unclosed", "prose\n\n```ts\nconst a = 1;\n\nmore\n"],
	["fence-partial-closer", "prose\n\n```ts\nconst a = 1;\n``\n\nmore\n"],
	["fence-inside-list", "- item\n  ```\n  code\n  ```\n\nprose\n"],
	["nested-list", "- a\n  - b\n\n- c\n\nprose\n"],
	["heading-without-blank", "# h\npara\n\n## h2\npara2\n"],
	["thematic-break-vs-setext", "a\n---\n\nb\n\n---\n\nc\n"],
	["task-list", "- [ ] a\n\n- [x] b\n\nprose\n"],
	["underscore-emphasis", "a_b_c\n\nprose\n\nd_e_f\n"],
	["backslash-hard-break", "a\\\nb\n\nprose\n\nc\\\nd\n"],
	["trailing-spaces", "a  \n\nb  \n\nc  \n"],
	["tab-normalisation", "a\n\tb\n\nc\n"],
	["crlf", "a\r\n\r\nb\r\n\r\nc\r\n"],
	["blank-line-runs", "a\n\n\n\n\nb\n\n\nc\n"],
	["emphasis-arrives-late", "plain text\n\nmore text\n\n**bold arrives later**\n"],
	["paragraph-continuation", "intro\n\nfirst line\nsecond line\n\nthird\n"],
	["image-line", "intro\n\n![alt](https://example.com/x.png)\n\ntail\n"],
	["empty-first-block", "\n\nfirst\n\nsecond\n"],
];

describe("Markdown streaming", () => {
	describe("prefix equivalence", () => {
		for (const [name, document] of HAZARDS) {
			it(`matches a cold render for every prefix: ${name}`, () => {
				for (const width of [20, 40, 80]) {
					checkPrefixes(document, width, name);
				}
			});
		}

		it("matches a cold render when prefixed by an unrelated document", () => {
			const preamble = "# Title\n\nA first paragraph.\n\n- a\n- b\n\n";
			for (const [, document] of HAZARDS) {
				checkPrefixes(preamble + document, 60, "with preamble");
			}
		});
	});

	describe("delivery shape", () => {
		const document =
			"# Heading\n\nFirst paragraph with `code` and **bold**.\n\n- one\n- two\n\n```ts\nconst a = 1;\n```\n\nLast paragraph.\n";

		for (const delta of [1, 2, 7, 120]) {
			it(`matches a cold render when delivered in ${delta}-character deltas`, () => {
				const streamed = new Markdown("", 0, 0, defaultMarkdownTheme, undefined, {});
				for (let end = delta; end < document.length; end += delta) {
					streamed.setText(document.slice(0, end));
					streamed.render(60);
				}
				streamed.setText(document);
				assert.deepStrictEqual(streamed.render(60), cold(document, 60));
			});
		}

		it("does not mutate arrays it already returned", () => {
			const streamed = new Markdown("first paragraph\n\n", 0, 0, defaultMarkdownTheme, undefined, {});
			const first = streamed.render(60);
			const snapshot = [...first];
			streamed.setText("first paragraph\n\nsecond paragraph that is long enough to wrap across the width\n\n");
			streamed.render(60);
			assert.deepStrictEqual(first, snapshot);
		});

		it("returns the same array instance when nothing changed", () => {
			const streamed = new Markdown("a paragraph\n\nanother\n", 0, 0, defaultMarkdownTheme, undefined, {});
			const first = streamed.render(60);
			assert.strictEqual(streamed.render(60), first);
		});

		it("reports a dirty start at or before the first changed line", () => {
			const streamed = new Markdown("first paragraph\n\n", 0, 0, defaultMarkdownTheme, undefined, {});
			let previous = streamed.render(60);
			const prefixes = [
				"first paragraph\n\nsecond",
				"first paragraph\n\nsecond paragraph\n\nthird",
				"first paragraph\n\nsecond paragraph\n\nthird paragraph\n\nfourth",
			];
			for (const prefix of prefixes) {
				streamed.setText(prefix);
				const next = streamed.render(60);
				const changed = firstChangedLine(previous, next);
				assert.ok(
					(streamed.renderDirtyStart ?? 0) <= changed,
					`dirty start ${streamed.renderDirtyStart} is after the first change at ${changed}`,
				);
				previous = next;
			}
		});

		it("matches a cold render after a replacement and after a width change", () => {
			const streamed = new Markdown("first\n\nsecond\n\n", 0, 0, defaultMarkdownTheme, undefined, {});
			streamed.render(60);
			streamed.setText("replaced document\n\nwith two paragraphs\n\n");
			assert.deepStrictEqual(streamed.render(60), cold("replaced document\n\nwith two paragraphs\n\n", 60));
			streamed.setText("replaced document\n\nwith two paragraphs\n\nand a third\n\n");
			assert.deepStrictEqual(
				streamed.render(40),
				cold("replaced document\n\nwith two paragraphs\n\nand a third\n\n", 40),
			);
			assert.deepStrictEqual(
				streamed.render(60),
				cold("replaced document\n\nwith two paragraphs\n\nand a third\n\n", 60),
			);
		});

		it("matches a cold render after invalidate", () => {
			const streamed = new Markdown("first\n\nsecond\n\n", 0, 0, defaultMarkdownTheme, undefined, {});
			streamed.render(60);
			streamed.setText("first\n\nsecond\n\nthird\n\n");
			streamed.invalidate();
			assert.deepStrictEqual(streamed.render(60), cold("first\n\nsecond\n\nthird\n\n", 60));
		});

		it("reports no reusable prefix after invalidate", () => {
			// Padding rows are identical empty rows, but a style change repaints them, so
			// a whole-document render must not claim they are unchanged.
			const streamed = new Markdown("first\n\nsecond\n\n", 0, 1, defaultMarkdownTheme, undefined, {});
			streamed.render(60);
			streamed.setText("first\n\nsecond\n\nthird\n\n");
			streamed.invalidate();
			streamed.render(60);
			assert.strictEqual(streamed.renderDirtyStart, 0);
		});
	});

	describe("document-wide parse state", () => {
		// Marked keeps `inLink`/`inRawBlock` on the lexer for the whole document, so an
		// unbalanced anchor in a certified prefix changes how a later URL is parsed.
		// The difference is only visible with hyperlink support enabled: without it a
		// bare URL renders as plain text either way.
		it("does not freeze an unbalanced inline anchor", () => {
			setCapabilities({ images: null, trueColor: true, hyperlinks: true });
			try {
				for (const doc of [
					'intro <a href="x">open\n\nhttps://example.com\n\n',
					'intro\n\n<a href="x">open\n\nfirst tail paragraph\n\nhttps://example.com\n\nsecond tail\n\n',
				]) {
					checkPrefixes(doc, 80, "unbalanced anchor");
				}
			} finally {
				resetCapabilitiesCache();
			}
		});

		it("does not freeze a reference label that is still open", () => {
			// The definition tokenizer runs before `paragraph` and its label may span
			// blank lines, so an open `[` can turn already rendered paragraphs into one
			// definition once `]:` arrives.
			for (const doc of [
				"[x\n\nprose\n\ntail\n\nmore\n\n]: https://example.com\n\nafter\n",
				"first paragraph\n\n[note\n\ninterlude\n\n]: https://example.com\n\ntail\n",
			]) {
				checkPrefixes(doc, 80, "open reference label");
			}
		});
	});

	describe("repository documents", () => {
		// Sampling: a repository document can be tens of kilobytes, and a cold render
		// per prefix would dominate the suite. Small fixtures above cover every prefix.
		const files = [
			new URL("../../../README.md", import.meta.url),
			new URL("../../../docs/development.md", import.meta.url),
			new URL("../../../docs/tui-rendering-pipeline.md", import.meta.url),
		];

		for (const file of files) {
			it(`matches a cold render at sampled prefixes: ${file.pathname.split("/").pop()}`, () => {
				const document = readFileSync(file, "utf8");
				const streamed = new Markdown("", 0, 0, defaultMarkdownTheme, undefined, {});
				const step = Math.max(1, Math.floor(document.length / 60));
				for (let end = 1; end <= document.length; end += step) {
					const prefix = document.slice(0, end);
					streamed.setText(prefix);
					assert.deepStrictEqual(streamed.render(100), cold(prefix, 100), `prefix ${end}/${document.length}`);
				}
			});
		}
	});

	describe("adversarial combinations", () => {
		// Deterministic block-level combination generator. A runtime seed would make a
		// failure impossible to reproduce, so the sequence is fixed.
		const shards = [
			"para text here\n\n",
			"second line\n\n",
			"- item\n",
			"- item\n\n",
			"  - nested\n",
			"1. one\n",
			"> quote\n",
			"lazy\n",
			"```\ncode\n```\n\n",
			"```ts\nconst a=1;\n",
			"# h\n\n",
			"## h2\n\n",
			"| a | b |\n| - | - |\n| 1 | 2 |\n\n",
			"| 3 | 4 |\n",
			"---\n\n",
			"    indented\n",
			"$$\nx\n$$\n\n",
			"$$\n",
			"\\[\nx\n\\]\n\n",
			"[x]: https://example.com\n\n",
			"use [x]\n",
			"a\n",
			"b\n",
			"\n",
			"\n\n",
			"\\\n",
			"word word word\n\n",
			'<a href="x">\n\n',
			"<div>\n",
			"</div>\n\n",
			"hello world\n\n",
			"1.\n",
			"1. x\n",
		];

		function nextRandom(state: { seed: number }): number {
			state.seed ^= state.seed << 13;
			state.seed ^= state.seed >>> 17;
			state.seed ^= state.seed << 5;
			return Math.abs(state.seed);
		}

		it("matches a cold render for 200 seeded documents", () => {
			const state = { seed: 0x51ab37 };
			for (let index = 0; index < 200; index++) {
				let document = "";
				const blockCount = 2 + (nextRandom(state) % 8);
				for (let block = 0; block < blockCount; block++) {
					document += shards[nextRandom(state) % shards.length];
				}
				const width = 30 + (nextRandom(state) % 90);
				checkPrefixes(document, width, `seeded document ${index} (seed 0x51ab37)`);
			}
		});
	});
});
