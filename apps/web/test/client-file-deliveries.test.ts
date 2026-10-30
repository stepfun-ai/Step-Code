import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { artifactKind, localFileReference, workspaceFilePath, workspaceFileReference } from "../client/src/lib/file-references.ts";
import { markdownFileReferences } from "../client/src/lib/markdown.ts";
import { MarkdownContent } from "../client/src/ui/MarkdownView/markdown-content.ts";
import { turnArtifacts, withTurnChanges } from "../client/src/features/conversation/turn-artifacts.ts";
import { collectTurnFooters } from "../client/src/features/conversation/turn-footers.ts";
import { openFileReference, toggleDeliveryFile } from "../client/src/features/files/actions.ts";
import { activeRightPanel, openRightPanel } from "../client/src/state/right-panel.ts";
import { createInitialState, getState, setState } from "../client/src/state/store.ts";
import type { TimelineItem } from "../client/src/state/types.ts";

const labels = { code: "Code", copy: "Copy", table: "Table", diagram: "Diagram" };

function renderMarkdown(source: string, options: { readonly localFiles?: boolean } = {}): string {
	return renderToStaticMarkup(createElement(MarkdownContent, { source, labels, ...options }));
}
afterEach(() => { mock.restoreAll(); setState(createInitialState()); });

test("normalizes Windows, encoded file URLs, line suffixes and relative preview links", () => {
	for (const reference of ["D:\\Work\\Output\\report.md:12:3", "file:///D:/Work/Output/report.md#L12", "/D:/Work/Output/report.md", "./Output/report.md"]) {
		assert.equal(workspaceFileReference("D:/Work", reference), "Output/report.md");
	}
	assert.equal(workspaceFileReference("d:/WORK", "D:/Work/report.md"), "report.md");
	assert.equal(workspaceFileReference("D:/Work", "<invalid>"), undefined);
	assert.equal(workspaceFileReference("/work", "../picture.png", "docs/guide.md"), "picture.png");
	assert.equal(workspaceFileReference("/work", "report%20one.md"), "report one.md");
	assert.equal(workspaceFileReference("/work", "report%2520.md"), "report%20.md");
	assert.equal(workspaceFilePath("/work", "report%20.md"), "report%20.md");
	assert.equal(workspaceFileReference("/work", "report%23one.md"), "report#one.md");
});

test("rejects unsafe schemes, network shares, malformed encodings and workspace escapes", () => {
	for (const reference of ["javascript:alert(1)", "data:text/html,x", "//server/share/report.md", "\\\\server\\share\\report.md", "file://server/report.md", "report%00.md", "report%0a.md", "bad%.md"]) {
		assert.equal(localFileReference(reference), undefined, reference);
	}
	for (const reference of ["D:/Other/report.md", "D:/Workshop/report.md", "C:/Work/report.md", "../report.md", "%2e%2e/report.md", "/etc/passwd"]) {
		assert.equal(workspaceFileReference("D:/Work", reference), undefined, reference);
	}
	assert.equal(workspaceFileReference("/Work", "/work/report.md"), undefined, "POSIX paths remain case-sensitive");
});

test("file references are opt-in keyboard buttons, not browser file navigation", () => {
	const text = "[Report](<file:///D:/Work/report%20one.md>) and `Output/report.md:10`";
	const html = renderMarkdown(text, { localFiles: true });
	assert.match(html, /<button type="button" class="md-file-reference" data-file-path="file:\/\/\/D:\/Work\/report%20one.md">Report<\/button>/);
	assert.match(html, /<code>Output\/report.md:10<\/code>/);
	assert.doesNotMatch(html, /data-file-path="Output/);
	assert.doesNotMatch(html, /href="file:/);
	assert.doesNotMatch(renderMarkdown(text), /md-file-reference/);
});

test("delivery recognition shares renderer parsing and ignores complete or unfinished code fences", () => {
	const references = markdownFileReferences("[Report][out]\n\n[out]: <output/report one.md>\n\n`output/chart.png`\n\n~~~md\n[Fake](fake.md)\n~~~\n\n```md\n[Also fake](fake2.md)");
	assert.deepEqual(references, [
		{ path: "output/report one.md", label: "Report", inlineCode: false },
		{ path: "output/chart.png", label: "output/chart.png", inlineCode: true },
	]);
	assert.deepEqual(markdownFileReferences("[Incomplete](output/report.md"), []);
	assert.deepEqual(markdownFileReferences("x".repeat(200_001)), []);
});

test("recognizes bounded turn outputs from explicit references and successful structured mutations", () => {
	const items: TimelineItem[] = [
		{ kind: "message", itemId: "u1", role: "user", content: "Create outputs" },
		{ kind: "tool", itemId: "t1", toolName: "write", state: "completed", inputSummary: "", outputSummary: "", args: { path: "output/report.md" } },
		{ kind: "tool", itemId: "t2", toolName: "write", state: "failed", inputSummary: "", outputSummary: "", args: { path: "output/failure.md" } },
		{ kind: "tool", itemId: "t3", toolName: "read", state: "completed", inputSummary: "", outputSummary: "", args: { path: "example.md" } },
		{ kind: "tool", itemId: "t4", toolName: "bash", state: "completed", inputSummary: "", outputSummary: "Created pretend.pdf" },
		{ kind: "message", itemId: "a1", role: "assistant", content: "Delivery: `report.md`. [Image](output/chart.png) [Outside](D:/Secret/secret.pdf) `pretend.pdf` `src/index.ts`" },
	];
	const [footer] = collectTurnFooters(items, "idle", false);
	assert.deepEqual(turnArtifacts(items, footer, "D:/Work"), [
		{ path: "output/report.md", label: "report.md", kind: "document", turnId: "u1" },
		{ path: "output/chart.png", label: "Image", kind: "image", turnId: "u1" },
	]);
	assert.equal(artifactKind("slides.PPTX"), "presentation");
	assert.equal(artifactKind("data.csv"), "spreadsheet");
	assert.equal(artifactKind("song.mp3"), "audio");
});

test("ambiguous basenames are not guessed and outputs do not leak between turns", () => {
	const items: TimelineItem[] = [
		{ kind: "message", itemId: "u1", role: "user", content: "Create" },
		...["a/report.md", "b/report.md"].map((path, index) => ({
			kind: "tool" as const, itemId: `t${index}`, toolName: "write", state: "completed" as const, inputSummary: "", outputSummary: "", args: { path },
		})),
		{ kind: "message", itemId: "a1", role: "assistant", content: "`report.md`" },
		{ kind: "message", itemId: "u2", role: "user", content: "Thanks" },
		{ kind: "message", itemId: "a2", role: "assistant", content: "`report.md`" },
	];
	const footers = collectTurnFooters(items, "idle", false);
	assert.deepEqual(turnArtifacts(items, footers[0], "/work").map((artifact) => artifact.path), ["a/report.md", "b/report.md"]);
	assert.deepEqual(turnArtifacts(items, footers[1], "/work"), []);
});

test("reference actions reuse canonical tabs, open Markdown rendered and refuse escapes without fetch", async () => {
	setState({ ...createInitialState(), current: { id: "one", cwd: "D:/Work", status: "idle" } });
	const fetch = mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ kind: "text", path: "report.md", size: 8, content: "# Report" })));
	await openFileReference("D:/Work", "file:///D:/Work/report.md");
	assert.equal(activeRightPanel(getState()), "files");
	assert.equal(getState().preview.tabs[0].path, "report.md");
	assert.equal(getState().preview.tabs[0].rendered, true);
	await openFileReference("D:/Work", "d:\\work\\report.md:12");
	assert.equal(getState().preview.tabs.length, 1);
	assert.equal(fetch.mock.calls.length, 1);
	await openFileReference("D:/Work", "../secret.md");
	assert.equal(fetch.mock.calls.length, 1);
	assert.ok(getState().toast?.message);
});

test("missing files retain a visible preview error, never a false success", async () => {
	setState(createInitialState());
	mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: "File no longer exists" }), { status: 404 }));
	await openFileReference("/work", "gone.md");
	assert.equal(getState().preview.tabs[0].error, "File no longer exists");
	assert.equal(getState().preview.tabs[0].file, null);
});

test("delivery triggers toggle their selected preview without dropping tabs or closing other panels", async () => {
	setState(createInitialState());
	const fetch = mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
		kind: "text", path: "report.md", size: 8, content: "# Report",
	})));
	await toggleDeliveryFile("/work", "report.md");
	assert.equal(activeRightPanel(getState()), "files");
	assert.equal(getState().preview.tabs[0].rendered, true);
	await toggleDeliveryFile("/work", "report.md");
	assert.equal(activeRightPanel(getState()), null);
	assert.equal(getState().preview.tabs.length, 1);
	await toggleDeliveryFile("/work", "report.md");
	assert.equal(activeRightPanel(getState()), "files");
	assert.equal(fetch.mock.calls.length, 1, "Reopening retains loaded content");
	await toggleDeliveryFile("/work", "other.md");
	assert.equal(activeRightPanel(getState()), "files");
	assert.equal(getState().preview.tabs[getState().preview.active].path, "other.md");
	openRightPanel("summary");
	await toggleDeliveryFile("/work", "other.md");
	assert.equal(activeRightPanel(getState()), "files", "Another panel must switch to the file, not close");
	await toggleDeliveryFile("/another-workspace", "other.md");
	assert.equal(activeRightPanel(getState()), "files");
	assert.equal(getState().preview.tabs[getState().preview.active].cwd, "/another-workspace");
});

test("artifact recognition keeps one cached result per turn, even past dozens of turns", () => {
	const items: TimelineItem[] = [];
	for (let turn = 0; turn < 40; turn++) {
		items.push(
			{ kind: "message", itemId: `u${turn}`, entryId: `u${turn}`, role: "user", content: "Write it." },
			{ kind: "message", itemId: `a${turn}`, entryId: `a${turn}`, role: "assistant", content: `See [report](out/report-${turn}.md).` },
		);
	}
	const footers = collectTurnFooters(items, "idle", false);
	assert.equal(footers.length, 40);
	const first = footers.map((footer) => turnArtifacts(items, footer, "/work"));
	const again = footers.map((footer) => turnArtifacts(items, footer, "/work"));
	assert.deepEqual(first.map((artifacts) => artifacts.map((artifact) => artifact.path)), footers.map((_footer, turn) => [`out/report-${turn}.md`]));
	// The same arrays come back: no turn was evicted and re-parsed.
	for (const [index, artifacts] of again.entries()) assert.equal(artifacts, first[index]);
});

test("a delivery carries its own turn's change, matched across the tool's path spelling", () => {
	const file = { path: ".\\site\\index.html", patches: ["@@ -1 +1 @@\n-a\n+b\n"], additions: 1, deletions: 1 };
	const turn = { turnId: "u2", ordinal: 2, latest: true, lastIndex: 5, files: [file], additions: 1, deletions: 1 };
	const artifacts = [
		{ path: "site/index.html", label: "Snake", kind: "website" as const, turnId: "u2" },
		{ path: "notes.md", label: "notes.md", kind: "document" as const, turnId: "u2" },
	];
	const attached = withTurnChanges(artifacts, turn, "D:/Work");
	assert.deepEqual(attached[0]?.change, { turnId: "u2", file });
	assert.equal(attached[1], artifacts[1], "a file the turn only referenced keeps no change");
	// Stream frames reuse the inputs, and then the result too.
	assert.equal(withTurnChanges(artifacts, turn, "D:/Work"), attached);
	assert.equal(withTurnChanges(artifacts, undefined, "D:/Work"), artifacts);
	assert.equal(withTurnChanges(artifacts, { ...turn, files: [] }, "D:/Work"), artifacts);
});
