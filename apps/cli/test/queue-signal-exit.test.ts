import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * A stop while a request waits in Step's model request queue must reach the
 * server: the built CLI in `-p` mode gets SIGINT mid-queue and has to send the
 * cancel (with the request's id) before it exits, within its bound.
 *
 * Step's queue lives at fixed hosts, so the test plays `api.stepfun.com` behind
 * a local CONNECT proxy (`HTTPS_PROXY`) with a throwaway certificate the child
 * accepts (`NODE_TLS_REJECT_UNAUTHORIZED=0`). Nothing leaves the machine.
 */

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function listen(server: Server): Promise<number> {
	return new Promise((done) =>
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("server did not start");
			done(address.port);
		}),
	);
}

function closeServer(server: Server, sockets: Set<Duplex>): () => Promise<void> {
	return () =>
		new Promise((done) => {
			for (const socket of sockets) socket.destroy();
			server.close(() => done());
		});
}

async function body(request: IncomingMessage): Promise<string> {
	let text = "";
	for await (const chunk of request) text += chunk;
	return text;
}

describe.skipIf(process.platform === "win32")("-p in the model request queue", () => {
	it(
		"sends the queue cancel before exiting on SIGINT",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "step-cli-queue-signal-"));
			roots.push(root);
			const home = join(root, "home");
			const cwd = join(root, "project");
			const agentDir = join(root, "configuration", "agent");
			await Promise.all([mkdir(home), mkdir(cwd), mkdir(agentDir, { recursive: true })]);
			execFileSync("openssl", [
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-days",
				"1",
				"-subj",
				"/CN=api.stepfun.com",
				"-keyout",
				join(root, "key.pem"),
				"-out",
				join(root, "cert.pem"),
			], { stdio: "ignore" });

			const trace: string[] = [];
			let cancel: { readonly id: unknown; readonly contentType: unknown; readonly body: string } | undefined;
			let pollId: unknown;
			let onFirstPoll: (() => void) | undefined;
			const firstPoll = new Promise<void>((done) => {
				onFirstPoll = done;
			});
			const step = createHttpsServer(
				{ key: await readFile(join(root, "key.pem")), cert: await readFile(join(root, "cert.pem")) },
				async (request: IncomingMessage, response: ServerResponse) => {
					const text = await body(request);
					const url = new URL(request.url ?? "/", "https://api.stepfun.com");
					trace.push(`${request.method} ${url.pathname}`);
					if (url.pathname === "/step_plan/v1/chat/completions") {
						response.writeHead(429, {
							"content-type": "application/json",
							"X-StepCode-Queue-State": "waiting",
							"X-StepCode-Queue-Position": "3",
							"Retry-After-Ms": "100",
						});
						response.end('{"error":{"type":"queued","code":"queued"}}');
						return;
					}
					if (url.pathname === "/stepcode/v1/queue") {
						pollId = request.headers["x-stepcode-queue-id"];
						response.writeHead(200, { "content-type": "application/json" });
						response.end('{"state":"waiting","position":2,"retry_after_ms":5000,"reason":""}');
						onFirstPoll?.();
						return;
					}
					if (url.pathname === "/stepcode/v1/queue/cancel") {
						cancel = {
							id: request.headers["x-stepcode-queue-id"],
							contentType: request.headers["content-type"],
							body: text,
						};
						response.writeHead(200, { "content-type": "application/json" });
						response.end("{}");
						return;
					}
					response.writeHead(200, { "content-type": "application/json" });
					response.end('{"data":[]}');
				},
			);
			const stepSockets = new Set<Duplex>();
			step.on("connection", (socket) => {
				stepSockets.add(socket);
				socket.on("close", () => stepSockets.delete(socket));
			});
			const stepPort = await listen(step);
			closers.push(closeServer(step, stepSockets));

			// Every CONNECT, whatever host it names, is tunnelled to the stand-in.
			const proxy = createHttpServer();
			const proxySockets = new Set<Duplex>();
			proxy.on("connection", (socket) => {
				proxySockets.add(socket);
				socket.on("close", () => proxySockets.delete(socket));
			});
			proxy.on("connect", (_request, client: Duplex, head) => {
				const upstream = connect(stepPort, "127.0.0.1", () => {
					client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
					upstream.write(head);
					upstream.pipe(client);
					client.pipe(upstream);
				});
				proxySockets.add(upstream);
				upstream.on("error", () => client.destroy());
				client.on("error", () => upstream.destroy());
			});
			const proxyPort = await listen(proxy);
			closers.push(closeServer(proxy, proxySockets));

			const catalog = JSON.stringify({
				providers: {
					stepgate: {
						baseUrl: "https://api.stepfun.com/step_plan/v1",
						api: "openai-completions",
						models: [
							{
								id: "queue-model",
								name: "Queue model",
								contextWindow: 32000,
								maxTokens: 1000,
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							},
						],
					},
				},
			});
			await Promise.all([
				writeFile(join(root, "configuration", "models.json"), catalog),
				writeFile(join(agentDir, "models.json"), catalog),
			]);
			const cli = resolve(import.meta.dirname, "../dist/main.js");
			const args = [
				cli,
				"--provider",
				"stepgate",
				"--model",
				"queue-model",
				"--api-key",
				"test-key",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
				"--no-approve",
				"--no-update-check",
				"--no-session",
				"-p",
				"Reply done.",
			];
			const child = spawn(process.execPath, args, {
				cwd,
				env: {
					PATH: process.env.PATH,
					HOME: home,
					USERPROFILE: home,
					STEP_CODING_AGENT_DIR: agentDir,
					STEP_NO_LOCAL_LLM: "1",
					AWS_EC2_METADATA_DISABLED: "true",
					HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
					NODE_TLS_REJECT_UNAUTHORIZED: "0",
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			let output = "";
			child.stdout.on("data", (chunk) => {
				output += chunk;
			});
			child.stderr.on("data", (chunk) => {
				output += chunk;
			});
			const exited = new Promise<number | null>((done, reject) => {
				child.once("error", reject);
				child.once("close", (code) => done(code));
			});
			const guard = setTimeout(() => child.kill("SIGKILL"), 90_000);
			try {
				await Promise.race([firstPoll, exited.then(() => Promise.reject(new Error(`exited early:\n${output}`)))]);
				expect(trace.slice(0, 2)).toEqual(["POST /step_plan/v1/chat/completions", "GET /stepcode/v1/queue"]);
				const stoppedAt = Date.now();
				child.kill("SIGINT");
				const code = await exited;
				const elapsed = Date.now() - stoppedAt;
				expect(code, output.slice(-4000)).toBe(130);
				expect(trace).toContain("POST /stepcode/v1/queue/cancel");
				// The cancel names the place in its queue id header, the same one the poll
				// asked about, and has no body.
				expect(pollId).toMatch(/^[0-9a-f-]{36}$/u);
				expect(cancel).toEqual({ id: pollId, contentType: undefined, body: "" });
				// The stop is bounded: the cancel's own limit plus the dispose bound, with slack for a loaded runner.
				expect(elapsed).toBeLessThan(5_000);
				expect(output).toContain("Queued: position 3");
			} finally {
				clearTimeout(guard);
				if (child.exitCode === null) child.kill("SIGKILL");
			}
		},
		120_000,
	);
});
