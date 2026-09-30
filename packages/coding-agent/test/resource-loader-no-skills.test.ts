import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return { ...fs, readdirSync: vi.fn(fs.readdirSync) };
});

const roots: string[] = [];
afterEach(() => {
	vi.clearAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeSkill(dir: string, name: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} instructions\n---\nUse ${name}.`);
}

describe("--no-skills discovery", () => {
	it("does not traverse default, configured or package skill directories", async () => {
		const root = mkdtempSync(join(tmpdir(), "step-no-skills-"));
		roots.push(root);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		const defaultDir = join(agentDir, "skills");
		const configuredDir = join(root, "configured");
		const packageDir = join(root, "package");
		const packageSkills = join(packageDir, "skills");
		for (const [dir, name] of [
			[defaultDir, "default-skill"],
			[configuredDir, "configured-skill"],
			[packageSkills, "package-skill"],
		]) {
			writeSkill(join(dir, name), name);
		}
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({ name: "skills-package", version: "1.0.0", pi: { skills: ["skills"] } }),
		);
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noSkills: true,
			noExtensions: true,
			noContextFiles: true,
			settingsManager: SettingsManager.inMemory({ skills: [configuredDir], packages: [packageDir] }),
		});
		await loader.reload();
		expect(loader.getSkills().skills).toEqual([]);
		const visited = vi.mocked(readdirSync).mock.calls.map(([path]) => String(path));
		expect(
			visited.some((path) =>
				[defaultDir, configuredDir, packageSkills].some((dir) => path === dir || path.startsWith(dir + sep)),
			),
		).toBe(false);
	});

	it("still discovers explicitly supplied skill directories", async () => {
		const root = mkdtempSync(join(tmpdir(), "step-explicit-skills-"));
		roots.push(root);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		const explicitDir = join(root, "explicit");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeSkill(join(explicitDir, "explicit-skill"), "explicit-skill");
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noSkills: true,
			noExtensions: true,
			noContextFiles: true,
			settingsManager: SettingsManager.inMemory(),
			additionalSkillPaths: [explicitDir],
		});
		await loader.reload();
		expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(["explicit-skill"]);
	});

	it("does not reinterpret a skills-only convention package as an extension", async () => {
		const root = mkdtempSync(join(tmpdir(), "step-skills-package-"));
		roots.push(root);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		const packageDir = join(root, "package");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeSkill(join(packageDir, "skills", "package-skill"), "package-skill");
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noSkills: true,
			noContextFiles: true,
			settingsManager: SettingsManager.inMemory({ packages: [packageDir] }),
		});
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		expect(loader.getExtensions().extensions).toEqual([]);
		expect(loader.getSkills().skills).toEqual([]);
	});
});
