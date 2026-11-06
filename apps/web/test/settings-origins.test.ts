import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { marketplaceOrigin, resolvePluginOrigins } from "../src/settings-origins.ts";

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "stepcode-origins-"));
	const installed = join(root, "installed", "example");
	const market = join(root, "market");
	const source = join(market, "plugins", "example");
	await mkdir(installed, { recursive: true });
	await mkdir(source, { recursive: true });
	for (const directory of [installed, source]) await writeFile(join(directory, "step.plugin.json"), '{"id":"example"}');
	const plugin = { id: "example", name: "Example", rootPath: installed, source: "user" as const, mcpServers: [], warnings: [] };
	const entry = { name: "example", sourcePath: source, marketplace: "builtin", declaration: {} };
	const sourceInfo = { name: "builtin", path: market, kind: "builtin" as const, origin: null };
	return { root, installed, source, plugin, entry, sourceInfo };
}

test("only actual matching files inherit a configured market source", async () => {
	const f = await fixture();
	try {
		let origins = await resolvePluginOrigins([f.plugin], [f.entry], [f.sourceInfo], true);
		assert.equal(origins.get("example"), "stepcode");
		await writeFile(join(f.installed, "step.plugin.json"), '{"id":"example","description":"custom"}');
		origins = await resolvePluginOrigins([f.plugin], [f.entry], [f.sourceInfo], true);
		assert.equal(origins.get("example"), "custom");
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("a third-party market named builtin is not an official source", async () => {
	const f = await fixture();
	try {
		const local = { ...f.sourceInfo, kind: "local" as const };
		assert.equal(marketplaceOrigin(f.entry, [local], true), "market");
		assert.equal((await resolvePluginOrigins([f.plugin], [f.entry], [local], true)).get("example"), "market");
		assert.equal((await resolvePluginOrigins([f.plugin], [f.entry], [f.sourceInfo], false)).get("example"), "custom");
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("extra files, unsafe links and bounded-out resources stay custom without disappearing", async () => {
	const f = await fixture();
	try {
		await writeFile(join(f.installed, "extra.txt"), "custom");
		assert.equal((await resolvePluginOrigins([f.plugin], [f.entry], [f.sourceInfo], true)).get("example"), "custom");
		await rm(join(f.installed, "extra.txt"));
		await writeFile(join(f.installed, "large.bin"), Buffer.alloc(512 * 1024 + 1));
		const bounded = await resolvePluginOrigins([f.plugin], [f.entry], [f.sourceInfo], true);
		assert.equal(bounded.size, 1);assert.equal(bounded.get("example"), "custom");
		await rm(join(f.installed, "large.bin"));
		if (process.platform !== "win32") {
			await symlink(f.source, join(f.installed, "external"));
			assert.equal((await resolvePluginOrigins([f.plugin], [f.entry], [f.sourceInfo], true)).get("example"), "custom");
		}
	} finally { await rm(f.root, { recursive: true, force: true }); }
});
