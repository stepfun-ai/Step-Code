/**
 * StepCode plugin marketplace facade.
 *
 * Pi's package manager can install executable extensions, but Step's built-in
 * marketplace has a deliberately smaller contract: marketplace packages are
 * declarative manifests copied into `.stepcode/plugins`. MCP processes are
 * started by the Step runtime after installation; this module owns discovery
 * and provisioning only.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BorderedLoader } from "../components/bordered-loader.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionFactory } from "../core/extensions/types.ts";
import { resolveStepConfigDir } from "./environment.ts";
import { resolveStepMcpEnvironment, STEP_LOGIN_SUPPLIED_ENV } from "./mcp-environment.ts";
import { isPathContained } from "./path-containment.ts";
import { ensureStepPageReady, stepPageInstallerUrl } from "./steppage-provision.ts";
import { resolveStepStorageRoot } from "./storage-root.ts";
import { type StepTelemetryReporter, trackStepTelemetry } from "./telemetry.ts";

const execFileAsync = promisify(execFile);

export const STEP_PLUGIN_MANIFEST_FILE = "step.plugin.json";
export const PLUGIN_MANIFEST_FILE_NAME = STEP_PLUGIN_MANIFEST_FILE;
export const CLAUDE_CODE_PLUGIN_MANIFEST_RELATIVE_PATH = path.join(".claude-plugin", "plugin.json");
export const MARKETPLACE_MANIFEST_CANDIDATES: readonly string[] = [
	path.join(".step-plugin", "marketplace.json"),
	path.join(".claude-plugin", "marketplace.json"),
];
export const MARKETPLACE_MANIFEST_RELATIVE_PATH = MARKETPLACE_MANIFEST_CANDIDATES[0]!;
export const BUILTIN_MARKETPLACE_NAME = "builtin";

const BUILTIN_FINGERPRINT_FILE = ".stepcode-builtin-fingerprint";
/** Records which built-in plugins have already been auto-installed, so a plugin
 * the user later uninstalls is not silently resurrected on the next launch. */
const PREINSTALL_MARKER_FILE = ".stepcode-preinstalled";
/** Built-in plugins provisioned into a fresh install without an explicit
 * `/plugin install`, so StepPage deployment tools are available out of the box. */
export const PREINSTALLED_BUILTIN_PLUGINS: readonly string[] = ["steppage"];
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]*$/iu;
const MAX_MANIFEST_BYTES = 512 * 1024;

/** The declarations shipped in the Step binary/source tree. */
export const BUILTIN_MARKETPLACE_FILES: Readonly<Record<string, string>> = {
	".step-plugin/marketplace.json": JSON.stringify(
		{
			name: BUILTIN_MARKETPLACE_NAME,
			description: "Plugins that ship inside the StepCode binary. Updated with the CLI itself, not fetched.",
			plugins: [
				{
					name: "playwright",
					description: "Browser automation and end-to-end testing MCP server by Microsoft.",
					source: "./playwright",
				},
				{
					name: "steppage",
					description: "Deploy and manage static sites on StepFun's Page hosting product.",
					source: "./steppage",
				},
			],
		},
		null,
	),
	"playwright/step.plugin.json": JSON.stringify(
		{
			id: "playwright",
			name: "Playwright",
			description:
				"Browser automation and end-to-end testing MCP server by Microsoft. Drives web pages, takes screenshots, fills forms, clicks elements and runs automated browser test flows.",
			version: "0.1.0",
			mcpServers: {
				playwright: { command: "npx", args: ["@playwright/mcp@latest"] },
			},
		},
		null,
	),
	"steppage/step.plugin.json": JSON.stringify(
		{
			id: "steppage",
			name: "StepPage",
			description:
				"Deploy and manage static sites on StepFun's Page hosting product. Publishes a local directory or .zip, lists sites and versions, promotes or rolls back a release, and mints shareable preview links.",
			version: "1.0.0",
			mcpServers: {
				steppage: { command: "steppage-mcp" },
			},
			provision: {
				command: "steppage-mcp",
				installer: "steppageInstaller",
				requiresEnv: ["STEPFUN_API_KEY"],
			},
		},
		null,
	),
};

export interface StepPluginProvision {
	command: string;
	installer?: string;
	requiresEnv?: string[];
}

export interface StepPluginManifest {
	id: string;
	name?: string;
	description?: string;
	version?: string;
	entry?: string;
	skills?: string[];
	agents?: string[];
	commands?: string[];
	mcpServers?: Record<string, unknown> | string;
	provision?: StepPluginProvision;
}

export interface ParsedStepPluginManifest {
	manifest?: StepPluginManifest;
	errors: string[];
}

export interface MarketplacePluginEntry {
	name: string;
	description?: string;
	sourcePath: string;
	marketplace: string;
	declaration: Record<string, unknown>;
}

export interface ListMarketplacePluginsResult {
	entries: MarketplacePluginEntry[];
	warnings: string[];
}

export interface StepPluginDiagnostics {
	mcpServers: string[];
	warnings: string[];
}

export interface InstalledStepPlugin {
	id: string;
	name: string;
	version?: string;
	description?: string;
	rootPath: string;
	source: "user" | "project";
	mcpServers: string[];
	warnings: string[];
}

export interface MarketplaceSource {
	name: string;
	path: string;
	origin: string | null;
	kind: "builtin" | "git" | "local";
}

export interface MarketplaceOperationResult {
	source?: MarketplaceSource;
	warnings: string[];
}

/** Compatibility name used by the original StepCode marketplace facade. */
export type AcquireMarketplaceResult = MarketplaceOperationResult;

export interface StepPluginCommandOptions {
	storageRootDir?: string;
	pluginsDir?: string;
	marketplacesDir?: string;
	telemetry?: StepTelemetryReporter;
}

/** Legacy aliases retained for callers migrating from stepcode. */
export function defaultUserPluginsDir(env: NodeJS.ProcessEnv = process.env): string {
	return defaultStepPluginsDir(env);
}

export function defaultUserMarketplacesDir(env: NodeJS.ProcessEnv = process.env): string {
	return defaultStepMarketplacesDir(env);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pathExists(candidate: string): Promise<boolean> {
	return fs
		.access(candidate)
		.then(() => true)
		.catch(() => false);
}

function isSafeName(value: string): boolean {
	return SAFE_NAME.test(value) && value !== "." && value !== "..";
}

function normalizeRelativePath(value: unknown): string | undefined {
	if (typeof value !== "string" || value.trim() === "") return undefined;
	const normalized = value.trim();
	if (path.isAbsolute(normalized) || /^[a-z]:[\\/]/iu.test(normalized) || normalized.startsWith("\\\\"))
		return undefined;
	const resolved = path.posix.normalize(normalized.replaceAll(/\\/gu, "/"));
	if (resolved === "." || resolved === ".." || resolved.startsWith("../")) return undefined;
	return resolved;
}

/** Resolve the clone source forms accepted by the Step marketplace command. */
export function resolveMarketplaceCloneUrl(source: string): string | undefined {
	const trimmed = source.trim();
	if (!trimmed || trimmed.startsWith("-")) return undefined;
	if (/^(?:https?:\/\/|git@|ssh:\/\/|git:\/\/|file:\/\/)/iu.test(trimmed)) return trimmed;
	if (/^[\w.-]+\/[\w.-]+$/u.test(trimmed)) return `https://github.com/${trimmed}.git`;
	return undefined;
}

/** Derive a safe checkout name from a clone URL or local path. */
export function resolveMarketplaceName(source: string): string | undefined {
	return deriveMarketplaceName(source);
}

function isLocalMarketplacePath(source: string): boolean {
	return (
		path.isAbsolute(source) ||
		source === "." ||
		source === ".." ||
		source.startsWith(`.${path.sep}`) ||
		source.startsWith("./") ||
		source.startsWith("../")
	);
}

/** Resolve the product-owned plugin roots. */
export function defaultStepPluginsDir(
	env: NodeJS.ProcessEnv = process.env,
	options: { cwd?: string; project?: boolean; storageRootDir?: string } = {},
): string {
	if (options.project) {
		return path.join(options.cwd ?? process.cwd(), resolveStepConfigDir(env), "plugins");
	}
	return path.join(options.storageRootDir?.trim() || resolveStepStorageRoot(env), "plugins");
}

export function defaultStepMarketplacesDir(env: NodeJS.ProcessEnv = process.env, storageRootDir?: string): string {
	return path.join(storageRootDir?.trim() || resolveStepStorageRoot(env), "marketplaces");
}

export function defaultMarketplaceRoots(
	env: NodeJS.ProcessEnv = process.env,
	options: { cwd?: string; includeProject?: boolean; storageRootDir?: string } = {},
): string[] {
	const globalRoot = defaultStepMarketplacesDir(env, options.storageRootDir);
	if (options.includeProject) {
		return [path.join(options.cwd ?? process.cwd(), resolveStepConfigDir(env), "marketplaces"), globalRoot];
	}
	return [globalRoot];
}

/** Find the first supported marketplace manifest in a checkout. */
export async function findMarketplaceManifest(dir: string): Promise<string | undefined> {
	for (const candidate of MARKETPLACE_MANIFEST_CANDIDATES) {
		const resolved = path.join(dir, candidate);
		if (await pathExists(resolved)) return resolved;
	}
	return undefined;
}

/** Parse a declarative plugin manifest without executing any declared command. */
export function parseStepPluginManifest(raw: unknown, origin: string): ParsedStepPluginManifest {
	const errors: string[] = [];
	if (!isRecord(raw)) return { errors: [`${origin}: manifest must be an object`] };
	const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : undefined;
	if (!id || !isSafeName(id)) errors.push(`${origin}.id: expected a safe non-empty plugin id`);
	const manifest: StepPluginManifest = { id: id ?? "" };
	for (const key of ["name", "description", "version", "entry"] as const) {
		if (raw[key] === undefined) continue;
		if (typeof raw[key] !== "string") {
			errors.push(`${origin}.${key}: expected a string`);
		} else if (key === "entry") {
			const normalized = normalizeRelativePath(raw[key]);
			if (!normalized) errors.push(`${origin}.${key}: expected a relative path inside the package`);
			else manifest[key] = normalized;
		} else {
			manifest[key] = raw[key] as string;
		}
	}
	for (const key of ["skills", "agents", "commands"] as const) {
		if (raw[key] === undefined) continue;
		if (!Array.isArray(raw[key])) {
			errors.push(`${origin}.${key}: expected an array of relative paths`);
			continue;
		}
		const values: string[] = [];
		for (const [index, value] of (raw[key] as unknown[]).entries()) {
			const normalized = normalizeRelativePath(value);
			if (!normalized) errors.push(`${origin}.${key}[${index}]: expected a relative path inside the package`);
			else values.push(normalized);
		}
		manifest[key] = values;
	}
	if (raw.mcpServers !== undefined) {
		if (typeof raw.mcpServers === "string") {
			const normalized = normalizeRelativePath(raw.mcpServers);
			if (!normalized) errors.push(`${origin}.mcpServers: expected a relative declaration path`);
			else manifest.mcpServers = normalized;
		} else if (isRecord(raw.mcpServers)) {
			manifest.mcpServers = structuredClone(raw.mcpServers);
		} else {
			errors.push(`${origin}.mcpServers: expected an object or relative path`);
		}
	}
	if (raw.provision !== undefined) {
		if (!isRecord(raw.provision) || typeof raw.provision.command !== "string" || !raw.provision.command.trim()) {
			errors.push(`${origin}.provision: expected a command declaration`);
		} else {
			const provision: StepPluginProvision = { command: raw.provision.command.trim() };
			if (raw.provision.installer !== undefined) {
				if (typeof raw.provision.installer !== "string" || !raw.provision.installer.trim()) {
					errors.push(`${origin}.provision.installer: expected a string`);
				} else provision.installer = raw.provision.installer.trim();
			}
			if (raw.provision.requiresEnv !== undefined) {
				if (
					!Array.isArray(raw.provision.requiresEnv) ||
					raw.provision.requiresEnv.some((item) => typeof item !== "string" || !item.trim())
				) {
					errors.push(`${origin}.provision.requiresEnv: expected variable names`);
				} else provision.requiresEnv = raw.provision.requiresEnv.map((item) => item.trim());
			}
			manifest.provision = provision;
		}
	}
	return errors.length > 0 || !id ? { errors } : { manifest, errors: [] };
}

export async function readStepPluginManifest(pluginDir: string): Promise<ParsedStepPluginManifest & { path: string }> {
	const manifestPath = path.join(pluginDir, STEP_PLUGIN_MANIFEST_FILE);
	const claudeManifestPath = path.join(pluginDir, CLAUDE_CODE_PLUGIN_MANIFEST_RELATIVE_PATH);
	const candidatePaths = [manifestPath, claudeManifestPath];
	for (const candidatePath of candidatePaths) {
		const parsed = await readPluginManifestAtPath(candidatePath);
		if (parsed) return parsed;
	}
	return { path: manifestPath, errors: [] };
}

async function readPluginManifestAtPath(
	manifestPath: string,
): Promise<(ParsedStepPluginManifest & { path: string }) | undefined> {
	try {
		const stat = await fs.stat(manifestPath);
		if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) {
			return { path: manifestPath, errors: [`${manifestPath}: manifest is missing or too large`] };
		}
		const raw = JSON.parse(await fs.readFile(manifestPath, "utf8")) as unknown;
		if (manifestPath.endsWith(CLAUDE_CODE_PLUGIN_MANIFEST_RELATIVE_PATH)) {
			if (!isRecord(raw)) return { path: manifestPath, errors: [`${manifestPath}: manifest must be an object`] };
			// Claude Code calls the stable identifier `name`; normalize only at this
			// boundary so the rest of the Step facade sees one schema.
			const normalized: Record<string, unknown> = { ...raw, id: raw.id ?? raw.name };
			if (
				normalized.mcpServers === undefined &&
				(await pathExists(path.join(path.dirname(path.dirname(manifestPath)), ".mcp.json")))
			) {
				normalized.mcpServers = ".mcp.json";
			}
			for (const directory of ["skills", "commands", "agents"] as const) {
				if (normalized[directory] !== undefined) continue;
				if (await pathExists(path.join(path.dirname(path.dirname(manifestPath)), directory)))
					normalized[directory] = [directory];
			}
			return { ...parseStepPluginManifest(normalized, manifestPath), path: manifestPath };
		}
		return { ...parseStepPluginManifest(raw, manifestPath), path: manifestPath };
	} catch (error) {
		if (isFileNotFound(error)) return undefined;
		return { path: manifestPath, errors: [`Invalid JSON manifest ${manifestPath}: ${describe(error)}`] };
	}
}

async function hasOwnPluginManifest(pluginDir: string): Promise<boolean> {
	return Boolean(
		(await readPluginManifestAtPath(path.join(pluginDir, STEP_PLUGIN_MANIFEST_FILE))) ||
			(await readPluginManifestAtPath(path.join(pluginDir, CLAUDE_CODE_PLUGIN_MANIFEST_RELATIVE_PATH))),
	);
}

/** List immediate plugin directories under a root. */
export async function listStepPluginDirectories(root: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(root, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isDirectory() && isSafeName(entry.name))
			.map((entry) => path.join(root, entry.name))
			.sort((left, right) => left.localeCompare(right));
	} catch {
		return [];
	}
}

/**
 * Discover installable entries from one or more local marketplace roots.
 *
 * The same marketplace checkout can be reachable from more than one root: the
 * built-in marketplace is materialized under each root's `marketplaces`
 * directory, and a project root is scanned alongside the global one. Roots are
 * already ordered by precedence, so an entry is kept only the first time its
 * name is seen and later duplicates are dropped — otherwise every built-in
 * plugin would be listed once per root.
 */
export async function listMarketplacePlugins(
	marketplaceRoots: readonly string[] = defaultMarketplaceRoots(),
): Promise<ListMarketplacePluginsResult> {
	const entries: MarketplacePluginEntry[] = [];
	const seenPluginNames = new Set<string>();
	const warnings: string[] = [];
	for (const root of marketplaceRoots) {
		const candidates = (await findMarketplaceManifest(root)) ? [root] : await listStepPluginDirectories(root);
		for (const marketplaceDir of candidates) {
			const manifestPath = await findMarketplaceManifest(marketplaceDir);
			if (!manifestPath) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(await fs.readFile(manifestPath, "utf8"));
			} catch (error) {
				warnings.push(`Invalid marketplace manifest ${manifestPath}: ${describe(error)}`);
				continue;
			}
			if (!isRecord(parsed)) {
				warnings.push(`Marketplace manifest ${manifestPath} must be an object.`);
				continue;
			}
			const marketplaceName =
				typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : path.basename(marketplaceDir);
			const plugins = Array.isArray(parsed.plugins) ? parsed.plugins : [];
			const remoteKinds = new Map<string, number>();
			for (const [index, value] of plugins.entries()) {
				if (!isRecord(value) || typeof value.name !== "string" || !value.name.trim()) {
					warnings.push(`Marketplace '${marketplaceName}' entry ${index} has no plugin name; skipped.`);
					continue;
				}
				const name = value.name.trim();
				if (!isSafeName(name)) {
					warnings.push(`Marketplace '${marketplaceName}' entry '${name}' is not a safe plugin name; skipped.`);
					continue;
				}
				// Dedupe before probing the source: a shadowed entry is never listed,
				// so warning about its missing checkout would describe a problem the
				// user does not have while the visible copy works.
				if (seenPluginNames.has(name)) continue;
				if (isRecord(value.source)) {
					const sourceKind =
						typeof value.source.source === "string" && value.source.source.trim()
							? value.source.source.trim()
							: "unknown";
					remoteKinds.set(sourceKind, (remoteKinds.get(sourceKind) ?? 0) + 1);
					continue;
				}
				const relative =
					typeof value.source === "string" && value.source.trim()
						? value.source.trim()
						: path.join("plugins", name);
				const sourcePath = path.resolve(marketplaceDir, relative);
				if (!isPathContained(marketplaceDir, sourcePath)) {
					warnings.push(
						`Marketplace '${marketplaceName}' entry '${name}' has a source outside the checkout; skipped.`,
					);
					continue;
				}
				if (!(await pathExists(sourcePath))) {
					warnings.push(
						`Marketplace '${marketplaceName}' entry '${name}' points at ${path.relative(marketplaceDir, sourcePath)}, which is missing from the checkout; skipped.`,
					);
					continue;
				}
				// Precedence is "first root wins": a project-level marketplace of the
				// same name shadows the global copy rather than adding a second entry.
				seenPluginNames.add(name);
				entries.push({
					name,
					description: typeof value.description === "string" ? value.description : undefined,
					sourcePath,
					marketplace: marketplaceName,
					declaration: value,
				});
			}
			if (remoteKinds.size > 0) {
				const total = [...remoteKinds.values()].reduce((sum, count) => sum + count, 0);
				const breakdown = [...remoteKinds.entries()]
					.sort(([left], [right]) => left.localeCompare(right))
					.map(([kind, count]) => `${count} ${kind}`)
					.join(", ");
				warnings.push(
					`Marketplace '${marketplaceName}' has ${total} entries hosted in another repository (${breakdown}), which this runtime cannot fetch; they are not listed.`,
				);
			}
		}
	}
	return { entries, warnings };
}

/** Copy a marketplace package into the Step plugin root. */
export async function installMarketplacePlugin(
	entry: MarketplacePluginEntry,
	pluginsDir = defaultStepPluginsDir(),
	options: { provision?: boolean } = {},
): Promise<{ installedPath: string; warnings: string[]; diagnostics: StepPluginDiagnostics }> {
	if (!isSafeName(entry.name)) throw new Error(`'${entry.name}' is not a safe plugin name.`);
	const target = path.resolve(pluginsDir, entry.name);
	if (!isPathContained(pluginsDir, target) || path.basename(target) !== entry.name)
		throw new Error(`'${entry.name}' is not an installed plugin name.`);
	if (await pathExists(target))
		throw new Error(`Plugin '${entry.name}' is already installed at ${target}. Remove it first.`);
	if (!(await pathExists(entry.sourcePath)))
		throw new Error(`Marketplace source for '${entry.name}' is missing at ${entry.sourcePath}.`);
	await fs.mkdir(pluginsDir, { recursive: true, mode: 0o700 });
	try {
		await fs.cp(entry.sourcePath, target, {
			recursive: true,
			force: false,
			errorOnExist: true,
			verbatimSymlinks: true,
		});
	} catch (error) {
		await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
		throw new Error(`Could not install plugin '${entry.name}': ${describe(error)}`);
	}
	const warnings: string[] = [];
	const ownManifest = await readStepPluginManifest(target);
	if (ownManifest.errors.length === 0 && !ownManifest.manifest && !(await hasOwnPluginManifest(target))) {
		const built = buildManifestFromMarketplaceEntry(entry);
		if (built) {
			await fs.writeFile(
				path.join(target, STEP_PLUGIN_MANIFEST_FILE),
				`${JSON.stringify(built, null, 2)}\n`,
				"utf8",
			);
		} else {
			warnings.push(
				`Plugin '${entry.name}' did not provide a step.plugin.json declaration; only its files were installed.`,
			);
		}
	} else if (ownManifest.errors.length > 0) {
		warnings.push(...ownManifest.errors);
	}
	if (entry.declaration.lspServers !== undefined) {
		warnings.push(
			`Marketplace entry '${entry.name}' declares lspServers, which StepCode does not host; that contribution was not installed.`,
		);
	}
	if (
		entry.marketplace === BUILTIN_MARKETPLACE_NAME &&
		options.provision !== false &&
		ownManifest.manifest?.provision
	) {
		const provision = await provisionBuiltinPlugin(ownManifest.manifest.provision);
		if (provision) warnings.push(provision);
	}
	const diagnostics = await diagnoseStepPlugin(target);
	warnings.push(...diagnostics.warnings);
	return { installedPath: target, warnings, diagnostics };
}

/** Resolve the StepPage installer URL, honouring the shell override. */
export function resolveProvisionInstallerUrl(env: NodeJS.ProcessEnv = process.env): string {
	return stepPageInstallerUrl(env);
}

/** The shell command that installs a provisionable plugin executable, when one is declared. */
export function provisionInstallCommand(
	provision: StepPluginProvision,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	if (provision.installer !== "steppageInstaller") return undefined;
	return `curl -fsSL ${shellQuote(resolveProvisionInstallerUrl(env))} | sh`;
}

/** Install the executable declared by a built-in plugin, when it is missing. */
export async function provisionBuiltinPlugin(provision: StepPluginProvision): Promise<string | undefined> {
	if (provision.command !== "steppage-mcp" || process.platform === "win32") {
		return undefined;
	}
	const install = provisionInstallCommand(provision);
	if (!install) return undefined;
	const result = await ensureStepPageReady();
	return (
		result.error ?? (result.installed ? `Installed ${provision.command} from the StepPage installer.` : undefined)
	);
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function uninstallPlugin(pluginsDir: string, name: string): Promise<{ removedPath: string }> {
	if (!isSafeName(name.trim())) throw new Error(`'${name}' is not an installed plugin name.`);
	const root = path.resolve(pluginsDir);
	const target = path.resolve(root, name.trim());
	if (!isPathContained(root, target) || path.dirname(target) !== root)
		throw new Error(`'${name}' is not an installed plugin name.`);
	const stat = await fs.lstat(target).catch(() => undefined);
	if (!stat?.isDirectory()) throw new Error(`Plugin '${name}' is not installed in ${root}.`);
	await fs.rm(target, { recursive: true, force: true });
	return { removedPath: target };
}

/** Read MCP declarations without starting a process. */
export async function diagnoseStepPlugin(
	pluginDir: string,
	options: { env?: NodeJS.ProcessEnv; authPath?: string } = {},
): Promise<StepPluginDiagnostics> {
	const read = await readStepPluginManifest(pluginDir);
	if (read.errors.length > 0) return { mcpServers: [], warnings: [...read.errors] };
	if (!read.manifest) return { mcpServers: [], warnings: [`No ${STEP_PLUGIN_MANIFEST_FILE} found in ${pluginDir}.`] };
	const warnings: string[] = [];
	const mcpServers: string[] = [];
	if (typeof read.manifest.mcpServers === "string") {
		const declarationPath = path.resolve(pluginDir, read.manifest.mcpServers);
		if (!isPathContained(pluginDir, declarationPath)) {
			warnings.push(`MCP declaration ${read.manifest.mcpServers} escapes ${pluginDir}.`);
		} else if (!(await pathExists(declarationPath))) {
			warnings.push(`MCP declaration ${read.manifest.mcpServers} is missing from ${pluginDir}.`);
		} else {
			mcpServers.push(read.manifest.mcpServers);
			try {
				const declaration = JSON.parse(await fs.readFile(declarationPath, "utf8")) as unknown;
				if (!isRecord(declaration))
					warnings.push(`MCP declaration ${read.manifest.mcpServers} must contain an object.`);
			} catch (error) {
				warnings.push(`Invalid MCP declaration ${read.manifest.mcpServers}: ${describe(error)}`);
			}
		}
	} else if (isRecord(read.manifest.mcpServers)) {
		for (const [name, declaration] of Object.entries(read.manifest.mcpServers)) {
			mcpServers.push(name);
			if (!isRecord(declaration) || typeof declaration.command !== "string" || !declaration.command.trim()) {
				warnings.push(`MCP server '${name}' has no executable command declaration.`);
			}
		}
	}
	if (mcpServers.length > 0) {
		warnings.push(`MCP declarations saved for ${mcpServers.join(", ")}; the server starts after Step restarts.`);
	}
	if (read.manifest.entry)
		warnings.push("Executable plugin entries are recorded but not loaded by the Step marketplace facade.");
	// Judged against the environment the matching servers are actually spawned
	// with: `connectStepMcpServer` layers the SDK's safe inherited environment,
	// the server's own declared `env`, and the Step login credential. Only an
	// inline `mcpServers` record can start a server — discovery skips a string
	// declaration path — so that is the only shape whose declared `env` can
	// satisfy a requirement.
	const requiredEnvironment = read.manifest.provision?.requiresEnv ?? [];
	if (requiredEnvironment.length > 0) {
		const candidates = provisionedServerEnvironments(read.manifest).map((declared) =>
			resolveStepMcpEnvironment(declared, options),
		);
		const missingEnvironment = requiredEnvironment.filter((name) =>
			candidates.every((candidate) => !candidate[name]?.trim()),
		);
		// A Step login only ever supplies its own credential, so pointing at
		// `/login` for an unrelated variable would send the user nowhere.
		const missingLogin = missingEnvironment.filter((name) => STEP_LOGIN_SUPPLIED_ENV.includes(name));
		const missingOther = missingEnvironment.filter((name) => !STEP_LOGIN_SUPPLIED_ENV.includes(name));
		if (missingLogin.length > 0) {
			warnings.push(
				`Plugin provisioning has no value for ${missingLogin.join(", ")}; run /login or declare it in the plugin's mcpServers env before using this plugin.`,
			);
		}
		if (missingOther.length > 0) {
			warnings.push(
				`Plugin provisioning has no value for ${missingOther.join(", ")}; declare it in the plugin's mcpServers env before using this plugin.`,
			);
		}
	}
	return { mcpServers, warnings };
}

/**
 * The declared environments of the servers a manifest's provisioning installs,
 * matched on the provisioned command. Returns a single `undefined` when no
 * server matches, so the caller still judges the requirement against the
 * process environment and the login fallback.
 */
function provisionedServerEnvironments(manifest: StepPluginManifest): Array<Record<string, string> | undefined> {
	const provisionCommand = manifest.provision?.command;
	if (!provisionCommand || !isRecord(manifest.mcpServers)) return [undefined];
	const declared = Object.values(manifest.mcpServers).flatMap((declaration) => {
		if (!isRecord(declaration) || declaration.command !== provisionCommand) return [];
		if (!isRecord(declaration.env)) return [undefined];
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(declaration.env)) if (typeof value === "string") env[key] = value;
		return [env];
	});
	return declared.length > 0 ? declared : [undefined];
}

/**
 * Resolve the skill and command directories contributed by installed plugins.
 *
 * A plugin's non-MCP contributions live beside its manifest rather than in the
 * agent's own resource directories, so nothing finds them by default: MCP is the
 * one contribution that reads the plugin root directly. This is the bridge for
 * the other two, returning paths that `ResourceLoader.extendResources` accepts.
 *
 * Declared entries win over convention. A manifest that names `skills` /
 * `commands` is taken at its word (resolved against the plugin root, and skipped
 * when it escapes or does not exist); otherwise the conventional `skills/` and
 * `commands/` directories are used when present. This mirrors how
 * `readPluginManifestAtPath` fills those fields in for Claude-style manifests.
 */
export async function discoverStepPluginResourcePaths(input: {
	userDir?: string;
	projectDir?: string;
	/** Project plugins are read only when the project is trusted, as MCP discovery does. */
	projectTrusted?: boolean;
}): Promise<{ skillPaths: string[]; promptPaths: string[]; warnings: string[] }> {
	const warnings: string[] = [];
	const seenByKind = { skills: new Set<string>(), commands: new Set<string>() };
	const collected = { skills: [] as string[], commands: [] as string[] };
	// An untrusted project must not inject skill instructions or prompt templates
	// into the session, so its plugin root is skipped entirely. The global root is
	// always read: it is the user's own configuration, not the checkout's.
	const roots = [
		...(input.projectTrusted && input.projectDir ? [input.projectDir] : []),
		input.userDir ?? defaultStepPluginsDir(),
	];

	for (const root of roots) {
		for (const pluginDir of await listStepPluginDirectories(root)) {
			const read = await readStepPluginManifest(pluginDir);
			if (!read.manifest) continue;
			const manifest = read.manifest;
			for (const key of ["skills", "commands"] as const) {
				const declared = manifest[key];
				// A declared empty array means "this plugin contributes none": honor
				// it instead of falling through to a stale conventional directory.
				const candidates =
					declared !== undefined ? declared : (await pathExists(path.join(pluginDir, key))) ? [key] : [];
				for (const relative of candidates) {
					const resolved = path.resolve(pluginDir, relative);
					if (!isPathContained(pluginDir, resolved)) {
						warnings.push(
							`Plugin '${manifest.id}' declares ${key} '${relative}', which is outside the plugin; skipped.`,
						);
						continue;
					}
					if (!(await pathExists(resolved))) {
						warnings.push(`Plugin '${manifest.id}' declares ${key} '${relative}', which is missing; skipped.`);
						continue;
					}
					// Dedupe within a kind, not across kinds: one directory can
					// legitimately be both a skills root and a commands root.
					const canonical = path.resolve(resolved);
					if (seenByKind[key].has(canonical)) continue;
					seenByKind[key].add(canonical);
					collected[key].push(canonical);
				}
			}
		}
	}
	return { skillPaths: collected.skills, promptPaths: collected.commands, warnings };
}

export async function listInstalledStepPlugins(
	input: { userDir?: string; projectDir?: string } = {},
): Promise<{ plugins: InstalledStepPlugin[]; warnings: string[] }> {
	const warnings: string[] = [];
	const byId = new Map<string, InstalledStepPlugin>();
	const userDir = input.userDir ?? defaultStepPluginsDir();
	const [userRoot, projectRoot] = await Promise.all([
		fs.realpath(userDir).catch(() => path.resolve(userDir)),
		input.projectDir ? fs.realpath(input.projectDir).catch(() => path.resolve(input.projectDir!)) : undefined,
	]);
	// Starting in HOME (or a symlink to it) makes both scopes point at the same
	// installation. Keep its user scope instead of reporting a false override.
	const roots: Array<{ path: string; source: "user" | "project" }> = [
		...(input.projectDir && projectRoot !== userRoot ? [{ path: input.projectDir, source: "project" as const }] : []),
		{ path: userDir, source: "user" },
	];
	for (const root of roots) {
		for (const pluginDir of await listStepPluginDirectories(root.path)) {
			const read = await readStepPluginManifest(pluginDir);
			if (read.errors.length > 0) {
				warnings.push(...read.errors);
				continue;
			}
			if (!read.manifest) continue;
			const diagnostics = await diagnoseStepPlugin(pluginDir);
			const plugin: InstalledStepPlugin = {
				id: read.manifest.id,
				name: read.manifest.name ?? read.manifest.id,
				version: read.manifest.version,
				description: read.manifest.description,
				rootPath: pluginDir,
				source: root.source,
				mcpServers: diagnostics.mcpServers,
				warnings: diagnostics.warnings,
			};
			const existing = byId.get(plugin.id);
			if (existing) {
				warnings.push(
					existing.source === "project" && root.source === "user"
						? `Plugin '${plugin.id}' from ${pluginDir} was ignored because a project plugin has precedence.`
						: `Plugin '${plugin.id}' from ${pluginDir} was ignored because another plugin with the same id is already loaded.`,
				);
				continue;
			}
			byId.set(plugin.id, plugin);
		}
	}
	return { plugins: [...byId.values()].sort((left, right) => left.id.localeCompare(right.id)), warnings };
}

/** Materialize built-ins into the same checkout shape as fetched marketplaces. */
export async function ensureBuiltinMarketplace(
	input: { marketplacesDir?: string } = {},
): Promise<{ path: string; warnings: string[] }> {
	const marketplacesDir = input.marketplacesDir ?? defaultStepMarketplacesDir();
	const target = path.join(marketplacesDir, BUILTIN_MARKETPLACE_NAME);
	const fingerprint = fingerprintBuiltinFiles();
	try {
		const marker = (await fs.readFile(path.join(target, BUILTIN_FINGERPRINT_FILE), "utf8")).trim();
		if (marker === fingerprint && (await findMarketplaceManifest(target))) return { path: target, warnings: [] };
	} catch (error) {
		if (!isFileNotFound(error))
			return { path: target, warnings: [`Could not read built-in marketplace at ${target}: ${describe(error)}`] };
		const existing = await fs.readdir(target).catch(() => []);
		if (existing.length > 0)
			return {
				path: target,
				warnings: [`${target} already exists and was not created by this build; built-ins were left alone.`],
			};
	}
	try {
		await fs.rm(target, { recursive: true, force: true });
		for (const [relative, contents] of Object.entries(BUILTIN_MARKETPLACE_FILES)) {
			const resolved = path.resolve(target, relative);
			if (!isPathContained(target, resolved))
				return { path: target, warnings: [`Built-in marketplace entry ${relative} escapes its directory.`] };
			await fs.mkdir(path.dirname(resolved), { recursive: true });
			await fs.writeFile(resolved, contents, "utf8");
		}
		await fs.writeFile(path.join(target, BUILTIN_FINGERPRINT_FILE), `${fingerprint}\n`, "utf8");
		return { path: target, warnings: [] };
	} catch (error) {
		return {
			path: target,
			warnings: [`Could not install the built-in marketplace into ${target}: ${describe(error)}`],
		};
	}
}

export interface PreinstalledPlugin {
	name: string;
	provision?: StepPluginProvision;
}

export interface EnsureBuiltinPluginsResult {
	/** Plugins whose manifest was copied into the plugin root during this call. */
	installed: PreinstalledPlugin[];
	warnings: string[];
}

/**
 * Provision the built-in plugins listed in {@link PREINSTALLED_BUILTIN_PLUGINS}
 * into a fresh install so their MCP servers are discovered without an explicit
 * `/plugin install`. Idempotent and once-only per plugin: a marker file records
 * every plugin already handled, so one the user later uninstalls is not silently
 * reinstalled on the next launch.
 *
 * Only the declarative manifest is copied here (the executable is not
 * provisioned) so startup stays fast. Executable readiness is checked separately
 * before connecting, including manifests already installed by older versions.
 */
export async function ensureBuiltinPluginsInstalled(
	input: { pluginsDir?: string; marketplacesDir?: string } = {},
): Promise<EnsureBuiltinPluginsResult> {
	const pluginsDir = input.pluginsDir ?? defaultStepPluginsDir();
	const marketplacesDir = input.marketplacesDir ?? defaultStepMarketplacesDir();
	const markerPath = path.join(pluginsDir, PREINSTALL_MARKER_FILE);
	const handled = await readPreinstallMarker(markerPath);
	const pending = PREINSTALLED_BUILTIN_PLUGINS.filter((name) => !handled.has(name));
	if (pending.length === 0) return { installed: [], warnings: [] };

	const warnings: string[] = [];
	const installed: PreinstalledPlugin[] = [];
	const builtin = await ensureBuiltinMarketplace({ marketplacesDir });
	warnings.push(...builtin.warnings);
	const [available, existing] = await Promise.all([
		listMarketplacePlugins([marketplacesDir]),
		listInstalledStepPlugins({ userDir: pluginsDir }),
	]);
	const installedIds = new Set(existing.plugins.map((plugin) => plugin.id));

	for (const name of pending) {
		if (installedIds.has(name)) {
			handled.add(name);
			continue;
		}
		const entry = available.entries.find(
			(candidate) => candidate.name === name && candidate.marketplace === BUILTIN_MARKETPLACE_NAME,
		);
		// Leave the plugin unmarked when the built-in source is not yet materialized
		// so a later launch can retry rather than skip it forever.
		if (!entry) continue;
		try {
			const result = await installMarketplacePlugin(entry, pluginsDir, { provision: false });
			const manifest = await readStepPluginManifest(result.installedPath);
			installed.push({ name, provision: manifest.manifest?.provision });
			handled.add(name);
		} catch (error) {
			warnings.push(`Could not pre-install '${name}': ${describe(error)}`);
		}
	}

	await writePreinstallMarker(markerPath, handled).catch(() => undefined);
	return { installed, warnings };
}

async function readPreinstallMarker(markerPath: string): Promise<Set<string>> {
	try {
		const parsed = JSON.parse(await fs.readFile(markerPath, "utf8")) as unknown;
		if (Array.isArray(parsed)) return new Set(parsed.filter((value): value is string => typeof value === "string"));
	} catch {
		// A missing or unreadable marker means nothing has been pre-installed yet.
	}
	return new Set();
}

async function writePreinstallMarker(markerPath: string, names: ReadonlySet<string>): Promise<void> {
	await fs.mkdir(path.dirname(markerPath), { recursive: true, mode: 0o700 });
	await fs.writeFile(markerPath, `${JSON.stringify([...names].sort())}\n`, "utf8");
}

/** Compatibility helper for code that needs the materialized built-in path. */
export function defaultBuiltinMarketplaceDir(marketplacesDir = defaultStepMarketplacesDir()): string {
	return path.join(marketplacesDir, BUILTIN_MARKETPLACE_NAME);
}

/** Return a stable fingerprint for the embedded tree. */
export function fingerprintBuiltinFiles(): string {
	const hash = createHash("sha256");
	for (const [relative, contents] of Object.entries(BUILTIN_MARKETPLACE_FILES).sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		hash.update(relative);
		hash.update("\0");
		hash.update(contents);
		hash.update("\0");
	}
	return hash.digest("hex").slice(0, 24);
}

/** Exported fingerprint for release/build checks and compatibility callers. */
export const BUILTIN_MARKETPLACE_FINGERPRINT = fingerprintBuiltinFiles();

/** List materialized marketplace checkouts. */
export async function listMarketplaceSources(
	marketplacesDir = defaultStepMarketplacesDir(),
): Promise<MarketplaceSource[]> {
	const entries = await fs.readdir(marketplacesDir, { withFileTypes: true }).catch(() => []);
	const result: MarketplaceSource[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !isSafeName(entry.name)) continue;
		const checkout = path.join(marketplacesDir, entry.name);
		const isGitCheckout = await pathExists(path.join(checkout, ".git"));
		result.push({
			name: entry.name,
			path: checkout,
			kind: entry.name === BUILTIN_MARKETPLACE_NAME ? "builtin" : isGitCheckout ? "git" : "local",
			origin: entry.name === BUILTIN_MARKETPLACE_NAME || !isGitCheckout ? null : await readGitOrigin(checkout),
		});
	}
	return result.sort((left, right) => left.name.localeCompare(right.name));
}

/** Add a local checkout or clone a git marketplace without invoking a shell. */
export async function addMarketplaceSource(input: {
	source: string;
	marketplacesDir?: string;
	name?: string;
	/**
	 * Called as the add moves through its stages. A git clone can run for a
	 * minute or more, and a caller that only hears back on completion has no way
	 * to show the user that anything is happening.
	 */
	onProgress?: (message: string) => void;
	/** Aborts an in-flight clone when the caller's dialog is cancelled. */
	signal?: AbortSignal;
}): Promise<MarketplaceOperationResult> {
	const report = input.onProgress ?? (() => {});
	const source = input.source.trim();
	if (!source) return { warnings: ["Marketplace source is empty."] };
	const marketplacesDir = input.marketplacesDir ?? defaultStepMarketplacesDir();
	let sourcePath: string | undefined;
	let cloneSource: string | undefined;
	try {
		if (/^file:\/\//iu.test(source)) {
			const localPath = fileURLToPath(new URL(source));
			// A file URL commonly points at a local git origin in tests and in
			// offline development. Clone it when possible so update/list retain
			// the same semantics as a remote marketplace.
			if (await pathExists(path.join(localPath, ".git"))) cloneSource = source;
			else sourcePath = localPath;
		} else if (isLocalMarketplacePath(source)) sourcePath = path.resolve(source);
		else cloneSource = resolveMarketplaceCloneUrl(source);
	} catch (error) {
		return { warnings: [`Invalid marketplace source ${JSON.stringify(source)}: ${describe(error)}`] };
	}
	if (!sourcePath && !cloneSource) {
		return {
			warnings: [
				`${JSON.stringify(source)} is not a usable marketplace source. Give a git URL, owner/repo pair, or local path.`,
			],
		};
	}
	const cloneName = input.name?.trim() || deriveMarketplaceName(sourcePath ?? cloneSource ?? source);
	if (!cloneName || !isSafeName(cloneName) || cloneName === BUILTIN_MARKETPLACE_NAME) {
		return { warnings: [`${JSON.stringify(cloneName ?? source)} is not a usable marketplace name.`] };
	}
	const target = path.join(marketplacesDir, cloneName);
	if (await pathExists(target))
		return { warnings: [`Marketplace '${cloneName}' is already present at ${target}; update or remove it first.`] };
	if (sourcePath) {
		const resolvedSource = path.resolve(sourcePath);
		const resolvedTarget = path.resolve(target);
		if (
			resolvedSource === resolvedTarget ||
			isPathContained(resolvedSource, resolvedTarget) ||
			isPathContained(resolvedTarget, resolvedSource)
		) {
			return {
				warnings: [
					`Marketplace source and destination overlap; refusing to copy ${resolvedSource} into ${resolvedTarget}.`,
				],
			};
		}
	}
	await fs.mkdir(marketplacesDir, { recursive: true });
	try {
		if (sourcePath) {
			const local = path.resolve(sourcePath);
			if (!(await pathExists(local))) return { warnings: [`Marketplace source does not exist: ${local}`] };
			report(`Copying ${local}`);
			await fs.cp(local, target, { recursive: true, errorOnExist: true, force: false });
		} else {
			report(`Cloning repository (timeout: 120s): ${cloneSource}`);
			await cloneMarketplace(cloneSource!, target, report, input.signal);
		}
	} catch (error) {
		await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
		return { warnings: [`Could not add marketplace '${cloneName}': ${describe(error)}`] };
	}
	report("Reading marketplace manifest");
	if (!(await findMarketplaceManifest(target))) {
		await fs.rm(target, { recursive: true, force: true });
		return { warnings: [`${source} has no marketplace manifest; it was not added.`] };
	}
	return {
		source: {
			name: cloneName,
			path: target,
			kind: sourcePath ? "local" : "git",
			origin: source,
		},
		warnings: [],
	};
}

/**
 * Clone a marketplace, forwarding git's progress lines as they arrive.
 *
 * `--progress` is what makes git emit percentage updates to stderr when it is
 * not attached to a terminal; without it a large clone is silent until it
 * finishes, which is indistinguishable from a hang.
 */
async function cloneMarketplace(
	cloneSource: string,
	target: string,
	report: (message: string) => void,
	signal?: AbortSignal,
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = execFile(
			"git",
			["clone", "--depth", "1", "--progress", "--", cloneSource, target],
			{ timeout: 120_000, ...(signal ? { signal } : {}) },
			(error) => (error ? reject(error) : resolve()),
		);
		let pending = "";
		child.stderr?.on("data", (chunk: Buffer | string) => {
			pending += chunk.toString();
			// Keep the trailing partial line: a chunk can end mid-update, and the
			// rest arrives in the next one.
			const parts = splitCloneProgress(pending);
			pending = parts.pop() ?? "";
			for (const line of parts) report(`Cloning repository: ${line}`);
		});
	});
}

/**
 * Split accumulated git output into complete progress lines, keeping the last
 * partial line as the final element.
 *
 * git redraws its progress with carriage returns instead of newlines, so
 * splitting on newlines alone would hold the whole transfer in the buffer and
 * leave the caller with a single update at the end.
 */
export function splitCloneProgress(pending: string): string[] {
	return pending.split(/[\r\n]+/u).map((line) => line.trim());
}

export async function removeMarketplaceSource(input: {
	name: string;
	marketplacesDir?: string;
}): Promise<MarketplaceOperationResult> {
	const name = input.name.trim();
	if (!isSafeName(name) || name === BUILTIN_MARKETPLACE_NAME)
		return { warnings: [`Marketplace '${name}' cannot be removed.`] };
	const root = input.marketplacesDir ?? defaultStepMarketplacesDir();
	const target = path.resolve(root, name);
	if (!isPathContained(root, target) || path.dirname(target) !== path.resolve(root))
		return { warnings: [`Marketplace '${name}' is not a valid name.`] };
	if (!(await pathExists(target))) return { warnings: [`No marketplace named '${name}' is configured.`] };
	const isGitCheckout = await pathExists(path.join(target, ".git"));
	await fs.rm(target, { recursive: true, force: true });
	return {
		source: { name, path: target, kind: isGitCheckout ? "git" : "local", origin: null },
		warnings: [],
	};
}

export async function updateMarketplaceSource(input: {
	name: string;
	marketplacesDir?: string;
}): Promise<MarketplaceOperationResult> {
	const name = input.name.trim();
	if (!isSafeName(name) || name === BUILTIN_MARKETPLACE_NAME)
		return { warnings: [`Marketplace '${name}' is built into StepCode and cannot be updated separately.`] };
	const root = input.marketplacesDir ?? defaultStepMarketplacesDir();
	const target = path.resolve(root, name);
	if (!(await pathExists(target))) return { warnings: [`No marketplace named '${name}' is configured.`] };
	if (!(await pathExists(path.join(target, ".git")))) {
		return { warnings: [`Marketplace '${name}' is a local checkout and cannot be updated automatically.`] };
	}
	try {
		await execFileAsync("git", ["-C", target, "pull", "--ff-only", "--quiet"], { timeout: 120_000 });
	} catch (error) {
		return { warnings: [`Could not update marketplace '${name}': ${describe(error)}`] };
	}
	return { source: { name, path: target, kind: "git", origin: await readGitOrigin(target) }, warnings: [] };
}

type PluginNotice = (message: string, type?: "info" | "warning" | "error") => void;

interface InteractivePluginOptions extends StepPluginCommandOptions {
	pluginsDir: string;
	marketplacesDir: string;
	marketplaceRoots: readonly string[];
}

/**
 * Contribute installed plugins' skills and commands to the session.
 *
 * MCP is discovered by reading the plugin root directly, but skills and commands
 * are consumed by `ResourceLoader` from agent/project resource directories that
 * plugins do not write to. This extension is the bridge: it answers
 * `resources_discover` with the plugin-owned paths, which the loader already
 * knows how to merge (`extendResources`) and re-merge on reload, so a plugin
 * installed during a session takes effect on the next resource reload instead of
 * requiring a restart.
 *
 * Failures are reported as warnings on the extension error channel rather than
 * thrown: a broken plugin must not cost the session its other resources.
 */
export function createStepPluginResourcesExtension(): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		pi.on("resources_discover", async (_event, ctx) => {
			const projectDir = defaultStepPluginsDir(process.env, { cwd: ctx.cwd, project: true });
			try {
				const discovered = await discoverStepPluginResourcePaths({
					projectDir,
					projectTrusted: ctx.isProjectTrusted(),
					userDir: defaultStepPluginsDir(process.env),
				});
				// Surface a malformed declaration once, on the channel the loader
				// already uses for resource diagnostics, rather than throwing: the
				// rest of the plugins' resources must still load.
				for (const warning of discovered.warnings) ctx.ui?.notify?.(warning, "warning");
				return { skillPaths: discovered.skillPaths, promptPaths: discovered.promptPaths };
			} catch (error) {
				ctx.ui?.notify?.(`Could not read plugin resources: ${describe(error)}`, "warning");
				return {};
			}
		});
	};
}

function reportPluginWarnings(say: PluginNotice, warnings: readonly string[]): void {
	if (warnings.length > 0) say(warnings.join("\n"), "warning");
}

function projectPluginsDir(ctx: ExtensionCommandContext): string {
	return defaultStepPluginsDir(process.env, { cwd: ctx.cwd, project: true });
}

async function loadAvailablePlugins(
	options: InteractivePluginOptions,
): Promise<ListMarketplacePluginsResult & { builtinWarnings: string[] }> {
	const builtin = await ensureBuiltinMarketplace({ marketplacesDir: options.marketplacesDir });
	const available = await listMarketplacePlugins(options.marketplaceRoots);
	return { ...available, builtinWarnings: builtin.warnings };
}

async function openInteractivePluginMenu(
	ctx: ExtensionCommandContext,
	options: InteractivePluginOptions,
	say: PluginNotice,
): Promise<void> {
	// Materialize the built-in source before listing so the available count is
	// stable in the top-level menu.
	const available = await loadAvailablePlugins(options);
	const installed = await listInstalledStepPlugins({
		userDir: options.pluginsDir,
		projectDir: projectPluginsDir(ctx),
	});
	reportPluginWarnings(say, [...installed.warnings, ...available.builtinWarnings, ...available.warnings]);
	const choices = [
		`Installed (${installed.plugins.length})`,
		`All Plugins (${available.entries.length} available)`,
		"Marketplaces",
	];
	const selected = await ctx.ui.select("Plugins", choices);
	if (selected === choices[0]) await openInstalledPlugins(ctx, options, say);
	else if (selected === choices[1]) await openMarketplacePlugins(ctx, options, say);
	else if (selected === choices[2]) await openMarketplaceSources(ctx, options, say);
}

async function openInstalledPlugins(
	ctx: ExtensionCommandContext,
	options: InteractivePluginOptions,
	say: PluginNotice,
): Promise<void> {
	const listed = await listInstalledStepPlugins({
		userDir: options.pluginsDir,
		projectDir: projectPluginsDir(ctx),
	});
	reportPluginWarnings(say, listed.warnings);
	if (listed.plugins.length === 0) {
		say("No plugins installed.");
		return;
	}
	const labels = listed.plugins.map((plugin) => {
		const version = plugin.version ? ` v${plugin.version}` : "";
		const scope = plugin.source === "project" ? "project" : "user";
		return `${plugin.name}${version} · ${scope}`;
	});
	const selected = await ctx.ui.select(`Installed Plugins (${listed.plugins.length})`, labels);
	if (!selected) return;
	const index = labels.indexOf(selected);
	const plugin = index >= 0 ? listed.plugins[index] : undefined;
	if (plugin) await openInstalledPluginDetails(ctx, options, plugin, say);
}

async function openInstalledPluginDetails(
	ctx: ExtensionCommandContext,
	options: InteractivePluginOptions,
	plugin: InstalledStepPlugin,
	say: PluginNotice,
): Promise<void> {
	const details = [
		plugin.description ?? "No description",
		plugin.version ? `Version: ${plugin.version}` : undefined,
		`Scope: ${plugin.source}`,
		`Path: ${plugin.rootPath}`,
		plugin.mcpServers.length > 0 ? `MCP: ${plugin.mcpServers.join(", ")}` : undefined,
	]
		.filter((line): line is string => Boolean(line))
		.join("\n");
	const selected = await ctx.ui.select(`${plugin.name}\n${details}`, ["Uninstall", "Back"]);
	if (selected !== "Uninstall") {
		if (selected === "Back") await openInstalledPlugins(ctx, options, say);
		return;
	}
	if (ctx.hasUI && !(await ctx.ui.confirm("Uninstall plugin", `Remove '${plugin.name}' from StepCode?`))) {
		say("Uninstall cancelled.");
		return;
	}
	try {
		await uninstallPlugin(path.dirname(plugin.rootPath), plugin.id);
		say(`Uninstalled '${plugin.name}'. Restart Step to unload it.`);
	} catch (error) {
		say(describe(error), "error");
	}
}

async function openMarketplacePlugins(
	ctx: ExtensionCommandContext,
	options: InteractivePluginOptions,
	say: PluginNotice,
): Promise<void> {
	const available = await loadAvailablePlugins(options);
	reportPluginWarnings(say, [...available.builtinWarnings, ...available.warnings]);
	if (available.entries.length === 0) {
		say("No plugins available. Add a marketplace with /plugin marketplace add <git-url|path>.", "warning");
		return;
	}
	const installed = await listInstalledStepPlugins({
		userDir: options.pluginsDir,
		projectDir: projectPluginsDir(ctx),
	});
	const installedIds = new Set(installed.plugins.map((plugin) => plugin.id));
	const labels = available.entries.map((entry) => {
		const state = installedIds.has(entry.name) ? " · installed" : "";
		return `${entry.name} · ${entry.marketplace}${state}`;
	});
	const selected = await ctx.ui.select(`All Plugins (${available.entries.length} available)`, labels, {
		// A marketplace can carry hundreds of plugins, so this list is the one
		// place that needs a query rather than a scroll.
		searchable: true,
	});
	if (!selected) return;
	const index = labels.indexOf(selected);
	const entry = index >= 0 ? available.entries[index] : undefined;
	if (entry) await openMarketplacePluginDetails(ctx, options, entry, installedIds.has(entry.name), say);
}

async function openMarketplacePluginDetails(
	ctx: ExtensionCommandContext,
	options: InteractivePluginOptions,
	entry: MarketplacePluginEntry,
	installed: boolean,
	say: PluginNotice,
): Promise<void> {
	const details = `${entry.description ?? "No description"}\nFrom: ${entry.marketplace}`;
	const choices = [installed ? "Already installed" : "Install", "Back"];
	const selected = await ctx.ui.select(`${entry.name}\n${details}`, choices);
	if (selected === "Back") {
		await openMarketplacePlugins(ctx, options, say);
		return;
	}
	if (selected !== "Install") {
		if (selected === "Already installed") say(`'${entry.name}' is already installed.`);
		return;
	}
	try {
		const result = await installMarketplacePlugin(entry, options.pluginsDir);
		say(
			[
				`Installed '${entry.name}' from ${entry.marketplace}.`,
				"Restart Step to activate plugin contributions.",
				...result.warnings,
			].join("\n"),
			result.warnings.length > 0 ? "warning" : "info",
		);
	} catch (error) {
		say(describe(error), "error");
	}
}

/**
 * Run `work` behind a spinner that shows the latest progress message.
 *
 * The marketplace add is the one `/plugin` action that can take minutes, and it
 * used to hand the terminal back to the editor for its whole duration. The
 * spinner keeps the dialog mounted and updates in place; hosts without a UI
 * (print, RPC) simply run the work, since they have nothing to render into.
 */
async function runWithProgress<T>(
	ctx: ExtensionCommandContext,
	work: (report: (message: string) => void, signal: AbortSignal) => Promise<T>,
): Promise<T> {
	if (!ctx.hasUI || ctx.mode !== "tui") return work(() => undefined, new AbortController().signal);
	const settled = await ctx.ui.custom<{ ok: true; value: T } | { ok: false; error: unknown }>(
		(tui, theme, _keybindings, done) => {
			// Cancellable: a clone can run for the full two-minute timeout, and a
			// mistyped URL should not hold the command hostage with no way out.
			const loader = new BorderedLoader(tui, theme, "Working...", { cancellable: true });
			const controller = new AbortController();
			loader.onAbort = () => controller.abort();
			void work((message) => loader.setMessage(message), controller.signal).then(
				(value) => done({ ok: true, value }),
				// The failure travels back as a value so the dialog always unmounts
				// before the caller reports it; rejecting through the dialog would
				// leave the spinner on screen next to the error.
				(error: unknown) => done({ ok: false, error }),
			);
			return loader;
		},
		{ hideFooter: true },
	);
	if (settled.ok) return settled.value;
	throw settled.error;
}

async function openMarketplaceSources(
	ctx: ExtensionCommandContext,
	options: InteractivePluginOptions,
	say: PluginNotice,
): Promise<void> {
	const builtin = await ensureBuiltinMarketplace({ marketplacesDir: options.marketplacesDir });
	const sources = await listMarketplaceSources(options.marketplacesDir);
	reportPluginWarnings(say, builtin.warnings);
	// The built-in source ships with the CLI: it cannot be updated or removed, so
	// listing it here would only add a row that does nothing. It stays out of the
	// labels and the parallel `sources` slice so the index lookup stays aligned.
	const manageable = sources.filter((source) => source.kind !== "builtin");
	const labels = manageable.map((source) => `${source.name} · ${source.kind}`);
	const addLabel = "Add marketplace";
	const selected = await ctx.ui.select("Marketplaces", [...labels, addLabel]);
	if (!selected) return;
	if (selected === addLabel) {
		const source = await ctx.ui.input("Add Marketplace\nEnter marketplace source:", undefined, {
			examples: [
				"owner/repo (GitHub)",
				"git@github.com:owner/repo.git (SSH)",
				"https://example.com/marketplace.json",
				"./path/to/marketplace",
			],
		});
		if (!source?.trim()) return;
		const added = await runWithProgress(ctx, (report, signal) =>
			addMarketplaceSource({
				source,
				marketplacesDir: options.marketplacesDir,
				onProgress: report,
				signal,
			}),
		);
		say(
			[...(added.source ? [`Added marketplace '${added.source.name}'.`] : []), ...added.warnings].join("\n"),
			added.source ? "info" : "warning",
		);
		// Land on the new marketplace's plugins instead of bouncing back to the
		// source list: adding a source is only ever a step toward installing from it.
		// A failed add keeps the user where they are so the warning stays adjacent
		// to the list they can retry from.
		if (added.source) await openMarketplacePlugins(ctx, options, say);
		return;
	}
	const index = labels.indexOf(selected);
	const source = index >= 0 ? manageable[index] : undefined;
	if (source) await openMarketplaceSourceDetails(ctx, options, source, say);
}

async function openMarketplaceSourceDetails(
	ctx: ExtensionCommandContext,
	options: InteractivePluginOptions,
	source: MarketplaceSource,
	say: PluginNotice,
): Promise<void> {
	// `openMarketplaceSources` filters the built-in source out of the list, so
	// only user-added marketplaces reach here — and both can be updated/removed.
	const details = `${source.origin ?? source.path}\nKind: ${source.kind}`;
	const selected = await ctx.ui.select(`${source.name}\n${details}`, ["Update", "Remove", "Back"]);
	if (selected === "Back") {
		await openMarketplaceSources(ctx, options, say);
		return;
	}
	if (selected === "Remove") {
		if (ctx.hasUI && !(await ctx.ui.confirm("Remove marketplace", `Remove '${source.name}'?`))) {
			say("Marketplace removal cancelled.");
			return;
		}
		const result = await removeMarketplaceSource({ name: source.name, marketplacesDir: options.marketplacesDir });
		say(
			[...(result.source ? [`Removed marketplace '${source.name}'.`] : []), ...result.warnings].join("\n"),
			result.source ? "info" : "warning",
		);
		return;
	}
	if (selected === "Update") {
		const result = await updateMarketplaceSource({ name: source.name, marketplacesDir: options.marketplacesDir });
		say(
			[...(result.source ? [`Updated marketplace '${source.name}'.`] : []), ...result.warnings].join("\n"),
			result.source ? "info" : "warning",
		);
	}
}

/** Register `/plugin` on the Step command surface. */
export function registerStepPluginCommand(pi: ExtensionAPI, options: StepPluginCommandOptions = {}): void {
	pi.registerCommand("plugin", {
		description: "Browse and manage StepCode plugins",
		getArgumentCompletions: (prefix) => {
			const words = prefix.trim().split(/\s+/u).filter(Boolean);
			const actions = ["list", "browse", "install", "remove", "uninstall", "marketplace"];
			if (words.length <= 1)
				return actions
					.filter((value) => value.startsWith(words[0] ?? ""))
					.map((value) => ({ value, label: value }));
			if (words[0] === "marketplace" && words.length === 2) {
				return ["list", "add", "update", "remove"]
					.filter((value) => value.startsWith(words[1] ?? ""))
					.map((value) => ({ value, label: value }));
			}
			return [];
		},
		handler: async (args, ctx) => {
			const storageRootDir = options.storageRootDir?.trim() || resolveStepStorageRoot(process.env);
			const pluginsDir = options.pluginsDir ?? defaultStepPluginsDir(process.env, { storageRootDir });
			const marketplacesDir = options.marketplacesDir ?? defaultStepMarketplacesDir(process.env, storageRootDir);
			const marketplaceRoots =
				options.marketplacesDir || options.storageRootDir
					? [marketplacesDir]
					: defaultMarketplaceRoots(process.env, { includeProject: true });
			const interactiveOptions: InteractivePluginOptions = {
				...options,
				pluginsDir,
				marketplacesDir,
				marketplaceRoots,
			};
			const action = args.trim().split(/\s+/u).filter(Boolean);
			const command = action[0]?.toLowerCase() || "menu";
			const say = (message: string, type: "info" | "warning" | "error" = "info"): void =>
				ctx.ui.notify(message, type);
			if (options.telemetry) {
				trackStepTelemetry(options.telemetry, "slash_command_used", { command: "/plugin", recognized: true });
			}
			try {
				switch (command) {
					case "menu":
						await openInteractivePluginMenu(ctx, interactiveOptions, say);
						return;
					case "list": {
						await openInstalledPlugins(ctx, interactiveOptions, say);
						return;
					}
					case "browse": {
						await openMarketplacePlugins(ctx, interactiveOptions, say);
						return;
					}
					case "install": {
						// Accept the `name@marketplace` spelling that Claude Code uses
						// alongside a bare name; the marketplace half only narrows the
						// search, since a plugin name alone is already unambiguous here.
						const requested = action[1];
						if (!requested) {
							say("Usage: /plugin install <name>", "warning");
							return;
						}
						const { name, marketplace } = parsePluginSpecifier(requested);
						await ensureBuiltinMarketplace({ marketplacesDir });
						const available = await listMarketplacePlugins(
							options.marketplacesDir || options.storageRootDir
								? [marketplacesDir]
								: defaultMarketplaceRoots(process.env, { includeProject: true }),
						);
						const matches = available.entries.filter(
							(candidate) => candidate.name === name && (!marketplace || candidate.marketplace === marketplace),
						);
						const entry = matches[0];
						if (!entry) {
							// Name the marketplaces that do carry this plugin: the bare name
							// resolves across all of them, so a wrong marketplace half is
							// the one failure the user cannot see from the message alone.
							const elsewhere = available.entries.filter((candidate) => candidate.name === name);
							const alternatives =
								elsewhere.length > 0
									? ` It is available from: ${[...new Set(elsewhere.map((candidate) => candidate.marketplace))].join(", ")}.`
									: "";
							const wanted = marketplace ? `'${name}' from '${marketplace}'` : `'${name}'`;
							say(`No marketplace entry named ${wanted} is available locally.${alternatives}`, "warning");
							return;
						}
						const installed = await installMarketplacePlugin(entry, pluginsDir);
						say(
							[
								`Installed ${entry.name} from ${entry.marketplace} to ${installed.installedPath}.`,
								"Restart Step to start the plugin's MCP server.",
								...installed.warnings,
							].join("\n"),
							installed.warnings.length > 0 ? "warning" : "info",
						);
						return;
					}
					case "remove":
					case "uninstall": {
						const name = action[1];
						if (!name) {
							say(`Usage: /plugin ${command} <name>`, "warning");
							return;
						}
						if (ctx.hasUI && !(await ctx.ui.confirm("Uninstall plugin", `Remove '${name}' from StepCode?`))) {
							say("Uninstall cancelled.");
							return;
						}
						const removed = await uninstallPlugin(pluginsDir, name);
						say(`Removed ${removed.removedPath}. Restart Step to unload it.`);
						return;
					}
					case "marketplace": {
						if (action.length === 1) {
							await openMarketplaceSources(ctx, interactiveOptions, say);
						} else {
							await handleMarketplaceCommand(action.slice(1), ctx, { ...options, marketplacesDir }, say);
						}
						return;
					}
					default:
						say(
							"Usage: /plugin [list|browse|install <name>|remove <name>]\n       /plugin marketplace [list|add <path|git-url>|update <name>|remove <name>]",
							"warning",
						);
				}
			} catch (error) {
				say(describe(error), "error");
			}
		},
	});
}

async function handleMarketplaceCommand(
	args: string[],
	ctx: ExtensionCommandContext,
	options: StepPluginCommandOptions,
	say: (message: string, type?: "info" | "warning" | "error") => void,
): Promise<void> {
	const action = args[0]?.toLowerCase() || "list";
	const marketplacesDir = options.marketplacesDir ?? defaultStepMarketplacesDir();
	if (action === "list") {
		const builtin = await ensureBuiltinMarketplace({ marketplacesDir });
		const sources = await listMarketplaceSources(marketplacesDir);
		say(
			[
				...sources.map(
					(source) =>
						`${source.name.padEnd(20)} ${source.kind === "builtin" ? "(built in)" : (source.origin ?? source.path)}`,
				),
				...builtin.warnings,
			].join("\n") || "No marketplaces configured.",
		);
		return;
	}
	const argument = args[1];
	if (!argument) {
		say(`Usage: /plugin marketplace ${action} <${action === "add" ? "path|git-url" : "name"}>`, "warning");
		return;
	}
	if (action === "add") {
		const added = await addMarketplaceSource({ source: argument, marketplacesDir });
		say(
			[...(added.source ? [`Added marketplace '${added.source.name}'.`] : []), ...added.warnings].join("\n"),
			added.source ? "info" : "warning",
		);
		return;
	}
	if (action === "remove" && ctx.hasUI) {
		const confirmed = await ctx.ui.confirm("Remove marketplace", `Remove '${argument}'?`);
		if (!confirmed) {
			say("Marketplace removal cancelled.");
			return;
		}
	}
	const operation =
		action === "update"
			? await updateMarketplaceSource({ name: argument, marketplacesDir })
			: action === "remove"
				? await removeMarketplaceSource({ name: argument, marketplacesDir })
				: undefined;
	if (!operation) {
		say("Usage: /plugin marketplace [list|add|update|remove]", "warning");
		return;
	}
	say(
		[
			...(operation.source
				? [`${action === "remove" ? "Removed" : "Updated"} marketplace '${operation.source.name}'.`]
				: []),
			...operation.warnings,
		].join("\n"),
		operation.source ? "info" : "warning",
	);
	void ctx;
}

export function buildManifestFromMarketplaceEntry(entry: MarketplacePluginEntry): StepPluginManifest | undefined {
	const source = entry.declaration;
	const manifest: StepPluginManifest = {
		id: entry.name,
		name: entry.name,
		...(entry.description ? { description: entry.description } : {}),
	};
	for (const key of ["version", "mcpServers", "skills", "agents", "commands", "provision"] as const) {
		if (source[key] === undefined) continue;
		if (key === "mcpServers" && isRecord(source[key])) manifest.mcpServers = structuredClone(source[key]);
		else if (key === "version" && typeof source[key] === "string") manifest.version = source[key];
		else if (["skills", "agents", "commands"].includes(key)) {
			const values = typeof source[key] === "string" ? [source[key]] : Array.isArray(source[key]) ? source[key] : [];
			manifest[key] = values.filter((value): value is string => typeof value === "string") as never;
		} else if (key === "provision" && isRecord(source[key])) manifest.provision = source[key] as never;
	}
	return manifest;
}

/**
 * Split the `name@marketplace` spelling into its two halves.
 *
 * The marketplace half is optional: a bare name is what `/plugin install` has
 * always accepted, and Step resolves a name across every configured
 * marketplace rather than requiring the qualifier.
 */
/**
 * Split the `name@marketplace` spelling into its two halves.
 *
 * Only the last `@` can introduce the qualifier, and only when it is not the
 * first character — a scoped npm-style name such as `@scope/plugin` has no
 * qualifier at all. A name that itself contains `@` (`foo@bar@baz`) is
 * ambiguous, so the whole specifier is taken as the name rather than silently
 * resolving to `foo@bar` and reporting a marketplace miss the user cannot see.
 */
function parsePluginSpecifier(specifier: string): { name: string; marketplace?: string } {
	const trimmed = specifier.trim();
	const separator = trimmed.lastIndexOf("@");
	if (separator <= 0) return { name: trimmed };
	const name = trimmed.slice(0, separator);
	const marketplace = trimmed.slice(separator + 1);
	if (!marketplace.trim() || name.includes("@")) return { name: trimmed };
	return { name, marketplace: marketplace.trim() };
}

function deriveMarketplaceName(source: string): string | undefined {
	const trimmed = source.replace(/[\\/]+$/u, "");
	const segment = trimmed
		.split(/[\\/:]/u)
		.pop()
		?.replace(/\.git$/iu, "");
	return segment && isSafeName(segment) ? segment : undefined;
}

async function readGitOrigin(dir: string): Promise<string | null> {
	try {
		const result = await execFileAsync("git", ["-C", dir, "remote", "get-url", "origin"], { timeout: 10_000 });
		return result.stdout.trim() || null;
	} catch {
		return null;
	}
}

function isFileNotFound(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
