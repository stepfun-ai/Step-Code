import assert from "node:assert/strict";
import test from "node:test";
import {
	classifyAttachment,
	MAX_ATTACHMENT_BYTES,
	MAX_INLINED_CHARS,
	withTextAttachments,
} from "../src/attachments.ts";

const text = (name: string, body: string) => ({
	name,
	mimeType: "text/plain",
	data: Buffer.from(body, "utf8").toString("base64"),
	kind: "text" as const,
});

const image = (name: string) => ({
	name,
	mimeType: "image/png",
	data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
	kind: "image" as const,
});

test("classifyAttachment routes images and everything else to text", () => {
	assert.equal(classifyAttachment("image/png"), "image");
	assert.equal(classifyAttachment("image/jpeg"), "image");
	assert.equal(classifyAttachment("text/plain"), "text");
	assert.equal(classifyAttachment("application/json"), "text");
	assert.equal(classifyAttachment("application/pdf"), "text");
});

test("a message without text attachments is returned untouched", () => {
	assert.equal(withTextAttachments("hello", []), "hello");
	assert.equal(withTextAttachments("hello", [image("shot.png")]), "hello");
});

test("text attachments are folded in with their filename", () => {
	const result = withTextAttachments(" summarise this", [text("notes.md", "# Title\n\nBody")]);

	assert.match(result, /summarise this/);
	assert.match(result, /\[attached file: notes\.md\]/u);
	assert.match(result, /# Title/);
	assert.match(result, /Body/);
});

test("each attachment becomes its own block, in order", () => {
	const result = withTextAttachments("go", [text("a.txt", "AAA"), text("b.txt", "BBB")]);

	assert.ok(result.indexOf("AAA") < result.indexOf("BBB"));
	assert.equal(result.match(/\[attached file:/gu)?.length, 2);
});

test("an oversized text attachment is truncated and says what is missing", () => {
	const huge = "x".repeat(50_000);
	const result = withTextAttachments("go", [text("big.txt", huge)]);

	// The model needs the size and an action, not just the word "truncated".
	assert.match(result, /Showing characters 1-40000 of 50000/u);
	assert.match(result, /remainder was not included/u);
	assert.ok(result.length < huge.length);
});

test("truncation counts code points, so it never splits a character", () => {
	// 40 001 astral characters: a UTF-16 slice would end on half a surrogate pair.
	const huge = "\u{1F600}".repeat(MAX_INLINED_CHARS + 1);
	const result = withTextAttachments("go", [text("emoji.txt", huge)]);

	assert.match(result, /of 40001/u);
	// The block must decode to whole characters only.
	const body = result.split("```")[1] ?? "";
	assert.equal(body.includes("\uFFFD"), false);
});

test("the size limit is a sane ceiling", () => {
	assert.equal(MAX_ATTACHMENT_BYTES, 5 * 1024 * 1024);
});
