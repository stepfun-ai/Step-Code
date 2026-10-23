import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSessionStore } from "../src/runtime.ts";

/**
 * The host must mount the Step tool profile.
 *
 * The system prompt, the plan extension and the CLI all name Step's tools
 * (`read_file`, `write_file`, `edit_file`, `run_command`, …). A host that mounts
 * Pi's builtins instead (`read`, `write`, `edit`, `bash`) leaves plan mode
 * activating tools that do not exist, so a proposal cannot be written at all —
 * the failure reads "Tool write_file not found" in the transcript.
 */

interface Fixture {
	readonly server: Server;
	stop(): Promise<void>;
}

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
			// drain
		}
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.write(
			`data: ${JSON.stringify({
				id: "fixture",
				object: "chat.completion.chunk",
				model: "fixture-model",
				choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
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

test("the Web host offers Step tool names, not Pi's builtins", { timeout: 120_000 }, async () => {
	const base = await mkdtemp(join(tmpdir(), "stepcode-web-tools-"));
	const fixture = await startFixture(base);
	const previous = { agentDir: process.env.STEP_CODING_AGENT_DIR, authPath: process.env.STEPCODE_AUTH_PATH };
	process.env.STEP_CODING_AGENT_DIR = join(base, "agent");
	process.env.STEPCODE_AUTH_PATH = join(base, "auth.json");
	let store: WebSessionStore | undefined;
	try {
		store = new WebSessionStore();
		const session = await store.create(base);
		// The active names are what the model is offered and what plan mode toggles.
		const names = (session as unknown as { session: { getActiveToolNames(): string[] } }).session.getActiveToolNames();
		for (const name of ["read_file", "write_file", "edit_file", "run_command", "list_directory"]) {
			assert.ok(names.includes(name), `${name} is not offered to the model (got ${names.join(", ")})`);
		}
		// Pi's builtins would shadow nothing but leave the prompt naming absent tools.
		for (const name of ["write", "edit", "bash"]) {
			assert.equal(names.includes(name), false, `Pi's ${name} should not be mounted beside the Step profile`);
		}
	} finally {
		await store?.close().catch(() => {});
		await fixture.stop();
		await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		if (previous.agentDir === undefined) delete process.env.STEP_CODING_AGENT_DIR;
		else process.env.STEP_CODING_AGENT_DIR = previous.agentDir;
		if (previous.authPath === undefined) delete process.env.STEPCODE_AUTH_PATH;
		else process.env.STEPCODE_AUTH_PATH = previous.authPath;
	}
});
