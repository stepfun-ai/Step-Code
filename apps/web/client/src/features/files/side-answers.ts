/**
 * Side answers (`/btw`) are their own thread: each one opens a tab in the
 * preview rail, next to the files, and the conversation is never touched.
 *
 * The tab opens as soon as the question is sent (`pending`), because the answer
 * takes a model round trip and the reader should see where it will appear. The
 * kernel's `ui.sideAnswer` fills it in. Tab state is client presentation only:
 * the answers themselves live in the host's session memory, never in the
 * session file and never in the model's context.
 */

import { api, errorMessage } from "../../lib/api";
import { createSessionIfNeeded, installSideAnswerTabs } from "../../state/session";
import { getState, type SideAnswerTab, setPreview } from "../../state/store";
import type { SideAnswer } from "../../state/types";
import { applyPreviewWidth, PREVIEW_MIN } from "./actions";

/** Tabs opened by this page that have not received an answer yet, newest first. */
const pendingTabs: SideAnswerTab[] = [];

/**
 * A side answer is prose with code and tables; it needs more room than a file
 * peek. Open the rail at this width unless the reader already chose wider.
 */
const SIDE_ANSWER_WIDTH = 560;

function ensureWidth(): void {
	// The panel is a browser surface; a non-DOM caller (a unit test, a future
	// headless host) still gets the tab and its state.
	if (typeof window === "undefined") return;
	if ((getState().ui.previewWidth ?? PREVIEW_MIN) < SIDE_ANSWER_WIDTH) applyPreviewWidth(SIDE_ANSWER_WIDTH);
}

function tab(answer: SideAnswer): SideAnswerTab {
	return {
		kind: "btw",
		id: answer.id,
		question: answer.question,
		text: answer.text,
		...(answer.model ? { model: answer.model } : {}),
		...(answer.unavailable ? { unavailable: true } : {}),
		createdAt: answer.createdAt,
	};
}

/** The tab a question was opened for, so the answer lands where the reader looked. */
function takePending(question: string): SideAnswerTab | undefined {
	const index = pendingTabs.findIndex((item) => item.question === question);
	if (index < 0) return undefined;
	return pendingTabs.splice(index, 1)[0];
}

/**
 * Ask a `/btw` side question.
 *
 * It is not a message: the tab opens first (so the reader sees where the answer
 * will appear and a waiting state), and the question goes to the kernel command
 * that owns the side-question logic. The conversation, its entries and the
 * model's context are untouched, and the request is not queued behind a running
 * turn — asking while work continues is the point.
 */
export async function askSideQuestion(question: string): Promise<boolean> {
	const asked = question.trim();
	if (!asked) return false;
	beginSideAnswer(asked);
	try {
		// Not the side question: a session's own title comes from its first prompt.
		const session = await createSessionIfNeeded();
		await api(`/api/v1/sessions/${encodeURIComponent(session.id)}/messages`, {
			method: "POST",
			body: JSON.stringify({ text: `/btw ${asked}`, attachments: [], files: [] }),
		});
		return true;
	} catch (error) {
		failSideAnswer(asked, errorMessage(error));
		return false;
	}
}

/**
 * Open a tab for a question that was just sent. Returns its id; the rail shows
 * the question with a waiting state until `applySideAnswer` fills it in.
 */
export function beginSideAnswer(question: string): string {
	const id = `pending-${pendingTabs.length}-${Date.now()}`;
	const tab: SideAnswerTab = {
		kind: "btw",
		id,
		question,
		text: "",
		createdAt: Date.now(),
		pending: true,
	};
	pendingTabs.push(tab);
	ensureWidth();
	setPreview((preview) => {
		const tabs = [...preview.tabs, tab];
		return { ...preview, tabs, active: tabs.length - 1, open: true, mode: "files" };
	});
	return id;
}

/** The question could not be sent (no session, transport error): say so in its tab. */
export function failSideAnswer(question: string, message: string): void {
	const pending = takePending(question);
	const id = pending?.id ?? `pending-${Date.now()}`;
	setPreview((preview) => ({
		...preview,
		tabs: preview.tabs.map((item) =>
			item.kind === "btw" && item.id === id ? { ...item, pending: false, unavailable: true, text: message } : item,
		),
	}));
}

/** File one answer: replace the waiting tab for its question, or append a new one. */
export function openSideAnswerTab(answer: SideAnswer): void {
	const pending = takePending(answer.question);
	const next = tab(answer);
	ensureWidth();
	setPreview((preview) => {
		if (pending) {
			const index = preview.tabs.findIndex((item) => item.kind === "btw" && item.id === pending.id);
			if (index >= 0) {
				return {
					...preview,
					tabs: preview.tabs.map((item, position) => (position === index ? next : item)),
					active: index,
					open: true,
					mode: "files",
				};
			}
		}
		const existing = preview.tabs.findIndex((item) => item.kind === "btw" && item.id === answer.id);
		const tabs =
			existing < 0
				? [...preview.tabs, next]
				: preview.tabs.map((item, position) => (position === existing ? next : item));
		return { ...preview, tabs, active: existing < 0 ? tabs.length - 1 : existing, open: true, mode: "files" };
	});
}

/**
 * Restore a reloaded session's answers without taking the reader off an open
 * file: the page had nothing to look at, so it lands on the newest answer,
 * otherwise the open tab keeps its place.
 */
export function syncSideAnswerTabs(answers: readonly SideAnswer[]): void {
	if (!answers.length) return;
	setPreview((preview) => {
		const known = new Set(preview.tabs.flatMap((item) => (item.kind === "btw" ? [item.id] : [])));
		const missing = answers.filter((answer) => !known.has(answer.id));
		if (!missing.length) return preview;
		const tabs = [...preview.tabs, ...missing.map(tab)];
		if (!preview.tabs.length) return { ...preview, tabs, active: tabs.length - 1, open: true, mode: "files" };
		return { ...preview, tabs };
	});
}

/** Forget the previous session's answers when the page follows another session. */
export function dropSideAnswerTabs(): void {
	pendingTabs.length = 0;
	setPreview((preview) => {
		const tabs = preview.tabs.filter((item) => item.kind !== "btw");
		if (tabs.length === preview.tabs.length) return preview;
		const active = Math.max(0, Math.min(preview.active, tabs.length - 1));
		return { ...preview, tabs, active: tabs.length ? active : -1, open: tabs.length ? preview.open : false };
	});
}

/** Close this session's answers and tell the host to forget them. */
export async function clearSideAnswers(): Promise<void> {
	pendingTabs.length = 0;
	setPreview((preview) => {
		const tabs = preview.tabs.filter((item) => item.kind !== "btw");
		const active = Math.max(0, Math.min(preview.active, tabs.length - 1));
		return { ...preview, tabs, active: tabs.length ? active : -1, open: tabs.length ? preview.open : false };
	});
	const current = getState().current;
	if (!current) return;
	await api(`/api/v1/sessions/${encodeURIComponent(current.id)}/side-answers/clear`, {
		method: "POST",
		body: "{}",
	});
}

// `state/session.ts` cannot import a feature; this is the one direction it needs.
installSideAnswerTabs({ open: openSideAnswerTab, sync: syncSideAnswerTabs, drop: dropSideAnswerTabs });
