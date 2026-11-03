import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/*
 * Rendering cost that lives in stylesheets. The component side (a folded
 * thought renders no Markdown, the hidden Context list is not built) is
 * checked in a real browser by test/e2e/process-groups.e2e.mjs and
 * test/e2e/web.e2e.mjs, since those components import CSS modules.
 */

/** A stylesheet's rules without its comments. */
const css = async (path: string) =>
	(await readFile(new URL(`../client/src/${path}`, import.meta.url), "utf8")).replace(/\/\*[\s\S]*?\*\//gu, "");

test("the app grid has one definite row, so a layout never sizes it from both columns' content", async () => {
	const global = await css("styles/global.css");
	const app = /\n\.app \{([^}]*)\}/u.exec(global)?.[1] ?? "";
	assert.match(app, /grid-template-rows:\s*minmax\(0,\s*1fr\)/u);
});
