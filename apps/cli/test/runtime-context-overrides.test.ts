import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function firstRequest(config: string, flags: string[]) {
	const root = await mkdtemp(join(tmpdir(), "step-cli-context-overrides-")); roots.push(root);
	const home = join(root, "home"); const cwd = join(root, "project"); const configRoot = join(root, "configuration"); const agentDir = join(configRoot, "agent");
	await Promise.all([mkdir(home), mkdir(cwd), mkdir(agentDir, { recursive: true })]);
	const requests: Array<{ messages: unknown[]; tools?: Array<{ function?: { name: string } }> }> = [];
	const server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => {
			if (!body.trim()) {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ data: [{ id: "local-cli-test" }] }));
				return;
			}
			requests.push(JSON.parse(body));
			response.writeHead(200, { "content-type": "text/event-stream" });
			const common = { id: "local-cli-test", object: "chat.completion.chunk", created: 1, model: "local-cli-test" };
			response.end([
				`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] })}\n\n`,
				`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 } })}\n\n`,
				"data: [DONE]\n\n",
			].join(""));
		});
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Local test server did not start");
		const catalog = JSON.stringify({ providers: { openai: { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", models: [{ id: "local-cli-test", name: "Local CLI Test", contextWindow: 128000, maxTokens: 4096, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } });
		await Promise.all([writeFile(join(configRoot, "models.json"), catalog), writeFile(join(agentDir, "models.json"), catalog), writeFile(join(configRoot, "config.toml"), config)]);
		const cli = resolve(import.meta.dirname, "../dist/main.js");
		const args = [cli, "--provider", "openai", "--model", "local-cli-test", "--api-key", "local-test-key", "--mode", "json", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--no-update-check", "--no-session", "-p", ...flags, "Reply done."];
		const child = spawn(process.execPath, args, { cwd, env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, STEP_CODING_AGENT_DIR: agentDir, STEP_NO_LOCAL_LLM: "1", AWS_EC2_METADATA_DISABLED: "true" }, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
		const timeout = setTimeout(() => child.kill("SIGKILL"), 20000);
		const code = await new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("close", done); });
		clearTimeout(timeout);
		expect(code, output.slice(-12000)).toBe(0);
		expect(requests.length, output.slice(-12000)).toBeGreaterThan(0);
		expect(await readFile(join(configRoot, "config.toml"), "utf8")).toBe(config);
		return requests[0];
	} finally {
		await new Promise<void>((done) => server.close(() => done()));
	}
}

describe.skipIf(process.platform === "win32")("CLI overrides after resource loading", () => {
	it("keeps explicit native compression after the resource loader reloads settings", async () => {
		const request = await firstRequest('[compaction]\ncontextProjection = "clm-v1"\n', ["--context-projection", "off"]);
		expect(JSON.stringify(request.messages)).not.toContain("## Working context");
	});
});
