import assert from "node:assert";
import { describe, it } from "node:test";
import { Markdown, type MarkdownTheme } from "../src/components/markdown.ts";

/**
 * Streaming render caching.
 *
 * A streaming reply re-renders its whole document on every delta. Lexing the whole
 * document is cheap and keeps Marked's own interpretation authoritative; rendering,
 * wrapping and highlighting are the expensive parts, so they are cached per top-level
 * token.
 *
 * The oracle is a freshly constructed instance, which has an empty cache and therefore
 * always takes the uncached path. Output must be byte-identical at every streamed
 * prefix — a cache that changes what is on screen is worse than no cache.
 */

const identity = (text: string) => text;

const plainTheme: MarkdownTheme = {
	heading: identity,
	link: identity,
	linkUrl: identity,
	code: identity,
	codeBlock: identity,
	codeBlockBorder: identity,
	quote: identity,
	quoteBorder: identity,
	hr: identity,
	listBullet: identity,
	bold: identity,
	italic: identity,
	strikethrough: identity,
	underline: identity,
};

const ansi = (open: string) => (text: string) => `\x1b[${open}m${text}\x1b[0m`;
const styledTheme: MarkdownTheme = {
	heading: ansi("1;36"),
	link: ansi("4;34"),
	linkUrl: ansi("2"),
	code: ansi("33"),
	codeBlock: ansi("32"),
	codeBlockBorder: ansi("2"),
	quote: ansi("3"),
	quoteBorder: ansi("2"),
	hr: ansi("2"),
	listBullet: ansi("36"),
	bold: ansi("1"),
	italic: ansi("3"),
	strikethrough: ansi("9"),
	underline: ansi("4"),
};

const cold = (text: string, width: number, theme: MarkdownTheme) =>
	new Markdown(text, 0, 0, theme, undefined, {}).render(width);

function assertStreamsLikeColdRender(name: string, text: string, width = 60, theme: MarkdownTheme = styledTheme): void {
	const streaming = new Markdown("", 0, 0, theme, undefined, {});
	for (let end = 1; end <= text.length; end++) {
		const prefix = text.slice(0, end);
		streaming.setText(prefix);
		assert.deepStrictEqual(
			streaming.render(width),
			cold(prefix, width, theme),
			`${name}: prefix of ${end}/${text.length} chars diverged from a cold render`,
		);
	}
}

describe("streaming render cache", () => {
	describe("output is byte-identical to an uncached render", () => {
		it("handles a setext underline that reaches back over a thematic break", () => {
			// The case that defeated "keep the last N blocks mutable": the underline turns
			// the whole run into a single heading.
			assertStreamsLikeColdRender("setext over break", "a\n***\nb\n=\n");
			assertStreamsLikeColdRender("setext equals", "para\n\nheading\n===\n\nafter\n");
		});

		it("handles a pending block-math delimiter", () => {
			assertStreamsLikeColdRender("pending $$", "$$\n\nalpha\n\nbeta\n\ngamma\n$$\n");
			assertStreamsLikeColdRender("pending \\[", "\\[\n\nalpha\n\nbeta\n\\]\n");
		});

		it("distinguishes tokens whose source is identical but whose parse differs", () => {
			// Two paragraphs with identical raw text: the first is plain text, the second is
			// a link, because Marked carries inline link state across paragraphs. Keying the
			// cache on `raw` alone would collide here.
			assertStreamsLikeColdRender(
				"inline <a> link state",
				'<a href="x">open\n\nhttps://example.com\n\nclose </a>\n\nhttps://example.com\n\nend\n',
			);
		});

		it("falls back for reference definitions", () => {
			// A definition lives in the document-level link table, so a link's target can
			// change without its own subtree changing.
			assertStreamsLikeColdRender("reference", "uses [x] here\n\none\n\ntwo\n\n[x]: https://e.com\n");
			assertStreamsLikeColdRender("escaped label", "uses [x\\]y] here\n\none\n\n[x\\]y]: https://e.com\n");
		});

		it("handles list numbering across blank lines and nesting", () => {
			assertStreamsLikeColdRender("ordered", "3. three\n4. four\n\n5. five\n\n- a\n  1. x\n  2. y\n");
			assertStreamsLikeColdRender("loose", "- one\n- two\n\n- three\n");
		});

		it("handles tables that grow a wide row", () => {
			assertStreamsLikeColdRender("table", "| a | b |\n| --- | --- |\n| 1 | 2 |\n| very long cell | 4 |\n");
		});

		it("preserves the document-wide no-wrap rule for code rows", () => {
			// Code rows are collected across the whole document before wrapping, so a prose
			// row identical to a later code row stops wrapping. Per-token caching must not
			// lose that coupling.
			assertStreamsLikeColdRender(
				"nowrap collision",
				"  alpha beta gamma delta\n\none\n\ntwo\n\n```\nalpha beta gamma delta\n```\n",
				20,
				plainTheme,
			);
		});

		it("handles the remaining block shapes", () => {
			const cases: Array<[string, string]> = [
				["open fence", "intro\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n"],
				["blockquote", "a\n\n> quoted\n>\n> > deeper\n>\n> more\n\noutro\n"],
				["html block", "a\n\n<div>\ninside\n</div>\n\nmore\n"],
				["indented code", "a\n\n    code one\n    code two\n\nmore\n"],
				["cjk and emoji", "标题\n\n中文段落 🎉 全角。\n\n- 列表\n\n| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n"],
				["inline latex", "a\n\ninline $E = mc^2$ math\n\nmore\n"],
				["long paragraph", `word ${"word ".repeat(200)}\n`],
				[
					"realistic mix",
					"# Head\n\nIntro `code` [link](https://e.com).\n\n```ts\nconst a = 1;\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n- one\n  - nested\n\n> quote\n\nEnd.\n",
				],
			];
			for (const [name, text] of cases) assertStreamsLikeColdRender(name, text);
		});
	});

	describe("cache lifecycle", () => {
		it("stops re-highlighting a block once it is finished", () => {
			// The block is highlighted while it is still being written (its source changes
			// on every delta). Once it is closed, appending unrelated prose must not touch
			// it again — that repeated work is the cost this cache exists to remove.
			let highlights = 0;
			const theme: MarkdownTheme = {
				...plainTheme,
				highlightCode: (code) => {
					highlights++;
					return code.split("\n");
				},
			};
			const streaming = new Markdown("", 0, 0, theme, undefined, {});
			const head = "```ts\nconst a = 1;\n```\n\n";
			for (let end = 1; end <= head.length; end++) {
				streaming.setText(head.slice(0, end));
				streaming.render(60);
			}
			const afterBlockFinished = highlights;
			assert.ok(afterBlockFinished > 0, "the code block was never highlighted");

			const tail = "Paragraph after the block, long enough to wrap at sixty columns.\n\n";
			for (let i = 1; i <= tail.length; i++) {
				streaming.setText(head + tail.slice(0, i));
				streaming.render(60);
			}
			assert.strictEqual(
				highlights,
				afterBlockFinished,
				`appending prose re-highlighted the finished block ${highlights - afterBlockFinished} times`,
			);
		});

		it("re-renders after an explicit invalidate", () => {
			let highlights = 0;
			const theme: MarkdownTheme = {
				...plainTheme,
				highlightCode: (code) => {
					highlights++;
					return code.split("\n");
				},
			};
			const markdown = new Markdown("```ts\nconst a = 1;\n```\n", 0, 0, theme, undefined, {});
			markdown.render(60);
			const afterFirst = highlights;
			markdown.invalidate();
			markdown.render(60);
			assert.ok(highlights > afterFirst, "invalidate did not drop the token cache");
		});

		it("re-renders when the width changes", () => {
			const streaming = new Markdown("", 0, 0, styledTheme, undefined, {});
			const doc = "# head\n\nbody text that will wrap at narrow widths\n\n```ts\nconst a = 1;\n```\n";
			for (let end = 1; end <= doc.length; end += 3) {
				streaming.setText(doc.slice(0, end));
				streaming.render(40);
			}
			for (const width of [40, 20, 80, 40]) {
				assert.deepStrictEqual(streaming.render(width), cold(doc, width, styledTheme));
			}
		});

		it("handles a shrink and a replacement", () => {
			const markdown = new Markdown("", 0, 0, styledTheme, undefined, {});
			const doc = "# first\n\nsecond\n\nthird\n";
			for (let end = 1; end <= doc.length; end++) {
				markdown.setText(doc.slice(0, end));
				markdown.render(60);
			}
			markdown.setText("# first\n");
			assert.deepStrictEqual(markdown.render(60), cold("# first\n", 60, styledTheme));
			markdown.setText("replaced\n\ncontent\n");
			assert.deepStrictEqual(markdown.render(60), cold("replaced\n\ncontent\n", 60, styledTheme));
		});

		it("renders a document with more blocks than the cache holds", () => {
			const streaming = new Markdown("", 0, 0, plainTheme, undefined, {});
			const blocks = Math.ceil(5000 / 6);
			const doc = Array.from({ length: blocks }, (_, i) => `p${i}\n\n`).join("");
			for (const end of [Math.floor(doc.length / 2), doc.length]) {
				streaming.setText(doc.slice(0, end));
				assert.deepStrictEqual(streaming.render(60), cold(doc.slice(0, end), 60, plainTheme));
			}
		});

		it("does not mutate a returned array", () => {
			// Container.render treats an identical array instance as "unchanged".
			const streaming = new Markdown("", 0, 0, styledTheme, undefined, {});
			const doc = "alpha\n\nbeta\n\ngamma\n\ndelta\n";
			streaming.setText(doc.slice(0, 20));
			const first = streaming.render(60);
			const snapshot = [...first];
			for (let end = 20; end <= doc.length; end += 4) {
				streaming.setText(doc.slice(0, end));
				streaming.render(60);
			}
			assert.deepStrictEqual(first, snapshot, "a returned array was mutated by a later render");
		});
	});
});
