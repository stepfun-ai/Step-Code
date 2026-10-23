import assert from "node:assert/strict";
import test from "node:test";
import { TextInputBroker, type TextInputEvent, textInput } from "../src/text-input.ts";

test("text input broker relays the prompt and returns the answer verbatim", async () => {
	const events: TextInputEvent[] = [];
	const broker = new TextInputBroker(
		() => "session-1",
		(event) => events.push(event),
	);
	const answer = broker.ask("Feedback comment", "What happened?");
	const [request] = broker.pendingRequests();
	assert.equal(request?.sessionId, "session-1");
	assert.equal(request?.title, "Feedback comment");
	assert.equal(request?.placeholder, "What happened?");
	assert.deepEqual(events[0], { type: "text_input_required", input: request });
	assert.equal(broker.respond(request?.id ?? "", "the tool crashed\nwhile editing"), true);
	assert.equal(await answer, "the tool crashed\nwhile editing");
	assert.deepEqual(events[1], { type: "text_input_resolved", id: request?.id });
	assert.deepEqual(broker.pendingRequests(), []);
	// Settled once: a second answer is a stale page.
	assert.equal(broker.respond(request?.id ?? "", "again"), false);
});

test("an empty answer is submitted and an omitted one dismisses the prompt", async () => {
	const broker = new TextInputBroker(
		() => "session-2",
		() => {},
	);
	const empty = broker.ask("Comment");
	const [first] = broker.pendingRequests();
	assert.equal(broker.respond(first?.id ?? "", ""), true);
	// The kernel distinguishes "typed nothing" from "cancelled".
	assert.equal(await empty, "");

	const dismissed = textInput(broker)("Comment", undefined);
	const [second] = broker.pendingRequests();
	assert.equal(second?.placeholder, undefined);
	assert.equal(broker.respond(second?.id ?? "", undefined), true);
	assert.equal(await dismissed, undefined);
});

test("abort and clear dismiss pending prompts", async () => {
	const events: TextInputEvent[] = [];
	const broker = new TextInputBroker(
		() => "session-3",
		(event) => events.push(event),
	);
	const controller = new AbortController();
	const aborted = textInput(broker)("Comment", "Why?", { signal: controller.signal });
	const cleared = broker.ask("Comment again");
	controller.abort();
	assert.equal(await aborted, undefined);
	assert.equal(broker.pendingRequests().length, 1);
	broker.clear();
	assert.equal(await cleared, undefined);
	assert.deepEqual(broker.pendingRequests(), []);
	assert.equal(events.filter((event) => event.type === "text_input_resolved").length, 2);
	// An already aborted signal never shows a dialog.
	const before = events.length;
	assert.equal(await broker.ask("Late", undefined, AbortSignal.abort()), undefined);
	assert.equal(events.length, before);
});

test("an unknown id is rejected and the prompt stays open", async () => {
	const broker = new TextInputBroker(
		() => "session-4",
		() => {},
	);
	const answer = broker.ask("Comment");
	const [request] = broker.pendingRequests();
	assert.equal(broker.respond("unknown", "text"), false);
	assert.equal(broker.pendingRequests().length, 1);
	assert.equal(broker.respond(request?.id ?? "", "text"), true);
	assert.equal(await answer, "text");
});
