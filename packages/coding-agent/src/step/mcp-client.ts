import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
	type CallToolResult,
	CallToolResultSchema,
	ErrorCode,
	ListToolsResultSchema,
	McpError,
	type Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
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
	const closeClient = async () => {
		try {
			await client.close();
		} catch {
			try {
				await transport.close();
			} catch {
				// Best-effort cleanup only.
			}
		}
	};
	// SDK connect() awaits notifications/initialized without forwarding the
	// request signal. Closing the transport also aborts that HTTP request.
	const closeOnAbort = () => {
		void closeClient();
	};
	signal.addEventListener("abort", closeOnAbort, { once: true });
	try {
		signal.throwIfAborted();
		await client.connect(transport, { timeout: timeoutMs, signal });
		const tools = await listAllMcpTools(client, signal, timeoutMs);
		const tool = tools.find((tool) => tool.name === input.toolName);
		if (!tool) {
			throw new Error(`Remote MCP server '${input.serverName}' does not expose tool '${input.toolName}'.`);
		}

		const result = await createMcpToolCaller(client, tool)(input.arguments, {
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
		signal.removeEventListener("abort", closeOnAbort);
		await closeClient();
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

/** Collect a complete snapshot without mutating the SDK's per-page tool metadata cache. */
export async function listAllMcpTools(client: Client, signal: AbortSignal, timeoutMs: number): Promise<McpTool[]> {
	const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
	const tools: McpTool[] = [];
	const cursors = new Set<string>();
	let cursor: string | undefined;
	do {
		deadline.throwIfAborted();
		// SDK 1.27.1 listTools() replaces output validators and task metadata on
		// every page, even if a later page fails. Stage raw pages instead.
		const result = await client.request(
			{ method: "tools/list", params: cursor === undefined ? undefined : { cursor } },
			ListToolsResultSchema,
			{ timeout: timeoutMs, signal: deadline },
		);
		deadline.throwIfAborted();
		tools.push(...result.tools);
		cursor = result.nextCursor;
		if (cursor !== undefined) {
			if (cursors.has(cursor)) throw new Error("MCP tools/list returned a repeated pagination cursor.");
			cursors.add(cursor);
		}
	} while (cursor !== undefined);
	return tools;
}

/** Bind execution policy and output validation to this catalog definition, including in-flight calls. */
export function createMcpToolCaller(client: Client, tool: McpTool) {
	const name = tool.name;
	const requiresTask = tool.execution?.taskSupport === "required";
	// Isolate schema IDs between tools and catalog generations. The SDK's
	// default validator otherwise reuses an old schema with the same $id.
	const validateOutput = tool.outputSchema ? new AjvJsonSchemaValidator().getValidator(tool.outputSchema) : undefined;
	return async (args: Record<string, unknown>, options: RequestOptions): Promise<CallToolResult> => {
		options.signal?.throwIfAborted();
		if (requiresTask) {
			throw new McpError(
				ErrorCode.InvalidRequest,
				`Tool "${name}" requires task-based execution, which this MCP client does not support.`,
			);
		}
		// callTool() looks up mutable SDK metadata after awaiting the response.
		// Use the public request/validator APIs so catalog refreshes cannot alter
		// the contract of a call that has already started.
		const result = await client.request(
			{ method: "tools/call", params: { name, arguments: args } },
			CallToolResultSchema,
			options,
		);
		options.signal?.throwIfAborted();
		if (validateOutput) {
			if (!result.structuredContent && !result.isError) {
				throw new McpError(
					ErrorCode.InvalidRequest,
					`Tool ${name} has an output schema but did not return structured content`,
				);
			}
			if (result.structuredContent) {
				const validation = validateOutput(result.structuredContent);
				if (!validation.valid) {
					throw new McpError(
						ErrorCode.InvalidParams,
						`Structured content does not match the tool's output schema: ${validation.errorMessage}`,
					);
				}
			}
		}
		return result;
	};
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
