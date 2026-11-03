/**
 * A session row's right end: the relative time by default; hovering the row
 * swaps the time for the hover actions (more, then archive). The tag diamond
 * sits between them and never moves: "…" appears on its left, and archive and
 * pin take the time's exact width on its right. Moving a row to a group is the first row of its "…" menu. A
 * pinned row ends with its pin, after everything else, so hovering never moves
 * it. In the grouped view the status dot owns that corner, so there the time
 * yields to the dot instead.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const css = await readFile(new URL("../client/src/features/sidebar/sessions.css", import.meta.url), "utf8");
const row = await readFile(new URL("../client/src/features/sidebar/SessionRow.tsx", import.meta.url), "utf8");
const menu = await readFile(new URL("../client/src/features/sidebar/SessionMenu.tsx", import.meta.url), "utf8");

function rule(selector: string): string {
	const start = css.indexOf(selector);
	assert.notEqual(start, -1, `missing rule: ${selector}`);
	// The selector may lead a comma-separated group, so scan to its block, not to "{selector} {".
	const brace = css.indexOf("{", start);
	assert.notEqual(brace, -1, `missing block for: ${selector}`);
	const end = css.indexOf("}", brace);
	return css.slice(brace, end);
}

test("the title grows so the time rides to the row's right end", () => {
	assert.match(rule(".session-title-wrap"), /flex:\s*1/u);
});

test("the time is exactly as wide as the hover actions it gives way to", () => {
	const time = rule("\n.session-time {");
	assert.match(time, /min-width:\s*calc\(2 \* 22px \+ 6px - 4px\)/u, "archive + gap + pin (-4px)");
	assert.match(time, /text-align:\s*right/u);
});

test("hovering swaps the time for the hover actions", () => {
	assert.match(rule(".session-row:hover .session-time"), /display:\s*none/u, "hover hides the time");
	assert.match(rule(".session-row:hover .session-archive-button"), /display:\s*grid/u, "hover shows archive");
	assert.match(rule(".session-row:hover .session-menu-button"), /display:\s*inline-grid/u, "hover shows the more action");
});

test("the hover actions stay put while their menu is anchored open", () => {
	assert.match(rule('.session-row:has(.session-menu-button[aria-expanded="true"]) .session-time'), /display:\s*none/u);
});

test("off hover, the actions take no space and the diamond keeps showing", () => {
	assert.match(rule(".session-archive-button"), /display:\s*none/u, "no reserved hover column beside the time");
	assert.doesNotMatch(css, /tagged .session-time/u, "the diamond must not hide the time");
	assert.match(rule(".session-meta > .session-tag {"), /display:\s*block/u);
});

test("one diamond keeps its place: … before it, the time or archive and pin after it", () => {
	const order = [
		'className="session-menu-button"',
		'className="tag-diamond session-tag"',
		'className="session-time"',
		'className="session-archive-button"',
		'row.pinned ? "session-pin" : "session-pin-action"',
	].map((needle) => row.indexOf(needle));
	assert.ok(order.every((index, at) => index !== -1 && (at === 0 || order[at - 1] < index)), "meta order");
	assert.equal(row.split("tag-diamond session-tag").length, 2, "a single diamond");
	assert.ok(row.indexOf('className="session-meta"') < order[1], "the diamond sits in the meta column");
	assert.match(
		rule('.session-row[data-pinned="true"]:has(.session-tag) .session-archive-button'),
		/margin-left:\s*calc\(2 \* 22px \+ 6px - 4px - 22px\)/u,
		"a pinned row's archive fills the width of the time its pin sat beside",
	);
});

test("in the grouped view the status dot owns the right corner", () => {
	const states = rule(".grouped-view .session-row:is(.running, .waiting, .failed, .unread) .session-time");
	assert.match(states, /display:\s*none/u, "a visible dot hides the time");
	assert.match(rule(".grouped-view .session-row:hover .session-dot"), /opacity:\s*0/u, "hover hands the corner to the menu");
});

test("the pin slot ends the row, after the hover actions, and toggles the pin on click", () => {
	const more = row.indexOf('className="session-menu-button"');
	const archive = row.indexOf('className="session-archive-button"');
	const pin = row.indexOf('row.pinned ? "session-pin" : "session-pin-action"');
	assert.ok(more < archive, "the more action leads the hover actions");
	assert.ok(archive < pin, "the pin is the row's last slot");
	assert.match(row, /onPinClick[\s\S]*toggleSessionPin\(session\.id\)/u, "clicking the pin toggles it");
	assert.doesNotMatch(rule(".session-pin,"), /display:\s*none/u, "a pinned row's pin shows without hover");
	assert.match(css, /\}\n\.session-pin-action \{\n\tdisplay:\s*none;/u, "an unpinned row's pin waits for hover");
	assert.match(rule(".session-row:hover .session-pin-action"), /display:\s*inline-grid/u, "hover offers the pin");
});

test("the archive button archives at once, with no confirmation", () => {
	assert.match(row, /onArchiveClick[\s\S]*runSessionAction\("archive", session\)/u);
	assert.doesNotMatch(row, /onArchiveClick[^}]*confirm\(/u);
});

test("moving to a group leads the row's menu and opens the picker as a submenu beside it", () => {
	const group = menu.indexOf('data-action="group"');
	assert.ok(group !== -1 && group < menu.indexOf('data-action="pin"'), "move to group is the first row");
	assert.match(row, /<SessionMenu session=\{session\} groups \/>/u);
	assert.match(menu, /id="tagPicker"\s+placement="right-start"/u, "the picker opens to the right of its row");
	assert.match(menu, /onPointerEnter=\{\(\) => openTagPicker\(session\.id\)\}/u, "hover opens it");
	assert.match(menu, /onClick=\{\(\) => openTagPicker\(session\.id\)\}/u, "a click opens it");
});

test("an open row menu keeps every hover action in place once the pointer leaves the row", () => {
	// "…" leads the cluster, so hiding the archive button beside it would slide "…" and its menu.
	assert.match(
		rule('.session-row:has(.session-menu-button[aria-expanded="true"]) .session-archive-button'),
		/display:\s*grid/u,
	);
	assert.match(rule('.session-row:has(.session-menu-button[aria-expanded="true"]) .session-pin-action'), /inline-grid/u);
});
