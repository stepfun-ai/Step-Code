/**
 * A warning that answers the user's own slash command is that command's reply.
 *
 * The page keeps reply warnings in the transcript and collects every other
 * warning in the composer's badge, so the host has to say which is which: it
 * alone knows when a command the user ran is still executing. `/messages` is
 * fire-and-forget, so the client cannot tell from the request's lifetime.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type WebEvent, WebSessionStore } from "../src/runtime.ts";

type NoticeEvent = Extract<WebEvent, { type: "notice" }>;

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("condition did not become true before the deadline");
}

test("a warning the user's slash command publishes is marked as its reply", { timeout: 60_000 }, async () => {
	const base = await mkdtemp(join(tmpdir(), "stepcode-web-notice-reply-"));
	const previous = {
		agentDir: process.env.STEP_CODING_AGENT_DIR,
		authPath: process.env.STEPCODE_AUTH_PATH,
		apiKey: process.env.STEP_API_KEY,
		loginState: process.env.STEPCODE_LOGIN_STATE_PATH,
	};
	process.env.STEP_CODING_AGENT_DIR = join(base, "agent");
	process.env.STEPCODE_AUTH_PATH = join(base, "auth.json");
	delete process.env.STEP_API_KEY;
	delete process.env.STEPCODE_LOGIN_STATE_PATH;
	const store = new WebSessionStore();
	try {
		const session = await store.create(base);
		const events: WebEvent[] = [];
		session.subscribe((event) => events.push(event));
		const notices = () => events.filter((event): event is NoticeEvent => event.type === "notice");

		// `/cron delete` without an id answers with a usage warning and runs no turn.
		await session.send("/cron delete");
		await waitFor(() => notices().some((notice) => notice.text.includes("Usage: /cron delete")));
		const usage = notices().find((notice) => notice.text.includes("Usage: /cron delete"));
		assert.equal(usage?.level, "warning");
		assert.equal(usage?.reply, true);
	} finally {
		await store.close();
		await rm(base, { recursive: true, force: true });
		process.env.STEP_CODING_AGENT_DIR = previous.agentDir;
		process.env.STEPCODE_AUTH_PATH = previous.authPath;
		if (previous.apiKey === undefined) delete process.env.STEP_API_KEY;
		else process.env.STEP_API_KEY = previous.apiKey;
		if (previous.loginState === undefined) delete process.env.STEPCODE_LOGIN_STATE_PATH;
		else process.env.STEPCODE_LOGIN_STATE_PATH = previous.loginState;
	}
});
