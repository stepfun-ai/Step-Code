/**
 * A long workspace group shows its first rows and offers the rest behind one
 * control. Pinned rows lead the drawn order, so they are always among the rows
 * shown; the open conversation also stays in sight. The rendering itself is
 * `features/sidebar/ProjectGroup.tsx`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { COLLAPSED_SESSION_LIMIT, collapsedRows } from "../client/src/features/sidebar/collapse.ts";

const ids = (count: number) => Array.from({ length: count }, (_, index) => `s${index + 1}`);

test("a short group shows every row and offers no control", () => {
	const drawn = ids(COLLAPSED_SESSION_LIMIT);
	assert.deepEqual(collapsedRows(drawn, [], null, false), { shownIds: drawn, hiddenCount: 0, collapsible: false });
});

test("a long group shows the first rows, pins included, and counts the rest", () => {
	// Drawn order already puts the pins first (state/session-order.ts).
	const drawn = ["p1", "p2", ...ids(50)];
	const rows = collapsedRows(drawn, ["p2", "p1"], null, false);
	assert.deepEqual(rows.shownIds, ["p1", "p2", "s1", "s2", "s3"]);
	assert.equal(rows.hiddenCount, 47);
	assert.equal(rows.collapsible, true);
});

test("an expanded group shows every row and still offers to collapse", () => {
	const drawn = ids(8);
	assert.deepEqual(collapsedRows(drawn, [], null, true), { shownIds: drawn, hiddenCount: 0, collapsible: true });
});

test("more pins than the limit keeps every pin in sight", () => {
	const pins = ids(7).map((id) => `p${id}`);
	const drawn = [...pins, ...ids(3)];
	const rows = collapsedRows(drawn, pins, null, false);
	assert.deepEqual(rows.shownIds, pins);
	assert.equal(rows.hiddenCount, 3);
});

test("the open conversation past the fold stays visible in its place", () => {
	const drawn = ids(9);
	const rows = collapsedRows(drawn, [], "s8", false);
	assert.deepEqual(rows.shownIds, ["s1", "s2", "s3", "s4", "s5", "s8"]);
	assert.equal(rows.hiddenCount, 3);
});
