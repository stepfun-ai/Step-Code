import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { acquireSettingsLockSync, type SettingsScope, type SettingsStorage } from "../core/settings-manager.ts";
import { resolveStepConfigDir, resolveStepConfigRoot } from "./environment.ts";

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

export interface StepConfigDocument {
	mcp_servers?: Record<string, StepMcpServerConfig>;
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

/** Create a config file once, without replacing an existing file. */
export function ensureStepConfigFile(path: string): string {
	if (!existsSync(path)) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		try {
			writeFileSync(path, "# StepCode configuration\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
		}
	}
	return path;
}

/** Create the global config once, without replacing an existing file. */
export function ensureStepGlobalConfig(env: NodeJS.ProcessEnv = process.env): string {
	return ensureStepConfigFile(resolveStepConfigPath(env));
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

/** Atomically write a TOML document. Callers must preserve unknown fields before calling. */
export function writeStepConfig(path: string, document: StepConfigDocument): void {
	const header = readLeadingComments(path);
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
		writeStepConfig(path, update(readStepConfig(path)));
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

	constructor(cwd: string, env: NodeJS.ProcessEnv = process.env, paths: StepTomlSettingsStoragePaths = {}) {
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
			writeStepConfig(path, merged);
		} finally {
			release?.();
		}
	}
}
