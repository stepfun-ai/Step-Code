import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { hasDescriptionMarkup } from "../client/src/lib/extension-text.ts";

const catalog = JSON.parse(
	await readFile(
		fileURLToPath(new URL("../client/src/features/market/catalog/catalog.json", import.meta.url)),
		"utf8",
	),
) as {
	readonly schemaVersion: number;
	readonly source: { readonly label: string; readonly statement: string };
	readonly entries: ReadonlyArray<{
		readonly kind: string;
		readonly package: string;
		readonly name: string;
		readonly description: string;
		readonly categories: readonly string[];
		readonly files: readonly string[];
		readonly logo?: string;
		readonly notes: readonly string[];
		readonly items: {
			readonly skills: ReadonlyArray<{ readonly name: string; readonly description?: string }>;
			readonly connectors: ReadonlyArray<{ readonly name: string; readonly transport?: string }>;
			readonly commands: ReadonlyArray<{ readonly name: string }>;
		};
		readonly connection?: {
			readonly transport: string;
			readonly auth: string;
			readonly url: string;
			readonly source: string;
			readonly configuration?: { readonly command?: string; readonly args?: readonly string[] };
		};
		readonly document: { readonly filename: string; readonly path: string; readonly raw: string; readonly sha256: string };
	}>;
};

test("local catalog keeps the full package list with original documents", () => {
	assert.equal(catalog.schemaVersion, 1);
	assert.match(catalog.source.statement, /不等于安装/);
	const counts = Object.groupBy(catalog.entries, (entry) => entry.kind);
	assert.equal(counts.plugins?.length, 15);
	assert.equal(counts.skills?.length, 36);
	assert.equal(counts.connectors?.length, 11);
	const packages = catalog.entries.map((entry) => `${entry.kind}/${entry.package}`);
	assert.equal(new Set(packages).size, 62);
	const logoRoot = fileURLToPath(new URL("../client/src/features/market/catalog/logos/", import.meta.url));
	const withLogo = catalog.entries.filter((entry) => entry.logo);
	assert.ok(withLogo.length >= 50);
	for (const entry of withLogo) assert.ok(existsSync(join(logoRoot, entry.logo!)), entry.logo);
	for (const entry of catalog.entries) {
		assert.ok(entry.name.trim(), entry.package);
		assert.ok(entry.description.trim(), entry.package);
		assert.ok(entry.categories.length > 0, entry.package);
		assert.ok(entry.files.includes(entry.document.path), entry.package);
		assert.ok(entry.notes.length > 0, entry.package);
		assert.equal(createHash("sha256").update(entry.document.raw).digest("hex"), entry.document.sha256);
	}
});

test("component items come from real manifests and expose no connection secrets", () => {
	const byPackage = (name: string) => catalog.entries.find((entry) => entry.package === name);
	assert.equal(byPackage("larksuite__cli")?.items.skills.length, 28);
	assert.equal(byPackage("slackapi__slack-skills-plugin")?.items.commands.length, 5);
	const pdf = byPackage("Open-Document-Alliance__PDF-Tools");
	assert.equal(pdf?.items.skills.length, 3);
	assert.deepEqual(pdf?.items.connectors, [{ name: "pdf-tools", transport: "http" }]);
	for (const entry of catalog.entries) {
		for (const connector of entry.items.connectors) {
			assert.deepEqual(Object.keys(connector).sort(), ["name", "transport"], entry.package);
		}
	}
	const connection = (name: string) => catalog.entries.find((entry) => entry.package === name)?.connection;
	assert.equal(connection("datalayer__jupyter-mcp-server")?.transport, "http");
	assert.equal(connection("datalayer__jupyter-mcp-server")?.auth, "oauth");
	assert.equal(connection("datalayer__jupyter-mcp-server")?.url, "https://mcp.datalayer.run/mcp");
	assert.equal(connection("microsoft__playwright")?.transport, "stdio");
	assert.equal(connection("microsoft__playwright")?.source, "readme");
	for (const entry of catalog.entries.filter((item) => item.kind === "connectors")) {
		const url = entry.connection?.url ?? "";
		assert.ok(!url.includes("@") && !url.includes("?"), entry.package);
	}
});

test("rejected connector packages are absent from the market", () => {
	for (const packageName of [
		"haris-musa__excel-mcp-server", "GongRzhe__Office-PowerPoint-MCP-Server",
		"GongRzhe__Office-Word-MCP-Server", "aliyun__alibabacloud-devops-mcp-server",
	]) {
		assert.equal(catalog.entries.some((entry) => entry.kind === "connectors" && entry.package === packageName), false, packageName);
	}
});

test("npm connector templates select fixed releases instead of floating packages", () => {
	for (const packageName of ["Coding-Solo__godot-mcp", "MausRundung__mcp-explorer", "microsoft__playwright"]) {
		const entry = catalog.entries.find((item) => item.kind === "connectors" && item.package === packageName);
		assert.ok(entry, packageName);
		assert.equal(entry.connection?.configuration?.command, "npx", packageName);
		const packageArgument = entry.connection?.configuration?.args?.find((argument) => argument.startsWith("@"));
		assert.ok(packageArgument, packageName);
		assert.match(packageArgument, /@\d+\.\d+\.\d+$/u, packageName);
	}
});

test("no catalog description carries raw README markup or loses its tail", () => {
	for (const entry of catalog.entries) {
		assert.equal(hasDescriptionMarkup(entry.description), false, `${entry.package}: ${entry.description.slice(0, 80)}`);
		assert.ok(entry.description.trim().length > 0, entry.package);
		assert.ok(!entry.description.endsWith("…"), `${entry.package} description was truncated`);
	}
});

test("current skill catalog has standard roots and MCP entries provide configuration evidence", () => {
	const skill = (name: string) => catalog.entries.find((entry) => entry.package === name);
	assert.equal(skill("sst__opentui"), undefined);
	assert.equal(skill("Cangjie-SIG__CangjieSkills")?.document.filename, "SKILL.md");
	assert.ok(catalog.entries.filter((entry) => entry.kind === "skills").every((entry) => entry.document.filename === "SKILL.md"));
	assert.ok(catalog.entries.filter((entry) => entry.kind === "connectors").every((entry) => entry.notes.some((note) => note.includes("配置模板"))));
});
