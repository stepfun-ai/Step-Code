/**
 * The command echo: a slash command the kernel consumes leaves no user
 * message, so the host journals the typed line as a custom entry and projects
 * it for the timeline. `/mcp`, `/btw` and `/feedback` are client-side surfaces
 * and must stay unechoed; the `ultracode:` keyword form is an ordinary
 * message.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { COMMAND_ECHO_TYPE, commandEchoText, projectEntry } from "../src/runtime.ts";

test("kernel commands echo their command line", () => {
	assert.equal(commandEchoText("/goal sort my folders"), "/goal sort my folders");
	assert.equal(commandEchoText("/plan"), "/plan");
	assert.equal(commandEchoText("/plan  refactor the parser"), "/plan  refactor the parser");
	assert.equal(commandEchoText("/todos"), "/todos");
	assert.equal(commandEchoText("/permissions approve-for-me"), "/permissions approve-for-me");
	assert.equal(commandEchoText("/ultraloop on"), "/ultraloop on");
	assert.equal(commandEchoText("/compact"), "/compact");
	// Trailing whitespace is trimmed; leading whitespace is not a command — the
	// kernel only runs a slash at position 0, so the echo follows the same rule.
	assert.equal(commandEchoText("/init "), "/init");
	assert.equal(commandEchoText("  /init"), null);
});

test("client-side surfaces and ordinary text never echo", () => {
	// `/mcp`, `/btw` and `/feedback` are handled in the client and never reach send().
	assert.equal(commandEchoText("/mcp"), null);
	assert.equal(commandEchoText("/btw what about x"), null);
	assert.equal(commandEchoText("/feedback"), null);
	// `/skill:` journals as an ordinary user message that already carries the
	// skill badge (MessageItem parses it), so it must not echo a second row.
	assert.equal(commandEchoText("/skill:demo do things"), null);
	// An unknown command journals as an ordinary user message; so does the keyword form.
	assert.equal(commandEchoText("/not-a-command hi"), null);
	assert.equal(commandEchoText("ultracode: dig in"), null);
	assert.equal(commandEchoText("just a message"), null);
	assert.equal(commandEchoText(""), null);
});

test("the echo entry projects its command, other custom entries stay opaque", () => {
	const echo = projectEntry({
		id: "e1",
		type: "custom",
		customType: COMMAND_ECHO_TYPE,
		data: { text: "/goal sort my folders" },
		timestamp: "2026-10-23T00:00:00.000Z",
	});
	assert.equal(echo.command, "/goal sort my folders");
	assert.equal(echo.customType, COMMAND_ECHO_TYPE);

	const goal = projectEntry({
		id: "e2",
		type: "custom",
		customType: "step-goal",
		data: { objective: "sort my folders" },
		timestamp: "2026-10-23T00:00:01.000Z",
	});
	assert.equal("command" in goal, false);

	// An echo without text (a hand-edited file) projects nothing rather than an empty row.
	const empty = projectEntry({ id: "e3", type: "custom", customType: COMMAND_ECHO_TYPE, data: {} });
	assert.equal("command" in empty, false);
});
