import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { readStepGlobalDefaults } from "../src/step/config-migration.ts";
import { createStepSettingsManager } from "../src/step/settings-manager.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Step config path resolution", () => {
	test("reads defaults from an explicitly configured Step agent directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-config-paths-"));
		roots.push(root);
		const agentDir = join(root, "custom-agent");
		await mkdir(agentDir, { recursive: true });
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({ defaultProvider: "custom", defaultModel: "model" }),
		);

		await expect(
			readStepGlobalDefaults(undefined, {
				STEP_HARNESS_CODING_AGENT_DIR: agentDir,
				HOME: join(root, "different-home"),
			}),
		).resolves.toEqual({ provider: "custom", model: "model" });
		await expect(readFile(join(agentDir, "settings.json"), "utf8")).resolves.toContain("custom");
	});

	test("keeps project settings isolated when managers use different config directory names", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-config-paths-isolation-"));
		roots.push(root);
		const cwd = join(root, "workspace");
		const agentDir = join(root, "agent");
		const harnessDir = join(cwd, ".step-harness");
		const piDir = join(cwd, ".pi");
		await mkdir(harnessDir, { recursive: true });
		await mkdir(piDir, { recursive: true });
		await writeFile(join(harnessDir, "settings.json"), JSON.stringify({ defaultModel: "harness" }));
		await writeFile(join(piDir, "settings.json"), JSON.stringify({ defaultModel: "pi" }));

		const harness = SettingsManager.create(cwd, agentDir, { configDirName: ".step-harness" });
		const pi = SettingsManager.create(cwd, agentDir, { configDirName: ".pi" });

		expect(harness.getDefaultModel()).toBe("harness");
		expect(pi.getDefaultModel()).toBe("pi");

		harness.setProjectExtensionPaths(["extensions"]);
		await harness.flush();
		expect(JSON.parse(await readFile(join(harnessDir, "settings.json"), "utf8"))).toMatchObject({
			extensions: ["extensions"],
		});
		expect(JSON.parse(await readFile(join(piDir, "settings.json"), "utf8"))).toEqual({ defaultModel: "pi" });
	});

	test("loads project resources from the injected config directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-config-paths-resources-"));
		roots.push(root);
		const cwd = join(root, "workspace");
		const agentDir = join(root, "agent");
		const harnessSkillDir = join(cwd, ".step-harness", "skills", "harness-skill");
		const piSkillDir = join(cwd, ".pi", "skills", "pi-skill");
		await mkdir(harnessSkillDir, { recursive: true });
		await mkdir(piSkillDir, { recursive: true });
		await writeFile(
			join(harnessSkillDir, "SKILL.md"),
			"---\nname: harness-skill\ndescription: Harness skill\n---\nHarness content\n",
		);
		await writeFile(join(piSkillDir, "SKILL.md"), "---\nname: pi-skill\ndescription: Pi skill\n---\nPi content\n");

		const settingsManager = SettingsManager.create(cwd, agentDir, { configDirName: ".step-harness" });
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			configDirName: ".step-harness",
			settingsManager,
		});
		await loader.reload();

		const names = loader.getSkills().skills.map((skill) => skill.name);
		expect(names).toContain("harness-skill");
		expect(names).not.toContain("pi-skill");
	});

	test("resolves project package paths from the injected config directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-config-paths-packages-"));
		roots.push(root);
		const cwd = join(root, "workspace");
		const agentDir = join(root, "agent");
		const projectExtension = join(cwd, ".step-harness", "extensions", "local.ts");
		await mkdir(join(cwd, ".step-harness", "extensions"), { recursive: true });
		await writeFile(projectExtension, "export default function () {}\n");

		const settingsManager = SettingsManager.create(cwd, agentDir, { configDirName: ".step-harness" });
		const packageManager = new DefaultPackageManager({
			cwd,
			agentDir,
			configDirName: ".step-harness",
			settingsManager,
		});

		expect(packageManager.getInstalledPath("extensions/local.ts", "project")).toBe(projectExtension);
	});

	test("derives the Step sidecar next to the injected project config directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-config-paths-sidecar-"));
		roots.push(root);
		const cwd = join(root, "workspace");
		const agentDir = join(root, "agent");
		await mkdir(cwd, { recursive: true });

		const manager = createStepSettingsManager(cwd, agentDir, { configDirName: ".step-custom" });

		expect(manager.getStepSettingsPaths()).toEqual({
			global: join(agentDir, "step-settings.json"),
			project: join(cwd, ".step-custom", "step-settings.json"),
		});
	});
});
