import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, type Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import type { AgentToolResult } from "@step-harness/agent-core";
import { type TSchema, Type } from "typebox";
import { readStoredCredential } from "../core/auth-storage.ts";
import type { ExtensionAPI, ExtensionFactory } from "../core/extensions/types.ts";
import { theme } from "../theme/theme.ts";
import { getStepAuthPath } from "./auth.ts";
import { readGlobalStepConfig } from "./config-toml.ts";
import { createStoredMcpOAuthProvider, hasStoredMcpOAuthCredential } from "./mcp-oauth.ts";
import {
	defaultStepPluginsDir,
	listStepPluginDirectories,
	provisionInstallCommand,
	readStepPluginManifest,
	type StepPluginProvision,
} from "./plugins.ts";
import { STEPCODE_VERSION } from "./version.ts";

const MCP_STARTUP_TIMEOUT_SEC = 30;
const MCP_CALL_TIMEOUT_SEC = 300;
const CLIENT_INFO = { name: "step-harness", version: STEPCODE_VERSION.value } as const;
const STEPPAGE_SERVER_NAME = "steppage__steppage";
const STEPPAGE_DEPLOY_TOOL_NAME = "page_deploy";
const STEPPAGE_MANAGEMENT_URL = "https://platform.stepfun.com/sites";

interface ConnectedServer {
	readonly name: string;
	readonly client: Client;
	readonly transport: StdioClientTransport | StreamableHTTPClientTransport;
	readonly tools: McpTool[];
	/** Per-call timeout for this server, from `tool_timeout_sec`. */
	readonly callTimeoutMs: number;
}

interface ServerDeclaration {
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
	oauth?: {
		client_id?: string;
		client_secret?: string;
		scopes?: string[];
		callback_port?: number;
	};
}

interface DiscoveredServer {
	name: string;
	declaration: ServerDeclaration;
	provision?: StepPluginProvision;
}

export interface StepMcpStatus {
	name: string;
	status: "connecting" | "connected" | "failed" | "disabled";
	toolCount: number;
}

let currentMcpStatuses: StepMcpStatus[] = [];

export function getStepMcpStatuses(): StepMcpStatus[] {
	return currentMcpStatuses.map((status) => ({ ...status }));
}

export function formatStepMcpStatuses(statuses: readonly StepMcpStatus[] = currentMcpStatuses): string {
	const lines =
		statuses.length === 0
			? ["No MCP servers configured."]
			: statuses.map((server) => {
					const connected = server.status === "connected";
					const bullet = connected ? theme.fg("success", "•") : theme.fg("dim", "•");
					const state = connected ? theme.fg("success", "connected") : theme.fg("dim", server.status);
					return `${bullet} ${server.name}: ${state} ${theme.fg("dim", `(${server.toolCount} tools)`)}`;
				});
	return ["MCP Tools", ...lines].join("\n");
}

/** Load installed declarative MCP servers and expose their tools to Pi. */
export function createStepMcpExtension(): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		let servers: ConnectedServer[] = [];
		let startup: Promise<void> | undefined;
		let cancellation: AbortController | undefined;
		let statuses: StepMcpStatus[] = [];

		pi.on("session_start", async (_event, ctx) => {
			if (startup) return;
			const controller = new AbortController();
			cancellation = controller;
			statuses = [];
			currentMcpStatuses = statuses;
			startup = (async () => {
				// Finish mounting the interactive session before doing discovery or
				// spawning processes. Awaiting Promise.all in session_start kept the
				// entire initialization path behind the slowest server.
				await yieldToEventLoop();
				if (controller.signal.aborted) return;
				const discovered = await discoverStepMcpServers(ctx.cwd, ctx.isProjectTrusted());
				if (controller.signal.aborted) return;
				statuses.push(
					...discovered.map(
						(item): StepMcpStatus => ({
							name: item.name,
							status: "connecting",
							toolCount: 0,
						}),
					),
				);
				await Promise.all(
					discovered.map(async (item, index) => {
						let connected: ConnectedServer | undefined;
						try {
							const server = await connectStepMcpServer(item, controller.signal);
							connected = server;
							const remoteTools = server.tools.map((tool) => createRemoteTool(server, tool));
							// Publishing a server's catalog refreshes the registry and the
							// Step prompt once. Yield first so a server that finished while
							// the loop was busy cannot preempt input or rendering.
							await yieldToEventLoop();
							controller.signal.throwIfAborted();
							pi.registerTools(remoteTools);
							servers.push(server);
							statuses[index] = {
								name: item.name,
								status: "connected",
								toolCount: server.tools.length,
							};
						} catch (error) {
							if (connected) await closeStepMcpServer(connected);
							if (controller.signal.aborted) return;
							statuses[index] = {
								name: item.name,
								status: "failed",
								toolCount: 0,
							};
							ctx.ui.notify(
								describeMcpStartFailure({
									name: item.name,
									command: item.declaration.command ?? item.declaration.url ?? "configured server",
									provision: item.provision,
									error,
								}),
								"warning",
							);
						}
					}),
				);
			})().catch((error: unknown) => {
				if (!controller.signal.aborted)
					ctx.ui.notify(
						`MCP discovery failed: ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
			});
			// Print/RPC callers expect the initial tool catalog before submitting
			// work. Only the interactive TUI detaches startup from session binding.
			if (ctx.mode !== "tui") await startup;
		});

		pi.on("session_shutdown", async () => {
			cancellation?.abort();
			await startup;
			const closing = servers;
			servers = [];
			startup = undefined;
			if (currentMcpStatuses === statuses) currentMcpStatuses = [];
			await Promise.all(closing.map(closeStepMcpServer));
		});
	};
}

async function closeStepMcpServer(server: Pick<ConnectedServer, "client" | "transport">): Promise<void> {
	try {
		await server.client.close();
	} catch {
		await server.transport.close().catch(() => undefined);
	}
}

export async function discoverStepMcpServers(cwd: string, projectTrusted: boolean): Promise<DiscoveredServer[]> {
	const roots = [defaultStepPluginsDir(process.env)];
	if (projectTrusted) roots.push(defaultStepPluginsDir(process.env, { cwd, project: true }));
	const result: DiscoveredServer[] = [];
	const seen = new Set<string>();
	const config = readGlobalStepConfig(process.env);
	for (const [name, declaration] of Object.entries(config.mcp_servers ?? {})) {
		if (!isRecord(declaration) || declaration.enabled === false) continue;
		if (typeof declaration.command !== "string" && typeof declaration.url !== "string") continue;
		const normalized = normalizeDeclaration(declaration);
		if (typeof normalized.command !== "string" && typeof normalized.url !== "string") continue;
		seen.add(name);
		result.push({ name, declaration: normalized });
	}
	for (const root of roots) {
		for (const pluginDir of await listStepPluginDirectories(root)) {
			const parsed = await readStepPluginManifest(pluginDir);
			if (!parsed.manifest) continue;
			const declared = parsed.manifest?.mcpServers;
			if (!declared || typeof declared === "string") continue;
			for (const [serverName, value] of Object.entries(declared)) {
				if (!isRecord(value) || typeof value.command !== "string" || !value.command.trim()) continue;
				const name = `${parsed.manifest.id}__${serverName}`;
				if (seen.has(name)) continue;
				seen.add(name);
				const discovered: DiscoveredServer = {
					name,
					declaration: normalizeDeclaration(value),
				};
				if (parsed.manifest.provision) discovered.provision = parsed.manifest.provision;
				result.push(discovered);
			}
		}
	}
	return result;
}

function normalizeDeclaration(value: Record<string, unknown>): ServerDeclaration {
	const declaration: ServerDeclaration = {};
	if (typeof value.command === "string" && value.command.trim()) declaration.command = value.command.trim();
	if (typeof value.url === "string" && value.url.trim()) declaration.url = value.url.trim();
	if (Array.isArray(value.args)) declaration.args = value.args.filter(isString);
	if (typeof value.cwd === "string" && value.cwd.trim()) declaration.cwd = value.cwd.trim();
	if (isRecord(value.env)) {
		const env: Record<string, string> = {};
		for (const [key, entry] of Object.entries(value.env)) if (typeof entry === "string") env[key] = entry;
		declaration.env = env;
	}
	for (const key of ["bearer_token_env_var", "startup_timeout_sec", "tool_timeout_sec"] as const) {
		if (key === "bearer_token_env_var" && typeof value[key] === "string")
			declaration.bearer_token_env_var = value[key];
		if (key === "startup_timeout_sec" && typeof value[key] === "number") declaration.startup_timeout_sec = value[key];
		if (key === "tool_timeout_sec" && typeof value[key] === "number") declaration.tool_timeout_sec = value[key];
	}
	for (const key of ["http_headers", "env_http_headers"] as const) {
		if (isRecord(value[key]))
			declaration[key] = Object.fromEntries(
				Object.entries(value[key]).filter(([, v]) => typeof v === "string"),
			) as Record<string, string>;
	}
	for (const key of ["enabled_tools", "disabled_tools"] as const) {
		if (Array.isArray(value[key])) declaration[key] = value[key].filter(isString);
	}
	if (isRecord(value.oauth)) {
		declaration.oauth = {
			...(typeof value.oauth.client_id === "string" ? { client_id: value.oauth.client_id } : {}),
			...(typeof value.oauth.client_secret === "string" ? { client_secret: value.oauth.client_secret } : {}),
			...(Array.isArray(value.oauth.scopes) ? { scopes: value.oauth.scopes.filter(isString) } : {}),
			...(typeof value.oauth.callback_port === "number" ? { callback_port: value.oauth.callback_port } : {}),
		};
	}
	return declaration;
}

export async function connectStepMcpServer(
	input: DiscoveredServer,
	abortSignal?: AbortSignal,
): Promise<ConnectedServer> {
	abortSignal?.throwIfAborted();
	const timeout = timeoutMs(input.declaration.startup_timeout_sec, MCP_STARTUP_TIMEOUT_SEC);
	const callTimeoutMs = timeoutMs(input.declaration.tool_timeout_sec, MCP_CALL_TIMEOUT_SEC);
	let transport: StdioClientTransport | StreamableHTTPClientTransport;
	if (input.declaration.command) {
		const env = resolveStepMcpEnvironment(input.declaration.env);
		transport = new StdioClientTransport({
			command: input.declaration.command,
			args: input.declaration.args,
			cwd: input.declaration.cwd,
			env,
			stderr: "pipe",
		});
		transport.stderr?.on("data", () => undefined);
	} else if (input.declaration.url) {
		const headers = resolveHttpHeaders(input.declaration);
		transport = new StreamableHTTPClientTransport(new URL(input.declaration.url), {
			requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
			...(hasStoredMcpOAuthCredential(input.name, input.declaration.url, process.env)
				? {
						authProvider: createStoredMcpOAuthProvider(input.name, input.declaration.url, process.env),
					}
				: {}),
		});
	} else {
		throw new Error("MCP server must define command or url");
	}
	const client = new Client(CLIENT_INFO, { capabilities: {} });
	const signal = AbortSignal.any([AbortSignal.timeout(timeout), ...(abortSignal ? [abortSignal] : [])]);
	const closeOnAbort = () => {
		void closeStepMcpServer({ client, transport });
	};
	signal.addEventListener("abort", closeOnAbort, { once: true });
	try {
		signal.throwIfAborted();
		await client.connect(transport, { timeout, signal });
		const listed = await client.listTools(undefined, { timeout, signal });
		signal.throwIfAborted();
		return {
			name: input.name,
			client,
			transport,
			tools: selectDeclaredTools(listed.tools, input.declaration),
			callTimeoutMs,
		};
	} catch (error) {
		await closeStepMcpServer({ client, transport });
		throw error;
	} finally {
		signal.removeEventListener("abort", closeOnAbort);
	}
}

/** Clamp a declared timeout to a usable range, falling back to the product default. */
function timeoutMs(declared: number | undefined, fallbackSec: number): number {
	const seconds = typeof declared === "number" && Number.isFinite(declared) && declared > 0 ? declared : fallbackSec;
	return Math.max(1_000, seconds * 1_000);
}

/**
 * Apply the server's allow/deny lists.
 *
 * These are a safety control: a user who lists `enabled_tools` expects every
 * other tool to stay unreachable, so filter here, before the catalog reaches
 * the registry, rather than relying on the model to avoid a name.
 */
function selectDeclaredTools(tools: readonly McpTool[], declaration: ServerDeclaration): McpTool[] {
	const allowed = declaration.enabled_tools;
	const denied = new Set(declaration.disabled_tools ?? []);
	return tools.filter((tool) => {
		if (denied.has(tool.name)) return false;
		return allowed === undefined || allowed.includes(tool.name);
	});
}

function resolveHttpHeaders(declaration: ServerDeclaration): Record<string, string> {
	const headers = { ...(declaration.http_headers ?? {}) };
	for (const [name, envName] of Object.entries(declaration.env_http_headers ?? {})) {
		// The value is the name of an environment variable, not the header value.
		// Fail loudly, as `bearer_token_env_var` does: dropping the header would
		// send an unauthenticated request and report an opaque server error.
		const value = process.env[envName]?.trim();
		if (!value) throw new Error(`MCP header environment variable '${envName}' for '${name}' is missing`);
		headers[name] = value;
	}
	if (declaration.bearer_token_env_var) {
		const token = process.env[declaration.bearer_token_env_var]?.trim();
		if (!token)
			throw new Error(`MCP bearer token environment variable '${declaration.bearer_token_env_var}' is missing`);
		headers.Authorization = `Bearer ${token}`;
	}
	return headers;
}

/** Turn a failed server start into a message the user can act on. */
export function describeMcpStartFailure(input: {
	name: string;
	command: string;
	provision?: StepPluginProvision;
	error: unknown;
	env?: NodeJS.ProcessEnv;
}): string {
	const detail = input.error instanceof Error ? input.error.message : String(input.error);
	if (
		input.error instanceof UnauthorizedError ||
		(input.error instanceof StreamableHTTPError && input.error.code === 401)
	) {
		const name = /^[\w.-]+$/u.test(input.name) ? input.name : `'${input.name.replace(/'/gu, "'\\''")}'`;
		return `MCP server '${input.name}' could not start: ${detail}\nAuthenticate with: step mcp login ${name}, then restart Step.`;
	}
	if (!isMissingExecutable(input.error)) return `MCP server '${input.name}' could not start: ${detail}`;
	const install = input.provision ? provisionInstallCommand(input.provision, input.env ?? process.env) : undefined;
	const remedy = install ? `Install it with: ${install}, then restart Step.` : "Install it, then restart Step.";
	return `MCP server '${input.name}' could not start: '${input.command}' is not installed or not on PATH. ${remedy}`;
}

/** A spawn that failed because the executable is absent, rather than because the server misbehaved. */
function isMissingExecutable(error: unknown): boolean {
	if (isRecord(error) && (error.code === "ENOENT" || error.errno === -2)) return true;
	return error instanceof Error && /\bENOENT\b/u.test(error.message);
}

/** Resolve the environment passed to a plugin server, including Step login fallback. */
export function resolveStepMcpEnvironment(
	declared: Record<string, string> | undefined,
	input: { env?: NodeJS.ProcessEnv; authPath?: string } = {},
): Record<string, string> {
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(input.env ?? process.env)) if (value !== undefined) resolved[key] = value;
	Object.assign(resolved, declared ?? {});
	if (!resolved.STEPFUN_API_KEY?.trim()) {
		const credential = readStoredCredential("step", input.authPath ?? getStepAuthPath());
		if (credential?.type === "oauth" && typeof credential.access === "string" && credential.access.trim()) {
			resolved.STEPFUN_API_KEY = credential.access;
		}
		if (credential?.type === "api_key" && typeof credential.key === "string" && credential.key.trim()) {
			resolved.STEPFUN_API_KEY = credential.key;
		}
	}
	return resolved;
}

interface McpCallResult {
	content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>;
	structuredContent?: unknown;
	isError?: boolean;
}

/**
 * Convert one MCP call result into model-facing content. Image blocks
 * (screenshot-style tools) must survive to the model: the host resizes them
 * and downgrades them to a text placeholder for non-vision models downstream,
 * so dropping them here would blind the model to its own captures.
 */
export function convertMcpCallResult(serverName: string, toolName: string, result: McpCallResult) {
	if (result.isError === true) {
		const errorText = (result.content ?? [])
			.filter((item) => item.type === "text" && typeof item.text === "string")
			.map((item) => item.text as string)
			.join("\n\n")
			.trim();
		throw new Error(errorText || `MCP tool '${toolName}' failed.`);
	}
	const text = (result.content ?? [])
		.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text as string)
		.join("\n\n");
	const images = (result.content ?? []).filter(
		(item): item is { type: "image"; data: string; mimeType: string } =>
			item.type === "image" &&
			typeof item.data === "string" &&
			item.data.length > 0 &&
			typeof item.mimeType === "string",
	);
	// Without this note an image-only result falls into the JSON fallback,
	// which pastes the base64 payload into the text block.
	const fallback = images.length > 0 ? "(see attached image)" : JSON.stringify(result.structuredContent ?? result);
	const renderedText = appendStepPageManagementHint(serverName, toolName, text || fallback);
	return {
		content: [
			{ type: "text" as const, text: renderedText },
			...images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
		],
		details: result,
	};
}

function createRemoteTool(server: ConnectedServer, remote: McpTool) {
	const name = `${server.name}__${sanitizeName(remote.name)}`;
	return {
		name,
		label: remote.title?.trim() || remote.name,
		description: remote.description?.trim() || `MCP tool '${remote.name}' from server '${server.name}'.`,
		parameters: schemaFromJson(remote.inputSchema),
		execute: async (
			_toolCallId: string,
			params: unknown,
			signal: AbortSignal | undefined,
		): Promise<AgentToolResult<unknown>> => {
			const result = (await server.client.callTool(
				{ name: remote.name, arguments: isRecord(params) ? params : {} },
				CallToolResultSchema,
				{ timeout: server.callTimeoutMs, resetTimeoutOnProgress: true, signal },
			)) as McpCallResult;
			return convertMcpCallResult(server.name, remote.name, result);
		},
	};
}

export function appendStepPageManagementHint(serverName: string, toolName: string, text: string): string {
	if (serverName !== STEPPAGE_SERVER_NAME || toolName !== STEPPAGE_DEPLOY_TOOL_NAME) return text;
	return `${text}\n\nTo manage your deployed pages, visit ${STEPPAGE_MANAGEMENT_URL}`;
}

function schemaFromJson(schema: unknown): TSchema {
	if (!isRecord(schema) || !isRecord(schema.properties)) return Type.Object({}, { additionalProperties: true });
	const properties: Record<string, TSchema> = {};
	for (const [key, value] of Object.entries(schema.properties)) {
		const property = schemaValueToTypeBox(value);
		properties[key] =
			Array.isArray(schema.required) && schema.required.includes(key) ? property : Type.Optional(property);
	}
	return Type.Object(properties, { additionalProperties: true });
}

function schemaValueToTypeBox(value: unknown): TSchema {
	if (!isRecord(value)) return Type.Unknown();
	if (Array.isArray(value.enum) && value.enum.length > 0) {
		const literals = value.enum.filter(
			(item): item is string | number | boolean =>
				typeof item === "string" || typeof item === "number" || typeof item === "boolean",
		);
		if (literals.length === 1) return Type.Literal(literals[0]);
		if (literals.length > 1) return Type.Union(literals.map((item) => Type.Literal(item)));
	}
	if (value.type === "array") return Type.Array(schemaValueToTypeBox(value.items));
	if (value.type === "object" && isRecord(value.properties)) return schemaFromJson(value);
	if (value.type === "boolean") return Type.Boolean();
	if (value.type === "number" || value.type === "integer") return Type.Number();
	if (value.type === "string") return Type.String();
	return Type.Unknown();
}

function sanitizeName(value: string): string {
	const normalized = value.replace(/[^a-zA-Z0-9_]+/gu, "_").replace(/^_+|_+$/gu, "");
	return normalized || "tool";
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
