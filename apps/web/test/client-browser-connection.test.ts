import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { BrowserConnection, BrowserDisconnect, browserRetryable } from "../client/src/features/browser/actions.ts";
import { ApiError } from "../client/src/lib/api.ts";

/** Let queued requests and their snapshot replies settle. */
async function settle(): Promise<void> {
	for (let index = 0; index < 6; index++) await nextTurn();
}

const pointerMove = (x: number, y: number) => ({
	kind: "pointer" as const,
	phase: "move" as const,
	x,
	y,
	button: "left" as const,
	clicks: 1 as const,
});

test("browser snapshots never regress across command responses, heartbeat and SSE", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const snapshots: number[] = [];
	let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
	let command: ((response: Response) => void) | undefined;
	let heartbeat: ((response: Response) => void) | undefined;
	let reads = 0;
	const snapshot = (revision: number) => ({ revision, activeId: null, tabs: [] });
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const path = String(input);
		if (path.endsWith("/control")) return Response.json({ token: "fixture-token" });
		if (path.endsWith("/events")) return new Response(new ReadableStream<Uint8Array>({
			start(controller) { stream = controller; },
		}));
		if (init?.method === "POST") return new Promise<Response>((resolve) => { command = resolve; });
		if (reads++ === 0) return Response.json(snapshot(0));
		return new Promise<Response>((resolve) => { heartbeat = resolve; });
	});
	const errors: unknown[] = [];
	const client = new BrowserConnection((state) => snapshots.push(state.revision), () => {}, (error) => errors.push(error));
	const publish = async (revision: number) => {
		stream?.enqueue(new TextEncoder().encode(`event: snapshot\ndata: ${JSON.stringify(snapshot(revision))}\n\n`));
		await nextTurn();
	};
	try {
		await client.connect();
		client.send("/tabs/old/select");
		await nextTurn();
		await publish(2);
		command?.(Response.json(snapshot(1)));
		await nextTurn();
		t.mock.timers.tick(5000);
		await nextTurn();
		await publish(4);
		heartbeat?.(Response.json(snapshot(3)));
		await nextTurn();
		await publish(4);
		await publish(2);
		await publish(-1);
		await publish(4.5);
		await publish(5);
		assert.deepEqual(snapshots, [0, 2, 4, 5]);
		assert.deepEqual(errors, []);
		client.send("/tabs/new/select");
		await nextTurn();
		client.close();
		command?.(Response.json(snapshot(6)));
		await nextTurn();
		assert.deepEqual(snapshots, [0, 2, 4, 5], "Closed connections must not publish late responses");
	} finally {
		client.close();
		stream?.close();
		await nextTurn();
	}
});

test("a heartbeat tolerates transient failures and drops only after three in a row", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	let beat = 0;
	let failing = false;
	const snapshots: number[] = [];
	const errors: Array<{ disconnected: boolean; retry: boolean }> = [];
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
		const path = String(input);
		if (path.endsWith("/control")) return Response.json({ token: "fixture-token" });
		if (path.endsWith("/events")) return new Response(new ReadableStream<Uint8Array>({ start() {} }));
		beat++;
		// An expired lease answers 409, like a competing page; on a heartbeat it is still recoverable.
		if (failing) return Response.json({ error: "Browser control expired; reconnect" }, { status: 409 });
		return Response.json({ revision: beat, activeId: null, tabs: [] });
	});
	const client = new BrowserConnection(
		(snapshot) => snapshots.push(snapshot.revision),
		() => {},
		(error, disconnected) => errors.push({ disconnected, retry: browserRetryable(error) }),
	);
	try {
		await client.connect();
		failing = true;
		t.mock.timers.tick(5000);
		t.mock.timers.tick(5000);
		await nextTurn();
		assert.deepEqual(errors, [], "two missed heartbeats are not a lost Host");
		failing = false;
		t.mock.timers.tick(5000);
		await nextTurn();
		assert.equal(snapshots.at(-1), 4);
		failing = true;
		t.mock.timers.tick(5000);
		t.mock.timers.tick(5000);
		await nextTurn();
		assert.deepEqual(errors, []);
		t.mock.timers.tick(5000);
		await nextTurn();
		assert.deepEqual(errors, [{ disconnected: true, retry: true }]);
	} finally {
		client.close();
	}
});

function wheelFixture(t: TestContext) {
	t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
	const inputs: Array<Record<string, unknown>> = [];
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const path = String(input);
		if (path.endsWith("/control")) return Response.json({ token: "fixture-token" });
		if (path.endsWith("/events")) return new Response(new ReadableStream<Uint8Array>({ start() {} }));
		if (path.endsWith("/input")) inputs.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		return Response.json({ revision: 1, activeId: "one", tabs: [] });
	});
	const client = new BrowserConnection(
		() => {},
		() => {},
		() => {},
	);
	return { client, inputs };
}

test("wheel input is coalesced per frame and keeps the whole scroll distance", async (t) => {
	const { client, inputs } = wheelFixture(t);
	try {
		await client.connect();
		for (let index = 0; index < 8; index++)
			client.wheel("/tabs/one/input", { x: 10 + index, y: 20, deltaX: 0, deltaY: 100 });
		assert.equal(inputs.length, 0, "a burst waits for the frame instead of queueing every event");
		t.mock.timers.tick(40);
		await nextTurn();
		assert.deepEqual(inputs, [{ kind: "wheel", x: 17, y: 20, deltaX: 0, deltaY: 800 }]);
		// A later command flushes the pending delta first, so it observes the scroll position.
		client.wheel("/tabs/one/input", { x: 5, y: 6, deltaX: 10, deltaY: 50 });
		client.send("/tabs/one/input", { kind: "key", key: "PageDown", modifiers: 0 });
		await nextTurn();
		await nextTurn();
		assert.deepEqual(inputs.slice(1), [
			{ kind: "wheel", x: 5, y: 6, deltaX: 10, deltaY: 50 },
			{ kind: "key", key: "PageDown", modifiers: 0 },
		]);
	} finally {
		client.close();
	}
});

test("wheel coalescing flushes before the host bound and when the tab changes", async (t) => {
	const { client, inputs } = wheelFixture(t);
	try {
		await client.connect();
		client.wheel("/tabs/one/input", { x: 1, y: 1, deltaX: 0, deltaY: 4000 });
		client.wheel("/tabs/one/input", { x: 2, y: 1, deltaX: 0, deltaY: 4000 });
		await nextTurn();
		assert.deepEqual(inputs, [{ kind: "wheel", x: 1, y: 1, deltaX: 0, deltaY: 4000 }]);
		t.mock.timers.tick(40);
		await nextTurn();
		assert.equal(inputs.length, 2);
		assert.equal(inputs[1].deltaY, 4000);
		client.wheel("/tabs/one/input", { x: 3, y: 1, deltaX: 0, deltaY: 10 });
		client.wheel("/tabs/two/input", { x: 4, y: 1, deltaX: 0, deltaY: 20 });
		await nextTurn();
		assert.equal(inputs.length, 3, "changing tabs flushes the previous tab first");
		assert.deepEqual(inputs[2], { kind: "wheel", x: 3, y: 1, deltaX: 0, deltaY: 10 });
		t.mock.timers.tick(40);
		await nextTurn();
		assert.deepEqual(inputs[3], { kind: "wheel", x: 4, y: 1, deltaX: 0, deltaY: 20 });
	} finally {
		client.close();
	}
});

test("wheel coalescing never moves scroll distance to another position or cancels a reversal", async (t) => {
	const { client, inputs } = wheelFixture(t);
	try {
		await client.connect();
		// Two scroll containers side by side: each must receive its own wheel at its own position.
		client.wheel("/tabs/one/input", { x: 50, y: 100, deltaX: 0, deltaY: 100 });
		client.wheel("/tabs/one/input", { x: 650, y: 100, deltaX: 0, deltaY: 100 });
		t.mock.timers.tick(40);
		await settle();
		assert.deepEqual(inputs, [
			{ kind: "wheel", x: 50, y: 100, deltaX: 0, deltaY: 100 },
			{ kind: "wheel", x: 650, y: 100, deltaX: 0, deltaY: 100 },
		]);
		inputs.length = 0;
		// At a scroll boundary up-then-down is not zero: the second wheel still scrolls down.
		client.wheel("/tabs/one/input", { x: 10, y: 10, deltaX: 0, deltaY: -100 });
		client.wheel("/tabs/one/input", { x: 10, y: 10, deltaX: 0, deltaY: 100 });
		client.wheel("/tabs/one/input", { x: 10, y: 10, deltaX: 40, deltaY: 100 });
		client.wheel("/tabs/one/input", { x: 10, y: 10, deltaX: -40, deltaY: 100 });
		t.mock.timers.tick(40);
		await settle();
		assert.deepEqual(
			inputs.map((input) => [input.deltaX, input.deltaY]),
			[
				[0, -100],
				[40, 200],
				[-40, 100],
			],
		);
	} finally {
		client.close();
	}
});

test("pointer moves and wheel deltas keep their order without losing wheel coalescing", async (t) => {
	const { client, inputs } = wheelFixture(t);
	try {
		await client.connect();
		client.wheel("/tabs/one/input", { x: 10, y: 10, deltaX: 0, deltaY: 100 });
		t.mock.timers.tick(10);
		client.move("/tabs/one/input", pointerMove(90, 90));
		t.mock.timers.tick(30);
		await settle();
		assert.deepEqual(inputs, [
			{ kind: "wheel", x: 10, y: 10, deltaX: 0, deltaY: 100 },
			pointerMove(90, 90),
		]);
		inputs.length = 0;
		// A wheel moves the remote pointer to its own position, so an earlier pending move is redundant.
		client.move("/tabs/one/input", pointerMove(20, 20));
		client.wheel("/tabs/one/input", { x: 20, y: 20, deltaX: 0, deltaY: 100 });
		t.mock.timers.tick(40);
		await settle();
		assert.deepEqual(inputs, [{ kind: "wheel", x: 20, y: 20, deltaX: 0, deltaY: 100 }]);
		inputs.length = 0;
		// Mouse-wheel jitter between notches still produces one command for the same place.
		client.wheel("/tabs/one/input", { x: 30, y: 30, deltaX: 0, deltaY: 100 });
		client.move("/tabs/one/input", pointerMove(32, 31));
		client.wheel("/tabs/one/input", { x: 33, y: 31, deltaX: 0, deltaY: 100 });
		t.mock.timers.tick(40);
		await settle();
		assert.deepEqual(inputs, [{ kind: "wheel", x: 33, y: 31, deltaX: 0, deltaY: 200 }]);
		inputs.length = 0;
		// A command flushes pending coalesced input in the order it happened.
		client.wheel("/tabs/one/input", { x: 40, y: 40, deltaX: 0, deltaY: 100 });
		client.move("/tabs/one/input", pointerMove(200, 200));
		client.send("/tabs/one/input", { kind: "key", key: "Enter", modifiers: 0 });
		await settle();
		assert.deepEqual(
			inputs.map((input) => input.kind),
			["wheel", "pointer", "key"],
		);
	} finally {
		client.close();
	}
});

test("a displaced page is told so and stays down; stream failures stay recoverable", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	let events: "open" | "503" = "open";
	let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
		const path = String(input);
		if (path.endsWith("/control")) return Response.json({ token: "fixture-token" });
		if (path.endsWith("/events")) {
			if (events === "503") return Response.json({ error: "unavailable" }, { status: 503 });
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						stream = controller;
					},
				}),
			);
		}
		return Response.json({ revision: 0, activeId: null, tabs: [] });
	});
	const failures: unknown[] = [];
	const displaced = new BrowserConnection(
		() => {},
		() => {},
		(error, disconnected) => {
			if (disconnected) failures.push(error);
		},
	);
	try {
		await displaced.connect();
		stream?.enqueue(new TextEncoder().encode("event: replaced\ndata: null\n\n"));
		await settle();
		assert.equal(failures.length, 1);
		assert.ok(failures[0] instanceof BrowserDisconnect && failures[0].reason === "replaced");
		assert.equal(browserRetryable(failures[0]), false, "reconnecting would take control back from the new page");
	} finally {
		displaced.close();
	}
	events = "503";
	const failing = new BrowserConnection(
		() => {},
		() => {},
		() => {},
	);
	try {
		// A connection is established only once its frame stream is: the retry budget must not reset before.
		const failure = await failing.connect().then(
			() => undefined,
			(error: unknown) => error,
		);
		assert.ok(failure instanceof Error, "an unopened stream fails connect");
		assert.equal(browserRetryable(failure), true);
	} finally {
		failing.close();
	}
	assert.equal(browserRetryable(new ApiError(409, {})), false, "a refused control request is a competing page");
	assert.equal(browserRetryable(new ApiError(503, {})), false, "a stopping Host is not retried");
	assert.equal(browserRetryable(new ApiError(500, {})), true);
	assert.equal(browserRetryable(new Error("network")), true);
});
