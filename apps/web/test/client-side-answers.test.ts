/**
 * A `/btw` answer is a tab of its own: the question opens it immediately (in a
 * waiting state), and the answer replaces that tab when it arrives. It is never
 * a message and never a notice.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { sideAnswerHtml } from "../client/src/features/files/side-answer-html.ts";
import {
	beginSideAnswer,
	failSideAnswer,
	openSideAnswerTab,
	syncSideAnswerTabs,
} from "../client/src/features/files/side-answers.ts";
import { createInitialState, getState, type SideAnswerTab, setState } from "../client/src/state/store.ts";

function reset(): void {
	const initial = createInitialState();
	setState({ preview: { ...initial.preview } });
}

function btwTabs(): readonly SideAnswerTab[] {
	return getState().preview.tabs.filter((tab): tab is SideAnswerTab => tab.kind === "btw");
}

test("the question opens its own tab before the answer exists", () => {
	reset();
	beginSideAnswer("why is the build red?");
	const [tab] = btwTabs();
	assert.equal(tab?.question, "why is the build red?");
	assert.equal(tab?.pending, true);
	assert.equal(tab?.text, "");
	// It is where the reader is looking: open, on the rail, selected.
	assert.equal(getState().preview.open, true);
	assert.equal(getState().preview.mode, "files");
	assert.equal(getState().preview.tabs[getState().preview.active]?.kind, "btw");
	// Nothing entered the conversation.
	assert.deepEqual(getState().timelineItems, []);
	assert.deepEqual(getState().notices, []);
});

test("the answer replaces the waiting tab instead of stacking a second one", () => {
	reset();
	beginSideAnswer("why?");
	openSideAnswerTab({
		id: "answer-1",
		question: "why?",
		text: "**Because** the token expired.",
		model: "step/test",
		createdAt: 2,
	});
	const tabs = btwTabs();
	assert.equal(tabs.length, 1);
	assert.equal(tabs[0]?.pending, undefined);
	assert.equal(tabs[0]?.text, "**Because** the token expired.");
	assert.equal(tabs[0]?.model, "step/test");
	assert.equal(getState().preview.active, getState().preview.tabs.length - 1);
});

test("a failed request says so in the tab it opened", () => {
	reset();
	beginSideAnswer("why?");
	failSideAnswer("why?", "No model selected");
	const [tab] = btwTabs();
	assert.equal(tab?.pending, false);
	assert.equal(tab?.unavailable, true);
	assert.equal(tab?.text, "No model selected");
});

test("restoring a session's answers reuses tabs and keeps an open file in front", () => {
	reset();
	syncSideAnswerTabs([
		{ id: "a1", question: "first", text: "one", createdAt: 1 },
		{ id: "a2", question: "second", text: "two", createdAt: 2 },
	]);
	assert.deepEqual(btwTabs().map((tab) => tab.id), ["a1", "a2"]);
	// Nothing was open, so the rail lands on the newest answer.
	assert.equal(getState().preview.tabs[getState().preview.active]?.kind, "btw");

	// A page already showing a file keeps that file in front.
	setState((state) => ({ preview: { ...state.preview, active: 0 } }));
	syncSideAnswerTabs([{ id: "a3", question: "third", text: "three", createdAt: 3 }]);
	assert.equal(btwTabs().length, 3);
	assert.equal(getState().preview.tabs[getState().preview.active]?.kind, "btw");
	// Already-known answers are not duplicated.
	syncSideAnswerTabs([{ id: "a1", question: "first", text: "one", createdAt: 1 }]);
	assert.equal(btwTabs().length, 3);
});

test("the answer body is Markdown, not its source", () => {
	const html = sideAnswerHtml("- the **blocking** issue is fixed", { code: "Code", copy: "Copy", table: "Table" });
	assert.match(html, /<strong>blocking<\/strong>/u);
	assert.equal(html.includes("**"), false);
	assert.match(html, /md-li/u);
});
