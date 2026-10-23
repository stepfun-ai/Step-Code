/**
 * Groups are named by the user, so renaming one must be reachable on the group
 * card itself — not only through the per-session tag picker.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const css = await readFile(new URL("../client/src/features/sidebar/sessions.css", import.meta.url), "utf8");
const groupedView = await readFile(new URL("../client/src/features/sidebar/GroupedView.tsx", import.meta.url), "utf8");
const picker = await readFile(new URL("../client/src/features/sidebar/TagPicker.tsx", import.meta.url), "utf8");

function rule(selector: string): string {
	const start = css.indexOf(selector);
	assert.notEqual(start, -1, `missing rule: ${selector}`);
	// The selector may lead a comma-separated group, so scan to its block, not to "{selector} {".
	const brace = css.indexOf("{", start);
	assert.notEqual(brace, -1, `missing block for: ${selector}`);
	const end = css.indexOf("}", brace);
	return css.slice(brace, end);
}

test("a group heading shows its rename pencil on hover and on keyboard focus", () => {
	assert.match(rule(".group-heading:hover .group-rename-button"), /display:\s*grid/u, "hover reveals the pencil");
	assert.match(rule(".group-heading .group-rename-button:focus-visible"), /display:\s*grid/u, "focus reveals it too");
});

test("clicking the pencil renames instead of folding the section", () => {
	assert.match(groupedView, /className="group-rename-button"/u, "the heading carries a pencil button");
	assert.match(groupedView, /event\.stopPropagation\(\);/u, "the pencil must not bubble to the fold handler");
});

test("the heading swaps into an inline rename row that keeps the card geometry", () => {
	assert.match(groupedView, /<GroupRenameInput group=\{group\}/u, "renaming happens in place of the heading");
	assert.match(rule(".group-section > .tag-create"), /min-height:\s*38px/u, "the row matches the heading height");
});

test("the picker and the grouped view share one rename row component", () => {
	assert.match(groupedView, /from "\.\/GroupRenameInput"/u);
	assert.match(picker, /from "\.\/GroupRenameInput"/u);
});
