import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "../src/core/extensions/types.ts";
import { loadSkillsFromDir } from "../src/core/skills.ts";
import {
	addMarketplaceSource,
	BUILTIN_MARKETPLACE_NAME,
	defaultStepMarketplacesDir,
	defaultStepPluginsDir,
	diagnoseStepPlugin,
	discoverStepPluginResourcePaths,
	ensureBuiltinMarketplace,
	ensureBuiltinPluginsInstalled,
	installMarketplacePlugin,
	listInstalledStepPlugins,
	listMarketplacePlugins,
	listMarketplaceSources,
	parseStepPluginManifest,
	registerStepPluginCommand,
	splitCloneProgress,
	uninstallPlugin,
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

	test("skips a marketplace entry whose source is the checkout's own parent", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-plugins-parent-"));
		roots.push(root);
		const checkout = join(root, "marketplaces", "hostile");
		await mkdir(join(checkout, ".step-plugin"), { recursive: true });
		await writeFile(
			join(checkout, ".step-plugin", "marketplace.json"),
			JSON.stringify({ name: "hostile", plugins: [{ name: "parent", source: ".." }] }),
		);
		// Make the parent look like a valid plugin, so only the containment check
		// stands between this entry and a copy of the whole directory.
		await writeFile(join(root, "marketplaces", "step.plugin.json"), JSON.stringify({ id: "parent" }));

		const result = await listMarketplacePlugins([join(root, "marketplaces")]);
		expect(result.entries).toEqual([]);
		expect(result.warnings).toEqual([expect.stringContaining("has a source outside the checkout")]);
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

	test("lists each plugin once when the same marketplace is reachable from two roots", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-plugins-twice-"));
		roots.push(root);
		// The built-in marketplace is materialized under every root, and a project
		// root is scanned alongside the global one, so the same checkout is
		// reachable twice. The listing must not grow with the root count.
		const globalRoot = join(root, "global", "marketplaces");
		const projectRoot = join(root, "project", "marketplaces");
		for (const marketplacesDir of [globalRoot, projectRoot]) {
			await ensureBuiltinMarketplace({ marketplacesDir });
		}
		await writeMarketplace(join(globalRoot, "plan-to-lark"), {
			name: "plan-to-lark",
			plugins: [{ name: "plan-to-lark", source: "plugins/plan-to-lark" }],
		});

		const listed = await listMarketplacePlugins([projectRoot, globalRoot]);
		expect(listed.entries.map((entry) => entry.name)).toEqual(["playwright", "steppage", "plan-to-lark"]);
		expect(listed.warnings).toEqual([]);
	});

	test("accepts the name@marketplace spelling and reports where a name does live", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-plugins-spec-"));
		roots.push(root);
		const marketplacesDir = join(root, "marketplaces");
		const pluginsDir = join(root, "plugins");
		await writeMarketplace(join(marketplacesDir, "official"), {
			name: "official",
			plugins: [{ name: "skill-creator", source: "plugins/skill-creator" }],
		});

		const commands = new Map<string, RegisteredCommand>();
		// The handler captures its dirs from registration, not from the context.
		const registerCommand = vi.fn((name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			commands.set(name, { ...command, name, sourceInfo: {} as RegisteredCommand["sourceInfo"] });
		});
		registerStepPluginCommand({ registerCommand } as unknown as ExtensionAPI, { marketplacesDir, pluginsDir });
		const notify = vi.fn();
		const ctx = { cwd: root, ui: { notify } } as unknown as ExtensionCommandContext;

		// The qualifier selects the marketplace rather than forming part of the name.
		await commands.get("plugin")!.handler("install skill-creator@official", ctx);
		const installedManifest = join(pluginsDir, "skill-creator", "step.plugin.json");
		expect(JSON.parse(await readFile(installedManifest, "utf8"))).toMatchObject({ id: "skill-creator" });

		// A wrong qualifier names the marketplaces that do carry the plugin.
		notify.mockClear();
		await commands.get("plugin")!.handler("install skill-creator@elsewhere", ctx);
		expect(String(notify.mock.calls[0]?.[0])).toContain("It is available from: official");
	});

	test("streams clone progress so a long add is not silent", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-plugins-progress-"));
		roots.push(root);
		const marketplacesDir = join(root, "marketplaces");
		const origin = join(root, "origin");
		await writeMarketplace(origin, { name: "origin", plugins: [{ name: "one", source: "one" }] });
		await mkdir(join(origin, "one"), { recursive: true });
		await writeFile(join(origin, "one", "step.plugin.json"), JSON.stringify({ id: "one" }));
		await execFileAsync("git", ["init", "--quiet", origin]);
		await execFileAsync("git", ["-C", origin, "add", "-A"]);
		await execFileAsync("git", [
			"-C",
			origin,
			"-c",
			"user.email=test@example.invalid",
			"-c",
			"user.name=test",
			"commit",
			"--quiet",
			"-m",
			"seed",
		]);

		const seen: string[] = [];
		const added = await addMarketplaceSource({
			source: pathToFileURL(origin).toString(),
			marketplacesDir,
			onProgress: (message) => seen.push(message),
		});
		expect(added.warnings).toEqual([]);
		// Progress starts before the clone so the spinner is never blank, and the
		// manifest check reports after it.
		expect(seen[0]).toContain("Cloning repository (timeout: 120s)");
		expect(seen.at(-1)).toContain("Reading marketplace manifest");
		// git separates progress updates with carriage returns rather than
		// newlines, so the parser must split on both or the spinner text would
		// never change after the first update.
		// The trailing empty element is the unfinished line the caller keeps as
		// its buffer, so complete updates are the ones before it.
		expect(splitCloneProgress("Receiving objects: 10%\rReceiving objects: 90%\r")).toEqual([
			"Receiving objects: 10%",
			"Receiving objects: 90%",
			"",
		]);
	});

	test("prefers the first root when two roots offer the same plugin name", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-plugins-precedence-"));
		roots.push(root);
		const projectRoot = join(root, "project", "marketplaces");
		const globalRoot = join(root, "global", "marketplaces");
		await writeMarketplace(join(projectRoot, "local"), {
			name: "local",
			plugins: [{ name: "shared", source: "shared" }],
		});
		await writeMarketplace(join(globalRoot, "remote"), {
			name: "remote",
			plugins: [{ name: "shared", source: "shared" }],
		});

		const listed = await listMarketplacePlugins([projectRoot, globalRoot]);
		expect(listed.entries).toHaveLength(1);
		expect(listed.entries[0]?.marketplace).toBe("local");
	});

	test("contributes plugin skills and commands as resource paths", async () => {
		const root = await mkdtemp(join(await realpath(tmpdir()), "step-plugins-resources-"));
		roots.push(root);
		const pluginsDir = join(root, "plugins");

		// A plugin whose manifest names its contributions explicitly.
		const declared = join(pluginsDir, "declared");
		await mkdir(join(declared, "my-skills"), { recursive: true });
		await mkdir(join(declared, "my-commands"), { recursive: true });
		await writeFile(
			join(declared, "step.plugin.json"),
			JSON.stringify({ id: "declared", skills: ["my-skills"], commands: ["my-commands"] }),
		);

		// A plugin relying on the conventional directories.
		const conventional = join(pluginsDir, "conventional");
		await mkdir(join(conventional, "skills", "one"), { recursive: true });
		await mkdir(join(conventional, "commands"), { recursive: true });
		await writeFile(join(conventional, "step.plugin.json"), JSON.stringify({ id: "conventional" }));

		// A plugin with no such contributions at all.
		const bare = join(pluginsDir, "bare");
		await mkdir(bare, { recursive: true });
		await writeFile(join(bare, "step.plugin.json"), JSON.stringify({ id: "bare" }));

		const discovered = await discoverStepPluginResourcePaths({ userDir: pluginsDir });
		expect(discovered.warnings).toEqual([]);
		expect(discovered.skillPaths.sort()).toEqual([join(declared, "my-skills"), join(conventional, "skills")].sort());
		expect(discovered.promptPaths.sort()).toEqual(
			[join(declared, "my-commands"), join(conventional, "commands")].sort(),
		);
	});

	test("withholds project plugin resources unless the project is trusted", async () => {
		const root = await mkdtemp(join(await realpath(tmpdir()), "step-plugins-trust-"));
		roots.push(root);
		const projectDir = join(root, "project");
		const userDir = join(root, "user");
		await writeMarketplacePlaceholder(join(projectDir, "from-project"), "project-skill");
		await writeMarketplacePlaceholder(join(userDir, "from-user"), "user-skill");

		// Untrusted: only the user's own plugins contribute.
		const untrusted = await discoverStepPluginResourcePaths({ projectDir, userDir, projectTrusted: false });
		expect(untrusted.skillPaths).toEqual([join(userDir, "from-user", "skills")]);

		// Trusted: the project's plugins are read too.
		const trusted = await discoverStepPluginResourcePaths({ projectDir, userDir, projectTrusted: true });
		expect(trusted.skillPaths).toEqual([
			join(projectDir, "from-project", "skills"),
			join(userDir, "from-user", "skills"),
		]);
	});

	test("keeps a path that is both a skills root and a commands root", async () => {
		const root = await mkdtemp(join(await realpath(tmpdir()), "step-plugins-both-"));
		roots.push(root);
		const pluginsDir = join(root, "plugins");
		const plugin = join(pluginsDir, "both");
		// One directory serving both kinds must not be deduped across them.
		await mkdir(join(plugin, "shared"), { recursive: true });
		await writeFile(
			join(plugin, "step.plugin.json"),
			JSON.stringify({ id: "both", skills: ["shared"], commands: ["shared"] }),
		);

		const discovered = await discoverStepPluginResourcePaths({ userDir: pluginsDir });
		expect(discovered.skillPaths).toEqual([join(plugin, "shared")]);
		expect(discovered.promptPaths).toEqual([join(plugin, "shared")]);
	});

	test("honors an explicitly empty contribution list over the conventions", async () => {
		const root = await mkdtemp(join(await realpath(tmpdir()), "step-plugins-empty-"));
		roots.push(root);
		const pluginsDir = join(root, "plugins");
		const plugin = join(pluginsDir, "none");
		// A stale conventional directory must not resurrect what the manifest
		// explicitly declared as none.
		await mkdir(join(plugin, "skills", "stale"), { recursive: true });
		await writeFile(join(plugin, "step.plugin.json"), JSON.stringify({ id: "none", skills: [] }));

		const discovered = await discoverStepPluginResourcePaths({ userDir: pluginsDir });
		expect(discovered.skillPaths).toEqual([]);
	});

	test("skips a declared contribution that is missing", async () => {
		const root = await mkdtemp(join(await realpath(tmpdir()), "step-plugins-missing-"));
		roots.push(root);
		const pluginsDir = join(root, "plugins");
		const plugin = join(pluginsDir, "bad");
		await mkdir(plugin, { recursive: true });
		await writeFile(join(plugin, "step.plugin.json"), JSON.stringify({ id: "bad", skills: ["gone"] }));

		const discovered = await discoverStepPluginResourcePaths({ userDir: pluginsDir });
		expect(discovered.skillPaths).toEqual([]);
		expect(discovered.warnings).toHaveLength(1);
		expect(discovered.warnings[0]).toContain("missing");
	});

	test("ships plugin skills through the resource loader", async () => {
		const root = await mkdtemp(join(await realpath(tmpdir()), "step-plugins-skill-"));
		roots.push(root);
		const pluginsDir = join(root, "plugins");
		// The conventional layout Claude Code plugins use, which the plugin's own
		// manifest does not describe.
		const skillDir = join(pluginsDir, "maker", "skills", "maker");
		await mkdir(skillDir, { recursive: true });
		await writeFile(join(pluginsDir, "maker", "step.plugin.json"), JSON.stringify({ id: "maker" }));
		await writeFile(
			join(skillDir, "SKILL.md"),
			["---", "name: maker", "description: Make things on request.", "---", "", "# Maker", ""].join("\n"),
		);

		const discovered = await discoverStepPluginResourcePaths({ userDir: pluginsDir });
		const loaded = loadSkillsFromDir({ dir: discovered.skillPaths[0]!, source: "plugin" });
		expect(loaded.diagnostics).toEqual([]);
		expect(loaded.skills.map((skill) => skill.name)).toEqual(["maker"]);
		expect(loaded.skills[0]?.description).toBe("Make things on request.");
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

	test("pre-installs the built-in StepPage plugin once and respects a later uninstall", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-plugins-preinstall-"));
		roots.push(root);
		const marketplacesDir = join(root, "marketplaces");
		const pluginsDir = join(root, ".stepcode", "plugins");

		// A fresh install copies the StepPage manifest without provisioning the
		// executable and reports its provision descriptor for background install.
		const first = await ensureBuiltinPluginsInstalled({ pluginsDir, marketplacesDir });
		expect(first.installed.map((plugin) => plugin.name)).toEqual(["steppage"]);
		expect(first.installed[0]?.provision).toMatchObject({ command: "steppage-mcp" });
		expect(JSON.parse(await readFile(join(pluginsDir, "steppage", "step.plugin.json"), "utf8"))).toMatchObject({
			id: "steppage",
		});
		const listed = await listInstalledStepPlugins({ userDir: pluginsDir });
		expect(listed.plugins.map((plugin) => plugin.id)).toContain("steppage");

		// A second launch is a no-op: the marker records the plugin as handled.
		const second = await ensureBuiltinPluginsInstalled({ pluginsDir, marketplacesDir });
		expect(second.installed).toEqual([]);

		// Once the user uninstalls it, a later launch must not resurrect it.
		await uninstallPlugin(pluginsDir, "steppage");
		const third = await ensureBuiltinPluginsInstalled({ pluginsDir, marketplacesDir });
		expect(third.installed).toEqual([]);
		const afterUninstall = await listInstalledStepPlugins({ userDir: pluginsDir });
		expect(afterUninstall.plugins.map((plugin) => plugin.id)).not.toContain("steppage");
	});

	test("treats a Step login credential as satisfying a provisioned environment requirement", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-plugins-requires-env-"));
		roots.push(root);
		const pluginDir = join(root, "steppage");
		await mkdir(pluginDir, { recursive: true });
		await writeFile(
			join(pluginDir, "step.plugin.json"),
			JSON.stringify({
				id: "steppage",
				provision: {
					command: "steppage-mcp",
					installer: "https://example.invalid/i.sh",
					requiresEnv: ["STEPFUN_API_KEY"],
				},
			}),
		);
		const authPath = join(root, "auth.json");
		await writeFile(
			authPath,
			JSON.stringify({ step: { type: "oauth", access: "login-key", refresh: "r", expires: 0 } }),
		);

		// A logged-in user exports nothing by hand: the credential on disk is what
		// the server is spawned with, so the doctor must not report it as missing.
		const loggedIn = await diagnoseStepPlugin(pluginDir, { env: {}, authPath });
		expect(loggedIn.warnings.join(" ")).not.toContain("STEPFUN_API_KEY");

		// With neither a shell value nor a credential the warning is real advice.
		const loggedOut = await diagnoseStepPlugin(pluginDir, { env: {}, authPath: join(root, "absent.json") });
		expect(loggedOut.warnings.join(" ")).toContain("STEPFUN_API_KEY");
		expect(loggedOut.warnings.join(" ")).toContain("/login");
	});

	test("accepts a requirement satisfied by the provisioned server's own declared env", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-plugins-declared-env-"));
		roots.push(root);
		const pluginDir = join(root, "declared");
		await mkdir(pluginDir, { recursive: true });
		await writeFile(
			join(pluginDir, "step.plugin.json"),
			JSON.stringify({
				id: "declared",
				mcpServers: { declared: { command: "steppage-mcp", env: { STEPFUN_API_KEY: "declared-key" } } },
				provision: { command: "steppage-mcp", requiresEnv: ["STEPFUN_API_KEY"] },
			}),
		);

		// The runtime layers the server's declared env over the process env, so a
		// manifest that carries its own key needs neither a shell value nor a login.
		const diagnostics = await diagnoseStepPlugin(pluginDir, { env: {}, authPath: join(root, "absent.json") });
		expect(diagnostics.warnings.join(" ")).not.toContain("STEPFUN_API_KEY");
	});

	test("points a non-login variable at configuration rather than /login", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-plugins-other-env-"));
		roots.push(root);
		const pluginDir = join(root, "other");
		await mkdir(pluginDir, { recursive: true });
		await writeFile(
			join(pluginDir, "step.plugin.json"),
			JSON.stringify({
				id: "other",
				mcpServers: { other: { command: "other-mcp" } },
				provision: { command: "other-mcp", requiresEnv: ["GITHUB_TOKEN"] },
			}),
		);

		// A Step login cannot supply someone else's token, so it must not be the advice.
		const diagnostics = await diagnoseStepPlugin(pluginDir, { env: {}, authPath: join(root, "absent.json") });
		expect(diagnostics.warnings.join(" ")).toContain("GITHUB_TOKEN");
		expect(diagnostics.warnings.join(" ")).not.toContain("/login");
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

	test("lists a shared user and project plugin root once as user plugins", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-plugins-shared-root-"));
		roots.push(root);
		const userDir = join(root, ".stepcode", "plugins");
		await writePlugin(userDir, "steppage", "steppage", "StepPage");

		const listed = await listInstalledStepPlugins({ userDir, projectDir: userDir });
		expect(listed.plugins).toHaveLength(1);
		expect(listed.plugins[0]).toMatchObject({ id: "steppage", source: "user" });
		expect(listed.warnings).toEqual([]);
	});

	test("recognizes a symlink to the user plugin root as the same installation", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-plugins-aliased-root-"));
		roots.push(root);
		const userDir = join(root, "user");
		const projectDir = join(root, "project-alias");
		await writePlugin(userDir, "steppage", "steppage", "StepPage");
		await symlink(userDir, projectDir, process.platform === "win32" ? "junction" : "dir");

		const listed = await listInstalledStepPlugins({ userDir, projectDir });
		expect(listed.plugins).toHaveLength(1);
		expect(listed.plugins[0]).toMatchObject({ id: "steppage", source: "user", rootPath: join(userDir, "steppage") });
		expect(listed.warnings).toEqual([]);
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

/** Write a marketplace checkout with one directory and manifest per declared plugin. */
async function writeMarketplace(
	marketplaceDir: string,
	manifest: { name: string; plugins: Array<{ name: string; source: string }> },
): Promise<void> {
	await mkdir(join(marketplaceDir, ".step-plugin"), { recursive: true });
	await writeFile(join(marketplaceDir, ".step-plugin", "marketplace.json"), JSON.stringify(manifest));
	for (const plugin of manifest.plugins) {
		await mkdir(join(marketplaceDir, plugin.source), { recursive: true });
		await writeFile(
			join(marketplaceDir, plugin.source, "step.plugin.json"),
			JSON.stringify({ id: plugin.name, name: plugin.name }),
		);
	}
}

/** A plugin exposing one conventional `skills/` directory. */
async function writeMarketplacePlaceholder(pluginDir: string, skillName: string): Promise<void> {
	await mkdir(join(pluginDir, "skills", skillName), { recursive: true });
	await writeFile(join(pluginDir, "step.plugin.json"), JSON.stringify({ id: pluginDir.split("/").pop() }));
}

async function writePlugin(root: string, directory: string, id: string, name: string): Promise<void> {
	const pluginDir = join(root, directory);
	await mkdir(pluginDir, { recursive: true });
	await writeFile(join(pluginDir, "step.plugin.json"), JSON.stringify({ id, name }));
}
