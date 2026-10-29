import { createHash } from "node:crypto";
import type { StepMcpServerConfig } from "./config-toml.ts";

export const MCP_SETTINGS_FIELDS = [
	"command",
	"args",
	"cwd",
	"env",
	"url",
	"bearer_token_env_var",
	"http_headers",
	"env_http_headers",
	"enabled",
	"startup_timeout_sec",
	"tool_timeout_sec",
	"enabled_tools",
	"disabled_tools",
	"shared",
	"oauth",
] as const;
export type McpSettingsField = (typeof MCP_SETTINGS_FIELDS)[number];
export type McpSettingsFieldChange =
	| { operation: "keep" }
	| { operation: "remove" }
	| { operation: "set"; value: unknown };
export interface McpSettingsPatch {
	revision: string;
	fields: Partial<Record<McpSettingsField, McpSettingsFieldChange>>;
}
export interface McpSettingsView {
	revision: string;
	transport: "stdio" | "http";
	/** Only non-secret metadata. Omitted fields are not empty values to write back. */
	configuration: StepMcpServerConfig;
	protectedFields: McpSettingsField[];
}

export class McpSettingsPatchError extends Error {
	readonly status: number;
	readonly code: "mcp_settings_changed" | "mcp_settings_invalid";
	constructor(code: "mcp_settings_changed" | "mcp_settings_invalid") {
		super(
			code === "mcp_settings_changed"
				? "MCP configuration changed; reload before editing"
				: "Invalid MCP settings patch",
		);
		this.status = code === "mcp_settings_changed" ? 409 : 400;
		this.code = code;
	}
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new McpSettingsPatchError("mcp_settings_invalid");
	return value as Record<string, unknown>;
}

function canonical(value: unknown, depth = 0): string {
	if (depth > 24) throw new McpSettingsPatchError("mcp_settings_invalid");
	if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((item) => canonical(item, depth + 1)).join(",")}]`;
	const object = record(value);
	return `{${Object.keys(object)
		.filter((key) => object[key] !== undefined)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonical(object[key], depth + 1)}`)
		.join(",")}}`;
}

function revision(config: unknown): string {
	const text = canonical(config);
	if (text.length > 1024 * 1024) throw new McpSettingsPatchError("mcp_settings_invalid");
	return createHash("sha256").update(text).digest("hex");
}

const variableName = (value: unknown): value is string =>
	typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(value);
const strings = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((item) => typeof item === "string");

function stringRecord(value: unknown): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	const result: Record<string, string> = {};
	for (const [key, entry] of Object.entries(record(value))) {
		if (typeof entry !== "string") throw new McpSettingsPatchError("mcp_settings_invalid");
		if (key.trim()) result[key.trim()] = entry;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

function positiveNumber(value: unknown): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new McpSettingsPatchError("mcp_settings_invalid");
	}
	return value;
}

function stringList(value: unknown): string[] | undefined {
	if (value === undefined) return undefined;
	if (!strings(value)) throw new McpSettingsPatchError("mcp_settings_invalid");
	return value;
}

function oauthConfig(value: unknown): StepMcpServerConfig["oauth"] {
	if (value === undefined) return undefined;
	const input = record(value);
	const oauth: NonNullable<StepMcpServerConfig["oauth"]> = {};
	for (const key of ["client_id", "client_secret"] as const) {
		if (input[key] === undefined) continue;
		if (typeof input[key] !== "string") throw new McpSettingsPatchError("mcp_settings_invalid");
		oauth[key] = input[key];
	}
	const scopes = stringList(input.scopes);
	if (scopes) oauth.scopes = scopes;
	if (input.callback_port !== undefined) {
		const port = input.callback_port;
		if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65535) {
			throw new McpSettingsPatchError("mcp_settings_invalid");
		}
		oauth.callback_port = port;
	}
	return Object.keys(oauth).length > 0 ? oauth : undefined;
}

/**
 * Parse a replacement declaration, normalizing strings and retaining every supported
 * runtime field. An empty enabled_tools allowlist means no reachable tools.
 * Exactly one transport is required. Invalid declarations yield a value-free 400 error.
 */
export function parseMcpSettingsServerConfig(value: unknown): StepMcpServerConfig {
	const input = record(value);
	const command = typeof input.command === "string" ? input.command.trim() : "";
	const url = typeof input.url === "string" ? input.url.trim() : "";
	if (Boolean(command) === Boolean(url)) throw new McpSettingsPatchError("mcp_settings_invalid");
	const config: StepMcpServerConfig = {};
	if (command) {
		config.command = command;
		const args = stringList(input.args);
		if (args && args.length > 0) config.args = args;
		if (typeof input.cwd === "string" && input.cwd.trim()) config.cwd = input.cwd.trim();
		const env = stringRecord(input.env);
		if (env) config.env = env;
	} else {
		try {
			const parsed = new URL(url);
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("protocol");
		} catch {
			throw new McpSettingsPatchError("mcp_settings_invalid");
		}
		config.url = url;
		const headers = stringRecord(input.http_headers);
		if (headers) config.http_headers = headers;
		if (typeof input.bearer_token_env_var === "string" && input.bearer_token_env_var.trim()) {
			config.bearer_token_env_var = input.bearer_token_env_var.trim();
		}
		const envHeaders = stringRecord(input.env_http_headers);
		if (envHeaders) config.env_http_headers = envHeaders;
		const oauth = oauthConfig(input.oauth);
		if (oauth) config.oauth = oauth;
	}
	const enabledTools = stringList(input.enabled_tools);
	if (enabledTools) config.enabled_tools = enabledTools;
	const disabledTools = stringList(input.disabled_tools);
	if (disabledTools && disabledTools.length > 0) config.disabled_tools = disabledTools;
	if (input.shared !== undefined) {
		if (typeof input.shared !== "boolean") throw new McpSettingsPatchError("mcp_settings_invalid");
		config.shared = input.shared;
	}
	const startup = positiveNumber(input.startup_timeout_sec);
	if (startup !== undefined) config.startup_timeout_sec = startup;
	const toolTimeout = positiveNumber(input.tool_timeout_sec);
	if (toolTimeout !== undefined) config.tool_timeout_sec = toolTimeout;
	if (input.enabled === false) config.enabled = false;
	return config;
}

/** Project a stored declaration without returning command-line, URL, header, environment or OAuth secrets. */
export function getMcpSettingsView(input: unknown): McpSettingsView {
	const config = record(input);
	const stamp = revision(config);
	const command = typeof config.command === "string" && config.command.trim().length > 0;
	const url = typeof config.url === "string" && config.url.trim().length > 0;
	if (command === url) throw new McpSettingsPatchError("mcp_settings_invalid");
	const configuration: StepMcpServerConfig = {};
	const protectedFields: McpSettingsField[] = [];
	for (const field of ["command", "args", "cwd", "env", "url", "http_headers", "oauth"] as const) {
		if (config[field] !== undefined) protectedFields.push(field);
	}
	for (const field of ["enabled", "shared"] as const) {
		if (typeof config[field] === "boolean") configuration[field] = config[field];
		else if (config[field] !== undefined) protectedFields.push(field);
	}
	for (const field of ["startup_timeout_sec", "tool_timeout_sec"] as const) {
		const value = config[field];
		if (typeof value === "number" && Number.isFinite(value) && value > 0) configuration[field] = value;
		else if (value !== undefined) protectedFields.push(field);
	}
	for (const field of ["enabled_tools", "disabled_tools"] as const) {
		if (strings(config[field])) configuration[field] = [...config[field]];
		else if (config[field] !== undefined) protectedFields.push(field);
	}
	if (variableName(config.bearer_token_env_var)) configuration.bearer_token_env_var = config.bearer_token_env_var;
	else if (config.bearer_token_env_var !== undefined) protectedFields.push("bearer_token_env_var");
	if (config.env_http_headers !== undefined) {
		const headers = config.env_http_headers;
		if (
			headers &&
			typeof headers === "object" &&
			!Array.isArray(headers) &&
			Object.values(headers).every(variableName) &&
			Object.keys(headers).every((key) => /^[A-Za-z0-9_-]{1,128}$/u.test(key))
		) {
			configuration.env_http_headers = Object.fromEntries(Object.entries(headers));
		} else protectedFields.push("env_http_headers");
	}
	return { revision: stamp, transport: command ? "stdio" : "http", configuration, protectedFields };
}

/**
 * Apply explicit changes to an authoritative snapshot. The caller must run this under
 * its configuration lock, then validate the resulting declaration before publishing it.
 * An omitted field or a keep operation never means deletion, including tool allow lists.
 */
export function applyMcpSettingsPatch(current: unknown, input: unknown): Record<string, unknown> {
	const config = record(current);
	const patch = record(input);
	if (
		Object.keys(patch).some((key) => key !== "revision" && key !== "fields") ||
		typeof patch.revision !== "string" ||
		!/^[a-f0-9]{64}$/u.test(patch.revision)
	) {
		throw new McpSettingsPatchError("mcp_settings_invalid");
	}
	if (patch.revision !== revision(config)) throw new McpSettingsPatchError("mcp_settings_changed");
	const fields = record(patch.fields);
	const result: Record<string, unknown> = structuredClone(config);
	for (const [key, raw] of Object.entries(fields)) {
		if (!MCP_SETTINGS_FIELDS.some((field) => field === key)) throw new McpSettingsPatchError("mcp_settings_invalid");
		const change = record(raw);
		if (change.operation === "set") {
			if (Object.keys(change).length !== 2 || !Object.hasOwn(change, "value") || change.value === undefined) {
				throw new McpSettingsPatchError("mcp_settings_invalid");
			}
			canonical(change.value);
			result[key] = structuredClone(change.value);
		} else if (change.operation === "keep" || change.operation === "remove") {
			if (Object.keys(change).length !== 1) throw new McpSettingsPatchError("mcp_settings_invalid");
			if (change.operation === "remove") delete result[key];
		} else throw new McpSettingsPatchError("mcp_settings_invalid");
	}
	revision(result);
	return result;
}

/**
 * Apply and validate a settings edit against the authoritative declaration. The caller
 * must hold its configuration lock through publication. Transport changes require
 * explicit removal of incompatible fields; untouched values retain their exact form,
 * including empty restrictions and metadata not understood by this version.
 * Throws value-free McpSettingsPatchError (400 invalid, 409 stale revision).
 */
export function applyValidatedMcpSettingsPatch(current: unknown, input: unknown): Record<string, unknown> {
	const existing = record(current);
	const patched = applyMcpSettingsPatch(existing, input);
	for (const field of ["command", "url", "cwd", "bearer_token_env_var"] as const) {
		if (patched[field] !== undefined && typeof patched[field] !== "string") {
			throw new McpSettingsPatchError("mcp_settings_invalid");
		}
	}
	if (patched.enabled !== undefined && typeof patched.enabled !== "boolean") {
		throw new McpSettingsPatchError("mcp_settings_invalid");
	}
	for (const field of ["startup_timeout_sec", "tool_timeout_sec"] as const) {
		if (patched[field] !== undefined && typeof patched[field] !== "number") {
			throw new McpSettingsPatchError("mcp_settings_invalid");
		}
	}
	const http = typeof patched.url === "string" && patched.url.trim().length > 0;
	const incompatible = http
		? ["command", "args", "cwd", "env"]
		: ["url", "http_headers", "env_http_headers", "bearer_token_env_var", "oauth"];
	if (incompatible.some((field) => patched[field] !== undefined)) {
		throw new McpSettingsPatchError("mcp_settings_invalid");
	}
	const next: Record<string, unknown> = { ...parseMcpSettingsServerConfig(patched) };
	if (typeof patched.enabled === "boolean") next.enabled = patched.enabled;
	for (const [field, value] of Object.entries(existing)) {
		if (Object.hasOwn(patched, field) && JSON.stringify(patched[field]) === JSON.stringify(value)) {
			next[field] = value;
		}
	}
	return next;
}
