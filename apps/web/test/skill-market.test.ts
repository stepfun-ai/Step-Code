import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createSkill, deleteSkill, listSkills, parseMcpServerConfig, setSkillEnabled } from "../src/settings.ts";
import { importSkillArchive, installCuratedSkill, previewCuratedSkill } from "../src/skill-market.ts";
const keys = ["HOME", "STEP_CODING_AGENT_DIR", "STEPCODE_STORAGE_ROOT_DIR", "STEPCODE_CONFIG_DIR"];
const previous = new Map(keys.map((key) => [key, process.env[key]])); let home: string;
test.before(async () => { home = await mkdtemp(join(tmpdir(), "skill-market-test-")); for (const key of keys) delete process.env[key]; process.env.HOME = home; });
test.after(async () => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await rm(home, { recursive: true, force: true }); });
test("all 36 current skills have valid usable packages and old OpenTUI is removed", async () => {
	const resource = JSON.parse(await readFile(new URL("../resources/skill-market.json", import.meta.url), "utf8")) as { packages: Array<{ catalogId: string; id: string }> };
	assert.equal(resource.packages.length, 36); assert.equal(resource.packages.some((pkg) => pkg.id === "opentui"), false);
	for (const pkg of resource.packages) assert.equal((await previewCuratedSkill(pkg.catalogId)).id, pkg.id);
});
test("skill installation is consent-bound, discovers resources, records verified origin and supports management", async () => {
	const id = "skills-user_3b34947d__ppt-generator-skill"; const preview = await previewCuratedSkill(id);
	await assert.rejects(installCuratedSkill(id, "changed", true), { status: 409 });
	await installCuratedSkill(id, preview.fingerprint, true);
	const entry = (await listSkills()).find((skill) => skill.name === "ppt-generator"); assert.ok(entry);
	assert.equal(entry.origin, "market"); assert.equal(entry.catalogId, id); assert.equal(entry.deletable, true);
	await setSkillEnabled(entry.id, false); assert.equal((await listSkills()).find((skill) => skill.id === entry.id)?.enabled, false);
	await assert.rejects(installCuratedSkill(id, preview.fingerprint, true), { status: 409 });
	await deleteSkill(entry.id); assert.equal((await listSkills()).some((skill) => skill.id === entry.id), false);
});
test("standalone SKILL.md import previews actual content and rejects bad metadata", async () => {
	const data = Buffer.from("---\nname: markdown-import\ndescription: Test\n---\n# Instructions\n").toString("base64");
	const first = await importSkillArchive({ data, format: "markdown" }); assert.equal(first.installed, false);
	await assert.rejects(importSkillArchive({ data: Buffer.from("# not a skill").toString("base64"), format: "markdown" }), { status: 400 });
	assert.equal((await importSkillArchive({ data, format: "markdown", confirmed: true, fingerprint: first.preview.fingerprint })).installed, true);
	assert.ok((await listSkills()).some((skill) => skill.name === "markdown-import"));
});
test("manual numeric and boolean-like skill names remain string metadata and importable", async () => {
	for (const name of ["true", "123"]) {
		await createSkill({ name, description: "Test", instructions: "Instructions" });
		const skill = (await listSkills()).find((entry) => entry.name === name); assert.ok(skill);
		const data = (await readFile(skill.id)).toString("base64");
		assert.equal((await importSkillArchive({ data, format: "markdown" })).preview.id, name);
		await deleteSkill(skill.id);
	}
});

test("skill repackaging preserves reviewed introductions and StepFun attribution", async () => {
	const root = await mkdtemp(join(tmpdir(), "skill-repackaging-"));
	try {
		const web = join(root, "web");
		const scripts = join(web, "scripts");
		const catalogDir = join(web, "client/src/features/market/catalog");
		const source = join(root, "source");
		await mkdir(join(scripts, "lib"), { recursive: true });
		await mkdir(catalogDir, { recursive: true });
		await symlink(fileURLToPath(new URL("../../../node_modules", import.meta.url)), join(web, "node_modules"), "dir");
		await copyFile(new URL("../scripts/package-skill-market.mjs", import.meta.url), join(scripts, "package-skill-market.mjs"));
		await copyFile(new URL("../scripts/lib/extension-text.mjs", import.meta.url), join(scripts, "lib/extension-text.mjs"));
		const description = "StepFun 官方技能：已确认的中文用途说明。";
		await writeFile(join(catalogDir, "catalog.json"), JSON.stringify({ entries: [{ kind: "skills", name: "official-skill", id: "skills-official", description, selfMade: true }] }));
		for (let index = 0; index < 36; index++) {
			const name = index === 0 ? "official-skill" : `fixture-${index}`;
			const folder = join(source, name);
			await mkdir(folder, { recursive: true });
			await writeFile(join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: Original source instruction\nversion: 1.0.0\n---\n# Fixture\n`);
		}
		execFileSync(process.execPath, [join(scripts, "package-skill-market.mjs"), source], { cwd: web, stdio: "pipe" });
		const result = JSON.parse(await readFile(join(catalogDir, "catalog.json"), "utf8")) as { entries: Array<{ id: string; description: string; selfMade?: boolean }> };
		const official = result.entries.find((entry) => entry.id === "skills-official");
		assert.equal(official?.description, description);
		assert.equal(official?.selfMade, true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("11 selected connector templates use valid MCP configurations and unresolved directories cannot be saved", async () => {
	const catalog = JSON.parse(await readFile(new URL("../client/src/features/market/catalog/catalog.json", import.meta.url), "utf8"));
	const connectors = catalog.entries.filter((entry: { kind: string }) => entry.kind === "connectors"); assert.equal(connectors.length, 11);
	for (const entry of connectors) {
		const config = entry.connection.configuration;
		if (config.args?.some((arg: string) => arg.startsWith("<"))) assert.throws(() => parseMcpServerConfig(config));
		const resolved = { ...config, args: config.args?.map((arg: string) => arg.startsWith("<") ? home : arg) };
		assert.ok(parseMcpServerConfig(resolved)); assert.ok(entry.connection.evidence);
	}
});
