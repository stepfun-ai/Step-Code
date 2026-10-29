import assert from "node:assert/strict";
import test from "node:test";
import { stripImportedUserControls } from "../client/src/lib/imported-content.ts";
import { timelineFromEntries } from "../client/src/state/session.ts";

const wrapped = "<user_query>你好</user_query>";

test("imported user_query wrappers retain their actual text", () => {
	assert.deepEqual(stripImportedUserControls(wrapped), { text: "你好", removed: false });
	assert.deepEqual(
		stripImportedUserControls(`<system-reminder>Source controls</system-reminder>${wrapped}`),
		{ text: "你好", removed: true },
	);
});

test("code examples and incomplete user_query markup are not stripped", () => {
	for (const text of ["```xml\n<user_query>你好</user_query>\n```", "example: <user_query>你好</user_query>", "<user_query>unfinished"]) {
		assert.equal(stripImportedUserControls(text).text, text);
	}
	assert.equal(
		stripImportedUserControls("<user_query>outer <user_query>inner</user_query></user_query>").text,
		"outer <user_query>inner</user_query>",
	);
});

test("existing imported messages unwrap without changing ordinary native messages", () => {
	for (const source of ["codex", "claude-code", "workbuddy", "qoder"]) {
		const rows = timelineFromEntries([
			{ id: "old", type: "message", imported: { source, sessionId: "s", itemId: "u" }, message: { role: "user", content: wrapped } },
			{ id: "native", type: "message", message: { role: "user", content: wrapped } },
		]);
		assert.equal(rows[0].kind, "message");
		assert.equal(rows[0].kind === "message" && rows[0].content, "你好");
		assert.equal(rows[1].kind === "message" && rows[1].content, wrapped);
	}
});
