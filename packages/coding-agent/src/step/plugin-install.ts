import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import { parseMcpSettingsServerConfig } from "./mcp-settings-secrets.ts";
import {
	MAX_PLUGIN_EXPANDED_BYTES,
	MAX_PLUGIN_FILES,
	type PluginFile,
	PluginInstallError,
	safePluginPath,
} from "./plugin-archive.ts";
import type { PluginDependencyState } from "./plugin-dependencies.ts";
import {
	defaultStepPluginsDir,
	listInstalledStepPlugins,
	parseStepPluginManifest,
	type StepPluginManifest,
} from "./plugins.ts";

export interface PluginInstallPreview {
	readonly id: string;
	readonly name: string;
	readonly fingerprint: string;
	readonly skills: readonly string[];
	readonly commands: readonly string[];
	readonly mcpServers: readonly string[];
	readonly requiresEnv: readonly string[];
	readonly provisionCommand?: string;
	readonly dependency?: PluginDependencyState;
	readonly warnings: readonly string[];
}
export interface PluginPackage {
	readonly files: readonly PluginFile[];
	readonly manifest: StepPluginManifest;
	readonly preview: PluginInstallPreview;
}

/** Single plugin root, either flat or wrapped in one folder; payload paths never determine destination. */
export function preparePluginPackage(input: readonly PluginFile[]): PluginPackage {
	if (!input.length || input.length > MAX_PLUGIN_FILES)
		throw new PluginInstallError("Plugin package is empty or too large");
	const roots = input.filter((file) => file.path === "step.plugin.json" || file.path.endsWith("/step.plugin.json"));
	const candidates = roots.length
		? roots
		: input.filter(
				(file) => file.path === ".claude-plugin/plugin.json" || file.path.endsWith("/.claude-plugin/plugin.json"),
			);
	if (candidates.length !== 1) throw new PluginInstallError("ZIP must contain exactly one plugin manifest");
	const manifestFile = candidates[0];
	const suffix = roots.length ? "step.plugin.json" : ".claude-plugin/plugin.json";
	const prefix = manifestFile.path.slice(0, -suffix.length);
	const files = input.map((file) => {
		if (!file.path.startsWith(prefix)) throw new PluginInstallError("Files outside the plugin root are not allowed");
		return { ...file, path: file.path.slice(prefix.length) };
	});
	const seen = new Set<string>();
	let bytes = 0;
	for (const file of files) {
		const key = file.path.normalize("NFC").toLowerCase();
		if (!safePluginPath(file.path) || seen.has(key)) throw new PluginInstallError("Unsafe or duplicate plugin path");
		seen.add(key);
		bytes += file.data.length;
		if (bytes > MAX_PLUGIN_EXPANDED_BYTES) throw new PluginInstallError("Plugin expands beyond 64 MiB");
	}
	if (manifestFile.data.length > 1024 * 1024) throw new PluginInstallError("Plugin manifest is too large");
	let raw: unknown;
	try {
		raw = JSON.parse(manifestFile.data.toString("utf8"));
	} catch {
		throw new PluginInstallError("Plugin manifest is not valid JSON");
	}
	if (!roots.length && raw && typeof raw === "object" && !Array.isArray(raw)) {
		const declaration = raw as Record<string, unknown>;
		raw = { ...declaration, id: declaration.id ?? declaration.name };
		const normalized = raw as Record<string, unknown>;
		if (normalized.mcpServers === undefined && seen.has(".mcp.json")) normalized.mcpServers = ".mcp.json";
		for (const key of ["skills", "commands"] as const)
			if (normalized[key] === undefined && files.some((file) => file.path.startsWith(`${key}/`)))
				normalized[key] = [key];
	}
	const parsed = parseStepPluginManifest(raw, "plugin manifest");
	if (!parsed.manifest) throw new PluginInstallError(parsed.errors.join("; "));
	const manifest = parsed.manifest;
	if (!safePluginPath(manifest.id) || manifest.id.length > 200)
		throw new PluginInstallError("Plugin identifier is not a portable directory name");
	for (const path of manifest.skills ?? []) {
		const usable = files.some((file) => {
			if (!file.path.startsWith(`${path}/`) || !/(^|\/)SKILL\.md$/u.test(file.path)) return false;
			try {
				const { frontmatter } = parseFrontmatter<Record<string, unknown>>(file.data.toString("utf8"));
				return typeof frontmatter.description === "string" && Boolean(frontmatter.description.trim());
			} catch {
				return false;
			}
		});
		if (!usable) throw new PluginInstallError(`Skill entry is missing or invalid: ${path}/SKILL.md`);
	}
	for (const path of manifest.commands ?? []) {
		if (!files.some((file) => (file.path === path || file.path.startsWith(`${path}/`)) && file.path.endsWith(".md")))
			throw new PluginInstallError(`Command entry is missing: ${path}`);
	}
	let servers: unknown = manifest.mcpServers ?? {};
	if (typeof servers === "string") {
		const file = files.find((file) => file.path === servers);
		if (!file) throw new PluginInstallError("MCP declaration file is missing");
		try {
			servers = JSON.parse(file.data.toString("utf8"));
		} catch {
			throw new PluginInstallError("MCP declaration is not valid JSON");
		}
		if (servers && typeof servers === "object" && "mcpServers" in servers) servers = servers.mcpServers;
	}
	if (!servers || typeof servers !== "object" || Array.isArray(servers))
		throw new PluginInstallError("Invalid MCP declarations");
	for (const [name, server] of Object.entries(servers)) {
		if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(name) || !server || typeof server !== "object" || Array.isArray(server))
			throw new PluginInstallError("Invalid MCP server declaration");
		try {
			parseMcpSettingsServerConfig(server);
		} catch {
			throw new PluginInstallError(`Invalid configuration for MCP server ${name}`);
		}
	}
	const hash = createHash("sha256");
	for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
		hash.update(`${file.path}\0${file.data.length}\0${Boolean(file.executable)}\0`);
		hash.update(file.data);
	}
	const warnings = ["Skills and commands apply to new or reloaded sessions."];
	if (manifest.provision)
		warnings.push(`CLI dependency declared: ${manifest.provision.command}. First-use configuration may be required.`);
	if (manifest.entry || manifest.agents?.length)
		warnings.push("Plugin entry and agent definitions are not executed by this installer.");
	return {
		files,
		manifest,
		preview: {
			id: manifest.id,
			name: manifest.name ?? manifest.id,
			fingerprint: hash.digest("hex"),
			skills: manifest.skills ?? [],
			commands: manifest.commands ?? [],
			mcpServers: Object.keys(servers),
			requiresEnv: manifest.provision?.requiresEnv ?? [],
			provisionCommand: manifest.provision?.command,
			warnings,
		},
	};
}

/** Content provenance only, not a trust verdict. Edited or linked files stay custom. */
export async function pluginPackageMatchesDirectory(pkg: Pick<PluginPackage, "files">, root: string): Promise<boolean> {
	const expected = new Map(pkg.files.map((file) => [file.path, file.data]));
	let entries = 0;
	const visit = async (relative: string, depth: number): Promise<boolean> => {
		if (depth > 32 || ++entries > Math.max(MAX_PLUGIN_FILES * 2, pkg.files.length * 3)) return false;
		const path = relative ? join(root, relative) : root;
		const info = await lstat(path);
		if (info.isSymbolicLink()) return false;
		if (info.isDirectory()) {
			for (const name of await readdir(path))
				if (!(await visit(relative ? `${relative}/${name}` : name, depth + 1))) return false;
			return true;
		}
		const data = expected.get(relative);
		if (!info.isFile() || !data || info.size !== data.length || !(await readFile(path)).equals(data)) return false;
		expected.delete(relative);
		return true;
	};
	try {
		return (await visit("", 0)) && expected.size === 0;
	} catch {
		return false;
	}
}

/** Validate first, hold an exclusive per-id lock, stage privately and publish without overwriting. */
export async function installPreparedPlugin(
	pkg: PluginPackage,
	pluginsDir = defaultStepPluginsDir(),
): Promise<PluginInstallPreview> {
	await mkdir(pluginsDir, { recursive: true, mode: 0o700 });
	const lockPath = join(pluginsDir, `.install-${pkg.manifest.id.toLowerCase()}.lock`);
	let compromised = false;
	const release = await lockfile
		.lock(pluginsDir, {
			lockfilePath: lockPath,
			realpath: false,
			stale: 60000,
			update: 10000,
			onCompromised: () => {
				compromised = true;
			},
		})
		.catch(() => {
			throw new PluginInstallError("Plugin installation is already in progress", 409);
		});
	let stage: string | undefined;
	try {
		const target = join(pluginsDir, pkg.manifest.id);
		const installed = await listInstalledStepPlugins({ userDir: pluginsDir });
		if (
			installed.plugins.some((plugin) => plugin.id.toLowerCase() === pkg.manifest.id.toLowerCase()) ||
			(await lstat(target).then(
				() => true,
				() => false,
			))
		)
			throw new PluginInstallError("Plugin is already installed; remove it before installing another version", 409);
		stage = await mkdtemp(join(pluginsDir, ".install-stage-"));
		for (const file of pkg.files) {
			const path = join(stage, file.path);
			await mkdir(dirname(path), { recursive: true, mode: 0o700 });
			await writeFile(path, file.data, { flag: "wx", mode: file.executable ? 0o700 : 0o600 });
		}
		if (compromised) throw new PluginInstallError("Plugin installation lock was lost; retry", 409);
		await rename(stage, target);
		stage = undefined;
		return pkg.preview;
	} finally {
		if (stage) await rm(stage, { recursive: true, force: true });
		await release();
	}
}
