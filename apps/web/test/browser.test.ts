import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WebBrowser } from "../src/browser.ts";
import { browserRoute } from "../src/browser-routes.ts";
import { browserExecutable, BrowserRequestError, browserUrl, readBrowserInput } from "../src/browser-policy.ts";

test("browser URL policy rejects host ports, credentials and non-web schemes", () => {
	assert.equal(browserUrl("example.com/a", [3077]), "https://example.com/a");
	assert.equal(browserUrl("http://127.0.0.1:8080", [3077]), "http://127.0.0.1:8080/");
	assert.equal(browserUrl("about:blank", [3077], true), "about:blank");
	for (const url of ["file:///C:/secret", "javascript:alert(1)", "data:text/html,secret", "http://me:pw@example.com", "http://localhost:3077", "http://alias.example:3077", "http://[::1]:3077"]) {
		assert.throws(() => browserUrl(url, [3077]), BrowserRequestError, url);
	}
	assert.throws(() => browserUrl(null, [3077]), BrowserRequestError);
	assert.throws(() => browserExecutable({ STEPCODE_WEB_BROWSER_PATH: "Z:/missing-chrome.exe" }), /Chrome\/Edge not found/);
});

test("browser input validates bounded text, coordinates, modifiers and keys", () => {
	assert.deepEqual(readBrowserInput({ kind: "text", text: "\u4e2d\u6587" }), { kind: "text", text: "\u4e2d\u6587" });
	assert.deepEqual(readBrowserInput({ kind: "key", key: "ArrowDown", modifiers: 2 }), { kind: "key", key: "ArrowDown", modifiers: 2 });
	for (const input of [
		{ kind: "text", text: "x".repeat(16385) }, { kind: "key", key: "Control+O", modifiers: 0 },
		{ kind: "key", key: "a", modifiers: 16 }, { kind: "pointer", x: Number.NaN, y: 10 },
		{ kind: "wheel", x: 1, y: 1, deltaX: 0, deltaY: Infinity },
	]) assert.throws(() => readBrowserInput(input), BrowserRequestError);
});

test("controller rotation preserves replacement against stale release and rejects competing pages", async () => {
	const browser = new WebBrowser([3077]);
	try {
		const first = browser.acquire("client-111111111111");
		assert.throws(() => browser.acquire("client-222222222222"), /another StepCode page/);
		let closed = 0;
		browser.subscribe(first.token, () => {}, () => closed++);
		const next = browser.acquire("client-111111111111");
		assert.notEqual(next.token, first.token);
		assert.equal(closed, 1);
		browser.release(first.token);
		browser.touch(next.token);
		assert.throws(() => browser.touch(first.token), /expired/);
		browser.release(next.token);
		browser.acquire("client-222222222222");
	} finally { await browser.close(); }
	assert.throws(() => browser.acquire("client-111111111111"), /stopping/);
});

test("browser command queue is bounded and revalidates control before mutations", async () => {
	const browser = new WebBrowser([3077]);
	try {
		const { token } = browser.acquire("client-111111111111");
		const commands = Array.from({ length: 64 }, () => browser.command(token, async () => 1));
		assert.throws(() => browser.command(token, async () => 2), /queue is full/);
		const settled = Promise.allSettled(commands);
		browser.release(token);
		assert.ok((await settled).every((result) => result.status === "rejected"));
	} finally { await browser.close(); }
});

test("an attached stream outlives a missed heartbeat; a closed page loses control", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	const browser = new WebBrowser([3077]);
	try {
		const { token } = browser.acquire("client-111111111111");
		let closed = 0;
		const stop = browser.subscribe(token, () => {}, () => closed++);
		t.mock.timers.tick(15_001);
		assert.equal(closed, 0, "the open stream must not be ended by a missed heartbeat");
		browser.touch(token);
		stop();
		t.mock.timers.tick(15_001);
		assert.throws(() => browser.touch(token), /expired/);
	} finally {
		await browser.close();
	}
});

test("an explicit release still ends the attached stream and drops control", async () => {
	const browser = new WebBrowser([3077]);
	try {
		const { token } = browser.acquire("client-111111111111");
		let closed = 0;
		browser.subscribe(token, () => {}, () => closed++);
		browser.release(token);
		assert.equal(closed, 1);
		assert.throws(() => browser.command(token, async () => 1), /expired/);
	} finally {
		await browser.close();
	}
});

test("an attached stream keeps control even when a request beats the expiry callback", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	const browser = new WebBrowser([3077]);
	try {
		const { token } = browser.acquire("client-111111111111");
		let closed = 0;
		browser.subscribe(token, () => {}, () => closed++);
		// A busy Host resumes past the deadline and serves the page's request before its timers.
		t.mock.timers.setTime(16_000);
		browser.touch(token);
		assert.throws(() => browser.acquire("client-222222222222"), /another StepCode page/);
		assert.equal(closed, 0);
	} finally {
		await browser.close();
	}
});

test("a same-id replacement tells the displaced stream before closing it", async () => {
	const browser = new WebBrowser([3077]);
	try {
		const { token } = browser.acquire("client-111111111111");
		const events: string[] = [];
		browser.subscribe(token, (event) => events.push(event.type), () => events.push("end"));
		browser.acquire("client-111111111111");
		assert.deepEqual(events, ["snapshot", "replaced", "end"]);
	} finally {
		await browser.close();
	}
});

test("the event route writes control events even while frames are dropped for backpressure", async () => {
	const browser = new WebBrowser([3077]);
	const written: string[] = [];
	const listeners = new Map<string, () => void>();
	// A response whose socket never drains: snapshots are held back, frames dropped.
	const response = {
		headersSent: false,
		destroyed: false,
		writableEnded: false,
		writableNeedDrain: true,
		writeHead() {
			this.headersSent = true;
		},
		write(chunk: string) {
			written.push(chunk);
			return false;
		},
		end() {
			this.writableEnded = true;
			listeners.get("close")?.();
		},
		on(name: string, listener: () => void) {
			listeners.set(name, listener);
		},
		once(name: string, listener: () => void) {
			listeners.set(name, listener);
		},
		off() {},
	};
	try {
		const { token } = browser.acquire("client-111111111111");
		const request = { method: "GET", headers: { "x-stepcode-browser-control": token } };
		await browserRoute(
			browser,
			["events"],
			request as unknown as Parameters<typeof browserRoute>[2],
			response as unknown as Parameters<typeof browserRoute>[3],
		);
		browser.acquire("client-111111111111");
		assert.ok(written.some((chunk) => chunk.startsWith("event: replaced")), JSON.stringify(written));
		assert.equal(response.writableEnded, true);
	} finally {
		await browser.close();
	}
});

test("a browser command that never settles times out and does not block the next one", async () => {
	const browser = new WebBrowser([3077]);
	try {
		const { token } = browser.acquire("client-111111111111");
		const hung = browser.command(token, () => new Promise<never>(() => {}), 50);
		const next = browser.command(token, async () => "closed", 1000);
		await assert.rejects(hung, (error: unknown) => error instanceof BrowserRequestError && error.status === 504);
		assert.equal(await next, "closed");
	} finally { await browser.close(); }
});

test("browser routes require control for mutations and reject invalid JSON and unknown paths", async () => {
	const browser = new WebBrowser([3077]);
	const server = createServer((request, response) => {
		void browserRoute(browser, new URL(request.url ?? "/", "http://localhost").pathname.split("/").filter(Boolean), request, response);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const root = `http://127.0.0.1:${address.port}`;
	try {
		assert.equal((await fetch(`${root}/tabs`, { method: "POST", body: "{}" })).status, 409);
		assert.equal((await fetch(`${root}/control`, { method: "POST", body: "{" })).status, 400);
		const { token } = await (await fetch(`${root}/control`, { method: "POST", body: '{"clientId":"client-111111111111"}' })).json() as { token: string };
		const headers = { "x-stepcode-browser-control": token };
		assert.equal((await fetch(`${root}/viewport`, { method: "POST", headers, body: '{"width":1,"height":9999999}' })).status, 400);
		assert.equal((await fetch(`${root}/unknown`, { method: "POST", headers, body: "{}" })).status, 404);
		assert.equal((await fetch(`${root}/tabs`, { method: "POST", headers, body: JSON.stringify({ padding: "x".repeat(66000) }) })).status, 413);
	} finally {
		await browser.close();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

async function waitFor(predicate: () => boolean, timeout = 12_000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeout) throw new Error("Browser fixture timed out");
		await delay(50);
	}
}

test("installed Chromium: frames, Chinese input, click, navigation, zoom, reconnect, popups and cleanup", {
	skip: process.env.STEPCODE_WEB_BROWSER_TEST !== "1",
	timeout: 45_000,
}, async () => {
	let received = "";
	let blockedRequests = 0;
	const fixture = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		if (url.pathname === "/sent") received = url.searchParams.get("text") ?? "";
		response.setHeader("content-type", "text/html; charset=utf-8");
		response.end(`<!doctype html><title>${url.pathname === "/sent" ? "Sent" : "Browser fixture"}</title>
<style>body{margin:0;background:#eef5f0;font:18px sans-serif}input,button,a{display:block;margin:20px;width:220px;height:40px}</style>
<h1>Browser fixture</h1><form action="/sent"><input name="text" aria-label="Text"><button>Submit</button></form>
<a href="/next">Next</a><a target="_blank" href="/popup">Popup</a><div style="height:2000px;background:#72bc9a">Scroll</div>`);
	});
	const forbidden = createServer((_request, response) => { blockedRequests++; response.end("private"); });
	fixture.listen(0, "127.0.0.1"); forbidden.listen(0, "127.0.0.1");
	await Promise.all([once(fixture, "listening"), once(forbidden, "listening")]);
	const address = fixture.address(); const blocked = forbidden.address();
	assert.ok(address && typeof address !== "string"); assert.ok(blocked && typeof blocked !== "string");
	const browser = new WebBrowser([blocked.port]);
	const root = `http://127.0.0.1:${address.port}`;
	const started = Date.now();
	let frames = 0;
	let lastWidth = 0;
	let firstFrameMs = 0;
	try {
		const { token } = browser.acquire("fixture-111111111111");
		const stop = browser.subscribe(token, (event) => {
			if (event.type === "frame") {
				frames++;
				if (!firstFrameMs) firstFrameMs = Date.now() - started;
				lastWidth = event.data.width;
				const bytes = Buffer.from(event.data.data, "base64");
				assert.equal(bytes.readUInt16BE(0), 0xffd8);
				assert.ok(bytes.length > 200);
			}
		}, () => {});
		await browser.command(token, () => browser.create(root));
		const id = browser.snapshot().activeId;
		assert.ok(id);
		await waitFor(() => browser.snapshot().tabs[0]?.title === "Browser fixture" && frames > 0);
		// The fixed fixture places the input below the h1; Tab is a deterministic focus path.
		await browser.input(id, { kind: "key", key: "Tab", modifiers: 0 });
		await browser.input(id, { kind: "text", text: "\u4e2d\u6587-test" });
		// Select-all is Cmd+A on macOS and Ctrl+A elsewhere.
		await browser.input(id, { kind: "key", key: "a", modifiers: process.platform === "darwin" ? 4 : 2 });
		assert.equal(await browser.selection(id), "\u4e2d\u6587-test");
		await browser.input(id, { kind: "key", key: "Enter", modifiers: 0 });
		await waitFor(() => received === "\u4e2d\u6587-test");
		await waitFor(() => browser.snapshot().tabs[0]?.title === "Sent");
		await browser.action(id, "back");
		await waitFor(() => browser.snapshot().tabs[0]?.title === "Browser fixture");
		await browser.action(id, "forward");
		await waitFor(() => browser.snapshot().tabs[0]?.title === "Sent");
		await browser.action(id, "zoom", 1.5);
		await browser.resize(600, 500);
		await waitFor(() => lastWidth === 400);
		stop();
		const before = frames;
		await delay(300);
		assert.equal(frames, before);
		const refreshed = browser.acquire("fixture-111111111111");
		assert.equal(browser.snapshot().activeId, id);
		browser.release(token);
		browser.touch(refreshed.token);
		assert.equal(browser.snapshot().tabs.length, 1);
		await assert.rejects(browser.action(id, "navigate", `http://alias.example:${blocked.port}`), /host ports/);
		assert.equal(blockedRequests, 0);
		// Return to 100% and use the fixture's popup link through mouse input.
		await browser.action(id, "zoom", 1);
		await browser.resize(900, 700);
		await browser.input(id, { kind: "pointer", phase: "down", x: 80, y: 315, button: "left", clicks: 1 });
		await browser.input(id, { kind: "pointer", phase: "up", x: 80, y: 315, button: "left", clicks: 1 });
		await waitFor(() => browser.snapshot().tabs.length === 2);
		await browser.closeTab(browser.snapshot().activeId ?? "");
		assert.equal(browser.snapshot().tabs.length, 1);
		console.log(JSON.stringify({ frames, firstFrameMs, browser: browserExecutable() }));
	} finally {
		await browser.close();
		assert.equal(browser.snapshot().tabs.length, 0);
		fixture.closeAllConnections(); forbidden.closeAllConnections();
		await Promise.all([new Promise<void>((resolve) => fixture.close(() => resolve())), new Promise<void>((resolve) => forbidden.close(() => resolve()))]);
	}
});

test("installed Chromium: page scripts cannot open tabs, a clicked popup still opens", {
	skip: process.env.STEPCODE_WEB_BROWSER_TEST !== "1",
	timeout: 45_000,
}, async () => {
	const fixture = createServer((request, response) => {
		response.setHeader("content-type", "text/html; charset=utf-8");
		if (request.url === "/spam") response.end("<title>spam</title><script>for (let i = 0; i < 5; i++) window.open('/p' + i)</script>");
		else if (request.url === "/link")
			response.end("<title>link</title><style>body{margin:0}a{display:block;width:300px;height:300px}</style><a target=_blank href='/popup'>open</a>");
		else response.end("<title>popup</title>");
	});
	fixture.listen(0, "127.0.0.1");
	await once(fixture, "listening");
	const address = fixture.address();
	assert.ok(address && typeof address !== "string");
	const root = `http://127.0.0.1:${address.port}`;
	const browser = new WebBrowser([]);
	try {
		const { token } = browser.acquire("fixture-111111111111");
		await browser.command(token, () => browser.create(`${root}/spam`));
		await waitFor(() => browser.snapshot().tabs[0]?.title === "spam");
		await browser.command(token, () => browser.create(`${root}/link`));
		await waitFor(() => browser.snapshot().tabs[1]?.title === "link");
		const id = browser.snapshot().activeId ?? "";
		await browser.input(id, { kind: "pointer", phase: "down", x: 100, y: 100, button: "left", clicks: 1 });
		await browser.input(id, { kind: "pointer", phase: "up", x: 100, y: 100, button: "left", clicks: 1 });
		await waitFor(() => browser.snapshot().tabs.length === 3);
		await delay(300);
		assert.deepEqual(browser.snapshot().tabs.map((tab) => tab.title), ["spam", "link", "popup"]);
	} finally {
		await browser.close();
		fixture.closeAllConnections();
		await new Promise<void>((resolve) => fixture.close(() => resolve()));
	}
});
