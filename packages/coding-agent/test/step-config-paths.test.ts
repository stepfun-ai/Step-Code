import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { readGlobalStepDefaults } from "../src/step/config-toml.ts";
import { createStepSettingsManager } from "../src/step/settings-manager.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Step config path resolution", () => {
	// The config file sits beside the agent directory, so an injected
	// STEP_CODING_AGENT_DIR must steer the defaults read away from $HOME.
	test("reads defaults from the config beside an explicitly configured agent directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-config-paths-"));
		roots.push(root);
		const configRoot = join(root, "custom-root");
		const agentDir = join(configRoot, "agent");
		await mkdir(agentDir, { recursive: true });
		await writeFile(
			join(configRoot, "config.toml"),
			['defaultProvider = "custom"', 'defaultModel = "model"', ""].join("\n"),
		);

		expect(
			readGlobalStepDefaults({
				STEP_CODING_AGENT_DIR: agentDir,
				HOME: join(root, "different-home"),
			}),
		).toEqual({ provider: "custom", model: "model" });
		await expect(readFile(join(configRoot, "config.toml"), "utf8")).resolves.toContain("custom");
	});

	test("keeps project settings isolated when managers use different config directory names", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-config-paths-isolation-"));
		roots.push(root);
		const cwd = join(root, "workspace");
		const agentDir = join(root, "agent");
		const harnessDir = join(cwd, ".stepcode");
		const piDir = join(cwd, ".pi");
		await mkdir(harnessDir, { recursive: true });
		await mkdir(piDir, { recursive: true });
		await writeFile(join(harnessDir, "settings.json"), JSON.stringify({ defaultModel: "harness" }));
		await writeFile(join(piDir, "settings.json"), JSON.stringify({ defaultModel: "pi" }));

		const harness = SettingsManager.create(cwd, agentDir, { configDirName: ".stepcode" });
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
		const harnessSkillDir = join(cwd, ".stepcode", "skills", "harness-skill");
		const piSkillDir = join(cwd, ".pi", "skills", "pi-skill");
		await mkdir(harnessSkillDir, { recursive: true });
		await mkdir(piSkillDir, { recursive: true });
		await writeFile(
			join(harnessSkillDir, "SKILL.md"),
			"---\nname: harness-skill\ndescription: Harness skill\n---\nHarness content\n",
		);
		await writeFile(join(piSkillDir, "SKILL.md"), "---\nname: pi-skill\ndescription: Pi skill\n---\nPi content\n");

		const settingsManager = SettingsManager.create(cwd, agentDir, { configDirName: ".stepcode" });
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			configDirName: ".stepcode",
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
		const projectExtension = join(cwd, ".stepcode", "extensions", "local.ts");
		await mkdir(join(cwd, ".stepcode", "extensions"), { recursive: true });
		await writeFile(projectExtension, "export default function () {}\n");

		const settingsManager = SettingsManager.create(cwd, agentDir, { configDirName: ".stepcode" });
		const packageManager = new DefaultPackageManager({
			cwd,
			agentDir,
			configDirName: ".stepcode",
			settingsManager,
		});

		expect(packageManager.getInstalledPath("extensions/local.ts", "project")).toBe(projectExtension);
	});

	test("derives the Step config next to the injected agent and project directories", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-config-paths-sidecar-"));
		roots.push(root);
		const cwd = join(root, "workspace");
		const agentDir = join(root, "agent");
		await mkdir(cwd, { recursive: true });

		const manager = createStepSettingsManager(cwd, agentDir, { configDirName: ".step-custom" });

		expect(manager.getStepSettingsPaths()).toEqual({
			global: join(root, "config.toml"),
			project: join(cwd, ".step-custom", "config.toml"),
		});
	});

	test("keeps the wrapped Pi manager on the injected config, not the real home", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-config-paths-shared-"));
		roots.push(root);
		const cwd = join(root, "workspace");
		const agentDir = join(root, "agent");
		await mkdir(cwd, { recursive: true });

		const manager = createStepSettingsManager(cwd, agentDir, { configDirName: ".step-custom" });
		manager.setDefaultModel("injected-model");
		await manager.flush();

		// The global config is the file the decorator reports, not ~/.stepcode.
		const globalPath = manager.getStepSettingsPaths().global;
		expect(globalPath).toBe(join(root, "config.toml"));
		expect(await readFile(globalPath, "utf8")).toContain("injected-model");
	});
});
