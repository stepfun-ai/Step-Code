import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "../src/core/extensions/types.ts";
import {
	addMarketplaceSource,
	BUILTIN_MARKETPLACE_NAME,
	defaultStepMarketplacesDir,
	defaultStepPluginsDir,
	diagnoseStepPlugin,
	ensureBuiltinMarketplace,
	installMarketplacePlugin,
	listInstalledStepPlugins,
	listMarketplacePlugins,
	listMarketplaceSources,
	parseStepPluginManifest,
	registerStepPluginCommand,
	updateMarketplaceSource,
} from "../src/step/plugins.ts";

const execFileAsync = promisify(execFile);

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Step plugin marketplace facade", () => {
	test("uses the Step namespace for default storage", () => {
		const env = { HOME: "/tmp/step-plugin-home" } as NodeJS.ProcessEnv;
		expect(defaultStepPluginsDir(env)).toBe("/tmp/step-plugin-home/.stepcode/plugins");
		expect(defaultStepMarketplacesDir(env)).toBe("/tmp/step-plugin-home/.stepcode/marketplaces");
	});

	test("aggregates remote marketplace entries into one diagnostic", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-plugins-remote-"));
		roots.push(root);
		const checkout = join(root, "remote");
		await mkdir(join(checkout, ".step-plugin"), { recursive: true });
		await writeFile(
			join(checkout, ".step-plugin", "marketplace.json"),
			JSON.stringify({
				name: "remote",
				plugins: [
					{ name: "a", source: { source: "github", repo: "acme/a" } },
					{ name: "b", source: { source: "github", repo: "acme/b" } },
					{ name: "c", source: { source: "url", url: "https://example.invalid/c.git" } },
				],
			}),
		);
		const result = await listMarketplacePlugins([root]);
		expect(result.entries).toEqual([]);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toEqual(expect.stringContaining("2 github"));
		expect(result.warnings[0]).toEqual(expect.stringContaining("1 url"));
	});

	test("materializes built-ins under the supplied Step marketplace root", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-plugins-builtin-"));
		roots.push(root);
		const marketplacesDir = join(root, ".stepcode", "marketplaces");

		const result = await ensureBuiltinMarketplace({ marketplacesDir });
		expect(result.warnings).toEqual([]);
		expect(result.path).toBe(join(marketplacesDir, BUILTIN_MARKETPLACE_NAME));

		const listed = await listMarketplacePlugins([marketplacesDir]);
		expect(listed.warnings).toEqual([]);
		expect(listed.entries.map((entry) => entry.name)).toEqual(["playwright", "steppage"]);
		expect(listed.entries.every((entry) => entry.sourcePath.startsWith(result.path))).toBe(true);
	});

	test("installs a manifest and reports MCP declarations without starting a process", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-plugins-install-"));
		roots.push(root);
		const marketplacesDir = join(root, "marketplaces");
		const pluginsDir = join(root, ".stepcode", "plugins");
		await ensureBuiltinMarketplace({ marketplacesDir });
		const available = await listMarketplacePlugins([marketplacesDir]);
		const entry = available.entries.find((candidate) => candidate.name === "playwright");
		expect(entry).toBeDefined();

		const installed = await installMarketplacePlugin(entry!, pluginsDir);
		expect(installed.installedPath).toBe(join(pluginsDir, "playwright"));
		expect(JSON.parse(await readFile(join(installed.installedPath, "step.plugin.json"), "utf8"))).toMatchObject({
			id: "playwright",
		});
		expect(installed.diagnostics.mcpServers).toEqual(["playwright"]);
		expect(installed.diagnostics.warnings.join(" ")).toContain("server starts after Step restarts");

		await expect(installMarketplacePlugin(entry!, pluginsDir)).rejects.toThrow("already installed");
		await expect(diagnoseStepPlugin(installed.installedPath)).resolves.toMatchObject({
			mcpServers: ["playwright"],
		});
	});

	test("does not overwrite a Claude-style plugin manifest", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-plugins-claude-"));
		roots.push(root);
		const marketplace = join(root, "marketplace");
		const pluginsDir = join(root, "installed");
		await mkdir(join(marketplace, "plugins", "legacy", ".claude-plugin"), { recursive: true });
		await mkdir(join(marketplace, ".step-plugin"), { recursive: true });
		await writeFile(
			join(marketplace, ".step-plugin", "marketplace.json"),
			JSON.stringify({ name: "legacy", plugins: [{ name: "legacy", source: "./plugins/legacy" }] }),
		);
		await writeFile(
			join(marketplace, "plugins", "legacy", ".claude-plugin", "plugin.json"),
			JSON.stringify({ name: "legacy", version: "1.0.0" }),
		);
		const entry = (await listMarketplacePlugins([root])).entries[0];
		const installed = await installMarketplacePlugin(entry!, pluginsDir);
		expect(installed.warnings).toEqual([]);
		await expect(readFile(join(installed.installedPath, "step.plugin.json"))).rejects.toThrow();
		expect(
			JSON.parse(await readFile(join(installed.installedPath, ".claude-plugin", "plugin.json"), "utf8")),
		).toMatchObject({ name: "legacy" });
	});

	test("keeps project plugins ahead of user plugins with the same id", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-plugins-precedence-"));
		roots.push(root);
		const userDir = join(root, "user");
		const projectDir = join(root, "project");
		await writePlugin(userDir, "user-copy", "shared", "User");
		await writePlugin(projectDir, "project-copy", "shared", "Project");

		const listed = await listInstalledStepPlugins({ userDir, projectDir });
		expect(listed.plugins).toHaveLength(1);
		expect(listed.plugins[0]).toMatchObject({ id: "shared", name: "Project", source: "project" });
		expect(listed.warnings.join(" ")).toContain("project plugin has precedence");
	});

	test("accepts a local file URL and labels it as a local marketplace", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-plugins-local-"));
		roots.push(root);
		const checkout = join(root, "my-marketplace");
		await mkdir(join(checkout, ".step-plugin"), { recursive: true });
		await mkdir(join(checkout, "hello"), { recursive: true });
		await writeFile(
			join(checkout, ".step-plugin", "marketplace.json"),
			JSON.stringify({ name: "local", plugins: [{ name: "hello", source: "./hello" }] }),
		);
		await writeFile(join(checkout, "hello", "step.plugin.json"), JSON.stringify({ id: "hello" }));

		const added = await addMarketplaceSource({
			source: new URL(`file://${checkout}`).toString(),
			marketplacesDir: join(root, "marketplaces"),
		});
		expect(added.warnings).toEqual([]);
		expect(added.source?.kind).toBe("local");
		expect(added.source?.name).toBe("my-marketplace");
	});

	test("clones a file URL git origin and can update the checkout", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-plugins-git-"));
		roots.push(root);
		const origin = join(root, "origin");
		await mkdir(join(origin, ".step-plugin"), { recursive: true });
		await writeFile(
			join(origin, ".step-plugin", "marketplace.json"),
			JSON.stringify({ name: "origin", plugins: [] }),
		);
		await execFileAsync("git", ["init", "-q"], { cwd: origin });
		await execFileAsync("git", ["config", "user.email", "step@example.invalid"], { cwd: origin });
		await execFileAsync("git", ["config", "user.name", "Step Test"], { cwd: origin });
		await execFileAsync("git", ["add", "."], { cwd: origin });
		await execFileAsync("git", ["commit", "-qm", "initial"], { cwd: origin });

		const marketplacesDir = join(root, "marketplaces");
		const added = await addMarketplaceSource({ source: pathToFileURL(origin).toString(), marketplacesDir });
		expect(added.source?.kind).toBe("git");
		expect((await listMarketplaceSources(marketplacesDir))[0]?.kind).toBe("git");

		await writeFile(join(origin, "updated.txt"), "updated\n");
		await execFileAsync("git", ["add", "."], { cwd: origin });
		await execFileAsync("git", ["commit", "-qm", "updated"], { cwd: origin });
		await expect(updateMarketplaceSource({ name: "origin", marketplacesDir })).resolves.toMatchObject({
			warnings: [],
		});
		expect(await readFile(join(marketplacesDir, "origin", "updated.txt"), "utf8")).toBe("updated\n");
	});

	test("rejects absolute and traversal paths in declarative manifests", () => {
		const parsed = parseStepPluginManifest(
			{ id: "unsafe", entry: "../run.js", skills: ["/tmp/skill", "..\\outside"] },
			"manifest",
		);
		expect(parsed.manifest).toBeUndefined();
		expect(parsed.errors).toEqual(
			expect.arrayContaining([
				"manifest.entry: expected a relative path inside the package",
				"manifest.skills[0]: expected a relative path inside the package",
				"manifest.skills[1]: expected a relative path inside the package",
			]),
		);
	});

	test("registers /plugin and handles a browse command through Pi's UI", async () => {
		const commands = new Map<string, RegisteredCommand>();
		const registerCommand = vi.fn((name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			commands.set(name, { ...command, name, sourceInfo: {} as RegisteredCommand["sourceInfo"] });
		});
		registerStepPluginCommand({ registerCommand } as unknown as ExtensionAPI);
		expect(commands.has("plugin")).toBe(true);
		const notify = vi.fn();
		await commands.get("plugin")!.handler("browse", {
			cwd: process.cwd(),
			ui: { notify },
		} as unknown as ExtensionCommandContext);
		expect(notify).toHaveBeenCalled();
	});
});

async function writePlugin(root: string, directory: string, id: string, name: string): Promise<void> {
	const pluginDir = join(root, directory);
	await mkdir(pluginDir, { recursive: true });
	await writeFile(join(pluginDir, "step.plugin.json"), JSON.stringify({ id, name }));
}
