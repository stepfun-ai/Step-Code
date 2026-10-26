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

test("a goal continuation message projects the round it starts", () => {
	const continuation = projectEntry({
		id: "c1",
		type: "custom_message",
		customType: "step-goal",
		content: [{ type: "text", text: "Continue working toward the active thread goal." }],
		details: { goalId: "g1", iteration: 1 },
		timestamp: "2026-10-26T00:00:00.000Z",
	});
	// One completed run queued this continuation, so it starts round 2.
	assert.equal(continuation.goalRound, 2);

	// A malformed or missing iteration projects no round: the client falls
	// back to counting separators instead of trusting a bad number.
	assert.equal(projectEntry({ id: "c2", type: "custom_message", customType: "step-goal" }).goalRound, undefined);
	assert.equal(
		projectEntry({ id: "c3", type: "custom_message", customType: "step-goal", details: { iteration: "two" } })
			.goalRound,
		undefined,
	);
	// Only the continuation carries a round; the persisted snapshot stays opaque.
	assert.equal(
		projectEntry({ id: "e4", type: "custom", customType: "step-goal", data: { iteration: 5 } }).goalRound,
		undefined,
	);
});
