/** Real Chrome regressions for @ completion's cursor, uploads, IME and request lifecycle, with a local client fixture. */
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
const fixtureId = join(webRoot, "client", "file-completion-fixture.tsx").replaceAll("\\", "/");
const chromePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium",
	"C:/Program Files/Google/Chrome/Application/chrome.exe"].find((path) => path && existsSync(path));
const skip = chromePath ? false : "No installed Chrome; set CHROME_PATH";
const fixture = `
import React from "react";
import {createRoot} from "react-dom/client";
import "/src/styles/global.css";
import {IconSprite} from "/src/ui";
import {Composer} from "/src/features/composer/index.tsx";
import {ShellEffects} from "/src/features/shell/ShellEffects.tsx";
import {createInitialState, getState, setState, setUi} from "/src/state/store.ts";
import {promptFileQuery, promptFiles, promptMessageText, promptText, replaceFileQuery} from "/src/features/composer/prompt-editor.ts";
import {fileCompletionText} from "/src/features/composer/file-completion.ts";
setState({...createInitialState(),bootstrapCwd:"/fixture",draftCwd:"/fixture",locale:"en-US"});
window.fixture = {getState, setState, setUi, promptFileQuery, promptFiles, promptMessageText, promptText, replaceFileQuery, fileCompletionText};
createRoot(document.getElementById("root")).render(<><IconSprite/><ShellEffects/><div className="composer-zone"><Composer/></div></>);
`;
let vite;
let browser;
let url;
before(async () => {
	if (skip) return;
	vite = await createServer({
		configFile: join(webRoot, "vite.config.ts"), root: join(webRoot, "client"),
		server: { host: "127.0.0.1", port: 0, proxy: {} },
		plugins: [{
			name: "file-completion-regression",
			resolveId(id) { if (id === "/file-completion-fixture.js" || id === fixtureId) return fixtureId; },
			load(id) { if (id === fixtureId) return fixture; },
			configureServer(server) {
				server.middlewares.use((req, res, next) => {
					if (req.url !== "/file-completion-fixture") return next();
					res.setHeader("Content-Type", "text/html");
					res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>#root{display:flex;align-items:flex-end;height:100vh;width:100%;} .composer-zone{width:100%;}</style></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/file-completion-fixture.js"></script></body></html>`);
				});
			},
		}],
	});
	await vite.listen();
	url = `http://127.0.0.1:${vite.httpServer.address().port}/file-completion-fixture`;
	browser = await chromium.launch({ executablePath: chromePath, headless: true });
});
after(async () => { await browser?.close(); await vite?.close(); });

const rootEntries = [
	{ name: "apps", path: "apps", kind: "directory" },
	{ name: "notes space", path: "notes space", kind: "directory" },
	{ name: "README.md", path: "README.md", kind: "file" },
];
const byQuery = (query) => query === "apps/" ? [
	{ name: "dev-docs", path: "apps/dev-docs", kind: "directory" },
	{ name: "zcode-cli", path: "apps/zcode-cli", kind: "directory" },
] : query === "apps/dev-docs/" ? [{ name: "guide.md", path: "apps/dev-docs/guide.md", kind: "file" }]
	: query === "notes space/" ? [{ name: "中文 note.md", path: "notes space/中文 note.md", kind: "file" }]
	: query.startsWith("apps/") ? [{ name: "main.ts", path: "apps/main.ts", kind: "file" }]
	: rootEntries;

async function pageFixture(options = {}) {
	const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
	await page.route("**/api/**", async (route) => {
		const path = new URL(route.request().url());
		if (path.pathname.endsWith("/completions")) {
			const query = path.searchParams.get("q");
			if (options.completions) return options.completions(route, query);
			return route.fulfill({ json: { entries: byQuery(query), truncated: false } });
		}
		if (path.pathname.endsWith("/uploads")) return route.fulfill({ json: {
			id: "uploaded-fixture", path: "/tmp/upload/attachment.txt", name: "attachment.txt", size: 10,
		} });
		return route.fulfill({ json: { models: [], skills: [], servers: [] } });
	});
	await page.goto(url);
	await page.waitForFunction(() => window.fixture && document.querySelector("#prompt"));
	return page;
}

async function setPrompt(page, text, caret = text.length) {
	await page.evaluate(({ text, caret }) => {
		const editor = document.querySelector("#prompt");
		editor.replaceChildren(document.createTextNode(text));
		editor.focus();
		const range = document.createRange();
		range.setStart(editor.firstChild, caret);
		range.collapse(true);
		getSelection().removeAllRanges();
		getSelection().addRange(range);
		editor.dispatchEvent(new Event("input", { bubbles: true }));
	}, { text, caret });
}
const rows = (page) => page.locator("#fileCompletionList [role=option]");
async function ready(page, path) {
	try {
		await page.waitForFunction((path) => !document.querySelector("#fileCompletionMenu").hidden &&
			document.querySelector("#fileCompletionList").getAttribute("aria-busy") === "false" &&
			[...document.querySelectorAll("#fileCompletionList [role=option]")].some((row) => row.dataset.path === path), path);
	} catch (error) {
		console.error("Completion failure", path, await page.evaluate(() => ({
			text: window.fixture.promptText(document.querySelector("#prompt")),
			query: window.fixture.promptFileQuery(document.querySelector("#prompt")),
			open: window.fixture.getState().ui.fileCompletionOpen,
			menu: document.querySelector("#fileCompletionMenu").textContent,
			selected: document.querySelector('#fileCompletionList [aria-selected="true"]')?.dataset.path,
		})));
		throw error;
	}
}
const promptValue = (page) => page.evaluate(() => window.fixture.promptText(document.querySelector("#prompt")));
const sentValue = (page) => page.evaluate(() => window.fixture.promptMessageText(document.querySelector("#prompt")).trim());

test("@ opens file rows, arrows select, Tab/chevron drill, and Enter settles without submitting", { skip }, async () => {
	const page = await pageFixture();
	let sends = 0;
	page.on("request", (request) => { if (request.method() === "POST" && !request.url().includes("uploads")) sends += 1; });
	try {
		await setPrompt(page, "@");
		await ready(page, "apps");
		assert.equal(await rows(page).count(), 3);
		await page.keyboard.press("ArrowDown");
		assert.equal(await page.locator('[data-path="notes space"]').getAttribute("aria-selected"), "true");
		await page.keyboard.press("ArrowUp");
		await page.keyboard.press("Tab");
		await ready(page, "apps/dev-docs");
		assert.equal(await promptValue(page), "@apps/");
		await page.locator('[data-path="apps/dev-docs"] .file-completion-drill').click();
		await ready(page, "apps/dev-docs/guide.md");
		assert.equal(await promptValue(page), "@apps/dev-docs/");
		assert.equal(await page.evaluate(() => document.activeElement.id), "prompt");
		await page.keyboard.press("Enter");
		await page.waitForFunction(() => document.querySelector("#fileCompletionMenu").hidden);
		assert.equal(await promptValue(page), "@apps/dev-docs/guide.md ");
		assert.equal(sends, 0);
	} finally { await page.close(); }
});

test("quoted directory picks close quotes; Tab keeps the caret inside quotes for spaced/Chinese paths", { skip }, async () => {
	const page = await pageFixture();
	try {
		await setPrompt(page, "@");
		await ready(page, "notes space");
		await page.locator('[data-path="notes space"] .file-completion-name').click();
		assert.equal(await promptValue(page), '@"notes space/" ');
		await page.waitForFunction(() => document.querySelector("#fileCompletionMenu").hidden);
		await page.mouse.move(0, 0);
		await setPrompt(page, "@");
		await ready(page, "notes space");
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("Tab");
		await ready(page, "notes space/中文 note.md");
		assert.equal(await promptValue(page), '@"notes space/"');
		assert.equal(await page.evaluate(() => window.fixture.promptFileQuery(document.querySelector("#prompt")).query), "notes space/");
		await page.keyboard.press("Enter");
		assert.equal(await promptValue(page), '@"notes space/中文 note.md" ');
	} finally { await page.close(); }
});

test("cursor-middle replacement preserves prose, inline uploads and browser undo", { skip }, async () => {
	const page = await pageFixture();
	try {
		const text = "🙂 before @apps/maXXX after";
		await setPrompt(page, text, text.indexOf("maXXX") + 2);
		await ready(page, "apps/main.ts");
		await page.keyboard.press("Enter");
		assert.equal(await promptValue(page), "🙂 before @apps/main.ts after");
		await page.keyboard.insertText("more ");
		assert.equal(await promptValue(page), "🙂 before @apps/main.ts more after");

		await setPrompt(page, "before ");
		await page.evaluate(() => {
			const transfer = new DataTransfer();
			transfer.items.add(new File(["attachment"], "attachment.txt", { type: "text/plain" }));
			document.querySelector("#prompt").dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
		});
		await page.waitForFunction(() => document.querySelector("#prompt .prompt-file")?.dataset.state === "ready");
		await page.keyboard.insertText("@apps/ma");
		await ready(page, "apps/main.ts");
		await page.keyboard.press("Enter");
		const report = await page.evaluate(() => {
			const editor = document.querySelector("#prompt");
			return { text: window.fixture.promptText(editor), files: window.fixture.promptFiles(editor), chips: editor.querySelectorAll(".prompt-file").length };
		});
		assert.equal(report.text, "before attachment.txt @apps/main.ts ");
		assert.equal(report.chips, 1);
		assert.equal(report.files[0].id, "uploaded-fixture");
		await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
		await page.waitForFunction(() => window.fixture.promptText(document.querySelector("#prompt")).includes("@apps/ma") &&
			!window.fixture.promptText(document.querySelector("#prompt")).includes("@apps/main.ts"));
		assert.equal(await page.locator("#prompt .prompt-file").count(), 1);
	} finally { await page.close(); }
});

test("range mapping supports split text nodes and multiline blocks; changed suffixes reject stale picks", { skip }, async () => {
	const page = await pageFixture();
	try {
		const report = await page.evaluate(() => {
			const editor = document.querySelector("#prompt");
			editor.replaceChildren();
			const first = document.createElement("div"); first.textContent = "first line";
			const second = document.createElement("div");
			const prefix = document.createTextNode("read @apps/");
			const rest = document.createTextNode("maXXX after");
			second.append(prefix, rest); editor.append(first, second); editor.focus();
			const range = document.createRange(); range.setStart(rest, 2); range.collapse(true);
			getSelection().removeAllRanges(); getSelection().addRange(range);
			const expected = window.fixture.promptFileQuery(editor);
			const picked = window.fixture.replaceFileQuery(editor, expected,
				window.fixture.fileCompletionText({ name: "main.ts", path: "apps/main.ts", kind: "file" }, false, false));
			const text = window.fixture.promptText(editor);
			return { picked, text };
		});
		assert.deepEqual(report, { picked: true, text: "first line\nread @apps/main.ts after" });
		await setPrompt(page, "@apps/maXXX after", 8);
		const rejected = await page.evaluate(() => {
			const editor = document.querySelector("#prompt");
			const expected = window.fixture.promptFileQuery(editor);
			editor.firstChild.data = "@apps/maYYY after";
			return window.fixture.replaceFileQuery(editor, expected, { text: "@apps/main.ts ", cursor: 14 });
		});
		assert.equal(rejected, false);
	} finally { await page.close(); }
});

test("pending/replaced requests cannot submit or overwrite newer queries, and dismissal is sticky", { skip }, async () => {
	let release;
	let started;
	const first = new Promise((resolve) => { started = resolve; });
	const gate = new Promise((resolve) => { release = resolve; });
	const page = await pageFixture({ completions: async (route, query) => {
		if (query === "slow") { started(); await gate; }
		await route.fulfill({ json: { entries: [{ name: `${query}.txt`, path: `${query}.txt`, kind: "file" }], truncated: false } }).catch(() => {});
	} });
	let sends = 0;
	page.on("request", (request) => { if (request.method() === "POST") sends += 1; });
	try {
		await setPrompt(page, "@slow");
		await first;
		await page.keyboard.press("Enter");
		assert.equal(await promptValue(page), "@slow");
		assert.equal(sends, 0);
		await setPrompt(page, "@new");
		await ready(page, "new.txt");
		release();
		await page.waitForFunction(() => document.querySelector('#fileCompletionList [data-path="new.txt"]'));
		assert.equal(await page.locator('[data-path="slow.txt"]').count(), 0);
		await page.keyboard.press("Escape");
		await page.waitForFunction(() => document.querySelector("#fileCompletionMenu").hidden);
		await page.locator("#sendButton").focus();
		await page.locator("#prompt").focus();
		assert.equal(await page.locator("#fileCompletionMenu").isVisible(), false);
		await page.keyboard.insertText("er");
		await ready(page, "newer.txt");
		await page.keyboard.press("ArrowLeft");
		await ready(page, "newe.txt");
		await page.evaluate(() => window.fixture.setState({ draftCwd: "/second" }));
		await page.waitForFunction(() => document.querySelector("#fileCompletionMenu").hidden);
		assert.equal(sends, 0);
	} finally { release(); await page.close(); }
});

test("IME Enter never picks/sends, Shift+Enter keeps newlines, and mail text has no @ menu", { skip }, async () => {
	const page = await pageFixture();
	try {
		await setPrompt(page, "@apps/");
		await ready(page, "apps/dev-docs");
		await page.evaluate(() => {
			const editor = document.querySelector("#prompt");
			editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
			editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }));
		});
		assert.equal(await promptValue(page), "@apps/");
		await page.waitForFunction(() => document.querySelector("#fileCompletionMenu").hidden);
		await page.evaluate(() => {
			const editor = document.querySelector("#prompt");
			editor.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
			editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true, cancelable: true }));
		});
		await ready(page, "apps/dev-docs");
		assert.equal(await promptValue(page), "@apps/");
		await page.keyboard.press("Shift+Enter");
		await page.waitForFunction(() => document.querySelector("#fileCompletionMenu").hidden);
		assert.match(await promptValue(page), /\n/);
		await setPrompt(page, "mail user@example.com");
		assert.equal(await page.locator("#fileCompletionMenu").isVisible(), false);
		await setPrompt(page, "/plan");
		await page.waitForFunction(() => !document.querySelector("#slashMenu").hidden);
		await page.keyboard.press("Enter");
		assert.equal(await promptValue(page), "/plan ");
		// A `/word` typed after other text opens the menu too; the pick moves to the
		// front as the lead chip and the text typed before it stays as its arguments.
		await setPrompt(page, "fix /pl");
		await page.waitForFunction(() => !document.querySelector("#slashMenu").hidden);
		await page.keyboard.press("Enter");
		assert.equal(await promptValue(page), "/plan fix ");
		await setPrompt(page, "and/or");
		assert.equal(await page.locator("#slashMenu").isVisible(), false);
		// Picked from the menu at the very start, a plain command and a skill
		// lead exactly as before: one chip, sent unchanged.
		await setPrompt(page, "/in");
		await page.waitForFunction(() => !document.querySelector("#slashMenu").hidden);
		await page.keyboard.press("Enter");
		assert.equal(await promptValue(page), "/init ");
		assert.equal(await sentValue(page), "/init");
		assert.equal(await page.locator("#prompt .prompt-command").count(), 1);
		await page.keyboard.type("go");
		assert.equal(await sentValue(page), "/init go");
		// A plain command picked mid-text stays where it was typed; the message
		// sends it first, where the kernel runs it, with the words as arguments.
		await setPrompt(page, "111 /in");
		await page.waitForFunction(() => !document.querySelector("#slashMenu").hidden);
		await page.keyboard.press("Enter");
		assert.equal(await promptValue(page), "111 /init ");
		assert.equal(await sentValue(page), "/init 111");
		await page.keyboard.type("x");
		assert.equal(await promptValue(page), "111 /init x");
		assert.equal(await sentValue(page), "/init 111 x");
		// With a command already leading, a second pick stays where it was typed:
		// only the first command runs, so moving it would just reorder the words.
		await setPrompt(page, "");
		await page.keyboard.type("/compact ");
		await page.waitForFunction(() => document.querySelector("#prompt .prompt-command"));
		await page.keyboard.type("和 /in");
		await page.waitForFunction(() => !document.querySelector("#slashMenu").hidden);
		await page.keyboard.press("Enter");
		assert.equal(await promptValue(page), "/compact 和 /init ");
		// A command already leads: the message is sent as typed.
		assert.equal(await sentValue(page), "/compact 和 /init");
		assert.equal(await page.locator("#prompt .prompt-command").count(), 2);
		// Typing continues right after the chip that was placed.
		await page.keyboard.type("x");
		assert.equal(await promptValue(page), "/compact 和 /init x");
	} finally { await page.close(); }
});

test("file menu shows explicit errors/empty/partial results and fits light, dark and narrow views", { skip }, async () => {
	const page = await pageFixture({ completions: async (route, query) => {
		if (query === "error") return route.fulfill({ status: 400, json: { error: "Path is outside the workspace" } });
		return route.fulfill({ json: { entries: query === "none" ? [] : byQuery(query), truncated: query === "many" } });
	} });
	try {
		await setPrompt(page, "@error");
		await page.getByText("Could not find files: Path is outside the workspace", { exact: true }).waitFor();
		await setPrompt(page, "@none");
		await page.getByText("No matching files or folders", { exact: true }).waitFor();
		await setPrompt(page, "@many");
		await page.getByText("Only partial results are shown. Type a more specific path.", { exact: true }).waitFor();
		const screenshots = process.env.STEPCODE_WEB_QA_DIR || join(tmpdir(), "stepcode-file-completion-qa");
		await mkdir(screenshots, { recursive: true });
		for (const [width, theme] of [[1200, "light"], [1200, "dark"], [390, "light"], [320, "dark"]]) {
			await page.setViewportSize({ width, height: 900 });
			await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
			await setPrompt(page, "@apps/");
			await ready(page, "apps/dev-docs");
			const overflow = await page.evaluate(() => [...document.querySelectorAll("body *")].filter((el) => {
				const box = el.getBoundingClientRect(); return box.width && (box.right > innerWidth + 1 || box.left < -1);
			}).map((el) => ({ tag: el.tagName, id: el.id, className: String(el.className), width: el.getBoundingClientRect().width })));
			assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, JSON.stringify({ width, overflow, metrics: await page.evaluate(() => ({
				viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth,
				root: document.querySelector("#root").scrollWidth, zone: document.querySelector(".composer-zone").scrollWidth,
				composer: document.querySelector("#composer").scrollWidth, card: document.querySelector(".composer-card").scrollWidth,
				menu: document.querySelector("#fileCompletionMenu").scrollWidth,
			})) }));
			assert.equal(await page.locator("#fileCompletionMenu").evaluate((el) => {
				const box = el.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && box.top >= 0;
			}), true);
			await page.screenshot({ path: join(screenshots, `files-${width}-${theme}.png`) });
		}
		console.log(`File completion screenshots: ${screenshots}`);
	} finally { await page.close(); }
});
