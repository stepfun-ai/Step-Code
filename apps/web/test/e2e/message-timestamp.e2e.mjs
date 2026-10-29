import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const webRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureId = join(webRoot, "client", "message-timestamp-fixture.tsx").replaceAll("\\", "/");
const chromePath = [
	process.env.CHROME_PATH,
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
	"C:/Program Files/Google/Chrome/Application/chrome.exe",
].find((path) => path && existsSync(path));
const skip = chromePath ? false : "No installed Chrome; set CHROME_PATH";
const fixture = `
import React from "react";
import {createRoot} from "react-dom/client";
import "/src/styles/global.css";
import "/src/features/conversation/stream.css";
import "/src/features/conversation/message-actions.css";
import "/src/features/conversation/turn-artifacts.css";
import {IconSprite} from "/src/ui";
import {ConversationStream} from "/src/features/conversation/ConversationStream.tsx";
import {setState, setUi, getState} from "/src/state/store.ts";
import {ChildAgentView} from "/src/features/conversation/ChildAgentView.tsx";
import {timelineFromEntries} from "/src/state/session.ts";
window.fixture = (items, extra = {}) => setState({
 booted:true, current:{id:"timestamp-fixture",cwd:"/fixture",status:"idle",entries:[],lastRunAborted:true},
 timelineItems:items, ...extra
});
window.fixtureEntries = entries => window.fixture(timelineFromEntries(entries));
window.fixtureState = getState;
window.childFixture = toolItemId => setUi({childView:{parentId:"timestamp-fixture",childId:"child-fixture",toolItemId,taskIndex:toolItemId ? 0 : undefined}});
createRoot(document.getElementById("root")).render(<><IconSprite/><ConversationStream/><ChildAgentView/></>);
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
		plugins: [
			{
				name: "message-timestamp-regression",
				resolveId(id) {
					if (id === "/message-timestamp-fixture.js" || id === fixtureId) return fixtureId;
				},
				load(id) {
					if (id === fixtureId) return fixture;
				},
				configureServer(server) {
					server.middlewares.use((req, res, next) => {
						if (req.url !== "/message-timestamp-fixture") return next();
						res.setHeader("Content-Type", "text/html");
						res.end(
							`<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/message-timestamp-fixture.js"></script></body></html>`,
						);
					});
				},
			},
		],
	});
	await vite.listen();
	url = `http://127.0.0.1:${vite.httpServer.address().port}/message-timestamp-fixture`;
	browser = await chromium.launch({ executablePath: chromePath, headless: true });
});
after(async () => {
	await browser?.close();
	await vite?.close();
});

const timestamp = "2026-10-26T03:12:00.000Z";
const message = (id, role, content, extra = {}) => ({
	kind: "message",
	itemId: `message-${id}`,
	entryId: id,
	role,
	content,
	timestamp,
	...extra,
});
const history = [
	message("user-1", "user", "First recorded prompt"),
	message("intermediate-1", "assistant", "First intermediate reply with [link](https://example.com)"),
	message("intermediate-2", "assistant", "Second intermediate reply"),
	message("final-1", "assistant", "First final reply"),
	message("user-2", "user", "Stopped prompt"),
	message("aborted", "assistant", "Recorded partial reply"),
	message("user-3", "user", "Failed prompt"),
	message("error", "assistant", "", { error: "Fixture request failed" }),
].map((item, index) => ({ ...item, timestamp: `2026-10-26T03:${String(12 + index).padStart(2, "0")}:00.000Z` }));
const opacity = (locator) =>
	locator.evaluate((el) => {
		let value = 1;
		for (let node = el; node instanceof Element; node = node.parentElement)
			value *= Number(getComputedStyle(node).opacity);
		return value;
	});
async function outside(page) {
	await page.mouse.move(1, 1);
	await page.evaluate(() => document.activeElement?.blur());
}

async function assertTrailingTimestamp(page, reply, expectedTimestamp, expectedLabel) {
	assert.equal(await reply.locator("time").count(), 0, "no paragraph timestamp");
	const toolbar = page.locator(".turn-actions");
	const toolbarTime = toolbar.locator(".message-meta-time");
	assert.equal(await toolbarTime.count(), 1, "one timestamp after trailing processes");
	assert.equal(await page.locator(".message.assistant time").count(), 0);
	assert.equal(await toolbarTime.getAttribute("datetime"), expectedTimestamp);
	assert.equal(await toolbarTime.innerText(), expectedLabel);
	await outside(page);
	await reply.locator(".message-body").hover();
	assert.equal(await opacity(toolbarTime), 1, "body reveals the single bottom timestamp");
	await outside(page);
	await toolbar.locator("button").first().hover();
	assert.equal(await opacity(toolbarTime), 1);
	await outside(page);
	await toolbar.locator("button").first().focus();
	assert.equal(await toolbar.evaluate((el) => el.matches(":hover")), false);
	assert.equal(await opacity(toolbarTime), 1);
}

test("error-only and stopped recorded turns have exactly one final time", { skip }, async () => {
	const page = await browser.newPage();
	try {
		await page.goto(url);
		await page.waitForFunction(() => typeof window.fixtureEntries === "function");
		const entries = [
			{ id: "stop-user", type: "message", timestamp, message: { role: "user", content: "Stop fixture" } },
			{ id: "stop-first", type: "message", timestamp, message: { role: "assistant", content: [{type:"text", text:"Earlier output"}], stopReason:"toolUse" } },
			{ id: "stop-last", type: "message", timestamp:"2026-10-26T03:16:00Z", message: { role: "assistant", content: [{type:"text", text:"Stopped partial"}], stopReason:"aborted" } },
			{ id: "error-user", type: "message", timestamp, message: { role: "user", content: "Fail fixture" } },
			... ["first", "last"].map((name) => ({ id:`error-${name}`, type:"message", timestamp: name === "last" ? "2026-10-26T03:17:00Z" : timestamp, message:{role:"assistant",content:[],stopReason:"error",errorMessage:"Fixture failure"} })),
		];
		await page.evaluate((entries) => window.fixtureEntries(entries), entries);
		await page.locator('[data-entry-id="error-last"]').waitFor();
		assert.equal(await page.locator(".message-meta-time").count(), 4, "two prompts, stopped turn, error-only turn");
		assert.equal(await page.locator(".turn-actions").count(), 1, "error-only has no fake actions");
		assert.equal(await page.locator(".turn-actions time").getAttribute("datetime"), "2026-10-26T03:16:00Z");
		assert.equal(await page.locator('[data-entry-id="error-first"] time').count(), 0);
		assert.equal(await page.locator('[data-entry-id="error-last"] time').getAttribute("datetime"), "2026-10-26T03:17:00Z");
	} finally { await page.close(); }
});

test("child reply has one timestamp per turn and retains collapsed read-only receipts", { skip }, async () => {
	const page = await browser.newPage();
	try {
		await page.route("**/api/v1/sessions/timestamp-fixture/children/child-fixture", (route) => route.fulfill({json:{id:"child-fixture",cwd:"/fixture",status:"idle",entries:[
			{id:"child-user",type:"message",timestamp,message:{role:"user",content:"Child received task"}},
			{id:"child-first",type:"message",timestamp,message:{role:"assistant",content:[{type:"text",text:"First child paragraph"}]}},
			{id:"child-last",type:"message",timestamp:"2026-10-26T03:18:00Z",message:{role:"assistant",content:[{type:"text",text:"Final child paragraph"}]}},
		]}}));
		await page.goto(url);
		await page.waitForFunction(() => typeof window.childFixture === "function");
		await page.evaluate(() => { window.fixture([]); window.childFixture(); });
		const child = page.locator("#childAgentView");
		await child.locator('[data-entry-id="child-last"]').waitFor();
		assert.equal(await child.locator(".message-meta-time").count(), 1);
		assert.equal(await child.locator(".message-meta-time").getAttribute("datetime"), "2026-10-26T03:18:00Z");
		assert.equal(await child.locator(".subagent-input-toggle").getAttribute("aria-expanded"), "false");
		assert.equal(await child.locator(".subagent-input-time").count(), 1);
		assert.equal(await child.locator(".message.user, .turn-actions, textarea, [contenteditable]").count(), 0);
		await page.evaluate(() => {
			window.fixture([{kind:"tool",itemId:"child-tool",toolName:"subagent",state:"completed",inputSummary:"child fixture",outputSummary:"done",subagentTasks:[{agent:"fixture",task:"Child received task",status:"completed",sessionId:"child-fixture"}]}], {current:{id:"timestamp-fixture",cwd:"/fixture",status:"running",entries:[]}});
			window.childFixture("child-tool");
		});
		await child.locator(".subagent-state-label").waitFor();
		assert.equal(await child.locator(".message-meta-time").count(), 1, "completed child retains time while its parent runs");
		for (const status of ["running", "queued"]) {
			await page.evaluate((status) => {
				const tool = window.fixtureState().timelineItems[0];
				window.fixture([{...tool,subagentTasks:[{...tool.subagentTasks[0],status}]}]);
			}, status);
			await page.waitForFunction(() => document.querySelectorAll("#childAgentView .message-meta-time").length === 0);
			assert.equal(await child.locator(".message-meta-time").count(), 0, `${status} child has no final timestamp`);
		}
	} finally { await page.close(); }
});

const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
for (const [name, item, selector] of [
	["image-only button", message("focus-image", "user", "", { images: [image] }), ".message-images button"],
	["image with text", message("focus-caption", "user", "Describe this image", { images: [image] }), ".message-images button"],
	["body markdown link", message("focus-link", "user", "Read [documentation](https://example.com)"), ".message-body a"],
]) {
	test(`message timestamp reveals on ${name} keyboard focus with pointer outside`, { skip }, async () => {
		const page = await browser.newPage();
		try {
			await page.emulateMedia({ reducedMotion: "reduce" });
			await page.goto(url);
			await page.waitForFunction(() => typeof window.fixture === "function");
			await page.evaluate((item) => window.fixture([item]), item);
			const article = page.locator(`article[data-entry-id="${item.entryId}"]`);
			const target = article.locator(selector);
			await target.waitFor();
			assert.equal(
				await article.locator(".prompt-actions button").count(),
				item.content ? 2 : 0,
				"only prompts with text keep their copy and rewrite actions",
			);
			await outside(page);
			assert.equal(await opacity(article.locator("time")), 0);
			await page.keyboard.press("Tab");
			assert.equal(await target.evaluate((el) => el === document.activeElement), true);
			assert.equal(await article.evaluate((el) => el.matches(":hover")), false);
			assert.equal(await opacity(article.locator("time")), 1, `${name} reveals parent actions and time`);
			await outside(page);
			assert.equal(await opacity(article.locator("time")), 0);
		} finally {
			await page.close();
		}
	});
}

for (const theme of ["light", "dark"]) {
	test(`message timestamp hover, leave and focus respect turn boundaries without reflow (${theme})`, { skip }, async () => {
		const page = await browser.newPage({ viewport: { width: 1000, height: 1500 }, timezoneId: "Asia/Shanghai" });
		const errors = [];
		page.on("pageerror", (error) => errors.push(error.message));
		try {
			await page.emulateMedia({ reducedMotion: "reduce" });
			await page.goto(url);
			await page.waitForFunction(() => typeof window.fixture === "function");
			await page.evaluate(
				({ items, theme }) => {
					document.documentElement.dataset.theme = theme;
					window.fixture(items);
				},
				{ items: history, theme },
			);
			await page.locator('[data-entry-id="error"]').waitFor();
			assert.equal(await page.locator(".message-meta-time").count(), history.filter((item) => !item.entryId.startsWith("intermediate")).length);
			const heights = () =>
				page.locator("#streamInner").evaluate((el) => ({
					height: el.getBoundingClientRect().height,
					messages: [...el.querySelectorAll("article.message")].map((row) => row.getBoundingClientRect().height),
				}));
			await outside(page);
			const baseline = await heights();
			for (const item of history) {
				const article = page.locator(`article[data-entry-id="${item.entryId}"]`);
				const owner = item.entryId.startsWith("intermediate") ? history[3] : item;
				const time = page.locator(`.message-meta-time[datetime="${owner.timestamp}"]`);
				assert.equal(
					await time.innerText(),
					`2026-10-26 11:${String(12 + history.indexOf(owner)).padStart(2, "0")}`,
				);
				assert.equal(await opacity(time), 0);
				await article.locator(item.error ? ".message-error-text" : ".message-body").hover();
				assert.equal(await opacity(time), 1, `${item.entryId} body hover`);
				assert.deepEqual(await heights(), baseline);
				const visible = await page.locator(".message-meta").evaluateAll(
					(nodes) =>
						nodes.filter((el) => {
							let value = 1;
							for (let node = el; node instanceof Element; node = node.parentElement)
								value *= Number(getComputedStyle(node).opacity);
							return value > 0;
						}).length,
				);
				assert.equal(visible, 1, "only this message reveals its timestamp");
				await outside(page);
				assert.equal(await opacity(time), 0, `${item.entryId} leave`);
				await time.hover();
				assert.equal(await opacity(time), 1, `${item.entryId} metadata hover`);
				await outside(page);
				const action = article.locator("button, a").first();
				const toolbar = time.locator("xpath=ancestor::*[contains(@class,'turn-actions')]");
				const focusTarget = (await action.count())
					? action
					: (await toolbar.count())
						? toolbar.locator("button").first()
						: time;
				await focusTarget.focus();
				assert.equal(await opacity(time), 1, `${item.entryId} focus`);
				assert.deepEqual(await heights(), baseline);
				await outside(page);
			}
			const finalToolbar = page.locator('[data-entry-id="final-1"] + .turn-actions');
			assert.equal(await finalToolbar.locator(".message-meta-time").count(), 1);
			await finalToolbar.locator(".copy-message").hover();
			assert.equal(await opacity(finalToolbar.locator(".message-meta-time")), 1);
			assert.deepEqual(await heights(), baseline);
			const screenshots = await mkdtemp(join(tmpdir(), "stepcode-timestamp-qa-"));
			await page.screenshot({ path: join(screenshots, `${theme}.png`), fullPage: true });
			console.log(`Timestamp screenshot: ${join(screenshots, `${theme}.png`)}`);
			assert.deepEqual(errors, []);
		} finally {
			await page.close();
		}
	});
}

test("turn actions keep full text copy, vote and final-entry fork; text prompts still rewrite", { skip }, async () => {
	const page = await browser.newPage();
	try {
		let forkBody;
		await page.route("**/api/v1/**", async (route) => {
			if (route.request().url().endsWith("/fork")) {
				forkBody = route.request().postDataJSON();
				await route.fulfill({ json: { cancelled: true } });
			} else await route.fulfill({ status: 503, json: { error: "Offline fixture" } });
		});
		await page.goto(url);
		await page.waitForFunction(() => typeof window.fixtureState === "function");
		await page.evaluate((items) => {
			Object.defineProperty(navigator, "clipboard", { configurable: true, value: {writeText: async (text) => { window.copiedText = text; }} });
			window.fixture(items);
		}, history.slice(0, 4));
		const toolbar = page.locator(".turn-actions");
		await toolbar.locator(".copy-message").click();
		assert.equal(await page.evaluate(() => window.copiedText), history.slice(1, 4).map((item) => item.content).join("\n\n"));
		await toolbar.locator(".vote-up").click();
		assert.equal(await toolbar.locator(".vote-up").getAttribute("aria-pressed"), "true");
		await toolbar.locator(".vote-down").click();
		assert.equal(await toolbar.locator(".vote-up").getAttribute("aria-pressed"), "false");
		assert.equal(await toolbar.locator(".vote-down").getAttribute("aria-pressed"), "true");
		const request = page.waitForRequest("**/fork");
		await toolbar.locator(".fork-message").click();
		await request;
		assert.deepEqual(forkBody, {entryId:"final-1"});
		const prompt = page.locator('[data-entry-id="user-1"]');
		await prompt.locator(".prompt-actions button").first().click();
		assert.equal(await page.evaluate(() => window.copiedText), history[0].content);
		await prompt.locator(".prompt-actions button").last().click();
		assert.deepEqual(await page.evaluate(() => window.fixtureState().ui.editingPrompt), {entryId:"user-1",before:undefined,text:history[0].content});
	} finally { await page.close(); }
});

test("message timestamp never fills in pending, queued, live or invalid data", { skip }, async () => {
	const page = await browser.newPage();
	try {
		await page.goto(url);
		await page.waitForFunction(() => typeof window.fixture === "function");
		await page.evaluate(
			({ items }) =>
				window.fixture(items, {
					pendingTurn: { text: "Pending prompt", images: [], files: [] },
					current: {
						id: "timestamp-fixture",
						cwd: "/fixture",
						status: "running",
						entries: [],
						steeringMessages: [{ text: "Queued prompt", images: [] }],
					},
				}),
			{
				timestamp,
				items: [
					message("invalid", "user", "Invalid date", { timestamp: "2026-02-30T00:00:00Z" }),
					message("missing", "assistant", "No time", { timestamp: undefined }),
					message("unrecorded", "user", "Unrecorded", { entryId: undefined }),
					message("live", "assistant", "Live output", { itemId: "message-live-1" }),
				],
			},
		);
		await page.getByText("Queued prompt", { exact: true }).waitFor();
		assert.equal(await page.locator(".message-meta-time").count(), 0);
		for (const recordedTime of [undefined, "not-a-date", "2026-02-30T00:00:00Z"]) {
			await page.evaluate((items) => window.fixture(items, {pendingTurn:null}), [
				message("earlier-valid", "assistant", "Earlier valid recorded reply"),
				message("invalid-final", "assistant", "Final record has no valid time", {timestamp:recordedTime}),
			]);
			await page.locator('[data-entry-id="invalid-final"]').waitFor();
			assert.equal(await page.locator(".message-meta-time").count(), 0, "never substitutes earlier or current clock for invalid final time");
		}
	} finally {
		await page.close();
	}
});

test(
	"message timestamp keeps changes, artifacts, trailing processes and keyed replies in place",
	{ skip },
	async () => {
		const page = await browser.newPage({ timezoneId: "Asia/Shanghai" });
		const tool = {
			kind: "tool",
			itemId: "edit-fixture",
			toolName: "edit_file",
			state: "completed",
			inputSummary: "result.md",
			outputSummary: "updated",
			args: { path: "result.md" },
			change: { path: "result.md", patch: "--- result.md\n+++ result.md\n@@ -1,1 +1,1 @@\n-old\n+new\n" },
		};
		const items = [
			message("image", "user", "", {
				images: [
					"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
				],
			}),
			tool,
			message("delivery", "assistant", "Delivered [result](./result.md)"),
		];
		try {
			await page.emulateMedia({ reducedMotion: "reduce" });
			await page.goto(url);
			await page.waitForFunction(() => typeof window.fixture === "function");
			await page.evaluate((items) => window.fixture(items), items);
			const reply = page.locator('[data-entry-id="delivery"]');
			await reply.waitFor();
			const toolbar = page.locator('[data-entry-id="delivery"] + .turn-changes + .turn-actions');
			assert.equal(await toolbar.count(), 1, "changes card remains before the toolbar");
			assert.equal(await reply.locator(".message-attachments").count(), 1);
			assert.equal(await page.locator(".message.user .message-meta-time").count(), 1, "images-only recorded prompt");
			await outside(page);
			await reply.locator(".message-body").hover();
			assert.equal(await opacity(toolbar.locator(".message-meta-time")), 1);
			await outside(page);
			await toolbar.locator("button").first().focus();
			assert.equal(await opacity(toolbar.locator(".message-meta-time")), 1);
			await page.evaluate(() => {
				window.originalReply = document.querySelector('[data-entry-id="delivery"]');
			});
			await page.evaluate(
				(items) => window.fixture(items),
				[...items, { ...tool, itemId: "trailing-tool", change: undefined }],
			);
			await page.waitForFunction(() => document.querySelector('.turn-actions .message-meta-time'));
			assert.equal(await reply.locator("time").count(), 0);
			assert.equal(
				await page.evaluate(() => window.originalReply === document.querySelector('[data-entry-id="delivery"]')),
				true,
			);
			await assertTrailingTimestamp(page, reply, timestamp, "2026-10-26 11:12");
		} finally {
			await page.close();
		}
	},
);

for (const trailingGroup of [false, true]) {
	test(`message timestamp follows real interleaved entries with trailing ${trailingGroup ? "group" : "tool"}`, { skip }, async () => {
		const page = await browser.newPage({ timezoneId: "Asia/Shanghai" });
		const replyTimestamp = "2026-10-26T03:14:00.000Z";
		const entries = [
			{ id: "real-user", type: "message", timestamp, message: { role: "user", content: "Inspect the files" } },
			{
				id: "real-assistant", type: "message", timestamp: replyTimestamp,
				message: {
					role: "assistant", stopReason: "toolUse", content: [
						{ type: "text", text: "Checking the first file" },
						{ type: "toolCall", id: "read-first", name: "read_file", arguments: { path: "first.md" } },
						{ type: "text", text: "Checking the second file" },
						{ type: "toolCall", id: "read-second", name: "read_file", arguments: { path: "second.md" } },
						...(trailingGroup ? [
							{ type: "toolCall", id: "read-third", name: "read_file", arguments: { path: "third.md" } },
						] : []),
					],
				},
			},
			...(trailingGroup ? ["first", "second", "third"] : ["first", "second"]).map((name) => ({
				id: `result-${name}`, type: "message", timestamp: "2026-10-26T03:15:00.000Z",
				message: {
					role: "toolResult", toolCallId: `read-${name}`,
					content: [{ type: "text", text: `Read ${name}` }], isError: false,
				},
			})),
		];
		try {
			await page.emulateMedia({ reducedMotion: "reduce" });
			await page.goto(url);
			await page.waitForFunction(() => typeof window.fixtureEntries === "function");
			if (trailingGroup) {
				const singletonEntries = entries.map((entry) => entry.id === "real-assistant"
					? {...entry, message:{...entry.message, content:entry.message.content.filter((part) => part.id !== "read-third")}}
					: entry).filter((entry) => entry.id !== "result-third");
				await page.evaluate((entries) => window.fixtureEntries(entries), singletonEntries);
				await page.locator(".tool-call").last().waitFor();
				await page.locator(".tool-call").last().locator(".tool-toggle").click();
				await page.evaluate(() => { window.originalSingleton = document.querySelectorAll(".tool-call")[1]; });
			}
			await page.evaluate((entries) => window.fixtureEntries(entries), entries);
			const replies = page.locator('article[data-entry-id="real-assistant"]');
			await replies.last().waitFor();
			assert.equal(await replies.count(), 2, "interleaved text blocks stay separate");
			assert.equal(await page.locator(".tool-call").count(), trailingGroup ? 3 : 2, "real results complete all tools");
			assert.equal(await page.locator('.process-tool-group[data-single="false"]').count(), trailingGroup ? 1 : 0);
			await assertTrailingTimestamp(page, replies.last(), replyTimestamp, "2026-10-26 11:14");
			assert.equal(await replies.first().locator("time").count(), 0, "earlier text has no timestamp");
			await outside(page);
			await replies.first().locator(".message-body").hover();
			assert.equal(await opacity(page.locator(".turn-actions time")), 1, "intermediate body reveals same footer");
			if (trailingGroup) {
				assert.equal(await page.evaluate(() => window.originalSingleton === document.querySelectorAll(".tool-call")[1]), true);
				assert.equal(await page.locator(".tool-call").nth(1).locator(".tool-toggle").getAttribute("aria-expanded"), "true");
			}
			await page.evaluate((entries) => window.fixtureEntries(entries), [...entries,
				{id:"next-user",type:"message",timestamp,message:{role:"user",content:"Next isolated turn"}},
				{id:"next-assistant",type:"message",timestamp:"2026-10-26T03:20:00Z",message:{role:"assistant",content:[{type:"text",text:"Next final reply"}]}},
			]);
			await page.locator('[data-entry-id="next-assistant"]').waitFor();
			await outside(page);
			await replies.first().locator(".message-body").hover();
			assert.equal(await opacity(page.locator(".turn-actions").first().locator("time")), 1);
			assert.equal(await opacity(page.locator(".turn-actions").last().locator("time")), 0, "trailing group cannot leak hover into later turn");
		} finally {
			await page.close();
		}
	});
}

test(
	"message timestamp normal-motion hover fits narrow layout and converts across the local date boundary",
	{ skip },
	async () => {
		const page = await browser.newPage({ viewport: { width: 390, height: 900 }, timezoneId: "America/New_York" });
		try {
			await page.emulateMedia({ reducedMotion: "no-preference" });
			await page.goto(url);
			await page.waitForFunction(() => typeof window.fixture === "function");
			await page.evaluate((items) => window.fixture(items), history.slice(0, 4));
			const prompt = page.locator('[data-entry-id="user-1"]');
			await prompt.waitFor();
			await outside(page);
			const before = await prompt.boundingBox();
			await prompt.locator(".message-body").hover();
			await page.waitForFunction(() => {
				const meta = document.querySelector(".message.user .message-meta");
				return getComputedStyle(meta).opacity === "1" && getComputedStyle(meta.parentElement).opacity === "1";
			});
			assert.equal(await prompt.locator("time").innerText(), "2026-10-25 23:12");
			assert.deepEqual(await prompt.boundingBox(), before);
			await outside(page);
			await page.waitForFunction(
				() => getComputedStyle(document.querySelector(".message.user .message-meta")).opacity === "0",
			);
			assert.deepEqual(await prompt.boundingBox(), before);
			const toolbar = page.locator('[data-entry-id="final-1"] + .turn-actions');
			await toolbar.locator("button").first().focus();
			assert.equal(await toolbar.locator("time").innerText(), "2026-10-25 23:15");
			assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
		} finally {
			await page.close();
		}
	},
);
