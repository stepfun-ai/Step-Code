import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
	addressLabel,
	browserAddress,
	clampZoom,
	isLocalAddress,
	readStoredTabs,
} from "../client/src/features/browser/address.ts";
import { closePreviewTab, showPreviewFiles } from "../client/src/features/files/actions.ts";
import { activeRightPanel, closeRightPanel, openRightPanel } from "../client/src/state/right-panel.ts";
import { createInitialState, getState, setState, setUi } from "../client/src/state/store.ts";

afterEach(() => setState(createInitialState()));

test("browser uses the shared exclusive inspector without discarding retained file tabs", () => {
	setState(createInitialState());
	setState((state) => ({
		preview: { ...state.preview, active: 0, tabs: [
			{ cwd: "/fixture", path: "notes.md", file: null, rendered: true, loading: false, error: "" },
		] },
	}));
	showPreviewFiles();
	openRightPanel("browser");
	assert.equal(activeRightPanel(getState()), "browser");
	assert.equal(getState().preview.open, false);
	assert.equal(getState().preview.tabs.length, 1);
	closePreviewTab(0);
	assert.equal(activeRightPanel(getState()), "browser");
	setUi({ rightPanelExpanded: true });
	closeRightPanel();
	assert.equal(activeRightPanel(getState()), null);
	assert.equal(getState().ui.rightPanelExpanded, false);
});

test("opening another inspector only changes presentation, not conversation selection", () => {
	setState({ ...createInitialState(), current: { id: "parent", cwd: "/fixture", status: "running" } });
	openRightPanel("browser");
	openRightPanel("context");
	assert.equal(activeRightPanel(getState()), "context");
	assert.equal(getState().current?.id, "parent");
	assert.equal(getState().current?.status, "running");
});

const APP = "http://127.0.0.1:3077";

test("the address bar accepts http(s), completes bare hosts and refuses everything else", () => {
	assert.deepEqual(browserAddress("example.com/docs", APP), { ok: true, url: "https://example.com/docs" });
	// A bare local host is a dev server or preview: plain http.
	assert.deepEqual(browserAddress("localhost:5173", APP), { ok: true, url: "http://localhost:5173/" });
	assert.deepEqual(browserAddress("127.0.0.1:8000/a", APP), { ok: true, url: "http://127.0.0.1:8000/a" });
	assert.deepEqual(browserAddress("  http://example.com  ", APP), { ok: true, url: "http://example.com/" });
	assert.deepEqual(browserAddress("", APP), { ok: false, reason: "invalid" });
	assert.deepEqual(browserAddress("http://exa mple.com", APP), { ok: false, reason: "invalid" });
	for (const blocked of ["file:///etc/passwd", "ftp://example.com/", "https://user:secret@example.com/"]) {
		assert.deepEqual(browserAddress(blocked, APP), { ok: false, reason: "blocked" }, blocked);
	}
});

test("the address bar never frames StepCode's own page, on any loopback name", () => {
	for (const own of ["http://127.0.0.1:3077/", "localhost:3077", "http://[::1]:3077/api/v1/sessions", "app.localhost:3077"]) {
		assert.deepEqual(browserAddress(own, APP), { ok: false, reason: "blocked" }, own);
	}
	// The same port on a remote host is another site.
	assert.deepEqual(browserAddress("https://example.com:3077/", APP), { ok: true, url: "https://example.com:3077/" });
	// A preview origin on its own port stays loadable.
	assert.equal(browserAddress("http://localhost:61000/token/index.html", APP).ok, true);
});

test("stored tabs are validated before a reload reopens them", () => {
	const raw = JSON.stringify({
		activeId: "b",
		tabs: [
			{ id: "a", url: "https://example.com/", title: "Example", zoom: 1.24 },
			{ id: "b", url: "", title: "", zoom: 9 },
			{ id: "c", url: "file:///etc/passwd", title: "", zoom: 1 },
			{ id: "d", url: "http://127.0.0.1:3077/", title: "", zoom: 1 },
			{ url: "https://no-id.example/" },
			"junk",
		],
	});
	assert.deepEqual(readStoredTabs(raw, APP), {
		activeId: "b",
		tabs: [
			{ id: "a", url: "https://example.com/", title: "Example", zoom: 1.2 },
			{ id: "b", url: "", title: "", zoom: 2 },
		],
	});
	assert.deepEqual(readStoredTabs("{not json", APP), { activeId: null, tabs: [] });
	assert.deepEqual(readStoredTabs(null, APP), { activeId: null, tabs: [] });
	// A missing active tab falls back to the last one.
	assert.equal(readStoredTabs(JSON.stringify({ activeId: "gone", tabs: [{ id: "x", url: "" }] }), APP).activeId, "x");
});

test("browser helpers: zoom steps, labels and local addresses", () => {
	assert.equal(clampZoom(0.3), 0.5);
	assert.equal(clampZoom(1.05), 1.1);
	assert.equal(clampZoom(Number.NaN), 1);
	assert.equal(addressLabel("https://example.com:8443/path"), "example.com:8443");
	assert.equal(addressLabel("not a url"), "not a url");
	assert.equal(isLocalAddress("http://localhost:5173/"), true);
	assert.equal(isLocalAddress("https://example.com/"), false);
});
