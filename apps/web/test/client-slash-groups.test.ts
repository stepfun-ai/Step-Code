/**
 * The slash menu's groups: the "plugin commands" heading appears only
 * when there is at least one prompt command to show under it.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { slashGroups, slashSections, slashTokenAt } from "../client/src/features/composer/slash-groups.ts";
import type { TranslateFn } from "../client/src/i18n/index.ts";

const t = ((key: string) => key) as TranslateFn;
const LABELS = { commands: "命令", prompts: "插件命令", skills: "技能", plugins: "插件", connectors: "连接器" };
const SKILLS = [{ name: "pdf", description: "PDF tools" }];

const REFERENCES = {
	plugins: [{ id: "gh-plugin", name: "GitHub", description: "Repository tools", mcpServers: [], warnings: [] }],
	connectors: [
		{ name: "git-server", source: "user", transport: "http", enabled: true, status: "connected" },
		{ name: "off-server", source: "user", transport: "stdio", enabled: false, status: "disabled" },
	],
} as const;

test("slash references include installed plugins and connectors in continuous groups", () => {
	const groups = slashGroups("", SKILLS, t, [], REFERENCES);
	const sections = slashSections(groups, LABELS);
	assert.deepEqual(sections.map((section) => section.id), ["commands", "plugins", "skills", "connectors"]);
	assert.equal(groups.plugins[0].kind, "plugin");
	assert.equal(groups.connectors[0].kind, "connector");
	assert.equal(groups.connectors.find((item) => item.key === "off-server")?.disabled, true);
	let offset = 0;for (const section of sections) { assert.equal(section.offset, offset);offset += section.items.length; }
});

test("disabled plugins cannot be selected as slash references", () => {
	const groups = slashGroups("", SKILLS, t, [], { plugins: REFERENCES.plugins.map((plugin) => ({ ...plugin, enabled: false })) });
	assert.deepEqual(groups.plugins, []);
});

test("resource prefixes search only the requested reference kind", () => {
	const plugin = slashGroups("plugin:github", SKILLS, t, [], REFERENCES);
	assert.equal(plugin.plugins[0]?.key, "gh-plugin");
	assert.equal(plugin.commands.length + plugin.skills.length + plugin.connectors.length, 0);
	const connector = slashGroups("connector:git", SKILLS, t, [], REFERENCES);
	assert.equal(connector.connectors[0]?.key, "git-server");
	assert.equal(connector.commands.length + connector.skills.length + connector.plugins.length, 0);
	const skill = slashGroups("skill:pdf", SKILLS, t, [], REFERENCES);
	assert.equal(skill.skills[0]?.key, "pdf");
	assert.equal(skill.commands.length + skill.plugins.length + skill.connectors.length, 0);
});

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

test("every command the menu lists is painted as a command in composer.css", () => {
	// The menu's command group is emphasised — ink and a bold `/name` — while
	// plugin commands and skills stay in the muted secondary colour. A command
	// kind that misses the rule renders gray among black entries, which is how
	// `/feedback` (its own kind, because it opens the dialog rather than
	// inserting text) looked before it joined the selector.
	const css = readFileSync(new URL("../client/src/features/composer/composer.css", import.meta.url), "utf8");
	const kinds = [...new Set(slashGroups("", SKILLS, t, []).commands.map((item) => item.kind))];
	assert.ok(kinds.includes("command"), "the built-in commands lost their kind");
	for (const kind of kinds) {
		assert.ok(
			css.includes(`.slash-item.${kind} .slash-item-title`),
			`composer.css has no command-title rule for slash-item kind "${kind}"`,
		);
	}
});
