import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { readGlobalStepConfig, updateGlobalStepConfig } from "../src/step/config-toml.ts";
import { discoverStepMcpServers, listStepPluginMcpServers } from "../src/step/mcp.ts";
import { isStepPluginEnabled } from "../src/step/plugin-state.ts";
import {
	defaultStepPluginsDir,
	discoverStepPluginResourcePaths,
	listInstalledStepPlugins,
} from "../src/step/plugins.ts";

let scratch: string | undefined;
afterEach(async () => {
	vi.unstubAllEnvs();
	if (scratch) await rm(scratch, { recursive: true, force: true });
	scratch = undefined;
});

test("plugin-level state preserves installation and server preferences while gating every contribution", async () => {
	scratch = await mkdtemp(join(tmpdir(), "step-plugin-state-"));
	vi.stubEnv("HOME", scratch);
	for (const key of ["STEP_CODING_AGENT_DIR", "STEPCODE_STORAGE_ROOT_DIR", "STEPCODE_CONFIG_DIR"])
		vi.stubEnv(key, undefined);
	const root = defaultStepPluginsDir();
	const plugin = join(root, "demo");
	await mkdir(join(plugin, "skills", "example"), { recursive: true });
	await mkdir(join(plugin, "commands"));
	await writeFile(
		join(plugin, "skills", "example", "SKILL.md"),
		"---\nname: example\ndescription: test\n---\n# test\n",
	);
	await writeFile(join(plugin, "commands", "test.md"), "Test command");
	await writeFile(
		join(plugin, "step.plugin.json"),
		JSON.stringify({
			id: "demo",
			skills: ["skills"],
			commands: ["commands"],
			mcpServers: { active: { command: "not-executed" }, off: { command: "not-executed" } },
		}),
	);
	updateGlobalStepConfig(process.env, (document) => ({
		...document,
		mcp_servers: { ...document.mcp_servers, demo__off: { enabled: false } },
		provider: "keep-me",
	}));
	expect((await listInstalledStepPlugins()).plugins.find((p) => p.id === "demo")?.enabled).toBe(true);
	expect((await discoverStepPluginResourcePaths({})).skillPaths).toContain(join(plugin, "skills"));
	expect((await discoverStepMcpServers(scratch, false)).map((s) => s.name)).toContain("demo__active");
	updateGlobalStepConfig(process.env, (document) => ({
		...document,
		plugins: { ...document.plugins, demo: { enabled: false } },
	}));
	expect((await listInstalledStepPlugins()).plugins.find((p) => p.id === "demo")?.enabled).toBe(false);
	const hidden = await discoverStepPluginResourcePaths({});
	expect(hidden.skillPaths).toEqual([]);
	expect(hidden.promptPaths).toEqual([]);
	expect((await discoverStepPluginResourcePaths({ includeDisabled: true })).skillPaths).toContain(
		join(plugin, "skills"),
	);
	expect((await discoverStepMcpServers(scratch, false)).some((s) => s.name.startsWith("demo__"))).toBe(false);
	expect(
		(await listStepPluginMcpServers(scratch, false)).filter((s) => s.pluginId === "demo").every((s) => !s.enabled),
	).toBe(true);
	updateGlobalStepConfig(process.env, (document) => ({
		...document,
		plugins: { ...document.plugins, demo: { enabled: true } },
	}));
	expect((await discoverStepPluginResourcePaths({})).promptPaths).toContain(join(plugin, "commands"));
	const restored = await listStepPluginMcpServers(scratch, false);
	expect(restored.find((s) => s.name === "demo__active")?.enabled).toBe(true);
	expect(restored.find((s) => s.name === "demo__off")?.enabled).toBe(false);
	expect(readGlobalStepConfig().provider).toBe("keep-me");
});

test("malformed plugin state fails closed", () => {
	expect(isStepPluginEnabled("demo", {})).toBe(true);
	expect(isStepPluginEnabled("demo", { plugins: { demo: { enabled: false } } })).toBe(false);
	expect(isStepPluginEnabled("demo", { plugins: { demo: { enabled: "false" } } } as never)).toBe(false);
	expect(isStepPluginEnabled("demo", { plugins: [] } as never)).toBe(false);
});
