import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { acquireSettingsLockSync, type SettingsScope, type SettingsStorage } from "../core/settings-manager.ts";
import { resolveStepConfigDir, resolveStepConfigRoot } from "./environment.ts";
import { configSchemaDirective, refreshSchemaFiles } from "./schema-files.ts";

export const STEP_CONFIG_FILE_NAME = "config.toml";

export interface StepMcpServerConfig {
	command?: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	url?: string;
	bearer_token_env_var?: string;
	http_headers?: Record<string, string>;
	env_http_headers?: Record<string, string>;
	enabled?: boolean;
	startup_timeout_sec?: number;
	tool_timeout_sec?: number;
	enabled_tools?: string[];
	disabled_tools?: string[];
	oauth?: { client_id?: string; client_secret?: string; scopes?: string[]; callback_port?: number };
}

/** Search backend selection; see `search-web-tool.ts` for the resolution order. */
export interface StepSearchConfig {
	/** `auto` walks the ordered candidate chain; a provider id pins one backend. */
	provider?: string;
}

export interface StepConfigDocument {
	mcp_servers?: Record<string, StepMcpServerConfig>;
	search?: StepSearchConfig;
	[key: string]: unknown;
}

export function resolveStepConfigPath(env: NodeJS.ProcessEnv = process.env, cwd?: string): string {
	// The global file sits beside the agent directory. Resolving it from the home
	// directory instead would send MCP discovery and `step mcp add` to a
	// different file than the settings manager writes whenever a host injects
	// STEP_CODING_AGENT_DIR.
	const root = cwd ? join(cwd, resolveStepConfigDir(env)) : resolveStepConfigRoot(env);
	return join(root, STEP_CONFIG_FILE_NAME);
}

/**
 * The header a StepCode-created config file starts with.
 *
 * Only the global file gets the editor directive, because only the global
 * directory receives a copy of the schema. A project file lives in a directory
 * the repository owns, and dropping two ~80 KB schemas into every project would
 * be noise in `git status`; its directive would also point at a file that is
 * not there.
 */
function configFileHeader(withSchemaDirective: boolean): string {
	return withSchemaDirective ? `${configSchemaDirective()}\n# StepCode configuration\n` : "# StepCode configuration\n";
}

/**
 * Whether a path is the global `config.toml` (as opposed to a project one).
 *
 * The environment is a parameter rather than `process.env`: an embedded host
 * and the tests inject `STEP_CODING_AGENT_DIR`, and comparing against the
 * process environment would then classify the injected global file as a project
 * one.
 */
export function isGlobalStepConfigPath(path: string, env: NodeJS.ProcessEnv = process.env): boolean {
	return resolve(path) === resolve(resolveStepConfigPath(env));
}

/**
 * Create a config file once, without replacing an existing file.
 *
 * The first line is the editor schema directive when the schema sits beside the
 * file. `writeStepConfig` preserves the leading comment block, so the directive
 * survives settings writes instead of disappearing the first time a setting is
 * saved.
 */
export function ensureStepConfigFile(path: string, options: { withSchemaDirective?: boolean } = {}): string {
	if (!existsSync(path)) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		try {
			writeFileSync(path, configFileHeader(options.withSchemaDirective ?? false), {
				encoding: "utf8",
				mode: 0o600,
				flag: "wx",
			});
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
		}
	}
	return path;
}

/**
 * Create the global config once, and keep the adjacent editor schemas current.
 *
 * Refreshing here covers every launch, so upgrading the binary updates the
 * schema an editor validates against instead of leaving a stale copy behind.
 */
export function ensureStepGlobalConfig(env: NodeJS.ProcessEnv = process.env): string {
	const path = ensureStepConfigFile(resolveStepConfigPath(env), { withSchemaDirective: true });
	refreshSchemaFiles(dirname(path));
	return path;
}

export function readStepConfig(path: string): StepConfigDocument {
	// Preserve filesystem error codes so optional configuration callers can
	// distinguish a missing file from invalid TOML or other read failures.
	const content = readFileSync(path, "utf8");
	try {
		const parsed = parseToml(content) as unknown;
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
			throw new Error("root must be a table");
		return parsed as StepConfigDocument;
	} catch (error) {
		throw new Error(`Invalid Step config TOML ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function readGlobalStepConfig(env: NodeJS.ProcessEnv = process.env): StepConfigDocument {
	const path = ensureStepGlobalConfig(env);
	return readStepConfig(path);
}

/** Global defaults the CLI needs before Pi's settings manager exists. */
export interface StepGlobalDefaults {
	provider?: string;
	model?: string;
	telemetry?: { enabled?: boolean; spool?: boolean; endpoint?: string };
}

/**
 * Read the persisted provider, model and telemetry defaults from the unified
 * config.
 *
 * These are consumed while argv is normalized, before Pi's settings manager is
 * constructed, so they cannot be read through it. Returning an empty object on
 * a missing or malformed file keeps startup working, but a readable file must
 * be honored: silently discarding `telemetry.enabled = false` would re-enable
 * reporting a user turned off.
 */
export function readGlobalStepDefaults(env: NodeJS.ProcessEnv = process.env): StepGlobalDefaults {
	let document: StepConfigDocument;
	try {
		document = readStepConfig(resolveStepConfigPath(env));
	} catch {
		return {};
	}
	const defaults: StepGlobalDefaults = {};
	if (typeof document.defaultProvider === "string" && document.defaultProvider.trim())
		defaults.provider = document.defaultProvider.trim();
	if (typeof document.defaultModel === "string" && document.defaultModel.trim())
		defaults.model = document.defaultModel.trim();
	const raw = document.telemetry;
	if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
		const source = raw as Record<string, unknown>;
		const telemetry: { enabled?: boolean; spool?: boolean; endpoint?: string } = {};
		if (typeof source.enabled === "boolean") telemetry.enabled = source.enabled;
		if (typeof source.spool === "boolean") telemetry.spool = source.spool;
		if (typeof source.endpoint === "string" && source.endpoint.trim()) telemetry.endpoint = source.endpoint.trim();
		defaults.telemetry = telemetry;
	}
	return defaults;
}

/**
 * Read back the comment block a file opens with. Re-emitting TOML loses every
 * comment, so at minimum the header a user (or `ensureStepConfigFile`) put at
 * the top of the file survives a settings write.
 */
function readLeadingComments(path: string): string {
	if (!existsSync(path)) return "";
	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch {
		return "";
	}
	const kept: string[] = [];
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("#")) kept.push(line);
		else if (trimmed.length === 0 && kept.length > 0) kept.push(line);
		else break;
	}
	while (kept.length > 0 && kept[kept.length - 1]!.trim().length === 0) kept.pop();
	return kept.length > 0 ? `${kept.join("\n")}\n` : "";
}

/**
 * Add the editor directive to a header that does not have one.
 *
 * A file written by an older release keeps its settings and gains one comment
 * line, so the schema that a launch now writes beside it is actually referenced.
 * Only the global file goes through this; a project file has no schema to point
 * at.
 */
function withSchemaDirective(header: string): string {
	if (/^#:schema\s/m.test(header)) return header;
	const directive = `${configSchemaDirective()}\n`;
	return header.length > 0 ? `${directive}${header}` : `${directive}# StepCode configuration\n`;
}

/**
 * TOML cannot express null. Drop those keys deliberately here rather than
 * letting the serializer decide, so "cleared" and "absent" mean the same thing
 * at every nesting level instead of silently reshaping the document.
 */
function stripNullValues(value: unknown): unknown {
	if (Array.isArray(value)) return value.filter((item) => item !== null && item !== undefined).map(stripNullValues);
	if (value === null || typeof value !== "object") return value;
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (entry === null || entry === undefined) continue;
		result[key] = stripNullValues(entry);
	}
	return result;
}

/**
 * Atomically write a TOML document. Callers must preserve unknown fields before
 * calling.
 *
 * A file this call creates keeps the header an existing file would have: the
 * global file keeps or gains the editor directive, a project file stays plain.
 * An existing file keeps whatever header it has.
 */
export function writeStepConfig(
	path: string,
	document: StepConfigDocument,
	options: { env?: NodeJS.ProcessEnv; editorDirective?: boolean } = {},
): void {
	const created = !existsSync(path);
	// The caller writes either the global file or a project file and knows which;
	// fall back to the path only when it does not say.
	const wantsDirective = options.editorDirective ?? isGlobalStepConfigPath(path, options.env);
	const existing = created ? undefined : readLeadingComments(path);
	const header = created
		? configFileHeader(wantsDirective)
		: wantsDirective
			? withSchemaDirective(existing ?? "")
			: (existing ?? "");
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const body = stringifyToml(stripNullValues(document) as Record<string, unknown>);
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${header}${body}`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, path);
}

/**
 * Read-modify-write the global config under the settings lock.
 *
 * Every writer shares one critical section: a concurrent `step mcp add` and a
 * settings save must not overwrite each other's half of the document.
 */
export function updateGlobalStepConfig(
	env: NodeJS.ProcessEnv,
	update: (document: StepConfigDocument) => StepConfigDocument,
): string {
	const path = ensureStepGlobalConfig(env);
	const release = acquireSettingsLockSync(path);
	try {
		writeStepConfig(path, update(readStepConfig(path)), { env, editorDirective: true });
	} finally {
		release();
	}
	return path;
}

export function updateGlobalMcpConfig(
	env: NodeJS.ProcessEnv,
	update: (servers: Record<string, StepMcpServerConfig>) => Record<string, StepMcpServerConfig>,
): string {
	return updateGlobalStepConfig(env, (document) => ({
		...document,
		mcp_servers: update(document.mcp_servers ?? {}),
	}));
}

/** Explicit config locations, so an embedded host or a test never reaches the real home. */
export interface StepTomlSettingsStoragePaths {
	global?: string;
	project?: string;
}

/** Adapter used by Pi's settings manager while Step owns the TOML document. */
export class StepTomlSettingsStorage implements SettingsStorage {
	private readonly globalPath: string;
	private readonly projectPath: string;
	private readonly env: NodeJS.ProcessEnv;

	constructor(cwd: string, env: NodeJS.ProcessEnv = process.env, paths: StepTomlSettingsStoragePaths = {}) {
		this.env = env;
		// The product decorator derives its paths from the injected agent and
		// config directories. Accept the same paths here, or the Pi settings and
		// the Step settings of one manager end up in two different files.
		this.globalPath = paths.global ? ensureStepConfigFile(paths.global) : ensureStepGlobalConfig(env);
		this.projectPath = paths.project ?? resolveStepConfigPath(env, cwd);
	}

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const path = scope === "global" ? this.globalPath : this.projectPath;
		// Read, transform and write have to be one critical section: another
		// session writing between the read and the write would otherwise lose its
		// change, and the mcp_servers table is re-merged from that same read.
		const exists = existsSync(path);
		let release: (() => void) | undefined = exists ? acquireSettingsLockSync(path) : undefined;
		try {
			const document = exists ? readStepConfig(path) : undefined;
			let current: string | undefined;
			if (document) {
				const settings = { ...document };
				delete settings.mcp_servers;
				current = JSON.stringify(settings);
			}
			const next = fn(current);
			if (next === undefined) return;
			const settings = JSON.parse(next) as Record<string, unknown>;
			if (!release) {
				ensureStepConfigFile(path);
				release = acquireSettingsLockSync(path);
			}
			const mcp = (document ?? readStepConfig(path)).mcp_servers;
			const merged: StepConfigDocument = { ...settings, ...(mcp ? { mcp_servers: mcp } : {}) };
			writeStepConfig(path, merged, { env: this.env, editorDirective: scope === "global" });
		} finally {
			release?.();
		}
	}
}
