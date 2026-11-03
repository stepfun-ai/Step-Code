import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/*
 * Working-state motion is drawn by the compositor. A `background-position`
 * sweep under clipped text repainted the label on every display frame; the
 * staged mode's border sweep looped forever on an idle page.
 */

/** A stylesheet's rules without its comments, which may name the techniques they replaced. */
const css = async (path: string) =>
	(await readFile(new URL(`../client/src/${path}`, import.meta.url), "utf8")).replace(/\/\*[\s\S]*?\*\//gu, "");

test("working-state motion is composited: no background-position sweeps on text, no endless border sweep", async () => {
	const shimmer = await css("ui/ShimmerText/ShimmerText.module.css");
	assert.equal(/background-position/u.test(shimmer), false);
	assert.match(shimmer, /animation:\s*breathe/u);
	const breathe = /@keyframes breathe \{([\s\S]*?)\n\}/u.exec(shimmer)?.[1] ?? "";
	assert.deepEqual([...new Set(breathe.match(/[a-z-]+(?=:)/gu))], ["opacity"]);
	const stream = await css("features/conversation/stream.css");
	const pending = /\.tool-pending::before \{([^}]*)\}/u.exec(stream)?.[1] ?? "";
	assert.match(pending, /animation:\s*tool-glow/u);
	assert.equal(/background-clip/u.test(pending), false);
	const glow = /@keyframes tool-glow \{([\s\S]*?)\n\}/u.exec(stream)?.[1] ?? "";
	assert.deepEqual([...new Set(glow.match(/[a-z-]+(?=:)/gu))], ["opacity"]);
	const composer = await css("features/composer/composer.css");
	const sweep = /\.composer-card\[data-mode\]::before \{([^}]*)\}/u.exec(composer)?.[1] ?? "";
	assert.match(sweep, /animation:\s*mode-border-sweep 3s linear 2;/u, "the mode border plays twice, then rests");
	assert.equal(/infinite/u.test(sweep), false);
});
