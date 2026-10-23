import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSessionStore } from "../src/runtime.ts";

/**
 * Forking is a session-replacement: the kernel mints a new id and file, the host
 * rebinds, and the store must be able to answer for the new id. The regression
 * this covers: `fork()` returned the id it had before the rebind, so the client
 * navigated to a session that did not exist and every follow-up read was a 404.
 */

interface Fixture {
	readonly server: Server;
	stop(): Promise<void>;
}

/** A local OpenAI-compatible endpoint that answers `/v1/models` and one short completion. */
async function startFixture(base: string): Promise<Fixture> {
	const server = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		if ((request.headers.authorization ?? "") !== "Bearer test-key") {
			response.writeHead(401, { "content-type": "application/json" });
			return response.end(JSON.stringify({ error: { message: "bad key" } }));
		}
		if (url.pathname.endsWith("/models")) {
			response.writeHead(200, { "content-type": "application/json" });
			return response.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
		}
		if (!url.pathname.endsWith("/chat/completions")) {
			response.writeHead(404, { "content-type": "application/json" });
			return response.end(JSON.stringify({ error: { message: "not found" } }));
		}
		for await (const _chunk of request) {
			// Drain the body before answering.
		}
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.write(
			`data: ${JSON.stringify({
				id: "fixture",
				object: "chat.completion.chunk",
				model: "fixture-model",
				choices: [{ index: 0, delta: { content: "done" }, finish_reason: null }],
			})}\n\n`,
		);
		response.write(
			`data: ${JSON.stringify({
				id: "fixture",
				object: "chat.completion.chunk",
				model: "fixture-model",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			})}\n\n`,
		);
		response.end("data: [DONE]\n\n");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("fixture did not bind a port");
	const baseUrl = `http://127.0.0.1:${address.port}/v1`;
	await mkdir(join(base, "agent"), { recursive: true });
	await writeFile(
		join(base, "models.json"),
		`${JSON.stringify(
			{
				providers: {
					mygw: { baseUrl, api: "openai-completions", name: "Fixture Gateway", models: [{ id: "fixture-model" }] },
				},
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	await writeFile(
		join(base, "auth.json"),
		`${JSON.stringify({ mygw: { type: "api_key", key: "test-key" } }, null, 2)}\n`,
		"utf8",
	);
	await writeFile(join(base, "config.toml"), 'defaultProvider = "mygw"\ndefaultModel = "fixture-model"\n', "utf8");
	return {
		server,
		stop: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

async function waitFor(check: () => boolean, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("condition did not become true before the deadline");
}

test("a fork returns the new session id, and that id resolves", { timeout: 120_000 }, async () => {
	const base = await mkdtemp(join(tmpdir(), "stepcode-web-fork-"));
	const fixture = await startFixture(base);
	let store: WebSessionStore | undefined;
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
	try {
		store = new WebSessionStore();
		const parent = await store.create(base);
		const parentId = parent.id;
		await parent.send("hello fork");
		await waitFor(() => !parent.isBusy());
		// Name the parent so the child title is predictable.
		await parent.rename("Alpha");

		const first = await parent.fork();
		assert.equal(first.cancelled, false);
		assert.notEqual(first.sessionId, parentId, "a fork must advertise the new session id");
		assert.equal(parent.id, first.sessionId, "the bound session and the returned id must agree");

		// The client's next request is a plain snapshot read on the returned id.
		const reopened = await store.getOrOpen(first.sessionId);
		assert.equal(reopened.id, first.sessionId);
		assert.equal(reopened.snapshot().status !== undefined, true);
		// The old id no longer describes this session.
		assert.equal(store.statuses().some((entry) => entry.id === parentId), false);
		assert.equal(reopened.snapshot().name, "Alpha_fork");

		// Forking the fork appends again rather than counting or replacing. A
		// branched session has no file until its first reply, and the kernel
		// refuses to branch one, so continue the child first.
		await reopened.send("hello again");
		await waitFor(() => !reopened.isBusy());
		const second = await reopened.fork();
		assert.notEqual(second.sessionId, first.sessionId);
		assert.equal(second.sessionId, reopened.id);
		assert.equal((await store.getOrOpen(second.sessionId)).snapshot().name, "Alpha_fork_fork");
	} finally {
		await store?.interruptAndClose().catch(() => {});
		await fixture.stop();
		await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		process.env.STEP_CODING_AGENT_DIR = previous.agentDir;
		process.env.STEPCODE_AUTH_PATH = previous.authPath;
		if (previous.apiKey === undefined) delete process.env.STEP_API_KEY;
		else process.env.STEP_API_KEY = previous.apiKey;
		if (previous.loginState === undefined) delete process.env.STEPCODE_LOGIN_STATE_PATH;
		else process.env.STEPCODE_LOGIN_STATE_PATH = previous.loginState;
	}
});
