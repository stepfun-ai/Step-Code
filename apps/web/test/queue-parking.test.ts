import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSessionStore } from "../src/runtime.ts";

/**
 * The host queue after the user stops.
 *
 * Stopping means stop: the queue stays parked until the user acts again, even if
 * the aborted run does not report itself as aborted. It is only released by the
 * next run starting, which is what a new message does.
 */

interface Fixture {
	requests: number;
	/** Resolve the reply the first request is waiting on. */
	releaseFirst: () => void;
	stop(): Promise<void>;
}

function chunk(delta: Record<string, unknown>, finish: string | null): string {
	return `data: ${JSON.stringify({
		id: "f",
		object: "chat.completion.chunk",
		model: "fixture-model",
		choices: [{ index: 0, delta, finish_reason: finish }],
	})}\n\n`;
}

async function startFixture(base: string): Promise<Fixture> {
	let requests = 0;
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const server: Server = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		if (url.pathname.endsWith("/models")) {
			response.writeHead(200, { "content-type": "application/json" });
			return response.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
		}
		let raw = "";
		for await (const part of request) raw += part;
		const parsed = JSON.parse(raw) as { messages: Array<{ role: string; content: unknown }> };
		if (parsed.messages.some((message) => JSON.stringify(message.content).includes("title-generation task"))) {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write(chunk({ content: '{"title":"fixture title"}' }, null));
			response.write(chunk({}, "stop"));
			return response.end("data: [DONE]\n\n");
		}
		requests += 1;
		const first = requests === 1;
		if (first) await gate;
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.write(chunk({ content: first ? "long answer" : "short answer" }, null));
		response.write(chunk({}, "stop"));
		response.end("data: [DONE]\n\n");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("fixture did not bind a port");
	const provider = {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		api: "openai-completions",
		name: "Fixture Gateway",
		models: [{ id: "fixture-model" }],
	};
	await mkdir(join(base, "agent"), { recursive: true });
	await writeFile(join(base, "models.json"), JSON.stringify({ providers: { mygw: provider } }));
	await writeFile(join(base, "auth.json"), JSON.stringify({ mygw: { type: "api_key", key: "test-key" } }));
	await writeFile(join(base, "config.toml"), 'defaultProvider = "mygw"\ndefaultModel = "fixture-model"\n');
	return {
		get requests() {
			return requests;
		},
		releaseFirst: () => release?.(),
		stop: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

async function waitFor(check: () => boolean, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("condition did not become true before the deadline");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function queuedLength(session: { snapshot(): unknown }): number {
	return (session.snapshot() as { queuedMessages: unknown[] }).queuedMessages.length;
}

test("a stopped run leaves the queue parked until the next run starts", { timeout: 60_000 }, async () => {
	const base = await mkdtemp(join(tmpdir(), "stepcode-web-park-"));
	const fixture = await startFixture(base);
	const previous = {
		agentDir: process.env.STEP_CODING_AGENT_DIR,
		authPath: process.env.STEPCODE_AUTH_PATH,
		apiKey: process.env.STEP_API_KEY,
	};
	process.env.STEP_CODING_AGENT_DIR = join(base, "agent");
	process.env.STEPCODE_AUTH_PATH = join(base, "auth.json");
	delete process.env.STEP_API_KEY;
	let store: WebSessionStore | undefined;
	try {
		store = new WebSessionStore();
		const session = await store.create(base);

		const running = session.send("long task");
		await waitFor(() => fixture.requests === 1);

		// The page shows the turn as running, so the composer queues this one.
		session.enqueue({ text: "after the stop", attachments: [], files: [] });
		assert.equal(queuedLength(session), 1);

		await session.interrupt();
		fixture.releaseFirst();
		await running.catch(() => {});
		await waitFor(() => !session.isBusy());
		// Parked: the queue does not start on its own after a stop.
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(queuedLength(session), 1, "a stopped run dispatched what it was holding");

		// A new message starts a run, which releases the park and drains the queue.
		await session.send("retry");
		await waitFor(() => !session.isBusy() && queuedLength(session) === 0);
		assert.ok(fixture.requests >= 3, `the parked message never ran (${fixture.requests} requests)`);
	} finally {
		fixture.releaseFirst();
		await store?.interruptAndClose().catch(() => {});
		await fixture.stop();
		await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		for (const [key, value] of [
			["STEP_CODING_AGENT_DIR", previous.agentDir],
			["STEPCODE_AUTH_PATH", previous.authPath],
			["STEP_API_KEY", previous.apiKey],
		] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});
