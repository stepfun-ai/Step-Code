import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSessionStore } from "../src/runtime.ts";

interface Fixture {
	readonly server: Server;
	readonly base: string;
	readonly started: Promise<void>;
	readonly requests: string[];
	stop(): Promise<void>;
}

/**
 * A local OpenAI-compatible endpoint that answers `/v1/models` and streams one
 * slow completion. The turn must still be running when sign-out interrupts it.
 */
async function startFixture(base: string): Promise<Fixture> {
	const requests: string[] = [];
	let markStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	const server = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		requests.push(`${request.method ?? "GET"} ${url.pathname}`);
		const authorized = (request.headers.authorization ?? "") === "Bearer test-key";
		if (!authorized) {
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
		let raw = "";
		for await (const chunk of request) raw += chunk;
		response.writeHead(200, { "content-type": "text/event-stream" });
		const chunk = (delta: Record<string, unknown>, finish: string | null = null) => {
			response.write(
				`data: ${JSON.stringify({
					id: "fixture",
					object: "chat.completion.chunk",
					model: "fixture-model",
					choices: [{ index: 0, delta, finish_reason: finish }],
				})}\n\n`,
			);
		};
		chunk({ content: "working " });
		// The session's title request also reaches this endpoint, and it can arrive first:
		// the turn waits for the awaited `before_agent_start` hooks (MCP reconciliation)
		// before its own request. Only the turn's request carries the tool catalog, and the
		// interrupt must land while that request streams, or no assistant message exists yet.
		const body = JSON.parse(raw) as { tools?: unknown };
		if (Array.isArray(body.tools) && body.tools.length > 0) markStarted();
		const timer = setInterval(() => chunk({ content: "still working " }), 100);
		request.on("close", () => clearInterval(timer));
		response.on("close", () => clearInterval(timer));
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
	await writeFile(
		join(base, "config.toml"),
		`defaultProvider = "mygw"\ndefaultModel = "fixture-model"\n`,
		"utf8",
	);
	return {
		server,
		base,
		started,
		requests,
		stop: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("condition did not become true before the deadline");
}

test("sign-out interrupts a running turn before closing, so the transcript stays on disk", { timeout: 60_000 }, async () => {
	const base = await mkdtemp(join(tmpdir(), "stepcode-web-interrupt-close-"));
	const fixture = await startFixture(base);
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
		const store = new WebSessionStore();
		const session = await store.create(base);
		// `prompt` settles with the turn, not when it starts; keep it pending so the
		// sign-out can interrupt a running turn.
		const sending = session.send("slow signout probe").catch((error: unknown) => error);
		await fixture.started;
		await waitFor(() => session.isBusy());
		const sessionFile = session.sessionFile();
		assert.ok(sessionFile, "the running session must already have a transcript file");

		await store.interruptAndClose();
		await sending;

		// The store forgot the closed session, but the transcript it wrote remains.
		assert.equal(existsSync(sessionFile), true);
		const transcript = await readFile(sessionFile, "utf8");
		assert.match(transcript, /slow signout probe/u);
		const messages = transcript
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { type?: string; message?: { role?: string; stopReason?: string } });
		assert.ok(
			messages.some((entry) => entry.type === "message" && entry.message?.role === "user"),
			"the user message must survive the interrupt",
		);
		assert.ok(
			messages.some((entry) => entry.type === "message" && entry.message?.stopReason === "aborted"),
			"the interrupted assistant message must be recorded as aborted",
		);
	} finally {
		await fixture.stop();
		await rm(base, { recursive: true, force: true });
		process.env.STEP_CODING_AGENT_DIR = previous.agentDir;
		process.env.STEPCODE_AUTH_PATH = previous.authPath;
		if (previous.apiKey === undefined) delete process.env.STEP_API_KEY;
		else process.env.STEP_API_KEY = previous.apiKey;
		if (previous.loginState === undefined) delete process.env.STEPCODE_LOGIN_STATE_PATH;
		else process.env.STEPCODE_LOGIN_STATE_PATH = previous.loginState;
	}
});
