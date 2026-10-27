import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type WebEvent, WebSessionStore } from "../src/runtime.ts";

/**
 * A session's outcome is unread only when no page followed its stream while
 * it happened. `publishError` ends a run as failed without a model call, so the
 * test needs no provider; the configured one points at a closed port.
 */
test("an outcome reached with no page watching stays unread until a page opens the stream", { timeout: 60_000 }, async () => {
	const base = await mkdtemp(join(tmpdir(), "stepcode-web-unread-"));
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
	await mkdir(join(base, "agent"), { recursive: true });
	await writeFile(
		join(base, "models.json"),
		`${JSON.stringify({
			providers: {
				mygw: {
					baseUrl: "http://127.0.0.1:9/v1",
					api: "openai-completions",
					name: "Closed Gateway",
					models: [{ id: "fixture-model" }],
				},
			},
		})}\n`,
		"utf8",
	);
	await writeFile(join(base, "auth.json"), `${JSON.stringify({ mygw: { type: "api_key", key: "test-key" } })}\n`);
	await writeFile(join(base, "config.toml"), `defaultProvider = "mygw"\ndefaultModel = "fixture-model"\n`, "utf8");
	const store = new WebSessionStore();
	try {
		const session = await store.create(base);
		const events: WebEvent[] = [];
		session.subscribe((event) => events.push(event));
		const statusOf = () => store.statuses().find((entry) => entry.id === session.id);

		assert.deepEqual(statusOf(), { id: session.id, status: "idle", unread: false });
		// Nothing has been published yet, so a read taken now orders before every event.
		assert.equal(session.snapshot().revision, 0);

		session.publishError("background failure");
		assert.deepEqual(statusOf(), { id: session.id, status: "failed", unread: true });

		// Opening the stream is looking at the session: the outcome is read, and the page is told.
		const unwatch = session.watch();
		assert.deepEqual(statusOf(), { id: session.id, status: "failed", unread: false });
		const watched = events.at(-1);
		assert.ok(watched?.type === "status" && watched.revision > 0, "the status event carries its revision");
		assert.deepEqual({ type: watched.type, status: watched.status, unread: watched.unread }, {
			type: "status",
			status: "failed",
			unread: false,
		});
		assert.ok(
			events.every((event, index) => index === 0 || event.revision > events[index - 1].revision),
			"revisions increase with the events a listener receives",
		);
		// A snapshot is stamped with the newest revision when it is serialized, so a
		// client can drop one that an event has already overtaken.
		assert.equal(session.snapshot().revision, watched.revision);

		// An outcome reached while a page watches is seen as it happens.
		session.publishError("watched failure");
		assert.equal(statusOf()?.unread, false);

		// Releasing twice must not count a second page out.
		unwatch();
		unwatch();
		session.publishError("unwatched failure");
		assert.equal(statusOf()?.unread, true);
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
