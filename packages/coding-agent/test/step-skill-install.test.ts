import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { installPreparedSkill, prepareSkillPackage } from "../src/step/skill-install.ts";

const skill = (name = "demo") => Buffer.from(`---\nname: ${name}\ndescription: Test skill\n---\n# Instructions\n`);
test("skills require one root, valid YAML, description and safe name", () => {
	for (const data of [
		Buffer.from("# no frontmatter"),
		skill("../escape"),
		skill("a/b"),
		Buffer.from("---\nname: demo\n---\n"),
	])
		expect(() => prepareSkillPackage([{ path: "SKILL.md", data }])).toThrow();
	expect(() =>
		prepareSkillPackage([
			{ path: "a/SKILL.md", data: skill() },
			{ path: "b/SKILL.md", data: skill("other") },
		]),
	).toThrow();
	expect(prepareSkillPackage([{ path: "wrapper/SKILL.md", data: skill() }]).preview.id).toBe("demo");
});
test("skill scripts and references are preserved, fingerprint binds all files and conflicts preserve installation", async () => {
	const root = await mkdtemp(join(tmpdir(), "skill-install-test-"));
	try {
		const files = [
			{ path: "SKILL.md", data: skill() },
			{ path: "scripts/demo.py", data: Buffer.from("print('demo')"), executable: true },
		];
		const pkg = prepareSkillPackage(files);
		expect(
			prepareSkillPackage([...files, { path: "references/a.md", data: Buffer.from("Changed") }]).preview.fingerprint,
		).not.toBe(pkg.preview.fingerprint);
		await installPreparedSkill(pkg, root);
		expect(await readFile(join(root, "demo/scripts/demo.py"), "utf8")).toBe("print('demo')");
		await expect(installPreparedSkill(pkg, root)).rejects.toMatchObject({ status: 409 });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
