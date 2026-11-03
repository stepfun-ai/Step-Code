import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/** A stylesheet's rules without its comments. */
const css = async (path: string) =>
	(await readFile(new URL(`../client/src/${path}`, import.meta.url), "utf8")).replace(/\/\*[\s\S]*?\*\//gu, "");

test("working-state labels keep their sweep from the first character to the last", async () => {
	const shimmer = await css("ui/ShimmerText/ShimmerText.module.css");
	assert.match(shimmer, /animation:\s*sweep 2s linear infinite/u);
	assert.match(shimmer, /background-clip:\s*text/u);
	assert.match(shimmer, /background-size:\s*300% 100%/u);
	const sweep = /@keyframes sweep \{([\s\S]*?)\n\}/u.exec(shimmer)?.[1] ?? "";
	assert.match(sweep, /from \{\s*background-position:\s*100% 0;\s*\}\s*to \{\s*background-position:\s*0 0;/u);

	const stream = await css("features/conversation/stream.css");
	const pending = /\.tool-pending::before \{([^}]*)\}/u.exec(stream)?.[1] ?? "";
	assert.match(pending, /animation:\s*tool-shimmer 1\.9s linear infinite/u);
	assert.match(pending, /background-clip:\s*text/u);
	assert.match(pending, /background-size:\s*260% 100%/u);
	assert.match(stream, /@keyframes tool-shimmer \{/u);
});

test("the staged mode's border sweep plays twice, then rests", async () => {
	const composer = await css("features/composer/composer.css");
	const sweep = /\.composer-card\[data-mode\]::before \{([^}]*)\}/u.exec(composer)?.[1] ?? "";
	assert.match(sweep, /animation:\s*mode-border-sweep 3s linear 2;/u);
	assert.equal(/infinite/u.test(sweep), false);
});
