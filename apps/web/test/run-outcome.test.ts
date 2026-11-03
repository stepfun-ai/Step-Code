import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type WebEvent, WebSessionStore } from "../src/runtime.ts";
import { EMPTY_RUN_OUTCOME_STATE, recordRunEnd, settleRunOutcome } from "../src/run-outcome.ts";

/**
 * A settled run is not automatically a successful one, and the settled event
 * alone cannot say: it reports an empty turn, while a provider error only ever
 * appears on the assistant message that `agent_end` carries. These cases lock the
 * one thing that broke before — a failed request being overwritten with
 * "completed" when the run settled one event later.
 */

test("a provider error survives the settle that follows it", () => {
	const afterEnd = recordRunEnd(["stop", "error"], false);
	const settled = settleRunOutcome(afterEnd, {});
	assert.equal(settled.outcome.failed, true);
	// The record is consumed: the next run does not inherit it.
	assert.deepEqual(settled.cleared, EMPTY_RUN_OUTCOME_STATE);
});

test("a failure the kernel is about to retry is not the run's outcome", () => {
	const afterEnd = recordRunEnd(["error"], true);
	assert.equal(settleRunOutcome(afterEnd, {}).outcome.failed, false);
});

test("an empty turn is reported by the settled event itself", () => {
	const settled = settleRunOutcome(recordRunEnd(["stop"], false), { failure: { kind: "incomplete_turn" } });
	assert.equal(settled.outcome.failed, true);
});

test("a quiet run completes", () => {
	assert.equal(settleRunOutcome(recordRunEnd(["stop"], false), {}).outcome.failed, false);
});

test("a run that settles without its own agent_end does not inherit the last one", () => {
	// An abort during the pre-prompt compaction settles a run that never started.
	const first = settleRunOutcome(recordRunEnd(["error"], false), {});
	const second = settleRunOutcome(first.cleared, {});
	assert.equal(second.outcome.failed, false);
});

test("the real host reports a terminal incomplete run as a red error and a later answer as completed", async () => {
	const base = await mkdtemp(join(tmpdir(), "step-web-outcome-"));
	let requests = 0;
	const server = createServer(async (request, response) => {
		let raw = "";
		for await (const part of request) raw += part;
		const titleRequest = raw.includes("title-generation task");
		if (!titleRequest) requests += 1;
		response.writeHead(200, { "content-type": "text/event-stream" });
		const delta = titleRequest
			? { content: '{"title":"fixture title"}' }
			: requests <= 2
				? { reasoning_content: "thinking only" }
				: { content: "Answered the next run." };
		for (const [value, finish] of [[delta, null], [{}, "stop"]] as const) {
			response.write(
				`data: ${JSON.stringify({
					id: "fixture",
					object: "chat.completion.chunk",
					model: "fixture-model",
					choices: [{ index: 0, delta: value, finish_reason: finish }],
				})}\n\n`,
			);
		}
		response.end("data: [DONE]\n\n");
	});
	const previous = {
		STEP_CODING_AGENT_DIR: process.env.STEP_CODING_AGENT_DIR,
		STEPCODE_AUTH_PATH: process.env.STEPCODE_AUTH_PATH,
		STEP_API_KEY: process.env.STEP_API_KEY,
	};
	let store: WebSessionStore | undefined;
	try {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		await mkdir(join(base, "agent"));
		await writeFile(
			join(base, "models.json"),
			JSON.stringify({
				providers: {
					fixture: {
						baseUrl: `http://127.0.0.1:${address.port}/v1`,
						api: "openai-completions",
						models: [{ id: "fixture-model" }],
					},
				},
			}),
		);
		await writeFile(join(base, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "test-key" } }));
		await writeFile(join(base, "config.toml"), 'defaultProvider = "fixture"\ndefaultModel = "fixture-model"\n');
		process.env.STEP_CODING_AGENT_DIR = join(base, "agent");
		process.env.STEPCODE_AUTH_PATH = join(base, "auth.json");
		delete process.env.STEP_API_KEY;
		store = new WebSessionStore();
		const session = await store.create(base);
		const events: WebEvent[] = [];
		session.subscribe((event) => events.push(event));
		await session.send("Inspect the workspace");
		assert.equal(requests, 2);
		assert.equal(session.liveStatus().status, "failed");
		assert.ok(events.some((event) => event.type === "notice" && event.level === "error" && event.text.includes("1/1")));
		const recovered = session.snapshot().entries as Array<Record<string, unknown>>;
		assert.equal(recovered.filter((entry) => entry.incompleteTurnRecovered === true).length, 1);
		events.length = 0;
		await session.send("Please answer now");
		assert.equal(session.liveStatus().status, "completed");
		assert.ok(!events.some((event) => event.type === "notice" && event.level === "error"));
	} finally {
		await store?.interruptAndClose();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(base, { recursive: true, force: true });
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});
