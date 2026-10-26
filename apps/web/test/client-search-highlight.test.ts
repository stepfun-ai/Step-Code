/**
 * The search modal's match wash.
 *
 * A reader scans the result list for their query; at 12% ink the mark was
 * indistinguishable from the surrounding snippet, so the hit looked like a
 * plain row. These checks pin the colour contract rather than exact pixels: the
 * mark uses the dedicated match pair (not the accent, which means focus, and
 * not the attention tint, which means a warning), and it stays visible on the
 * selected row.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../client/src/", import.meta.url);
const overlays = await readFile(new URL("features/sidebar/overlays.css", root), "utf8");
const tokens = await readFile(new URL("styles/global.css", root), "utf8");

/** The declarations of every block whose selector list contains `selector`. */
function blocks(css: string, selector: string): string[] {
	const found: string[] = [];
	// Comments sit between rules and would otherwise join the next selector.
	for (const match of css.replace(/\/\*[\s\S]*?\*\//gu, "").matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
		const selectors = match[1]!.split(",").map((entry) => entry.trim());
		if (selectors.some((entry) => entry === selector)) found.push(match[2]!);
	}
	return found;
}

function declarations(css: string, selector: string): Record<string, string> {
	const merged: Record<string, string> = {};
	for (const block of blocks(css, selector)) {
		for (const declaration of block.split(";")) {
			const [name, ...value] = declaration.split(":");
			if (!name?.trim() || value.length === 0) continue;
			merged[name.trim()] = value.join(":").trim();
		}
	}
	return merged;
}

test("a match uses its own wash, not the accent or the attention tint", () => {
	const mark = declarations(overlays, ".search-result-main mark");
	assert.equal(mark.background, "var(--match-surface)", `mark background: ${String(mark.background)}`);
	assert.equal(mark.color, "var(--match-ink)");
	assert.equal(mark["font-weight"], "600", "the weight still separates the match from the snippet");
});

test("the match wash is defined for both themes and is not a status colour", () => {
	// Two definitions: the light theme and the dark one.
	const surfaces = [...tokens.matchAll(/--match-surface:\s*([^;]+);/gu)].map((match) => match[1]!.trim());
	const inks = [...tokens.matchAll(/--match-ink:\s*([^;]+);/gu)].map((match) => match[1]!.trim());
	assert.equal(surfaces.length, 2, "one --match-surface per theme");
	assert.equal(inks.length, 2, "one --match-ink per theme");
	for (const value of [...surfaces, ...inks]) {
		assert.match(value, /^#[0-9a-f]{6}$/iu, `expected a literal colour, got ${value}`);
	}
	// Borrowing a status token would make a search hit read as a warning, and the
	// accent would make it read as focus; both are used elsewhere for that.
	assert.ok(!surfaces.some((value) => value.includes("attention") || value.includes("accent")));
});

test("the selected row does not paint over the match", () => {
	// The old rule replaced the mark's background on the Enter target, because a
	// translucent tint needed help there. An opaque wash needs no such override.
	const selected = declarations(overlays, ".search-result.selected .search-result-main mark");
	assert.equal(selected.background, undefined, "the selected row must not override the match background");
	assert.equal(selected.color, undefined);
});

test("the light match wash is dark enough to separate from the surface", () => {
	// Rough luminance check: a highlight on white must be clearly tinted, which a
	// near-white wash (the previous 12%-ink tint) is not.
	const surfaces = [...tokens.matchAll(/--match-surface:\s*#([0-9a-f]{6});/giu)].map((match) => match[1]!);
	const luminance = (hex: string): number => {
		const [r, g, b] = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
		return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
	};
	const [light, dark] = surfaces;
	assert.ok(luminance(light!) < 0.95, `light wash is too close to white: #${light}`);
	assert.ok(luminance(dark!) < 0.6, `dark wash must stay dark: #${dark}`);
	assert.ok(luminance(light!) > luminance(dark!), "the light theme must use the lighter wash");
});
