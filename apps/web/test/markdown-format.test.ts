import assert from "node:assert/strict";
import test from "node:test";
import {
	planInlineFormat,
	planLink,
	type PlannedEdit,
	type PromptRange,
} from "../client/src/features/composer/markdown-format.ts";

/** A range whose selection is the marked slice, e.g. `a[bc]d`. */
function range(marked: string): PromptRange {
	const start = marked.indexOf("[");
	const end = marked.indexOf("]") - 1;
	return { text: marked.slice(0, start) + marked.slice(start + 1, end + 1) + marked.slice(end + 2), start, end };
}

/** The parts of a plan callers care about, without the edit runs. */
function shape(planned: PlannedEdit | null): { text: string; selection: [number, number] } | null {
	return planned && { text: planned.text, selection: [planned.selectionStart, planned.selectionEnd] };
}

test("wraps the selection by inserting a marker at each boundary", () => {
	const bold = planInlineFormat(range("say [hello] now"), "**");
	assert.deepEqual(shape(bold), { text: "say **hello** now", selection: [6, 11] });
	// The content itself is never rewritten: only the two boundaries change.
	assert.deepEqual(bold?.runs, [
		{ start: 4, end: 4, text: "**" },
		{ start: 9, end: 9, text: "**" },
	]);
	assert.deepEqual(shape(planInlineFormat(range("a [b] c"), "*")), { text: "a *b* c", selection: [3, 4] });
	assert.deepEqual(shape(planInlineFormat(range("[x]"), "`")), { text: "`x`", selection: [1, 2] });
});

test("a selection inside an existing pair is unwrapped in place", () => {
	assert.deepEqual(shape(planInlineFormat({ text: "say **hello** now", start: 6, end: 11 }, "**")), {
		text: "say hello now",
		selection: [4, 9],
	});
	const code = planInlineFormat({ text: "run `npm test` now", start: 5, end: 13 }, "`");
	assert.deepEqual(shape(code), { text: "run npm test now", selection: [4, 12] });
	assert.deepEqual(code?.runs, [
		{ start: 4, end: 5, text: "" },
		{ start: 13, end: 14, text: "" },
	]);
});

test("a fully selected pair loses its markers and stays selected", () => {
	assert.deepEqual(shape(planInlineFormat({ text: "**hello**", start: 0, end: 9 }, "**")), {
		text: "hello",
		selection: [0, 5],
	});
	assert.deepEqual(shape(planInlineFormat({ text: "a `x` b", start: 2, end: 5 }, "`")), {
		text: "a x b",
		selection: [2, 3],
	});
});

test("an empty selection gets an empty pair, and a second press removes it", () => {
	const inserted = planInlineFormat({ text: "", start: 0, end: 0 }, "**");
	assert.deepEqual(shape(inserted), { text: "****", selection: [2, 2] });
	assert.deepEqual(inserted?.runs, [{ start: 0, end: 0, text: "****" }]);
	assert.deepEqual(shape(planInlineFormat({ text: "****", start: 2, end: 2 }, "**")), {
		text: "",
		selection: [0, 0],
	});
});

test("multi-line and CJK selections wrap like any other", () => {
	assert.deepEqual(shape(planInlineFormat({ text: "第一行\n第二行", start: 0, end: 7 }, "**")), {
		text: "**第一行\n第二行**",
		selection: [2, 9],
	});
	assert.deepEqual(shape(planInlineFormat({ text: "看这里", start: 1, end: 3 }, "*")), {
		text: "看*这里*",
		selection: [2, 4],
	});
});

test("formatting never cuts a file chip", () => {
	const text = "参考 \ufffc 实现";
	assert.equal(planInlineFormat({ text, start: 1, end: 6 }, "**"), null);
	assert.equal(planLink({ text, start: 1, end: 6 }), null);
	// Markers may still be added around a chip that stays whole.
	assert.deepEqual(shape(planInlineFormat({ text, start: 5, end: 7 }, "**")), {
		text: "参考 \ufffc **实现**",
		selection: [7, 9],
	});
});

test("a single asterisk next to a bold pair is refused instead of making ***", () => {
	assert.equal(planInlineFormat({ text: "**粗**", start: 2, end: 3 }, "*"), null);
	assert.equal(planInlineFormat({ text: "**粗**", start: 5, end: 5 }, "*"), null);
	assert.equal(planInlineFormat({ text: "**粗**", start: 0, end: 5 }, "*"), null);
});

test("a link wraps the selection and selects its destination", () => {
	assert.deepEqual(shape(planLink({ text: "see docs here", start: 4, end: 8 })), {
		text: "see [docs](url) here",
		selection: [11, 14],
	});
	assert.deepEqual(shape(planLink({ text: "a\nb", start: 0, end: 3 })), {
		text: "[a\nb](url)",
		selection: [6, 9],
	});
	assert.deepEqual(shape(planLink({ text: "", start: 0, end: 0 })), {
		text: "[text](url)",
		selection: [1, 5],
	});
	assert.deepEqual(shape(planLink({ text: "a  b", start: 2, end: 2 })), {
		text: "a [text](url) b",
		selection: [3, 7],
	});
});

test("an out-of-bounds or inverted range changes nothing", () => {
	for (const [start, end] of [
		[-1, 0],
		[0, 99],
		[3, 2],
		[0.5, 1],
	] as const) {
		assert.equal(planInlineFormat({ text: "abc", start, end }, "**"), null);
		assert.equal(planLink({ text: "abc", start, end }), null);
	}
});
