import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSessionStore } from "../src/runtime.ts";

/**
 * `/plan <task>` on the Web host: the host enters plan mode, and the model is
 * told so in the very first request.
 *
 * The model used to report that it "never entered plan mode", probe with
 * `enter_plan_mode`, and call `exit_plan_mode` several times. This drives one
 * real host session against a scripted OpenAI-compatible endpoint and checks
 * what the model actually receives.
 */

interface ChatRequest {
	readonly messages: ReadonlyArray<{ readonly role: string; readonly content: unknown }>;
	readonly tools?: ReadonlyArray<{ readonly function: { readonly name: string } }>;
}

type Reply = { readonly text: string } | { readonly tool: string; readonly args: Record<string, unknown> };

interface Fixture {
	readonly requests: ChatRequest[];
	/** Replies for the next requests, in order; an empty script answers "ok". */
	readonly script: Array<() => Reply>;
	stop(): Promise<void>;
}

function chunk(delta: Record<string, unknown>, finish: string | null): string {
	const body = { id: "f", object: "chat.completion.chunk", model: "fixture-model" };
	return `data: ${JSON.stringify({ ...body, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

async function startFixture(base: string): Promise<Fixture> {
	const requests: ChatRequest[] = [];
	const script: Array<() => Reply> = [];
	const server: Server = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		if (url.pathname.endsWith("/models")) {
			response.writeHead(200, { "content-type": "application/json" });
			return response.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
		}
		let raw = "";
		for await (const part of request) raw += part;
		requests.push(JSON.parse(raw) as ChatRequest);
		const reply = (script.shift() ?? (() => ({ text: "ok" })))();
		response.writeHead(200, { "content-type": "text/event-stream" });
		if ("tool" in reply) {
			const call = { index: 0, id: `call_${requests.length}`, type: "function" };
			const fn = { name: reply.tool, arguments: JSON.stringify(reply.args) };
			response.write(chunk({ tool_calls: [{ ...call, function: fn }] }, null));
			response.write(chunk({}, "tool_calls"));
		} else {
			response.write(chunk({ content: reply.text }, null));
			response.write(chunk({}, "stop"));
		}
		response.end("data: [DONE]\n\n");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("fixture did not bind a port");
	const baseUrl = `http://127.0.0.1:${address.port}/v1`;
	const provider = { baseUrl, api: "openai-completions", name: "Fixture Gateway", models: [{ id: "fixture-model" }] };
	await mkdir(join(base, "agent", "skills", "demo-skill"), { recursive: true });
	await writeFile(
		join(base, "agent", "skills", "demo-skill", "SKILL.md"),
		"---\nname: demo-skill\ndescription: A fixture skill.\n---\nDEMO SKILL BODY\n",
	);
	await writeFile(join(base, "models.json"), JSON.stringify({ providers: { mygw: provider } }));
	await writeFile(join(base, "auth.json"), JSON.stringify({ mygw: { type: "api_key", key: "test-key" } }));
	await writeFile(join(base, "config.toml"), 'defaultProvider = "mygw"\ndefaultModel = "fixture-model"\n');
	return {
		requests,
		script,
		stop: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

/** Text of a chat message, whichever content shape the adapter produced. */
function textOf(message: { readonly content: unknown }): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.map((part: unknown) => (typeof part === "object" && part && "text" in part ? String(part.text) : ""))
		.join("");
}

async function waitFor(check: () => boolean, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("condition did not become true before the deadline");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

test("/plan <task> reaches the model with plan mode on and stated", { timeout: 60_000 }, async () => {
	const base = await mkdtemp(join(tmpdir(), "stepcode-web-plan-"));
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
		const planPath = join(base, ".stepcode", "plans", `session-${session.id}.md`);
		let planModeAtFirstRequest: unknown;
		fixture.script.push(
			() => {
				planModeAtFirstRequest = session.snapshot().planMode;
				return { tool: "write_file", args: { path: join(base, "README.md"), content: "too early" } };
			},
			() => ({ tool: "write_file", args: { path: planPath, content: "# Plan\n1. Write README.md\n" } }),
			() => ({ tool: "exit_plan_mode", args: {} }),
			() => ({ text: "Submitted." }),
		);

		// The composer's Plan chip sends exactly this.
		await session.send("/plan add a readme");
		await waitFor(() => fixture.requests.length >= 4 && !session.isBusy());

		const first = fixture.requests[0]!;
		assert.deepEqual(planModeAtFirstRequest, { enabled: true, planFilePath: planPath, planSource: "user" });
		const tools = (first.tools ?? []).map((tool) => tool.function.name);
		for (const name of ["read_file", "write_file", "edit_file", "exit_plan_mode"]) {
			assert.ok(tools.includes(name), `${name} missing from the plan tool set (${tools.join(", ")})`);
		}
		// The task arrives as an ordinary user message, followed by the reminder.
		const texts = first.messages.slice(1).map(textOf);
		assert.equal(texts[0], "add a readme");
		const reminder = texts.at(-1) ?? "";
		assert.match(reminder, /^<system-reminder>Plan mode is ON\./);
		assert.ok(reminder.includes("must not call enter_plan_mode"), reminder);
		assert.ok(reminder.includes(JSON.stringify(planPath)), reminder);
		assert.ok(reminder.includes("call exit_plan_mode exactly once"), reminder);
		assert.equal(texts.filter((text) => text.includes("<system-reminder>Plan mode")).length, 1);

		// Only the plan file may be written. Plan mode narrows permissions rather than
	// the tool list, so the refusal comes from the `tool_call` guard.
		const blocked = fixture.requests[1]!.messages.find((message) => message.role === "tool");
		assert.ok(
			textOf(blocked ?? { content: "" }).includes("Only the plan file may be written"),
			textOf(blocked ?? { content: "" }),
		);
		assert.equal(await readFile(planPath, "utf8"), "# Plan\n1. Write README.md\n");

		// One exit submits; the result says not to call it again and the mode is off.
		const afterExit = fixture.requests[3]!;
		const exitResult = textOf(afterExit.messages.at(-1)!);
		assert.ok(exitResult.includes("which the host turned on for the user's /plan request, is now off"), exitResult);
		assert.ok(exitResult.includes("Do not call exit_plan_mode again"), exitResult);
		assert.equal(afterExit.messages.filter((message) => textOf(message).includes("<system-reminder>Plan")).length, 0);
		assert.equal((session.snapshot().planMode as { enabled: boolean }).enabled, false);

		// `/plan` before a picked skill: plan mode on and the skill still expanded.
		await session.send("/plan /skill:demo-skill tidy up");
		await waitFor(() => fixture.requests.length >= 5 && !session.isBusy());
		const withSkill = fixture.requests[4]!.messages.map(textOf);
		assert.ok(
			withSkill.some((text) => text.includes("DEMO SKILL BODY") && text.includes("tidy up")),
			"the skill was not expanded",
		);
		assert.ok(withSkill.at(-1)?.startsWith("<system-reminder>Plan mode is ON."));
	} finally {
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
