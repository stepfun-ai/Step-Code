import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSessionStore } from "../src/runtime.ts";

/**
 * `/btw` answers belong to a surface of their own. The host keeps them in process
 * memory (never a session entry, never model context), hands them to a reloaded
 * page through the snapshot, and can forget them on request.
 */

test("a side answer is announced, kept for the snapshot, and cleared", { timeout: 120_000 }, async () => {
	const base = await mkdtemp(join(tmpdir(), "stepcode-web-side-"));
	const previous = { agentDir: process.env.STEP_CODING_AGENT_DIR };
	process.env.STEP_CODING_AGENT_DIR = join(base, "agent");
	let store: WebSessionStore | undefined;
	try {
		store = new WebSessionStore();
		const session = await store.create(base);
		const events: Array<{ type: string; answer?: { id: string; question: string; text: string } }> = [];
		session.subscribe((event) => {
			if (event.type === "side-answer") events.push(event as never);
		});

		// The kernel's `sideAnswer` capability lands on this recorder through the
		// extension UI context; drive it the way `/btw` does.
		session.recordSideAnswer({
			question: "why is this failing?",
			text: "**Because** the token expired.",
			model: "step/test",
		});

		assert.equal(events.length, 1);
		assert.equal(events[0]?.answer?.question, "why is this failing?");
		const snapshot = session.snapshot() as { sideAnswers?: Array<{ text: string; model?: string }> };
		assert.deepEqual(
			snapshot.sideAnswers?.map((answer) => answer.text),
			["**Because** the token expired."],
		);
		assert.equal(snapshot.sideAnswers?.[0]?.model, "step/test");
		// Not part of the transcript: no entry was appended for it.
		const entries = (session.snapshot() as { entries?: Array<{ type: string }> }).entries ?? [];
		assert.equal(entries.some((entry) => entry.type === "custom_message"), false);

		session.clearSideAnswers();
		assert.deepEqual((session.snapshot() as { sideAnswers?: unknown[] }).sideAnswers, []);
	} finally {
		await store?.close().catch(() => {});
		await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		if (previous.agentDir === undefined) delete process.env.STEP_CODING_AGENT_DIR;
		else process.env.STEP_CODING_AGENT_DIR = previous.agentDir;
	}
});
