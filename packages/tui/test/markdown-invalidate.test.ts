import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { type DefaultTextStyle, Markdown, type MarkdownTheme } from "../src/components/markdown.ts";
import { markdownWork, resetMarkdownWork } from "../src/components/markdown-work.ts";
import { setIncrementalRenderDisabled } from "../src/tui.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";

/**
 * Renderer invalidation and the shared incremental-render switch.
 *
 * `invalidate()` is how a theme or settings change reaches a live component, so
 * every cache derived from the previous inputs has to go with it. The switch is
 * the seam that promises an unoptimized path for render-equivalence checks, which
 * only works if the renderer honours it too.
 */

const identity = (text: string) => text;

/** A theme whose emphasis can be turned off, like a theme switch that drops a style. */
function mutableTheme(state: { bold: boolean }): MarkdownTheme {
	return {
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
		italic: identity,
		strikethrough: identity,
		underline: identity,
		bold: (text) => (state.bold ? `\x1b[1m${text}\x1b[22m` : text),
	};
}

/** A row long enough to wrap, so the default style is applied inside wrapped text. */
const WRAPPING_DOCUMENT = "a line with **bold** inside it that is long enough to wrap at forty columns\n\n";

afterEach(() => {
	setIncrementalRenderDisabled(false);
});

describe("Markdown invalidation", () => {
	it("drops the default style prefix when the theme stops applying it", () => {
		// The prefix is appended to every inline span that ends inside a style. A stale
		// one splices the previous theme's escape into the new output, which is visible
		// as soon as the new theme no longer applies that style itself.
		const state = { bold: true };
		const defaultTextStyle: DefaultTextStyle = { bold: true };
		const markdown = new Markdown(WRAPPING_DOCUMENT, 0, 0, mutableTheme(state), defaultTextStyle, {});
		const before = markdown.render(40);
		assert.ok(before[0]?.includes("\u001b[1m"), "the bold style never applied");

		state.bold = false;
		markdown.invalidate();

		const expected = new Markdown(WRAPPING_DOCUMENT, 0, 0, mutableTheme(state), defaultTextStyle, {}).render(40);
		assert.deepStrictEqual(markdown.render(40), expected);
	});

	it("still matches a cold render after a theme switch on a long document", () => {
		const state = { bold: true };
		const defaultTextStyle: DefaultTextStyle = { bold: true };
		const document = `${WRAPPING_DOCUMENT}| a | b |\n| - | - |\n| **x** | y |\n\n# heading\n\nmore **bold** text here\n\n`;
		const markdown = new Markdown(document, 0, 0, mutableTheme(state), defaultTextStyle, {});
		markdown.render(40);
		for (let end = 1; end <= document.length; end++) {
			markdown.setText(document.slice(0, end));
			markdown.render(40);
		}

		state.bold = false;
		markdown.invalidate();

		assert.deepStrictEqual(
			markdown.render(40),
			new Markdown(document, 0, 0, mutableTheme(state), defaultTextStyle, {}).render(40),
		);
	});
});

describe("incremental render switch", () => {
	it("renders the whole document and retains no prefix while disabled", () => {
		const document = `${"first paragraph of prose\n\nsecond paragraph of prose\n\n".repeat(40)}`;
		setIncrementalRenderDisabled(true);
		const markdown = new Markdown("", 0, 0, defaultMarkdownTheme, undefined, {});
		resetMarkdownWork();

		let frames = 0;
		for (let end = 120; end < document.length; end += 120) {
			frames++;
			markdown.setText(document.slice(0, end));
			markdown.render(60);
		}
		markdown.setText(document);
		const lines = markdown.render(60);

		assert.strictEqual(markdownWork.reusedFrames, 0, "a prefix was reused while the switch was set");
		assert.ok(
			markdownWork.lexUnits >= frames * 120,
			`only ${markdownWork.lexUnits} units were lexed across ${frames} frames, so frames were skipped`,
		);
		assert.deepStrictEqual(lines, new Markdown(document, 0, 0, defaultMarkdownTheme, undefined, {}).render(60));
	});

	it("resumes prefix reuse once the switch is cleared", () => {
		const document = "first paragraph of prose\n\nsecond paragraph of prose\n\n".repeat(20);
		setIncrementalRenderDisabled(true);
		const markdown = new Markdown("", 0, 0, defaultMarkdownTheme, undefined, {});
		markdown.setText(document.slice(0, 200));
		markdown.render(60);

		setIncrementalRenderDisabled(false);
		resetMarkdownWork();
		for (let end = 200; end < document.length; end += 60) {
			markdown.setText(document.slice(0, end));
			markdown.render(60);
		}
		markdown.setText(document);
		assert.deepStrictEqual(
			markdown.render(60),
			new Markdown(document, 0, 0, defaultMarkdownTheme, undefined, {}).render(60),
		);
		assert.ok(markdownWork.reusedFrames > 0, "the renderer never re-armed prefix reuse");
	});
});
