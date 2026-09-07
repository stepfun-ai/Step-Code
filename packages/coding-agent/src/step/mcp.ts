import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, type Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { type TSchema, Type } from "typebox";
import { readStoredCredential } from "../core/auth-storage.ts";
import type { ExtensionAPI, ExtensionFactory } from "../core/extensions/types.ts";
import { getStepAuthPath } from "./auth.ts";
import {
	defaultStepPluginsDir,
	listStepPluginDirectories,
	provisionInstallCommand,
	readStepPluginManifest,
	type StepPluginProvision,
} from "./plugins.ts";

const MCP_TIMEOUT_MS = 30_000;
const CLIENT_INFO = { name: "step-harness", version: "0.3.1" } as const;
const STEPPAGE_SERVER_NAME = "steppage__steppage";
const STEPPAGE_DEPLOY_TOOL_NAME = "page_deploy";
const STEPPAGE_MANAGEMENT_URL = "https://platform.stepfun.com/sites";

interface ConnectedServer {
	readonly name: string;
	readonly client: Client;
	readonly transport: StdioClientTransport;
	readonly tools: McpTool[];
}

interface ServerDeclaration {
	command: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
}

interface DiscoveredServer {
	name: string;
	declaration: ServerDeclaration;
	provision?: StepPluginProvision;
}

/** Load installed declarative MCP servers and expose their tools to Pi. */
export function createStepMcpExtension(): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		let servers: ConnectedServer[] = [];

		pi.on("session_start", async (_event, ctx) => {
			if (servers.length > 0) return;
			const discovered = await discoverServers(ctx.cwd, ctx.isProjectTrusted());
			for (const item of discovered) {
				try {
					const connected = await connectServer(item);
					servers.push(connected);
					for (const tool of connected.tools) {
						pi.registerTool(createRemoteTool(connected, tool));
					}
				} catch (error) {
					ctx.ui.notify(
						describeMcpStartFailure({
							name: item.name,
							command: item.declaration.command,
							provision: item.provision,
							error,
						}),
						"warning",
					);
				}
			}
		});

		pi.on("session_shutdown", async () => {
			const closing = servers;
			servers = [];
			await Promise.all(
				closing.map(async (server) => {
					try {
						await server.client.close();
					} catch {
						await server.transport.close().catch(() => undefined);
					}
				}),
			);
		});
	};
}

async function discoverServers(cwd: string, projectTrusted: boolean): Promise<DiscoveredServer[]> {
	const roots = [defaultStepPluginsDir(process.env)];
	if (projectTrusted) roots.push(defaultStepPluginsDir(process.env, { cwd, project: true }));
	const result: DiscoveredServer[] = [];
	const seen = new Set<string>();
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
				const discovered: DiscoveredServer = { name, declaration: normalizeDeclaration(value) };
				if (parsed.manifest.provision) discovered.provision = parsed.manifest.provision;
				result.push(discovered);
			}
		}
	}
	return result;
}

function normalizeDeclaration(value: Record<string, unknown>): ServerDeclaration {
	const declaration: ServerDeclaration = { command: String(value.command).trim() };
	if (Array.isArray(value.args)) declaration.args = value.args.filter(isString);
	if (typeof value.cwd === "string" && value.cwd.trim()) declaration.cwd = value.cwd.trim();
	if (isRecord(value.env)) {
		const env: Record<string, string> = {};
		for (const [key, entry] of Object.entries(value.env)) if (typeof entry === "string") env[key] = entry;
		declaration.env = env;
	}
	return declaration;
}

async function connectServer(input: DiscoveredServer): Promise<ConnectedServer> {
	const env = resolveStepMcpEnvironment(input.declaration.env);
	const transport = new StdioClientTransport({
		command: input.declaration.command,
		args: input.declaration.args,
		cwd: input.declaration.cwd,
		env,
		stderr: "pipe",
	});
	// Drain server diagnostics so a chatty MCP process cannot block on a full pipe.
	transport.stderr?.on("data", () => undefined);
	const client = new Client(CLIENT_INFO, { capabilities: {} });
	await client.connect(transport, { timeout: MCP_TIMEOUT_MS });
	const listed = await client.listTools(undefined, { timeout: MCP_TIMEOUT_MS });
	return { name: input.name, client, transport, tools: listed.tools };
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

function createRemoteTool(server: ConnectedServer, remote: McpTool) {
	const name = `${server.name}__${sanitizeName(remote.name)}`;
	return {
		name,
		label: remote.title?.trim() || remote.name,
		description: `StepPage MCP tool '${remote.name}'. ${remote.description?.trim() || "Deploy and manage a static site."}`,
		parameters: schemaFromJson(remote.inputSchema),
		execute: async (
			_toolCallId: string,
			params: unknown,
			signal: AbortSignal | undefined,
		): Promise<AgentToolResult<unknown>> => {
			const result = (await server.client.callTool(
				{ name: remote.name, arguments: isRecord(params) ? params : {} },
				CallToolResultSchema,
				{ timeout: MCP_TIMEOUT_MS, resetTimeoutOnProgress: true, signal },
			)) as { content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown };
			if ((result as { isError?: boolean }).isError === true) {
				const errorText = (result.content ?? [])
					.filter((item) => item.type === "text" && typeof item.text === "string")
					.map((item) => item.text as string)
					.join("\n\n")
					.trim();
				throw new Error(errorText || `MCP tool '${remote.name}' failed.`);
			}
			const text = (result.content ?? [])
				.filter((item) => item.type === "text" && typeof item.text === "string")
				.map((item) => item.text as string)
				.join("\n\n");
			const renderedText = appendStepPageManagementHint(
				server.name,
				remote.name,
				text || JSON.stringify(result.structuredContent ?? result),
			);
			return {
				content: [{ type: "text", text: renderedText }],
				details: result,
			};
		},
	};
}

export function appendStepPageManagementHint(serverName: string, toolName: string, text: string): string {
	if (serverName !== STEPPAGE_SERVER_NAME || toolName !== STEPPAGE_DEPLOY_TOOL_NAME) return text;
	return `${text}\n\n如要管理已部署的页面，请前往 ${STEPPAGE_MANAGEMENT_URL}`;
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
