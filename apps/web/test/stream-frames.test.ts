import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStepSessionManager, INCOMPLETE_TURN_RECOVERY_CUSTOM_TYPE, type SessionEntry } from "@step-harness/coding-agent";
import type { AssistantMessage } from "@step-harness/providers";
import { LiveMessageAssembler } from "../client/src/state/live-message.ts";
import { JournalCursor } from "../src/journal-cursor.ts";
import { messageImages, omitImageData } from "../src/omitted-images.ts";
import { projectEntries, projectEntryRange, type WebEvent } from "../src/runtime.ts";
import { SseSessionWriter } from "../src/sse-writer.ts";
import { THINKING_TIMING_TYPE } from "../src/thinking-timing.ts";

/** A writer whose frame never fires by itself: the test flushes, so frames are deterministic. */
function capture(tails = true): { writer: SseSessionWriter; frames: { name: string; body: Record<string, unknown> }[] } {
	const frames: { name: string; body: Record<string, unknown> }[] = [];
	const writer = new SseSessionWriter((name, data) => frames.push({ name, body: JSON.parse(data) }), {
		frameMs: 60_000,
		tails,
	});
	return { writer, frames };
}

let revision = 0;
function agent(event: Record<string, unknown>): WebEvent {
	revision += 1;
	return { type: "agent", event, revision } as unknown as WebEvent;
}

/** What the kernel publishes per chunk: the message so far, twice, and the raw tool argument text. */
function update(content: unknown[], timestamp = 100): WebEvent {
	const message = { role: "assistant", content, timestamp };
	return agent({
		type: "message_update",
		message,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, partial: message },
	});
}

/** The page side: rebuild each written `message_update` the way `connectStream` does. */
function rebuild(assembler: LiveMessageAssembler, frame: { body: Record<string, unknown> }): unknown {
	const event = frame.body.event as { type: string; message?: { timestamp?: unknown; content?: unknown } };
	if (event.type === "message_start" || event.type === "message_end") assembler.reset();
	return event.type === "message_update" ? assembler.apply(event.message) : undefined;
}

test("a frame keeps only the newest update, and the page rebuilds every block from the tails", () => {
	const { writer, frames } = capture();
	const assembler = new LiveMessageAssembler();
	const thought = "Check the files first. ".repeat(40);
	const answer = "Here is the answer. ".repeat(60);
	writer.publish(update([{ type: "thinking", thinking: thought.slice(0, 100) }]));
	writer.publish(update([{ type: "thinking", thinking: thought.slice(0, 300) }]));
	writer.flush();
	assert.equal(frames.length, 1, "two updates in one frame are written once");
	writer.publish(update([{ type: "thinking", thinking: thought }, { type: "text", text: answer.slice(0, 50) }]));
	writer.flush();
	writer.publish(update([{ type: "thinking", thinking: thought }, { type: "text", text: answer }]));
	writer.flush();
	writer.close();
	const rebuilt = frames.map((frame) => rebuild(assembler, frame));
	assert.deepEqual(rebuilt.at(-1), [
		{ type: "thinking", thinking: thought },
		{ type: "text", text: answer },
	]);
	const last = frames.at(-1)?.body.event as { message: { content: Record<string, unknown>[] }; assistantMessageEvent: object };
	// The finished thinking block did not grow: sent whole. The answer grew: only its tail.
	assert.equal(last.message.content[1].appendedTo, 50);
	assert.equal(last.message.content[1].text, answer.slice(50));
	assert.equal("partial" in last.assistantMessageEvent, false, "the partial copy of the message is not sent");
	const sent = JSON.stringify(frames.at(-1)?.body).length;
	assert.ok(sent < thought.length + answer.length, `a grown frame sends less than the message (${sent})`);
});

test("a streaming tool call sends only the appended argument text, and never the raw arguments", () => {
	const { writer, frames } = capture();
	const assembler = new LiveMessageAssembler();
	const content = "# Generated\n\n".concat("A line of the file.\n".repeat(200));
	const call = (written: string) => ({
		type: "toolCall",
		id: "w1",
		name: "write_file",
		arguments: { path: "notes/out.md", content: written },
		partialArgs: JSON.stringify({ path: "notes/out.md", content: written }),
	});
	for (const end of [100, 1500, content.length]) {
		writer.publish(update([call(content.slice(0, end))]));
		writer.flush();
	}
	writer.close();
	const rebuilt = frames.map((frame) => rebuild(assembler, frame));
	assert.deepEqual(rebuilt.at(-1), [
		{ type: "toolCall", id: "w1", name: "write_file", arguments: { path: "notes/out.md", content } },
	]);
	for (const frame of frames) assert.equal(JSON.stringify(frame.body).includes("partialArgs"), false);
	const last = (frames.at(-1)?.body.event as { message: { content: Record<string, unknown>[] } }).message.content[0];
	// The unchanged path goes out as an empty tail too; only the content's new text is sent.
	assert.deepEqual(last.appendedArguments, { path: "notes/out.md".length, content: 1500 });
	assert.deepEqual(last.arguments, { path: "", content: content.slice(1500) });
});

test("another event flushes the waiting update first, and a new message starts complete", () => {
	const { writer, frames } = capture();
	writer.publish(update([{ type: "text", text: "Reading" }]));
	writer.publish(agent({ type: "tool_execution_start", toolCallId: "c1", toolName: "read_file", args: { path: "a" } }));
	assert.deepEqual(
		frames.map((frame) => (frame.body.event as { type: string }).type),
		["message_update", "tool_execution_start"],
	);
	writer.publish(agent({ type: "message_end", message: { role: "assistant", content: [], timestamp: 100 } }));
	writer.publish(update([{ type: "text", text: "Reading on" }], 200));
	writer.flush();
	writer.close();
	const next = (frames.at(-1)?.body.event as { message: { content: Record<string, unknown>[] } }).message.content[0];
	assert.equal(next.text, "Reading on");
	assert.equal("appendedTo" in next, false, "a later message never extends the previous one's text");
});

test("text that was replaced rather than extended is sent whole", () => {
	const { writer, frames } = capture();
	const assembler = new LiveMessageAssembler();
	writer.publish(update([{ type: "text", text: "First draft of a reply" }]));
	writer.flush();
	writer.publish(update([{ type: "text", text: "Rewritten" }]));
	writer.flush();
	writer.close();
	const rebuilt = frames.map((frame) => rebuild(assembler, frame));
	assert.deepEqual(rebuilt.at(-1), [{ type: "text", text: "Rewritten" }]);
});

test("a subscriber that did not ask for tails gets whole messages, still coalesced and without copies", () => {
	const { writer, frames } = capture(false);
	const call = { type: "toolCall", id: "w1", name: "write_file", arguments: { path: "a.md", content: "abc" }, partialArgs: "{}" };
	writer.publish(update([{ type: "text", text: "First" }, call]));
	writer.flush();
	writer.publish(update([{ type: "text", text: "First half" }, { ...call, arguments: { path: "a.md", content: "abcdef" } }]));
	writer.publish(update([{ type: "text", text: "First half and more" }, { ...call, arguments: { path: "a.md", content: "abcdefgh" } }]));
	writer.flush();
	writer.close();
	assert.equal(frames.length, 2, "updates are still coalesced per frame");
	const last = frames[1]?.body.event as { message: { content: Record<string, unknown>[] }; assistantMessageEvent: object };
	assert.deepEqual(last.message.content, [
		{ type: "text", text: "First half and more" },
		{ type: "toolCall", id: "w1", name: "write_file", arguments: { path: "a.md", content: "abcdefgh" } },
	]);
	assert.equal("partial" in last.assistantMessageEvent, false);
});

test("a running call's partial results keep only the newest per call, in arrival order", () => {
	const { writer, frames } = capture();
	const partial = (id: string, text: string) =>
		agent({ type: "tool_execution_update", toolCallId: id, partialResult: { content: [{ type: "text", text }] } });
	writer.publish(partial("c1", "one"));
	writer.publish(partial("c2", "other"));
	writer.publish(partial("c1", "one two"));
	writer.publish(partial("c1", "one two three"));
	writer.flush();
	writer.close();
	assert.deepEqual(
		frames.map((frame) => {
			const event = frame.body.event as { toolCallId: string; partialResult: { content: { text: string }[] } };
			return [event.toolCallId, event.partialResult.content[0].text];
		}),
		[
			["c2", "other"],
			["c1", "one two three"],
		],
	);
});

test("tool-result images leave the stream as placeholders; a user's own images do not", () => {
	const { writer, frames } = capture();
	const image = { type: "image", data: "iVBORw0KGgo=".repeat(1000), mimeType: "image/png" };
	writer.publish(
		agent({
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName: "read_file",
			result: { content: [{ type: "text", text: "Read image file" }, image] },
		}),
	);
	writer.publish(agent({ type: "message_end", message: { role: "toolResult", toolCallId: "c1", content: [image] } }));
	writer.publish(agent({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "see" }, image] } }));
	writer.close();
	const [end, result, prompt] = frames.map((frame) => JSON.stringify(frame.body));
	assert.equal(end.includes(image.data), false);
	assert.ok(end.includes('"omitted":true'));
	assert.equal(result.includes(image.data), false);
	assert.ok(prompt.includes(image.data), "the page draws the images a user sent");
	assert.deepEqual(omitImageData([image]), [{ type: "image", mimeType: "image/png", omitted: true }]);
	assert.deepEqual(messageImages([{ type: "text", text: "x" }, image]), [{ data: image.data, mimeType: "image/png" }]);
});

test("the journal cursor publishes only appended entries and says when the branch moved", () => {
	const cursor = new JournalCursor([{ id: "a" }, { id: "b" }]);
	assert.equal(cursor.advance([{ id: "a" }, { id: "b" }]), undefined);
	assert.equal(cursor.advance([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]), 2);
	assert.equal(cursor.advance([{ id: "a" }, { id: "b" }, { id: "x" }]), "reset", "a rewind is not an extension");
	assert.equal(cursor.advance([{ id: "a" }, { id: "b" }, { id: "x" }, { id: "y" }]), 3);
	assert.equal(new JournalCursor([]).advance([{ id: "a" }]), 0);
});

test("a projected range is the tail of the full projection, plus messages a later timing re-times", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "stepcode-web-entry-range-"));
	try {
		const manager = createStepSessionManager("/fixture", { agentDir });
		const usage = {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const reply = (timestamp: number): AssistantMessage => ({
			role: "assistant",
			content: [{ type: "thinking", thinking: "Think." }, { type: "text", text: "Answer." }],
			api: "faux", provider: "faux", model: "faux", usage, stopReason: "stop", timestamp,
		});
		manager.appendMessage({ role: "user", content: "One.", timestamp: 1 });
		manager.appendMessage(reply(10));
		manager.appendMessage({
			role: "toolResult", toolCallId: "c1", toolName: "read_file", isError: false, timestamp: 11,
			content: [{ type: "text", text: "Read image file" }, { type: "image", data: "AAAA", mimeType: "image/png" }],
		});
		const start = manager.getBranch().length;
		// The run's clock settled after the message was recorded: its timing entry comes later.
		manager.appendCustomEntry(THINKING_TIMING_TYPE, {
			version: 1, messageTimestamp: 10, thinkingTimings: { 0: { startedAt: 1, endedAt: 9 } },
		});
		manager.appendMessage({ role: "user", content: "Two.", timestamp: 20 });
		const branch = manager.getBranch();
		const full = projectEntries(branch);
		const range = projectEntryRange(branch, start);
		const retimed = full.find((entry) => entry.id === branch[1]?.id);
		assert.deepEqual(range, [retimed, ...full.slice(start)]);
		assert.deepEqual(retimed?.thinkingTimings, { 0: { startedAt: 1, endedAt: 9 } });
		assert.deepEqual(projectEntryRange(branch, 0), full);
		const result = full.find((entry) => (entry.message as { role?: string } | undefined)?.role === "toolResult");
		assert.deepEqual((result?.message as { content: unknown[] }).content[1], {
			type: "image",
			mimeType: "image/png",
			omitted: true,
		});
		const stored = manager.getEntry(branch[2]?.id ?? "");
		assert.equal(JSON.stringify(stored).includes("AAAA"), true, "the transcript itself keeps the image");
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("a projected range re-sends the empty turn a later recovery answers", () => {
	const at = "2026-11-03T11:00:00.000Z";
	const prompt = (id: string): SessionEntry =>
		({ type: "message", id, timestamp: at, message: { role: "user", content: "Go.", timestamp: 1 } }) as SessionEntry;
	const empty = {
		type: "message",
		id: "a",
		timestamp: at,
		message: {
			role: "assistant",
			content: [{ type: "thinking", thinking: "Thinking." }],
			stopReason: "stop",
			incomplete: "no_visible_output",
			timestamp: 2,
		},
	} as SessionEntry;
	const recovery = {
		type: "custom_message",
		id: "r",
		timestamp: at,
		customType: INCOMPLETE_TURN_RECOVERY_CUSTOM_TYPE,
		content: "Continue.",
		display: false,
		details: { recoversEntryId: "a" },
	} as SessionEntry;
	const branch = [prompt("u"), empty, recovery];
	const full = projectEntries(branch);
	assert.equal(full[1]?.incompleteTurnRecovered, true);
	// The page held the empty turn before its recovery was recorded: it gets the turn again, now paired.
	assert.deepEqual(projectEntryRange(branch, 2), [full[1], full[2]]);
	// Once the page holds both, later entries re-send neither.
	const later = [...branch, prompt("v")];
	assert.deepEqual(projectEntryRange(later, 3), [projectEntries(later)[3]]);
});
