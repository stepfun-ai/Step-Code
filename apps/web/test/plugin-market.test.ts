import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { crc32, gunzipSync } from "node:zlib";

function pluginZip(id: string): string {
	const name = Buffer.from("step.plugin.json");
	const content = Buffer.from(JSON.stringify({ id, name: "Imported test plugin" }));
	const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt32LE(crc32(content), 14);
	local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26);
	const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt32LE(crc32(content), 16);
	central.writeUInt32LE(content.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(name.length, 28);
	const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
	end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + content.length, 16);
	return Buffer.concat([local, name, content, central, name, end]).toString("base64");
}
import { curatedPluginOrigin, importPluginArchive, installCuratedPlugin, previewCuratedPlugin } from "../src/plugin-market.ts";
import { listPlugins, listSkills, removePlugin, setPluginEnabled } from "../src/settings.ts";

const prepareDependency = async (command: string) => ({ command, status: "ready" as const, firstUseConfiguration: true });
const keys = ["HOME", "STEP_CODING_AGENT_DIR", "STEPCODE_STORAGE_ROOT_DIR", "STEPCODE_CONFIG_DIR"];
let home: string;
const previous = new Map(keys.map((key) => [key, process.env[key]]));
test.before(async () => {
	home = await mkdtemp(join(tmpdir(), "web-plugin-market-"));
	for (const key of keys) delete process.env[key];
	process.env.HOME = home;
});
test.after(async () => {
	for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	await rm(home, { recursive: true, force: true });
});
test("rejected plugins are unavailable from the installable market", async () => {
	for (const packageName of [
		"pbakaus__impeccable", "slidevjs__slidev", "nextlevelbuilder__ui-ux-pro-max-skill",
		"apollographql__skills", "cloudflare__skills", "coderabbitai__skills", "duckdb__duckdb-skills",
		"affaan-m__ECC", "mongodb__agent-skills__mongodb", "anthropics__claude-plugins-official__pr-review-toolkit",
		"aaquib90__proxymail-qa-plugin", "supermax92__qgraphflow", "obra__superpowers", "JuliusBrussee__caveman",
	]) {
		await assert.rejects(previewCuratedPlugin(`plugins-${packageName}`), { status: 404 }, packageName);
	}
});

test("all 15 selected catalog packages pass actual manifest and contribution validation", async () => {
	const resources = JSON.parse(await readFile(new URL("../resources/plugin-market.json", import.meta.url), "utf8")) as { packages: Array<{ catalogId: string; id: string }> };
	assert.equal(resources.packages.length, 15);
	for (const bundle of resources.packages) {
		const preview = await previewCuratedPlugin(bundle.catalogId);
		assert.equal(preview.id, bundle.id);
		assert.match(preview.fingerprint, /^[a-f0-9]{64}$/u);
	}
});
test("plugin payloads preserve catalog documents and provide a root README", async () => {
	const catalog = JSON.parse(await readFile(new URL("../client/src/features/market/catalog/catalog.json", import.meta.url), "utf8")) as {
		entries: Array<{ id: string; kind: string; document: { path: string; sha256: string } }>;
	};
	const resources = JSON.parse(await readFile(new URL("../resources/plugin-market.json", import.meta.url), "utf8")) as {
		packages: Array<{ catalogId: string; data: string }>;
	};
	for (const entry of catalog.entries.filter((item) => item.kind === "plugins")) {
		const bundle = resources.packages.find((item) => item.catalogId === entry.id);
		assert.ok(bundle, entry.id);
		const files = JSON.parse(gunzipSync(Buffer.from(bundle.data, "base64"), { maxOutputLength: 96 * 1024 * 1024 }).toString("utf8")) as Array<{ path: string; data: string }>;
		const document = files.find((file) => file.path === entry.document.path);
		assert.ok(document, `${entry.id}: missing catalog document ${entry.document.path}`);
		assert.equal(createHash("sha256").update(Buffer.from(document.data, "base64")).digest("hex"), entry.document.sha256, entry.id);
		assert.ok(files.some((file) => /^readme(?:\.|$)/iu.test(file.path)), `${entry.id}: missing root README`);
	}
});
test("catalog consent binds content, installs real skills, groups origin and supports toggle/removal", async () => {
	const id = "plugins-larksuite__cli";
	const preview = await previewCuratedPlugin(id);
	await assert.rejects(installCuratedPlugin(id, preview.fingerprint, false), { status: 409 });
	await assert.rejects(installCuratedPlugin(id, "changed", true), { status: 409 });
	await installCuratedPlugin(id, preview.fingerprint, true, prepareDependency);
	assert.equal((await listPlugins()).installed.find((p) => p.id === "lark-cli")?.origin, "market");
	assert.ok((await listSkills()).some((skill) => skill.source === "plugin" && skill.pluginName === "飞书 CLI"));
	await setPluginEnabled("lark-cli", false);
	assert.equal((await listPlugins()).installed.find((p) => p.id === "lark-cli")?.enabled, false);
	await assert.rejects(installCuratedPlugin(id, preview.fingerprint, true, prepareDependency), { status: 409 });
	assert.equal(await curatedPluginOrigin("lark-cli", join(home, ".stepcode/plugins/lark-cli")), true);
	await removePlugin("lark-cli");
	assert.equal((await listPlugins()).installed.some((p) => p.id === "lark-cli"), false);
	await installCuratedPlugin(id, preview.fingerprint, true, prepareDependency);
	assert.equal((await listPlugins()).installed.find((p) => p.id === "lark-cli")?.enabled, true);
	await removePlugin("lark-cli");
});
test("real ZIP import stays read-only until confirmation, then persists files and detects conflicts", async () => {
	const data = pluginZip("import-test");
	const result = await importPluginArchive({ data });
	assert.equal(result.installed, false);
	assert.equal((await listPlugins()).installed.some((p) => p.id === "import-test"), false);
	await assert.rejects(importPluginArchive({ data, confirmed: true, fingerprint: "changed" }), { status: 409 });
	assert.equal((await importPluginArchive({ data, confirmed: true, fingerprint: result.preview.fingerprint })).installed, true);
	assert.equal(JSON.parse(await readFile(join(home, ".stepcode/plugins/import-test/step.plugin.json"), "utf8")).id, "import-test");
	await assert.rejects(importPluginArchive({ data, confirmed: true, fingerprint: result.preview.fingerprint }), { status: 409 });
	await removePlugin("import-test");
});

test("dependency preparation failure preserves plugin files and reports first-use setup instead of false readiness", async () => {
	const id = "plugins-DingTalk-Real-AI__dingtalk-workspace-cli";
	const preview = await previewCuratedPlugin(id);
	const result = await installCuratedPlugin(id, preview.fingerprint, true, async (command) => ({ command, status: "setup_required", reason: "timeout", setupCommand: "dws auth login", firstUseConfiguration: true }));
	assert.equal(result.dependency?.status, "setup_required");assert.equal(result.dependency?.reason, "timeout");
	assert.ok((await listPlugins()).installed.some((entry) => entry.id === "dingtalk-cli"));
	await removePlugin("dingtalk-cli");
});

test("fake ZIP and malformed uploads never produce success", async () => {
	for (const data of ["bad-base64", Buffer.from("preview").toString("base64"), ""])
		await assert.rejects(importPluginArchive({ data }), { status: 400 });
	await assert.rejects(previewCuratedPlugin("not-a-catalog-plugin"), { status: 404 });
});
