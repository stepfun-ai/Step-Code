/**
 * Settings screen back end: MCP servers, plugins and marketplaces, and skills.
 *
 * Every function reads and writes the user's global StepCode configuration
 * through `@step-harness/coding-agent`, the same files `step mcp`, `/plugin`
 * and the TUI resource selector use. Project scope is not offered here. MCP
 * changes reach running sessions too: each session re-reads its MCP servers
 * before the next model request. Skills still load with a session's
 * resources, so the client tells the user that new sessions pick them up.
 */

import { realpathSync } from "node:fs";
import { cp, lstat, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
	addMarketplaceSource,
	createStepSettingsManager,
	DefaultPackageManager,
	defaultMarketplaceRoots,
	defaultStepPluginsDir,
	discoverStepPluginResourcePaths,
	ensureBuiltinMarketplace,
	getStepMcpStatuses,
	installMarketplacePlugin,
	listInstalledStepPlugins,
	listMarketplacePlugins,
	listMarketplaceSources,
	listStepPluginMcpServers,
	loadSkillsFromDir,
	parseFrontmatter,
	readGlobalStepConfig,
	removeMarketplaceSource,
	resolveStepAgentDir,
	resolveStepConfigDir,
	resolveStepHomeDir,
	type StepMcpServerConfig,
	type StepMcpStatus,
	uninstallPlugin,
	updateGlobalMcpConfig,
	updateMarketplaceSource,
} from "@step-harness/coding-agent";

/** A caller mistake the server answers with 4xx (`status`), not 500. */
export class SettingsError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

// ── MCP servers ──────────────────────────────────────────────────────────────

export interface WebMcpServer {
	readonly name: string;
	/** `user`: an entry of `mcp_servers` in config.toml. `plugin`: declared by an installed plugin. */
	readonly source: "user" | "plugin";
	readonly pluginName?: string;
	readonly transport: "stdio" | "http";
	readonly enabled: boolean;
	/** The stored declaration; user servers only (plugin declarations belong to the plugin). */
	readonly config?: StepMcpServerConfig;
	/** Last known connection state in this host process; absent until a session has started it. */
	readonly status?: StepMcpStatus["status"];
	readonly toolCount?: number;
	readonly error?: string;
}

/** Names a user may give a server. `__` is reserved: it joins a plugin id to its server name. */
const MCP_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringRecord(value: unknown, field: string): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new SettingsError(400, `${field} must be an object of strings`);
	const result: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry !== "string") throw new SettingsError(400, `${field}.${key} must be a string`);
		if (key.trim()) result[key.trim()] = entry;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

function positiveNumber(value: unknown, field: string): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new SettingsError(400, `${field} must be a positive number`);
	}
	return value;
}

function stringList(value: unknown, field: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
		throw new SettingsError(400, `${field} must be an array of strings`);
	}
	return value;
}

function oauthConfig(value: unknown): StepMcpServerConfig["oauth"] {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new SettingsError(400, "oauth must be an object");
	const oauth: NonNullable<StepMcpServerConfig["oauth"]> = {};
	for (const key of ["client_id", "client_secret"] as const) {
		if (value[key] === undefined) continue;
		if (typeof value[key] !== "string") throw new SettingsError(400, `oauth.${key} must be a string`);
		oauth[key] = value[key];
	}
	const scopes = stringList(value.scopes, "oauth.scopes");
	if (scopes) oauth.scopes = scopes;
	if (value.callback_port !== undefined) {
		const port = value.callback_port;
		if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65535) {
			throw new SettingsError(400, "oauth.callback_port must be a port number");
		}
		oauth.callback_port = port;
	}
	return Object.keys(oauth).length > 0 ? oauth : undefined;
}

/**
 * Validate a server declaration from the client and keep only the fields the
 * kernel reads. Exactly one transport is required: `command` (stdio) or `url`
 * (streamable HTTP; there is no separate SSE transport).
 *
 * Every field the kernel reads is kept, including those the form does not show
 * (`enabled_tools`, `disabled_tools`, `env_http_headers`, `oauth`): a replace
 * writes exactly this result, so a dropped `enabled_tools` would silently expose
 * every tool of the server.
 */
export function parseMcpServerConfig(input: unknown): StepMcpServerConfig {
	if (!isRecord(input)) throw new SettingsError(400, "Server configuration must be an object");
	const command = typeof input.command === "string" ? input.command.trim() : "";
	const url = typeof input.url === "string" ? input.url.trim() : "";
	if (Boolean(command) === Boolean(url)) throw new SettingsError(400, "Set either a command or a URL");
	const config: StepMcpServerConfig = {};
	if (command) {
		config.command = command;
		if (input.args !== undefined) {
			if (!Array.isArray(input.args) || !input.args.every((arg) => typeof arg === "string")) {
				throw new SettingsError(400, "args must be an array of strings");
			}
			if (input.args.length > 0) config.args = input.args;
		}
		if (typeof input.cwd === "string" && input.cwd.trim()) config.cwd = input.cwd.trim();
		const env = stringRecord(input.env, "env");
		if (env) config.env = env;
	} else {
		try {
			const parsed = new URL(url);
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("protocol");
		} catch {
			throw new SettingsError(400, "URL must be an http(s) address");
		}
		config.url = url;
		const headers = stringRecord(input.http_headers, "http_headers");
		if (headers) config.http_headers = headers;
		if (typeof input.bearer_token_env_var === "string" && input.bearer_token_env_var.trim()) {
			config.bearer_token_env_var = input.bearer_token_env_var.trim();
		}
		const envHeaders = stringRecord(input.env_http_headers, "env_http_headers");
		if (envHeaders) config.env_http_headers = envHeaders;
		const oauth = oauthConfig(input.oauth);
		if (oauth) config.oauth = oauth;
	}
	const enabledTools = stringList(input.enabled_tools, "enabled_tools");
	// An empty allow list is meaningful (no tool reachable), so it is kept.
	if (enabledTools) config.enabled_tools = enabledTools;
	const disabledTools = stringList(input.disabled_tools, "disabled_tools");
	if (disabledTools && disabledTools.length > 0) config.disabled_tools = disabledTools;
	if (input.shared !== undefined) {
		if (typeof input.shared !== "boolean") throw new SettingsError(400, "shared must be a boolean");
		config.shared = input.shared;
	}
	const startup = positiveNumber(input.startup_timeout_sec, "startup_timeout_sec");
	if (startup !== undefined) config.startup_timeout_sec = startup;
	const toolTimeout = positiveNumber(input.tool_timeout_sec, "tool_timeout_sec");
	if (toolTimeout !== undefined) config.tool_timeout_sec = toolTimeout;
	if (input.enabled === false) config.enabled = false;
	return config;
}

function checkMcpName(name: string): void {
	if (!MCP_NAME.test(name) || name.includes("__")) {
		throw new SettingsError(400, "Name may use letters, digits, '.', '_' and '-', and must not contain '__'");
	}
}

/** User servers first, then plugin servers, each carrying the host's last known connection state. */
export async function listMcpServers(): Promise<WebMcpServer[]> {
	const statuses = new Map(getStepMcpStatuses().map((status) => [status.name, status]));
	const withStatus = (server: Omit<WebMcpServer, "status" | "toolCount" | "error">): WebMcpServer => {
		const status = statuses.get(server.name);
		return status ? { ...server, status: status.status, toolCount: status.toolCount, error: status.error } : server;
	};
	const configured = readGlobalStepConfig(process.env).mcp_servers ?? {};
	const users: WebMcpServer[] = [];
	for (const [name, config] of Object.entries(configured)) {
		// An entry without a transport is a plugin-server override (`enabled = false`), listed with its plugin.
		if (!isRecord(config) || (typeof config.command !== "string" && typeof config.url !== "string")) continue;
		users.push(
			withStatus({
				name,
				source: "user",
				transport: typeof config.command === "string" ? "stdio" : "http",
				enabled: config.enabled !== false,
				config,
			}),
		);
	}
	users.sort((left, right) => left.name.localeCompare(right.name));
	const plugins = (await listStepPluginMcpServers(resolveStepHomeDir(), false))
		.filter((server) => !users.some((user) => user.name === server.name))
		.map((server) =>
			withStatus({
				name: server.name,
				source: "plugin",
				pluginName: server.pluginName,
				transport: server.transport,
				enabled: server.enabled,
			}),
		);
	return [...users, ...plugins];
}

/** Add a server (`replace: false`, 409 when the name is taken) or replace an existing one (404 when missing). */
export function saveMcpServer(name: string, input: unknown, options: { replace: boolean }): void {
	checkMcpName(name);
	const config = parseMcpServerConfig(input);
	updateGlobalMcpConfig(process.env, (servers) => {
		const existing = servers[name];
		if (options.replace && !existing) throw new SettingsError(404, `MCP server '${name}' does not exist`);
		if (!options.replace && existing) throw new SettingsError(409, `MCP server '${name}' already exists`);
		// The settings form has no sharing switch: an edit keeps a `shared` set in config.toml.
		const kept = config.shared === undefined && isRecord(existing) && typeof existing.shared === "boolean";
		return { ...servers, [name]: kept ? { ...config, shared: existing.shared as boolean } : config };
	});
}

export function deleteMcpServer(name: string): void {
	updateGlobalMcpConfig(process.env, (servers) => {
		if (!servers[name]) throw new SettingsError(404, `MCP server '${name}' does not exist`);
		const { [name]: _removed, ...rest } = servers;
		return rest;
	});
}

/**
 * Turn a server on or off. For a plugin server the switch is an override entry
 * `mcp_servers."<plugin>__<server>" = { enabled = false }`, which discovery
 * honours; turning it back on removes the override instead of leaving an empty table.
 */
export async function setMcpServerEnabled(name: string, enabled: boolean): Promise<void> {
	const pluginServer = (await listStepPluginMcpServers(resolveStepHomeDir(), false)).some(
		(server) => server.name === name,
	);
	updateGlobalMcpConfig(process.env, (servers) => {
		const existing = servers[name];
		if (!existing && !pluginServer) throw new SettingsError(404, `MCP server '${name}' does not exist`);
		const { enabled: _previous, ...rest } = existing ?? {};
		const next: StepMcpServerConfig = enabled ? rest : { ...rest, enabled: false };
		if (Object.keys(next).length === 0) {
			const { [name]: _removed, ...others } = servers;
			return others;
		}
		return { ...servers, [name]: next };
	});
}

// ── Plugins and marketplaces ─────────────────────────────────────────────────

export interface WebPlugin {
	readonly id: string;
	readonly name: string;
	readonly version?: string;
	readonly description?: string;
	readonly mcpServers: readonly string[];
	readonly warnings: readonly string[];
}

export interface WebMarketplacePlugin {
	readonly name: string;
	readonly description?: string;
	readonly marketplace: string;
	readonly installed: boolean;
}

export interface WebMarketplace {
	readonly name: string;
	readonly kind: "builtin" | "git" | "local";
	readonly origin: string | null;
}

export interface WebPluginCatalog {
	readonly installed: readonly WebPlugin[];
	readonly available: readonly WebMarketplacePlugin[];
	readonly marketplaces: readonly WebMarketplace[];
	readonly warnings: readonly string[];
}

/** Installed user plugins, every marketplace's plugins (with an installed flag), and the marketplaces. */
export async function listPlugins(): Promise<WebPluginCatalog> {
	const builtin = await ensureBuiltinMarketplace();
	const [installed, available, sources] = await Promise.all([
		listInstalledStepPlugins(),
		listMarketplacePlugins(defaultMarketplaceRoots()),
		listMarketplaceSources(),
	]);
	const userPlugins = installed.plugins.filter((plugin) => plugin.source === "user");
	const installedNames = new Set(userPlugins.flatMap((plugin) => [plugin.id, basename(plugin.rootPath)]));
	return {
		installed: userPlugins.map((plugin) => ({
			id: plugin.id,
			name: plugin.name,
			version: plugin.version,
			description: plugin.description,
			mcpServers: plugin.mcpServers,
			warnings: plugin.warnings,
		})),
		available: available.entries.map((entry) => ({
			name: entry.name,
			description: entry.description,
			marketplace: entry.marketplace,
			installed: installedNames.has(entry.name),
		})),
		marketplaces: sources.map((source) => ({ name: source.name, kind: source.kind, origin: source.origin })),
		warnings: [...builtin.warnings, ...installed.warnings, ...available.warnings],
	};
}

/** Install a marketplace plugin into the user plugin root; returns the installer's warnings. */
export async function installPlugin(name: string, marketplace?: string): Promise<{ warnings: string[] }> {
	await ensureBuiltinMarketplace();
	const available = await listMarketplacePlugins(defaultMarketplaceRoots());
	const entry = available.entries.find(
		(candidate) => candidate.name === name && (!marketplace || candidate.marketplace === marketplace),
	);
	if (!entry) throw new SettingsError(404, `No marketplace plugin named '${name}'`);
	try {
		const result = await installMarketplacePlugin(entry, defaultStepPluginsDir());
		return { warnings: result.warnings };
	} catch (error) {
		throw new SettingsError(409, error instanceof Error ? error.message : String(error));
	}
}

export async function removePlugin(name: string): Promise<void> {
	// The id in a manifest may differ from its folder; uninstall addresses the folder.
	const { plugins } = await listInstalledStepPlugins();
	const plugin = plugins.find((candidate) => candidate.source === "user" && candidate.id === name);
	const folder = plugin ? basename(plugin.rootPath) : name;
	try {
		await uninstallPlugin(defaultStepPluginsDir(), folder);
	} catch (error) {
		throw new SettingsError(404, error instanceof Error ? error.message : String(error));
	}
}

/** Kernel marketplace operations report failure as warnings without a `source`. */
function marketplaceOutcome(result: { source?: unknown; warnings: string[] }): { warnings: string[] } {
	if (!result.source) throw new SettingsError(400, result.warnings.join(" ") || "Marketplace operation failed");
	return { warnings: result.warnings };
}

/** Add a marketplace from a local folder, a git URL or `owner/repo` (cloned from GitHub). */
export async function addMarketplace(source: string): Promise<{ warnings: string[] }> {
	return marketplaceOutcome(await addMarketplaceSource({ source }));
}

export async function removeMarketplace(name: string): Promise<void> {
	marketplaceOutcome(await removeMarketplaceSource({ name }));
}

export async function updateMarketplace(name: string): Promise<{ warnings: string[] }> {
	return marketplaceOutcome(await updateMarketplaceSource({ name }));
}

// ── Skills ───────────────────────────────────────────────────────────────────

export interface WebSkillEntry {
	/** Absolute path of the skill file: the id the toggle and delete routes take. */
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly source: "user" | "plugin";
	readonly pluginName?: string;
	/** Display location, with the home directory shortened to `~`. */
	readonly location: string;
	readonly enabled: boolean;
	/** False for skills the settings file cannot switch (plugin and package skills). */
	readonly toggleable: boolean;
	/** True only inside StepCode's own skill folders; shared folders such as ~/.claude are left alone. */
	readonly deletable: boolean;
}

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MAX_SKILL_NAME = 64;
const SKILL_FILE = "SKILL.md";

function skillContext() {
	const home = resolveStepHomeDir();
	const agentDir = resolveStepAgentDir();
	const configDirName = resolveStepConfigDir();
	// Resolved from the home directory so no project folder is read: this screen is user scope.
	const settingsManager = createStepSettingsManager(home, agentDir, { configDirName });
	const packageManager = new DefaultPackageManager({ cwd: home, agentDir, configDirName, settingsManager });
	/** Folders StepCode owns. New and imported skills go to the first. */
	const ownedDirs = [join(agentDir, "skills"), join(home, configDirName, "skills")];
	return { home, agentDir, settingsManager, packageManager, ownedDirs };
}

/**
 * The home directory shortened to `~`. Both sides go through `realpath` first:
 * on macOS a temporary home is reported as `/var/...` while `$HOME` keeps the
 * symlink spelling, and a skill found through one path must still shorten.
 */
function displayPath(home: string, path: string): string {
	const real = (value: string) => {
		try {
			return realpathSync(value);
		} catch {
			return value;
		}
	};
	const resolvedHome = real(home);
	const resolvedPath = real(path);
	if (resolvedPath === resolvedHome || resolvedPath.startsWith(`${resolvedHome}${sep}`)) {
		return `~${resolvedPath.slice(resolvedHome.length)}`;
	}
	return path;
}

function isInside(root: string, path: string): boolean {
	const rel = relative(resolve(root), resolve(path));
	return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep);
}

/** Name and description from a skill file's frontmatter; the folder name when it has none. */
async function readSkillMetadata(path: string): Promise<{ name: string; description: string }> {
	const fallback = basename(path) === SKILL_FILE ? basename(dirname(path)) : basename(path, ".md");
	try {
		const { frontmatter } = parseFrontmatter(await readFile(path, "utf8"));
		return {
			name: typeof frontmatter.name === "string" && frontmatter.name.trim() ? frontmatter.name.trim() : fallback,
			description: typeof frontmatter.description === "string" ? frontmatter.description.trim() : "",
		};
	} catch {
		// A skill with broken frontmatter still appears, so it can be found and deleted.
		return { name: fallback, description: "" };
	}
}

/** Skills in the user scope, then those contributed by installed plugins. */
export async function listSkills(): Promise<WebSkillEntry[]> {
	const { home, packageManager, ownedDirs } = skillContext();
	const resolved = await packageManager.resolve(async () => "skip");
	const users: WebSkillEntry[] = [];
	for (const resource of resolved.skills) {
		if (resource.metadata.scope !== "user") continue;
		const metadata = await readSkillMetadata(resource.path);
		const topLevel = resource.metadata.origin === "top-level";
		users.push({
			id: resource.path,
			...metadata,
			source: "user",
			location: displayPath(home, resource.path),
			enabled: resource.enabled,
			toggleable: topLevel,
			deletable: topLevel && ownedDirs.some((dir) => isInside(dir, resource.path)),
		});
	}
	users.sort((left, right) => left.name.localeCompare(right.name));

	const [{ plugins }, { skillPaths }] = await Promise.all([
		listInstalledStepPlugins(),
		discoverStepPluginResourcePaths({}),
	]);
	const fromPlugins: WebSkillEntry[] = [];
	for (const dir of skillPaths) {
		const owner = plugins.find((plugin) => isInside(plugin.rootPath, dir) || resolve(plugin.rootPath) === dir);
		for (const skill of loadSkillsFromDir({ dir, source: "plugin" }).skills) {
			fromPlugins.push({
				id: skill.filePath,
				name: skill.name,
				description: skill.description,
				source: "plugin",
				pluginName: owner?.name,
				location: displayPath(home, skill.filePath),
				enabled: true,
				toggleable: false,
				deletable: false,
			});
		}
	}
	return [...users, ...fromPlugins];
}

async function findUserSkill(id: string) {
	const context = skillContext();
	const resolved = await context.packageManager.resolve(async () => "skip");
	const resource = resolved.skills.find(
		(candidate) =>
			candidate.metadata.scope === "user" && candidate.metadata.origin === "top-level" && candidate.path === id,
	);
	if (!resource) throw new SettingsError(404, "Skill is not a user skill");
	return { ...context, resource };
}

/** Settings patterns are relative to the folder the skill was found under, as the TUI writes them. */
function skillPattern(resource: { path: string; metadata: { baseDir?: string } }, agentDir: string): string {
	return relative(resource.metadata.baseDir ?? agentDir, resource.path);
}

function withoutPattern(patterns: readonly string[], pattern: string): string[] {
	return patterns.filter((entry) => (/^[!+-]/u.test(entry) ? entry.slice(1) : entry) !== pattern);
}

async function saveSettings(settingsManager: ReturnType<typeof skillContext>["settingsManager"]): Promise<void> {
	await settingsManager.flush();
	const errors = settingsManager.drainErrors();
	if (errors.length > 0) throw new Error(errors.map((entry) => entry.error.message).join("; "));
}

/** Write `+pattern` or `-pattern` into the global `skills` list (the TUI resource selector's rule). */
export async function setSkillEnabled(id: string, enabled: boolean): Promise<void> {
	const { agentDir, settingsManager, resource } = await findUserSkill(id);
	const pattern = skillPattern(resource, agentDir);
	const current = (settingsManager.getGlobalSettings().skills ?? []) as string[];
	settingsManager.setSkillPaths([...withoutPattern(current, pattern), `${enabled ? "+" : "-"}${pattern}`]);
	await saveSettings(settingsManager);
}

function checkSkillName(name: string): void {
	if (name.length > MAX_SKILL_NAME || !SKILL_NAME.test(name)) {
		throw new SettingsError(400, "Skill name must use lowercase letters, digits and single hyphens (max 64)");
	}
}

async function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}

/** Create `<agentDir>/skills/<name>/SKILL.md`. The description is what makes the model pick the skill. */
export async function createSkill(input: {
	name: unknown;
	description: unknown;
	instructions: unknown;
}): Promise<void> {
	const name = typeof input.name === "string" ? input.name.trim() : "";
	const description = typeof input.description === "string" ? input.description.replace(/\s+/gu, " ").trim() : "";
	const instructions = typeof input.instructions === "string" ? input.instructions.trim() : "";
	checkSkillName(name);
	if (!description) throw new SettingsError(400, "Description is required");
	const { ownedDirs } = skillContext();
	const target = join(ownedDirs[0] ?? "", name);
	if (await exists(target)) throw new SettingsError(409, `Skill '${name}' already exists`);
	await mkdir(target, { recursive: true });
	// JSON string syntax is valid YAML, so quoting through JSON keeps colons and quotes safe.
	const body = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${instructions}\n`;
	await writeFile(join(target, SKILL_FILE), body, { encoding: "utf8", flag: "wx" });
}

/** Copy a local skill folder (one containing SKILL.md) into the user skill folder. */
export async function importSkill(sourcePath: unknown): Promise<{ name: string }> {
	if (typeof sourcePath !== "string" || !sourcePath.trim()) throw new SettingsError(400, "path is required");
	const source = resolve(sourcePath.trim());
	const skillFile = join(source, SKILL_FILE);
	if (!(await exists(skillFile))) throw new SettingsError(400, `No ${SKILL_FILE} in ${source}`);
	const { name } = await readSkillMetadata(skillFile);
	checkSkillName(name);
	const { ownedDirs } = skillContext();
	const target = join(ownedDirs[0] ?? "", name);
	if (resolve(source) === resolve(target)) throw new SettingsError(409, `Skill '${name}' is already installed`);
	if (await exists(target)) throw new SettingsError(409, `Skill '${name}' already exists`);
	await cp(source, target, { recursive: true, errorOnExist: true, force: false });
	return { name };
}

/**
 * Delete a skill from StepCode's own skill folders: its folder when the file is
 * `SKILL.md`, otherwise the single file. Its enable/disable pattern goes too.
 */
export async function deleteSkill(id: string): Promise<void> {
	const { agentDir, settingsManager, resource, ownedDirs } = await findUserSkill(id);
	const owner = ownedDirs.find((dir) => isInside(dir, resource.path));
	if (!owner) throw new SettingsError(403, "Only skills in StepCode's own skill folders can be deleted");
	const target = basename(resource.path) === SKILL_FILE ? dirname(resource.path) : resource.path;
	// Never remove the skill root itself, even for a SKILL.md placed directly in it.
	if (!isInside(owner, target)) throw new SettingsError(403, "Refusing to delete the skill folder root");
	const info = await lstat(target);
	await rm(target, { recursive: info.isDirectory(), force: true });
	const pattern = skillPattern(resource, agentDir);
	const current = (settingsManager.getGlobalSettings().skills ?? []) as string[];
	const remaining = withoutPattern(current, pattern);
	if (remaining.length !== current.length) {
		settingsManager.setSkillPaths(remaining);
		await saveSettings(settingsManager);
	}
}
