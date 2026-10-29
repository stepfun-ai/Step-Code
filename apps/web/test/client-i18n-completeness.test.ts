/**
 * A translation key used by the client must be defined in both dictionaries.
 *
 * `t()` falls back to the key itself, so a missing entry is not a crash: it is
 * a button that reads `promptCancel` in the middle of the UI. Nothing in the
 * suite noticed, because the failure is visual. Scan the literals instead.
 *
 * Template keys (`t(\`subagentStatus.${status}\`)`) are assembled at runtime and
 * are covered by their own families, not by this scan.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { MESSAGES } from "../client/src/i18n/messages.ts";

const root = new URL("../client/src/", import.meta.url);

/**
 * Keys shown on purpose without a translation: `models.ts` falls back to the
 * catalogue id when a model has no display name, so the raw key is the value
 * that belongs there.
 */
const INTENTIONALLY_RAW = new Set(["defaultModel"]);

async function sourceFiles(directory: URL): Promise<URL[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const files: URL[] = [];
	for (const entry of entries) {
		const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
		if (entry.isDirectory()) files.push(...(await sourceFiles(child)));
		else if (/\.tsx?$/u.test(entry.name)) files.push(child);
	}
	return files;
}

async function keysPerDictionary(): Promise<{ zh: Set<string>; en: Set<string> }> {
	// Inspect the dictionary consumed by t(), including typed paired modules composed by spread.
	// A source-only regex cannot see those keys and would reject complete runtime dictionaries.
	return { zh: new Set(Object.keys(MESSAGES["zh-CN"])), en: new Set(Object.keys(MESSAGES["en-US"])) };
}

async function usedKeys(): Promise<Map<string, string>> {
	const used = new Map<string, string>();
	for (const file of await sourceFiles(root)) {
		const path = file.pathname;
		if (path.endsWith("i18n/messages.ts") || path.endsWith("i18n/index.ts")) continue;
		const text = await readFile(file, "utf8");
		for (const match of text.matchAll(/\bt\(\s*"([^"]+)"/gu)) used.set(match[1]!, path);
	}
	return used;
}

test("every translation key the client asks for is defined in both languages", async () => {
	const [{ zh, en }, used] = await Promise.all([keysPerDictionary(), usedKeys()]);
	assert.ok(zh.size > 100 && en.size > 100, "the dictionaries did not parse; this scan would assert nothing");
	const missingZh = [...used.keys()].filter((key) => !INTENTIONALLY_RAW.has(key) && !zh.has(key));
	const missingEn = [...used.keys()].filter((key) => !INTENTIONALLY_RAW.has(key) && !en.has(key));
	assert.deepEqual(missingZh, [], `missing from zh-CN: ${missingZh.join(", ")}`);
	assert.deepEqual(missingEn, [], `missing from en-US: ${missingEn.join(", ")}`);
});

test("the dictionaries define the same keys", async () => {
	// A key added to one language only reads as that key to the other locale.
	const { zh, en } = await keysPerDictionary();
	const onlyZh = [...zh].filter((key) => !en.has(key));
	const onlyEn = [...en].filter((key) => !zh.has(key));
	assert.deepEqual(onlyZh, [], `only in zh-CN: ${onlyZh.join(", ")}`);
	assert.deepEqual(onlyEn, [], `only in en-US: ${onlyEn.join(", ")}`);
});

test("the stylesheet guards still name rules that exist", async () => {
	// The empty-state and header guards protect against a merge dropping CSS for
	// markup that is still rendered; if their selectors vanish, they assert
	// nothing. This is the check that fails first when a stylesheet is replaced.
	const css = await readFile(new URL("features/conversation/stream.css", root), "utf8");
	for (const selector of [".empty-mark", ".empty-title", ".session-header-title"]) {
		assert.notEqual(css.indexOf(selector), -1, `missing rule from the stylesheet guards: ${selector}`);
	}
});
