import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsx from "react/jsx-runtime";
import ts from "typescript";
import type * as Legacy from "../client/src/features/migration/LegacyHistory.tsx";
import { migrationMessages } from "../client/src/i18n/migration-messages.ts";
import * as api from "../client/src/lib/api.ts";

const source = await readFile(new URL("../client/src/features/migration/LegacyHistory.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
	compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const fetchBefore = globalThis.fetch;
after(() => { globalThis.fetch = fetchBefore; });

function harness() {
	let visible = true;
	let currentId: string | undefined;
	let openingSession: string | null = null;
	let openSucceeds = true;
	let closed = 0;
	const opens: { id: string; reportErrors?: boolean }[] = [];
	const states: unknown[] = [];
	let cursor = 0;
	let effect: (() => void | (() => void)) | undefined;
	const buttons: { readonly onClick?: () => void | Promise<void>; readonly disabled?: boolean }[] = [];
	const bindings: Record<string, unknown> = {
		"react/jsx-runtime": jsx,
		react: {
			useState(initial: unknown) {
				const index = cursor++;
				if (!(index in states)) states[index] = initial;
				return [states[index], (value: unknown) => {
					states[index] = typeof value === "function" ? value(states[index]) : value;
				}];
			},
			useEffect(callback: () => void | (() => void)) { effect = callback; },
		},
		"../../i18n": { useT: () => (key: string, values: Record<string, unknown> = {}) => {
			let label = migrationMessages.en[key] ?? key;
			for (const [name, value] of Object.entries(values)) label = label.replace(`{${name}}`, String(value));
			return label;
		} },
		"../../lib/api": api,
		"../../state/session": { async openSessionWithOutcome(id: string, options: { reportErrors?: boolean }) {
			opens.push({ id, ...options });
			if (openingSession) return "superseded";
			if (openSucceeds) { currentId = id; return "opened"; }
			return "failed";
		} },
		"../../state/store": {
			useAppStore: () => visible,
			getState: () => ({ current: currentId ? { id: currentId } : null, ui: { openingSession } }),
		},
		"../../ui": {
			Button: ({ children, variant: _variant, ...props }: React.PropsWithChildren<{ variant?: string; onClick?: () => void | Promise<void>; disabled?: boolean }>) => {
				buttons.push(props);
				return React.createElement("button", props, children);
			},
			EmptyState: ({ children }: React.PropsWithChildren) => React.createElement("p", null, children),
			Spinner: () => null,
		},
		"../settings/actions": { closeSettings: () => { closed++; } },
	};
	// Run the actual TSX module with only boundary imports stubbed: no CSS, Host, HOME or providers.
	const exports: typeof Legacy = new Function("exports", "require", `${compiled}\nreturn exports;`)(
		{}, (name: string) => { assert.ok(name in bindings, `Unexpected import: ${name}`); return bindings[name]; },
	);
	return {
		exports, states, opens, buttons,
		render() { cursor = 0; buttons.length = 0; return renderToStaticMarkup(React.createElement(exports.LegacyHistory)); },
		runEffect() { return effect?.(); },
		setVisible(value: boolean) { visible = value; },
		failOpen() { openSucceeds = false; },
		setPending(value: string) { openingSession = value; },
		get closed() { return closed; },
	};
}
const fixture = {
	jobs: [{ id: "old-non-unified-id", createdAt: "2026-10-01T00:00:00Z", status: "completed", total: 4,
		results: [
			{ candidateId: "one", source: "codex", sourcePath: "/fixture/source.jsonl", cwd: "/fixture/selected", title: "Imported fixture", status: "imported", sessionId: "fixture-session", warning: "fixture-private-warning" },
			{ candidateId: "two", status: "skipped", sessionId: "do-not-open" },
			{ candidateId: "three", status: "failed", error: "fixture-private-error" },
			{ candidateId: "four", status: "future-status", sessionId: "do-not-open" },
		] }],
};

test("legacy HTTP JSON history is read-only and keeps persisted results distinct", async () => {
	const h = harness();
	const requests: { path: string; method: string }[] = [];
	globalThis.fetch = async (input, init) => {
		requests.push({ path: String(input), method: init?.method ?? "GET" });
		return Response.json(fixture);
	};
	const jobs = await h.exports.readLegacyHistory();
	assert.deepEqual(requests, [{ path: "/api/v1/session-imports", method: "GET" }]);
	assert.deepEqual(jobs[0]?.results.map((row) => row.status), ["imported", "skipped", "failed", "unknown"]);
	assert.equal(jobs[0]?.results[0]?.requestedCwd, "/fixture/selected");
	assert.equal(jobs[0]?.id, "old-non-unified-id");
	assert.doesNotMatch(JSON.stringify(jobs), /fixture-private-(?:error|warning)/u);
	h.states[0] = jobs;
	h.states[2] = true;
	const html = h.render();
	assert.match(html, /Earlier session import history/u);
	assert.match(html, /Explicitly selected directory \(may not be the actual target\)/u);
	assert.match(html, /does not confirm the actual target/u);
	for (const status of ["imported", "skipped", "failed", "unknown"]) {
		assert.match(html, new RegExp(`data-legacy-result-status="${status}"`, "u"));
	}
	assert.equal(html.match(/Open imported session/gu)?.length, 1);
	assert.doesNotMatch(html, /fixture-private|do-not-open|migrationLegacy[A-Z]|<button[^>]*>(?:Cancel|Retry|Re-import)/u);
});

test("unknown and malformed metadata never invent targets, statuses or successful empty history", () => {
	const h = harness();
	for (const payload of [null, [], {}, { jobs: null }, { jobs: {} }]) {
		assert.throws(() => h.exports.parseLegacyHistory(payload), /legacy-history-invalid/u);
	}
	const jobs = h.exports.parseLegacyHistory({ jobs: [
		{ status: "future-job", total: -1, createdAt: "bad date", results: [null, { status: "imported", sessionId: "../unsafe?secret=fixture", source: { toString: {} }, cwd: 123 }] },
		null, { status: "cancelled", results: fixture.jobs[0].results },
		{ status: "interrupted", results: [{ status: "imported", sessionId: "saved-session" }] },
	] });
	assert.equal(jobs[0]?.status, "unknown");
	assert.equal(jobs[0]?.total, undefined);
	assert.equal(jobs[0]?.createdAt, undefined);
	assert.equal(jobs[0]?.results[0]?.status, "unknown");
	assert.equal(jobs[0]?.results[1]?.sessionId, undefined);
	assert.equal(jobs[0]?.results[1]?.source, undefined);
	assert.equal(jobs[0]?.results[1]?.requestedCwd, undefined);
	assert.equal(jobs[1]?.resultsUnknown, true);
	assert.equal(jobs[2]?.results.length, 4);
	assert.equal(jobs[3]?.results[0]?.sessionId, "saved-session");
	h.states[0] = jobs;
	h.states[2] = true;
	const html = h.render();
	assert.match(html, /results are missing or unrecognized/u);
	assert.match(html, /Old job status unknown/u);
	assert.match(html, /saved results retained/u);
	assert.doesNotMatch(html, /unsafe|bad date/u);
});

test("only confirmed imported sessions open through public lifecycle and Settings actions", async () => {
	const h = harness();
	globalThis.fetch = async () => { throw new Error("Legacy navigation must not call migration APIs"); };
	const rows = h.exports.parseLegacyHistory(fixture)[0]?.results;
	assert.ok(rows);
	for (const row of rows.slice(1)) await h.exports.openLegacySession(row);
	assert.equal(h.opens.length, 0);
	assert.ok(rows[0]);
	await h.exports.openLegacySession(rows[0]);
	assert.deepEqual(h.opens, [{ id: "fixture-session", reportErrors: false }]);
	assert.equal(h.closed, 1);
	const failed = harness();
	failed.failOpen();
	await assert.rejects(failed.exports.openLegacySession(rows[0]), /legacy-session-open-failed/u);
	assert.equal(failed.closed, 0);
	const replaced = harness();
	replaced.setPending("another-session");
	await assert.rejects(replaced.exports.openLegacySession(rows[0]), /legacy-session-open-failed/u);
	assert.equal(replaced.closed, 0);
});

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("history loads only while visible, refreshes on reopening, and retains records on read failure", async () => {
	const h = harness();
	let reads = 0;
	globalThis.fetch = async () => { reads++; return Response.json(fixture); };
	h.setVisible(false);
	h.render();
	assert.equal(h.runEffect(), undefined);
	assert.equal(reads, 0);
	h.setVisible(true);
	h.render();
	const cleanup = h.runEffect();
	await settle();
	assert.equal(reads, 1);
	assert.match(h.render(), /Imported fixture/u);
	assert.equal(typeof cleanup, "function");
	if (typeof cleanup === "function") cleanup();
	h.setVisible(false);
	h.render();
	h.runEffect();
	h.setVisible(true);
	h.render();
	globalThis.fetch = async () => { reads++; return Response.json({ error: "fixture-private-error" }, { status: 500 }); };
	h.runEffect();
	await settle();
	const html = h.render();
	assert.equal(reads, 2);
	assert.match(html, /Earlier records could not be read/u);
	assert.match(html, /Imported fixture/u);
	assert.doesNotMatch(html, /fixture-private-error|No earlier session import records/u);
});

test("late read callbacks cannot publish after history hides", async () => {
	const h = harness();
	let finish!: (response: Response) => void;
	let signal: AbortSignal | null | undefined;
	globalThis.fetch = async (_input, init) => {
		signal = init?.signal;
		return new Promise<Response>((resolve) => { finish = resolve; });
	};
	h.render();
	const cleanup = h.runEffect();
	assert.equal(typeof cleanup, "function");
	if (typeof cleanup === "function") cleanup();
	assert.equal(signal?.aborted, true);
	finish(Response.json(fixture));
	await settle();
	assert.deepEqual(h.states[0], []);
});

test("mounted history refresh and session-open failure use visible read-only feedback", async () => {
	const h = harness();
	let reads = 0;
	globalThis.fetch = async (input, init) => {
		assert.equal(String(input), "/api/v1/session-imports");
		assert.equal(init?.method ?? "GET", "GET");
		reads++;
		return Response.json(fixture);
	};
	h.render();
	const firstCleanup = h.runEffect();
	assert.match(h.render(), /Loading migration history/u);
	await settle();
	h.render();
	assert.equal(h.buttons[0]?.disabled, false);
	await h.buttons[0]?.onClick?.();
	if (typeof firstCleanup === "function") firstCleanup();
	h.render();
	h.runEffect();
	await settle();
	assert.equal(reads, 2);
	h.render();
	h.failOpen();
	await h.buttons[1]?.onClick?.();
	assert.match(h.render(), /This session could not be opened/u);
	assert.equal(h.closed, 0);
	assert.equal(reads, 2);
});

test("legacy history mounts separately and uses only paired existing i18n inputs", async () => {
	const jobView = await readFile(new URL("../client/src/features/migration/JobView.tsx", import.meta.url), "utf8");
	assert.match(jobView, /import \{ LegacyHistory \} from "\.\/LegacyHistory"/u);
	assert.match(jobView, /<LegacyHistory \/>/u);
	assert.doesNotMatch(source, /apiSend|\/api\/v1\/migrations|attachMigrationJob|stopMigrationJob|retryMigrationFailures|\.error\}|\.warning\}|from "\.\.\/settings\/(?!actions)/u);
	assert.deepEqual(Object.keys(migrationMessages.zh).sort(), Object.keys(migrationMessages.en).sort());
	for (const key of Object.keys(migrationMessages.zh).filter((key) => key.startsWith("migrationLegacy"))) {
		assert.ok(migrationMessages.en[key]);
	}
});
