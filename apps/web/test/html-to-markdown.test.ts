import assert from "node:assert/strict";
import test from "node:test";
import { hasMarkdownSyntax } from "../client/src/features/composer/html-to-markdown.ts";

test("source with visible Markdown markers earns a preview", () => {
	for (const text of [
		"# Title",
		"- item",
		"* item",
		"1. one",
		"> quote",
		"```ts\nconst a = 1;\n```",
		"~~~\nx\n~~~",
		"| a | b |",
		"first\n\nsecond",
		"**bold**",
		"~~gone~~",
		"`code`",
		"[docs](https://example.com)",
		"## 复盘结论\n\n- 根因",
	]) {
		assert.equal(hasMarkdownSyntax(text), true, text);
	}
});

test("plain prose and arithmetic stay in the editor", () => {
	for (const text of ["", "plain prose", "hello world", "2 * 3 * 4", "snake_case_value", "a *b", "two  spaces"]) {
		assert.equal(hasMarkdownSyntax(text), false, text);
	}
});

test("italic emphasis counts, and bare arithmetic still does not", () => {
	for (const text of ["*italic*", "中文*斜体*文本", "a *b c* d", "a**b**c"]) {
		assert.equal(hasMarkdownSyntax(text), true, text);
	}
	for (const text of ["2 * 3 * 4", "a *b", "snake_case_value", "a * b"]) {
		assert.equal(hasMarkdownSyntax(text), false, text);
	}
});
