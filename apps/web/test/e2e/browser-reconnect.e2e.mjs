/**
 * Real Chrome checks for the browser panel's reconnect policy: the real BrowserPanel and
 * BrowserConnection run in the page against the real Host browser routes, with a paused page clock.
 * No browser tab is created, so the Host never launches its own Chromium.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const webRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureId = join(webRoot, "client", "browser-reconnect-fixture.tsx").replaceAll("\\", "/");
const chromePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium",
	"C:/Program Files/Google/Chrome/Application/chrome.exe"].find((path) => path && existsSync(path));
const skip = chromePath ? false : "No installed Chrome; set CHROME_PATH";
// Every panel on one page shares sessionStorage, so two panels are two pages with one copied client id.
const fixture = `
import React, {useState} from "react";
import {createRoot} from "react-dom/client";
import "/src/styles/global.css";
import {IconSprite} from "/src/ui";
import {BrowserPanel} from "/src/features/browser/index.tsx";
import {createInitialState, setState} from "/src/state/store.ts";
setState({...createInitialState(), locale: "en-US"});
window.panels = {};
function Panel({id}) {
	const [open, setOpen] = useState(true);
	window.panels[id] = {setOpen};
	return <div data-panel={id} style={{display: "flex", height: "320px"}}><BrowserPanel open={open}/></div>;
}
const count = Number(new URLSearchParams(location.search).get("panels") ?? "1");
// Vite can evaluate this module again while it re-optimizes dependencies; a second root would be a
// second page connecting with the same client id and would skew every count.
if (!window.fixtureMounted) {
	window.fixtureMounted = true;
	createRoot(document.getElementById("root")).render(<><IconSprite/>{Array.from({length: count}, (_, index) => <Panel key={index} id={String(index)}/>)}</>);
}
`;
const fixturePage = `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/browser-reconnect-fixture.js"></script></body></html>`;

let vite;
let chrome;
let origin;
let hostModules;
/** The Host under test; replaced before each test so no lease survives from a previous one. */
let host;
/** Fault switches and counters for the Host's browser routes. */
const faults = { events: "" };
const counts = { acquire: 0, events: 0 };
const streams = new Set();

async function resetHost() {
	await host?.close();
	for (const response of streams) response.destroy();
	streams.clear();
	faults.events = "";
	counts.acquire = 0;
	counts.events = 0;
	host = new hostModules.WebBrowser([]);
}

before(async () => {
	if (skip) return;
	vite = await createServer({
		configFile: join(webRoot, "vite.config.ts"), root: join(webRoot, "client"),
		server: { host: "127.0.0.1", port: 0, proxy: {} },
		plugins: [{
			name: "browser-reconnect-regression",
			resolveId(id) { if (id === "/browser-reconnect-fixture.js" || id === fixtureId) return fixtureId; },
			load(id) { if (id === fixtureId) return fixture; },
			configureServer(server) {
				server.middlewares.use((req, res, next) => {
					const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
					if (pathname === "/browser-reconnect-fixture") {
						res.setHeader("Content-Type", "text/html");
						res.end(fixturePage);
						return;
					}
					if (!pathname.startsWith("/api/v1/browser")) return next();
					const parts = pathname.split("/").filter(Boolean).slice(3);
					if (parts[0] === "control" && req.method === "POST") counts.acquire++;
					if (parts[0] === "events") {
						counts.events++;
						if (faults.events === "503") {
							res.writeHead(503, { "content-type": "application/json" });
							res.end('{"error":"Browser stream unavailable"}');
							return;
						}
						streams.add(res);
						res.once("close", () => streams.delete(res));
					}
					hostModules.browserRoute(host, parts, req, res).catch(next);
				});
			},
		}],
	});
	await vite.listen();
	origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
	const { WebBrowser } = await vite.ssrLoadModule(join(webRoot, "src", "browser.ts"));
	const { browserRoute } = await vite.ssrLoadModule(join(webRoot, "src", "browser-routes.ts"));
	hostModules = { WebBrowser, browserRoute };
	chrome = await chromium.launch({ executablePath: chromePath, headless: true });
});
after(async () => {
	await chrome?.close();
	await host?.close();
	for (const response of streams) response.destroy();
	await vite?.close();
});
beforeEach(async () => {
	if (!skip) await resetHost();
});

async function until(probe, label, timeout = 8000) {
	const deadline = Date.now() + timeout;
	while (!(await probe())) {
		if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
		await delay(50);
	}
}

/** Wait until the page stops talking to the Host: retries are scheduled only after a request settles. */
async function settle() {
	let last = -1;
	for (let quiet = 0; quiet < 4; ) {
		await delay(80);
		const now = counts.acquire * 1000 + counts.events;
		quiet = now === last ? quiet + 1 : 0;
		last = now;
	}
}

/** A page with a paused clock: retry and health timers fire only when the test advances time. */
async function openPanels(count) {
	const page = await chrome.newPage({ viewport: { width: 900, height: 800 } });
	await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
	await page.clock.pauseAt(new Date("2026-01-01T00:00:01Z"));
	await page.goto(`${origin}/browser-reconnect-fixture?panels=${count}`);
	await page.waitForFunction((count) => Object.keys(window.panels ?? {}).length === count, count);
	return page;
}

const panel = (page, id) => ({
	ready: () => page.locator(`[data-panel="${id}"] .browser-address`).isEnabled(),
	error: async () => {
		// The banner's own text, not the Reconnect button's tooltip.
		const banner = page.locator(`[data-panel="${id}"] .browser-error > span:not([role])`);
		return (await banner.count()) ? banner.innerText() : "";
	},
	// The paused clock also freezes animation frames, which Playwright's actionability checks wait on.
	reconnect: () =>
		page
			.locator(`[data-panel="${id}"] .browser-error button[aria-label="Reconnect browser"]`)
			.evaluate((button) => button.click()),
	setOpen: (open) => page.evaluate(({ id, open }) => window.panels[id].setOpen(open), { id, open }),
});

test("a lost stream reconnects by itself, and closing the panel cancels a pending retry", { skip }, async () => {
	const page = await openPanels(1);
	try {
		const view = panel(page, "0");
		await until(view.ready, "first connection");
		assert.equal(counts.acquire, 1);
		for (const response of streams) response.destroy();
		await until(async () => !(await view.ready()), "drop noticed");
		await page.clock.runFor(1000);
		await until(view.ready, "reconnected after one second");
		assert.equal(counts.acquire, 2);
		// Drop again and hide the inspector before the retry is due: nothing may reconnect behind it.
		for (const response of streams) response.destroy();
		await until(async () => !(await view.ready()), "second drop noticed");
		await view.setOpen(false);
		for (let index = 0; index < 3; index++) {
			await page.clock.runFor(10_000);
			await settle();
		}
		assert.equal(counts.acquire, 2);
	} finally {
		await page.close();
	}
});

test("a stream that cannot open backs off and stops; manual Reconnect starts over", { skip }, async () => {
	faults.events = "503";
	const page = await openPanels(1);
	try {
		const view = panel(page, "0");
		await until(async () => (await view.error()).includes("503"), "first stream failure");
		await settle();
		assert.equal(counts.acquire, 1);
		await page.clock.runFor(900);
		await settle();
		assert.equal(counts.acquire, 1, "the first retry waits a full second");
		await page.clock.runFor(200);
		await until(() => counts.acquire === 2, "first retry");
		await settle();
		await page.clock.runFor(1800);
		await settle();
		assert.equal(counts.acquire, 2, "the second retry backs off to two seconds");
		for (let index = 0; index < 10; index++) {
			await page.clock.runFor(10_000);
			await settle();
		}
		assert.equal(counts.acquire, 6, "one connection and five retries, then the page waits for the user");
		assert.equal(await view.ready(), false);
		await view.reconnect();
		await until(() => counts.acquire === 7, "manual reconnect");
		await until(async () => (await view.error()).includes("503"), "manual attempt failed too");
		await settle();
		faults.events = "";
		await view.reconnect();
		await until(view.ready, "connected once the stream opens");
	} finally {
		await page.close();
	}
});

test("pages sharing a copied client id do not take control from each other", { skip }, async () => {
	const page = await openPanels(2);
	try {
		const views = [panel(page, "0"), panel(page, "1")];
		const states = async () => Promise.all(views.map(async (view) => ({ ready: await view.ready(), error: await view.error() })));
		const busy = "Another StepCode page is using the browser";
		const oneOwner = async () => {
			const [first, second] = await states();
			return first.ready !== second.ready && [first, second].some((state) => state.error.includes(busy));
		};
		await until(oneOwner, "one page controls, the other is told it was replaced");
		await settle();
		const acquired = counts.acquire;
		const owner = (await states()).findIndex((state) => state.ready);
		for (let index = 0; index < 3; index++) {
			await page.clock.runFor(10_000);
			await settle();
		}
		assert.equal(counts.acquire, acquired, "the displaced page must not reconnect by itself");
		assert.equal((await states()).findIndex((state) => state.ready), owner);
		// The user can still take control back explicitly; the other page then stays down.
		await views[1 - owner].reconnect();
		await until(async () => (await states()).findIndex((state) => state.ready) === 1 - owner, "manual takeover");
		await until(oneOwner, "the previous owner is told it was replaced");
		await settle();
		const afterTakeover = counts.acquire;
		for (let index = 0; index < 3; index++) {
			await page.clock.runFor(10_000);
			await settle();
		}
		assert.equal(counts.acquire, afterTakeover);
	} finally {
		await page.close();
	}
});
