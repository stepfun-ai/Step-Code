import { readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { StepMcpServerConfig } from "../config-toml.ts";
import { allocateStepMcpImportCandidates, parseStepMcpImportSource, type TranslatedServer } from "../mcp-import.ts";
import { fail, hash, info, inside, record, safePath, stable, text } from "./filesystem.ts";
import { configDocument, type MigrationPaths } from "./paths.ts";
import type { MigrationScope, MigrationSource } from "./types.ts";

export interface McpDeclaration {
	name: string;
	config?: StepMcpServerConfig;
	translated: TranslatedServer;
}
export function declarations(
	path: string,
	source: MigrationSource,
	unsupportedProjects?: (count: number) => void,
): McpDeclaration[] {
	if (source !== "codex" && source !== "claude-code") return fail("unsupported-mcp-config");
	const parsed = parseStepMcpImportSource(source === "codex" ? ".codex" : ".claude", text(path)!);
	if (parsed.state === "error") return fail("invalid-source-config");
	if (parsed.projectScopedCount) unsupportedProjects?.(parsed.projectScopedCount);
	return parsed.servers.map((translated) => ({ name: translated.name, config: translated.config, translated }));
}

export function allocateMcpNames(
	declarations: readonly TranslatedServer[],
	existing: Record<string, unknown>,
	sameConfig: (left: StepMcpServerConfig, right: StepMcpServerConfig) => boolean = (left, right) =>
		mcpIdentity(left) === mcpIdentity(right),
) {
	const servers: Record<string, StepMcpServerConfig> = {};
	for (const [name, value] of Object.entries(existing)) {
		if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid-target-config");
		servers[name] = record(value);
	}
	return allocateStepMcpImportCandidates(declarations, servers, { sameConfig, matchAnyName: true });
}

/** Compare the entire declaration; absent enabled/shared carry the runtime defaults. */
export function mcpIdentity(value: unknown): string {
	const normalized = { ...record(value), enabled: true, shared: record(value).shared ?? true };
	return hash(stable(normalized));
}
export function targetServers(
	paths: MigrationPaths,
	scope: MigrationScope = { kind: "global" },
): Record<string, unknown> {
	const doc = configDocument(paths.configFor(scope));
	return doc.mcp_servers === undefined ? {} : record(doc.mcp_servers);
}
const reference = /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::-)?\}$/u;
const secretName = /token|secret|password|passwd|api[-_]?key|authorization|credential|cookie/iu;
export function sanitizedMcp(
	input: StepMcpServerConfig,
	includeSensitive: boolean,
): { config: StepMcpServerConfig; stripped: boolean } {
	const config = structuredClone(input);
	let stripped = false;
	// Login state belongs to its originating identity; it is never migrated, even with literal-value consent.
	if (config.oauth) {
		delete config.oauth;
		stripped = true;
	}
	for (const key of ["env", "http_headers"] as const) {
		const values = config[key];
		if (!values) continue;
		for (const [name, value] of Object.entries(values)) {
			if (!includeSensitive && !reference.test(value)) {
				delete values[name];
				stripped = true;
			}
		}
		if (!Object.keys(values).length) delete config[key];
	}
	if (!includeSensitive && config.args) {
		const args: string[] = [];
		let omitNext = false;
		for (const arg of config.args) {
			if (omitNext) {
				omitNext = false;
				stripped = true;
				continue;
			}
			if ((secretName.test(arg) && !reference.test(arg)) || /\$\{[A-Za-z_][A-Za-z0-9_]*:-[^}]/u.test(arg)) {
				omitNext = secretName.test(arg) && !arg.includes("=") && !arg.includes("${");
				stripped = true;
				continue;
			}
			args.push(arg);
		}
		config.args = args;
	}
	if (config.url) {
		let url: URL;
		try {
			url = new URL(config.url);
		} catch {
			return fail("unsupported-mcp-url");
		}
		if (!["http:", "https:"].includes(url.protocol)) fail("unsupported-mcp-url");
		if (!includeSensitive && (url.username || url.password || url.search || url.hash)) {
			url.username = "";
			url.password = "";
			url.search = "";
			url.hash = "";
			config.url = url.toString();
			stripped = true;
		}
	}
	config.enabled = false;
	return { config, stripped };
}
/** No command, argument, URL or literal header/environment value crosses the DTO boundary. */
export function redactedMcp(config: unknown): string {
	const input = record(config);
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(input)) {
		if (key === "enabled" || key === "shared") result[key] = input[key];
		else if (["bearer_token_env_var", "env_http_headers"].includes(key)) result[key] = "[environment reference]";
		else result[key] = "[redacted]";
	}
	return JSON.stringify(result, null, 2);
}

export function pluginMcpMatches(
	paths: MigrationPaths,
	config: StepMcpServerConfig,
): { path: string; enabled: boolean }[] {
	// A project plugin does not establish availability at the only supported ordinary-MCP target: global.
	const roots = [join(paths.env.STEPCODE_STORAGE_ROOT_DIR?.trim() || join(paths.home, paths.configDir), "plugins")];
	const matches: { path: string; enabled: boolean }[] = [];
	for (const root of roots) {
		if (!info(root)) continue;
		safePath(root);
		const entries = readdirSync(root, { withFileTypes: true });
		if (entries.length > 256) fail("resource-limit");
		for (const entry of entries) {
			if (entry.isSymbolicLink()) fail("unsafe-link");
			if (!entry.isDirectory()) continue;
			const pluginRoot = join(root, entry.name);
			let path = join(pluginRoot, "step.plugin.json");
			let raw = text(path, true);
			if (raw === undefined) {
				path = join(pluginRoot, ".claude-plugin", "plugin.json");
				raw = text(path, true);
			}
			if (raw === undefined) continue;
			let manifest: Record<string, unknown>;
			try {
				manifest = record(JSON.parse(raw));
			} catch {
				return fail("invalid-plugin-config");
			}
			if (typeof manifest.id !== "string" && typeof manifest.name !== "string") fail("invalid-plugin-config");
			let declared = manifest.mcpServers;
			if (!declared && path.endsWith(join(".claude-plugin", "plugin.json")) && info(join(pluginRoot, ".mcp.json")))
				declared = ".mcp.json";
			if (typeof declared === "string") {
				const file = resolve(pluginRoot, declared);
				if (!inside(pluginRoot, file)) fail("unsafe-plugin-path");
				try {
					const parsed = record(JSON.parse(text(file)!));
					declared = parsed.mcpServers ?? parsed;
				} catch {
					return fail("invalid-plugin-config");
				}
			}
			if (!declared) continue;
			for (const [serverName, value] of Object.entries(record(declared))) {
				const qualified = `${manifest.id ?? manifest.name}__${serverName}`;
				const existing = targetServers(paths)[qualified];
				const normalized = { ...record(existing ?? value) };
				delete normalized.type;
				if (normalized.headers && !normalized.http_headers) {
					const headers = record(normalized.headers);
					// Interpolating plugin headers would require ambient credentials; never pretend a literal is equivalent.
					if (Object.values(headers).some((v) => typeof v !== "string" || v.includes("$"))) continue;
					normalized.http_headers = headers;
				}
				delete normalized.headers;
				if (
					typeof normalized.command === "string" &&
					(typeof normalized.cwd !== "string" || !isAbsolute(normalized.cwd))
				) {
					const cwd = resolve(pluginRoot, typeof normalized.cwd === "string" ? normalized.cwd : "");
					normalized.cwd = inside(pluginRoot, cwd) ? cwd : resolve(pluginRoot);
				}
				if (mcpIdentity(normalized) === mcpIdentity(config))
					matches.push({ path, enabled: normalized.enabled !== false });
			}
		}
	}
	return matches;
}
