import assert from "node:assert";
import { describe, it } from "node:test";
import { Markdown } from "../src/components/markdown.ts";
import { markdownWork, resetMarkdownWork } from "../src/components/markdown-work.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";

/**
 * Work-per-frame gates for streaming.
 *
 * Wall-clock assertions cannot separate "the renderer stopped re-reading finished
 * blocks" from "the machine was busy", and on a loaded CI runner they can fail a
 * real optimization or silently pass a regression. These tests assert the amount
 * of source handed to the lexer, the number of tokens rendered, and the number of
 * rows wrapped instead: for a streamed reply those are the stages that used to be
 * quadratic in the message length.
 */

const SHARD = [
	"A paragraph of prose with `code` and **bold** text that is long enough to wrap at 100 columns.",
	"",
	"- first item",
	"- second item",
	"",
	"```ts",
	"export const value = 1;",
	"```",
	"",
	"| a | b |",
	"| - | - |",
	"| 1 | 2 |",
	"",
	"",
].join("\n");

function build(bytes: number): string {
	let document = "";
	while (document.length < bytes) {
		document += SHARD;
	}
	return document.slice(0, bytes);
}

interface Measurement {
	frames: number;
	lexUnits: number;
	renderedTokens: number;
	wrappedRows: number;
	coldFrames: number;
	reusedFrames: number;
	lines: number;
}

function stream(document: string, width: number, delta: number): Measurement {
	const markdown = new Markdown("", 0, 0, defaultMarkdownTheme, undefined, {});
	resetMarkdownWork();
	let frames = 0;
	for (let end = delta; end < document.length; end += delta) {
		frames++;
		markdown.setText(document.slice(0, end));
		markdown.render(width);
	}
	markdown.setText(document);
	const lines = markdown.render(width);
	return { ...markdownWork, frames: frames + 1, lines: lines.length };
}

describe("streaming work", () => {
	it("lexes the document roughly once instead of once per frame", () => {
		const document = build(60 * 1024);
		const measured = stream(document, 100, 120);
		assert.ok(
			measured.reusedFrames > measured.frames * 0.9,
			`only ${measured.reusedFrames}/${measured.frames} frames reused a prefix`,
		);
		// One lexical pass over the document, plus one partial block per frame. A
		// renderer that re-lexed the whole document per frame would land near
		// frames/2 passes: ~250 here.
		assert.ok(
			measured.lexUnits <= document.length * 6,
			`lexed ${measured.lexUnits} units for a ${document.length}-unit document`,
		);
	});

	it("keeps per-frame work independent of the document length", () => {
		const single = stream(build(30 * 1024), 100, 120);
		const doubled = stream(build(60 * 1024), 100, 120);
		assert.ok(
			doubled.lexUnits <= single.lexUnits * 2.5,
			`doubling the document multiplied lexing by ${(doubled.lexUnits / single.lexUnits).toFixed(2)}`,
		);
		assert.ok(
			doubled.renderedTokens <= single.renderedTokens * 2.5,
			`doubling the document multiplied token renders by ${(doubled.renderedTokens / single.renderedTokens).toFixed(2)}`,
		);
		assert.ok(
			doubled.wrappedRows <= single.wrappedRows * 2.5,
			`doubling the document multiplied wrapping by ${(doubled.wrappedRows / single.wrappedRows).toFixed(2)}`,
		);
	});

	it("renders each line a bounded number of times", () => {
		const document = build(60 * 1024);
		const measured = stream(document, 100, 120);
		assert.ok(
			measured.wrappedRows <= measured.lines * 6,
			`wrapped ${measured.wrappedRows} rows for ${measured.lines} final lines`,
		);
	});
});

describe("streaming fallbacks", () => {
	it("never reuses a prefix when the document contains block math", () => {
		// A pending block-math token can re-clip the paragraph in front of it, so the
		// certificate cannot be trusted anywhere in the document.
		const measured = stream(`$$\nE = mc^2\n$$\n\n${build(20 * 1024)}`, 100, 120);
		assert.strictEqual(measured.reusedFrames, 0);
	});

	it("never reuses a prefix when the document has a reference definition", () => {
		const measured = stream(`use [label]\n\n[label]: https://example.com\n\n${build(20 * 1024)}`, 100, 120);
		assert.strictEqual(measured.reusedFrames, 0);
	});

	it("keeps rendering a document with no certifiable cut", () => {
		// A single paragraph has no blank line, so there is nothing to certify and the
		// frame cost stays what it was. This is a documented limit, not a silent
		// truncation: the output still equals a cold render.
		const document = "word ".repeat(4000).trimEnd();
		const markdown = new Markdown("", 0, 0, defaultMarkdownTheme, undefined, {});
		resetMarkdownWork();
		for (let end = 120; end < document.length; end += 120) {
			markdown.setText(document.slice(0, end));
			markdown.render(100);
		}
		markdown.setText(document);
		assert.deepStrictEqual(
			markdown.render(100),
			new Markdown(document, 0, 0, defaultMarkdownTheme, undefined, {}).render(100),
		);
		assert.strictEqual(markdownWork.reusedFrames, 0);
	});

	it("re-renders the document when a code row collides with a certified prose row", () => {
		// Code rows are never soft-wrapped and the rule is applied by row text, so a
		// later fenced block containing an already rendered prose row changes how that
		// row is laid out. The prefix must be dropped instead of kept.
		//
		// Reaching this at all needs a theme that does not restyle code, otherwise the
		// code row carries different ANSI escapes and can never collide.
		const identity = (text: string) => text;
		const plainTheme = {
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
		const long = "a long line that will definitely exceed the terminal width and needs wrapping";
		const document = `  ${long}\n\nsecond paragraph\n\n\`\`\`\n${long}\n\`\`\`\n\n`;
		const markdown = new Markdown("", 0, 0, plainTheme, undefined, {});
		resetMarkdownWork();
		for (let end = 1; end <= document.length; end++) {
			const prefix = document.slice(0, end);
			markdown.setText(prefix);
			assert.deepStrictEqual(
				markdown.render(40),
				new Markdown(prefix, 0, 0, plainTheme, undefined, {}).render(40),
				`prefix ${end}`,
			);
		}
		assert.ok(markdownWork.coldFrames > 0, "the colliding document never re-rendered");
	});
});
