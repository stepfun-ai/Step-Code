/**
 * Prompt commands: the host records the line the user typed beside the
 * transcript and pairs it with the user message the kernel expanded it into,
 * by content, so the flow can show the line instead of the template.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { PromptTemplate, SessionEntry } from "@step-harness/coding-agent";
import {
	LivePromptCommands,
	PROMPT_COMMAND_TYPE,
	pairPromptCommands,
	promptCommandRecord,
	promptDigest,
	webPromptCommands,
} from "../src/prompt-commands.ts";
import { projectEntries } from "../src/runtime.ts";

const template = (name: string, content: string, extra: Partial<PromptTemplate> = {}): PromptTemplate =>
	({ name, description: `${name} description`, content, filePath: `/plugins/${name}.md`, ...extra }) as PromptTemplate;

const TEMPLATES = [template("code-review", "Review pull request $1 carefully."), template("commit", "Commit the staged work.")];

const record = (id: string, text: string, digest: string): SessionEntry =>
	({ id, type: "custom", customType: PROMPT_COMMAND_TYPE, data: { text, digest }, timestamp: "t" }) as unknown as SessionEntry;

const user = (id: string, text: string): SessionEntry =>
	({
		id,
		type: "message",
		timestamp: "t",
		message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
	}) as unknown as SessionEntry;

test("only a line the kernel would expand is recorded, keyed by its expansion", () => {
	const recorded = promptCommandRecord("/code-review 123", "/code-review 123", TEMPLATES);
	assert.deepEqual(recorded, {
		text: "/code-review 123",
		digest: promptDigest("Review pull request 123 carefully."),
	});
	// Attachments folded into the sent text change the expansion, not the shown line.
	const withFile = promptCommandRecord("/commit ", "/commit \n\nattached", TEMPLATES);
	assert.equal(withFile?.text, "/commit");
	assert.equal(withFile?.digest, promptDigest("Commit the staged work."));

	assert.equal(promptCommandRecord("/unknown 1", "/unknown 1", TEMPLATES), null);
	assert.equal(promptCommandRecord("/skill:pdf merge", "/skill:pdf merge", TEMPLATES), null);
	assert.equal(promptCommandRecord("review /code-review", "review /code-review", TEMPLATES), null);
});

test("a recorded line pairs with the first later user message that is its expansion", () => {
	const review = promptDigest("Review pull request 7 carefully.");
	const entries = [
		user("u0", "Review pull request 7 carefully."), // typed by hand before any record: stays as is
		record("r1", "/code-review 7", review),
		// A steered or queued message can land after unrelated entries.
		user("u1", "something else"),
		user("u2", "Review pull request 7 carefully."),
		user("u3", "Review pull request 7 carefully."), // a second identical message with no second record
		record("r2", "/commit", promptDigest("Commit the staged work.")), // never delivered: pairs with nothing
	];
	assert.deepEqual([...pairPromptCommands(entries)], [["u2", "/code-review 7"]]);

	const projected = projectEntries(entries);
	assert.equal(projected.find((entry) => entry.id === "u2")?.promptCommand, "/code-review 7");
	for (const id of ["u0", "u1", "u3"]) assert.equal(projected.find((entry) => entry.id === id)?.promptCommand, undefined);
	// The model's view is untouched: the paired message keeps the expanded text.
	const paired = projected.find((entry) => entry.id === "u2")?.message as { content: { text: string }[] };
	assert.equal(paired.content[0]?.text, "Review pull request 7 carefully.");
});

test("two sends of the same command pair in order", () => {
	const digest = promptDigest("Commit the staged work.");
	const pairs = pairPromptCommands([
		record("r1", "/commit", digest),
		record("r2", "/commit  ", digest),
		user("u1", "Commit the staged work."),
		user("u2", "Commit the staged work."),
	]);
	assert.deepEqual([...pairs], [
		["u1", "/commit"],
		["u2", "/commit  "],
	]);
});

test("malformed records are ignored", () => {
	const broken = { id: "r", type: "custom", customType: PROMPT_COMMAND_TYPE, data: { text: 3 }, timestamp: "t" };
	assert.equal(pairPromptCommands([broken as unknown as SessionEntry, user("u", "x")]).size, 0);
});

test("the live event takes each line once, and the pending list stays bounded", () => {
	const live = new LivePromptCommands();
	live.add({ text: "/commit", digest: promptDigest("Commit the staged work.") });
	assert.equal(live.take("something else"), undefined);
	assert.equal(live.take("Commit the staged work."), "/commit");
	assert.equal(live.take("Commit the staged work."), undefined);

	for (let index = 0; index < 40; index++) live.add({ text: `/c ${index}`, digest: promptDigest(`m${index}`) });
	assert.equal(live.take("m0"), undefined, "the oldest records were dropped");
	assert.equal(live.take("m39"), "/c 39");
});

test("the menu lists each runnable template once, by name", () => {
	const commands = webPromptCommands(
		[
			template("zeta", "z"),
			template("alpha", "a", { argumentHint: "<file>" }),
			template("alpha", "shadowed by the first"),
			template("goal", "reserved"),
			template("skill:x", "never a template name"),
		],
		(name) => name === "goal",
	);
	assert.deepEqual(commands, [
		{ name: "alpha", description: "alpha description", argumentHint: "<file>" },
		{ name: "zeta", description: "zeta description" },
	]);
});
