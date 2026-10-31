/** Minimal ACP v1 wire types used by the native stdio mode. */

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
	jsonrpc?: "2.0";
	id?: JsonRpcId;
	method: string;
	params?: unknown;
}

export interface JsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: JsonRpcId | null;
	result?: unknown;
	error?: JsonRpcError;
}

export interface JsonRpcResponseObject {
	jsonrpc?: "2.0";
	id: JsonRpcId | null;
	result?: unknown;
	error?: JsonRpcError;
}

export interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

export interface TextContentBlock {
	type: "text";
	text: string;
}

export interface ImageContentBlock {
	type: "image";
	data: string;
	mimeType: string;
}

export interface ResourceLinkContentBlock {
	type: "resource_link";
	name: string;
	uri: string;
}

/**
 * A resource embedded whole in a prompt. `text` carries a text resource and
 * `blob` a base64 binary one; ACP calls these "embedded context".
 */
export interface ResourceContentBlock {
	type: "resource";
	resource: { uri: string; mimeType?: string; text?: string; blob?: string };
}

export type ContentBlock = TextContentBlock | ImageContentBlock | ResourceLinkContentBlock | ResourceContentBlock;

export interface InitializeParams {
	protocolVersion: number;
	clientCapabilities?: {
		fs?: { readTextFile?: boolean; writeTextFile?: boolean };
		terminal?: boolean;
		auth?: { terminal?: boolean };
		/** Which elicitation modes the client can render. */
		elicitation?: { form?: Record<string, unknown> | null; url?: Record<string, unknown> | null };
	};
	clientInfo?: { name: string; version: string; title?: string };
}

/** ACP `authenticate` selects one of the `authMethods` returned by initialize. */
export interface AuthenticateParams {
	methodId: string;
}

/**
 * An authentication method advertised in the `initialize` response.
 *
 * `terminal` methods are run by the client itself as a separate interactive
 * process; the spec forbids passing them to `authenticate`. Agent methods are
 * handled here, inside `authenticate`.
 */
export type AuthMethod =
	| { id: string; name: string; description?: string; type?: "agent" }
	| {
			id: string;
			name: string;
			description?: string;
			type: "terminal";
			args?: string[];
			env?: Record<string, string>;
	  };

/**
 * ACP `elicitation/create` asks the user something with a fixed schema.
 *
 * Only the `form` mode is implemented: the client renders a form from
 * `requestedSchema`. URL-based elicitation needs a client that can open a
 * browser and report completion, which the baseline does not assume.
 */
export interface ElicitationCreateParams {
	sessionId: string;
	mode: "form";
	prompt: string;
	requestedSchema: {
		type: "object";
		properties: Record<string, unknown>;
		required?: string[];
		title?: string;
		description?: string;
	};
	_meta?: Record<string, unknown>;
}

export type ElicitationAction = "accept" | "decline" | "cancel";

export interface ElicitationResult {
	action: ElicitationAction;
	/** Present only for `accept`. Keys come from `requestedSchema.properties`. */
	content?: Record<string, unknown>;
	_meta?: Record<string, unknown>;
}

export interface NewSessionParams {
	cwd: string;
	mcpServers: unknown[];
	additionalDirectories?: string[];
}

export interface LoadSessionParams {
	sessionId: string;
	cwd: string;
	mcpServers: unknown[];
	additionalDirectories?: string[];
}

/**
 * Resume deliberately carries no replay switch.
 *
 * The protocol splits the two: `session/load` MUST replay the conversation and
 * `session/resume` MUST NOT, so there is nothing here for a client to ask for.
 */
export interface ResumeSessionParams {
	sessionId: string;
	cwd: string;
	mcpServers?: unknown[];
	/** Normalized by the wire validator, which always fills it (empty when absent). */
	additionalDirectories: string[];
}

export interface ListSessionsParams {
	cwd?: string;
	cursor?: string;
}

export interface ListSessionsResult {
	sessions: Array<{
		sessionId: string;
		cwd: string;
		title?: string;
		updatedAt?: string;
		_meta?: Record<string, unknown>;
	}>;
	nextCursor?: string;
}

export interface DeleteSessionParams {
	sessionId: string;
}

export interface CloseSessionParams {
	sessionId: string;
}

export interface SetSessionModeParams {
	sessionId: string;
	modeId: string;
}

/** A mode the agent can operate in, and the one currently active. */
export interface SessionMode {
	id: string;
	name: string;
	description?: string;
}

export interface SessionModeState {
	currentModeId: string;
	availableModes: SessionMode[];
}

/**
 * A single-value selector configuration option. Booleans are part of the ACP
 * union; Step exposes only selectors today, so the union is modelled as one
 * optional shape rather than a variant this mode cannot produce.
 */
export interface SessionConfigOption {
	id: string;
	name: string;
	description?: string;
	category?: string;
	type: "select";
	currentValue: string;
	options: Array<{ value: string; name: string; description?: string }>;
}

export interface SetSessionConfigOptionParams {
	sessionId: string;
	optionId: string;
	/** Absent means the payload is a `SessionConfigValueId` string. */
	type?: "boolean";
	value: string | boolean;
}

export interface PromptParams {
	sessionId: string;
	prompt: ContentBlock[];
}

/**
 * ACP `session/fork`.
 *
 * Not part of the v1 schema: the method set is fixed at the twelve listed in
 * this file, and fork is an extension other agents carry. It is implemented
 * because clients that talk to those agents send it, and the response mirrors
 * `session/new` because there is no spec shape to follow.
 */
export interface ForkSessionParams {
	sessionId: string;
	cwd: string;
	mcpServers?: unknown[];
	additionalDirectories?: string[];
}

/**
 * ACP `session/set_model`, also outside the v1 schema. It is the model half of
 * `session/set_config_option`, carried over from the older unstable surface, so
 * it is accepted as an alias rather than as a second selector.
 */
export interface SetSessionModelParams {
	sessionId: string;
	modelId: string;
}

/** Client-side file read. The spec names the result field `content`. */
export interface ReadTextFileParams {
	sessionId: string;
	path: string;
	line?: number;
	limit?: number;
}

export interface ReadTextFileResult {
	content: string;
}

/** Client-side file write. The client creates the file when it is missing. */
export interface WriteTextFileParams {
	sessionId: string;
	path: string;
	content: string;
}

export interface TerminalEnvVariable {
	name: string;
	value: string;
}

/**
 * `terminal/create` takes a program plus arguments, not a shell string.
 *
 * The agent's own command pipeline is a shell string, which is why the terminal
 * surface is a forwarding layer rather than the bash tool's execution path: see
 * the note on `ClientTerminalRegistry`.
 */
export interface TerminalCreateParams {
	sessionId: string;
	command: string;
	args?: string[];
	env?: TerminalEnvVariable[];
	cwd?: string;
	outputByteLimit?: number;
}

export interface TerminalCreateResult {
	terminalId: string;
}

export interface TerminalExitStatus {
	exitCode?: number | null;
	signal?: string | null;
}

export interface TerminalOutputParams {
	sessionId: string;
	terminalId: string;
}

export interface TerminalOutputResult {
	output: string;
	truncated: boolean;
	exitStatus?: TerminalExitStatus;
}

/**
 * `terminal/wait_for_exit` resolves once the command exits. Both fields are
 * optional because a process killed by a signal has no exit code.
 */
export interface TerminalWaitForExitParams {
	sessionId: string;
	terminalId: string;
}

export interface TerminalWaitForExitResult {
	exitCode?: number | null;
	signal?: string | null;
}

export interface TerminalReleaseParams {
	sessionId: string;
	terminalId: string;
}

export interface TerminalKillParams {
	sessionId: string;
	terminalId: string;
}

export interface SessionUpdateTextChunk {
	sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk";
	content: ContentBlock;
}

/** One entry in a `tool_call` or `tool_call_update` content array. */
export interface ToolCallContent {
	type: "content";
	content: ContentBlock;
}

export interface SessionUpdateToolCall {
	sessionUpdate: "tool_call";
	toolCallId: string;
	title: string;
	name?: string | null;
	kind?: string;
	status?: "pending" | "in_progress" | "completed" | "failed";
	content?: ToolCallContent[];
	rawInput?: unknown;
}

export interface SessionUpdateToolCallUpdate {
	sessionUpdate: "tool_call_update";
	toolCallId: string;
	title?: string | null;
	status?: "pending" | "in_progress" | "completed" | "failed";
	content?: ToolCallContent[] | null;
	rawInput?: unknown;
	rawOutput?: unknown;
}

export type SessionUpdate = SessionUpdateTextChunk | SessionUpdateToolCall | SessionUpdateToolCallUpdate;

export interface SessionNotificationParams {
	sessionId: string;
	update: SessionUpdate;
}

export interface RequestPermissionParams {
	sessionId: string;
	toolCall: {
		toolCallId: string;
		title: string;
		status?: "pending" | "in_progress" | "completed" | "failed";
		content?: unknown[];
	};
	options: Array<{ optionId: string; name: string; kind: string }>;
}

export type RequestPermissionResult =
	| { outcome: { outcome: "cancelled" } }
	| { outcome: { outcome: "selected"; optionId: string } };

export const ACP_PROTOCOL_VERSION = 1;

/**
 * ACP reuses the JSON-RPC reserved range for its own codes. `authRequired` and
 * `resourceNotFound` come from the protocol's `ErrorCode` union; a client that
 * receives them is expected to run the matching recovery flow rather than retry.
 */
export const ACP_JSON_RPC_ERRORS = {
	parse: -32700,
	invalidRequest: -32600,
	methodNotFound: -32601,
	invalidParams: -32602,
	internal: -32603,
	authRequired: -32000,
	resourceNotFound: -32001,
	notInitialized: -32002,
	unavailable: -32003,
	requestCancelled: -32800,
} as const;
