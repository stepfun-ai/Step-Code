import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { encodeSitePath, parseSitePath, SitePreviewServer, siteContentType } from "../src/site-preview.ts";

async function site() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "stepcode-site-")));
	const outside = await realpath(await mkdtemp(join(tmpdir(), "stepcode-site-outside-")));
	await mkdir(join(root, "game", "assets"), { recursive: true });
	await writeFile(join(root, "game", "index.html"), '<link rel="stylesheet" href="assets/app.css"><h1>Snake</h1>');
	await writeFile(join(root, "game", "assets", "app.css"), "h1 { color: red }");
	await writeFile(join(root, "中文 页面.html"), "<p>hi</p>");
	await writeFile(join(outside, "secret.txt"), "secret");
	const server = new SitePreviewServer();
	return {
		root,
		outside,
		server,
		cleanup: async () => {
			await server.close();
			await rm(root, { recursive: true, force: true });
			await rm(outside, { recursive: true, force: true });
		},
	};
}

test("site paths decode per segment and refuse traversal or smuggled separators", () => {
	assert.deepEqual(parseSitePath("/tok/game/index.html"), { token: "tok", segments: ["game", "index.html"] });
	assert.deepEqual(parseSitePath("/tok/%E4%B8%AD%E6%96%87%20a.html"), { token: "tok", segments: ["中文 a.html"] });
	assert.deepEqual(parseSitePath("/tok/"), { token: "tok", segments: [] });
	assert.equal(parseSitePath("/tok/../x"), undefined);
	assert.equal(parseSitePath("/tok/a%2F..%2Fb"), undefined);
	assert.equal(parseSitePath("/tok/a%5Cb"), undefined);
	assert.equal(parseSitePath("/tok/C%3A"), undefined);
	assert.equal(parseSitePath("/tok/%E0%A4%A"), undefined);
	assert.equal(parseSitePath("/"), undefined);
	assert.equal(encodeSitePath("game\\中文 a.html"), "game/%E4%B8%AD%E6%96%87%20a.html");
	assert.equal(siteContentType("A.HTML"), "text/html; charset=utf-8");
	assert.equal(siteContentType("x.unknown"), "application/octet-stream");
});

test("a workspace file is served with its relative assets under one unguessable token", async () => {
	const { root, server, cleanup } = await site();
	try {
		const page = await server.url(root, "game/index.html");
		// `localhost`, a different site from the client's 127.0.0.1: an embedded preview gets its own process.
		assert.match(page, /^http:\/\/localhost:\d+\/[\w-]{32}\/game\/index\.html$/);
		const response = await fetch(page);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
		assert.equal(response.headers.get("referrer-policy"), "no-referrer");
		assert.match(await response.text(), /Snake/);
		const css = await fetch(new URL("assets/app.css", page));
		assert.equal(css.headers.get("content-type"), "text/css; charset=utf-8");
		assert.equal(await css.text(), "h1 { color: red }");
		// The folder serves its index page; it is never listed.
		assert.match(await (await fetch(new URL("./", page))).text(), /Snake/);
		const token = new URL(page).pathname.split("/")[1];
		const rootListing = await fetch(new URL(`/${token}/`, page));
		assert.equal(rootListing.status, 404);
		// The same workspace keeps its token; non-ASCII names round-trip.
		const other = await server.url(root, "中文 页面.html");
		assert.equal(new URL(other).pathname.split("/")[1], token);
		assert.equal(await (await fetch(other)).text(), "<p>hi</p>");
		assert.equal((await fetch(page, { method: "HEAD" })).status, 200);
		assert.equal((await fetch(page, { method: "POST" })).status, 405);
	} finally {
		await cleanup();
	}
});

test("nothing outside the workspace or without the token is served", async () => {
	const { root, outside, server, cleanup } = await site();
	try {
		await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
		const page = new URL(await server.url(root, "game/index.html"));
		const token = page.pathname.split("/")[1];
		assert.equal((await fetch(new URL("/not-a-token/game/index.html", page))).status, 404);
		assert.equal((await fetch(new URL(`/${token}/link.txt`, page))).status, 404);
		assert.equal((await fetch(new URL(`/${token}/game/%2E%2E/%2E%2E/x`, page))).status, 404);
		await assert.rejects(server.url(root, "../x.html"));
		await assert.rejects(server.url(root, "link.txt"), /outside the workspace/);
		await assert.rejects(server.url(root, "game"), /not a file/);
	} finally {
		await cleanup();
	}
});

test("an earlier version is served from memory beside the file, with one URL per version", async () => {
	const { root, server, cleanup } = await site();
	try {
		const current = await server.url(root, "game/index.html");
		const earlier = await server.versionUrl(root, "game/index.html", "<h1>Earlier</h1>");
		assert.match(earlier, /\/game\/index\.html\?rev=[\w-]{24}$/);
		assert.equal(new URL(earlier).pathname, new URL(current).pathname);
		assert.equal(await server.versionUrl(root, "game/index.html", "<h1>Earlier</h1>"), earlier);
		assert.notEqual(await server.versionUrl(root, "game/index.html", "<h1>Other</h1>"), earlier);
		const response = await fetch(earlier);
		assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
		assert.equal(response.headers.get("cache-control"), "no-store");
		assert.equal(await response.text(), "<h1>Earlier</h1>");
		// Relative assets still come from disk; the plain URL still serves the current file.
		assert.equal(await (await fetch(new URL("assets/app.css", earlier))).text(), "h1 { color: red }");
		assert.match(await (await fetch(current)).text(), /Snake/);
		// A version id names one file only.
		const rev = new URL(earlier).search;
		const elsewhere = new URL(await server.url(root, "中文 页面.html"));
		assert.equal((await fetch(`${elsewhere.origin}${elsewhere.pathname}${rev}`)).status, 404);
		assert.equal((await fetch(`${new URL(current).origin}${new URL(current).pathname}?rev=unknown`)).status, 404);
	} finally {
		await cleanup();
	}
});
