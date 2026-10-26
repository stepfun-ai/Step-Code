import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "smol-toml";
import {
	addMarketplace,
	createSkill,
	deleteMcpServer,
	deleteSkill,
	importSkill,
	installPlugin,
	listMcpServers,
	listPlugins,
	listSkills,
	parseMcpServerConfig,
	removeMarketplace,
	removePlugin,
	SettingsError,
	saveMcpServer,
	setMcpServerEnabled,
	setSkillEnabled,
} from "../src/settings.ts";

// Every function reads the user's StepCode folders from the environment, so the
// whole file runs against a scratch HOME and never touches the real ~/.stepcode.
const ENV_KEYS = ["HOME", "STEP_CODING_AGENT_DIR", "STEPCODE_STORAGE_ROOT_DIR", "STEPCODE_CONFIG_DIR"] as const;
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
let home = "";

test.before(async () => {
	home = await realpath(await mkdtemp(join(tmpdir(), "stepcode-web-settings-")));
	for (const key of ENV_KEYS) delete process.env[key];
	process.env.HOME = home;
});

test.after(async () => {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await rm(home, { recursive: true, force: true });
});

async function rejectsWith(promise: Promise<unknown> | (() => unknown), status: number): Promise<void> {
	await assert.rejects(
		async () => (typeof promise === "function" ? promise() : promise),
		(error: unknown) => error instanceof SettingsError && error.status === status,
	);
}

async function writePlugin(id: string, manifest: Record<string, unknown>): Promise<string> {
	const dir = join(home, ".stepcode", "plugins", id);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "step.plugin.json"), JSON.stringify({ id, ...manifest }));
	return dir;
}

test("server declarations need exactly one transport and keep only known fields", () => {
	assert.deepEqual(parseMcpServerConfig({ command: " npx ", args: ["-y", "pkg"], env: { A: "1" }, junk: 1 }), {
		command: "npx",
		args: ["-y", "pkg"],
		env: { A: "1" },
	});
	assert.deepEqual(parseMcpServerConfig({ url: "https://mcp.example.com/mcp", http_headers: { X: "y" } }), {
		url: "https://mcp.example.com/mcp",
		http_headers: { X: "y" },
	});
	for (const bad of [{}, { command: "a", url: "https://x" }, { url: "ftp://x" }, { command: "a", args: [1] }]) {
		assert.throws(() => parseMcpServerConfig(bad), SettingsError);
	}
});

test("replacing a server keeps the tool lists, env headers and OAuth it was given", async () => {
	const config = {
		url: "https://mcp.example.com/mcp",
		env_http_headers: { "X-Key": "MCP_KEY" },
		oauth: { client_id: "id", scopes: ["read"], callback_port: 8123 },
		enabled_tools: ["read"],
		disabled_tools: ["write"],
	};
	assert.deepEqual(parseMcpServerConfig(config), config);
	// An empty allow list means "no tool reachable", so it must not be dropped as unset.
	assert.deepEqual(parseMcpServerConfig({ command: "node", enabled_tools: [] }), {
		command: "node",
		enabled_tools: [],
	});
	for (const bad of [{ command: "a", enabled_tools: "read" }, { url: "https://x", oauth: { callback_port: 0 } }]) {
		assert.throws(() => parseMcpServerConfig(bad), SettingsError);
	}

	saveMcpServer("guarded", { command: "node" }, { replace: false });
	saveMcpServer("guarded", { ...config }, { replace: true });
	const saved = (await listMcpServers()).find((server) => server.name === "guarded")?.config;
	assert.deepEqual(saved?.enabled_tools, ["read"]);
	assert.deepEqual(saved?.disabled_tools, ["write"]);
	assert.deepEqual(saved?.env_http_headers, { "X-Key": "MCP_KEY" });
	assert.equal(saved?.oauth?.client_id, "id");
	deleteMcpServer("guarded");
});

test("a server's shared flag is accepted and kept when the form edits it without one", async () => {
	assert.deepEqual(parseMcpServerConfig({ command: "node", shared: false }), { command: "node", shared: false });
	assert.throws(() => parseMcpServerConfig({ command: "node", shared: "no" }), SettingsError);
	saveMcpServer("browser", { command: "node", shared: false }, { replace: false });
	// The settings form has no sharing switch, so its edit carries no `shared`.
	saveMcpServer("browser", { command: "node", args: ["server.js"] }, { replace: true });
	const saved = (await listMcpServers()).find((server) => server.name === "browser")?.config;
	assert.equal(saved?.shared, false);
	assert.deepEqual(saved?.args, ["server.js"]);
	deleteMcpServer("browser");
});

test("user MCP servers are added, replaced, switched off and deleted in config.toml", async () => {
	saveMcpServer("files", { command: "node", args: ["server.js"] }, { replace: false });
	await rejectsWith(() => saveMcpServer("files", { command: "node" }, { replace: false }), 409);
	await rejectsWith(() => saveMcpServer("missing", { command: "node" }, { replace: true }), 404);
	await rejectsWith(() => saveMcpServer("a__b", { command: "node" }, { replace: false }), 400);

	saveMcpServer("files", { url: "https://mcp.example.com" }, { replace: true });
	let files = (await listMcpServers()).find((server) => server.name === "files");
	assert.equal(files?.source, "user");
	assert.equal(files?.transport, "http");
	assert.equal(files?.enabled, true);

	await setMcpServerEnabled("files", false);
	files = (await listMcpServers()).find((server) => server.name === "files");
	assert.equal(files?.enabled, false);
	assert.match(await readFile(join(home, ".stepcode", "config.toml"), "utf8"), /enabled = false/u);
	await setMcpServerEnabled("files", true);
	assert.equal((await listMcpServers()).find((server) => server.name === "files")?.enabled, true);

	deleteMcpServer("files");
	assert.equal((await listMcpServers()).some((server) => server.name === "files"), false);
	await rejectsWith(() => deleteMcpServer("files"), 404);
});

test("a plugin server is switched off by an override entry that is removed again on re-enable", async () => {
	await writePlugin("demo", { name: "Demo", mcpServers: { srv: { command: "node" } } });
	try {
		let server = (await listMcpServers()).find((entry) => entry.name === "demo__srv");
		assert.deepEqual(
			{ source: server?.source, pluginName: server?.pluginName, enabled: server?.enabled },
			{ source: "plugin", pluginName: "Demo", enabled: true },
		);
		await setMcpServerEnabled("demo__srv", false);
		server = (await listMcpServers()).find((entry) => entry.name === "demo__srv");
		assert.equal(server?.source, "plugin");
		assert.equal(server?.enabled, false);
		await setMcpServerEnabled("demo__srv", true);
		assert.doesNotMatch(await readFile(join(home, ".stepcode", "config.toml"), "utf8"), /demo__srv/u);
		await rejectsWith(setMcpServerEnabled("nobody__srv", false), 404);
	} finally {
		await rm(join(home, ".stepcode", "plugins", "demo"), { recursive: true, force: true });
	}
});

test("skills are created, switched off, imported and deleted in the user skill folder", async () => {
	await createSkill({ name: "release-notes", description: "Write release notes: short", instructions: "Do it." });
	await rejectsWith(createSkill({ name: "release-notes", description: "x", instructions: "" }), 409);
	await rejectsWith(createSkill({ name: "Bad Name", description: "x", instructions: "" }), 400);
	await rejectsWith(createSkill({ name: "no-description", description: " ", instructions: "" }), 400);

	let skill = (await listSkills()).find((entry) => entry.name === "release-notes");
	assert.equal(skill?.description, "Write release notes: short");
	assert.deepEqual(
		{ source: skill?.source, enabled: skill?.enabled, toggleable: skill?.toggleable, deletable: skill?.deletable },
		{ source: "user", enabled: true, toggleable: true, deletable: true },
	);
	const location = (skill?.location ?? "").replaceAll("\\", "/");
	assert.ok(location.includes("/skills/release-notes/SKILL.md") || location.startsWith("~/"));

	await setSkillEnabled(skill?.id ?? "", false);
	skill = (await listSkills()).find((entry) => entry.name === "release-notes");
	assert.equal(skill?.enabled, false);
	const config = parse(await readFile(join(home, ".stepcode", "config.toml"), "utf8"));
	assert.deepEqual(config.skills, [`-${join("skills", "release-notes", "SKILL.md")}`]);

	const source = join(home, "downloads", "lint-fix");
	await mkdir(source, { recursive: true });
	await writeFile(join(source, "SKILL.md"), "---\nname: lint-fix\ndescription: Fix lint\n---\nRun the linter.\n");
	assert.deepEqual(await importSkill(source), { name: "lint-fix" });
	await rejectsWith(importSkill(source), 409);
	await rejectsWith(importSkill(join(home, "downloads")), 400);
	assert.equal((await listSkills()).find((entry) => entry.name === "lint-fix")?.enabled, true);

	await deleteSkill(skill?.id ?? "");
	assert.equal((await listSkills()).some((entry) => entry.name === "release-notes"), false);
	assert.doesNotMatch(await readFile(join(home, ".stepcode", "config.toml"), "utf8"), /release-notes/u);
	await rejectsWith(deleteSkill(skill?.id ?? ""), 404);
});

test("skills in shared folders can be switched but not deleted, and plugin skills are read-only", async () => {
	const shared = join(home, ".claude", "skills", "shared-skill");
	await mkdir(shared, { recursive: true });
	await writeFile(join(shared, "SKILL.md"), "---\nname: shared-skill\ndescription: Shared\n---\n");
	const plugin = await writePlugin("helper", { name: "Helper" });
	await mkdir(join(plugin, "skills", "helper-skill"), { recursive: true });
	await writeFile(
		join(plugin, "skills", "helper-skill", "SKILL.md"),
		"---\nname: helper-skill\ndescription: From a plugin\n---\n",
	);
	try {
		const skills = await listSkills();
		const sharedSkill = skills.find((entry) => entry.name === "shared-skill");
		assert.equal(sharedSkill?.toggleable, true);
		assert.equal(sharedSkill?.deletable, false);
		await rejectsWith(deleteSkill(sharedSkill?.id ?? ""), 403);
		assert.ok(await stat(shared));

		const pluginSkill = skills.find((entry) => entry.name === "helper-skill");
		assert.deepEqual(
			{ source: pluginSkill?.source, pluginName: pluginSkill?.pluginName, toggleable: pluginSkill?.toggleable },
			{ source: "plugin", pluginName: "Helper", toggleable: false },
		);
		await rejectsWith(setSkillEnabled(pluginSkill?.id ?? "", false), 404);
	} finally {
		await rm(join(home, ".claude"), { recursive: true, force: true });
		await rm(plugin, { recursive: true, force: true });
	}
});

test("plugins install from a local marketplace and uninstall; marketplaces are added and removed", async () => {
	const market = join(home, "my-market");
	await mkdir(join(market, ".step-plugin"), { recursive: true });
	await mkdir(join(market, "notes"), { recursive: true });
	await writeFile(
		join(market, ".step-plugin", "marketplace.json"),
		JSON.stringify({ name: "my-market", plugins: [{ name: "notes", description: "Notes", source: "./notes" }] }),
	);
	await writeFile(join(market, "notes", "step.plugin.json"), JSON.stringify({ id: "notes", name: "Notes" }));

	await addMarketplace(market);
	await rejectsWith(addMarketplace(join(home, "nowhere")), 400);
	let catalog = await listPlugins();
	assert.ok(catalog.marketplaces.some((entry) => entry.name === "builtin" && entry.kind === "builtin"));
	assert.ok(catalog.marketplaces.some((entry) => entry.name === "my-market"));
	assert.deepEqual(
		catalog.available.find((entry) => entry.name === "notes"),
		{ name: "notes", description: "Notes", marketplace: "my-market", installed: false },
	);

	await installPlugin("notes", "my-market");
	await rejectsWith(installPlugin("notes"), 409);
	await rejectsWith(installPlugin("missing"), 404);
	catalog = await listPlugins();
	assert.equal(catalog.installed.find((plugin) => plugin.id === "notes")?.name, "Notes");
	assert.equal(catalog.available.find((entry) => entry.name === "notes")?.installed, true);

	await removePlugin("notes");
	assert.equal((await listPlugins()).installed.some((plugin) => plugin.id === "notes"), false);
	await rejectsWith(removePlugin("notes"), 404);

	await removeMarketplace("my-market");
	assert.equal((await listPlugins()).marketplaces.some((entry) => entry.name === "my-market"), false);
	await rejectsWith(removeMarketplace("builtin"), 400);
});
