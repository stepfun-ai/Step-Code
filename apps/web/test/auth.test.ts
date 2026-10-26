import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebAuth } from "../src/auth.ts";

test("launch token exchanges once and authorizes only local origins", () => {
	const auth = new WebAuth(["http://127.0.0.1:3077"]);
	const token = auth.getLaunchToken();
	const cookie = auth.exchange(token, "http://127.0.0.1:3077");

	assert.ok(cookie);
	assert.equal(auth.exchange(token, "http://127.0.0.1:3077"), undefined);
	assert.equal(auth.authorize(cookie, "http://127.0.0.1:3077"), true);
	assert.equal(auth.authorize(cookie, "http://evil.example"), false);
	assert.equal(auth.authorize(undefined, "http://127.0.0.1:3077"), false);
	assert.equal(auth.allowsOrigin("http://127.0.0.1:3077"), true);
	assert.equal(auth.allowsOrigin("http://evil.example"), false);
});

test("origin-less requests remain compatible with same-origin clients", () => {
	const auth = new WebAuth(["http://127.0.0.1:3077"]);
	const cookie = auth.exchange(auth.getLaunchToken(), undefined);

	assert.ok(cookie);
	assert.equal(auth.authorize(cookie, undefined), true);
});

test("same-site pages on other loopback ports cannot ride the cookie", () => {
	const auth = new WebAuth(["http://127.0.0.1:3077"]);
	const cookie = auth.exchange(auth.getLaunchToken(), undefined);

	assert.ok(cookie);
	assert.equal(auth.authorize(cookie, undefined, "same-origin"), true);
	assert.equal(auth.authorize(cookie, undefined, "none"), true);
	// An <img> or navigation from a rendered preview on 127.0.0.1:<other port> sends no Origin.
	assert.equal(auth.authorize(cookie, undefined, "same-site"), false);
	assert.equal(auth.authorize(cookie, undefined, "cross-site"), false);
});

test("a persisted secret keeps issued cookies valid across a restart", () => {
	const directory = mkdtempSync(join(tmpdir(), "stepcode-web-auth-"));
	const secretPath = join(directory, "web-auth-secret");
	try {
		const before = new WebAuth(["http://127.0.0.1:3077"], secretPath);
		const cookie = before.exchange(before.getLaunchToken(), "http://127.0.0.1:3077");
		assert.ok(cookie);

		// A new process is a new WebAuth instance but the same stored secret, so a
		// cookie the browser already holds must keep verifying.
		const after = new WebAuth(["http://127.0.0.1:3077"], secretPath);
		assert.equal(after.authorize(cookie, "http://127.0.0.1:3077"), true);
		// The launch token stays per-process and single-use regardless.
		assert.equal(after.exchange(before.getLaunchToken(), "http://127.0.0.1:3077"), undefined);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("an unwritable secret path falls back to an in-memory secret", () => {
	const auth = new WebAuth(["http://127.0.0.1:3077"], join(tmpdir(), "stepcode-web-auth-missing-dir", "nested", "secret"));
	const cookie = auth.exchange(auth.getLaunchToken(), "http://127.0.0.1:3077");

	assert.ok(cookie);
	assert.equal(auth.authorize(cookie, "http://127.0.0.1:3077"), true);
});
