import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mergeEntries } from "../client/src/state/timeline-reuse.ts";
import type { SessionEntry } from "../client/src/state/types.ts";
import { WebSessionStore } from "../src/runtime.ts";

/**
 * A real turn through the host: the model reads an image with `read_file`, then
 * answers. What a page builds from the snapshot it opened with plus the stream's
 * `entries` events must be exactly what a fresh snapshot reports, without the
 * image's data, which only the image route serves.
 */

/** 1x1 transparent PNG. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function startFixture(): Promise<{ baseUrl: string; stop(): Promise<void> }> {
	const server: Server = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		if ((request.headers.authorization ?? "") !== "Bearer test-key") {
			response.writeHead(401, { "content-type": "application/json" });
			return response.end(JSON.stringify({ error: { message: "bad key" } }));
		}
		if (url.pathname.endsWith("/models")) {
			response.writeHead(200, { "content-type": "application/json" });
			return response.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
		}
		let raw = "";
		for await (const chunk of request) raw += chunk;
		const body = JSON.parse(raw) as {
			tools?: { function?: { name?: string } }[];
			messages?: { role?: string }[];
		};
		const tools = Array.isArray(body.tools) ? body.tools : [];
		const last = body.messages?.at(-1);
		response.writeHead(200, { "content-type": "text/event-stream" });
		const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
			response.write(
				`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
			);
		if (tools.length && last?.role === "user") {
			const read = tools.find((tool) => tool.function?.name === "read_file") ? "read_file" : "read";
			chunk({ reasoning_content: "Look at the image first." });
			chunk({
				tool_calls: [
					{ index: 0, id: "read-1", type: "function", function: { name: read, arguments: JSON.stringify({ path: "pixel.png" }) } },
				],
			});
			chunk({}, "tool_calls");
		} else {
			chunk({ reasoning_content: "It is a single pixel." });
			chunk({ content: tools.length ? "The image is one transparent pixel." : "Pixel check" });
			chunk({}, "stop");
		}
		response.end("data: [DONE]\n\n");
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

test("stream entries rebuild the snapshot, `after` reads send only the tail, images stay behind their route", { timeout: 60_000 }, async () => {
	const base = await mkdtemp(join(tmpdir(), "stepcode-web-stream-entries-"));
	const fixture = await startFixture();
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
		await mkdir(join(base, "agent"), { recursive: true });
		await writeFile(
			join(base, "models.json"),
			`${JSON.stringify({
				providers: {
					mygw: { baseUrl: fixture.baseUrl, api: "openai-completions", name: "Fixture", models: [{ id: "fixture-model" }] },
				},
			})}\n`,
		);
		await writeFile(join(base, "auth.json"), `${JSON.stringify({ mygw: { type: "api_key", key: "test-key" } })}\n`);
		await writeFile(join(base, "config.toml"), `defaultProvider = "mygw"\ndefaultModel = "fixture-model"\n`);
		const workspace = join(base, "workspace");
		await mkdir(workspace, { recursive: true });
		await writeFile(join(workspace, "pixel.png"), Buffer.from(PNG, "base64"));

		const session = await store.create(workspace);
		let held = ((session.snapshot() as { entries?: SessionEntry[] }).entries ?? []) as readonly SessionEntry[];
		let lastRevision = 0;
		const unsubscribe = session.subscribe((event) => {
			assert.ok(event.revision > lastRevision, "events stay in revision order");
			lastRevision = event.revision;
			if (event.type === "approval_required") void session.decideApproval(event.approval.id, "approve");
			if (event.type !== "entries") return;
			const incoming = event.entries as unknown as SessionEntry[];
			held = event.reset ? incoming : mergeEntries(held, incoming);
		});
		await session.send("What is in pixel.png?");
		// Entries recorded by the run's last events are published on the next microtask.
		await new Promise((resolve) => setTimeout(resolve, 50));
		unsubscribe();

		const fresh = session.snapshot() as { entries: SessionEntry[] };
		assert.ok(fresh.entries.length >= 4, `a user prompt, two replies and a tool result (${fresh.entries.length})`);
		assert.deepEqual(held, fresh.entries, "snapshot + entries events = a fresh snapshot");

		const result = fresh.entries.find((entry) => entry.message?.role === "toolResult");
		assert.ok(result, "the read was recorded");
		const content = result.message?.content as { type: string; data?: string; omitted?: boolean }[];
		const image = content.find((part) => part.type === "image");
		assert.deepEqual(image && { omitted: image.omitted, data: image.data }, { omitted: true, data: undefined });
		assert.equal(JSON.stringify(fresh).includes(PNG), false, "the snapshot carries no image data");
		assert.equal(session.entryImage(result.id, 0)?.data, PNG, "the image route serves the recorded data");
		assert.equal(session.entryImage(result.id, 1), undefined);

		const cut = fresh.entries.findIndex((entry) => entry.id === result.id);
		const after = session.snapshot(result.id) as { entries: SessionEntry[]; entriesAfter?: string };
		assert.equal(after.entriesAfter, result.id);
		assert.deepEqual(
			after.entries.map((entry) => entry.id),
			fresh.entries.slice(cut + 1).map((entry) => entry.id),
			"an `after` read carries only what follows that entry",
		);
		const unknown = session.snapshot("not-on-this-branch") as { entries: SessionEntry[]; entriesAfter?: string };
		assert.equal(unknown.entriesAfter, undefined, "an id off the branch gets the whole branch");
		assert.equal(unknown.entries.length, fresh.entries.length);
	} finally {
		await store.close();
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
