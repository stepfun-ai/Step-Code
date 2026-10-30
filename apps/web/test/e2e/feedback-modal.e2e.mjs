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
const fixtureId = join(webRoot, "client", "feedback-modal-fixture.tsx").replaceAll("\\", "/");
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
import "/src/features/conversation/feedback.css";
import {IconSprite} from "/src/ui";
import {FeedbackModal} from "/src/features/conversation/FeedbackModal.tsx";
import {openFeedback} from "/src/features/conversation/feedback.ts";
import {setState} from "/src/state/store.ts";
setState({current:{id:"feedback-test",cwd:"/fixture",status:"idle",entries:[]}});
window.openFeedback = openFeedback;
createRoot(document.getElementById("root")).render(<><IconSprite/><FeedbackModal/></>);
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
			name: "feedback-modal-regression",
			resolveId(id) {
				if (id === "/feedback-modal-fixture.js" || id === fixtureId) return fixtureId;
			},
			load(id) {
				if (id === fixtureId) return fixture;
			},
			configureServer(server) {
				server.middlewares.use((req, res, next) => {
					if (req.url !== "/feedback-modal-fixture") return next();
					res.setHeader("Content-Type", "text/html");
					res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/feedback-modal-fixture.js"></script></body></html>`);
				});
			},
		}],
	});
	await vite.listen();
	url = `http://127.0.0.1:${vite.httpServer.address().port}/feedback-modal-fixture`;
	browser = await chromium.launch({ executablePath: chromePath, headless: true });
});
after(async () => {
	await browser?.close();
	await vite?.close();
});

const draft = {
	token: "draft-token",
	preview: { version: "0.1.0", channel: "dev", summary: true, archive: [{ name: "session.jsonl", bytes: 2048 }] },
};

async function openPage() {
	const page = await browser.newPage({ viewport: { width: 900, height: 820 } });
	const posts = [];
	await page.route("**/api/v1/sessions/feedback-test/feedback/evidence", (route) => route.fulfill({ json: draft }));
	await page.route("**/api/v1/sessions/feedback-test/feedback", (route) => {
		posts.push(route.request().postDataJSON());
		return route.fulfill({ json: { message: "ok" } });
	});
	await page.goto(url);
	await page.waitForFunction(() => typeof window.openFeedback === "function");
	return { page, posts };
}

test("the required vote is separated from optional topics and explains a missing choice", { skip }, async () => {
	const { page, posts } = await openPage();
	try {
		await page.evaluate(() => window.openFeedback());
		await page.locator("#feedbackAttachments .feedback-attachments-title").waitFor();
		const sentiments = page.locator("#feedbackSentiments .feedback-sentiment");
		assert.equal(await sentiments.count(), 2);
		assert.equal(await page.locator("#feedbackSentiments .feedback-topic").count(), 0);
		assert.equal(await page.locator(".feedback-required").count(), 1);
		assert.equal(await page.locator(".feedback-optional").count(), 1);
		const vote = await sentiments.first().boundingBox();
		const topic = await page.locator("#feedbackTopics .feedback-topic").first().boundingBox();
		assert.ok(vote.height > topic.height, "the required vote is visibly larger than an optional topic chip");
		const group = await page.locator("#feedbackSentiments").boundingBox();
		assert.ok(vote.width < group.width / 2, "vote buttons size to their content instead of filling the row");

		await page.locator("#feedbackTopics .feedback-topic").nth(2).click();
		const submit = page.locator("#feedbackSubmit");
		assert.equal(await submit.isDisabled(), false, "a missing vote must not leave a silent grey button");
		assert.equal(await page.locator(".feedback-required-hint").isVisible(), false);
		await submit.click();
		assert.equal(await page.locator(".feedback-required-hint").isVisible(), true);
		assert.equal(await page.locator("#feedbackSentiments").getAttribute("data-missing"), "true");
		assert.equal(posts.length, 0);

		await page.locator('[data-sentiment="down"]').click();
		assert.equal(await page.locator(".feedback-required-hint").isVisible(), false);
		assert.equal(await page.locator("#feedbackSentiments").getAttribute("data-missing"), null);
		const screenshots = process.env.STEPCODE_WEB_QA_DIR || join(tmpdir(), "stepcode-feedback-qa");
		await mkdir(screenshots, { recursive: true });
		await page.mouse.move(0, 0);
		await page.waitForTimeout(300);
		await page.screenshot({ path: join(screenshots, "feedback-selected.png") });
		await submit.click();
		await page.waitForFunction(() => document.querySelector("#feedbackModal")?.hidden !== false);
		assert.deepEqual(posts, [{ sentiment: "down", comment: "", topic: "productInteraction", token: "draft-token" }]);

		await page.evaluate(() => window.openFeedback());
		assert.equal(await page.locator(".feedback-required-hint").isVisible(), false, "a reopened dialog starts clean");
		await page.locator("#feedbackAttachments .feedback-attachments-title").waitFor();
		await page.locator("#feedbackSubmit").click();
		await page.waitForTimeout(400);
		await page.screenshot({ path: join(screenshots, "feedback-missing.png") });
		console.log(`Feedback screenshots: ${screenshots}`);
	} finally {
		await page.close();
	}
});

test("a vote button preselects the sentiment and submits without extra steps", { skip }, async () => {
	const { page, posts } = await openPage();
	try {
		await page.evaluate(() => window.openFeedback("up"));
		await page.locator("#feedbackAttachments .feedback-attachments-title").waitFor();
		assert.equal(await page.locator('[data-sentiment="up"]').getAttribute("aria-pressed"), "true");
		await page.locator("#feedbackSubmit").click();
		await page.waitForFunction(() => document.querySelector("#feedbackModal")?.hidden !== false);
		assert.equal(posts[0].sentiment, "up");
	} finally {
		await page.close();
	}
});
