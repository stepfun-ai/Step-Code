import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { activeRightPanel, closeRightPanel, openRightPanel } from "../client/src/state/right-panel.ts";
import { appStore, createInitialState } from "../client/src/state/store.ts";
import { MESSAGES } from "../client/src/i18n/messages.ts";
import { TerminalConnection, terminalWorkspaceKey, toggleTerminalDock } from "../client/src/features/terminal/actions.ts";

test("terminal workspace keys normalize Windows spelling without folding POSIX case", () => {
	assert.equal(terminalWorkspaceKey("D:\\Project\\"), terminalWorkspaceKey("d:/project"));
	assert.notEqual(terminalWorkspaceKey("/home/Project"), terminalWorkspaceKey("/home/project"));
	assert.equal(terminalWorkspaceKey("/"), "/");
});

test("terminal docks below the conversation, independent of the exclusive inspector", () => {
	const rail = readFileSync(new URL("../client/src/features/inspector/RightPanel.tsx", import.meta.url), "utf8");
	assert.doesNotMatch(rail, /id: "terminal"/);
	assert.match(rail, /data-terminal-toggle/);
	const app = readFileSync(new URL("../client/src/App.tsx", import.meta.url), "utf8");
	// The dock is the last block of the page, directly below the input area —
	// whether that is the composer or the decision standing in its place.
	assert.match(app, /<\/div>\s*\)\}\s*<TerminalDock \/>/);
	appStore.setState(createInitialState());
	assert.equal(appStore.getState().ui.terminalOpen, false);
	toggleTerminalDock();
	openRightPanel("browser");
	assert.equal(activeRightPanel(appStore.getState()), "browser");
	assert.equal(appStore.getState().ui.terminalOpen, true);
	closeRightPanel();
	assert.equal(appStore.getState().ui.terminalOpen, true);
	toggleTerminalDock(false);
	assert.equal(appStore.getState().ui.terminalOpen, false);
});
test("all terminal messages are present in both locales", () => {
	const zh = MESSAGES["zh-CN"];
	const en = MESSAGES["en-US"];
	for (const key of Object.keys(zh).filter((key) => key.startsWith("terminal"))) {
		assert.ok(en[key], key);
		assert.deepEqual([...zh[key].matchAll(/\{(\w+)\}/g)].map((match) => match[1]), [...en[key].matchAll(/\{(\w+)\}/g)].map((match) => match[1]));
	}
});

test("input typed while a request is in flight is sent as one ordered request", async () => {
	const requests: { path: string; body: unknown }[] = [];
	let release: () => void = () => {};
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	const original = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		requests.push({ path: String(input), body: JSON.parse(String(init?.body)) });
		if (requests.length === 1) await blocked;
		return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
	};
	const errors: unknown[] = [];
	const connection = new TerminalConnection("t1", 0, async () => {}, (_connected, error) => error && errors.push(error), () => {});
	try {
		connection.send("input", { data: "a" });
		await delay(5);
		// 200 keys while the first request is stuck: the old queue closed the connection at 64.
		for (const key of "x".repeat(200)) connection.send("input", { data: key });
		connection.send("resize", { cols: 90, rows: 30 });
		connection.send("input", { data: "\r" });
		release();
		for (let n = 0; n < 100 && requests.length < 4; n++) await delay(5);
		assert.deepEqual(errors, []);
		assert.deepEqual(
			requests.map((request) => [request.path.split("/").at(-1), request.body]),
			[
				["input", { data: "a" }],
				["input", { data: "x".repeat(200) }],
				["resize", { cols: 90, rows: 30 }],
				["input", { data: "\r" }],
			],
		);
	} finally {
		connection.close();
		globalThis.fetch = original;
	}
});
