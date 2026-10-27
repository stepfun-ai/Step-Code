import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type WebEvent, WebSessionStore } from "../src/runtime.ts";
import { cleanGeneratedTitle, type SlashCommandResolver, sessionTitleInput } from "../src/session-title.ts";

/* ── Unit: the title answer cleaner ──────────────────────────────────────── */

test("a title answer is read from JSON, fenced JSON, or the first line", () => {
	assert.equal(cleanGeneratedTitle('{"title":"修复登录令牌过期"}'), "修复登录令牌过期");
	assert.equal(cleanGeneratedTitle('```json\n{"title":"Fix token refresh"}\n```'), "Fix token refresh");
	assert.equal(cleanGeneratedTitle("修复登录令牌过期"), "修复登录令牌过期");
	// Thinking blocks are dropped before any parsing is attempted.
	assert.equal(cleanGeneratedTitle('<think>reasoning</think>{"title":"标题"}'), "标题");
});

test("a title answer is stripped of decorations and rejected when unusable", () => {
	assert.equal(cleanGeneratedTitle('{"title":"## Fix `token` expiry."}'), "Fix `token` expiry");
	assert.equal(cleanGeneratedTitle('{"title":"“标题”"}'), "标题");
	assert.equal(cleanGeneratedTitle('{"title":"标题。"}'), "标题");
	assert.equal(cleanGeneratedTitle('{"title":"!!! --- !!!"}'), null);
	assert.equal(cleanGeneratedTitle('{"title":""}'), null);
	assert.equal(cleanGeneratedTitle(""), null);
	// Overlong answers are capped so the sidebar never gets an essay.
	const long = "标".repeat(120);
	assert.equal(cleanGeneratedTitle(`{"title":"${long}"}`), `${"标".repeat(97)}...`);
});

/* ── Unit: which prompt a title is generated from ─────────────────────────── */

test("the title input is the prompt itself, whitespace-collapsed and capped", () => {
	assert.equal(sessionTitleInput("帮我修复\n登录页面  的问题，token 过期后不会刷新"), "帮我修复 登录页面 的问题，token 过期后不会刷新");
	// A short prompt is still titled (by itself); only an empty one is not.
	assert.equal(sessionTitleInput("  hi  "), "hi");
	assert.equal(sessionTitleInput("   "), null);
	assert.equal(sessionTitleInput(`${"x".repeat(1_500)}`), "x".repeat(1_200));
});

/** A kernel that registers these commands and one prompt template, `review`. */
const kernel: SlashCommandResolver = (name) =>
	["goal", "plan", "permissions", "compact", "ultraloop", "clm"].includes(name)
		? "command"
		: name === "review"
			? "template"
			: undefined;
const titleOf = (prompt: string) => sessionTitleInput(prompt, kernel);

test("a task command is titled by its argument", () => {
	assert.equal(titleOf("/goal 请在当前项目中从零开发一款可运行的浏览器塔防游戏"), "请在当前项目中从零开发一款可运行的浏览器塔防游戏");
	assert.equal(titleOf("/plan 重构登录模块的 token 刷新逻辑"), "重构登录模块的 token 刷新逻辑");
	// `/goal start` is the explicit form of the same objective.
	assert.equal(titleOf("/goal start 开发一款浏览器塔防游戏"), "开发一款浏览器塔防游戏");
	// A task that is itself a skill invocation is titled like the skill sent alone.
	assert.equal(titleOf("/plan /skill:lark-calendar 帮我创建明天上午十点的站会"), "帮我创建明天上午十点的站会");
	assert.equal(titleOf("/skill:lark-calendar 帮我创建明天上午十点的站会"), "帮我创建明天上午十点的站会");
	assert.equal(
		titleOf('<skill name="pdf" location="/skills/pdf/SKILL.md">\nUse the pdf skill.\n</skill>\n\n帮我把这两个报告合并成一份'),
		"帮我把这两个报告合并成一份",
	);
	// A skill with no request of its own is titled by the skill's name.
	assert.equal(titleOf('<skill name="pdf" location="/skills/pdf/SKILL.md">\nUse the pdf skill.\n</skill>'), "pdf");
	// The host's template naming misses a template behind `/plan`; its own line titles the session.
	assert.equal(titleOf("/plan /review src/auth.ts"), "/review src/auth.ts");
});

test("the ultraloop mode's keyword prefix is not part of the title", () => {
	assert.equal(titleOf("ultracode: 帮我重构支付模块"), "帮我重构支付模块");
	assert.equal(titleOf("ULTRALOOP: /skill:pdf 合并两份报告"), "合并两份报告");
	// The keyword anywhere else is the user's own wording.
	assert.equal(titleOf("用 ultracode 跑一遍审计"), "用 ultracode 跑一遍审计");
});

test("a configuring command leaves the title to the next input", () => {
	for (const line of [
		"/permissions full-access",
		"/compact keep the API notes",
		"/ultraloop on",
		"/clm status",
		"/plan",
		"/goal  ",
		"/goal status",
		"/goal pause",
		"/goal clear",
		"/goal stop",
		"/goal budget 5000",
		"/goal edit 新目标",
		// A prompt template is named after its command line by the host itself.
		"/review src/auth.ts",
	]) {
		assert.equal(titleOf(line), null, line);
	}
});

test("a slash line the kernel does not register is an ordinary prompt", () => {
	// Pasted paths, including a single segment that looks like a command name.
	assert.equal(titleOf("/tmp 看下这个目录里的日志"), "/tmp 看下这个目录里的日志");
	assert.equal(titleOf("/Users/me/repo 帮我看看这个目录"), "/Users/me/repo 帮我看看这个目录");
	// With no resolver nothing is registered: a slash line is plain text.
	assert.equal(sessionTitleInput("/goal 开发塔防游戏"), "/goal 开发塔防游戏");
	// The kernel splits a command line at a space only; `/goal\n…` is no command.
	assert.equal(titleOf("/goal\n开发塔防游戏"), "/goal 开发塔防游戏");
});

/* ── End to end: the first send names the session via a sidecar call ──────── */

interface Fixture {
	readonly server: Server;
	readonly base: string;
	readonly titleRequests: string[];
	stop(): Promise<void>;
}

/**
 * A local OpenAI-compatible endpoint. Both the session's turn and the title
 * sidecar call `/chat/completions`; the title request carries the title system
 * prompt as its first message and is answered with a fixed JSON title.
 */
async function startFixture(base: string): Promise<Fixture> {
	const titleRequests: string[] = [];
	const server = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
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
		const body = JSON.parse(raw) as { messages?: { role?: string; content?: unknown }[] };
		const isTitleRequest = (body.messages ?? []).some(
			(message) => message.role === "system" && String(message.content).includes("title-generation task"),
		);
		if (isTitleRequest) titleRequests.push(raw);
		const answer = isTitleRequest ? '{"title":"修复登录令牌过期"}' : "done";
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
		chunk({ role: "assistant", content: answer });
		chunk({}, "stop");
		response.write("data: [DONE]\n\n");
		response.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("fixture did not bind a port");
	const baseUrl = `http://127.0.0.1:${address.port}/v1`;
	await mkdir(join(base, "agent"), { recursive: true });
	await writeFile(
		join(base, "models.json"),
		`${JSON.stringify({
			providers: {
				mygw: { baseUrl, api: "openai-completions", name: "Fixture Gateway", models: [{ id: "fixture-model" }] },
			},
		})}\n`,
		"utf8",
	);
	await writeFile(join(base, "auth.json"), `${JSON.stringify({ mygw: { type: "api_key", key: "test-key" } })}\n`);
	await writeFile(join(base, "config.toml"), `defaultProvider = "mygw"\ndefaultModel = "fixture-model"\n`, "utf8");
	return {
		server,
		base,
		titleRequests,
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

test("the first input names the session; later sends do not; short input names it directly", { timeout: 60_000 }, async () => {
	const base = await mkdtemp(join(tmpdir(), "stepcode-web-session-title-"));
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
	const store = new WebSessionStore();
	try {
		const session = await store.create(base);
		const events: WebEvent[] = [];
		session.subscribe((event) => events.push(event));
		const nameChanges = () =>
			events.filter(
				(event): event is Extract<WebEvent, { type: "agent" }> =>
					event.type === "agent" && event.event.type === "session_info_changed",
			);

		// The first send starts the sidecar beside the turn it names.
		await session.send("帮我修复登录页面里 token 过期后不会自动刷新的问题");
		await waitFor(() => nameChanges().some((event) => event.event.name === "修复登录令牌过期"));
		assert.equal(session.snapshot().name, "修复登录令牌过期");
		assert.equal(fixture.titleRequests.length, 1);

		// A second send must not name the session again.
		await session.send("顺便把刷新接口的日志也补上，方便排查线上问题");
		await waitFor(() => session.snapshot().status === "completed");
		assert.equal(fixture.titleRequests.length, 1);

		// A fresh session whose first prompt is short is named by it, with no model call.
		const quiet = await store.create(base);
		await quiet.send("hi");
		await waitFor(() => quiet.snapshot().status === "completed");
		await waitFor(() => quiet.snapshot().name === "hi");
		assert.equal(fixture.titleRequests.length, 1);

		// A goal journals no user message; its objective still names the session.
		const goal = await store.create(base);
		await goal.send("/goal 帮我修复登录页面里 token 过期后不会自动刷新的问题");
		await waitFor(() => goal.snapshot().name === "修复登录令牌过期");
		assert.equal(fixture.titleRequests.length, 2);
		await goal.controlGoal("clear");

		// The goal strip's start control bypasses `send` and must title as well.
		const started = await store.create(base);
		await started.controlGoal("start", "做一个塔防游戏");
		await waitFor(() => started.snapshot().name === "做一个塔防游戏");
		assert.equal(fixture.titleRequests.length, 2);
		await started.controlGoal("clear");

		// A configuring command first leaves the title to the input after it.
		const configured = await store.create(base);
		await configured.send("/goal status");
		await configured.send("帮我修复登录页面里 token 过期后不会自动刷新的问题");
		await waitFor(() => configured.snapshot().name === "修复登录令牌过期");
		assert.equal(fixture.titleRequests.length, 3);

		// A pasted path is no command: the session is titled from the whole line.
		const pathed = await store.create(base);
		await pathed.send("/tmp 看下");
		await waitFor(() => pathed.snapshot().name === "/tmp 看下");
		assert.equal(fixture.titleRequests.length, 3);
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
