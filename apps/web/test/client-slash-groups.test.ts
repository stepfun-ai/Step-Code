/**
 * The slash menu's groups: the "plugin commands" heading appears only
 * when there is at least one prompt command to show under it.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { slashGroups, slashSections, slashTokenAt } from "../client/src/features/composer/slash-groups.ts";
import type { TranslateFn } from "../client/src/i18n/index.ts";

const t = ((key: string) => key) as TranslateFn;
const LABELS = { commands: "命令", prompts: "插件命令", skills: "技能" };
const SKILLS = [{ name: "pdf", description: "PDF tools" }];

test("with no prompt commands the group is not rendered", () => {
	const sections = slashSections(slashGroups("", SKILLS, t, []), LABELS);
	assert.deepEqual(
		sections.map((section) => section.id),
		["commands", "skills"],
	);
	// Keyboard order stays continuous across the groups that remain.
	assert.equal(sections[1]?.offset, sections[0]?.items.length);
});

test("a query that matches no prompt command hides the group too", () => {
	const prompts = [{ name: "code-review", description: "Review a pull request" }];
	const sections = slashSections(slashGroups("pdf", SKILLS, t, prompts), LABELS);
	assert.equal(
		sections.some((section) => section.id === "prompts"),
		false,
	);
});

test("prompt commands get their own group between commands and skills", () => {
	const prompts = [{ name: "code-review", description: "Review a pull request", argumentHint: "<pr>" }];
	const sections = slashSections(slashGroups("", SKILLS, t, prompts), LABELS);
	assert.deepEqual(
		sections.map((section) => [section.id, section.label]),
		[
			["commands", "命令"],
			["prompts", "插件命令"],
			["skills", "技能"],
		],
	);
	const group = sections[1];
	assert.equal(group?.offset, sections[0]?.items.length);
	assert.deepEqual(group?.items, [
		{ kind: "prompt", key: "code-review", title: "/code-review", description: "<pr> · Review a pull request" },
	]);
	assert.equal(sections[2]?.offset, (group?.offset ?? 0) + 1);
});

test("a prompt command named like a built-in command is not offered, so it cannot open the group alone", () => {
	const sections = slashSections(slashGroups("", [], t, [{ name: "goal", description: "shadowed" }]), LABELS);
	assert.deepEqual(
		sections.map((section) => section.id),
		["commands"],
	);
});

test("a /word opens the menu at the start, after chips and after a space mid-text", () => {
	assert.deepEqual(slashTokenAt("/co", 3), { start: 0, end: 3, query: "co" });
	assert.deepEqual(slashTokenAt("111 /", 5), { start: 4, end: 5, query: "" });
	assert.deepEqual(slashTokenAt("fix /comm it", 9), { start: 4, end: 9, query: "comm" });
	// After a staged lead chip (projected as U+FFFC) and its separating space.
	assert.deepEqual(slashTokenAt("\ufffc /sk", 5), { start: 2, end: 5, query: "sk" });
	// The caret inside the word: the query is what precedes it, the word runs on.
	assert.deepEqual(slashTokenAt("say /commit now", 7), { start: 4, end: 11, query: "co" });
	assert.deepEqual(slashTokenAt("line one\n/pl", 12), { start: 9, end: 12, query: "pl" });
});

test("slashes inside words, paths and URLs do not open the menu", () => {
	assert.equal(slashTokenAt("and/or", 6), null);
	assert.equal(slashTokenAt("see https://x.dev/a", 19), null);
	assert.equal(slashTokenAt("open /usr/bin", 13), null);
	assert.equal(slashTokenAt("\ufffc/x", 3), null);
	// The caret has left the word.
	assert.equal(slashTokenAt("fix /commit it", 14), null);
});
