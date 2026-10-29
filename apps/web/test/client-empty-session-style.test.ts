/**
 * The new-session layout (mark beside the question, the composer pulled up under
 * them, both centred in the pane) once vanished in a merge (834a3e8 took the
 * other side of stream.css), bringing back an older wordmark stack and leaving
 * the composer at the bottom. Guard the rules so a silent loss fails here first.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const css = await readFile(new URL("../client/src/features/conversation/stream.css", import.meta.url), "utf8");
const component = await readFile(
	new URL("../client/src/features/conversation/ConversationStream.tsx", import.meta.url),
	"utf8",
);
const store = await readFile(new URL("../client/src/state/store.ts", import.meta.url), "utf8");

function rule(selector: string): string {
	const start = css.indexOf(`${selector} {`);
	assert.notEqual(start, -1, `missing rule: ${selector}`);
	const brace = css.indexOf("{", start);
	return css.slice(brace, css.indexOf("}", brace));
}

test("an empty session centres the composer with the question instead of pinning it to the bottom", () => {
	const empty = ".main:has(.empty-state):not(:has(.stream[data-opening]))";
	assert.match(rule(`${empty} > .stream`), /flex:\s*1 1 auto/u);
	assert.match(rule(`${empty} > .composer-zone`), /flex:\s*1 1 auto/u);
});

test("the mark leads the question on one line", () => {
	const state = rule(".empty-state");
	assert.doesNotMatch(state, /flex-direction:\s*column/u, "a column would stack the mark over the question");
	assert.match(state, /justify-content:\s*center/u);
	assert.match(rule(".empty-mark"), /width:\s*44px/u, "the full-size mark tile");
	assert.match(rule(".empty-title"), /font-size:\s*clamp\(26px/u);
});

test("the stylesheet matches the markup the empty state renders", () => {
	assert.match(component, /className="empty-mark"/u);
	assert.match(component, /className="empty-title"/u);
	assert.doesNotMatch(css, /\.empty-wordmark/u, "the retired wordmark styles");
});

test("migration stays below the centred mark and question without an application subtitle", async () => {
	assert.match(rule(".empty-conversation"), /flex-direction:\s*column/u);
	assert.match(rule(".empty-conversation"), /align-items:\s*center/u);
	assert.match(rule(".empty-state"), /flex:\s*0 0 auto/u);
	assert.match(
		component,
		/className="empty-conversation">\s*<div className="empty-state">[\s\S]*?<h1 className="empty-title">[\s\S]*?<\/h1>\s*<\/div>\s*\{draft/u,
	);
	assert.doesNotMatch(component, /emptySessionImportSources/u);
	assert.doesNotMatch(css, /\.empty-session-import small/u);
	const messages = await readFile(new URL("../client/src/i18n/messages.ts", import.meta.url), "utf8");
	assert.match(messages, /emptySessionImport: "迁移历史会话到 StepCode"/u);
	assert.match(messages, /emptySessionImport: "Migrate sessions into StepCode"/u);
	assert.doesNotMatch(messages, /emptySessionImportSources/u);
});

test("startup is not drawn as a centred new conversation", () => {
	// Before bootstrap picks a session the timeline is empty, but that is loading,
	// not a new conversation: painting it centred moved the composer into the middle
	// of the pane and dropped it to the bottom a few frames later.
	assert.match(component, /!state\.booted \|\| state\.ui\.openingSession !== null/u);
	assert.match(store, /readonly booted: boolean/u);
	assert.match(store, /booted: false/u);
});
