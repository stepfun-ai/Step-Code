import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSessionStore } from "../src/runtime.ts";

/**
 * A feedback report filed from this host.
 *
 * The kernel decides what a report carries; this host must call it instead of
 * assembling its own payload, must name the surface it came from, and must show
 * the user the evidence before sending it. A report that carried only the user's
 * sentence could not be investigated, which is what these cases prevent.
 */

interface FeedbackBody {
	readonly schemaVersion?: number;
	readonly surface?: string;
	readonly comment?: string;
	readonly context?: { version?: string; channel?: string; versionSource?: string; sessionId?: string };
	readonly sessionSummary?: { counts?: { turns?: number; toolCalls?: number } };
	readonly request?: { requestId?: string };
}

interface Collector {
	readonly bodies: FeedbackBody[];
	readonly archives: Array<{ query: string; bytes: number }>;
	readonly endpoint: string;
	readonly bundleEndpoint: string;
	readonly feedbackId: string;
	stop(): Promise<void>;
}

/** A feedback endpoint and a bundle endpoint, both stubs that record what arrived. */
async function startCollector(): Promise<Collector> {
	const bodies: FeedbackBody[] = [];
	const archives: Array<{ query: string; bytes: number }> = [];
	const feedbackId = "fb-test-0001";
	const server: Server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		const chunks: Buffer[] = [];
		request.on("data", (part: Buffer) => {
			chunks.push(part);
		});
		request.on("end", () => {
			const body = Buffer.concat(chunks);
			if (url.pathname === "/bundle") {
				archives.push({ query: url.search, bytes: body.byteLength });
			} else {
				bodies.push(JSON.parse(body.toString("utf8")) as FeedbackBody);
			}
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ ok: true, feedbackId }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("collector did not bind a port");
	const base = `http://127.0.0.1:${address.port}`;
	return {
		bodies,
		archives,
		endpoint: `${base}/feedback`,
		bundleEndpoint: `${base}/bundle`,
		feedbackId,
		stop: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

function chunk(delta: Record<string, unknown>, finish: string | null): string {
	const body = { id: "f", object: "chat.completion.chunk", model: "fixture-model" };
	return `data: ${JSON.stringify({ ...body, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

/** One scripted OpenAI-compatible model, so the session under test has real entries. */
async function startFixture(): Promise<{ baseUrl: string; stop(): Promise<void> }> {
	const server: Server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		if (url.pathname.endsWith("/models")) {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
			return;
		}
		// Drain the request before answering: an unread body keeps the connection
		// from settling, and the session would wait on it.
		request.resume();
		request.on("end", () => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write(chunk({ content: "fixture reply" }, null));
			response.write(chunk({}, "stop"));
			response.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("fixture did not bind a port");
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		stop: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

/** Isolated home for one test: agent dir, credentials, storage root and models. */
async function startHome(fixtureBaseUrl: string): Promise<string> {
	const base = await mkdtemp(join(tmpdir(), "stepcode-web-feedback-"));
	await mkdir(join(base, "agent"), { recursive: true });
	await writeFile(join(base, "README.md"), "# scratch\n");
	await writeFile(
		join(base, "models.json"),
		JSON.stringify({
			providers: {
				mygw: { baseUrl: fixtureBaseUrl, api: "openai-completions", name: "Fixture", models: [{ id: "fixture-model" }] },
			},
		}),
	);
	await writeFile(join(base, "auth.json"), JSON.stringify({ mygw: { type: "api_key", key: "test-key" } }));
	await writeFile(join(base, "config.toml"), 'defaultProvider = "mygw"\ndefaultModel = "fixture-model"\n');
	return base;
}

const ENVIRONMENT_KEYS = [
	"STEP_CODING_AGENT_DIR",
	"STEPCODE_AUTH_PATH",
	"STEPCODE_STORAGE_ROOT_DIR",
	"STEPCODE_FEEDBACK_ENDPOINT",
	"STEPCODE_FEEDBACK_BUNDLE_ENDPOINT",
	"STEPCODE_DISABLE_FEEDBACK",
	"STEP_API_KEY",
	"STEPCODE_STEPGO_IMPORT",
] as const;

function snapshotEnvironment(): Record<string, string | undefined> {
	const snapshot: Record<string, string | undefined> = {};
	for (const key of ENVIRONMENT_KEYS) snapshot[key] = process.env[key];
	return snapshot;
}

/** Restore every variable this file sets, whatever the test did with them. */
function restoreEnvironment(previous: Readonly<Record<string, string | undefined>>): void {
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

/** Point every Step path at `home`, so no test reads the developer's real state. */
function isolate(home: string): void {
	process.env.STEP_CODING_AGENT_DIR = join(home, "agent");
	process.env.STEPCODE_AUTH_PATH = join(home, "auth.json");
	process.env.STEPCODE_STORAGE_ROOT_DIR = join(home, "storage");
	process.env.STEPCODE_STEPGO_IMPORT = "0";
	delete process.env.STEP_API_KEY;
}

async function waitForIdle(session: { isBusy(): boolean }): Promise<void> {
	const deadline = Date.now() + 20_000;
	while (session.isBusy()) {
		if (Date.now() > deadline) throw new Error("the session did not settle before the deadline");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

test("a report carries the session evidence, the archive and this host's surface", { timeout: 60_000 }, async () => {
	const previous = snapshotEnvironment();
	const fixture = await startFixture();
	const collector = await startCollector();
	const home = await startHome(fixture.baseUrl);
	const store = new WebSessionStore();
	try {
		isolate(home);
		process.env.STEPCODE_FEEDBACK_ENDPOINT = collector.endpoint;
		process.env.STEPCODE_FEEDBACK_BUNDLE_ENDPOINT = collector.bundleEndpoint;

		const session = await store.create(home);
		await session.send("hello there");
		await waitForIdle(session);

		// The Web host renders no `/usage` panel, but provenance belongs to the
		// session lifecycle: without it a report from this host names no request.
		const sessionFile = session.sessionFile();
		assert.ok(sessionFile, "the session has no file to record provenance in");
		const entries = (await readFile(sessionFile, "utf8"))
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as { customType?: string; data?: { requestId?: unknown } });
		const provenance = entries.find((entry) => entry.customType === "step.usage_provenance");
		assert.ok(provenance, "the session recorded no step.usage_provenance entry");
		assert.equal(typeof provenance.data?.requestId, "string", "the provenance entry has no request id to join on");

		// What the dialog shows before it offers to send anything.
		const draft = await session.prepareFeedback();
		assert.ok(draft.token.length > 0, "the preview names no token, so a submission cannot send the same evidence");
		assert.equal(draft.preview.surface, "web");
		assert.equal(draft.preview.summary, true, "the content-free summary is not prepared");
		assert.ok(
			draft.preview.archive?.some((file) => file.name === "events.jsonl"),
			"the transcript archive is not prepared",
		);
		assert.ok(draft.preview.archive?.length, "the archive names no files");

		const result = await session.submitFeedback({
			sentiment: "down",
			topic: "taskResult",
			comment: "the reply stopped halfway",
			token: draft.token,
		});
		assert.equal(result.ok, true, result.message);
		// The kernel owns the report id and sends it with the body; the endpoint's
		// reply is not an authority on it.
		assert.equal(typeof result.feedbackId, "string");
		assert.ok(result.feedbackId.length > 0, "the host reported no feedback id");

		assert.equal(collector.bodies.length, 1, "one report body was expected");
		const body = collector.bodies[0]!;
		assert.equal(body.surface, "web", "the report must not claim to come from the CLI");
		assert.equal(body.schemaVersion, 2);
		assert.equal(body.comment, "[taskResult] the reply stopped halfway");
		assert.equal(body.sessionSummary?.counts?.turns, 1, "the summary does not describe this conversation");
		assert.ok(body.sessionSummary?.counts?.toolCalls === 0, "the summary counted tool calls that never ran");
		assert.equal(body.context?.sessionId, session.id, "the report names another session");
		assert.ok(body.context?.version, "the report names no build");
		assert.equal(typeof body.request?.requestId, "string", "the report has no request id to look up");
		// The archive travels as its own request, keyed by the report it belongs to.
		assert.equal(collector.archives.length, 1);
		assert.ok(collector.archives[0]!.query.includes(`feedbackId=${result.feedbackId}`), collector.archives[0]!.query);
		assert.ok(collector.archives[0]!.bytes > 0, "the archive upload is empty");
	} finally {
		await store.interruptAndClose().catch(() => {});
		await fixture.stop();
		await collector.stop();
		await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		restoreEnvironment(previous);
	}
});

test("without a bundle endpoint the report says the transcript is not attached", { timeout: 60_000 }, async () => {
	const previous = snapshotEnvironment();
	const fixture = await startFixture();
	const collector = await startCollector();
	const home = await startHome(fixture.baseUrl);
	const store = new WebSessionStore();
	try {
		isolate(home);
		process.env.STEPCODE_FEEDBACK_ENDPOINT = collector.endpoint;
		delete process.env.STEPCODE_FEEDBACK_BUNDLE_ENDPOINT;

		const session = await store.create(home);
		await session.send("hello there");
		await waitForIdle(session);

		const draft = await session.prepareFeedback();
		assert.equal(draft.preview.archive, undefined, "an archive is promised with nowhere to send it");
		assert.match(draft.preview.archiveNote ?? "", /bundle endpoint/i);
		const result = await session.submitFeedback({ sentiment: "up", comment: "fine", token: draft.token });
		assert.equal(result.ok, true, result.message);
		assert.equal(collector.archives.length, 0, "an archive was uploaded without an endpoint");
		// The summary still travels: it is the part that needs no archive endpoint.
		assert.equal(collector.bodies[0]?.sessionSummary?.counts?.turns, 1);
	} finally {
		await store.interruptAndClose().catch(() => {});
		await fixture.stop();
		await collector.stop();
		await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		restoreEnvironment(previous);
	}
});

test("an undeliverable report is reported as pending, not as submitted", { timeout: 60_000 }, async () => {
	const previous = snapshotEnvironment();
	const fixture = await startFixture();
	const home = await startHome(fixture.baseUrl);
	const store = new WebSessionStore();
	try {
		isolate(home);
		// A port nothing listens on: delivery fails, and the kernel keeps the body
		// locally for `step feedback --retry`.
		process.env.STEPCODE_FEEDBACK_ENDPOINT = "http://127.0.0.1:1/feedback";
		delete process.env.STEPCODE_FEEDBACK_BUNDLE_ENDPOINT;

		const session = await store.create(home);
		const result = await session.submitFeedback({ sentiment: "up", comment: "hello" });
		assert.equal(result.ok, false, "an undelivered report was reported as submitted");
		assert.equal(result.feedbackId, undefined);
		assert.match(result.message, /Saved to|not (?:be )?delivered|pending/i, result.message);
	} finally {
		await store.interruptAndClose().catch(() => {});
		await fixture.stop();
		await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		restoreEnvironment(previous);
	}
});

test("feedback without an endpoint is refused and nothing is prepared", { timeout: 60_000 }, async () => {
	const previous = snapshotEnvironment();
	const fixture = await startFixture();
	const home = await startHome(fixture.baseUrl);
	const store = new WebSessionStore();
	try {
		isolate(home);
		delete process.env.STEPCODE_FEEDBACK_ENDPOINT;
		delete process.env.STEPCODE_FEEDBACK_BUNDLE_ENDPOINT;

		const session = await store.create(home);
		await assert.rejects(
			() => session.prepareFeedback(),
			/Feedback is not configured/,
			"preparing evidence must fail when nothing can receive the report",
		);
		const result = await session.submitFeedback({ sentiment: "up", comment: "hello" });
		assert.deepEqual(result, { ok: false, message: "Feedback is not configured for this build." });
	} finally {
		await store.interruptAndClose().catch(() => {});
		await fixture.stop();
		await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		restoreEnvironment(previous);
	}
});

test("a token that no longer names prepared evidence is refused, not re-prepared", { timeout: 60_000 }, async () => {
	const previous = snapshotEnvironment();
	const fixture = await startFixture();
	const collector = await startCollector();
	const home = await startHome(fixture.baseUrl);
	const store = new WebSessionStore();
	try {
		isolate(home);
		process.env.STEPCODE_FEEDBACK_ENDPOINT = collector.endpoint;
		delete process.env.STEPCODE_FEEDBACK_BUNDLE_ENDPOINT;

		const session = await store.create(home);
		const draft = await session.prepareFeedback();
		// A second submission consumes the first: one preview, one report.
		const first = await session.submitFeedback({ sentiment: "up", comment: "one", token: draft.token });
		assert.equal(first.ok, true, first.message);
		const replay = await session.submitFeedback({ sentiment: "up", comment: "two", token: draft.token });
		assert.equal(replay.ok, false, "the same preview paid for two reports");
		assert.match(replay.message, /expired before sending/i, replay.message);
		assert.equal(collector.bodies.length, 1, "unreviewed evidence was sent after the preview expired");

		// A fork rebinds this object to another branch and another file: a token
		// prepared before it must not carry the parent's conversation into the child.
		await session.send("fork me");
		await waitForIdle(session);
		const bound = await session.prepareFeedback();
		await session.fork();
		const afterRebind = await session.submitFeedback({ sentiment: "up", comment: "three", token: bound.token });
		assert.equal(afterRebind.ok, false, "a token from the parent branch was accepted after a fork");
	} finally {
		await store.interruptAndClose().catch(() => {});
		await fixture.stop();
		await collector.stop();
		await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		restoreEnvironment(previous);
	}
});

test("a configured opt-out refuses the report on this surface too", { timeout: 60_000 }, async () => {
	const previous = snapshotEnvironment();
	const fixture = await startFixture();
	const collector = await startCollector();
	const home = await startHome(fixture.baseUrl);
	const store = new WebSessionStore();
	try {
		isolate(home);
		process.env.STEPCODE_FEEDBACK_ENDPOINT = collector.endpoint;
		delete process.env.STEPCODE_FEEDBACK_BUNDLE_ENDPOINT;
		// The documented opt-out (docs/feedback-report.md, "Consent") has to hold
		// on the surface that owns the dialog, not only in the terminal.
		process.env.STEPCODE_DISABLE_FEEDBACK = "1";

		const session = await store.create(home);
		await assert.rejects(() => session.prepareFeedback(), /disabled by environment settings/i);
		const result = await session.submitFeedback({ sentiment: "up", comment: "hello" });
		assert.deepEqual(result, { ok: false, message: "Feedback is disabled by environment settings." });
		assert.equal(collector.bodies.length, 0, "a disabled host still sent a report");
	} finally {
		await store.interruptAndClose().catch(() => {});
		await fixture.stop();
		await collector.stop();
		await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		restoreEnvironment(previous);
	}
});
