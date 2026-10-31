import { isAbsolute } from "node:path";
import type { AgentMessage } from "@step-harness/agent-core";
import type { ImageContent } from "@step-harness/providers";
import type { AgentSessionEvent } from "../../core/agent-session.ts";
import type { McpServerDeclaration } from "../../step/mcp.ts";
import type {
	AuthenticateParams,
	CloseSessionParams,
	ContentBlock,
	DeleteSessionParams,
	ElicitationResult,
	ForkSessionParams,
	InitializeParams,
	JsonRpcError,
	JsonRpcId,
	JsonRpcRequest,
	JsonRpcResponse,
	JsonRpcResponseObject,
	ListSessionsParams,
	ListSessionsResult,
	PromptParams,
	ReadTextFileParams,
	RequestPermissionResult,
	ResumeSessionParams,
	SessionNotificationParams,
	SessionUpdate,
	SetSessionConfigOptionParams,
	SetSessionModelParams,
	SetSessionModeParams,
	TerminalCreateParams,
	TerminalKillParams,
	TerminalOutputParams,
	TerminalReleaseParams,
	TerminalWaitForExitParams,
	ToolCallContent,
	WriteTextFileParams,
} from "./acp-types.ts";
import { ACP_JSON_RPC_ERRORS } from "./acp-types.ts";

export function serializeJsonLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

export function createResponse(id: JsonRpcId | null, result: unknown): JsonRpcResponse {
	return { jsonrpc: "2.0", id, result };
}

export function createErrorResponse(
	id: JsonRpcId | null,
	code: number,
	message: string,
	data?: unknown,
): JsonRpcResponse {
	const error: JsonRpcError = { code, message };
	if (data !== undefined) {
		error.data = data;
	}
	return { jsonrpc: "2.0", id, error };
}

export function createNotification(
	method: string,
	params: unknown,
): { jsonrpc: "2.0"; method: string; params: unknown } {
	return { jsonrpc: "2.0", method, params };
}

export function parseJsonRpcLine(line: string): {
	request?: JsonRpcRequest;
	response?: JsonRpcResponseObject;
	error?: JsonRpcError;
} {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return { error: { code: ACP_JSON_RPC_ERRORS.parse, message: "Invalid JSON" } };
	}
	if (!isRecord(value)) {
		return { error: { code: ACP_JSON_RPC_ERRORS.invalidRequest, message: "Not a JSON-RPC message" } };
	}
	const id = value.id;
	if (id !== undefined && typeof id !== "string" && typeof id !== "number") {
		return { error: { code: ACP_JSON_RPC_ERRORS.invalidRequest, message: "Invalid id" } };
	}
	if (value.jsonrpc !== undefined && value.jsonrpc !== "2.0") {
		return { error: { code: ACP_JSON_RPC_ERRORS.invalidRequest, message: "Unsupported JSON-RPC version" } };
	}

	if (typeof value.method === "string" && value.method.length > 0) {
		const request: JsonRpcRequest = { method: value.method, params: value.params };
		if (id !== undefined) request.id = id;
		if (value.jsonrpc !== undefined) request.jsonrpc = "2.0";
		return { request };
	}

	if (id !== undefined && ("result" in value || "error" in value)) {
		const response: JsonRpcResponseObject = { id };
		if ("result" in value) response.result = value.result;
		if ("error" in value) response.error = value.error as JsonRpcError;
		if (value.jsonrpc !== undefined) response.jsonrpc = "2.0";
		return { response };
	}

	return { error: { code: ACP_JSON_RPC_ERRORS.invalidRequest, message: "Not a JSON-RPC request or response" } };
}

/**
 * Ceiling on what one tool call sends the client, in characters.
 *
 * ACP puts no limit of its own on `tool_call` content or `rawInput`. The engine
 * already bounds a tool result for the model's sake (see `boundToolResultContent`,
 * which holds it near 50KB); that serves a different purpose, and this is a
 * tighter bound on what a client renders inline. It applies to both directions,
 * because a `write` carries the whole file in its arguments and a `read` returns
 * the whole file in its result, so bounding only the result leaves the same flood
 * open on the way in. Neither bound touches what the model receives.
 */
const TOOL_CALL_CHAR_LIMIT = 4000;
// Structured arguments also contain keys and JSON punctuation. Keep their
// normal shape, but collapse pathological aggregates into bounded JSON text.
const TOOL_INPUT_AGGREGATE_CHAR_LIMIT = 12_000;

/**
 * Marker appended where a value was cut, naming what was removed.
 *
 * Without it a client has no way to tell a truncated argument or result from
 * the complete one, and will present a partial read as the whole read.
 */
function truncationNotice(originalLength: number): string {
	return `[truncated, ${originalLength} characters total]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateInitializeParams(
	params: unknown,
): { ok: true; value: InitializeParams } | { ok: false; message: string } {
	if (!isRecord(params)) {
		return { ok: false, message: "Initialize params must be an object" };
	}
	if (typeof params.protocolVersion !== "number") {
		return { ok: false, message: "protocolVersion must be a number" };
	}
	if (params.clientCapabilities !== undefined && !isRecord(params.clientCapabilities)) {
		return { ok: false, message: "clientCapabilities must be an object" };
	}
	const capabilities = params.clientCapabilities;
	if (capabilities?.fs !== undefined && !isRecord(capabilities.fs)) {
		return { ok: false, message: "clientCapabilities.fs must be an object" };
	}
	if (capabilities?.auth !== undefined && !isRecord(capabilities.auth)) {
		return { ok: false, message: "clientCapabilities.auth must be an object" };
	}
	if (capabilities?.elicitation !== undefined && !isRecord(capabilities.elicitation)) {
		return { ok: false, message: "clientCapabilities.elicitation must be an object" };
	}
	return {
		ok: true,
		value: {
			protocolVersion: params.protocolVersion,
			...(capabilities === undefined
				? {}
				: { clientCapabilities: capabilities as InitializeParams["clientCapabilities"] }),
			...(isRecord(params.clientInfo) ? { clientInfo: params.clientInfo as InitializeParams["clientInfo"] } : {}),
		},
	};
}

export function validateNewSessionParams(
	params: unknown,
): { ok: true; cwd: string; mcpServers: unknown; additionalDirectories: string[] } | { ok: false; message: string } {
	if (!isRecord(params)) {
		return { ok: false, message: "Session params must be an object" };
	}
	if (typeof params.cwd !== "string" || !params.cwd) {
		return { ok: false, message: "cwd is required" };
	}
	if (!isAbsolute(params.cwd)) {
		return { ok: false, message: "cwd must be an absolute path" };
	}
	if (params.mcpServers !== undefined && !Array.isArray(params.mcpServers)) {
		return { ok: false, message: "mcpServers must be an array" };
	}
	// Validated and passed through even though the mode does not expand the
	// filesystem scope for them. Silently dropping the field would leave a client
	// believing it had granted workspace roots the agent cannot reach.
	const additionalDirectories = validateAdditionalDirectories(params.additionalDirectories);
	if (!additionalDirectories.ok) return additionalDirectories;
	return {
		ok: true,
		cwd: params.cwd,
		mcpServers: params.mcpServers,
		additionalDirectories: additionalDirectories.value,
	};
}

/** Normalize `additionalDirectories` to a string array, rejecting any other shape. */
function validateAdditionalDirectories(value: unknown): { ok: true; value: string[] } | { ok: false; message: string } {
	if (value === undefined) return { ok: true, value: [] };
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry)) {
		return { ok: false, message: "additionalDirectories must be an array of non-empty strings" };
	}
	return { ok: true, value: value as string[] };
}

export function validateLoadSessionParams(
	params: unknown,
):
	| { ok: true; sessionId: string; cwd: string; mcpServers: unknown; additionalDirectories: string[] }
	| { ok: false; message: string } {
	if (!isRecord(params)) {
		return { ok: false, message: "Session params must be an object" };
	}
	if (typeof params.sessionId !== "string" || !params.sessionId) {
		return { ok: false, message: "sessionId is required" };
	}
	if (typeof params.cwd !== "string" || !params.cwd) {
		return { ok: false, message: "cwd is required" };
	}
	if (!isAbsolute(params.cwd)) {
		return { ok: false, message: "cwd must be an absolute path" };
	}
	if (params.mcpServers !== undefined && !Array.isArray(params.mcpServers)) {
		return { ok: false, message: "mcpServers must be an array" };
	}
	const additionalDirectories = validateAdditionalDirectories(params.additionalDirectories);
	if (!additionalDirectories.ok) return additionalDirectories;
	return {
		ok: true,
		sessionId: params.sessionId,
		cwd: params.cwd,
		mcpServers: params.mcpServers,
		additionalDirectories: additionalDirectories.value,
	};
}

export function validatePromptParams(
	params: unknown,
): { ok: true; value: PromptParams } | { ok: false; message: string } {
	if (!isRecord(params)) {
		return { ok: false, message: "Prompt params must be an object" };
	}
	if (typeof params.sessionId !== "string" || !params.sessionId) {
		return { ok: false, message: "sessionId is required" };
	}
	if (!Array.isArray(params.prompt)) {
		return { ok: false, message: "prompt must be an array" };
	}
	const prompt: ContentBlock[] = [];
	for (const block of params.prompt) {
		if (!isRecord(block)) {
			return { ok: false, message: "prompt block must be an object" };
		}
		const type = block.type;
		if (type === "text" && typeof block.text === "string") {
			prompt.push({ type: "text", text: block.text });
			continue;
		}
		if (type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
			prompt.push({ type: "image", data: block.data, mimeType: block.mimeType });
			continue;
		}
		if (type === "resource_link" && typeof block.name === "string" && typeof block.uri === "string") {
			prompt.push({ type: "resource_link", name: block.name, uri: block.uri });
			continue;
		}
		if (type === "resource" && isRecord(block.resource)) {
			const { uri, mimeType, text, blob } = block.resource;
			if (typeof uri !== "string") {
				return { ok: false, message: "resource blocks need a uri string" };
			}
			if (typeof text !== "string" && typeof blob !== "string") {
				return { ok: false, message: "resource blocks need either text or blob" };
			}
			prompt.push({
				type: "resource",
				resource: {
					uri,
					...(typeof mimeType === "string" ? { mimeType } : {}),
					...(typeof text === "string" ? { text } : {}),
					...(typeof blob === "string" ? { blob } : {}),
				},
			});
			continue;
		}
		return { ok: false, message: "Unsupported prompt content block" };
	}
	return { ok: true, value: { sessionId: params.sessionId, prompt } };
}

function escapeXmlAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

export function normalizePrompt(prompt: ContentBlock[]): { text: string; images: ImageContent[] } {
	const textParts: string[] = [];
	const images: ImageContent[] = [];
	for (const block of prompt) {
		if (block.type === "text") {
			textParts.push(block.text);
			continue;
		}
		if (block.type === "image") {
			images.push({ type: "image", data: block.data, mimeType: block.mimeType });
			continue;
		}
		if (block.type === "resource_link") {
			textParts.push(`[[${block.name}]](${block.uri})`);
			continue;
		}
		// Embedded resources arrive with their contents, so the prompt carries the
		// payload instead of a link the model would have to fetch itself.
		const { uri, text, blob, mimeType } = block.resource;
		if (typeof text === "string") {
			textParts.push(`[[resource ${uri}]]
${text}`);
			continue;
		}
		if (typeof blob !== "string") throw new Error(`Resource ${uri} has no text or blob payload`);
		const normalizedMimeType = mimeType?.split(";", 1)[0]?.trim().toLowerCase();
		if (normalizedMimeType?.startsWith("image/")) {
			textParts.push(`[[resource ${uri}]] (image attached)`);
			images.push({ type: "image", data: blob, mimeType: normalizedMimeType });
			continue;
		}
		const isText =
			normalizedMimeType?.startsWith("text/") ||
			/^(?:application|text)\/(?:[\w.+-]*\+)?(?:json|xml|javascript|yaml|toml|csv|x-sh)$/.test(
				normalizedMimeType ?? "",
			);
		if (!isText) {
			// The engine's user-message union has no arbitrary binary block. Preserve
			// the payload losslessly in an explicit envelope instead of rejecting the
			// ACP resource or silently dropping it. Text and image resources keep
			// their native paths above; this branch is for every other MIME type.
			const binaryMimeType = normalizedMimeType || "application/octet-stream";
			textParts.push(
				`<resource uri="${escapeXmlAttribute(uri)}" mimeType="${escapeXmlAttribute(binaryMimeType)}" encoding="base64">${blob}</resource>`,
			);
			continue;
		}
		textParts.push(`[[resource ${uri}]]
${Buffer.from(blob, "base64").toString("utf8")}`);
	}
	return { text: textParts.join("\n"), images };
}

export function validateResumeSessionParams(
	params: unknown,
): { ok: true; value: ResumeSessionParams } | { ok: false; message: string } {
	if (!isRecord(params)) {
		return { ok: false, message: "Resume params must be an object" };
	}
	if (typeof params.sessionId !== "string" || !params.sessionId) {
		return { ok: false, message: "sessionId is required" };
	}
	if (typeof params.cwd !== "string" || !params.cwd) {
		return { ok: false, message: "cwd is required" };
	}
	if (!isAbsolute(params.cwd)) {
		return { ok: false, message: "cwd must be an absolute path" };
	}
	if (params.mcpServers !== undefined && !Array.isArray(params.mcpServers)) {
		return { ok: false, message: "mcpServers must be an array" };
	}
	const additionalDirectories = validateAdditionalDirectories(params.additionalDirectories);
	if (!additionalDirectories.ok) return additionalDirectories;
	return {
		ok: true,
		value: {
			sessionId: params.sessionId,
			cwd: params.cwd,
			...(params.mcpServers === undefined ? {} : { mcpServers: params.mcpServers }),
			additionalDirectories: additionalDirectories.value,
		},
	};
}

export function validateListSessionsParams(
	params: unknown,
): { ok: true; value: ListSessionsParams } | { ok: false; message: string } {
	if (params === undefined) {
		return { ok: true, value: {} };
	}
	if (!isRecord(params)) {
		return { ok: false, message: "Session list params must be an object" };
	}
	if (params.cwd !== undefined && (typeof params.cwd !== "string" || !isAbsolute(params.cwd))) {
		return { ok: false, message: "cwd must be an absolute path" };
	}
	if (params.cursor !== undefined && typeof params.cursor !== "string") {
		return { ok: false, message: "cursor must be a string" };
	}
	return {
		ok: true,
		value: {
			...(params.cwd === undefined ? {} : { cwd: params.cwd as string }),
			...(params.cursor === undefined ? {} : { cursor: params.cursor as string }),
		},
	};
}

export function validateCloseSessionParams(
	params: unknown,
): { ok: true; value: CloseSessionParams } | { ok: false; message: string } {
	if (!isRecord(params)) {
		return { ok: false, message: "Close params must be an object" };
	}
	if (typeof params.sessionId !== "string" || !params.sessionId) {
		return { ok: false, message: "sessionId is required" };
	}
	return { ok: true, value: { sessionId: params.sessionId } };
}

export function validateDeleteSessionParams(
	params: unknown,
): { ok: true; value: DeleteSessionParams } | { ok: false; message: string } {
	if (!isRecord(params)) {
		return { ok: false, message: "Delete params must be an object" };
	}
	if (typeof params.sessionId !== "string" || !params.sessionId) {
		return { ok: false, message: "sessionId is required" };
	}
	return { ok: true, value: { sessionId: params.sessionId } };
}

export function validateAuthenticateParams(
	params: unknown,
): { ok: true; value: AuthenticateParams } | { ok: false; message: string } {
	if (!isRecord(params)) {
		return { ok: false, message: "Authenticate params must be an object" };
	}
	if (typeof params.methodId !== "string" || !params.methodId) {
		return { ok: false, message: "methodId is required" };
	}
	return { ok: true, value: { methodId: params.methodId } };
}

/**
 * Read a client response to an `elicitation/create` request.
 *
 * `decline` and `cancel` carry no content, so an absent `content` is only an
 * error on `accept`. Anything unrecognized returns undefined, so the caller
 * cancels the pending request instead of inventing an answer.
 */
export function parseElicitationResult(value: unknown): ElicitationResult | undefined {
	if (!isRecord(value)) return undefined;
	const action = value.action;
	if (action !== "accept" && action !== "decline" && action !== "cancel") return undefined;
	if (action !== "accept") {
		return { action };
	}
	if (value.content !== undefined && !isRecord(value.content)) return undefined;
	return {
		action,
		...(value.content === undefined ? {} : { content: value.content as Record<string, unknown> }),
	};
}

export function validateSetSessionModeParams(
	params: unknown,
): { ok: true; value: SetSessionModeParams } | { ok: false; message: string } {
	if (!isRecord(params)) {
		return { ok: false, message: "Set mode params must be an object" };
	}
	if (typeof params.sessionId !== "string" || !params.sessionId) {
		return { ok: false, message: "sessionId is required" };
	}
	if (typeof params.modeId !== "string" || !params.modeId) {
		return { ok: false, message: "modeId is required" };
	}
	return { ok: true, value: { sessionId: params.sessionId, modeId: params.modeId } };
}

export function validateSetSessionConfigOptionParams(
	params: unknown,
): { ok: true; value: SetSessionConfigOptionParams } | { ok: false; message: string } {
	if (!isRecord(params)) {
		return { ok: false, message: "Set config option params must be an object" };
	}
	if (typeof params.sessionId !== "string" || !params.sessionId) {
		return { ok: false, message: "sessionId is required" };
	}
	if (typeof params.optionId !== "string" || !params.optionId) {
		return { ok: false, message: "optionId is required" };
	}
	if (params.type !== undefined && params.type !== "boolean") {
		return { ok: false, message: "type must be boolean when present" };
	}
	const isBoolean = params.type === "boolean";
	if (isBoolean ? typeof params.value !== "boolean" : typeof params.value !== "string") {
		return { ok: false, message: isBoolean ? "value must be a boolean" : "value must be a string" };
	}
	return {
		ok: true,
		value: {
			sessionId: params.sessionId,
			optionId: params.optionId,
			...(isBoolean ? { type: "boolean" as const } : {}),
			value: params.value as string | boolean,
		},
	};
}
/**
 * Turn engine `SessionInfo` records into ACP `session/list` entries.
 *
 * The engine already computes a display name and a first message; the ACP
 * surface exposes whichever is available so a client can label the row without
 * opening the session. `messageCount` travels in `_meta` because ACP has no
 * field for it and clients show it when present.
 */
export function toAcpSessionListEntries(
	sessions: Array<{
		id: string;
		cwd: string;
		name?: string;
		firstMessage?: string;
		modified: Date;
		messageCount: number;
	}>,
): ListSessionsResult["sessions"] {
	return sessions.map((session) => ({
		sessionId: session.id,
		cwd: session.cwd,
		...(session.name === undefined ? {} : { title: session.name }),
		...(session.name === undefined && session.firstMessage ? { title: session.firstMessage } : {}),
		updatedAt: session.modified.toISOString(),
		_meta: { messageCount: session.messageCount },
	}));
}

export interface AcpMcpServer {
	name: string;
	type?: string;
	command?: string;
	args?: string[];
	env?: Array<{ name: string; value: string }>;
	url?: string;
	headers?: Array<{ name: string; value: string }>;
}

/**
 * Convert ACP `mcpServers` into engine MCP declarations, keyed by server name.
 *
 * ACP v1 sends a named array discriminated by `type`, where an absent `type`
 * means stdio; the engine wants a name-keyed record. All three transports the
 * protocol defines are accepted: stdio, `http`, and `sse`. SSE is deprecated but
 * still defined and still sent, so it is marked on the declaration rather than
 * reported and dropped. Only the unstable `acp` transport is rejected, because
 * nothing can act on it.
 *
 * A rejected name is reported rather than dropped silently: a server the client
 * asked for and never received is indistinguishable from one that failed to
 * start.
 */
export function convertAcpMcpServers(servers: unknown): {
	declarations: Record<string, McpServerDeclaration>;
	rejected: string[];
} {
	const declarations: Record<string, McpServerDeclaration> = {};
	const rejected: string[] = [];
	if (!Array.isArray(servers)) return { declarations, rejected };
	for (const entry of servers) {
		if (!isRecord(entry)) {
			rejected.push("<invalid>");
			continue;
		}
		const server = entry as unknown as AcpMcpServer;
		const name = typeof server.name === "string" ? server.name.trim() : "";
		if (!name) {
			rejected.push("<unnamed>");
			continue;
		}
		if (server.type !== undefined && server.type !== "http" && server.type !== "sse") {
			rejected.push(name);
			continue;
		}
		if (server.type === "http" || server.type === "sse") {
			if (typeof server.url !== "string" || !server.url) {
				rejected.push(name);
				continue;
			}
			const headers = namedPairsToRecord(server.headers);
			declarations[name] = {
				url: server.url,
				// SSE is selected by the transport the client named, not guessed from
				// the URL, which cannot be told apart from a streamable-HTTP one.
				...(server.type === "sse" ? { transport: "sse" as const } : {}),
				...(headers ? { http_headers: headers } : {}),
			};
			continue;
		}
		if (typeof server.command !== "string" || !server.command) {
			rejected.push(name);
			continue;
		}
		const env = namedPairsToRecord(server.env);
		declarations[name] = {
			command: server.command,
			...(Array.isArray(server.args) ? { args: server.args.filter((arg) => typeof arg === "string") } : {}),
			...(env ? { env } : {}),
		};
	}
	return { declarations, rejected };
}

function namedPairsToRecord(pairs: unknown): Record<string, string> | undefined {
	if (!Array.isArray(pairs) || pairs.length === 0) return undefined;
	const record: Record<string, string> = {};
	for (const pair of pairs) {
		if (!isRecord(pair)) continue;
		if (typeof pair.name !== "string" || typeof pair.value !== "string") continue;
		record[pair.name] = pair.value;
	}
	return Object.keys(record).length === 0 ? undefined : record;
}

export function parseRequestPermissionResult(value: unknown): RequestPermissionResult | null {
	if (!isRecord(value) || !isRecord(value.outcome)) return null;
	const outcome = value.outcome;
	if (outcome.outcome === "cancelled") {
		return { outcome: { outcome: "cancelled" } };
	}
	if (outcome.outcome === "selected" && typeof outcome.optionId === "string") {
		return { outcome: { outcome: "selected", optionId: outcome.optionId } };
	}
	return null;
}

export function mapAssistantEventToSessionUpdate(event: AgentSessionEvent): SessionUpdate | null {
	if (event.type === "message_update") {
		const assistantEvent = event.assistantMessageEvent;
		if (assistantEvent.type === "text_delta" && assistantEvent.delta.length > 0) {
			return {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: assistantEvent.delta },
			};
		}
		if (assistantEvent.type === "thinking_delta" && assistantEvent.delta.length > 0) {
			return {
				sessionUpdate: "agent_thought_chunk",
				content: { type: "text", text: assistantEvent.delta },
			};
		}
		return null;
	}
	if (event.type === "tool_execution_start") {
		return {
			sessionUpdate: "tool_call",
			toolCallId: event.toolCallId,
			title: buildToolTitle(event.toolName, event.args),
			name: event.toolName,
			kind: mapToolKind(event.toolName),
			status: "pending",
			content: [],
			rawInput: boundToolInput(event.args),
		};
	}
	if (event.type === "tool_execution_update") {
		// The protocol asks for an in_progress status once the tool is running,
		// and this is the only event between start and end. Without it a client
		// sees a call appear as pending and then jump straight to its outcome.
		return {
			sessionUpdate: "tool_call_update",
			toolCallId: event.toolCallId,
			status: "in_progress",
			...(event.partialResult == null ? {} : { content: [toolOutputContent(event.partialResult)] }),
		};
	}
	if (event.type === "tool_execution_end") {
		const update: SessionUpdate = {
			sessionUpdate: "tool_call_update",
			toolCallId: event.toolCallId,
			status: event.isError ? "failed" : "completed",
		};
		if (event.isError) {
			// The error goes through the same bound as a success, so a failure cannot
			// bypass the ceiling. `null` survives as `null`.
			update.rawOutput = { error: boundedToolOutputText(event.result) };
		} else if (event.result !== undefined && event.result !== null) {
			// A completed call reports what it produced. Sending the outcome only
			// on failure leaves the client unable to show what a successful tool
			// did, which is the case it most needs to render.
			update.content = [toolOutputContent(event.result)];
		}
		return update;
	}
	return null;
}

export function toSessionNotification(sessionId: string, event: AgentSessionEvent): SessionNotificationParams | null {
	const update = mapAssistantEventToSessionUpdate(event);
	if (!update) return null;
	return { sessionId, update };
}

/**
 * The error message of the turn that just finished, or undefined if it did not
 * fail.
 *
 * `session.prompt()` resolves even when the model call fails: the failure is
 * recorded on the assistant message instead of being thrown. ACP v1 has no
 * error stop reason (its `StopReason` covers end_turn, max_tokens,
 * max_turn_requests, refusal and cancelled), so the JSON-RPC error channel is
 * the only place a client can learn that its turn produced nothing. Reporting
 * `end_turn` instead would tell the client the agent answered when it did not.
 *
 * Only the last assistant message is inspected: an older failed turn must not
 * be replayed onto a later successful one.
 */
export function extractTurnError(messages: readonly AgentMessage[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		if (message.stopReason !== "error") return undefined;
		return message.errorMessage ?? "The turn ended with an error.";
	}
	return undefined;
}

/** Map the engine's truncated final response to the ACP stop reason. */
export function extractTurnStopReason(messages: readonly AgentMessage[]): "max_tokens" | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		return message.stopReason === "length" ? "max_tokens" : undefined;
	}
	return undefined;
}

function stringifyToolOutput(value: unknown): unknown {
	if (value === undefined || value === null) return null;
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

function buildToolTitle(name: string, input: unknown): string {
	if (!name) return "tool";
	if (!isRecord(input)) return name;
	const target = input.path ?? input.file ?? input.filePath ?? input.command ?? input.query ?? input.url;
	if (typeof target === "string" && target.length > 0 && target.length <= 120) {
		return `${name} ${target}`;
	}
	return name;
}

/**
 * Render a tool result as bounded text.
 *
 * Every path that puts a result on the wire goes through here, including the
 * failure path: an error carries whatever the tool printed before it gave up,
 * so an unbounded one floods the client exactly like a success does.
 *
 * A missing result stays `null` rather than becoming the string "null": an
 * error with nothing attached carries no text, and inventing a word for it
 * would show the client something the tool never produced.
 */
function boundedToolOutputText(result: unknown): string | null {
	const text = stringifyToolOutput(result);
	return text === null ? null : boundString(String(text));
}

/**
 * Wrap a tool result as one ACP content block, truncated to the ceiling.
 *
 * ACP v1 content blocks are text, image or audio, and a tool result here is
 * whatever the tool returned, so it is rendered as text rather than typed. A
 * result that is already text is passed through unchanged. Callers only reach
 * this with a real result, so the `null` case collapses to empty text here.
 */
function toolOutputContent(result: unknown): ToolCallContent {
	return { type: "content", content: { type: "text", text: boundedToolOutputText(result) ?? "" } };
}

/**
 * How deep tool arguments are walked before the rest is left alone.
 *
 * Arguments arrive as model-generated JSON, so the walk is bounded rather than
 * trusted: past this depth the value is replaced by a note instead of recursed
 * into, which keeps a pathological payload from exhausting the stack.
 */
const MAX_TOOL_INPUT_DEPTH = 32;

/**
 * Key names whose values are credentials rather than call data.
 *
 * Matched as a substring of the lowercased key, which is why the list stays
 * short and specific: a bare "key" or "auth" would also catch ordinary fields
 * like a jq expression over a `key` column.
 */
const CREDENTIAL_KEY_PARTS: readonly string[] = [
	"token",
	"secret",
	"password",
	"passwd",
	"passphrase",
	"passcode",
	"credential",
	"api_key",
	"apikey",
	"authorization",
	"bearer",
	"private_key",
	"access_key",
	"cookie",
];

/**
 * Redact credential-shaped keys and bound oversized strings in tool arguments.
 *
 * `rawInput` goes straight to the client, and a `write` puts the entire file
 * in `content`, so the same ceiling that bounds a result has to bound the
 * arguments. Strings are cut in place rather than the whole payload being
 * serialized and cut, so the client still sees the shape of the call.
 *
 * Redaction is key-based on purpose. The shared `redactSecretString` scans
 * values, and measured against realistic arguments it cuts
 * `git commit -m "token: fix the parser"` and `const password = prompt(...)`,
 * so it would show the client an argument the agent never sent. Tool arguments
 * are structured data with named fields, which is exactly the case key matching
 * handles without collateral damage.
 */
function sanitizeToolInput(input: unknown, depth = 0): unknown {
	if (typeof input === "string") return boundString(input);
	if (depth >= MAX_TOOL_INPUT_DEPTH) return "[nested too deep to display]";
	if (Array.isArray(input)) return input.map((item) => sanitizeToolInput(item, depth + 1));
	if (!isRecord(input)) return input;
	const sanitized: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		const lowered = key.toLowerCase();
		if (CREDENTIAL_KEY_PARTS.some((part) => lowered.includes(part))) {
			sanitized[key] = "[redacted]";
			continue;
		}
		sanitized[key] = sanitizeToolInput(value, depth + 1);
	}
	return sanitized;
}

/** Bound the aggregate too, so many small fields cannot bypass the limit. */
function boundToolInput(input: unknown): unknown {
	const sanitized = sanitizeToolInput(input);
	if (typeof sanitized === "string") return sanitized;
	const serialized = JSON.stringify(sanitized);
	return serialized !== undefined && serialized.length > TOOL_INPUT_AGGREGATE_CHAR_LIMIT
		? boundString(serialized)
		: sanitized;
}

/**
 * Cut at a code-point boundary rather than a UTF-16 one.
 *
 * `slice` counts code units, so a cut can land between the halves of a
 * surrogate pair and leave a lone high surrogate, which serializes as an
 * unpaired escape and renders as a replacement character. Dropping the half is
 * the honest option: the pair cannot be split, and inventing the other half
 * would show a character the tool never produced.
 */
function cutAtBoundary(value: string, limit: number): string {
	const cut = value.slice(0, limit);
	const last = cut.charCodeAt(cut.length - 1);
	const next = value.charCodeAt(limit);
	const splitsPair = last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
	return splitsPair ? cut.slice(0, -1) : cut;
}

function boundString(value: string): string {
	if (value.length <= TOOL_CALL_CHAR_LIMIT) return value;
	return `${cutAtBoundary(value, TOOL_CALL_CHAR_LIMIT)}\n${truncationNotice(value.length)}`;
}

function mapToolKind(name: string): string {
	switch (name) {
		case "bash":
			return "execute";
		case "read":
			return "read";
		case "write":
			return "edit";
		case "edit":
			return "edit";
		case "glob":
			return "search";
		case "grep":
			return "search";
		case "web_search":
			return "fetch";
		case "web_fetch":
			return "fetch";
		default:
			return "other";
	}
}

/**
 * Shared shape for the four terminal methods that take only a terminal id.
 *
 * `sessionId` is required by the protocol but is not trusted here: the registry
 * re-derives the session from the live mode, so a client naming someone else's
 * session is rejected there rather than by a string comparison that could drift.
 */
function validateTerminalIdParams(
	params: unknown,
	label: string,
): { ok: true; value: { sessionId: string; terminalId: string } } | { ok: false; message: string } {
	if (!isRecord(params)) {
		return { ok: false, message: `${label} params must be an object` };
	}
	if (typeof params.sessionId !== "string" || !params.sessionId) {
		return { ok: false, message: "sessionId is required" };
	}
	if (typeof params.terminalId !== "string" || !params.terminalId) {
		return { ok: false, message: "terminalId is required" };
	}
	return { ok: true, value: { sessionId: params.sessionId, terminalId: params.terminalId } };
}

export function validateReadTextFileParams(
	params: unknown,
): { ok: true; value: ReadTextFileParams } | { ok: false; message: string } {
	if (!isRecord(params)) {
		return { ok: false, message: "Read params must be an object" };
	}
	if (typeof params.sessionId !== "string" || !params.sessionId) {
		return { ok: false, message: "sessionId is required" };
	}
	if (typeof params.path !== "string" || !params.path) {
		return { ok: false, message: "path is required" };
	}
	const line = typeof params.line === "number" && Number.isFinite(params.line) ? params.line : undefined;
	const limit = typeof params.limit === "number" && Number.isFinite(params.limit) ? params.limit : undefined;
	return {
		ok: true,
		value: {
			sessionId: params.sessionId,
			path: params.path,
			...(line === undefined ? {} : { line }),
			...(limit === undefined ? {} : { limit }),
		},
	};
}

export function validateWriteTextFileParams(
	params: unknown,
): { ok: true; value: WriteTextFileParams } | { ok: false; message: string } {
	if (!isRecord(params)) {
		return { ok: false, message: "Write params must be an object" };
	}
	if (typeof params.sessionId !== "string" || !params.sessionId) {
		return { ok: false, message: "sessionId is required" };
	}
	if (typeof params.path !== "string" || !params.path) {
		return { ok: false, message: "path is required" };
	}
	if (typeof params.content !== "string") {
		return { ok: false, message: "content must be a string" };
	}
	return { ok: true, value: { sessionId: params.sessionId, path: params.path, content: params.content } };
}

export function validateTerminalCreateParams(
	params: unknown,
): { ok: true; value: TerminalCreateParams } | { ok: false; message: string } {
	if (!isRecord(params)) {
		return { ok: false, message: "Terminal create params must be an object" };
	}
	if (typeof params.sessionId !== "string" || !params.sessionId) {
		return { ok: false, message: "sessionId is required" };
	}
	if (typeof params.command !== "string" || !params.command) {
		return { ok: false, message: "command is required" };
	}
	const args = Array.isArray(params.args)
		? params.args.filter((arg): arg is string => typeof arg === "string")
		: undefined;
	const env = Array.isArray(params.env)
		? params.env
				.filter(
					(entry): entry is { name: string; value: string } =>
						isRecord(entry) && typeof entry.name === "string" && typeof entry.value === "string",
				)
				.map((entry) => ({ name: entry.name, value: entry.value }))
		: undefined;
	const cwd = typeof params.cwd === "string" && params.cwd ? params.cwd : undefined;
	const outputByteLimit =
		typeof params.outputByteLimit === "number" && Number.isFinite(params.outputByteLimit)
			? params.outputByteLimit
			: undefined;
	return {
		ok: true,
		value: {
			sessionId: params.sessionId,
			command: params.command,
			...(args === undefined ? {} : { args }),
			...(env === undefined ? {} : { env }),
			...(cwd === undefined ? {} : { cwd }),
			...(outputByteLimit === undefined ? {} : { outputByteLimit }),
		},
	};
}

export function validateTerminalOutputParams(
	params: unknown,
): { ok: true; value: TerminalOutputParams } | { ok: false; message: string } {
	return validateTerminalIdParams(params, "Terminal output");
}

export function validateTerminalWaitForExitParams(
	params: unknown,
): { ok: true; value: TerminalWaitForExitParams } | { ok: false; message: string } {
	return validateTerminalIdParams(params, "Terminal wait");
}

export function validateTerminalReleaseParams(
	params: unknown,
): { ok: true; value: TerminalReleaseParams } | { ok: false; message: string } {
	return validateTerminalIdParams(params, "Terminal release");
}

export function validateTerminalKillParams(
	params: unknown,
): { ok: true; value: TerminalKillParams } | { ok: false; message: string } {
	return validateTerminalIdParams(params, "Terminal kill");
}

export function validateForkSessionParams(
	params: unknown,
): { ok: true; value: ForkSessionParams } | { ok: false; message: string } {
	if (!isRecord(params)) {
		return { ok: false, message: "Fork params must be an object" };
	}
	if (typeof params.sessionId !== "string" || !params.sessionId) {
		return { ok: false, message: "sessionId is required" };
	}
	if (typeof params.cwd !== "string" || !params.cwd) {
		return { ok: false, message: "cwd is required" };
	}
	// Absolute like every other session-lifecycle method: the fork is written
	// under this path and matched against the source session's stored cwd, so a
	// relative one would resolve against whatever directory the agent happens to
	// run in and fail with a message that names the wrong place.
	if (!isAbsolute(params.cwd)) {
		return { ok: false, message: "cwd must be an absolute path" };
	}
	return {
		ok: true,
		value: {
			sessionId: params.sessionId,
			cwd: params.cwd,
			...(Array.isArray(params.mcpServers) ? { mcpServers: params.mcpServers } : {}),
			...(Array.isArray(params.additionalDirectories)
				? { additionalDirectories: params.additionalDirectories }
				: {}),
		},
	};
}

export function validateSetSessionModelParams(
	params: unknown,
): { ok: true; value: SetSessionModelParams } | { ok: false; message: string } {
	if (!isRecord(params)) {
		return { ok: false, message: "Set model params must be an object" };
	}
	if (typeof params.sessionId !== "string" || !params.sessionId) {
		return { ok: false, message: "sessionId is required" };
	}
	if (typeof params.modelId !== "string" || !params.modelId) {
		return { ok: false, message: "modelId is required" };
	}
	return { ok: true, value: { sessionId: params.sessionId, modelId: params.modelId } };
}
