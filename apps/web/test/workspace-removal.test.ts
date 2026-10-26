import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSessionStore } from "../src/runtime.ts";
import { WORKSPACES_FILE, WorkspaceRegistry } from "../src/workspaces.ts";

/**
 * Deleting a workspace from the sidebar has to remove it from the sidebar and
 * from the composer's workspace picker, including after a reload — and it has to
 * work when the folder is named one way by the registry and another way by the
 * session that was created in it.
 *
 * The client compares plain strings: `removed.has(session.cwd)` decides whether
 * a project group is still drawn, and `knownWorkspaces` filters by the same
 * paths. So the host has to report one spelling per folder, and a removal has to
 * cover that spelling.
 */

function chunk(delta: Record<string, unknown>, finish: string | null): string {
	const body = { id: "f", object: "chat.completion.chunk", model: "fixture-model" };
	return `data: ${JSON.stringify({ ...body, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

async function startFixture(): Promise<{ baseUrl: string; stop(): Promise<void> }> {
	const server: Server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		if (url.pathname.endsWith("/models")) {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
			return;
		}
		request.resume();
		request.on("end", () => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write(chunk({ content: "ok" }, null));
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

async function startHome(fixtureBaseUrl: string): Promise<string> {
	const base = await realpath(await mkdtemp(join(tmpdir(), "stepcode-web-remove-")));
	await mkdir(join(base, "agent"), { recursive: true });
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
	"STEPCODE_STEPGO_IMPORT",
	"STEP_API_KEY",
] as const;

function snapshotEnvironment(): Record<string, string | undefined> {
	const snapshot: Record<string, string | undefined> = {};
	for (const key of ENVIRONMENT_KEYS) snapshot[key] = process.env[key];
	return snapshot;
}

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

test("a removed workspace leaves the host's list and the session rows agree on its name", { timeout: 60_000 }, async () => {
	const previous = snapshotEnvironment();
	const fixture = await startFixture();
	const home = await startHome(fixture.baseUrl);
	const store = new WebSessionStore();
	try {
		isolate(home);
		const folder = join(home, "project");
		await mkdir(folder);
		// A second name for the same folder: what a symlinked launcher or a
		// session created through another spelling carries.
		const link = join(home, "project-link");
		await symlink(folder, link);

		const registry = new WorkspaceRegistry(join(home, "agent", WORKSPACES_FILE));
		await registry.add(folder);

		const session = await store.create(link);
		await session.send("hello");
		await waitForIdle(session);

		// The sidebar's group key is the session row's cwd, so it has to be the
		// spelling the registry stores, or a removal under either name misses it.
		const listed = await store.list();
		assert.equal(listed.length, 1);
		assert.equal(listed[0]!.cwd, folder, "the session row keeps a different name for the same folder");

		// The user removes the workspace from the sidebar, which sends that name.
		await registry.remove(link);

		const workspaces = await registry.list();
		assert.deepEqual(
			workspaces.filter((workspace) => !workspace.hidden).map((workspace) => workspace.path),
			[],
			"the workspace is still offered after being deleted",
		);
		// After a reload the same answer: nothing is rebuilt from the session cwd.
		const reopened = new WorkspaceRegistry(join(home, "agent", WORKSPACES_FILE));
		const removed = new Set(
			(await reopened.list()).filter((workspace) => workspace.hidden).map((workspace) => workspace.path),
		);
		assert.ok(removed.has(folder), "the registered spelling is not hidden for the client's comparison");
		assert.ok(
			(await store.list()).every((row) => row.cwd === folder && removed.has(row.cwd)),
			"a session row would still draw its project group",
		);
	} finally {
		await store.interruptAndClose().catch(() => {});
		await fixture.stop();
		await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});
