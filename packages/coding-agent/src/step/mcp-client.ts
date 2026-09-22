import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type CallToolResult, CallToolResultSchema, type Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { STEPCODE_VERSION } from "./version.ts";

export const DEFAULT_MCP_TIMEOUT_MS = 30_000;

export interface RemoteMcpToolInvocation {
	serverName: string;
	serverUrl: string;
	toolName: string;
	arguments: Record<string, unknown>;
	headers?: Record<string, string>;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface RemoteMcpToolResult {
	isError?: boolean;
	content?: string;
	structuredContent?: Record<string, unknown>;
}

/** Invoke one remote Streamable HTTP MCP tool and close its client afterwards. */
export async function invokeRemoteMcpTool(input: RemoteMcpToolInvocation): Promise<RemoteMcpToolResult> {
	const timeoutMs = input.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
	const transport = new StreamableHTTPClientTransport(new URL(input.serverUrl), {
		requestInit: input.headers ? { headers: input.headers } : undefined,
	});
	const client = new Client({ name: "stepcode", version: STEPCODE_VERSION.value }, { capabilities: {} });

	try {
		await client.connect(transport, { timeout: timeoutMs, signal });
		const tools = await listAllMcpTools(client, signal, timeoutMs);
		if (!tools.some((tool) => tool.name === input.toolName)) {
			throw new Error(`Remote MCP server '${input.serverName}' does not expose tool '${input.toolName}'.`);
		}

		const result = await client.callTool({ name: input.toolName, arguments: input.arguments }, CallToolResultSchema, {
			timeout: timeoutMs,
			resetTimeoutOnProgress: true,
			signal,
		});
		return normalizeMcpResult(normalizeMcpCallToolResult(result));
	} catch (error) {
		throw new Error(
			`MCP tool ${input.serverName}.${input.toolName} failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		try {
			await client.close();
		} catch {
			try {
				await transport.close();
			} catch {
				// Best-effort cleanup only.
			}
		}
	}
}

function normalizeMcpResult(result: CallToolResult): RemoteMcpToolResult {
	const text = (result.content ?? [])
		.filter((item): item is { type: "text"; text: string } => item.type === "text")
		.map((item) => item.text.trim())
		.filter(Boolean)
		.join("\n\n");
	return {
		...(result.isError === true ? { isError: true } : {}),
		...(text ? { content: text } : {}),
		...(isRecord(result.structuredContent) ? { structuredContent: result.structuredContent } : {}),
	};
}

type RawMcpCallToolResult = Awaited<ReturnType<Client["callTool"]>>;

function normalizeMcpCallToolResult(result: RawMcpCallToolResult): CallToolResult {
	if (hasMcpContent(result)) return CallToolResultSchema.parse(result);

	const legacyPayload = isRecord(result) && "toolResult" in result ? result.toolResult : undefined;
	if (hasMcpContent(legacyPayload)) return CallToolResultSchema.parse(legacyPayload);

	const structuredContent = isRecord(legacyPayload) ? legacyPayload : undefined;
	const serialized = safeJsonStringify(legacyPayload).trim();
	return CallToolResultSchema.parse({
		_meta: isRecord(result) ? result._meta : undefined,
		content: serialized ? [{ type: "text", text: serialized }] : [],
		structuredContent,
		isError:
			isRecord(legacyPayload) && typeof legacyPayload.isError === "boolean" ? legacyPayload.isError : undefined,
	});
}

async function listAllMcpTools(client: Client, signal: AbortSignal, timeoutMs: number): Promise<McpTool[]> {
	const tools: McpTool[] = [];
	let cursor: string | undefined;
	do {
		const result = await client.listTools(cursor ? { cursor } : undefined, {
			timeout: timeoutMs,
			signal,
		});
		tools.push(...result.tools);
		cursor = result.nextCursor;
	} while (cursor);
	return tools;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasMcpContent(value: unknown): value is CallToolResult {
	return isRecord(value) && Array.isArray(value.content);
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? "";
	} catch {
		return "";
	}
}
