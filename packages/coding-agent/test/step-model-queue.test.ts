import assert from "node:assert/strict";
import { test } from "vitest";
import type { ModelFetchRequest, ModelQueueExit, ModelQueueState } from "../src/core/model-fetch.ts";
import {
	createStepModelQueueFactory,
	createStepModelQueueFetch,
	resolveStepModelQueueEnabled,
	stepModelQueueClosedMessage,
	stepModelQueueStatusText,
} from "../src/step/model-queue.ts";

const PLAN = "https://api.example.test/step_plan/v1";
const CHAT = `${PLAN}/chat/completions`;
/** Stand-ins for the fixed endpoints, injected through the test hook: mainland on `.test`, overseas on `.ai`. */
const QUEUE = "https://api.example.test/stepcode/v1/queue";
const QUEUE_OVERSEAS = "https://api.example.ai/stepcode/v1/queue";
const QUEUE_ENDPOINTS = { "api.example.test": QUEUE, "api.example.ai": QUEUE_OVERSEAS };
const BODY = JSON.stringify({ model: "step", messages: [{ role: "user", content: "你好 🌏" }], stream: true });

interface Call {
	readonly url: string;
	readonly method: string;
	readonly headers: Headers;
	readonly body?: Uint8Array;
	readonly signal?: AbortSignal;
	/** Whether the idle watchdog was held when the request went out. */
	readonly held: boolean;
}

type Reply = Response | Error | ((call: Call) => Response | Promise<Response>);

function queued(position?: number, retryAfterMs?: number): Response {
	const headers = new Headers({ "X-StepCode-Queue-State": "waiting", "content-type": "application/json" });
	if (position !== undefined) headers.set("X-StepCode-Queue-Position", String(position));
	if (retryAfterMs !== undefined) headers.set("Retry-After-Ms", String(retryAfterMs));
	return new Response(JSON.stringify({ error: { type: "queued", code: "queued" } }), { status: 429, headers });
}

function status(state: string, extra: Record<string, unknown> = {}): Response {
	return new Response(JSON.stringify({ state, position: 0, retry_after_ms: 2000, reason: "", ...extra }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

const ok = () => new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });

function harness(replies: Reply[], options: { budgetMs?: number } = {}) {
	const calls: Call[] = [];
	const sleeps: number[] = [];
	const states: Array<ModelQueueState | null> = [];
	const exits: Array<ModelQueueExit | undefined> = [];
	const teardowns: Array<Promise<unknown>> = [];
	const caller = new AbortController();
	let holds = 0;
	let released = 0;
	let clock = 0;
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		const call: Call = {
			url: request.url,
			method: request.method,
			headers: new Headers(request.headers),
			...(request.body ? { body: new Uint8Array(await request.arrayBuffer()) } : {}),
			...(init?.signal ? { signal: init.signal } : {}),
			held: holds > released,
		};
		calls.push(call);
		const reply = replies.shift();
		if (!reply) throw new Error(`unexpected request ${call.method} ${call.url}`);
		if (reply instanceof Error) throw reply;
		return typeof reply === "function" ? reply(call) : reply;
	};
	const wrapped = createStepModelQueueFetch(
		{
			signal: caller.signal,
			fetch,
			reportQueue: (queueId, state, exit) => {
				assert.equal(queueId, "q-1");
				states.push(state);
				if (state === null) exits.push(exit);
			},
			registerTeardown: (task) => teardowns.push(task),
			holdIdleWatchdog: () => {
				holds++;
				let done = false;
				return () => {
					if (done) throw new Error("released twice");
					done = true;
					released++;
				};
			},
		},
		{
			queueId: () => "q-1",
			queueEndpoints: QUEUE_ENDPOINTS,
			now: () => clock,
			sleep: async (ms, signal) => {
				signal.throwIfAborted();
				sleeps.push(ms);
				clock += ms;
			},
			...(options.budgetMs === undefined ? {} : { pollFailureBudgetMs: options.budgetMs }),
		},
	);
	const fetchRequest = (input: Request) => wrapped(input);
	const post = (url = CHAT, init: RequestInit = {}) =>
		wrapped(url, {
			method: "POST",
			headers: { authorization: "Bearer sk-test", "content-type": "application/json" },
			body: BODY,
			...init,
		});
	return {
		calls,
		sleeps,
		states,
		exits,
		teardowns,
		caller,
		post,
		fetchRequest,
		holds: () => holds,
		released: () => released,
	};
}

const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

/** The cancel: `POST <queue>/cancel` with the request's credentials, naming the place by its queue id header, no body. */
function assertCancel(call: Call | undefined): void {
	assert.equal(call?.method, "POST");
	assert.equal(call?.url, `${QUEUE}/cancel`);
	assert.equal(call?.headers.get("authorization"), "Bearer sk-test");
	assert.equal(call?.headers.get("X-StepCode-Queue-ID"), "q-1");
	assert.equal(call?.headers.has("content-type"), false);
	assert.equal(call?.body, undefined);
}

test("tags each Step model call with a queue id and passes the answer through", async () => {
	const h = harness([ok()]);
	const response = await h.post();
	assert.equal(response.status, 200);
	assert.equal(h.calls.length, 1);
	assert.equal(h.calls[0]?.headers.get("X-StepCode-Queue-ID"), "q-1");
	assert.equal(text(h.calls[0]?.body), BODY);
	assert.deepEqual(h.states, []);
	assert.equal(h.holds(), 0);
});

test("generates a fresh id per call", async () => {
	const ids: string[] = [];
	const fetch: typeof globalThis.fetch = async (input, init) => {
		ids.push(new Request(input, init).headers.get("X-StepCode-Queue-ID") ?? "");
		return ok();
	};
	const wrapped = createStepModelQueueFetch(
		{
			signal: new AbortController().signal,
			fetch,
			holdIdleWatchdog: () => () => {},
			reportQueue: () => {},
			registerTeardown: () => {},
		},
		{ queueEndpoints: QUEUE_ENDPOINTS },
	);
	await wrapped(CHAT, { method: "POST", body: BODY });
	await wrapped(CHAT, { method: "POST", body: BODY });
	assert.equal(ids.length, 2);
	assert.match(ids[0], /^[0-9a-f-]{36}$/u);
	assert.notEqual(ids[0], ids[1]);
});

test("tags every request to a Step API host, whatever its route; the server decides whether it waits", async () => {
	const h = harness([ok(), ok(), ok()]);
	await h.post("https://api.example.test/v1/chat/completions");
	await h.post(`${PLAN}/messages`);
	await h.post(`${PLAN}/models`, { method: "GET", body: null });
	assert.deepEqual(
		h.calls.map((call) => call.headers.has("X-StepCode-Queue-ID")),
		[true, true, true],
	);
});

test("picks the queue of the request's region", async () => {
	const mainland = harness([queued(1), status("ready"), ok()]);
	await mainland.post("https://api.example.test/v1/chat/completions");
	assert.equal(mainland.calls[1]?.url, QUEUE);
	const overseas = harness([queued(1), status("ready"), ok()]);
	await overseas.post("https://api.example.ai/step_plan/v1/chat/completions");
	assert.equal(overseas.calls[1]?.url, QUEUE_OVERSEAS);
});

test("sends a request to any other host as it is: no header, no queue", async () => {
	const h = harness([queued(1)]);
	// An endpoint override, or a gateway: even a queued-looking answer is the caller's.
	const response = await h.post("https://gateway.example.test/step_plan/v1/chat/completions");
	assert.equal(response.status, 429);
	assert.equal(h.calls.length, 1);
	assert.equal(h.calls[0]?.headers.has("X-StepCode-Queue-ID"), false);
	assert.deepEqual(h.states, []);
});

test("knows Step's own two API hosts by default", async () => {
	const seen: string[] = [];
	const replies = [queued(1), status("ready"), ok(), queued(1), status("ready"), ok(), ok()];
	const wrapped = createStepModelQueueFetch(
		{
			signal: new AbortController().signal,
			fetch: async (input, init) => {
				const request = new Request(input, init);
				seen.push(`${request.headers.get("X-StepCode-Queue-ID") ?? "plain"} ${request.method} ${request.url}`);
				return replies.shift() ?? ok();
			},
			holdIdleWatchdog: () => () => {},
			reportQueue: () => {},
			registerTeardown: () => {},
		},
		{ queueId: () => "id", sleep: async () => {} },
	);
	await wrapped("https://api.stepfun.com/step_plan/v1/chat/completions", { method: "POST", body: BODY });
	await wrapped("https://api.stepfun.ai/v1/chat/completions", { method: "POST", body: BODY });
	await wrapped("https://staging.example.test/step_plan/v1/chat/completions", { method: "POST", body: BODY });
	assert.deepEqual(seen, [
		"id POST https://api.stepfun.com/step_plan/v1/chat/completions",
		"id GET https://api.stepfun.com/stepcode/v1/queue",
		"id POST https://api.stepfun.com/step_plan/v1/chat/completions",
		"id POST https://api.stepfun.ai/v1/chat/completions",
		"id GET https://api.stepfun.ai/stepcode/v1/queue",
		"id POST https://api.stepfun.ai/v1/chat/completions",
		"plain POST https://staging.example.test/step_plan/v1/chat/completions",
	]);
});

test("never wraps the queue control endpoints: they go out as they are", async () => {
	const h = harness([ok(), queued(1)]);
	await h.post(QUEUE, { method: "GET", body: null, headers: { "X-StepCode-Queue-ID": "other" } });
	const response = await h.post(`${QUEUE}/cancel`, { body: null, headers: { "X-StepCode-Queue-ID": "other" } });
	// Not wrapped: a queued-looking answer to a control request is not a place in line.
	assert.equal(response.status, 429);
	// The id they name is their own, never replaced by a fresh one.
	assert.deepEqual(
		h.calls.map((call) => call.headers.get("X-StepCode-Queue-ID")),
		["other", "other"],
	);
	assert.deepEqual(h.states, []);
	assert.equal(h.holds(), 0);
});

test("forwards the request's own headers to the control requests, except those describing its body", async () => {
	const h = harness([queued(1), status("ready"), ok()]);
	await h.post(CHAT, {
		headers: {
			authorization: "Bearer sk-test",
			"x-api-key": "k",
			"x-step-session-id": "s1",
			"content-type": "application/json",
			"content-length": String(BODY.length),
		},
	});
	const poll = h.calls[1];
	assert.equal(poll?.headers.get("authorization"), "Bearer sk-test");
	assert.equal(poll?.headers.get("x-api-key"), "k");
	assert.equal(poll?.headers.get("x-step-session-id"), "s1");
	assert.equal(poll?.headers.get("accept"), "application/json");
	assert.equal(poll?.headers.has("content-type"), false);
	assert.equal(poll?.headers.has("content-length"), false);
	// The control requests name the place they ask about.
	assert.equal(poll?.headers.get("X-StepCode-Queue-ID"), "q-1");
});

test("passes a non-queued answer through unchanged", async () => {
	const answer = new Response('{"error":"bad"}', { status: 400, headers: { "content-type": "application/json" } });
	const h = harness([answer]);
	const response = await h.post();
	assert.equal(response, answer);
	assert.equal(h.holds(), 0);
	assert.deepEqual(h.states, []);
});

test("passes an ordinary 429 through to the existing retry policy", async () => {
	const h = harness([new Response("{}", { status: 429, headers: { "retry-after": "1" } })]);
	const response = await h.post();
	assert.equal(response.status, 429);
	assert.equal(h.calls.length, 1);
	assert.deepEqual(h.states, []);
});

test("waits in line, then resends the same bytes under the same id", async () => {
	const h = harness([
		queued(3, 1500),
		status("waiting", { position: 2, retry_after_ms: 1000 }),
		status("waiting", { position: 1 }),
		status("ready"),
		ok(),
	]);
	const response = await h.post();
	assert.equal(response.status, 200);
	assert.deepEqual(
		h.calls.map((call) => call.method),
		["POST", "GET", "GET", "GET", "POST"],
	);
	for (const poll of h.calls.slice(1, 4)) {
		// No query: the place is named by its queue id header.
		assert.equal(poll.url, QUEUE);
		assert.equal(poll.headers.get("X-StepCode-Queue-ID"), "q-1");
		assert.equal(poll.headers.get("authorization"), "Bearer sk-test");
		assert.equal(poll.body, undefined);
	}
	const [first, resend] = [h.calls[0], h.calls[4]];
	assert.equal(resend?.headers.get("X-StepCode-Queue-ID"), "q-1");
	assert.equal(resend?.url, CHAT);
	assert.deepEqual(resend?.body, first?.body);
	assert.equal(text(resend?.body), BODY);
	assert.deepEqual(h.sleeps, [1500, 1000, 2000]);
	assert.deepEqual(h.states, [{ position: 3 }, { position: 2 }, { position: 1 }, null]);
	assert.deepEqual(h.exits, [undefined]);
	assert.deepEqual([h.holds(), h.released()], [1, 1]);
	// Held only while polling; the resend is back under the idle bound.
	assert.deepEqual(
		h.calls.map((call) => call.held),
		[false, true, true, true, false],
	);
});

test("sends the queue id as it is, in a header, never in the URL", async () => {
	const calls: Array<{ url: string; id: string | null }> = [];
	const replies = [queued(1), status("ready"), ok()];
	const wrapped = createStepModelQueueFetch(
		{
			signal: new AbortController().signal,
			fetch: async (input, init) => {
				const request = new Request(input, init);
				calls.push({ url: request.url, id: request.headers.get("X-StepCode-Queue-ID") });
				return replies.shift() ?? ok();
			},
			holdIdleWatchdog: () => () => {},
			reportQueue: () => {},
			registerTeardown: () => {},
		},
		{ queueId: () => "a b&c", sleep: async () => {}, queueEndpoints: QUEUE_ENDPOINTS },
	);
	await wrapped(CHAT, { method: "POST", body: BODY });
	assert.deepEqual(calls[1], { url: QUEUE, id: "a b&c" });
});

test("keeps polling when the resend is queued again", async () => {
	const h = harness([
		queued(2),
		status("ready"),
		queued(4, 500),
		status("waiting", { position: 1 }),
		status("ready"),
		ok(),
	]);
	const response = await h.post();
	assert.equal(response.status, 200);
	const posts = h.calls.filter((call) => call.method === "POST");
	assert.equal(posts.length, 3);
	assert.deepEqual(new Set(posts.map((call) => call.headers.get("X-StepCode-Queue-ID"))), new Set(["q-1"]));
	assert.deepEqual(new Set(posts.map((call) => text(call.body))), new Set([BODY]));
	assert.deepEqual(h.states, [{ position: 2 }, { position: 4 }, { position: 1 }, null]);
	assert.deepEqual(h.sleeps, [2000, 500, 2000]);
	// Released before each resend, held again when the resend is queued.
	assert.deepEqual(
		h.calls.map((call) => `${call.method}:${call.held}`),
		["POST:false", "GET:true", "POST:false", "GET:true", "GET:true", "POST:false"],
	);
	assert.deepEqual([h.holds(), h.released()], [2, 2]);
});

test("releases the hold once when the caller stops during a resend", async () => {
	const h = harness([
		queued(1),
		status("ready"),
		(call) =>
			new Promise<Response>((_resolve, reject) => {
				assert.equal(call.held, false);
				call.signal?.addEventListener("abort", () => reject(call.signal?.reason), { once: true });
				h.caller.abort(new DOMException("stop", "AbortError"));
			}),
		new Response(null, { status: 204 }),
	]);
	await assert.rejects(h.post(), { name: "AbortError" });
	assertCancel(h.calls.at(-1));
	assert.deepEqual([h.holds(), h.released()], [1, 1]);
	assert.equal(h.states.at(-1), null);
});

test("ends with a non-retryable, readable error that keeps the reason code when the place is closed", async () => {
	const h = harness([queued(5), status("closed", { reason: "max_wait_exceeded" })]);
	const response = await h.post();
	assert.equal(response.status, 410);
	assert.equal(response.headers.get("x-should-retry"), "false");
	const body = (await response.json()) as { error: { message: string; code: string; reason: string } };
	assert.equal(body.error.message, "The request waited in line too long. Try again later. (max_wait_exceeded)");
	assert.equal(body.error.code, "queue_closed");
	assert.equal(body.error.reason, "max_wait_exceeded");
	assert.equal(h.states.at(-1), null);
	// The reason code reaches the host, for its own wording.
	assert.deepEqual(h.exits, [{ closedReason: "max_wait_exceeded" }]);
	assert.equal(h.released(), 1);
});

test("a status answer of 404 closes the place as not_found", async () => {
	const h = harness([queued(1), new Response("gone", { status: 404 })]);
	const response = await h.post();
	assert.equal(response.status, 410);
	const body = (await response.json()) as { error: { reason: string } };
	assert.equal(body.error.reason, "not_found");
	assert.deepEqual(h.exits, [{ closedReason: "not_found" }]);
});

test("a status answer of 401 or 403 goes back to the caller as it is", async () => {
	for (const status of [401, 403]) {
		const denied = new Response('{"error":"unauthorized"}', { status });
		const h = harness([queued(1), denied]);
		const response = await h.post();
		assert.equal(response, denied);
		assert.equal(h.states.at(-1), null);
		assert.equal(h.released(), 1);
	}
});

test("a throttled status endpoint is retried like a failing one", async () => {
	const h = harness([queued(1), new Response("slow down", { status: 429 }), status("ready"), ok()]);
	const response = await h.post();
	assert.equal(response.status, 200);
	assert.deepEqual(h.sleeps, [2000, 1000]);
});

test("reports only changes of place or of being in line", async () => {
	const h = harness([
		queued(2),
		status("waiting", { position: 2 }),
		status("waiting", { position: 2 }),
		status("waiting", { position: 1 }),
		status("ready"),
		ok(),
	]);
	await h.post();
	assert.deepEqual(h.states, [{ position: 2 }, { position: 1 }, null]);
});

test("names every closed reason code in readable text, generic for unknown codes", () => {
	const codes = ["queue_full", "user_limit", "lease_expired", "max_wait_exceeded", "not_found"];
	const generic = stepModelQueueClosedMessage("");
	const texts = codes.map((code) => stepModelQueueClosedMessage(code));
	for (const [index, text] of texts.entries()) {
		assert.equal(text.endsWith(` (${codes[index]})`), true);
		assert.equal(text.startsWith(generic), false);
	}
	assert.equal(new Set(texts).size, codes.length);
	assert.equal(stepModelQueueClosedMessage("brand_new_reason"), `${generic} (brand_new_reason)`);
	assert.equal(stepModelQueueClosedMessage("toString"), `${generic} (toString)`);
	assert.equal(stepModelQueueClosedMessage("queue_full"), "The request queue is full. Try again later. (queue_full)");
});

test("a stop always surfaces as an Error", async () => {
	const h = harness([
		queued(1),
		() => {
			h.caller.abort("user pressed stop");
			return status("waiting", { position: 1 });
		},
		new Response(null, { status: 204 }),
	]);
	const error = await h.post().then(
		() => undefined,
		(caught: unknown) => caught,
	);
	assert.ok(error instanceof Error);
	assert.equal((error as Error).name, "AbortError");
});

test("sends no cancel when the caller stops during the first send: nothing said the call was queued", async () => {
	const h = harness([
		(call) =>
			new Promise<Response>((_resolve, reject) => {
				call.signal?.addEventListener("abort", () => reject(call.signal?.reason), { once: true });
				h.caller.abort(new DOMException("stop", "AbortError"));
			}),
	]);
	const attempt = new AbortController();
	h.caller.signal.addEventListener("abort", () => attempt.abort(h.caller.signal.reason), { once: true });
	await assert.rejects(h.post(CHAT, { signal: attempt.signal }), { name: "AbortError" });
	// The model request alone: no cancel, no teardown for a disposing session to wait on.
	assert.deepEqual(
		h.calls.map((call) => `${call.method} ${call.url}`),
		[`POST ${CHAT}`],
	);
	assert.deepEqual(h.teardowns, []);
	assert.equal(h.holds(), 0);
	assert.deepEqual(h.states, []);
});

test("a Request input's own signal stops the first send", async () => {
	const stop = new AbortController();
	const h = harness([
		(call) =>
			new Promise<Response>((_resolve, reject) => {
				assert.ok(call.signal);
				call.signal.addEventListener("abort", () => reject(call.signal?.reason), { once: true });
				stop.abort(new DOMException("stop", "AbortError"));
			}),
	]);
	const input = new Request(CHAT, {
		method: "POST",
		headers: { authorization: "Bearer sk-test", "content-type": "application/json" },
		body: BODY,
		signal: stop.signal,
	});
	await assert.rejects(h.fetchRequest(input), { name: "AbortError" });
	assert.equal(h.calls.length, 1);
	assert.deepEqual(h.teardowns, []);
});

test("a Request input's own signal also reaches the resend", async () => {
	const stop = new AbortController();
	const h = harness([
		queued(1),
		status("ready"),
		(call) =>
			new Promise<Response>((_resolve, reject) => {
				assert.ok(call.signal);
				call.signal.addEventListener("abort", () => reject(call.signal?.reason), { once: true });
				stop.abort(new DOMException("stop", "AbortError"));
			}),
	]);
	const input = new Request(CHAT, {
		method: "POST",
		headers: { authorization: "Bearer sk-test", "content-type": "application/json" },
		body: BODY,
		signal: stop.signal,
	});
	await assert.rejects(h.fetchRequest(input), { name: "AbortError" });
	assert.deepEqual(
		h.calls.map((call) => call.method),
		["POST", "GET", "POST"],
	);
	assert.equal(h.released(), 1);
	assert.equal(h.states.at(-1), null);
});

test("does not leave the line when the first send fails without a stop", async () => {
	const h = harness([new TypeError("fetch failed")]);
	await assert.rejects(h.post(), { message: "fetch failed" });
	assert.deepEqual(
		h.calls.map((call) => call.method),
		["POST"],
	);
});

test("backs off on poll failures without changing the id", async () => {
	const h = harness([
		queued(1),
		new TypeError("fetch failed"),
		new Response("busy", { status: 503 }),
		status("waiting", { position: 1 }),
		status("ready"),
		ok(),
	]);
	const response = await h.post();
	assert.equal(response.status, 200);
	assert.deepEqual(h.sleeps, [2000, 1000, 2000, 2000]);
	const polls = new Set(
		h.calls
			.filter((call) => call.method === "GET")
			.map((call) => `${call.url} ${call.headers.get("X-StepCode-Queue-ID")}`),
	);
	assert.deepEqual(polls, new Set([`${QUEUE} q-1`]));
});

test("gives up once polling has failed for the whole budget", async () => {
	const failures: Reply[] = Array.from({ length: 20 }, () => new Response("down", { status: 502 }));
	const h = harness([queued(1), ...failures], { budgetMs: 10_000 });
	const response = await h.post();
	assert.equal(response.status, 410);
	const body = (await response.json()) as { error: { message: string } };
	assert.match(body.error.message, /HTTP 502/u);
	// 2000 + 1000 + 2000 + 4000 + 8000 >= 10000 since the last success.
	assert.deepEqual(h.sleeps, [2000, 1000, 2000, 4000, 8000]);
	assert.equal(h.states.at(-1), null);
});

test("leaves the line with a cancel request when the caller aborts while waiting", async () => {
	const h = harness([
		queued(2),
		() => {
			h.caller.abort(new DOMException("stop", "AbortError"));
			return status("waiting", { position: 1 });
		},
		new Response(null, { status: 204 }),
	]);
	await assert.rejects(h.post(), { name: "AbortError" });
	assertCancel(h.calls.at(-1));
	assert.equal(h.states.at(-1), null);
	assert.equal(h.released(), 1);
});

test("ignores the SDK's own attempt timeout while waiting in line", async () => {
	const attempt = new AbortController();
	const h = harness([
		queued(1),
		() => {
			attempt.abort(new Error("Request timed out."));
			return status("ready");
		},
		(call) => {
			assert.equal(call.signal?.aborted, false);
			return ok();
		},
	]);
	const response = await h.post(CHAT, { signal: attempt.signal });
	assert.equal(response.status, 200);
	assert.deepEqual(
		h.calls.map((call) => call.method),
		["POST", "GET", "POST"],
	);
});

test("switch: the environment wins, then settings, and the queue is on otherwise", () => {
	const resolve = resolveStepModelQueueEnabled;
	// Neither the environment nor a setting decides: on, whatever the host.
	assert.deepEqual(resolve({ env: {} }), { enabled: true, source: "default" });
	// An explicit setting turns it off, or on.
	assert.deepEqual(resolve({ env: {}, settings: { modelQueue: false } }), {
		enabled: false,
		source: "settings",
	});
	assert.deepEqual(resolve({ env: {}, settings: { modelQueue: true } }), {
		enabled: true,
		source: "settings",
	});
	// The environment beats the setting.
	assert.deepEqual(resolve({ env: { STEPCODE_MODEL_QUEUE: "1" }, settings: { modelQueue: false } }), {
		enabled: true,
		source: "env",
	});
	assert.deepEqual(resolve({ env: { STEPCODE_MODEL_QUEUE: "0" }, settings: { modelQueue: true } }), {
		enabled: false,
		source: "env",
	});
	// An unrecognized value is no override.
	assert.deepEqual(resolve({ env: { STEPCODE_MODEL_QUEUE: "maybe" }, settings: { modelQueue: false } }), {
		enabled: false,
		source: "settings",
	});
	assert.deepEqual(resolve({ env: { STEPCODE_MODEL_QUEUE: "maybe" } }), { enabled: true, source: "default" });
});

function factoryRequest(provider: string, baseUrl = "https://api.stepfun.com/step_plan/v1"): ModelFetchRequest {
	return {
		model: { provider, baseUrl } as ModelFetchRequest["model"],
		signal: new AbortController().signal,
		fetch: globalThis.fetch,
		holdIdleWatchdog: () => () => {},
		reportQueue: () => {},
		registerTeardown: () => {},
	};
}

test("the factory wraps every model's requests only with the switch on", () => {
	let settings: { modelQueue?: boolean } = { modelQueue: false };
	const factory = createStepModelQueueFactory({ env: {}, settings: () => settings });
	assert.equal(factory(factoryRequest("step")), undefined);
	// Read per request: turning it on applies to the next one.
	settings = { modelQueue: true };
	assert.equal(typeof factory(factoryRequest("step")), "function");
	assert.equal(typeof factory(factoryRequest("my-gateway")), "function");
	// Unset is on; the environment can still turn it off.
	assert.equal(
		typeof createStepModelQueueFactory({ env: {}, settings: () => undefined })(factoryRequest("step")),
		"function",
	);
	assert.equal(
		createStepModelQueueFactory({ env: { STEPCODE_MODEL_QUEUE: "0" }, settings: () => undefined })(
			factoryRequest("step"),
		),
		undefined,
	);
});

test("the request host decides, not the provider: a custom provider at Step's host queues, elsewhere it does not", async () => {
	const factory = createStepModelQueueFactory(
		{ env: {}, settings: () => ({ modelQueue: true }) },
		{ queueId: () => "id", sleep: async () => {} },
	);
	const seen: string[] = [];
	const replies = [queued(4), status("ready"), ok(), queued(4)];
	const wrapped = factory({
		...factoryRequest("my-gateway"),
		fetch: async (input, init) => {
			const request = new Request(input, init);
			seen.push(`${request.headers.get("X-StepCode-Queue-ID") ?? "plain"} ${request.method} ${request.url}`);
			return replies.shift() ?? ok();
		},
	});
	assert.ok(wrapped);
	const atStep = await wrapped("https://api.stepfun.com/v1/chat/completions", { method: "POST", body: BODY });
	assert.equal(atStep.status, 200);
	// Elsewhere, even a queued-looking answer is the caller's.
	const elsewhere = await wrapped("https://gateway.example.test/v1/chat/completions", { method: "POST", body: BODY });
	assert.equal(elsewhere.status, 429);
	assert.deepEqual(seen, [
		"id POST https://api.stepfun.com/v1/chat/completions",
		"id GET https://api.stepfun.com/stepcode/v1/queue",
		"id POST https://api.stepfun.com/v1/chat/completions",
		"plain POST https://gateway.example.test/v1/chat/completions",
	]);
});

test("status text names the position, never a wait estimate", () => {
	assert.equal(stepModelQueueStatusText({ position: 3 }), "Queued: position 3");
	assert.equal(stepModelQueueStatusText({}), "Queued");
	assert.equal(stepModelQueueStatusText({ position: 0 }), "Queued");
});

test("a stop waits for the cancel request, and the call stays a registered teardown until it settles", async () => {
	let cancelReceived = false;
	const h = harness([
		queued(1),
		() => {
			h.caller.abort(new DOMException("stop", "AbortError"));
			return status("waiting", { position: 1 });
		},
		async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			cancelReceived = true;
			return new Response(null, { status: 200 });
		},
	]);
	await assert.rejects(h.post(), { name: "AbortError" });
	// The stopped call returned only after its cancel answered.
	assert.equal(cancelReceived, true);
	assert.equal(h.teardowns.length, 1);
	await h.teardowns[0];
});

test("a call becomes a teardown only once the server queues it, and stops being one when it settles", async () => {
	const h = harness([ok(), queued(1), status("ready"), ok()]);
	await h.post();
	// Answered on the first send: nothing to release, nothing registered.
	assert.deepEqual(h.teardowns, []);
	await h.post();
	assert.equal(h.teardowns.length, 1);
	await h.teardowns[0];
});

test("requests to other hosts register no teardown", async () => {
	const h = harness([ok()]);
	await h.post("https://gateway.example.test/v1/chat/completions");
	assert.deepEqual(h.teardowns, []);
});

test("a hanging cancel ends within its own bound", async () => {
	const h = harness([
		queued(1),
		() => {
			h.caller.abort(new DOMException("stop", "AbortError"));
			return status("waiting", { position: 1 });
		},
		(call) =>
			new Promise<Response>((_resolve, reject) => {
				call.signal?.addEventListener("abort", () => reject(call.signal?.reason), { once: true });
			}),
	]);
	const started = Date.now();
	await assert.rejects(h.post(), { name: "AbortError" });
	const elapsed = Date.now() - started;
	assert.ok(elapsed >= 900 && elapsed < 3_000, `cancel bound: ${elapsed}ms`);
});
