import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { compact } from "../client/src/lib/format.ts";
import { LiveMessageAssembler } from "../client/src/state/live-message.ts";
import { coalesced, throttled } from "../client/src/state/refresh-schedule.ts";
import { closeStream, connectStream, refreshCurrent, renderSnapshot } from "../client/src/state/session.ts";
import { createInitialState, getState, setState } from "../client/src/state/store.ts";
import { completeSnapshot, mergeEntries, reuseTimelineItems } from "../client/src/state/timeline-reuse.ts";
import type { SessionEntry, SessionSnapshot, TimelineItem } from "../client/src/state/types.ts";

/** The page's stream, driven by the test. */
class FakeEventSource {
	static current: FakeEventSource | undefined;
	readonly listeners = new Map<string, (event: { data: string }) => void>();
	onerror: (() => void) | null = null;
	constructor() {
		FakeEventSource.current = this;
	}
	addEventListener(type: string, listener: (event: { data: string }) => void): void {
		this.listeners.set(type, listener);
	}
	close(): void {}
	emit(type: string, payload: unknown): void {
		this.listeners.get(type)?.({ data: JSON.stringify(payload) });
	}
}

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
const originalFrame = globalThis.requestAnimationFrame;
const originalCancelFrame = globalThis.cancelAnimationFrame;
/** Frames the page asked for; `drawFrame` runs them, as the browser would before painting. */
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
let revision = 1;
let requested: string[] = [];
let answer: (url: string) => unknown = () => {
	throw new Error("offline");
};

function drawFrame(): void {
	const due = [...frames.values()];
	frames = new Map();
	for (const callback of due) callback(performance.now());
}

beforeEach(() => {
	revision = 1;
	requested = [];
	frames = new Map();
	answer = () => {
		throw new Error("offline");
	};
	setState(createInitialState());
	globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
	globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
		const id = nextFrame++;
		frames.set(id, callback);
		return id;
	};
	globalThis.cancelAnimationFrame = (id: number) => {
		frames.delete(id);
	};
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = String(input);
		requested.push(url);
		return new Response(JSON.stringify(answer(url)));
	}) as typeof fetch;
});

afterEach(() => {
	closeStream();
	setState(createInitialState());
	globalThis.fetch = originalFetch;
	globalThis.EventSource = originalEventSource;
	globalThis.requestAnimationFrame = originalFrame;
	globalThis.cancelAnimationFrame = originalCancelFrame;
});

const user: SessionEntry = { type: "message", id: "u1", timestamp: "", message: { role: "user", content: "Explain." } };

function open(entries: SessionEntry[] = [user]): void {
	renderSnapshot({ id: "s", cwd: "/w", status: "running", revision, entries } as SessionSnapshot);
	connectStream("s");
}

function agent(event: Record<string, unknown>): void {
	revision += 1;
	FakeEventSource.current?.emit("agent", { revision, event });
}

function recorded(entries: SessionEntry[], reset = false): void {
	revision += 1;
	FakeEventSource.current?.emit("entries", { revision, entries, ...(reset ? { reset: true } : {}) });
}

const assistantAt = 500;
function frame(content: unknown[]): void {
	agent({
		type: "message_update",
		message: { role: "assistant", content, timestamp: assistantAt },
		assistantMessageEvent: { type: "text_delta", contentIndex: content.length - 1 },
	});
}

test("streamed frames redraw only the live rows, never the recorded transcript", () => {
	open();
	const transcript = getState().timelineItems;
	agent({ type: "message_start", message: { role: "assistant", content: [], timestamp: assistantAt } });
	frame([{ type: "text", text: "First " }]);
	// The host's shortened frame: only the tail after the 6 characters already sent.
	frame([{ type: "text", text: "half, then the rest.", appendedTo: 6 }]);
	assert.equal(getState().liveItems.length, 0, "nothing is drawn before the frame");
	drawFrame();
	assert.equal(getState().timelineItems, transcript, "the transcript array is untouched");
	assert.deepEqual(
		getState().liveItems.map((item) => (item.kind === "message" ? item.content : item.kind)),
		["First half, then the rest."],
	);
});

test("a finished message joins the transcript, and its recorded entry replaces it in place", () => {
	open();
	const userRow = getState().timelineItems[0];
	agent({ type: "message_start", message: { role: "assistant", content: [], timestamp: assistantAt } });
	frame([{ type: "text", text: "Done." }]);
	agent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done." }], timestamp: assistantAt } });
	assert.deepEqual(getState().liveItems, []);
	assert.deepEqual(
		getState().timelineItems.map((item) => item.itemId),
		["message-u1", "message-live"],
	);
	recorded([{ type: "message", id: "a1", timestamp: "", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }]);
	assert.deepEqual(
		getState().timelineItems.map((item) => item.itemId),
		["message-u1", "message-a1"],
	);
	assert.equal(getState().timelineItems[0], userRow, "an unchanged row keeps its object, so it does not re-render");
	assert.deepEqual(
		getState().current?.entries?.map((entry) => entry.id),
		["u1", "a1"],
	);
});

test("a prompt's own row stays until its recorded message arrives, and a reset replaces everything", () => {
	open([]);
	agent({ type: "message_start", message: { role: "user", content: "Hello" } });
	recorded([{ type: "custom", id: "echo" } as SessionEntry]);
	assert.ok(getState().timelineItems.some((item) => item.itemId === "message-user-live"));
	recorded([{ type: "message", id: "u9", timestamp: "", message: { role: "user", content: "Hello" } }]);
	assert.deepEqual(
		getState().timelineItems.map((item) => item.itemId),
		["message-u9"],
	);
	recorded([user], true);
	assert.deepEqual(
		getState().current?.entries?.map((entry) => entry.id),
		["u1"],
	);
});

test("a refresh asks only for the entries after the last one held and folds them in", async () => {
	open();
	answer = () => ({
		id: "s",
		cwd: "/w",
		status: "running",
		revision: revision + 1,
		entriesAfter: "u1",
		entries: [{ type: "message", id: "a2", timestamp: "", message: { role: "assistant", content: "Hi." } }],
	});
	await refreshCurrent();
	assert.deepEqual(requested, ["/api/v1/sessions/s?after=u1"]);
	assert.deepEqual(
		getState().current?.entries?.map((entry) => entry.id),
		["u1", "a2"],
	);
});

test("an `after` answer the page cannot place is read again in full", () => {
	const answerAfter = { id: "s", cwd: "/w", status: "idle", entriesAfter: "gone", entries: [] } as unknown as SessionSnapshot;
	assert.equal(completeSnapshot(answerAfter, [user]), undefined);
	const whole = { id: "s", cwd: "/w", status: "idle", entries: [user] } as unknown as SessionSnapshot;
	assert.equal(completeSnapshot(whole, []), whole);
	const retimed = { ...user, promptCommand: "/x" };
	assert.deepEqual(mergeEntries([user], [retimed]), [retimed], "a re-projected entry replaces its old copy");
});

test("merged entries keep branch order around an answer the page applied early", () => {
	const entry = (id: string): SessionEntry => ({ type: "custom", id }) as SessionEntry;
	const message = (id: string): SessionEntry =>
		({ type: "message", id, message: { role: "assistant", content: id } }) as SessionEntry;
	// The page appended answer `c` from its event; timing `t`, recorded before it, arrives with it.
	assert.deepEqual(
		mergeEntries([user, message("m"), entry("c")], [entry("t"), entry("c")]).map((item) => item.id),
		["u1", "m", "t", "c"],
	);
	// A message deep in the branch re-timed by a later entry stays where it is.
	const retimed = { ...message("m"), thinkingTimings: { 0: { startedAt: 1, endedAt: 2 } } } as SessionEntry;
	const merged = mergeEntries([user, message("m"), message("n")], [retimed, entry("t")]);
	assert.deepEqual(
		merged.map((item) => item.id),
		["u1", "m", "n", "t"],
	);
	assert.equal(merged[1], retimed);
	// The last held message re-timed: it is carried again, and keeps its place before the timing.
	assert.deepEqual(
		mergeEntries([user, message("m")], [retimed, entry("t")]).map((item) => item.id),
		["u1", "m", "t"],
	);
});

test("rebuilt rows keep unchanged objects and a running call's streamed output", () => {
	const running: TimelineItem = {
		itemId: "tool-c1",
		kind: "tool",
		state: "pending",
		toolName: "run_command",
		inputSummary: "make",
		outputSummary: "building…",
		inputDetail: "command: make",
		outputDetail: "building…",
	};
	const message: TimelineItem = { itemId: "message-u1", kind: "message", role: "user", content: "x" };
	const previous = [message, running];
	assert.equal(reuseTimelineItems(previous, [{ ...message }, { ...running }]), previous);
	const rebuilt = reuseTimelineItems(previous, [{ ...message }, { ...running, outputSummary: "", outputDetail: "" }]);
	assert.equal(rebuilt, previous, "the recorded call has no output yet; the live one keeps it");
});

test("the refresh schedule answers at once, folds a burst into one more run, and never overlaps", async () => {
	let runs = 0;
	let active = 0;
	let overlap = false;
	const schedule = throttled(async () => {
		runs += 1;
		active += 1;
		overlap ||= active > 1;
		await new Promise((resolve) => setTimeout(resolve, 15));
		active -= 1;
	}, 40);
	schedule.request();
	assert.equal(runs, 1, "a request after a quiet interval runs immediately");
	for (let index = 0; index < 10; index++) schedule.request();
	await new Promise((resolve) => setTimeout(resolve, 120));
	assert.equal(runs, 2, "ten requests during the window cost one more run");
	assert.equal(overlap, false);
	schedule.request();
	schedule.request();
	schedule.cancel();
	await new Promise((resolve) => setTimeout(resolve, 80));
	assert.ok(runs <= 3, "a cancelled schedule starts nothing new");

	let loads = 0;
	const read = coalesced(async () => {
		loads += 1;
		await new Promise((resolve) => setTimeout(resolve, 10));
	});
	await Promise.all([read(), read(), read(), read()]);
	assert.equal(loads, 2, "overlapping reads share one trailing read");
});

test("compact cuts like the full normalisation, reading only what it needs", () => {
	const reference = (value: unknown, limit = 120) => {
		const text = String(value ?? "")
			.replace(/\s+/g, " ")
			.trim();
		return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
	};
	let seed = 7;
	const random = () => {
		seed = (seed * 48271) % 2147483647;
		return seed / 2147483647;
	};
	const pieces = ["a", "word", " ", "  ", "\n", "\t", "\n\n  ", "长文本", "x".repeat(50), " ".repeat(300)];
	for (let index = 0; index < 400; index++) {
		let text = "";
		const count = Math.floor(random() * 80);
		for (let part = 0; part < count; part++) text += pieces[Math.floor(random() * pieces.length)];
		const limit = 1 + Math.floor(random() * 160);
		assert.equal(compact(text, limit), reference(text, limit), JSON.stringify({ text, limit }));
	}
	assert.equal(compact(undefined), "");
	assert.equal(compact(`${" ".repeat(10_000)}tail`), "tail");
});

test("the live message assembler rebuilds blocks and starts over with a new message", () => {
	const assembler = new LiveMessageAssembler();
	assert.deepEqual(assembler.apply({ timestamp: 1, content: [{ type: "text", text: "ab" }] }), [{ type: "text", text: "ab" }]);
	assert.deepEqual(assembler.apply({ timestamp: 1, content: [{ type: "text", text: "cd", appendedTo: 2 }] }), [
		{ type: "text", text: "abcd" },
	]);
	assert.deepEqual(assembler.apply({ timestamp: 2, content: [{ type: "text", text: "new" }] }), [
		{ type: "text", text: "new" },
	]);
	assert.equal(assembler.apply({ timestamp: 2, content: "plain" }), "plain");
});
