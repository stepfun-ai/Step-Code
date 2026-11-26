import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelFetchFactory } from "../src/core/model-fetch.ts";
import { main } from "../src/main.ts";

/**
 * The composition root hands `MainOptions.modelFetch` to the session of every
 * one-shot mode. The CLI passes the model request queue's factory this way, so
 * a mode that skipped it would send unqueued requests.
 */

const roots: string[] = [];
const servers: Server[] = [];
const originalStdin = Object.getOwnPropertyDescriptor(process, "stdin");

afterEach(async () => {
	if (originalStdin) Object.defineProperty(process, "stdin", originalStdin);
	vi.restoreAllMocks();
	process.exitCode = undefined;
	for (const server of servers.splice(0)) await new Promise<void>((done) => server.close(() => done()));
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixtureServer(): Promise<string> {
	const server = createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			const common = { id: "c1", object: "chat.completion.chunk", created: 1, model: "fixture-model" };
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(
				`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] })}\n\n` +
					`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n` +
					"data: [DONE]\n\n",
			);
		});
	});
	servers.push(server);
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("fixture server did not start");
	return `http://127.0.0.1:${address.port}/v1`;
}

async function runOneShot(modeArgs: string[], modelFetch: ModelFetchFactory): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-main-model-fetch-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	const baseUrl = await fixtureServer();
	const catalog = {
		providers: {
			fixture: {
				baseUrl,
				api: "openai-completions",
				models: [
					{
						id: "fixture-model",
						name: "Fixture",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 32_000,
						maxTokens: 1_000,
					},
				],
			},
		},
	};
	await writeFile(join(root, "models.json"), JSON.stringify(catalog));
	vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
		const done = args.find((arg): arg is () => void => typeof arg === "function");
		done?.();
		return true;
	});
	vi.spyOn(console, "error").mockImplementation(() => {});
	// An empty, closed pipe: the run reads its prompt from argv, not from the test runner's stdin.
	const stdin = new PassThrough();
	stdin.end();
	Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
	await main(
		[
			"--cwd",
			root,
			"--provider",
			"fixture",
			"--model",
			"fixture-model",
			"--api-key",
			"test-key",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--no-session",
			...modeArgs,
			"Reply done.",
		],
		{ agentDir, modelsPath: join(root, "models.json"), disableBackgroundServices: true, modelFetch },
	);
}

describe("main() installs the host's model fetch in every one-shot mode", () => {
	it.each([
		["-p", ["-p"]],
		["--mode json", ["--mode", "json", "-p"]],
	])("%s", async (_label, modeArgs) => {
		const urls: string[] = [];
		const factory = vi.fn<ModelFetchFactory>((request) => async (input, init) => {
			urls.push(new Request(input, init).url);
			return request.fetch(input, init);
		});
		await runOneShot(modeArgs, factory);
		expect(factory).toHaveBeenCalled();
		expect(factory.mock.calls[0]?.[0].model.id).toBe("fixture-model");
		expect(urls.some((url) => url.endsWith("/v1/chat/completions"))).toBe(true);
	});
});
