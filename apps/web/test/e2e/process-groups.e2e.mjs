import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const webRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureId = join(webRoot, "client", "process-group-fixture.tsx").replaceAll("\\", "/");
const chromePath = [
	process.env.CHROME_PATH,
	"C:/Program Files/Google/Chrome/Application/chrome.exe",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
].find((path) => path && existsSync(path));
const skip = chromePath ? false : "No installed Chrome; set CHROME_PATH";
const fixture = `
import React from "react";
import {createRoot} from "react-dom/client";
import "/src/styles/global.css";
import "/src/features/conversation/stream.css";
import {IconSprite} from "/src/ui";
import {ConversationStream} from "/src/features/conversation/ConversationStream.tsx";
import {setState} from "/src/state/store.ts";
window.fixture = (items, running = false) => setState({
 current:{id:"singleton-test",cwd:"/fixture",status:running?"running":"idle",entries:[]},
 timelineItems:items
});
createRoot(document.getElementById("root")).render(<><IconSprite/><ConversationStream/></>);
`;
let vite;
let browser;
let url;
before(async () => {
	if (skip) return;
	vite = await createServer({
		configFile: join(webRoot, "vite.config.ts"),
		root: join(webRoot, "client"),
		server: { host: "127.0.0.1", port: 0, proxy: {} },
		plugins: [{
			name: "process-group-regression",
			resolveId(id) {
				if (id === "/process-group-fixture.js" || id === fixtureId) return fixtureId;
			},
			load(id) {
				if (id === fixtureId) return fixture;
			},
			configureServer(server) {
				server.middlewares.use((req, res, next) => {
					if (req.url !== "/process-group-fixture") return next();
					res.setHeader("Content-Type", "text/html");
					res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/process-group-fixture.js"></script></body></html>`);
				});
			},
		}],
	});
	await vite.listen();
	url = `http://127.0.0.1:${vite.httpServer.address().port}/process-group-fixture`;
	browser = await chromium.launch({ executablePath: chromePath, headless: true });
});
after(async () => {
	await browser?.close();
	await vite?.close();
});

const thought = {
	kind: "thinking", itemId: "thought", entryId: "thought-entry",
	content: "Inspect **the session**.\n\nRead the full reasoning.",
	running: false, timing: { startedAt: 1000, endedAt: 22000 },
};
const command = {
	kind: "tool", itemId: "command", toolName: "bash", state: "completed",
	inputSummary: "printf fixture", args: { command: "printf fixture" },
	outputSummary: "fixture output",
};

test("singleton thinking has one disclosure; streaming growth preserves its mounted body and manual choice", { skip }, async () => {
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	try {
		await page.goto(url);
		await page.waitForFunction(() => typeof window.fixture === "function");
		await page.evaluate((item) => window.fixture([item]), thought);
		const toggle = page.locator(".thinking-summary");
		await toggle.waitFor();
		assert.equal(await page.locator(".tool-group-trigger").isVisible(), false);
		assert.equal(await page.locator(".thinking-elapsed").count(), 1);
		assert.equal(await page.locator(".tool-group-body").evaluate((el) => getComputedStyle(el).paddingLeft), "0px");
		await toggle.focus();
		await page.keyboard.press("Enter");
		assert.equal(await toggle.getAttribute("aria-expanded"), "true");
		await page.evaluate(() => { window.originalRow = document.querySelector(".thinking"); });
		await page.evaluate(([first, second]) => window.fixture([first, second]), [thought, command]);
		await page.waitForFunction(() => document.querySelector(".process-tool-group")?.dataset.single === "false");
		assert.equal(await page.locator(".tool-group-trigger").isVisible(), true);
		assert.equal(await page.locator(".tool-group-trigger").getAttribute("aria-expanded"), "true");
		assert.equal(await toggle.getAttribute("aria-expanded"), "true");
		assert.equal(await page.evaluate(() => window.originalRow === document.querySelector(".thinking")), true);
		assert.equal(await page.evaluate(() => document.activeElement === document.querySelector(".thinking-summary")), true);
		await page.evaluate((item) => window.fixture([item]), thought);
		assert.equal(await toggle.getAttribute("aria-expanded"), "true");
		assert.equal(await page.locator(".tool-group-trigger").isVisible(), false);
		await toggle.click();
		await page.evaluate((item) => window.fixture([{ ...item, running: true, timing: { startedAt: Date.now() - 21000 } }], true), thought);
		await page.waitForFunction(() => document.querySelector(".thinking")?.dataset.running === "true");
		assert.equal(await page.locator(".thinking-elapsed").count(), 1);
		await toggle.click();
		await page.evaluate(([item, next]) => window.fixture([{
			...item, content: item.content + "\n\nAppended reasoning.", running: true,
			timing: { startedAt: Date.now() - 21000 },
		}, next], true), [thought, command]);
		await page.waitForFunction(() => document.querySelector(".thinking-body")?.textContent.includes("Appended reasoning."));
		assert.equal(await toggle.getAttribute("aria-expanded"), "true");
		assert.equal(await page.locator(".tool-group-trigger").getAttribute("aria-expanded"), "true");
		assert.deepEqual(errors, []);
	} finally {
		await page.close();
	}
});

test("singleton command exposes output in one step and retains output controls when grouped", { skip }, async () => {
	const page = await browser.newPage();
	try {
		await page.goto(url);
		await page.waitForFunction(() => typeof window.fixture === "function");
		await page.evaluate((item) => window.fixture([item]), command);
		const toggle = page.locator(".tool-toggle");
		await toggle.waitFor();
		assert.equal(await page.locator(".tool-group-trigger").isVisible(), false);
		await toggle.click();
		await page.getByText("fixture output", { exact: true }).waitFor();
		const wrap = page.locator(".tool-cx-action[aria-pressed]");
		await wrap.click();
		await page.evaluate(() => { window.originalRow = document.querySelector(".tool-call"); });
		await page.evaluate(([first, second]) => window.fixture([first, second]), [command, thought]);
		await page.waitForFunction(() => document.querySelector(".process-tool-group")?.dataset.single === "false");
		assert.equal(await page.evaluate(() => window.originalRow === document.querySelector(".tool-call")), true);
		assert.equal(await toggle.getAttribute("aria-expanded"), "true");
		assert.equal(await wrap.getAttribute("aria-pressed"), "true");
		assert.equal(await page.locator(".tool-group-trigger").getAttribute("aria-expanded"), "true");
		await page.locator(".tool-group-trigger").click();
		assert.equal(await page.locator(".tool-group-disclosure").getAttribute("inert"), "");
		await page.locator(".tool-group-trigger").click();
		assert.equal(await wrap.getAttribute("aria-pressed"), "true");
		await page.evaluate((item) => window.fixture([item]), command);
		assert.equal(await toggle.getAttribute("aria-expanded"), "true");
		assert.equal(await page.locator(".tool-group-trigger").isVisible(), false);
	} finally {
		await page.close();
	}
});

test("losing a sibling leaves the singleton accessible without losing group-header keyboard focus", { skip }, async () => {
	const page = await browser.newPage();
	try {
		await page.goto(url);
		await page.waitForFunction(() => typeof window.fixture === "function");
		await page.evaluate(([first, second]) => window.fixture([first, { ...second, state: "pending" }], true), [thought, command]);
		const header = page.locator(".tool-group-trigger");
		await header.waitFor();
		await header.focus();
		await page.keyboard.press("Enter");
		assert.equal(await page.evaluate(() => document.activeElement === document.querySelector(".tool-group-trigger")), true);
		await page.evaluate((first) => window.fixture([first]), thought);
		await page.waitForFunction(() => document.querySelector(".process-tool-group")?.dataset.single === "true");
		assert.equal(await header.isVisible(), false);
		assert.equal(await page.locator(".process-tool-group .tool-call").count(), 0);
		assert.equal(
			await page.evaluate(() => document.activeElement === document.querySelector(".thinking-summary")),
			true,
			"Focus must follow the remaining member when its group header disappears",
		);
		await page.evaluate(([first, second]) => window.fixture([first, second]), [thought, command]);
		await page.waitForFunction(() => document.querySelector(".process-tool-group")?.dataset.single === "false");
		await page.evaluate(() => {
			const outside = document.createElement("button");
			outside.id = "outside-focus";
			outside.textContent = "Outside";
			document.body.append(outside);
			outside.focus();
		});
		await page.evaluate((first) => window.fixture([first]), thought);
		await page.waitForFunction(() => document.querySelector(".process-tool-group")?.dataset.single === "true");
		assert.equal(await header.isVisible(), false);
		assert.equal(await page.evaluate(() => document.activeElement?.id), "outside-focus");
	} finally {
		await page.close();
	}
});

test("a failed call folds into its process group and shows its state only when opened", { skip }, async () => {
	const page = await browser.newPage();
	try {
		await page.goto(url);
		await page.waitForFunction(() => typeof window.fixture === "function");
		const failed = {
			...command, itemId: "failed-command", state: "failed",
			args: { command: "git log --skip=2" }, outputSummary: "fatal: bad revision",
		};
		await page.evaluate((items) => window.fixture(items), [thought, command, failed]);
		const header = page.locator(".tool-group-trigger");
		await header.waitFor();
		assert.equal(await page.locator(".process-tool-group").count(), 1);
		assert.equal(await header.getAttribute("aria-expanded"), "false");
		assert.match(await header.innerText(), /已完成：命令执行 2 项|Completed: 2 commands/);
		assert.equal(await page.locator(".tool-group-disclosure").getAttribute("inert"), "");
		const row = page.locator('.process-tool-group .tool-call[data-tool-state="failed"]');
		assert.equal(await row.count(), 1);
		await header.click();
		await page.waitForFunction(() => document.querySelector(".tool-group-disclosure")?.getAttribute("inert") === null);
		const colors = await row.evaluate((el) => ({
			verb: getComputedStyle(el.querySelector(".tool-verb")).color,
			sibling: getComputedStyle(document.querySelector('.tool-call[data-tool-state="completed"] .tool-verb')).color,
			glyph: getComputedStyle(el.querySelector(".tool-glyph")).color,
		}));
		assert.equal(colors.verb, colors.sibling, "a failed verb reads like its siblings");
		assert.notEqual(colors.glyph, colors.verb, "only the glyph marks the failure");
		await row.locator(".tool-toggle").click();
		await page.getByText("fatal: bad revision", { exact: true }).waitFor();
		assert.equal(await row.locator(".tool-cx-status.failed").count(), 1);
	} finally {
		await page.close();
	}
});

test("unopened singletons grow into folded groups; single-level layouts fit narrow screens", { skip }, async () => {
	const page = await browser.newPage();
	try {
		await page.goto(url);
		await page.waitForFunction(() => typeof window.fixture === "function");
		await page.evaluate((item) => window.fixture([item]), thought);
		await page.locator(".thinking-summary").waitFor();
		await page.evaluate(([first, second]) => window.fixture([first, second]), [thought, command]);
		await page.waitForFunction(() => document.querySelector(".process-tool-group")?.dataset.single === "false");
		assert.equal(await page.locator(".tool-group-trigger").getAttribute("aria-expanded"), "false");
		assert.equal(await page.locator(".tool-group-disclosure").getAttribute("inert"), "");
		await page.evaluate((item) => window.fixture([item]), thought);
		await page.locator(".thinking-summary").click();
		await page.emulateMedia({ reducedMotion: "reduce" });
		assert.equal(await page.locator(".thinking-disclosure").evaluate((el) => getComputedStyle(el).transitionDuration), "0s");
		const screenshots = process.env.STEPCODE_WEB_QA_DIR || join(tmpdir(), "stepcode-single-member-qa");
		await mkdir(screenshots, { recursive: true });
		for (const [width, theme] of [[1440, "light"], [390, "dark"], [320, "light"]]) {
			await page.setViewportSize({ width, height: 900 });
			await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
			await page.waitForTimeout(300);
			assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
			assert.equal(await page.locator(".tool-group-trigger").isVisible(), false);
			assert.match(await page.locator(".thinking-body").innerText(), /full reasoning/);
			await page.screenshot({ path: join(screenshots, `single-${width}-${theme}.png`) });
		}
		console.log(`Single-member screenshots: ${screenshots}`);
	} finally {
		await page.close();
	}
});
