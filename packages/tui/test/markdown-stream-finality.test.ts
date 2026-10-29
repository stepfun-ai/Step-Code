import assert from "node:assert";
import { describe, it } from "node:test";
import { Marked } from "marked";
import {
	applyInlineTagDepth,
	createStreamGuard,
	findCertifiedCut,
	guardIsClean,
	rawLengthOf,
	rawsCoverSource,
	scanBlockMath,
	scanReferenceLabels,
} from "../src/components/markdown-stream.ts";

/**
 * Unit coverage for the certification rules.
 *
 * These pin the two halves of the incremental renderer that cannot be observed
 * from rendered output: which cut points are allowed, and which document-wide
 * facts make a previously certified prefix unsafe.
 */

const parser = new Marked();

function tokensOf(source: string) {
	return parser.lexer(source);
}

function cutOffsetFor(source: string): number | undefined {
	const tokens = tokensOf(source);
	const cut = findCertifiedCut(tokens);
	return cut === undefined ? undefined : rawLengthOf(tokens, cut);
}

describe("certified cut", () => {
	it("stops in front of a paragraph that follows a blank line", () => {
		assert.strictEqual(cutOffsetFor("first paragraph\n\nsecond paragraph\n"), "first paragraph\n\n".length);
	});

	it("stops in front of an ATX heading", () => {
		assert.strictEqual(cutOffsetFor("first paragraph\n\n# heading\n"), "first paragraph\n\n".length);
	});

	it("rejects an unterminated final paragraph", () => {
		// `1` can still become a list marker, and a list merges across blank lines
		// into the list that precedes it.
		assert.strictEqual(cutOffsetFor("first paragraph\n\n1"), undefined);
		assert.strictEqual(cutOffsetFor("first paragraph\n\nsecond"), undefined);
	});

	it("rejects a list, quote, table, or fence as the witness", () => {
		assert.strictEqual(cutOffsetFor("first paragraph\n\n- a\n- b\n"), undefined);
		assert.strictEqual(cutOffsetFor("first paragraph\n\n> quoted\n"), undefined);
		assert.strictEqual(cutOffsetFor("first paragraph\n\n| a |\n| - |\n| 1 |\n"), undefined);
		assert.strictEqual(cutOffsetFor("first paragraph\n\n```\ncode\n```\n"), undefined);
	});

	it("rejects an indented witness", () => {
		// A blank line does not end a list, so an indented line can still belong to
		// the block in front of the cut.
		assert.strictEqual(cutOffsetFor("first paragraph\n\n  indented continuation\n"), undefined);
	});

	it("rejects a cut with no blank line in front of it", () => {
		assert.strictEqual(cutOffsetFor("first paragraph\nsecond paragraph\n"), undefined);
	});

	it("prefers the rightmost candidate", () => {
		const source = "one\n\ntwo\n\nthree\n";
		const tokens = tokensOf(source);
		const cut = findCertifiedCut(tokens);
		assert.strictEqual(cut, tokens.length - 1);
		assert.strictEqual(rawLengthOf(tokens, cut!), source.length - "three\n".length);
	});
});

describe("document-wide guards", () => {
	it("finds a block-math opener and keeps it sticky", () => {
		const guard = createStreamGuard();
		scanBlockMath("intro\n\n$$", guard);
		assert.strictEqual(guard.blockMath, true);
		// Sticky: later scans cannot clear it, even for an innocent remainder.
		scanBlockMath("intro\n\n$$\nplain prose\n\n", guard);
		assert.strictEqual(guard.blockMath, true);
		assert.strictEqual(guardIsClean(guard), false);
	});

	it("detects an opener split across two deltas", () => {
		const guard = createStreamGuard();
		scanBlockMath("intro\n\n$", guard);
		assert.strictEqual(guard.blockMath, false);
		scanBlockMath("intro\n\n$$", guard);
		assert.strictEqual(guard.blockMath, true);
	});

	it("ignores a dollar that is not at the start of a line", () => {
		const guard = createStreamGuard();
		scanBlockMath("cost is $$5 today\n\nmore\n", guard);
		assert.strictEqual(guard.blockMath, false);
		assert.strictEqual(guardIsClean(guard), true);
	});

	it("tracks an unclosed reference label until it closes", () => {
		const guard = createStreamGuard();
		scanReferenceLabels("intro\n\n[x", guard);
		assert.strictEqual(guard.openReferenceLabel, true);
		assert.strictEqual(guardIsClean(guard), false);
		scanReferenceLabels("]: https://example.com\n\n", guard);
		assert.strictEqual(guard.openReferenceLabel, false);
		assert.strictEqual(guardIsClean(guard), true);
	});

	it("ignores an escaped bracket", () => {
		const guard = createStreamGuard();
		scanReferenceLabels("intro\n\n\\[not a label\n\n", guard);
		assert.strictEqual(guard.openReferenceLabel, false);
	});

	it("tracks an unbalanced inline anchor tag", () => {
		const guard = createStreamGuard();
		applyInlineTagDepth(tokensOf('<a href="x">open\n\n'), guard);
		assert.strictEqual(guard.openLinkTags, 1);
		assert.strictEqual(guardIsClean(guard), false);

		applyInlineTagDepth(tokensOf("</a>\n\n"), guard);
		assert.strictEqual(guard.openLinkTags, 0);
		assert.strictEqual(guardIsClean(guard), true);
	});

	it("ignores tag-like text inside fenced code", () => {
		const guard = createStreamGuard();
		applyInlineTagDepth(tokensOf('```\n<a href="x">\n```\n\n'), guard);
		assert.strictEqual(guard.openLinkTags, 0);
		assert.strictEqual(guardIsClean(guard), true);
	});
});

describe("raw coverage", () => {
	it("accepts tokens that reproduce their source", () => {
		const source = "first\n\nsecond\n\n```\ncode\n```\n";
		assert.strictEqual(rawsCoverSource(tokensOf(source), source), true);
	});

	it("rejects a repeated reference definition, which Marked drops", () => {
		// The second definition is not emitted as a token, so offsets cannot be
		// derived from the token raws. The renderer must not advance a prefix.
		const source = "[x]: https://example.com\n\n[x]: https://example.com\n\n";
		assert.strictEqual(rawsCoverSource(tokensOf(source), source), false);
	});
});
