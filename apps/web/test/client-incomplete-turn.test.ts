import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { turnArtifacts } from "../client/src/features/conversation/turn-artifacts.ts";
import { collectTurnFooters } from "../client/src/features/conversation/turn-footers.ts";
import { t } from "../client/src/i18n/index.ts";
import { incompleteRecoveryNotice, timelineFromEntries } from "../client/src/state/session.ts";
import type { SessionEntry } from "../client/src/state/types.ts";

function message(id: string, value: Record<string, unknown>, extra: Record<string, unknown> = {}): SessionEntry {
	return { type: "message", id, timestamp: "2026-10-19T00:00:00.000Z", message: value, ...extra } as SessionEntry;
}

/**
 * The host pairs an empty turn with the follow-up that recovered it, so the flag
 * rides the turn. `recoveredTurn` is what `projectEntries` produces.
 */
function recovery(id: string): SessionEntry {
	return {
		type: "custom_message",
		id,
		timestamp: "2026-10-19T00:00:01.000Z",
		customType: "step-incomplete-turn-recovery",
		content: "…",
		display: false,
	} as SessionEntry;
}

const user = (id: string) => message(id, { role: "user", content: "继续" });
/**
 * `recovered` is the host's pairing flag, which rides the session entry rather
 * than the provider message (see `projectEntries` in `src/runtime.ts`).
 */
const emptyTurn = (id: string, incomplete: string, content: unknown[] = [], recovered = false) =>
	message(
		id,
		{ role: "assistant", content, stopReason: "stop", incomplete },
		recovered ? { incompleteTurnRecovered: true } : {},
	);
const reply = (id: string, text = "done") => message(id, { role: "assistant", content: [{ type: "text", text }] });

const errors = (items: ReturnType<typeof timelineFromEntries>) =>
	items.flatMap((item) => (item.kind === "message" && item.error ? [item.error] : []));
const contents = (items: ReturnType<typeof timelineFromEntries>) =>
	items.flatMap((item) => (item.kind === "message" ? [item.content] : []));

test("only an actual recovery start announces its attempt metadata", () => {
	const event = {
		type: "message_start",
		message: {
			role: "custom",
			customType: "step-incomplete-turn-recovery",
			details: { attempt: 2, maxAttempts: 3 },
		},
	};
	assert.equal(incompleteRecoveryNotice(event), t("incompleteRetryStarted", { attempt: 2, max: 3 }));
	assert.equal(incompleteRecoveryNotice({ ...event, type: "message_end" }), undefined);
	assert.equal(incompleteRecoveryNotice({ ...event, message: { role: "assistant" } }), undefined);
	assert.equal(incompleteRecoveryNotice({ ...event, message: { role: "custom", customType: "other" } }), undefined);
});

test("legacy or invalid recovery metadata uses the existing one-attempt budget", () => {
	for (const details of [undefined, null, { attempt: -1, maxAttempts: "1" }]) {
		assert.equal(
			incompleteRecoveryNotice({
				type: "message_start",
				message: { role: "custom", customType: "step-incomplete-turn-recovery", details },
			}),
			t("incompleteRetryStarted", { attempt: 1, max: 1 }),
		);
	}
});

test("an error or incomplete closing response still renders the turn's file deliveries", () => {
	// Bundle the actual renderer for Node; CSS has no behavior in server rendering.
	// Keep React external so hooks and the server renderer share one instance.
	const result = buildSync({
		entryPoints: [fileURLToPath(new URL("../client/src/features/conversation/MessageItem.tsx", import.meta.url))],
		bundle: true,
		write: false,
		outfile: "renderer.cjs",
		platform: "node",
		format: "cjs",
		jsx: "automatic",
		external: ["react", "react/*", "react-dom", "react-dom/*"],
		logLevel: "silent",
		loader: { ".css": "text" },
	});
	const module = { exports: {} as { MessageItem: ComponentType<Record<string, unknown>> } };
	runInNewContext(result.outputFiles[0].text, {
		module,
		exports: module.exports,
		require: createRequire(import.meta.url),
		console,
		process,
		crypto: globalThis.crypto,
		performance,
		navigator: { userAgent: "fixture browser" },
		setTimeout,
		clearTimeout,
		URL,
	});
	for (const errorKind of ["incomplete", "request"]) {
		const items = timelineFromEntries([
			user("u"),
			emptyTurn("a", "missing_tool_call", [{ type: "text", text: "Saved [Report](report.md)." }]),
		]);
		const [footer] = collectTurnFooters(items, "failed", false);
		const attachments = turnArtifacts(items, footer, "/work");
		assert.equal(attachments.length, 1);
		const closing = items.filter((item) => item.kind === "message" && item.role === "assistant").at(-1);
		assert.ok(closing?.kind === "message" && closing.error);
		const html = renderToStaticMarkup(
			createElement(module.exports.MessageItem, { item: { ...closing, errorKind }, attachments, fileCwd: "/work" }),
		);
		assert.match(html, /message-error/);
		assert.match(html, /attachment-grid/);
		assert.match(html, /report\.md/);
	}
});

test("an incomplete turn explains itself instead of rendering blank", () => {
	const items = timelineFromEntries([user("u"), emptyTurn("a", "no_visible_output")]);
	assert.deepEqual(errors(items), [t("incompleteNoVisibleOutput")]);
});

test("an incomplete turn labels the response, not a failed request or run outcome", () => {
	// No recovery entry does not prove the run ended: a decision may be pending.
	const items = timelineFromEntries([user("u"), emptyTurn("a", "no_visible_output")]);
	const note = items.find((item) => item.kind === "message" && item.error);
	assert.equal(note?.kind === "message" ? note.errorKind : undefined, "incomplete");
});

test("a provider error keeps its own kind", () => {
	const items = timelineFromEntries([
		user("u"),
		message("e", { role: "assistant", content: [], stopReason: "error", errorMessage: "invalid_api_key" }),
	]);
	const note = items.find((item) => item.kind === "message" && item.error);
	assert.equal(note?.kind === "message" ? note.errorKind : undefined, "request");
});

test("a tool-use turn with no call is described by its own reason", () => {
	const items = timelineFromEntries([user("u"), emptyTurn("a", "missing_tool_call")]);
	assert.deepEqual(errors(items), [t("incompleteMissingToolCall")]);
});

test("a recovered empty turn reads as a retry, not an error", () => {
	const items = timelineFromEntries([
		user("u"),
		emptyTurn("a", "no_visible_output", [], true),
		recovery("r"),
		reply("ok"),
	]);
	assert.deepEqual(
		items.map((item) => item.kind),
		["message", "retry", "message"],
	);
	assert.deepEqual(errors(items), []);
});

test("a recovered empty turn keeps the thinking and text it did produce", () => {
	// A tool-use turn with prose is still incomplete by classification; the prose is
	// the model's real output and the page must not swallow it.
	const items = timelineFromEntries([
		user("u"),
		emptyTurn(
			"a",
			"missing_tool_call",
			[
				{ type: "thinking", thinking: "plan" },
				{ type: "text", text: "Let me read the file." },
			],
			true,
		),
		recovery("r"),
		reply("ok"),
	]);
	assert.deepEqual(
		items.map((item) => item.kind),
		["message", "retry", "thinking", "message", "message"],
	);
	assert.deepEqual(contents(items), ["继续", "Let me read the file.", "done"]);
	assert.deepEqual(errors(items), []);
});

test("a recovered turn still reports the retry when its follow-up produced nothing", () => {
	// An abort mid-recovery leaves no assistant reply; the turn must not vanish.
	const items = timelineFromEntries([user("u"), emptyTurn("a", "no_visible_output", [], true), user("u2")]);
	assert.deepEqual(
		items.map((item) => item.kind),
		["message", "retry", "message"],
	);
	assert.deepEqual(errors(items), []);
});

test("a note row does not collide with the text block's item id", () => {
	const items = timelineFromEntries([
		user("u"),
		emptyTurn("a", "missing_tool_call", [{ type: "text", text: "Let me read the file." }]),
	]);
	const ids = items.flatMap((item) => ("itemId" in item ? [item.itemId] : []));
	assert.equal(new Set(ids).size, ids.length);
});

test("a completed turn renders no error row", () => {
	assert.deepEqual(errors(timelineFromEntries([user("u"), reply("ok")])), []);
});

test("a provider error keeps its own message and still hides the partial body", () => {
	const items = timelineFromEntries([
		user("u"),
		message("e", {
			role: "assistant",
			content: [{ type: "text", text: "half an answer" }],
			stopReason: "error",
			errorMessage: "invalid_api_key",
		}),
		{
			type: "custom_message",
			id: "x",
			timestamp: "2026-10-19T00:00:01.000Z",
			customType: "other",
			content: "…",
		} as SessionEntry,
	]);
	assert.deepEqual(errors(items), ["invalid_api_key"]);
	assert.ok(!contents(items).includes("half an answer"));
});

test("an unknown classification still explains the turn", () => {
	// `incomplete` being set is the kernel's verdict: a newer reason must not bring
	// back the blank row this classification exists to remove.
	assert.deepEqual(errors(timelineFromEntries([user("u"), emptyTurn("a", "something_new")])), [
		t("incompleteNoVisibleOutput"),
	]);
});
