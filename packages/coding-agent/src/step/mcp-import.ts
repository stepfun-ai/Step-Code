/**
 * Reads MCP server declarations out of other agent CLIs' config files so they
 * can be migrated into `~/.stepcode/config.toml`.
 *
 * Unlike the equivalent in the previous CLI, which re-read the foreign files on
 * every launch, this is a one-time translation: the user reviews a list, picks
 * what to keep, and the result is written into Step's own config. The foreign
 * files are opened read-only and are never written, renamed, or removed.
 *
 * Three rules govern everything in this file.
 *
 * **Never throw.** These files belong to another tool. One `sse` server in
 * `~/.claude.json`, a truncated JSON read, or a `[mcp_servers]` table with a
 * stray value must not be able to stop Step from starting. Every server is
 * translated in isolation, and a failure becomes a reason string attached to
 * that one row.
 *
 * **Report what was dropped.** Both source schemas are larger than Step's, so
 * translation is lossy by construction. A silently ignored field is worse than
 * an absent one: the user configured it on purpose and would assume it still
 * applies. Each translator enumerates the keys it *consumed* and reports the
 * remainder, which also means a field added upstream later surfaces as a
 * warning instead of vanishing.
 *
 * **Never inline a secret.** Codex's `bearer_token_env_var` and
 * `env_http_headers` hold variable *names*. Step's schema has the same fields,
 * so the names are copied verbatim. Dereferencing them here would bake a live
 * token into a file on disk that the user never asked to hold one.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { parse as parseToml } from "smol-toml";
import { readGlobalStepConfig, type StepMcpServerConfig, updateGlobalMcpConfig } from "./config-toml.ts";

/**
 * Named after each agent's home directory, even though Claude Code keeps its
 * MCP servers in `~/.claude.json` rather than inside `~/.claude/`.
 */
export const STEP_MCP_IMPORT_SOURCES = [".claude", ".codex"] as const;

export type StepMcpImportSource = (typeof STEP_MCP_IMPORT_SOURCES)[number];

export function isStepMcpImportSource(value: string): value is StepMcpImportSource {
	return (STEP_MCP_IMPORT_SOURCES as readonly string[]).includes(value);
}

/** Human-facing label for a source, used in the prompt and in warnings. */
export function describeStepMcpImportSource(source: StepMcpImportSource): string {
	return source === ".claude" ? "Claude Code" : "Codex";
}

/**
 * Where each source keeps its MCP servers. Exported so the prompt describes the
 * same paths this module actually reads.
 */
export function stepMcpImportSourcePath(source: StepMcpImportSource, homeDir: string = homedir()): string {
	return source === ".claude" ? join(homeDir, ".claude.json") : join(homeDir, ".codex", "config.toml");
}

/** Why a server cannot be imported, or `undefined` when it can. */
export type StepMcpImportBlock =
	| { kind: "unsupported"; detail: string }
	| { kind: "incomplete"; detail: string }
	/** Already imported under another name — not a failure, just not a second copy. */
	| { kind: "duplicate"; detail: string }
	/** Every fallback name was taken by a different server. */
	| { kind: "name-exhausted"; detail: string };

interface StepMcpTranslationDiagnostic {
	readonly code:
		| "mcp-unsupported-transport"
		| "mcp-incomplete-config"
		| "mcp-invalid-tool-filter"
		| "mcp-fields-not-translated"
		| "mcp-remote-env-unsupported";
	readonly count?: number;
}

/** Safe for presentation without exposing source names, values, or parser errors. */
export interface StepMcpImportDiagnostic {
	readonly code:
		| StepMcpTranslationDiagnostic["code"]
		| "mcp-name-normalized"
		| "mcp-name-conflict"
		| "mcp-duplicate"
		| "mcp-name-exhausted";
	readonly count?: number;
}

export interface StepMcpImportCandidate {
	readonly source: StepMcpImportSource;
	readonly sourceLabel: string;
	/** Name as written in the foreign config. */
	readonly name: string;
	/** Name it will take in `config.toml`; differs from `name` on a conflict. */
	readonly targetName: string;
	readonly transport: "stdio" | "http";
	/** One-line summary of what the server runs or connects to. */
	readonly summary: string;
	readonly config?: StepMcpServerConfig;
	readonly blocked?: StepMcpImportBlock;
	readonly warnings: readonly string[];
	readonly diagnostics: readonly StepMcpImportDiagnostic[];
}

/** What reading one source produced, including the reason when it produced nothing. */
export interface StepMcpImportSourceStatus {
	readonly source: StepMcpImportSource;
	readonly label: string;
	readonly path: string;
	readonly state: "ok" | "missing" | "empty" | "error";
	/** Present for every state except `ok`; explains what the user is seeing. */
	readonly detail?: string;
	readonly importable: number;
	readonly total: number;
}

export interface StepMcpImportPlan {
	readonly candidates: readonly StepMcpImportCandidate[];
	readonly sources: readonly StepMcpImportSourceStatus[];
	readonly warnings: readonly string[];
}

export interface PlanStepMcpImportOptions {
	readonly homeDir?: string;
	readonly env?: NodeJS.ProcessEnv;
	/** Existing `mcp_servers`; read from the global config when omitted. */
	readonly existing?: Record<string, StepMcpServerConfig>;
	/** Explicit per-source configuration files; source contents are read-only. */
	readonly sourcePaths?: Partial<Record<StepMcpImportSource, string>>;
	/**
	 * Sources to consider; all of them when omitted.
	 *
	 * A source the user is no longer being asked about must not take part in name
	 * allocation. It would claim `figma`, and the source that *is* being offered
	 * would then see its own identical `figma` as a duplicate of a row that is
	 * never shown and never written — so the server could not be imported at all.
	 * Anything the skipped source did import is in `existing` already.
	 */
	readonly sources?: readonly StepMcpImportSource[];
}

/**
 * Builds the reviewable list: every recognised server from every source, with
 * its target name already resolved against what `config.toml` holds.
 */
export function planStepMcpImport(options: PlanStepMcpImportOptions = {}): StepMcpImportPlan {
	const homeDir = options.homeDir ?? homedir();
	const env = options.env ?? process.env;
	const warnings: string[] = [];
	const existing = options.existing ?? readExistingServers(env, warnings);

	const wantedSources = options.sources ?? STEP_MCP_IMPORT_SOURCES;
	const reads = STEP_MCP_IMPORT_SOURCES.filter((source) => wantedSources.includes(source)).map((source) => {
		const path =
			options.sourcePaths?.[source] ??
			(source === ".codex" && env.CODEX_HOME?.trim()
				? join(env.CODEX_HOME.trim(), "config.toml")
				: stepMcpImportSourcePath(source, homeDir));
		const read = readImportSource(source, path);
		warnings.push(...read.warnings);
		return { source, path, read };
	});
	const candidates = allocateStepMcpImportCandidates(
		reads.flatMap(({ read }) => read.servers),
		existing,
	);
	const sources: StepMcpImportSourceStatus[] = reads.map(({ source, path, read }) => {
		const resolved = candidates.filter((candidate) => candidate.source === source);
		return {
			source,
			label: describeStepMcpImportSource(source),
			path,
			state: read.state,
			detail: read.detail,
			importable: resolved.filter((candidate) => candidate.config !== undefined).length,
			total: resolved.length,
		};
	});

	return { candidates, sources, warnings };
}

export interface ApplyStepMcpImportResult {
	/** Target names actually written, in the order they were requested. */
	readonly imported: readonly string[];
	/** Requested names that were skipped, with the reason. */
	readonly skipped: readonly { name: string; reason: string }[];
	readonly configPath?: string;
}

/**
 * Writes the chosen candidates into `~/.stepcode/config.toml`.
 *
 * Selection is by `targetName` because that is what the prompt shows and what
 * the file will contain. Nothing outside `mcp_servers` is touched, and no
 * foreign file is opened at all.
 */
export function applyStepMcpImport(
	plan: StepMcpImportPlan,
	selected: readonly string[],
	env: NodeJS.ProcessEnv = process.env,
): ApplyStepMcpImportResult {
	const wanted = new Set(selected);
	const imported: string[] = [];
	const skipped: { name: string; reason: string }[] = [];
	const additions = new Map<string, StepMcpServerConfig>();

	// A de-duplicated row shares its target name with the row that will write it,
	// so selecting that name must not also report the twin as skipped.
	const importable = new Set(
		plan.candidates.filter((candidate) => candidate.config !== undefined).map((candidate) => candidate.targetName),
	);

	for (const candidate of plan.candidates) {
		if (!wanted.has(candidate.targetName)) continue;
		if (!candidate.config) {
			if (!importable.has(candidate.targetName)) {
				skipped.push({ name: candidate.targetName, reason: candidate.blocked?.detail ?? "cannot be imported" });
			}
			continue;
		}
		additions.set(candidate.targetName, candidate.config);
	}

	if (additions.size === 0) {
		return { imported, skipped };
	}

	try {
		const configPath = updateGlobalMcpConfig(env, (servers) => {
			const next = { ...servers };
			for (const [name, config] of additions) {
				// Check the current value under the settings lock, not the preview snapshot.
				if (Object.hasOwn(servers, name)) {
					skipped.push({
						name,
						reason: isSameServerConfig(servers[name], config)
							? "already in config.toml with identical configuration"
							: "name now holds a different configuration; review again",
					});
					continue;
				}
				Object.defineProperty(next, name, { value: config, enumerable: true, configurable: true, writable: true });
				imported.push(name);
			}
			return next;
		});
		return { imported, skipped, configPath };
	} catch (error) {
		return {
			imported: [],
			skipped: [
				...skipped,
				...Array.from(additions.keys())
					.filter((name) => !skipped.some((entry) => entry.name === name))
					.map((name) => ({ name, reason: `could not write config.toml (${errorMessage(error)})` })),
			],
		};
	}
}

// --- name allocation -----------------------------------------------------

/**
 * Allocates in source order without changing the supplied servers or settings.
 * Defaults preserve CLI equality and name-chain matching; hosts may compare
 * effective configurations across all names with an explicit policy.
 */
export function allocateStepMcpImportCandidates(
	servers: readonly TranslatedServer[],
	existing: Record<string, StepMcpServerConfig>,
	options: {
		sameConfig?: (left: StepMcpServerConfig, right: StepMcpServerConfig) => boolean;
		matchAnyName?: boolean;
	} = {},
): StepMcpImportCandidate[] {
	const allocated = new Map<string, AllocatedServer>();
	for (const [name, config] of Object.entries(existing)) {
		allocated.set(name, { config, origin: "config" });
	}
	return servers.map((server) =>
		resolveCandidate(server, allocated, options.sameConfig ?? isSameServerConfig, options.matchAnyName ?? false),
	);
}

/** A name already spoken for, and by what. */
interface AllocatedServer {
	readonly config: StepMcpServerConfig;
	/** `config` = already in config.toml; otherwise the source that claimed it. */
	readonly origin: "config" | StepMcpImportSource;
	readonly originLabel?: string;
}

/**
 * Picks the name a server takes in `config.toml`.
 *
 * The previous CLI let a later source overwrite an earlier one by name, on the
 * theory that two tools declaring `playwright` mean the same server. That is
 * wrong for a migration: the write is permanent, and a Codex `playwright`
 * pointing at a different binary than the Claude one would silently replace it.
 * So nothing is ever clobbered. A name already spoken for by a *different*
 * server falls back to a source suffix (`playwright-codex`), then to a counter.
 *
 * The exception is an entry that is byte-for-byte what we would have written.
 * Most people who run both CLIs configured the same servers in both, so the
 * common case is two sources describing one server; importing it twice under
 * `figma` and `figma-codex` would give the model two identical toolsets and
 * double every tool name it sees. Such a row is marked as a duplicate of the
 * name that already holds it, whether that name came from `config.toml` or from
 * the source processed earlier in this same run.
 */
function resolveCandidate(
	server: TranslatedServer,
	allocated: Map<string, AllocatedServer>,
	sameConfig: (left: StepMcpServerConfig, right: StepMcpServerConfig) => boolean,
	matchAnyName: boolean,
): StepMcpImportCandidate {
	const warnings = [...server.warnings];
	const diagnostics: StepMcpImportDiagnostic[] = [...server.diagnostics];
	const base = sanitizeServerName(server.name);
	if (base !== server.name) {
		diagnostics.push({ code: "mcp-name-normalized" });
		warnings.push(
			`mcpServer '${server.name}' from ${server.sourceLabel} contains characters Step cannot use in a tool name; it is imported as '${base}'.`,
		);
	}

	const shared = {
		source: server.source,
		sourceLabel: server.sourceLabel,
		name: server.name,
		transport: server.transport,
		summary: server.summary,
		warnings,
		diagnostics,
	} as const;

	if (!server.config) {
		return { ...shared, targetName: base, blocked: server.blocked };
	}

	const config = server.config;
	const duplicate = matchAnyName
		? Array.from(allocated).find(([, current]) => sameConfig(current.config, config))
		: undefined;
	const names = duplicate ? [duplicate[0]] : nameCandidates(base, server.source);
	for (const candidateName of names) {
		const current = allocated.get(candidateName);
		if (!current) {
			allocated.set(candidateName, {
				config: server.config,
				origin: server.source,
				originLabel: server.sourceLabel,
			});
			return { ...shared, targetName: candidateName, config: server.config };
		}
		if (sameConfig(current.config, server.config)) {
			diagnostics.push({ code: "mcp-duplicate" });
			return {
				...shared,
				targetName: candidateName,
				blocked: {
					kind: "duplicate",
					detail:
						current.origin === "config"
							? `already in config.toml as '${candidateName}'`
							: `same server as ${current.originLabel ?? "another source"}; imports once as '${candidateName}'`,
				},
			};
		}
		if (!diagnostics.some((diagnostic) => diagnostic.code === "mcp-name-conflict"))
			diagnostics.push({ code: "mcp-name-conflict" });
	}

	diagnostics.push({ code: "mcp-name-exhausted" });
	return {
		...shared,
		targetName: base,
		blocked: { kind: "name-exhausted", detail: `'${base}' is taken and no free name was found` },
	};
}

/** `foo`, then `foo-codex`, then `foo-codex-2`, `foo-codex-3`, … */
function* nameCandidates(base: string, source: StepMcpImportSource): Generator<string> {
	yield base;
	const suffix = source === ".claude" ? "claude" : "codex";
	yield `${base}-${suffix}`;
	for (let index = 2; index <= 64; index += 1) {
		yield `${base}-${suffix}-${index}`;
	}
}

/**
 * A server name becomes the `<server>__<tool>` prefix the model sees, so it is
 * restricted to what a tool name may contain.
 */
function sanitizeServerName(value: string): string {
	const normalized = value.replace(/[^a-zA-Z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "");
	return normalized || "server";
}

function isSameServerConfig(left: StepMcpServerConfig, right: StepMcpServerConfig): boolean {
	return stableStringify(left) === stableStringify(right);
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
	}
	const record = readRecord(value);
	if (!record) {
		return JSON.stringify(value ?? null);
	}
	const keys = Object.keys(record).sort((left, right) => left.localeCompare(right));
	return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function readExistingServers(env: NodeJS.ProcessEnv, warnings: string[]): Record<string, StepMcpServerConfig> {
	try {
		return readGlobalStepConfig(env).mcp_servers ?? {};
	} catch (error) {
		// An unreadable config.toml must not block the review. Treating it as
		// empty would risk allocating a name it already holds, so the safe
		// reading is "everything conflicts": report and import nothing.
		warnings.push(
			`Could not read Step's config.toml (${errorMessage(error)}); no servers can be imported until it parses.`,
		);
		return {};
	}
}

// --- source reading ------------------------------------------------------

export interface TranslatedServer {
	readonly source: StepMcpImportSource;
	readonly sourceLabel: string;
	readonly name: string;
	readonly transport: "stdio" | "http";
	readonly summary: string;
	readonly config?: StepMcpServerConfig;
	readonly blocked?: StepMcpImportBlock;
	readonly warnings: readonly string[];
	readonly diagnostics: readonly StepMcpTranslationDiagnostic[];
}

export interface StepMcpImportSourceRead {
	readonly servers: readonly TranslatedServer[];
	readonly warnings: readonly string[];
	readonly state: "ok" | "empty" | "error" | "missing";
	readonly detail?: string;
	readonly projectScopedCount?: number;
}

// --- Claude Code ---------------------------------------------------------

/**
 * Transports Claude Code writes that Step has no equivalent for.
 *
 * `sse-ide` / `stdio-ide` are injected by the IDE extension for the lifetime of
 * an editor session. They are not user-authored config, so they are dropped
 * without a row — offering to migrate them would promise something that stops
 * existing the moment the editor closes.
 */
const CLAUDE_IDE_TRANSPORTS = new Set(["sse-ide", "stdio-ide", "ws-ide"]);

const CLAUDE_STDIO_KEYS = new Set(["type", "command", "args", "env"]);
const CLAUDE_HTTP_KEYS = new Set(["type", "url", "headers"]);

/** Translates raw source content without reading files or resolving environment values. */
export function parseStepMcpImportSource(source: StepMcpImportSource, raw: string): StepMcpImportSourceRead {
	const label = describeStepMcpImportSource(source);
	let parsed: unknown;
	try {
		parsed = source === ".claude" ? JSON.parse(raw) : parseToml(raw);
	} catch {
		// Parser errors may include source lines containing credentials.
		return {
			servers: [],
			warnings: [],
			state: "error",
			detail: `could not parse ${label} config as ${source === ".claude" ? "JSON" : "TOML"}`,
		};
	}
	const root = readRecord(parsed);
	const key = source === ".claude" ? "mcpServers" : "mcp_servers";
	if (!root || (Object.hasOwn(root, key) && !readRecord(root[key]))) {
		return {
			servers: [],
			warnings: [],
			state: "error",
			detail: `${label} config must contain an object of MCP servers`,
		};
	}
	const declared = readRecord(root[key]) ?? {};
	const warnings: string[] = [];
	const servers: TranslatedServer[] = [];
	for (const [name, entry] of Object.entries(declared)) {
		const record = readRecord(entry);
		if (!record) {
			servers.push(
				blockedServer(source, name, {
					kind: "incomplete",
					detail: source === ".claude" ? "the entry is not an object" : "the entry is not a table",
				}),
			);
			continue;
		}
		const translated =
			source === ".claude" ? translateClaudeServer(name, record) : translateCodexServer(name, record);
		if (translated) servers.push(translated);
	}
	// Foreign project scope is not promoted into Step's global settings.
	const projectScopedCount = source === ".claude" ? countClaudeProjectScopedServers(root.projects) : undefined;
	if (projectScopedCount) {
		warnings.push(
			`Claude Code declares ${projectScopedCount} project-scoped MCP server(s) under projects[...].mcpServers; only user-scoped servers are offered here.`,
		);
	}
	return {
		servers,
		warnings,
		projectScopedCount,
		state: servers.length > 0 ? "ok" : "empty",
		detail: servers.length > 0 ? undefined : `${label} config declares no user-scoped MCP servers`,
	};
}

function readImportSource(source: StepMcpImportSource, configPath: string): StepMcpImportSourceRead {
	const raw = readTextFile(configPath);
	if (raw.error) return { servers: [], warnings: [], state: "error", detail: raw.error };
	if (raw.value === undefined) {
		return { servers: [], warnings: [], state: "missing", detail: `${describePath(configPath)} does not exist` };
	}
	return parseStepMcpImportSource(source, raw.value);
}

export function translateClaudeServer(name: string, record: Record<string, unknown>): TranslatedServer | undefined {
	const type = typeof record.type === "string" ? record.type : undefined;

	if (type && CLAUDE_IDE_TRANSPORTS.has(type)) {
		return undefined;
	}

	if (type === "sse" || type === "ws") {
		return blockedServer(".claude", name, {
			kind: "unsupported",
			detail: `uses the ${type} transport; Step supports stdio and http (Streamable HTTP)`,
		});
	}

	if (type === "http") {
		const url = readNonEmptyString(record.url);
		if (!url) {
			return blockedServer(".claude", name, { kind: "incomplete", detail: "http transport with no url" }, "http");
		}
		return {
			source: ".claude",
			sourceLabel: "Claude Code",
			name,
			transport: "http",
			summary: url,
			// `type` is consumed and dropped: Step infers the transport from
			// whether the entry has a command or a url.
			config: compact({ url, http_headers: readStringMap(record.headers) }),
			...reportUnconsumedKeys(name, "Claude Code", record, CLAUDE_HTTP_KEYS),
		};
	}

	if (type !== undefined && type !== "stdio") {
		return blockedServer(".claude", name, {
			kind: "unsupported",
			detail: `uses an unrecognised transport '${type}'`,
		});
	}

	const command = readNonEmptyString(record.command);
	if (!command) {
		return blockedServer(".claude", name, { kind: "incomplete", detail: "no command" });
	}
	const args = readStringArray(record.args);
	return {
		source: ".claude",
		sourceLabel: "Claude Code",
		name,
		transport: "stdio",
		summary: [command, ...(args ?? [])].join(" "),
		config: compact({ command, args, env: readStringMap(record.env) }),
		...reportUnconsumedKeys(name, "Claude Code", record, CLAUDE_STDIO_KEYS),
	};
}

function countClaudeProjectScopedServers(projects: unknown): number {
	const record = readRecord(projects);
	if (!record) return 0;
	let total = 0;
	for (const entry of Object.values(record)) {
		const declared = readRecord(readRecord(entry)?.mcpServers);
		total += declared ? Object.keys(declared).length : 0;
	}
	return total;
}

// --- Codex ---------------------------------------------------------------

const CODEX_STDIO_KEYS = new Set([
	"command",
	"args",
	"env",
	"env_vars",
	"cwd",
	"enabled",
	"enabled_tools",
	"disabled_tools",
	"startup_timeout_sec",
	"tool_timeout_sec",
]);

const CODEX_HTTP_KEYS = new Set([
	"url",
	"http_headers",
	"env_http_headers",
	"bearer_token_env_var",
	"enabled",
	"enabled_tools",
	"disabled_tools",
	"startup_timeout_sec",
	"tool_timeout_sec",
]);

/**
 * Codex's schema and Step's are the same shape, so this is close to an identity
 * translation: both express the transport by which of `command` / `url` is set,
 * and both keep the startup and tool timeouts separately.
 */
export function translateCodexServer(name: string, record: Record<string, unknown>): TranslatedServer {
	for (const field of ["enabled_tools", "disabled_tools"] as const) {
		if (Object.hasOwn(record, field) && !isStringArray(record[field])) {
			return blockedServer(
				".codex",
				name,
				{
					kind: "incomplete",
					detail: `${field} must be an array of strings`,
				},
				readNonEmptyString(record.url) ? "http" : "stdio",
				"mcp-invalid-tool-filter",
			);
		}
	}
	const common = compact({
		enabled: typeof record.enabled === "boolean" ? record.enabled : undefined,
		// An empty allowlist means no tools, not an absent restriction.
		enabled_tools: isStringArray(record.enabled_tools) ? [...record.enabled_tools] : undefined,
		disabled_tools: isStringArray(record.disabled_tools) ? [...record.disabled_tools] : undefined,
		startup_timeout_sec: readPositiveNumber(record.startup_timeout_sec),
		tool_timeout_sec: readPositiveNumber(record.tool_timeout_sec),
	});

	const url = readNonEmptyString(record.url);
	if (url) {
		return {
			source: ".codex",
			sourceLabel: "Codex",
			name,
			transport: "http",
			summary: url,
			// The env-var *names* are carried across untouched. Resolving them to
			// values here would write a live bearer token into config.toml.
			config: compact({
				url,
				http_headers: readStringMap(record.http_headers),
				env_http_headers: readStringMap(record.env_http_headers),
				bearer_token_env_var: readNonEmptyString(record.bearer_token_env_var),
				...common,
			}),
			...reportUnconsumedKeys(name, "Codex", record, CODEX_HTTP_KEYS),
		};
	}

	const command = readNonEmptyString(record.command);
	if (!command) {
		return blockedServer(".codex", name, { kind: "incomplete", detail: "neither command nor url" });
	}

	const unconsumed = reportUnconsumedKeys(name, "Codex", record, CODEX_STDIO_KEYS);
	const remoteEnvWarnings = reportCodexEnvVars(name, record);
	const diagnostics = [...unconsumed.diagnostics];
	if (remoteEnvWarnings.length > 0) {
		diagnostics.push({ code: "mcp-remote-env-unsupported", count: remoteEnvWarnings.length });
	}
	const args = readStringArray(record.args);
	return {
		source: ".codex",
		sourceLabel: "Codex",
		name,
		transport: "stdio",
		summary: [command, ...(args ?? [])].join(" "),
		config: compact({
			command,
			args,
			cwd: readNonEmptyString(record.cwd),
			env: readStringMap(record.env),
			...common,
		}),
		warnings: [...unconsumed.warnings, ...remoteEnvWarnings],
		diagnostics,
	};
}

/**
 * `env_vars` names variables to forward from the ambient environment, where
 * Step's `env` carries literal values.
 *
 * Step already inherits the host environment when it spawns a server, so a
 * forwarded name needs no translation and nothing is written for it — which
 * also keeps whatever those variables hold out of config.toml. `source =
 * "remote"` asks for a value Step cannot obtain, and that is reported rather
 * than quietly treated as local.
 */
function reportCodexEnvVars(name: string, record: Record<string, unknown>): string[] {
	if (!Array.isArray(record.env_vars)) return [];
	const warnings: string[] = [];
	for (const entry of record.env_vars) {
		if (typeof entry === "string") continue; // Inherited from the host environment already.
		const table = readRecord(entry);
		const variable = readNonEmptyString(table?.name);
		if (!variable) continue;
		if (readNonEmptyString(table?.source) === "remote") {
			warnings.push(
				`mcpServer '${name}' from Codex sources env var ${variable} remotely, which Step cannot resolve; the server starts without it.`,
			);
		}
	}
	return warnings;
}

// --- shared readers ------------------------------------------------------

function blockedServer(
	source: StepMcpImportSource,
	name: string,
	blocked: StepMcpImportBlock,
	transport: "stdio" | "http" = "stdio",
	code: StepMcpTranslationDiagnostic["code"] = blocked.kind === "unsupported"
		? "mcp-unsupported-transport"
		: "mcp-incomplete-config",
): TranslatedServer {
	return {
		source,
		sourceLabel: describeStepMcpImportSource(source),
		name,
		transport,
		summary: blocked.detail,
		blocked,
		warnings: [],
		diagnostics: [{ code }],
	};
}

/**
 * Names every key the translator handled, so anything else is reported.
 *
 * Inverting the default this way is what keeps the warning list honest as the
 * upstream schemas grow: a field added to Codex or Claude Code tomorrow shows up
 * here on its own instead of being dropped without trace.
 */
function reportUnconsumedKeys(
	name: string,
	sourceLabel: string,
	record: Record<string, unknown>,
	consumed: ReadonlySet<string>,
): Pick<TranslatedServer, "warnings" | "diagnostics"> {
	const ignored = Object.keys(record)
		.filter((key) => !consumed.has(key))
		.sort((left, right) => left.localeCompare(right));
	if (ignored.length === 0) return { warnings: [], diagnostics: [] };
	return {
		warnings: [
			`mcpServer '${name}' from ${sourceLabel} sets ${ignored.join(", ")}, which Step has no equivalent for; ${ignored.length === 1 ? "it is" : "they are"} ignored.`,
		],
		diagnostics: [{ code: "mcp-fields-not-translated", count: ignored.length }],
	};
}

function readTextFile(filePath: string): { value?: string; error?: string } {
	try {
		return { value: readFileSync(filePath, "utf8") };
	} catch (error) {
		// A missing directory is as ordinary as a missing file: the user simply
		// does not have that tool installed.
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return {};
		return { error: `could not read ${describePath(filePath)} (${errorMessage(error)})` };
	}
}

/** Home-relative so messages never print an absolute path. */
function describePath(filePath: string): string {
	const home = homedir();
	return filePath.startsWith(home) ? join("~", relative(home, filePath)) : filePath;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function readStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value.filter((entry): entry is string => typeof entry === "string");
	return items.length > 0 ? items : undefined;
}

function readStringMap(value: unknown): Record<string, string> | undefined {
	const record = readRecord(value);
	if (!record) return undefined;
	const result: Record<string, string> = {};
	for (const [key, entry] of Object.entries(record)) {
		if (typeof entry === "string") result[key] = entry;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Drops undefined fields so the result matches what a hand-written table looks like. */
function compact(value: Record<string, unknown>): StepMcpServerConfig {
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (entry !== undefined) result[key] = entry;
	}
	return result as StepMcpServerConfig;
}
