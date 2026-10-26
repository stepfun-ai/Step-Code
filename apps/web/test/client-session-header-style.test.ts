/**
 * The session header's own styles once vanished in a merge (6fff9c1 took the
 * other side of stream.css), leaving the title as a bare browser <h1>: huge
 * bold default type. Guard the rules so a silent loss fails here first.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const css = await readFile(new URL("../client/src/features/conversation/stream.css", import.meta.url), "utf8");

function rule(selector: string): string {
	const start = css.indexOf(selector);
	assert.notEqual(start, -1, `missing rule: ${selector}`);
	// The selector may lead a comma-separated group, so scan to its block, not to "{selector} {".
	const brace = css.indexOf("{", start);
	assert.notEqual(brace, -1, `missing block for: ${selector}`);
	const end = css.indexOf("}", brace);
	return css.slice(brace, end);
}

test("the header bar exists as a styled bar, not unstyled markup", () => {
	const bar = rule(".session-header");
	assert.match(bar, /height:\s*var\(--session-header-h\)/u, "the fixed bar height");
	assert.match(bar, /border-bottom:\s*1px solid var\(--line\)/u, "the bar's separating line");
});

test("the title is bar-scale type, never the browser's default <h1>", () => {
	const title = rule(".session-header-title");
	assert.match(title, /font-size:\s*14px/u);
	assert.match(title, /font-weight:\s*600/u);
	assert.match(title, /text-overflow:\s*ellipsis/u, "a long first message truncates, not squeezes the chips");
});

test("the project chip and status keep their pill and dot", () => {
	assert.match(rule(".session-header-chip"), /background:\s*var\(--surface-soft\)/u);
	assert.match(rule('.session-header-status[data-status="running"] i'), /animation:\s*pulse/u);
});
