/**
 * A quoted other-session context (`packageSessionContext`) rides at the tail
 * of the message it was sent with. It must collapse into one pill row instead
 * of rendering its markdown fence across the screen, and a session titled from
 * such a first prompt names the user's own words, not the quote.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sessionContextOf, skillInvocation } from "../client/src/lib/markdown.ts";
import { sessionTitleInput } from "../src/session-title.ts";

const css = await readFile(new URL("../client/src/features/conversation/stream.css", import.meta.url), "utf8");
const messageItem = await readFile(
	new URL("../client/src/features/conversation/MessageItem.tsx", import.meta.url),
	"utf8",
);

const quote = (transcript: string) =>
	`# 引用会话「另一个会话」的上下文\n\`\`\`session-context\n${transcript}\n\`\`\``;

test("a quoted context at the tail splits off, leaving the user's own words", () => {
	const split = sessionContextOf(`继续上面的思路\n\n${quote("用户: 之前的问题\n\n助手: 之前的回答")}`);
	assert.ok(split, "the quote must be recognized");
	assert.equal(split.body, "继续上面的思路");
	assert.equal(split.quote.title, "另一个会话");
	assert.match(split.quote.transcript, /之前的问题/u);
});

test("a skill invocation still collapses when its message also quotes a session", () => {
	const split = sessionContextOf(`/skill:reviewds 看看这段\n\n${quote("用户: 旧内容")}`);
	assert.ok(split);
	assert.equal(split.body, "/skill:reviewds 看看这段");
	assert.equal(skillInvocation(split.body)?.name, "reviewds", "the peeled body still matches the skill form");
});

test("a message without the quote passes through untouched", () => {
	assert.equal(sessionContextOf("普通消息"), null);
	assert.equal(sessionContextOf("正文里提到 ```session-context\n也不算"), null);
});

test("a session titled from a quoting first prompt names the user's words", () => {
	const titled = sessionTitleInput(`帮我梳理一下这个项目的文件结构\n\n${quote("用户: 旧内容")}`);
	assert.equal(titled, "帮我梳理一下这个项目的文件结构");
});

test("the quote renders as a collapsed pill with a bounded transcript", () => {
	assert.match(messageItem, /function QuotedContext/u, "the collapsed row component exists");
	assert.match(messageItem, /useState\(false\)/u, "the transcript starts collapsed");
	const bounded = css.indexOf(".message-quote-body");
	assert.notEqual(bounded, -1, "missing rule: .message-quote-body");
	assert.match(css.slice(bounded, css.indexOf("}", bounded)), /max-height:\s*220px/u, "the transcript never spans the screen");
});
