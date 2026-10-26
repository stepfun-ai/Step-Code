/**
 * A session row's right end: the relative time and the tag diamond by default;
 * hovering the row swaps the time for the hover actions (tag, more) — the
 * diamond keeps its corner. In the grouped view the status dot owns that
 * corner, so there the time yields to the dot instead.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const css = await readFile(new URL("../client/src/features/sidebar/sessions.css", import.meta.url), "utf8");
const row = await readFile(new URL("../client/src/features/sidebar/SessionRow.tsx", import.meta.url), "utf8");

function rule(selector: string): string {
	const start = css.indexOf(selector);
	assert.notEqual(start, -1, `missing rule: ${selector}`);
	// The selector may lead a comma-separated group, so scan to its block, not to "{selector} {".
	const brace = css.indexOf("{", start);
	assert.notEqual(brace, -1, `missing block for: ${selector}`);
	const end = css.indexOf("}", brace);
	return css.slice(brace, end);
}

test("the title grows so the time and diamond ride to the row's right end", () => {
	assert.match(rule(".session-title-wrap"), /flex:\s*1/u);
});

test("hovering swaps the time for the hover actions", () => {
	assert.match(rule(".session-row:hover .session-time"), /display:\s*none/u, "hover hides the time");
	assert.match(rule(".session-row:hover .session-tag-button"), /display:\s*grid/u, "hover shows the tag action");
	assert.match(rule(".session-row:hover .session-menu-button"), /display:\s*inline-grid/u, "hover shows the more action");
});

test("the hover actions stay put while their menu is anchored open", () => {
	assert.match(rule('.session-row:has(.session-menu-button[aria-expanded="true"]) .session-time'), /display:\s*none/u);
});

test("off hover, the actions take no space and the diamond keeps showing", () => {
	assert.match(rule(".session-tag-button"), /display:\s*none/u, "no reserved hover column beside the time");
	assert.doesNotMatch(css, /tagged .session-time/u, "the diamond must not hide the time");
	assert.ok(
		row.indexOf('className="session-time"') < row.indexOf('className="tag-diamond session-tag"'),
		"the time leads the right cluster, the diamond ends it",
	);
});

test("in the grouped view the status dot owns the right corner", () => {
	const states = rule(".grouped-view .session-row:is(.running, .waiting, .failed, .unread) .session-time");
	assert.match(states, /display:\s*none/u, "a visible dot hides the time");
	assert.match(rule(".grouped-view .session-row:hover .session-dot"), /opacity:\s*0/u, "hover hands the corner to the menu");
});
