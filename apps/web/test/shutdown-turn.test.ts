import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionEntry } from "@step-harness/coding-agent";
import { hasInterruptedTurn, type WebSession, WebSessionStore } from "../src/runtime.ts";

interface Fixture {
	readonly server: Server;
	readonly baseUrl: string;
	/** Resolves once a turn the fixture holds open has started streaming. */
	readonly started: Promise<void>;
	stop(): Promise<void>;
}

/**
 * A local OpenAI-compatible endpoint. `completeTurns` turns finish normally;
 * every turn after them streams reasoning forever, so a shutdown lands
 * mid-stream — the state a desktop restart finds. Title requests (which carry
 * no tool catalog) are answered separately and never look like a turn.
 */
async function startFixture(completeTurns: number): Promise<Fixture> {
	let turnRequests = 0;
	let markStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	const server = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
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
		const body = JSON.parse(raw) as { tools?: unknown };
		const isTurn = Array.isArray(body.tools) && body.tools.length > 0;
		if (isTurn) turnRequests += 1;
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
		const finishTurn = (thought: string, answer: string) => {
			chunk({ reasoning_content: thought });
			chunk({ content: answer });
			chunk({}, "stop");
			response.write("data: [DONE]\n\n");
			response.end();
		};
		if (!isTurn) return finishTurn("naming", "title");
		if (turnRequests <= completeTurns) return finishTurn("first turn thought ", "first turn answer");
		// The held turn already has a thought on screen when the host stops.
		chunk({ reasoning_content: "partial thought before restart " });
		markStarted();
		const timer = setInterval(() => chunk({ reasoning_content: "still thinking " }), 100);
		request.on("close", () => clearInterval(timer));
		response.on("close", () => clearInterval(timer));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("fixture did not bind a port");
	return {
		server,
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		started,
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

/**
 * Wait until the model's thought has actually reached this session, so the
 * shutdown interrupts a turn the page would already be drawing.
 */
async function waitForStreamedThought(session: WebSession): Promise<void> {
	const thought = new Promise<void>((resolve) => {
		const unsubscribe = session.subscribe((event) => {
			if (event.type !== "agent" || event.event.type !== "message_update") return;
			const content = event.event.message.content;
			if (!Array.isArray(content)) return;
			if (!content.some((block) => block.type === "thinking" && typeof block.thinking === "string" && block.thinking)) {
				return;
			}
			unsubscribe();
			resolve();
		});
	});
	await thought;
}

async function withWorkspace(
	completeTurns: number,
	run: (base: string, fixture: Fixture) => Promise<void>,
): Promise<void> {
	const base = await mkdtemp(join(tmpdir(), "stepcode-web-shutdown-turn-"));
	const fixture = await startFixture(completeTurns);
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
		await mkdir(join(base, "agent"), { recursive: true });
		await writeFile(
			join(base, "models.json"),
			`${JSON.stringify({
				providers: {
					mygw: {
						baseUrl: fixture.baseUrl,
						api: "openai-completions",
						name: "Fixture Gateway",
						models: [{ id: "fixture-model" }],
					},
				},
			})}\n`,
			"utf8",
		);
		await writeFile(
			join(base, "auth.json"),
			`${JSON.stringify({ mygw: { type: "api_key", key: "test-key" } })}\n`,
			"utf8",
		);
		await writeFile(join(base, "config.toml"), `defaultProvider = "mygw"\ndefaultModel = "fixture-model"\n`, "utf8");
		await run(base, fixture);
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
}

test("host shutdown keeps the reply that was streaming", { timeout: 60_000 }, async () => {
	await withWorkspace(1, async (base, fixture) => {
		const store = new WebSessionStore();
		const session = await store.create(base);
		await session.send("first probe");
		const sessionFile = session.sessionFile();
		assert.ok(sessionFile, "the finished turn has a transcript");

		const sending = session.send("second probe").catch(() => undefined);
		await fixture.started;
		await waitForStreamedThought(session);
		assert.equal(
			(session.snapshot() as { interruptedTurn?: boolean }).interruptedTurn,
			false,
			"a turn still in flight is not interrupted yet",
		);

		// What a desktop restart does: SIGTERM, then host shutdown.
		await store.interruptAndClose({ graceMs: 3_000, reason: "host shutdown" });
		await sending;

		const transcript = await readFile(sessionFile, "utf8");
		assert.ok(
			transcript.includes("partial thought before restart"),
			"the thinking the page had shown must reach the session file",
		);
		const assistants = transcript
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { type?: string; message?: { role?: string; stopReason?: string } })
			.filter((entry) => entry.type === "message" && entry.message?.role === "assistant");
		assert.deepEqual(
			assistants.map((entry) => entry.message?.stopReason),
			["stop", "aborted"],
		);

		// Reopening the transcript (as the restarted host does) reports the interruption.
		const reopened = await store.getOrOpen(session.id);
		assert.equal((reopened.snapshot() as { interruptedTurn?: boolean }).interruptedTurn, true);
		await store.close();
	});
});

test("a first turn cut off by shutdown still leaves a session on disk", { timeout: 60_000 }, async () => {
	await withWorkspace(0, async (base, fixture) => {
		const store = new WebSessionStore();
		const session = await store.create(base);
		const sessionFile = session.sessionFile();
		assert.ok(sessionFile);
		assert.equal(existsSync(sessionFile), false, "nothing has been said yet");

		const sending = session.send("only probe").catch(() => undefined);
		await fixture.started;
		await waitForStreamedThought(session);
		await store.interruptAndClose({ graceMs: 3_000, reason: "host shutdown" });
		await sending;

		// The prompt alone is enough: the file now exists, so the conversation is
		// in the sidebar instead of vanishing with the process.
		assert.equal(existsSync(sessionFile), true);
		const transcript = await readFile(sessionFile, "utf8");
		assert.ok(transcript.includes("only probe"));
	});
});

test("an accepted prompt counts as busy before its run starts", { timeout: 60_000 }, async () => {
	// One completed turn first: extension startup is what makes a later `send`
	// take the direct path, where nothing has reported "running" yet.
	await withWorkspace(1, async (base) => {
		const store = new WebSessionStore();
		const session = await store.create(base);
		await session.send("warm up");
		const sending = session.send("prompt during setup").catch(() => undefined);
		assert.equal(session.isBusy(), true, "an accepted prompt counts as busy before its run starts");
		assert.equal(
			(session.snapshot() as { interruptedTurn?: boolean }).interruptedTurn,
			false,
			"a turn that is still starting is not an interrupted turn",
		);
		await store.interruptAndClose({ graceMs: 3_000, reason: "host shutdown" });
		await sending;
	});
});

test("a prompt still being set up when shutdown begins is stopped, not disposed", { timeout: 60_000 }, async () => {
	await withWorkspace(1, async (base) => {
		const store = new WebSessionStore();
		const session = await store.create(base);
		await session.send("warm up");
		const sessionFile = session.sessionFile();
		assert.ok(sessionFile);

		const sending = session.send("prompt during shutdown").catch(() => undefined);
		await store.interruptAndClose({ graceMs: 3_000, reason: "host shutdown" });
		await sending;

		const transcript = await readFile(sessionFile, "utf8");
		assert.ok(transcript.includes("prompt during shutdown"), "the prompt must reach the transcript");
		const assistants = transcript
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { type?: string; message?: { role?: string; stopReason?: string } })
			.filter((entry) => entry.type === "message" && entry.message?.role === "assistant");
		assert.deepEqual(
			assistants.map((entry) => entry.message?.stopReason),
			["stop", "aborted"],
			"the run that started during shutdown must be aborted, not disposed",
		);
	});
});

test("a closed session refuses new prompts instead of spending a model call", { timeout: 60_000 }, async () => {
	await withWorkspace(1, async (base) => {
		const store = new WebSessionStore();
		const session = await store.create(base);
		await session.send("warm up");
		await session.close();
		await assert.rejects(() => session.send("after close"), /closing/u);
		assert.equal(session.isBusy(), false);
	});
});

test("a goal start is tracked and refuses to start after close", { timeout: 60_000 }, async () => {
	await withWorkspace(1, async (base, fixture) => {
		const store = new WebSessionStore();
		const session = await store.create(base);
		await session.send("warm up");

		// `/goal <objective>` runs a real turn, but through the goal strip rather
		// than `send`. It must count as a pending turn from the moment it is
		// accepted, or a shutdown in its pre-run window disposes the session with
		// the turn still in memory.
		const starting = session.controlGoal("start", "keep the transcript whole").catch(() => undefined);
		assert.equal(session.isBusy(), true, "a goal start counts as a pending turn");
		await fixture.started;
		await store.interruptAndClose({ graceMs: 3_000, reason: "host shutdown" });
		await starting;

		const transcript = await readFile(session.sessionFile()!, "utf8");
		assert.ok(transcript.includes("keep the transcript whole"), "the goal objective must be journaled");
	});

	await withWorkspace(1, async (base) => {
		const store = new WebSessionStore();
		const session = await store.create(base);
		await session.send("warm up");
		await session.close();
		await assert.rejects(() => session.controlGoal("start", "too late"), /closing/u);
		await assert.rejects(() => session.setMode("goal", true, "too late"), /closing/u);
	});
});

test("hasInterruptedTurn reads the newest turn, not the newest message kind", () => {
	const user = (id: string): SessionEntry =>
		({ type: "message", id, timestamp: "", message: { role: "user", content: "hi" } }) as SessionEntry;
	const assistant = (id: string, stopReason: string, content?: unknown[]): SessionEntry =>
		({
			type: "message",
			id,
			timestamp: "",
			message: { role: "assistant", stopReason, content: content ?? [{ type: "text", text: "ok" }] },
		}) as SessionEntry;
	const call = { type: "toolCall", id: "call-1", name: "bash", arguments: {} };
	const toolResult = (id: string): SessionEntry =>
		({
			type: "message",
			id,
			timestamp: "",
			message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: "ok" },
		}) as SessionEntry;

	assert.equal(hasInterruptedTurn([user("u")], false), true, "a prompt with no reply was cut off");
	assert.equal(hasInterruptedTurn([user("u")], true), false, "unless the turn is still running");
	assert.equal(hasInterruptedTurn([user("u"), assistant("a", "stop")], false), false);
	assert.equal(hasInterruptedTurn([user("u"), assistant("a", "aborted")], false), true);
	assert.equal(
		hasInterruptedTurn([user("u"), assistant("a", "aborted"), user("u2"), assistant("a2", "stop")], false),
		false,
		"an interrupted turn the user retried is no longer the newest",
	);
	assert.equal(hasInterruptedTurn([], false), false);
	const imported: NonNullable<SessionEntry["imported"]> = {
		source: "codex",
		sessionId: "source-session",
		itemId: "source-item",
	};
	const importedEntry = (entry: SessionEntry): SessionEntry => ({ ...entry, imported });
	for (const tail of [user("iu"), assistant("ia", "toolUse"), assistant("ab", "aborted"), toolResult("ir")]) {
		const history = [importedEntry(user("iu0")), importedEntry(tail)];
		assert.equal(hasInterruptedTurn(history, false), false, "a source snapshot is not a native interruption");
		assert.equal(hasInterruptedTurn([...history, user("nu")], false), true, "a native continuation remains checked");
		assert.equal(hasInterruptedTurn([...history, assistant("na", "aborted")], false), true);
		assert.equal(hasInterruptedTurn([...history, assistant("nc", "stop")], false), false);
	}
	// Tool work: a killed host leaves an assistant whose calls never answered.
	assert.equal(hasInterruptedTurn([user("u"), assistant("a", "toolUse", [call])], false), true);
	assert.equal(
		hasInterruptedTurn([user("u"), assistant("a", "toolUse", [call]), toolResult("r")], false),
		false,
		"a settled batch answers every call, so a trailing result is not an interruption",
	);
	const twoCalls = { type: "toolCall", id: "call-2", name: "bash", arguments: {} };
	assert.equal(
		hasInterruptedTurn([user("u"), assistant("a", "toolUse", [call, twoCalls]), toolResult("r")], false),
		true,
		"a batch cut off mid-way leaves a call unanswered",
	);
	// A settled tool turn's newest entry is the assistant that answered it.
	assert.equal(
		hasInterruptedTurn(
			[user("u"), assistant("a", "toolUse", [call]), toolResult("r"), assistant("a2", "stop")],
			false,
		),
		false,
	);
	// Errors and truncation are rendered as what they are, not as interruptions.
	assert.equal(hasInterruptedTurn([user("u"), assistant("a", "error")], false), false);
	assert.equal(hasInterruptedTurn([user("u"), assistant("a", "length")], false), false);
});
