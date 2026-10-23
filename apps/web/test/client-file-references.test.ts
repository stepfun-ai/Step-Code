import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { resolveFileReference } from "../client/src/lib/file-references.ts";
import { openFileReference } from "../client/src/features/files/actions.ts";
import { activeRightPanel } from "../client/src/state/right-panel.ts";
import { createInitialState, getState, setState } from "../client/src/state/store.ts";

afterEach(() => {
	mock.restoreAll();
	setState(createInitialState());
});

test("references inside the workspace stay workspace paths; absolute ones resolve anywhere", () => {
	assert.deepEqual(resolveFileReference("/work", "docs/guide.md"), { scope: "workspace", path: "docs/guide.md" });
	assert.deepEqual(resolveFileReference("/work", "/work/report.md"), { scope: "workspace", path: "report.md" });
	assert.deepEqual(resolveFileReference("/work", "/Users/me/Desktop/notes.md"), {
		scope: "local",
		path: "/Users/me/Desktop/notes.md",
	});
	assert.deepEqual(resolveFileReference("/work", "file:///Users/me/Desktop/notes.md"), {
		scope: "local",
		path: "/Users/me/Desktop/notes.md",
	});
	assert.deepEqual(resolveFileReference("/work", "/Users/me/Desktop/../Desktop/notes.md"), {
		scope: "local",
		path: "/Users/me/Desktop/notes.md",
	});
	// A Windows drive path is a local file only for a Windows workspace, and a
	// POSIX path only for a POSIX workspace.
	assert.equal(resolveFileReference("/work", "D:/Other/report.md"), undefined);
	assert.deepEqual(resolveFileReference("D:/Work", "D:/Other/report.md"), {
		scope: "local",
		path: "D:/Other/report.md",
	});
	assert.deepEqual(resolveFileReference("D:/Work", "E:/Output/report.md"), {
		scope: "local",
		path: "E:/Output/report.md",
	});
});

test("relative references resolve only beside an absolute source file, never from a message alone", () => {
	assert.equal(resolveFileReference("/work", "../secret.md"), undefined);
	assert.deepEqual(resolveFileReference("/work", "sibling.md", "/Users/me/Desktop/guide.md"), {
		scope: "local",
		path: "/Users/me/Desktop/sibling.md",
	});
	assert.deepEqual(resolveFileReference("/work", "../notes/intro.md", "/Users/me/Desktop/guide.md"), {
		scope: "local",
		path: "/Users/me/notes/intro.md",
	});
	// Links in a previewed file that land back inside the workspace stay workspace paths.
	assert.deepEqual(resolveFileReference("/Users/me/work", "../src/app.ts", "/Users/me/work/docs/guide.md"), {
		scope: "workspace",
		path: "src/app.ts",
	});
	assert.deepEqual(resolveFileReference("/work", "../picture.png", "docs/guide.md"), {
		scope: "workspace",
		path: "picture.png",
	});
});

test("an outside reference opens a read-only local tab instead of an error", async () => {
	setState({ ...createInitialState(), current: { id: "one", cwd: "/work", status: "idle" } });
	const fetch = mock.method(
		globalThis,
		"fetch",
		async () =>
			new Response(JSON.stringify({ kind: "text", path: "/Users/me/Desktop/notes.md", size: 6, content: "# Note" })),
	);
	await openFileReference("/work", "/Users/me/Desktop/notes.md");
	assert.equal(activeRightPanel(getState()), "files");
	const tab = getState().preview.tabs[0];
	assert.equal(tab.scope, "local");
	assert.equal(tab.path, "/Users/me/Desktop/notes.md");
	assert.equal(tab.rendered, true);
	assert.equal(tab.file?.kind, "text");
	assert.equal(fetch.mock.calls.length, 1);
	assert.match(String(fetch.mock.calls[0].arguments[0]), /\/api\/v1\/file\?path=/);
	// The same reference reuses its tab; an unresolvable reference still errors without fetching.
	await openFileReference("/work", "/Users/me/Desktop/notes.md");
	assert.equal(getState().preview.tabs.length, 1);
	assert.equal(fetch.mock.calls.length, 1);
	await openFileReference("/work", "../secret.md");
	assert.equal(fetch.mock.calls.length, 1);
	assert.ok(getState().toast?.message);
});
