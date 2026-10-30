import assert from "node:assert/strict";
import { test } from "node:test";
import {
	guestNavigationAllowed,
	guestRequestBlocked,
	guestShortcut,
	leaseFromStartUrl,
} from "../src/browser-guest-policy.ts";

test("guest main frames go only to http(s) without embedded credentials", () => {
	assert.equal(guestNavigationAllowed("https://example.com/path"), true);
	assert.equal(guestNavigationAllowed("http://localhost:5173/"), true);
	assert.equal(guestNavigationAllowed("https://user:secret@example.com/"), false);
	assert.equal(guestNavigationAllowed("file:///etc/passwd"), false);
	assert.equal(guestNavigationAllowed("javascript:alert(1)"), false);
	assert.equal(guestNavigationAllowed("not a url"), false);
});

test("guest requests never reach a Host port, on any hostname or scheme", () => {
	const host = [51234];
	for (const url of [
		"http://127.0.0.1:51234/api/v1/sessions",
		"http://localhost:51234/",
		"http://[::1]:51234/",
		"http://rebound.example:51234/",
		"ws://127.0.0.1:51234/socket",
	]) {
		assert.equal(guestRequestBlocked(url, host), true, url);
	}
	// A preview origin or dev server on another port stays reachable.
	assert.equal(guestRequestBlocked("http://localhost:61000/token/index.html", host), false);
	assert.equal(guestRequestBlocked("https://example.com/", host), false);
	// The default port counts: a Host on 443 blocks plain https.
	assert.equal(guestRequestBlocked("https://example.com/", [443]), true);
	assert.equal(guestRequestBlocked("wss://example.com/", [443]), true);
});

test("guest requests keep inert local documents and refuse privileged schemes and credentials", () => {
	for (const url of ["about:blank#lease", "data:text/html,hi", "blob:https://example.com/0f0"]) {
		assert.equal(guestRequestBlocked(url, []), false, url);
	}
	for (const url of ["file:///Users/me/.ssh/id_rsa", "chrome://settings", "devtools://devtools", "https://u:p@x.test/"]) {
		assert.equal(guestRequestBlocked(url, []), true, url);
	}
});

test("a lease is read only from the inert start document", () => {
	const lease = "0f8fad5b-d9cb-469f-a165-70867728950e";
	assert.equal(leaseFromStartUrl(`about:blank#${lease}`), lease);
	assert.equal(leaseFromStartUrl(`https://example.com/#${lease}`), undefined);
	assert.equal(leaseFromStartUrl("about:blank#not-a-lease"), undefined);
	assert.equal(leaseFromStartUrl("about:blank"), undefined);
});

test("panel shortcuts are Cmd on macOS and Ctrl elsewhere, with no other modifier", () => {
	const key = { type: "keyDown", key: "r", control: false, meta: false, alt: false, shift: false };
	assert.equal(guestShortcut({ ...key, meta: true }, "darwin"), "r");
	assert.equal(guestShortcut({ ...key, key: "W", meta: true }, "darwin"), "w");
	assert.equal(guestShortcut({ ...key, control: true }, "darwin"), undefined);
	assert.equal(guestShortcut({ ...key, control: true }, "win32"), "r");
	assert.equal(guestShortcut({ ...key, key: "l", control: true }, "linux"), "l");
	assert.equal(guestShortcut({ ...key, meta: true }, "win32"), undefined);
	// Shift/Alt chords and other keys belong to the page; key-up never triggers.
	assert.equal(guestShortcut({ ...key, meta: true, shift: true }, "darwin"), undefined);
	assert.equal(guestShortcut({ ...key, meta: true, alt: true }, "darwin"), undefined);
	assert.equal(guestShortcut({ ...key, key: "c", meta: true }, "darwin"), undefined);
	assert.equal(guestShortcut({ ...key, type: "rawKeyDown", meta: true }, "darwin"), "r");
	assert.equal(guestShortcut({ ...key, type: "keyUp", meta: true }, "darwin"), undefined);
	assert.equal(guestShortcut({ ...key, type: "char", meta: true }, "darwin"), undefined);
});
