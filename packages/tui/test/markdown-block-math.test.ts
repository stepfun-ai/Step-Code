import assert from "node:assert";
import { describe, it } from "node:test";
import { Markdown, type MarkdownTheme } from "../src/components/markdown.ts";

/**
 * Block-math tokenizer coverage.
 *
 * `latexBlock` is a Marked block-level extension, so its `start()` runs at every
 * block boundary with the *unconsumed remainder* as the haystack. The regex it
 * uses can only match when that remainder still contains a block-math opener, so
 * `start()` short-circuits on a substring check first. These tests pin the
 * behaviour on both sides of that short-circuit:
 *
 * - documents without block math must render exactly as before, and
 * - documents with block math must still tokenize, including the pending forms
 *   a streamed reply produces before its closing delimiter arrives.
 *
 * Any change that makes the prefilter skip a real opener shows up as a math
 * block rendering as literal text.
 */

const identity = (text: string) => text;

const theme: MarkdownTheme = {
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

/** Render with padding stripped, so assertions read as visible text. */
function lines(markdown: string, width = 80): string[] {
	const rendered = new Markdown(markdown, 0, 0, theme, undefined, {}).render(width);
	return rendered.map((line) => line.replace(/\s+$/u, ""));
}

describe("Markdown block math", () => {
	describe("dollar-delimited blocks", () => {
		it("renders a complete block", () => {
			// LaTeX is rendered to Unicode, so the assertion pins the rendered form.
			assert.deepStrictEqual(lines("$$\nE = mc^2\n$$"), ["E = mc²"]);
		});

		it("renders every prefix of a streamed block without losing content", () => {
			// A streamed reply renders every prefix. Each frame must match a cold render
			// of the same prefix, whichever side of the delimiter it lands on.
			const full = "$$\n\\int_0^1 x^2 dx\n$$\n";
			const streamed = new Markdown("", 0, 0, theme, undefined, {});
			for (let end = 1; end <= full.length; end++) streamed.setText(full.slice(0, end));
			for (let end = 1; end <= full.length; end++) {
				const prefix = full.slice(0, end);
				streamed.setText(prefix);
				assert.deepStrictEqual(
					streamed.render(80).map((line) => line.replace(/\s+$/u, "")),
					lines(prefix),
					`prefix of ${end}/${full.length} chars diverged`,
				);
			}
		});

		it("keeps a dollar in prose as prose", () => {
			assert.deepStrictEqual(lines("cost is $5 today"), ["cost is $5 today"]);
		});

		it("keeps an escaped dollar as prose", () => {
			assert.deepStrictEqual(lines("cost is \\$5 today"), ["cost is $5 today"]);
		});
	});

	describe("bracket-delimited blocks", () => {
		it("renders a complete block", () => {
			assert.deepStrictEqual(lines("\\[\nE = mc^2\n\\]"), ["E = mc²"]);
		});

		it("keeps the opener as text while the closer is still missing", () => {
			// Pending bracket math only becomes a block once its closer arrives; until
			// then the opener is an ordinary line. Pinned so the prefilter cannot make
			// a pending opener disappear early.
			assert.deepStrictEqual(lines("\\[\nE = mc^2"), ["\\[", "E = mc^2"]);
		});

		it("starts a block on a paragraph continuation line", () => {
			// `start()`'s hint is load-bearing here: without it the paragraph rule
			// swallows the opener, so a prefilter that misses this opener renders the
			// math as literal text instead of converting it.
			assert.deepStrictEqual(lines("intro text\n\\[\nE = mc^2\n\\]"), ["intro text", "", "E = mc²"]);
			assert.deepStrictEqual(lines("intro text\n$$\nE = mc^2\n$$"), ["intro text", "", "E = mc²"]);
		});
	});

	describe("short-circuit does not change ordinary documents", () => {
		it("still renders every non-math block shape", () => {
			const cases: Array<[string, string, string[]]> = [
				["heading", "# Title", ["# Title"]],
				["code fence", "```ts\nconst a = 1;\n```", ["```ts", "  const a = 1;", "```"]],
				["list", "- one\n- two", ["- one", "- two"]],
				["quote", "> quoted", ["│ quoted"]],
				["table", "| a | b |\n| --- | --- |\n| 1 | 2 |", ["a  b", "━  ━", "1  2"]],
			];
			for (const [name, source, expected] of cases) {
				assert.deepStrictEqual(lines(source), expected, `${name} changed`);
			}
		});

		it("does not treat a bracket inside a fence as a math opener", () => {
			// The prefilter looks at the raw remainder, so `\[` inside a fence is a
			// false positive: it must fall through to the regex, which rejects it.
			const rendered = lines("```\nfoo \\[ bar\n```");
			assert.ok(
				rendered.some((line) => line.includes("foo \\[ bar")),
				"fenced content was rewritten",
			);
		});

		it("runs the block-math regex only when an opener is present", () => {
			// Assert work, not wall-clock: the guard must not depend on machine speed.
			// `start()` runs once per block boundary, so a math-free document with many
			// blocks would execute the pattern many times without the prefilter.
			const blockMathPattern = (markdown: string): boolean => {
				const rendered = new Markdown(markdown, 0, 0, theme, undefined, {}).render(80);
				return rendered.length > 0;
			};

			const paragraph = "a paragraph of ordinary prose without any math delimiters.\n\n";

			const originalExec = RegExp.prototype.exec;
			let blockMathExecs = 0;
			let totalExecs = 0;
			RegExp.prototype.exec = function patchedExec(this: RegExp, input: string) {
				totalExecs++;
				// The tokenizer's pattern is `/  (?:^|\n) {0,3}(?:\$\$|\\\[)  /`, so its
				// source is the only one carrying an escaped `$$` alternative.
				if (this.source.includes("\\$\\$|")) blockMathExecs++;
				return originalExec.call(this, input);
			};
			try {
				assert.ok(blockMathPattern(paragraph.repeat(400)));
				assert.ok(totalExecs > 0, "no regex ran, so the counter would be vacuous");
				assert.strictEqual(
					blockMathExecs,
					0,
					"the block-math regex ran on a document with no opener, so the prefilter did not short-circuit",
				);

				blockMathExecs = 0;
				assert.ok(blockMathPattern(`${paragraph.repeat(20)}\n$$\nE = mc^2\n$$\n`));
				assert.ok(blockMathExecs > 0, "the block-math regex did not run for a document that has an opener");
			} finally {
				RegExp.prototype.exec = originalExec;
			}
		});
	});
});
