/** Real Composer/session lifecycle regression; all HTTP calls are local mocks. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { after, before, test } from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const webRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureId = join(webRoot, "client", "composer-draft-fixture.tsx");
const chromePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/google-chrome", "/usr/bin/chromium"].find((path) => path && existsSync(path));
const skip = chromePath ? false : "No installed Chrome; set CHROME_PATH";
const fixture = `
import React from "react";
import {createRoot} from "react-dom/client";
import "/src/styles/global.css";
import {IconSprite} from "/src/ui";
import {Composer, ImagePreview} from "/src/features/composer/index.tsx";
import {ConversationStream} from "/src/features/conversation/ConversationStream.tsx";
import {composerDraft} from "/src/features/composer/drafts.ts";
import {composerDraftPatch} from "/src/state/composer-drafts.ts";
import {createInitialState, getState, setState, setUi, useAppStore} from "/src/state/store.ts";
import {openSession, startDraft} from "/src/state/session.ts";
import {promptText} from "/src/features/composer/prompt-editor.ts";
setState({...createInitialState(),booted:true,bootstrapCwd:"/fixture",draftCwd:"/fixture",locale:"en-US"});
window.fixture = {getState, setState, setUi, promptText, openSession, startDraft, composerDraft, composerDraftPatch};
createRoot(document.getElementById("root")).render(<><IconSprite/><ImagePreview/><ConversationStream/><div className="composer-zone"><Composer/></div></>);
`;
let vite;
let browser;
let url;
let cacheDir;
before(async () => {
	if (skip) return;
	cacheDir = await mkdtemp(join(tmpdir(), "composer-draft-vite-"));
	vite = await createServer({
		cacheDir,
		optimizeDeps: { holdUntilCrawlEnd: false },
		configFile: join(webRoot, "vite.config.ts"), root: join(webRoot, "client"),
		server: { host: "127.0.0.1", port: 0, proxy: {}, hmr: false },
		plugins: [{
			name: "composer-draft-regression",
			resolveId(id) { if (id === "/composer-draft-fixture.js" || id === fixtureId) return fixtureId; },
			load(id) { if (id === fixtureId) return fixture; },
			configureServer(server) {
				server.middlewares.use((req, res, next) => {
					if (req.url !== "/composer-draft-fixture") return next();
					res.setHeader("Content-Type", "text/html");
					res.end(`<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/composer-draft-fixture.js"></script></body></html>`);
				});
			},
		}],
	});
	await vite.listen();
	await vite.environments.client.depsOptimizer?.scanProcessing;
	await Promise.all(Object.values(vite.environments.client.depsOptimizer?.metadata.discovered ?? {}).map(dep => dep.processing));
	url = `http://127.0.0.1:${vite.httpServer.address().port}/composer-draft-fixture`;
	browser = await chromium.launch({ executablePath: chromePath, headless: true });
});
after(async () => {
	try {
		await browser?.close();
	} finally {
		try {
			await vite?.environments.client.depsOptimizer?.scanProcessing;
		} finally {
			try {
				await vite?.close();
			} finally {
				if (cacheDir) await rm(cacheDir, { recursive: true });
			}
		}
	}
});

const snapshot = (id) => ({ id, cwd: id === "C" ? "/other" : "/fixture", status: "idle", permissionPreset: "approve-for-me", entries: id === "A" ? [{ id: "entry", type: "message", timestamp: "2026-10-28T00:00:00Z", message: { role: "user", content: "old message" } }] : [], revision: 1 });
async function pageFixture() {
	const page = await browser.newPage();
	await page.route("**/api/**", (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith("/events")) return route.fulfill({ contentType: "text/event-stream", body: "" });
		if (path === "/api/v1/sessions" && route.request().method() === "POST") return route.fulfill({ json: snapshot("created") });
		if (/\/(messages|queue|steer)$/.test(path)) return route.fulfill({ json: { ok: true } });
		const id = path.match(/\/sessions\/([^/]+)$/)?.[1];
		return route.fulfill({ json: id ? snapshot(id) : { models: [], skills: [], servers: [], sessions: [] } });
	});
	await page.goto(url);
	await page.waitForFunction(() => window.fixture && document.querySelector("#prompt"));
	return page;
}
async function open(page, id) {
	const previous = await page.evaluate(() => {
		window.previousPrompt = document.querySelector("#prompt");
		return window.fixture.getState().composerDraftId;
	});
	await page.evaluate((id) => window.fixture.openSession(id), id);
	await page.waitForFunction(({ id, previous }) => {
		const state = window.fixture.getState();
		return state.current?.id === id && !state.ui.openingSession && document.querySelector("#prompt") &&
			(state.composerDraftId === previous || document.querySelector("#prompt") !== window.previousPrompt);
	}, { id, previous });
}
async function type(page, text) {
	await page.locator("#prompt").focus();
	await page.keyboard.type(text);
}
const value = (page) => page.evaluate(() => window.fixture.promptText(document.querySelector("#prompt")));
async function newDraft(page, cwd = "/fixture") {
	await page.evaluate((cwd) => {
		window.previousPrompt = document.querySelector("#prompt");
		window.fixture.startDraft(cwd);
	}, cwd);
	await page.waitForFunction(() => !window.fixture.getState().current && document.querySelector("#prompt") && document.querySelector("#prompt") !== window.previousPrompt);
}
async function settledSend(page, id) {
	await page.waitForFunction((id) => !window.fixture.composerDraft(id).sending, id);
}
async function pasteFile(page, name, mime = "text/plain", selector = "#prompt") {
	await page.locator(selector).focus();
	await page.evaluate(({ name, mime, selector }) => {
		const data = new DataTransfer();
		data.items.add(new File(["fixture"], name, { type: mime }));
		document.querySelector(selector).dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
	}, { name, mime, selector });
}
async function deferredRoute(page, pattern) {
	let arrived;
	const ready = new Promise((resolve) => { arrived = resolve; });
	let release;
	const response = new Promise((resolve) => { release = resolve; });
	await page.route(pattern, async (route) => {
		arrived(route.request());
		await route.fulfill(await response);
	});
	return { ready, release };
}


test("image preview and shared remove controls stay scoped to main drafts and inline rewrites", { skip }, async () => {
	const page = await pageFixture();
	try {
		const pasteImage = async (name, selector = "#prompt") => {
			await page.locator(selector).focus();
			await page.evaluate(({ name, selector }) => {
				const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII="), char => char.charCodeAt(0));
				const data = new DataTransfer();
				data.items.add(new File([bytes], name, { type: "image/png" }));
				document.querySelector(selector).dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
			}, { name, selector });
		};
		const preview = async (scope, name) => {
			const thumb = page.locator(`${scope} .attachment-thumb`);
			await thumb.waitFor();
			assert.equal(await thumb.getAttribute("title"), null);
			assert.equal(await thumb.getAttribute("aria-label"), `View image: ${name}`);
			await thumb.hover();
			await page.locator(`${scope} [role=tooltip]`).filter({ hasText: name }).waitFor({ state: "visible" });
			await thumb.focus();
			await page.keyboard.press("Enter");
			await page.locator("#imagePreview").waitFor({ state: "visible" });
			assert.equal(await page.locator("#imagePreview [role=dialog]").getAttribute("aria-label"), name);
			assert.equal(await page.locator("#imagePreview img").getAttribute("alt"), name);
			assert.equal(await page.locator("#imagePreview img").getAttribute("src"), await thumb.locator("img").getAttribute("src"));
			await page.waitForFunction(() => document.querySelector("#imagePreview img")?.naturalWidth === 1);
			await page.locator("#imagePreview .image-preview-close").click();
			await page.waitForFunction(() => document.querySelector("#imagePreview").hidden);
		};
		const remove = async (scope) => {
			const button = page.locator(`${scope} .attachment-remove`);
			assert.ok((await button.getAttribute("class")).split(" ").includes("icon-button"));
			assert.equal(await button.getAttribute("type"), "button");
			assert.equal(await button.getAttribute("title"), null);
			assert.equal(await button.getAttribute("aria-label"), "Remove attachment");
			await button.hover();
			await page.locator(`${scope} [role=tooltip]`).filter({ hasText: "Remove attachment" }).waitFor({ state: "visible" });
			const bounds = await button.boundingBox();
			assert.equal(bounds.width, 18);
			assert.equal(bounds.height, 18);
			await button.click();
			await page.locator(`${scope} .attachment-chip`).waitFor({ state: "detached" });
			assert.equal(await page.evaluate(() => window.fixture.getState().ui.imagePreview), null, "remove must not open preview");
		};
		await open(page, "B");
		await pasteImage("B.png");
		await page.waitForFunction(() => window.fixture.getState().attachments.length === 1);
		await open(page, "A");
		await type(page, "main text stays");
		await pasteImage("A.png");
		await page.waitForFunction(() => window.fixture.getState().attachments.length === 1);
		await preview("#attachmentList", "A.png");
		await page.evaluate(() => window.fixture.setUi({ editingPrompt: { entryId: "entry", text: "rewrite text stays" } }));
		await page.locator("#editPrompt").waitFor();
		await pasteImage("rewrite.png", "#editPrompt");
		await preview("#editComposer", "rewrite.png");
		await remove("#editComposer");
		assert.equal(await page.evaluate(() => window.fixture.getState().attachments[0]?.name), "A.png");
		assert.equal(await page.locator("#editPrompt").textContent(), "rewrite text stays");
		await remove("#attachmentList");
		assert.equal(await page.evaluate(() => window.fixture.getState().attachments.length), 0);
		assert.equal(await value(page), "main text stays");
		await page.evaluate(() => window.fixture.setUi({ editingPrompt: null }));
		await open(page, "B");
		assert.equal(await page.evaluate(() => window.fixture.getState().attachments[0]?.name), "B.png");
		await open(page, "A");
		assert.equal(await page.evaluate(() => window.fixture.getState().attachments.length), 0);
	} finally { await page.close(); }
});

test("truncated attachment labels reveal the complete wrapping filename in a shared tooltip", { skip }, async () => {
	const page = await pageFixture();
	try {
		const name = `attachment-${"long-filename-".repeat(14)}.txt`;
		await open(page, "A");
		await page.evaluate(name => window.fixture.setState({ attachments: [{ name, mimeType: "text/plain", data: "Zml4dHVyZQ==", kind: "text" }] }), name);
		const label = page.locator("#attachmentList .attachment-chip > span").filter({ hasText: name }).first();
		assert.equal(await label.evaluate(element => element.scrollWidth > element.clientWidth), true);
		await label.hover();
		const hint = page.locator("#attachmentList [role=tooltip]").filter({ hasText: name });
		await hint.waitFor({ state: "visible" });
		assert.equal(await hint.textContent(), name);
		assert.equal(await hint.evaluate(element => getComputedStyle(element).whiteSpace), "normal");
		assert.equal(await hint.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
		await page.locator("#attachmentList .attachment-remove").click();
		assert.equal(await page.locator("#attachmentList .attachment-chip").count(), 0);
	} finally { await page.close(); }
});

test("typing in A does not appear in B, and returning restores each draft", { skip }, async () => {
	const page = await pageFixture();
	try {
		await open(page, "A");
		await type(page, "A private draft");
		await open(page, "B");
		assert.equal(await value(page), "", "B must not show A's unsent input");
		await type(page, "B independent draft");
		await open(page, "A");
		assert.equal(await value(page), "A private draft");
		await open(page, "B");
		assert.equal(await value(page), "B independent draft");
	} finally { await page.close(); }
});

test("cross-workspace and repeated same-folder new conversations start empty", { skip }, async () => {
	const page = await pageFixture();
	try {
		await open(page, "A");
		await type(page, "saved A");
		await open(page, "C");
		assert.equal(await value(page), "");
		await type(page, "saved C");
		await newDraft(page);
		assert.equal(await value(page), "");
		await type(page, "discarded new draft");
		await newDraft(page);
		assert.equal(await value(page), "");
		await open(page, "A");
		assert.equal(await value(page), "saved A");
		await open(page, "C");
		assert.equal(await value(page), "saved C");
	} finally { await page.close(); }
});

test("rich blocks, modes, images and skill picks travel with only their draft", { skip }, async () => {
	const page = await pageFixture();
	try {
		await open(page, "A");
		await page.evaluate(() => {
			const root = document.querySelector("#prompt");
			root.innerHTML = "<div>first</div><div><br></div><div>**second**</div>";
			root.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const rich = await value(page);
		await page.locator("#plusTrigger").click();
		await page.locator(".control-option--goal").click();
		await page.route("**/api/v1/settings/skills", (route) => route.fulfill({ json: { skills: [{ id: "fixture-skill", name: "fixture-skill", enabled: true, description: "fixture" }] } }));
		await page.locator("#plusTrigger").click();
		await page.locator(".plus-row").nth(1).hover();
		await page.locator(".plus-sub-row").filter({ hasText: "fixture-skill" }).click();
		assert.equal(await page.locator(".pick-chip--skill").count(), 1);
		await pasteFile(page, "picture.png", "image/png");
		await page.waitForFunction(() => window.fixture.getState().attachments.length === 1);
		const original = await value(page);
		assert.ok(original.includes(rich));
		assert.equal(await page.locator(".prompt-mode").count(), 1);
		await open(page, "B");
		assert.equal(await value(page), "");
		assert.equal(await page.locator(".prompt-mode").count(), 0);
		assert.equal(await page.locator(".pick-chip--skill").count(), 0);
		assert.equal(await page.evaluate(() => window.fixture.getState().attachments.length), 0);
		await open(page, "A");
		assert.equal(await value(page), original);
		assert.equal(await page.locator(".prompt-mode").count(), 1);
		assert.equal(await page.locator(".pick-chip--skill").count(), 1);
		assert.equal(await page.evaluate(() => window.fixture.getState().attachments[0].name), "picture.png");
	} finally { await page.close(); }
});

test("uploading chips keep their live identity offscreen; waiting send never sends B", { skip }, async () => {
	const page = await pageFixture();
	try {
		await open(page, "A");
		await type(page, "reference ");
		const upload = await deferredRoute(page, "**/api/v1/uploads?*");
		await pasteFile(page, "notes.txt");
		await upload.ready;
		const sent = [];
		page.on("request", request => {
			if (request.method() === "POST" && /\/(messages|queue|steer)$/.test(new URL(request.url()).pathname)) sent.push({ target: request.url(), body: request.postDataJSON() });
		});
		await page.locator("#sendButton").click();
		await page.waitForFunction(() => window.fixture.composerDraft("session:A").sending);
		await open(page, "B");
		await type(page, "B is not sent");
		upload.release({ json: { id: "upload-A", path: "/fixture/notes.txt", name: "notes.txt", size: 7 } });
		await settledSend(page, "session:A");
		assert.deepEqual(sent, [], "navigation cancels waiting submission, including its original target");
		assert.equal(await value(page), "B is not sent");
		await open(page, "A");
		await page.waitForFunction(() => document.querySelector(".prompt-file")?.dataset.uploadId === "upload-A");
		assert.match(await value(page), /reference.*notes.txt/);
		assert.deepEqual(sent, []);
	} finally { await page.close(); }
});

test("failed offscreen uploads remove only their original chip", { skip }, async () => {
	const page = await pageFixture();
	try {
		await open(page, "A");
		await type(page, "A text ");
		const upload = await deferredRoute(page, "**/api/v1/uploads?*");
		await pasteFile(page, "bad.txt");
		await upload.ready;
		await open(page, "B");
		await type(page, "B text");
		upload.release({ status: 500, json: { error: "fixture rejected" } });
		await page.waitForFunction(() => !window.fixture.composerDraft("session:A").parked.querySelector(".prompt-file"));
		assert.equal(await value(page), "B text");
		await open(page, "A");
		assert.equal(await page.locator(".prompt-file").count(), 0);
		assert.match(await value(page), /^A text/);
	} finally { await page.close(); }
});

test("first-send adoption keeps input empty and does not restore the sent draft", { skip }, async () => {
	const page = await pageFixture();
	try {
		await newDraft(page);
		await type(page, "first send");
		const message = await deferredRoute(page, "**/api/v1/sessions/created/messages");
		await page.locator("#sendButton").click();
		const request = await message.ready;
		assert.equal(request.postDataJSON().text, "first send");
		assert.equal(await value(page), "");
		await type(page, "typed while sending");
		message.release({ json: { ok: true } });
		await settledSend(page, await page.evaluate(() => window.fixture.getState().composerDraftId));
		await open(page, "B");
		assert.equal(await value(page), "");
		await open(page, "created");
		assert.equal(await value(page), "typed while sending");
		await newDraft(page);
		assert.equal(await value(page), "");
	} finally { await page.close(); }
});

test("failed send restores only A's rich draft and images, not the active B input", { skip }, async () => {
	const page = await pageFixture();
	try {
		await open(page, "A");
		await type(page, "failed A");
		await page.locator("#plusTrigger").click();
		await page.locator(".control-option--plan").click();
		await pasteFile(page, "A.png", "image/png");
		await page.waitForFunction(() => window.fixture.getState().attachments.length === 1);
		const original = await value(page);
		const message = await deferredRoute(page, "**/api/v1/sessions/A/messages");
		await page.locator("#sendButton").click();
		await message.ready;
		await open(page, "B");
		await type(page, "B stays");
		message.release({ status: 500, json: { error: "fixture rejected send" } });
		await settledSend(page, "session:A");
		assert.equal(await value(page), "B stays");
		await page.keyboard.type(" continued");
		assert.equal(await value(page), "B stays continued", "offscreen restoration must not move B's caret");
		assert.equal(await page.evaluate(() => window.fixture.getState().attachments.length), 0);
		await open(page, "A");
		assert.equal(await value(page), original);
		assert.equal(await page.locator(".prompt-mode").getAttribute("data-mode"), "plan");
		assert.equal(await page.evaluate(() => window.fixture.getState().attachments[0].name), "A.png");
	} finally { await page.close(); }
});

test("late session creation sends to the created session without stealing B's selection", { skip }, async () => {
	const page = await pageFixture();
	try {
		await newDraft(page);
		await type(page, "belongs to created");
		const origin = await page.evaluate(() => window.fixture.getState().composerDraftId);
		const creation = await deferredRoute(page, "**/api/v1/sessions");
		const message = await deferredRoute(page, "**/api/v1/sessions/created/messages");
		await page.locator("#sendButton").click();
		await creation.ready;
		await open(page, "B");
		await type(page, "B stays selected");
		creation.release({ json: snapshot("created") });
		assert.equal((await message.ready).postDataJSON().text, "belongs to created");
		message.release({ json: { ok: true } });
		await settledSend(page, origin);
		assert.equal(await page.evaluate(() => window.fixture.getState().current.id), "B");
		assert.equal(await value(page), "B stays selected");
		await open(page, "created");
		assert.equal(await value(page), "");
	} finally { await page.close(); }
});

test("concurrent btw and first send share draft creation and never share private text with another session", { skip }, async () => {
	const page = await pageFixture();
	try {
		await newDraft(page);
		const origin = await page.evaluate(() => window.fixture.getState().composerDraftId);
		let creations = 0;
		let creationArrived;
		const ready = new Promise(resolve => { creationArrived = resolve; });
		let releaseCreation;
		const held = new Promise(resolve => { releaseCreation = resolve; });
		await page.route("**/api/v1/sessions", async route => {
			if (route.request().method() !== "POST") return route.fallback();
			creations++;
			const id = creations === 1 ? "created" : "duplicate";
			creationArrived();
			if (creations === 1) await held;
			await route.fulfill({ json: snapshot(id) });
		});
		const sent = [];
		page.on("request", request => {
			if (request.method() === "POST" && request.url().endsWith("/messages")) sent.push({ target: new URL(request.url()).pathname, text: request.postDataJSON().text });
		});
		await type(page, "/btw side question");
		await page.locator("#sendButton").click();
		await page.waitForFunction(() => !window.fixture.composerDraft(window.fixture.getState().composerDraftId).sending);
		await ready;
		await type(page, "first normal send");
		await page.locator("#sendButton").click();
		await page.waitForFunction((origin) => window.fixture.composerDraft(origin).sending || !!window.fixture.getState().current, origin);
		// The server accepts no first prompt until this creation response is released.
		releaseCreation();
		await settledSend(page, origin);
		await page.waitForFunction(() => window.fixture.getState().current?.id);
		assert.equal(creations, 1, "both Composer paths must await one draft-owned creation");
		assert.deepEqual(sent.map(item => item.target), ["/api/v1/sessions/created/messages", "/api/v1/sessions/created/messages"]);
		assert.deepEqual(sent.map(item => item.text).sort(), ["/btw side question", "first normal send"]);
		await type(page, "created private text");
		await open(page, "duplicate");
		assert.equal(await value(page), "");
		await type(page, "duplicate independent text");
		await open(page, "created");
		assert.equal(await value(page), "created private text");
		await open(page, "duplicate");
		assert.equal(await value(page), "duplicate independent text");
	} finally { await page.close(); }
});

test("opening eventual created session before creation response preserves independently typed target input", { skip }, async () => {
	const page = await pageFixture();
	try {
		await newDraft(page);
		await type(page, "first send");
		const origin = await page.evaluate(() => window.fixture.getState().composerDraftId);
		const creation = await deferredRoute(page, "**/api/v1/sessions");
		const message = await deferredRoute(page, "**/api/v1/sessions/created/messages");
		await page.locator("#sendButton").click();
		await creation.ready;
		await open(page, "created");
		await type(page, "independent target private text");
		await pasteFile(page, "target.png", "image/png");
		await page.waitForFunction(() => window.fixture.getState().attachments.length === 1);
		creation.release({ json: snapshot("created") });
		assert.equal((await message.ready).postDataJSON().text, "first send");
		message.release({ json: { ok: true } });
		await settledSend(page, origin);
		assert.equal(await value(page), "independent target private text");
		await open(page, "B");
		await open(page, "created");
		assert.equal(await value(page), "independent target private text");
		assert.equal(await page.evaluate(() => window.fixture.getState().attachments[0]?.name), "target.png");
	} finally { await page.close(); }
});

test("failed returned send refreshes open preview to exactly the recovered outgoing body without stealing focus", { skip }, async () => {
	const page = await pageFixture();
	try {
		await open(page, "A");
		await type(page, "original A");
		const message = await deferredRoute(page, "**/api/v1/sessions/A/messages");
		await page.locator("#sendButton").click();
		await message.ready;
		await open(page, "B");
		await open(page, "A");
		await type(page, "newer A");
		await page.locator("#prompt").press(process.platform === "darwin" ? "Meta+Shift+M" : "Control+Shift+M");
		await page.locator(".prompt-preview").waitFor({ state: "visible" });
		await page.locator("#plusTrigger").focus();
		message.release({ status: 500, json: { error: "fixture failed" } });
		await settledSend(page, "session:A");
		const recovered = await value(page);
		assert.ok(recovered.includes("original A") && recovered.includes("newer A"));
		assert.equal((await page.locator(".prompt-preview").innerText()).trim(), recovered.trim());
		assert.equal(await page.evaluate(() => document.activeElement?.id), "plusTrigger");
		await page.unroute("**/api/v1/sessions/A/messages");
		const retry = page.waitForRequest(request => request.method() === "POST" && request.url().endsWith("/A/messages"));
		await page.locator("#sendButton").click();
		assert.equal((await retry).postDataJSON().text, recovered.trim());
		await settledSend(page, "session:A");
	} finally { await page.close(); }
});

test("draft creation coalesces setup too, but a different new draft completes independently", { skip }, async () => {
	const page = await pageFixture();
	try {
		await page.route("**/api/v1/models?*", route => route.fulfill({ json: { models: [], availableThinkingLevels: ["high"] } }));
		await newDraft(page);
		await page.evaluate(() => window.fixture.setState({ draftThinking: "high" }));
		const origin = await page.evaluate(() => window.fixture.getState().composerDraftId);
		let creations = 0;
		await page.route("**/api/v1/sessions", route => {
			if (route.request().method() !== "POST") return route.fallback();
			return route.fulfill({ json: snapshot(++creations === 1 ? "created" : "independent") });
		});
		const setup = await deferredRoute(page, "**/api/v1/sessions/created/thinking");
		const sent = [];
		page.on("request", request => {
			if (request.method() === "POST" && request.url().endsWith("/messages")) sent.push({ target: new URL(request.url()).pathname, text: request.postDataJSON().text });
		});
		await type(page, "/btw setup side question");
		await page.locator("#sendButton").click();
		await setup.ready;
		await settledSend(page, origin);
		await type(page, "first normal send");
		await page.locator("#sendButton").click();
		await page.waitForFunction(origin => window.fixture.composerDraft(origin).sending, origin);
		await newDraft(page);
		await page.evaluate(() => window.fixture.setState({ draftThinking: "" }));
		const secondOrigin = await page.evaluate(() => window.fixture.getState().composerDraftId);
		await type(page, "independent first send");
		await page.locator("#sendButton").click();
		await settledSend(page, secondOrigin);
		assert.equal(await page.evaluate(() => window.fixture.getState().current?.id), "independent");
		assert.equal(creations, 2, "setup joiners cannot create a third session; other draft is not blocked");
		assert.deepEqual(sent, [{ target: "/api/v1/sessions/independent/messages", text: "independent first send" }]);
		await type(page, "independent private text");
		setup.release({ json: { ...snapshot("created"), thinkingLevel: "high" } });
		await settledSend(page, origin);
		assert.equal(await page.evaluate(() => window.fixture.getState().current?.id), "independent");
		assert.equal(await value(page), "independent private text");
		assert.deepEqual(sent.filter(item => item.target.includes("/created/")).map(item => item.text).sort(), ["/btw setup side question", "first normal send"]);
		await open(page, "created");
		assert.equal(await value(page), "");
		await open(page, "independent");
		assert.equal(await value(page), "independent private text");
	} finally { await page.close(); }
});

test("a rejected shared creation releases its pending work so the same input can retry", { skip }, async () => {
	const page = await pageFixture();
	try {
		await newDraft(page);
		const origin = await page.evaluate(() => window.fixture.getState().composerDraftId);
		const creation = await deferredRoute(page, "**/api/v1/sessions");
		await type(page, "/btw rejected side question");
		await page.locator("#sendButton").click();
		await creation.ready;
		await settledSend(page, origin);
		await type(page, "normal recovered send");
		await page.locator("#sendButton").click();
		await page.waitForFunction(origin => window.fixture.composerDraft(origin).sending, origin);
		creation.release({ status: 500, json: { error: "shared creation rejected" } });
		await settledSend(page, origin);
		assert.equal(await value(page), "normal recovered send");
		await page.unroute("**/api/v1/sessions");
		const retry = page.waitForRequest(request => request.method() === "POST" && request.url().endsWith("/created/messages"));
		await page.locator("#sendButton").click();
		assert.equal((await retry).postDataJSON().text, "normal recovered send");
		await settledSend(page, origin);
		await open(page, "B");
		await open(page, "created");
		assert.equal(await value(page), "");
	} finally { await page.close(); }
});

test("failed setup releases an abandoned input after successful session creation", { skip }, async () => {
	const page = await pageFixture();
	try {
		await page.route("**/api/v1/models?*", route => route.fulfill({ json: { models: [], availableThinkingLevels: ["high"] } }));
		await newDraft(page);
		await page.evaluate(() => window.fixture.setState({ draftThinking: "high" }));
		await type(page, "private setup draft");
		await pasteFile(page, "setup.png", "image/png");
		await page.waitForFunction(() => window.fixture.getState().attachments.length === 1);
		await page.evaluate(() => {
			window.failedSetupId = window.fixture.getState().composerDraftId;
			window.failedSetupDraft = window.fixture.composerDraft(window.failedSetupId);
		});
		const setup = await deferredRoute(page, "**/api/v1/sessions/created/thinking");
		await page.locator("#sendButton").click();
		await setup.ready;
		await newDraft(page);
		setup.release({ status: 500, json: { error: "setup rejected" } });
		await page.waitForFunction(() => !window.failedSetupDraft.sending);
		assert.equal(await page.evaluate(() => window.fixture.composerDraft(window.failedSetupId) === window.failedSetupDraft), false);
		assert.equal(await page.evaluate(() => window.failedSetupDraft.parked.childNodes.length), 0);
		assert.deepEqual(await page.evaluate(() => window.fixture.composerDraftPatch(window.failedSetupId).attachments), []);
		assert.equal(await value(page), "");
	} finally { await page.close(); }
});

test("retry after setup rejection adopts the original input only into the successful session", { skip }, async () => {
	const page = await pageFixture();
	try {
		await page.route("**/api/v1/models?*", route => route.fulfill({ json: { models: [], availableThinkingLevels: ["high"] } }));
		await newDraft(page);
		await page.evaluate(() => window.fixture.setState({ draftThinking: "high" }));
		const origin = await page.evaluate(() => window.fixture.getState().composerDraftId);
		let creations = 0;
		await page.route("**/api/v1/sessions", route => {
			if (route.request().method() !== "POST") return route.fallback();
			return route.fulfill({ json: snapshot(++creations === 1 ? "failed-setup" : "retry-created") });
		});
		const setup = await deferredRoute(page, "**/api/v1/sessions/failed-setup/thinking");
		await type(page, "retry original text");
		await pasteFile(page, "retry.png", "image/png");
		await page.waitForFunction(() => window.fixture.getState().attachments.length === 1);
		await page.locator("#sendButton").click();
		await setup.ready;
		setup.release({ status: 500, json: { error: "setup rejected" } });
		await settledSend(page, origin);
		assert.equal(await value(page), "retry original text");
		await page.route("**/api/v1/sessions/retry-created/thinking", route => route.fulfill({ json: { ...snapshot("retry-created"), thinkingLevel: "high" } }));
		const retry = page.waitForRequest(request => request.method() === "POST" && request.url().endsWith("/retry-created/messages"));
		await page.locator("#sendButton").click();
		const body = (await retry).postDataJSON();
		assert.equal(body.text, "retry original text");
		assert.equal(body.attachments[0]?.name, "retry.png");
		await settledSend(page, origin);
		assert.equal(await page.evaluate(() => window.fixture.getState().composerDraftId), origin);
		await type(page, "successful session private text");
		await open(page, "failed-setup");
		assert.equal(await value(page), "");
		await open(page, "retry-created");
		assert.equal(await value(page), "successful session private text");
	} finally { await page.close(); }
});

test("late context picks update their original draft, not B's staged input", { skip }, async () => {
	const page = await pageFixture();
	try {
		await open(page, "A");
		await type(page, "A context");
		await page.evaluate(() => window.fixture.setState({ sessions: [{ id: "quoted", name: "Quoted context", cwd: "/fixture" }] }));
		const context = await deferredRoute(page, "**/api/v1/sessions/quoted");
		await page.locator("#plusTrigger").click();
		await page.locator(".plus-row").nth(2).hover();
		await page.locator(".plus-sub-row").filter({ hasText: "Quoted context" }).click();
		await context.ready;
		await open(page, "B");
		await type(page, "B context");
		context.release({ json: { ...snapshot("quoted"), name: "Quoted context" } });
		await page.waitForFunction(() => window.fixture.composerDraft("session:A").contextPackages.length === 1);
		assert.equal(await value(page), "B context");
		assert.equal(await page.locator(".context-chip").count(), 0);
		await open(page, "A");
		assert.equal(await value(page), "A context");
		assert.equal(await page.locator(".context-chip").count(), 1);
	} finally { await page.close(); }
});

test("delayed image reads belong to A even when B is active", { skip }, async () => {
	const page = await pageFixture();
	try {
		await open(page, "A");
		await page.evaluate(() => {
			window.releaseImage = [];
			const Original = FileReader;
			window.FileReader = class extends Original {
				readAsDataURL(file) {
					const callback = this.onload;
					this.onload = (event) => window.releaseImage.push(() => callback.call(this, event));
					super.readAsDataURL(file);
				}
			};
		});
		await pasteFile(page, "delayed.png", "image/png");
		await page.waitForFunction(() => window.releaseImage.length === 1);
		await open(page, "B");
		await type(page, "B input");
		await page.evaluate(() => window.releaseImage[0]());
		await page.waitForFunction(() => window.fixture.composerDraftPatch("session:A").attachments.length === 1);
		assert.equal(await value(page), "B input");
		assert.equal(await page.evaluate(() => window.fixture.getState().attachments.length), 0);
		await open(page, "A");
		assert.equal(await page.evaluate(() => window.fixture.getState().attachments[0].name), "delayed.png");
	} finally { await page.close(); }
});

test("inline rewriting does not read or mutate the main draft or its mode", { skip }, async () => {
	const page = await pageFixture();
	try {
		await open(page, "A");
		await type(page, "main draft");
		await page.locator("#plusTrigger").click();
		await page.locator(".control-option--goal").click();
		const original = await value(page);
		await page.evaluate(() => window.fixture.setUi({ editingPrompt: { entryId: "entry", before: "entry", text: "old message" } }));
		await page.locator("#editPrompt").waitFor();
		assert.equal(await page.locator("#editPrompt").textContent(), "old message");
		await page.locator("#editPrompt").focus();
		await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
		await page.keyboard.type("/plan rewrite only");
		assert.equal(await value(page), original);
		assert.deepEqual(await page.evaluate(() => window.fixture.getState().modes), { goal: true, plan: false, ultraloop: false });
		await page.evaluate(() => window.fixture.setUi({ editingPrompt: null }));
		await open(page, "B");
		assert.equal(await value(page), "");
		await open(page, "A");
		assert.equal(await value(page), original);
	} finally { await page.close(); }
});

test("switching running conversations recomputes stop versus send from that draft", { skip }, async () => {
	const page = await pageFixture();
	try {
		await page.route("**/api/v1/sessions/*", (route) => {
			const id = new URL(route.request().url()).pathname.split("/").at(-1);
			return route.fulfill({ json: { ...snapshot(id), status: "running" } });
		});
		await open(page, "A");
		assert.equal(await page.locator("#stopRun").count(), 1);
		await type(page, "queued A");
		assert.equal(await page.locator("#sendButton").count(), 1);
		await open(page, "B");
		assert.equal(await value(page), "");
		assert.equal(await page.locator("#stopRun").count(), 1);
		await open(page, "A");
		assert.equal(await value(page), "queued A");
		assert.equal(await page.locator("#sendButton").count(), 1);
	} finally { await page.close(); }
});

test("a late inline rewrite fork cannot send or consume another conversation's draft", { skip }, async () => {
	const page = await pageFixture();
	try {
		await open(page, "A");
		await type(page, "main A stays");
		await page.evaluate(() => window.fixture.setUi({ editingPrompt: { entryId: "entry", before: "entry", text: "rewritten A" } }));
		await page.locator("#editPrompt").waitFor();
		const fork = await deferredRoute(page, "**/api/v1/sessions/A/fork");
		const message = await deferredRoute(page, "**/api/v1/sessions/forked/messages");
		await page.locator("#editComposer #sendButton").click();
		await fork.ready;
		await page.evaluate(() => window.fixture.setUi({ editingPrompt: null }));
		await open(page, "B");
		await type(page, "B stays");
		await pasteFile(page, "B.png", "image/png");
		await page.waitForFunction(() => window.fixture.getState().attachments.length === 1);
		fork.release({ json: { sessionId: "forked" } });
		const body = (await message.ready).postDataJSON();
		assert.equal(body.text, "rewritten A");
		assert.deepEqual(body.attachments, []);
		const answered = page.waitForResponse(response => response.url().endsWith("/forked/messages"));
		message.release({ json: { ok: true } });
		await answered;
		assert.equal(await value(page), "B stays");
		assert.equal(await page.evaluate(() => window.fixture.getState().current.id), "B");
		assert.equal(await page.evaluate(() => window.fixture.getState().attachments[0].name), "B.png");
		await open(page, "A");
		assert.equal(await value(page), "main A stays");
	} finally { await page.close(); }
});

test("a failed send after returning to A keeps newer typing and only the newer staged mode", { skip }, async () => {
	const page = await pageFixture();
	try {
		await open(page, "A");
		await type(page, "original A");
		await page.locator("#plusTrigger").click();
		await page.locator(".control-option--plan").click();
		const message = await deferredRoute(page, "**/api/v1/sessions/A/messages");
		await page.locator("#sendButton").click();
		await message.ready;
		await open(page, "B");
		await open(page, "A");
		await page.locator("#plusTrigger").click();
		await page.locator(".control-option--goal").click();
		await type(page, "newer A");
		message.release({ status: 500, json: { error: "fixture rejected send" } });
		await settledSend(page, "session:A");
		assert.equal(await page.locator(".prompt-mode").count(), 1);
		assert.equal(await page.locator(".prompt-mode").getAttribute("data-mode"), "goal");
		assert.match(await value(page), /^\/goal .*original A.*newer A/);
		assert.equal(await page.locator("#sendButton").count(), 1);
	} finally { await page.close(); }
});

test("returned running A refreshes stop after its only upload fails", { skip }, async () => {
	const page = await pageFixture();
	try {
		await page.route("**/api/v1/sessions/A", route => route.fulfill({ json: { ...snapshot("A"), status: "running" } }));
		await open(page, "A");
		const upload = await deferredRoute(page, "**/api/v1/uploads?*");
		await pasteFile(page, "bad.txt");
		await upload.ready;
		await open(page, "B");
		await open(page, "A");
		assert.equal(await page.locator("#sendButton").count(), 1);
		upload.release({ status: 500, json: { error: "fixture rejected" } });
		await page.waitForFunction(() => !document.querySelector(".prompt-file"));
		assert.equal(await page.locator("#stopRun").count(), 1);
	} finally { await page.close(); }
});

test("rewrite image MIME is explicit even if its fork is independently selected", { skip }, async () => {
	const page = await pageFixture();
	try {
		await open(page, "A");
		await page.evaluate(() => window.fixture.setUi({ editingPrompt: { entryId: "entry", text: "rewrite image" } }));
		await page.locator("#editPrompt").waitFor();
		await pasteFile(page, "rewrite.png", "image/png", "#editPrompt");
		// Let either the old binary chip or the intended image reader settle before submitting.
		await page.waitForFunction(() => document.querySelector("#editComposer .attachment-chip") || document.querySelector("#editPrompt .prompt-file[data-state=ready]"));
		const fork = await deferredRoute(page, "**/api/v1/sessions/A/fork");
		const message = await deferredRoute(page, "**/api/v1/sessions/forked/messages");
		await page.locator("#editComposer #sendButton").click();
		await fork.ready;
		await open(page, "forked");
		await type(page, "fork main stays");
		await pasteFile(page, "main.png", "image/png");
		await page.waitForFunction(() => window.fixture.getState().attachments.length === 1);
		fork.release({ json: { sessionId: "forked" } });
		const body = (await message.ready).postDataJSON();
		assert.equal(body.attachments.length, 1);
		assert.equal(body.attachments[0].name, "rewrite.png");
		assert.equal(body.attachments[0].mimeType, "image/png");
		assert.equal(body.attachments[0].kind, "image");
		assert.deepEqual(body.files, []);
		assert.equal(await page.evaluate(() => window.fixture.getState().attachments[0]?.name), "main.png");
		message.release({ json: { ok: true } });
		assert.equal(await value(page), "fork main stays");
	} finally { await page.close(); }
});

test("abandoned unsaved drafts release rich nodes and images after pending uploads settle", { skip }, async () => {
	const page = await pageFixture();
	try {
		await newDraft(page);
		await type(page, "abandoned rich draft");
		await pasteFile(page, "abandoned.png", "image/png");
		await page.waitForFunction(() => window.fixture.getState().attachments.length === 1);
		await page.evaluate(() => {
			window.abandonedId = window.fixture.getState().composerDraftId;
			window.abandonedDraft = window.fixture.composerDraft(window.abandonedId);
		});
		const upload = await deferredRoute(page, "**/api/v1/uploads?*");
		await pasteFile(page, "pending.txt");
		await upload.ready;
		await newDraft(page);
		assert.equal(await page.evaluate(() => window.fixture.composerDraft(window.abandonedId) === window.abandonedDraft), true, "pending work keeps its owner");
		upload.release({ status: 500, json: { error: "abandoned upload settled" } });
		await page.waitForFunction(() => window.fixture.getState().toast?.message === "abandoned upload settled" || window.fixture.getState().toast?.message?.includes("abandoned upload settled"));
		assert.equal(await page.evaluate(() => window.fixture.composerDraft(window.abandonedId) === window.abandonedDraft), false, "unreachable draft cache is released");
		assert.deepEqual(await page.evaluate(() => window.fixture.composerDraftPatch(window.abandonedId).attachments), []);
		assert.equal(await page.evaluate(() => window.abandonedDraft.parked.childNodes.length), 0);
	} finally { await page.close(); }
});

test("replacing an unsaved draft without pending work releases both caches", { skip }, async () => {
	const page = await pageFixture();
	try {
		await newDraft(page);
		await type(page, "discarded");
		await pasteFile(page, "discarded.png", "image/png");
		await page.waitForFunction(() => window.fixture.getState().attachments.length === 1);
		await page.evaluate(() => {
			window.abandonedId = window.fixture.getState().composerDraftId;
			window.abandonedDraft = window.fixture.composerDraft(window.abandonedId);
		});
		await newDraft(page);
		assert.equal(await page.evaluate(() => window.fixture.composerDraft(window.abandonedId) === window.abandonedDraft), false);
		assert.deepEqual(await page.evaluate(() => window.fixture.composerDraftPatch(window.abandonedId).attachments), []);
		assert.equal(await page.evaluate(() => window.abandonedDraft.parked.childNodes.length), 0);
	} finally { await page.close(); }
});

test("failed late creation releases an unreachable input instead of retaining recovery forever", { skip }, async () => {
	const page = await pageFixture();
	try {
		await newDraft(page);
		await type(page, "failed creation");
		await page.evaluate(() => {
			window.abandonedId = window.fixture.getState().composerDraftId;
			window.abandonedDraft = window.fixture.composerDraft(window.abandonedId);
		});
		const creation = await deferredRoute(page, "**/api/v1/sessions");
		await page.locator("#sendButton").click();
		await creation.ready;
		await open(page, "B");
		assert.equal(await page.evaluate(() => window.fixture.composerDraft(window.abandonedId) === window.abandonedDraft), true);
		creation.release({ status: 500, json: { error: "creation rejected" } });
		await page.waitForFunction(() => !window.abandonedDraft.sending);
		assert.equal(await page.evaluate(() => window.fixture.composerDraft(window.abandonedId) === window.abandonedDraft), false);
		assert.equal(await page.evaluate(() => window.abandonedDraft.parked.childNodes.length), 0);
		assert.equal(await value(page), "");
	} finally { await page.close(); }
});

test("real transcript keeps failed inline rewrite reachable until submission succeeds", { skip }, async () => {
	const page = await pageFixture();
	try {
		await open(page, "A");
		await page.evaluate(() => window.fixture.setUi({ editingPrompt: { entryId: "entry", text: "recover rewrite" } }));
		await page.locator("#stream #editPrompt").waitFor();
		await pasteFile(page, "recover.png", "image/png", "#editPrompt");
		await page.waitForFunction(() => document.querySelector("#editComposer .attachment-chip--image"));
		await page.route("**/api/v1/sessions/A/fork", route => route.fulfill({ json: { sessionId: "forked" } }));
		const message = await deferredRoute(page, "**/api/v1/sessions/forked/messages");
		await page.locator("#editComposer #sendButton").click();
		await message.ready;
		message.release({ status: 500, json: { error: "rewrite rejected" } });
		await page.waitForFunction(() => window.fixture.getState().toast?.message === "rewrite rejected");
		assert.equal(await page.locator("#stream #editPrompt").count(), 1);
		assert.equal(await page.locator("#editPrompt").textContent(), "recover rewrite");
		assert.equal(await page.locator("#editComposer .attachment-chip--image").count(), 1);
		assert.equal(await page.evaluate(() => window.fixture.getState().current.id), "A");
		let retryBody;
		await page.route("**/api/v1/sessions/forked/messages", route => {
			retryBody = route.request().postDataJSON();
			return route.fulfill({ json: { ok: true } });
		});
		await page.locator("#editComposer #sendButton").click();
		await page.waitForFunction(() => window.fixture.getState().current?.id === "forked" && !document.querySelector("#editPrompt"));
		assert.equal(retryBody.text, "recover rewrite");
		assert.equal(retryBody.attachments[0].name, "recover.png");
	} finally { await page.close(); }
});
