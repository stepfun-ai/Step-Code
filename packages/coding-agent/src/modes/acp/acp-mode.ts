/**
 * ACP mode: native stdio JSON-RPC for Agent Client Protocol v1.
 *
 * This mode exposes the baseline ACP client surface over newline-delimited
 * JSON-RPC 2.0 on stdin/stdout. It reuses the same `AgentSessionRuntimeHost`
 * as the interactive TUI and RPC mode, so session persistence, extensions,
 * compaction, and tool execution behave identically. Only the wire format is
 * different.
 *
 * Supported client-to-agent methods:
 * - `initialize`, `authenticate`, `logout`
 * - `session/new`, `session/load`, `session/resume`, `session/list`,
 *   `session/delete`, `session/close`
 * - `session/prompt`, `session/cancel`
 * - `session/set_mode`, `session/set_config_option`
 *
 * Agent-to-client traffic uses `session/update` notifications,
 * `session/request_permission` requests for tool approval, and
 * `elicitation/create` requests when an extension needs free-form input.
 *
 * The client-side surfaces work in opposite directions. `fs/*` is bridged into
 * this mode's file tools, because the client's read is a superset of a local one
 * (it sees unsaved editor state) and its writes let the client track what the
 * agent changed. `terminal/*` is forwarded but not wired into the bash tool,
 * because ACP takes a program plus arguments where the agent's pipeline is a
 * shell string, and re-routing every command through a client shell is a product
 * decision rather than a protocol detail. See docs/acp.md.
 */

import * as crypto from "node:crypto";
import { unlink } from "node:fs/promises";
import type { AssistantMessage, Model } from "@step-harness/providers";
import { VERSION } from "../../config.ts";
import type { AgentSessionEvent } from "../../core/agent-session.ts";
import type { AgentSessionRuntimeHost } from "../../core/agent-session-runtime.ts";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.ts";
import {
	flushRawStdout,
	takeOverStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../../core/output-guard.ts";
import { loadEntriesFromFile, type SessionEntry, SessionManager } from "../../core/session-manager.ts";
import { setClientFileSystemBridge } from "../../core/tools/client-fs.ts";
import { type ClientTerminalHost, setClientTerminalHost } from "../../core/tools/client-terminal.ts";
import { STEP_PROVIDER_ID } from "../../features/step-provider/index.ts";
import { getStepAuthPath, logoutStepCredentials } from "../../step/auth.ts";
import { readStepLoginCredential, writeStepLoginCredential } from "../../step/login-flow.ts";
import { clearStepLoginState } from "../../step/login-state.ts";
import { getHostMcpServerOverlay, setHostMcpServerOverlay } from "../../step/mcp.ts";
import { resolveStepLoginProfiles } from "../../step/onboarding.ts";
import { getStepPermissionPreset, STEP_PERMISSION_PRESETS } from "../../step/permissions.ts";
import { type Theme, theme } from "../../theme/theme.ts";
import { resolvePath } from "../../utils/paths.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { attachJsonlLineReader } from "../rpc/jsonl.ts";
import type {
	AuthMethod,
	CloseSessionParams,
	ElicitationCreateParams,
	ElicitationResult,
	ForkSessionParams,
	JsonRpcId,
	JsonRpcRequest,
	JsonRpcResponseObject,
	ListSessionsParams,
	PromptParams,
	ReadTextFileResult,
	RequestPermissionResult,
	ResumeSessionParams,
	SessionConfigOption,
	SessionModeState,
	SessionNotificationParams,
	SessionUpdate,
	SetSessionConfigOptionParams,
	SetSessionModelParams,
	SetSessionModeParams,
} from "./acp-types.ts";
import { ACP_JSON_RPC_ERRORS, ACP_PROTOCOL_VERSION } from "./acp-types.ts";
import {
	convertAcpMcpServers,
	createErrorResponse,
	createNotification,
	createResponse,
	extractTurnError,
	extractTurnStopReason,
	normalizePrompt,
	parseElicitationResult,
	parseJsonRpcLine,
	parseRequestPermissionResult,
	serializeJsonLine,
	toAcpSessionListEntries,
	toSessionNotification,
	validateAuthenticateParams,
	validateCloseSessionParams,
	validateDeleteSessionParams,
	validateForkSessionParams,
	validateInitializeParams,
	validateListSessionsParams,
	validateLoadSessionParams,
	validateNewSessionParams,
	validatePromptParams,
	validateResumeSessionParams,
	validateSetSessionConfigOptionParams,
	validateSetSessionModelParams,
	validateSetSessionModeParams,
} from "./acp-wire.ts";
import { ClientTerminalRegistry } from "./client-terminal.ts";

const PERMISSION_ALLOW_OPTION_ID = "allow_once";
const PERMISSION_ALLOW_ALWAYS_OPTION_ID = "allow_always";
const PERMISSION_REJECT_OPTION_ID = "reject_once";
const PERMISSION_REJECT_ALWAYS_OPTION_ID = "reject_always";

/** Status key the step extension uses to publish the active permission tier. */
const PERMISSION_STATUS_KEY = "step-permission";

/** Prefix of that status text; the remainder is the preset label. */
const PERMISSION_STATUS_PREFIX = "Mode: ";

/** Auth method the client runs itself as an interactive `step login`. */
const STEP_TERMINAL_AUTH_METHOD_ID = "step_login";

/** Auth method this agent completes through `elicitation/create`. */
const STEP_API_KEY_AUTH_METHOD_ID = "step_api_key";

/** A JSON-RPC error returned by the client, preserved so fallback policy can inspect its code. */
class AcpClientRequestError extends Error {
	readonly code: number;

	constructor(code: number, message: string) {
		super(message);
		this.name = "AcpClientRequestError";
		this.code = code;
	}
}

export async function runAcpMode(runtimeHost: AgentSessionRuntimeHost): Promise<never> {
	takeOverStdout();
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeBackpressure: (() => void) | undefined;

	let initialized = false;
	let shuttingDown = false;
	let sessionClosing = false;
	/**
	 * Read from `initialize`. A client that does not advertise form elicitation
	 * keeps the allow/reject fallback for `select()` and gets no `input()`.
	 */
	let clientSupportsFormElicitation = false;
	/** Whether the client can run `step login` in its own terminal. */
	let clientSupportsTerminalAuth = false;
	/**
	 * Which directions of the client's filesystem the client offered.
	 *
	 * ACP gates read and write independently, so a client that offers only one
	 * gets a bridge with only that direction; the other stays local rather than
	 * failing.
	 */
	let clientSupportsFsRead = false;
	let clientSupportsFsWrite = false;
	/** Whether the client can host terminals this agent asks it to create. */
	let clientSupportsTerminal = false;
	/** Terminals handed out by `terminal/create`, released on switch and exit. */
	let terminalRegistry: ClientTerminalRegistry | undefined;
	/**
	 * Last permission label the step extension published through `setStatus`.
	 * The extension owns the policy, so this mode reports what it published
	 * rather than keeping a second copy that could drift.
	 */
	let publishedPermissionLabel: string | undefined;
	let detachInput = () => {};
	const signalCleanupHandlers: Array<() => void> = [];

	/** Sessions returned per `session/list` page; a client that wants them all follows `nextCursor`. */
	const SESSION_LIST_PAGE_SIZE = 100;

	const activePromptIds = new Set<JsonRpcId>();
	const cancelledPromptIds = new Set<JsonRpcId>();
	/**
	 * Error message of the turn currently in flight, if it failed.
	 *
	 * Set from `agent_end`, because a failed model call does not reject
	 * `session.prompt()`; it is recorded on the assistant message. The engine
	 * allows one turn at a time per session (a prompt sent while streaming is
	 * rejected or queued), so one slot is enough.
	 */
	let inFlightTurnError: string | undefined;
	/** ACP stop reason derived from the final assistant message, if it was truncated. */
	let inFlightStopReason: "max_tokens" | undefined;

	/**
	 * Every request this agent sends to the client, permission or elicitation.
	 *
	 * Both kinds block a turn until the client answers, both are answered through
	 * the same `handleClientResponse` path, and both must be settled on shutdown
	 * so a pending turn is never left hanging. They differ only in how the
	 * response is parsed, which is the caller's job.
	 */
	const pendingClientRequests = new Map<
		string,
		{ resolve: (result: unknown) => void; reject: (error: AcpClientRequestError) => void }
	>();

	/**
	 * Send one request to the client and wait for its response.
	 *
	 * There is no timeout on purpose: a permission dialog or a form may sit open
	 * for as long as the user needs. `shutdown` settles everything still pending,
	 * which is the only way this promise is abandoned.
	 */
	const requestFromClient = (method: string, params: unknown): Promise<unknown> => {
		const requestId = crypto.randomUUID();
		return new Promise<unknown>((resolve, reject) => {
			pendingClientRequests.set(requestId, { resolve, reject });
			output({ jsonrpc: "2.0", id: requestId, method, params });
		});
	};

	/** Settle a pending client request, whether the client answered or gave up. */
	const settleClientRequest = (requestId: string, result: unknown): void => {
		const pending = pendingClientRequests.get(requestId);
		if (!pending) return;
		pendingClientRequests.delete(requestId);
		pending.resolve(result);
	};

	/** Preserve a client's JSON-RPC failure instead of flattening every failure into a cancellation. */
	const rejectClientRequest = (requestId: string, error: AcpClientRequestError): void => {
		const pending = pendingClientRequests.get(requestId);
		if (!pending) return;
		pendingClientRequests.delete(requestId);
		pending.reject(error);
	};

	/**
	 * Terminals this agent asked the client to create.
	 *
	 * Created here rather than per session because the registry is a forwarder:
	 * it holds no process, only which ids were handed out and to which session.
	 */
	terminalRegistry = new ClientTerminalRegistry(requestFromClient, () => session.sessionId);

	/**
	 * Install the client filesystem the file tools read and write through.
	 *
	 * Only the directions the client advertised are installed. A missing method
	 * is not an error: ACP gates read and write independently, so a client that
	 * offers one keeps local behavior for the other instead of failing it.
	 *
	 * Only an explicit `methodNotFound` falls back to the local file. Any other
	 * failure propagates: silently reading the disk after a client error could
	 * replace the editor's unsaved buffer with stale content.
	 */
	const installClientFileSystemBridge = (): void => {
		if (!clientSupportsFsRead && !clientSupportsFsWrite) {
			setClientFileSystemBridge(undefined);
			return;
		}
		setClientFileSystemBridge({
			...(clientSupportsFsRead
				? {
						readTextFile: async (absolutePath: string): Promise<string> => {
							try {
								const result = (await requestFromClient("fs/read_text_file", {
									sessionId: session.sessionId,
									path: absolutePath,
								})) as ReadTextFileResult;
								if (typeof result?.content !== "string") {
									throw new Error("client returned no content");
								}
								return result.content;
							} catch (error) {
								if (
									!(error instanceof AcpClientRequestError) ||
									error.code !== ACP_JSON_RPC_ERRORS.methodNotFound
								) {
									throw error;
								}
								process.stderr.write(
									`[acp] fs/read_text_file is unavailable for ${absolutePath}, reading locally: ${error.message}
`,
								);
								const { readFile } = await import("node:fs/promises");
								return (await readFile(absolutePath)).toString("utf-8");
							}
						},
					}
				: {}),
			...(clientSupportsFsWrite
				? {
						writeTextFile: async (absolutePath: string, content: string): Promise<void> => {
							try {
								await requestFromClient("fs/write_text_file", {
									sessionId: session.sessionId,
									path: absolutePath,
									content,
								});
							} catch (error) {
								// A write has no safe local fallback: writing the same bytes
								// twice, once where the client can see it and once where it
								// cannot, is worse than one visible failure.
								process.stderr.write(`[acp] fs/write_text_file failed for ${absolutePath}: ${String(error)}
`);
								throw error;
							}
						},
					}
				: {}),
		});
	};

	/**
	 * Install the client terminal the bash tool runs commands in.
	 *
	 * Installed only when the client advertised `terminal`, so a client that did
	 * not ask for it keeps purely local execution. The registry already forwards
	 * to the client; this adapts it to the shape the tool consumes.
	 */
	const installClientTerminalHost = (): void => {
		if (!clientSupportsTerminal || terminalRegistry === undefined) {
			setClientTerminalHost(undefined);
			return;
		}
		const registry = terminalRegistry;
		const host: ClientTerminalHost = {
			create: async (params) => {
				const record = await registry.create({
					command: params.command,
					...(params.args === undefined ? {} : { args: params.args }),
					...(params.cwd === undefined ? {} : { cwd: params.cwd }),
					...(params.env === undefined
						? {}
						: { env: Object.entries(params.env).map(([name, value]) => ({ name, value })) }),
					...(params.outputByteLimit === undefined ? {} : { outputByteLimit: params.outputByteLimit }),
				});
				return { terminalId: record.terminalId };
			},
			output: (terminalId) => registry.output(terminalId),
			waitForExit: (terminalId) => registry.waitForExit(terminalId),
			kill: (terminalId) => registry.kill(terminalId),
			release: (terminalId) => registry.release(terminalId),
		};
		setClientTerminalHost(host);
	};

	/**
	 * Drop everything scoped to the session that is about to stop being active.
	 *
	 * Two kinds of state are session-scoped, and both must go on a switch:
	 *
	 * - Terminals, because a terminal belongs to the session that created it, so
	 *   a switch makes the whole set unusable. The spec makes release mandatory
	 *   once a terminal is no longer needed, and leaking them would hold the
	 *   client's terminals for the life of the client process.
	 * - The "always allow" and "always reject" answers, because ACP scopes them to
	 *   the session. Carrying an allow across a session switch would silently
	 *   approve tool calls in a session whose user never consented to them.
	 */
	const releaseSessionScopedClientState = async (): Promise<void> => {
		sessionAlwaysAllows.clear();
		sessionAlwaysRejects.clear();
		for (const promptId of activePromptIds) {
			cancelledPromptIds.add(promptId);
		}
		// A pending permission or form belongs to the outgoing session. Leaving it
		// unresolved blocks runtime teardown, which waits for the old turn to stop.
		for (const requestId of [...pendingClientRequests.keys()]) {
			settleClientRequest(requestId, undefined);
		}
		await terminalRegistry?.releaseAll();
	};

	const output = (obj: unknown) => {
		writeRawStdout(serializeJsonLine(obj));
	};

	const sendNotification = (method: string, params: unknown) => {
		output(createNotification(method, params));
	};

	const sendResponse = (id: JsonRpcId | null, result: unknown) => {
		output(createResponse(id, result));
	};

	const sendError = (id: JsonRpcId | null, code: number, message: string, data?: unknown) => {
		output(createErrorResponse(id, code, message, data));
	};

	/**
	 * Operations for which the user answered "always" in this session.
	 *
	 * The protocol remembers the choice for the operation that was presented,
	 * not a blanket decision for unrelated tools. The title and message are the
	 * complete operation description available to this UI bridge, so together
	 * they form the consent key.
	 */
	const sessionAlwaysAllows = new Set<string>();
	const sessionAlwaysRejects = new Set<string>();

	const sendPermissionRequest = async (title: string, message: string): Promise<RequestPermissionResult> => {
		const operationKey = JSON.stringify([title, message]);
		// Rejection wins if concurrent answers somehow record both decisions for
		// the same operation. A different operation still gets its own prompt.
		if (sessionAlwaysRejects.has(operationKey)) {
			return { outcome: { outcome: "selected", optionId: PERMISSION_REJECT_OPTION_ID } };
		}
		if (sessionAlwaysAllows.has(operationKey)) {
			return { outcome: { outcome: "selected", optionId: PERMISSION_ALLOW_OPTION_ID } };
		}
		let response: unknown;
		try {
			response = await requestFromClient("session/request_permission", {
				sessionId: session.sessionId,
				toolCall: {
					toolCallId: crypto.randomUUID(),
					title,
					status: "pending",
					content: [{ type: "content", content: { type: "text", text: message } }],
				},
				options: [
					{ optionId: PERMISSION_ALLOW_OPTION_ID, name: "Allow once", kind: "allow_once" },
					{ optionId: PERMISSION_ALLOW_ALWAYS_OPTION_ID, name: "Allow for this session", kind: "allow_always" },
					{ optionId: PERMISSION_REJECT_OPTION_ID, name: "Reject once", kind: "reject_once" },
					{ optionId: PERMISSION_REJECT_ALWAYS_OPTION_ID, name: "Reject for this session", kind: "reject_always" },
				],
			});
		} catch {
			// A failed approval request never grants permission.
			response = undefined;
		}
		// A response that does not parse is a client that answered something else;
		// treating it as a cancellation is the safe reading for an approval.
		const result = parseRequestPermissionResult(response) ?? { outcome: { outcome: "cancelled" } };
		if (result.outcome.outcome === "selected") {
			if (result.outcome.optionId === PERMISSION_ALLOW_ALWAYS_OPTION_ID) sessionAlwaysAllows.add(operationKey);
			if (result.outcome.optionId === PERMISSION_REJECT_ALWAYS_OPTION_ID) sessionAlwaysRejects.add(operationKey);
		}
		return result;
	};

	const isPermissionAllowed = (result: RequestPermissionResult): boolean => {
		if (result.outcome.outcome !== "selected") return false;
		return (
			result.outcome.optionId === PERMISSION_ALLOW_OPTION_ID ||
			result.outcome.optionId === PERMISSION_ALLOW_ALWAYS_OPTION_ID
		);
	};

	/**
	 * Ask the user for structured input through `elicitation/create`.
	 *
	 * Only the form mode is used. A client that declines or cancels, or that
	 * answers with a payload this mode cannot read, yields `undefined` so the
	 * caller behaves exactly as it does for a dismissed dialog.
	 */
	const elicitForm = async (input: {
		prompt: string;
		properties: Record<string, unknown>;
		required?: string[];
	}): Promise<Record<string, unknown> | undefined> => {
		const params: ElicitationCreateParams = {
			sessionId: session.sessionId,
			mode: "form",
			prompt: input.prompt,
			requestedSchema: {
				type: "object",
				properties: input.properties,
				...(input.required === undefined ? {} : { required: input.required }),
			},
		};
		let response: unknown;
		try {
			response = await requestFromClient("elicitation/create", params);
		} catch {
			// A failed form request is equivalent to dismissing the dialog.
			response = undefined;
		}
		const result: ElicitationResult | undefined = parseElicitationResult(response);
		if (!result || result.action !== "accept") return undefined;
		return result.content ?? {};
	};

	/** Create an extension UI context backed by ACP permission requests. */
	const createExtensionUIContext = (): ExtensionUIContext => {
		const requestApproval = async (
			opts: ExtensionUIDialogOptions | undefined,
			title: string,
			message: string,
		): Promise<boolean> => {
			if (opts?.signal?.aborted) return false;
			return isPermissionAllowed(await sendPermissionRequest(title, message));
		};

		/**
		 * Offer a fixed set of choices.
		 *
		 * With form elicitation the user picks the real option, so `select()`
		 * stops guessing which entry was chosen. Without it the only surface ACP
		 * guarantees is a yes/no approval, which cannot name an option, so the
		 * fallback returns the first entry when approved and says so below.
		 */
		const selectWithElicitation = async (
			title: string,
			options: string[],
			opts: ExtensionUIDialogOptions | undefined,
		): Promise<string | undefined> => {
			if (opts?.signal?.aborted || options.length === 0) return undefined;
			const content = await elicitForm({
				prompt: title,
				properties: { choice: { type: "string", title, enum: options } },
				required: ["choice"],
			});
			const choice = content?.choice;
			return typeof choice === "string" && options.includes(choice) ? choice : undefined;
		};

		return {
			select: (title, options, opts) =>
				clientSupportsFormElicitation
					? selectWithElicitation(title, options, opts)
					: requestApproval(opts, title, options.join("\n")).then((approved) =>
							approved ? options[0] : undefined,
						),

			confirm: (title, message, opts) => requestApproval(opts, title, message),

			// Free-form text needs elicitation; without it there is no honest
			// answer, so the dialog resolves as dismissed.
			input: (title, _placeholder, opts) => {
				if (!clientSupportsFormElicitation || opts?.signal?.aborted) {
					return Promise.resolve(undefined);
				}
				return elicitForm({
					prompt: title,
					properties: { value: { type: "string", title } },
					required: ["value"],
				}).then((content) => {
					const value = content?.value;
					return typeof value === "string" ? value : undefined;
				});
			},

			notify(message: string, type?: "info" | "warning" | "error"): void {
				process.stderr.write(`[acp ${type ?? "info"}] ${message}\n`);
			},

			onTerminalInput(): () => void {
				return () => {};
			},

			setStatus(key: string, text: string | undefined): void {
				// The step extension publishes the permission tier here; keeping the
				// last label lets session/set_mode report the mode actually in force,
				// including one changed mid-session.
				if (key === PERMISSION_STATUS_KEY) {
					publishedPermissionLabel = text;
				}
			},

			setWorkingMessage(_message?: string): void {},

			setWorkingVisible(_visible: boolean): void {},

			setWorkingIndicator(_options?: WorkingIndicatorOptions): void {},

			setHiddenThinkingLabel(_label?: string): void {},

			setWidget(_key: string, _content: unknown, _options?: ExtensionWidgetOptions): void {},

			setFooter(_factory: unknown): void {},

			setHeader(_factory: unknown): void {},

			setTitle(title: string): void {
				process.stderr.write(`[acp title] ${title}\n`);
			},

			async custom() {
				return undefined as never;
			},

			pasteToEditor(text: string): void {
				this.setEditorText(text);
			},

			setEditorText(_text: string): void {},

			getEditorText(): string {
				return "";
			},

			async editor(): Promise<string | undefined> {
				return undefined;
			},

			addAutocompleteProvider(): void {},

			setEditorComponent(): void {},

			getEditorComponent() {
				return undefined;
			},

			get theme() {
				return theme;
			},

			getAllThemes() {
				return [];
			},

			getTheme(_name: string) {
				return undefined;
			},

			setTheme(_theme: string | Theme) {
				return { success: false, error: "Theme switching not supported in ACP mode" };
			},

			getToolsExpanded() {
				return false;
			},

			setToolsExpanded(_expanded: boolean): void {},
		};
	};

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	const rebindSession = async (): Promise<void> => {
		const nextSession = runtimeHost.session;
		unsubscribe?.();
		unsubscribeBackpressure?.();
		session = nextSession;
		unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			if (!initialized) return;
			if (event.type === "agent_end") {
				inFlightTurnError = extractTurnError(event.messages);
				inFlightStopReason = extractTurnStopReason(event.messages);
			}
			const notification: SessionNotificationParams | null = toSessionNotification(session.sessionId, event);
			if (notification) {
				sendNotification("session/update", notification);
			}
		});
		unsubscribeBackpressure = session.agent.subscribe(async () => {
			await waitForRawStdoutBackpressure();
		});
		await session.bindExtensions({
			uiContext: createExtensionUIContext(),
			mode: "acp",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: async (options) => runtimeHost.newSession(options),
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, options) => {
					return runtimeHost.switchSession(sessionPath, options);
				},
				reload: async () => {
					await session.reload();
				},
			},
			shutdownHandler: () => {
				void shutdown();
			},
			onError: (err) => {
				process.stderr.write(`[acp extension error] ${err.error}\n`);
			},
		});
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void shutdown(signal === "SIGHUP" ? 129 : signal === "SIGINT" ? 130 : 143, signal);
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	await rebindSession();
	registerSignalHandlers();

	const handlePrompt = async (id: JsonRpcId, params: PromptParams): Promise<void> => {
		if (params.sessionId !== session.sessionId) {
			sendError(id, ACP_JSON_RPC_ERRORS.invalidParams, `Unknown sessionId: ${params.sessionId}`);
			return;
		}
		if (activePromptIds.size > 0) {
			sendError(id, ACP_JSON_RPC_ERRORS.unavailable, "A prompt is already active for this session");
			return;
		}
		let text: string;
		let images: ReturnType<typeof normalizePrompt>["images"];
		try {
			({ text, images } = normalizePrompt(params.prompt));
		} catch (error: unknown) {
			sendError(id, ACP_JSON_RPC_ERRORS.invalidParams, error instanceof Error ? error.message : String(error));
			return;
		}
		activePromptIds.add(id);
		inFlightTurnError = undefined;
		inFlightStopReason = undefined;
		try {
			await session.prompt(text, { images, source: "acp" });
			const turnError = inFlightTurnError;
			const stopReason = inFlightStopReason;
			inFlightTurnError = undefined;
			inFlightStopReason = undefined;
			if (turnError !== undefined && !cancelledPromptIds.has(id)) {
				// The turn produced nothing. ACP v1 has no error stop reason, so the
				// error channel is the only honest reply; `end_turn` would claim an
				// answer that does not exist.
				sendError(id, ACP_JSON_RPC_ERRORS.internal, turnError);
				return;
			}
			sendResponse(id, { stopReason: cancelledPromptIds.has(id) ? "cancelled" : (stopReason ?? "end_turn") });
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			if (cancelledPromptIds.has(id)) {
				sendResponse(id, { stopReason: "cancelled" });
			} else {
				sendError(id, ACP_JSON_RPC_ERRORS.internal, message);
			}
		} finally {
			activePromptIds.delete(id);
			cancelledPromptIds.delete(id);
		}
	};

	/**
	 * Install the client's MCP servers for the session about to become active.
	 *
	 * Must run before `newSession()` / `switchSession()`, because discovery reads
	 * the overlay once during the new session's `session_start`. A client that
	 * sends no servers clears the overlay, so a previous client's servers do not
	 * leak into a session that never asked for them.
	 */
	const applyClientMcpServers = (mcpServers: unknown): { accepted: number; rejected: string[] } => {
		const { declarations, rejected } = convertAcpMcpServers(mcpServers);
		setHostMcpServerOverlay(Object.keys(declarations).length > 0 ? declarations : undefined);
		return { accepted: Object.keys(declarations).length, rejected };
	};

	/** Restore the active session's MCP declaration when its replacement never starts. */
	const withMcpOverlayRollback = async <T>(
		previous: ReturnType<typeof getHostMcpServerOverlay>,
		operation: () => Promise<T>,
	): Promise<T> => {
		try {
			return await operation();
		} catch (error: unknown) {
			setHostMcpServerOverlay(previous);
			throw error;
		}
	};

	/**
	 * Report workspace roots beyond `cwd` instead of dropping them.
	 *
	 * A stdio session's tools resolve every path against one working directory, so
	 * extra roots cannot be honoured without re-plumbing path resolution through
	 * every tool. Saying so on stderr keeps the gap visible; staying silent would
	 * leave the client believing it had granted workspace roots the agent cannot
	 * reach. All three session-entry methods that accept the field route through
	 * here, so the report is identical whichever one a client calls.
	 */
	const reportUnhonoredAdditionalDirectories = (additionalDirectories: readonly string[]): void => {
		if (additionalDirectories.length === 0) return;
		process.stderr.write(
			`[acp] additionalDirectories is not honored; the session is scoped to ${runtimeHost.cwd}: ${additionalDirectories.join(", ")}\n`,
		);
	};

	const handleNewSession = async (
		id: JsonRpcId,
		cwd: string,
		mcpServers: unknown,
		additionalDirectories: readonly string[],
	): Promise<void> => {
		if (resolvePath(cwd) !== resolvePath(runtimeHost.cwd)) {
			sendError(
				id,
				ACP_JSON_RPC_ERRORS.invalidParams,
				`cwd must match the agent working directory: ${runtimeHost.cwd}`,
			);
			return;
		}
		reportUnhonoredAdditionalDirectories(additionalDirectories);
		const missingAuth = missingAuthError();
		if (missingAuth !== undefined) {
			sendError(id, ACP_JSON_RPC_ERRORS.authRequired, missingAuth);
			return;
		}
		const previousMcpServers = getHostMcpServerOverlay();
		const mcp = applyClientMcpServers(mcpServers);
		if (mcp.rejected.length > 0) {
			process.stderr.write(`[acp] ignoring MCP servers with unsupported transports: ${mcp.rejected.join(", ")}\n`);
		}
		const result = await withMcpOverlayRollback(previousMcpServers, async () => {
			await releaseSessionScopedClientState();
			return runtimeHost.newSession();
		});
		if (result.cancelled) {
			setHostMcpServerOverlay(previousMcpServers);
			// The engine cancels a session switch when a `session_before_switch`
			// handler declines it, which in practice is the setup flow finding no
			// model to select. An ACP client has no way to act on a bare
			// "cancelled", and no way to run the interactive setup that would fix
			// it, so say what to configure instead.
			sendError(
				id,
				ACP_JSON_RPC_ERRORS.unavailable,
				"Session creation was cancelled. ACP mode has no setup prompt, so this usually means no model is configured: run `step login` or add a provider to config.toml, then retry.",
			);
			return;
		}
		sendResponse(id, {
			sessionId: session.sessionId,
			modes: buildSessionModeState(),
			configOptions: buildConfigOptions(),
		});
	};

	const handleLoadSession = async (
		id: JsonRpcId,
		params: { sessionId: string; cwd: string; mcpServers: unknown; additionalDirectories: readonly string[] },
	): Promise<void> => {
		let info = (await SessionManager.list(params.cwd)).find((candidate) => candidate.id === params.sessionId);
		if (!info) {
			info = (await SessionManager.listAll()).find((candidate) => candidate.id === params.sessionId);
		}
		if (!info) {
			sendError(id, ACP_JSON_RPC_ERRORS.invalidParams, `Session not found: ${params.sessionId}`);
			return;
		}
		if (info.cwd && resolvePath(info.cwd) !== resolvePath(params.cwd)) {
			sendError(id, ACP_JSON_RPC_ERRORS.invalidParams, `Session cwd does not match: ${info.cwd}`);
			return;
		}
		reportUnhonoredAdditionalDirectories(params.additionalDirectories);
		const missingAuth = missingAuthError();
		if (missingAuth !== undefined) {
			sendError(id, ACP_JSON_RPC_ERRORS.authRequired, missingAuth);
			return;
		}
		const previousMcpServers = getHostMcpServerOverlay();
		const mcp = applyClientMcpServers(params.mcpServers);
		if (mcp.rejected.length > 0) {
			process.stderr.write(`[acp] ignoring MCP servers with unsupported transports: ${mcp.rejected.join(", ")}\n`);
		}
		const switched = await withMcpOverlayRollback(previousMcpServers, async () => {
			await releaseSessionScopedClientState();
			return runtimeHost.switchSession(info.path, { cwdOverride: params.cwd });
		});
		if (switched.cancelled) {
			setHostMcpServerOverlay(previousMcpServers);
			sendError(id, ACP_JSON_RPC_ERRORS.requestCancelled, "Session load was cancelled before the session changed");
			return;
		}
		// Loading is the entry point the protocol requires to replay, so the
		// history is streamed before the response that says the session is ready.
		replayStoredSession(info.path);
		sendResponse(id, { modes: buildSessionModeState(), configOptions: buildConfigOptions() });
	};

	/**
	 * Turn stored session entries into v1 `session/update` chunks.
	 *
	 * v1 has no whole-message update and no message ids, so a replayed message
	 * arrives as one chunk per content part in stored order. That is lossy for
	 * interleaved thinking and text (the client sees them sequentially rather
	 * than interleaved), which is the protocol's shape, not a choice here.
	 */
	const buildReplayUpdates = (entries: SessionEntry[]): SessionUpdate[] => {
		const updates: SessionUpdate[] = [];
		for (const entry of entries) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			const isUser = message.role === "user";
			const isAssistant = message.role === "assistant";
			if (!isUser && !isAssistant) continue;
			// Older sessions store a bare string instead of a content array.
			const parts: ReadonlyArray<AssistantMessage["content"][number] | { type: "image"; source?: unknown }> =
				typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
			for (const part of parts) {
				// v1 has no image chunk kind, so image parts are surfaced as text placeholders.
				if (part.type === "image") {
					const source = (part as { source?: { type?: string; media_type?: string } }).source;
					const label = source?.type === "base64" ? (source.media_type ?? "image") : "image";
					updates.push({
						sessionUpdate: isUser ? "user_message_chunk" : "agent_message_chunk",
						content: { type: "text", text: `[${label} omitted: ACP v1 has no image chunk]` },
					});
					continue;
				}
				if (part.type === "text" && part.text.length > 0) {
					updates.push({
						sessionUpdate: isUser ? "user_message_chunk" : "agent_message_chunk",
						content: { type: "text", text: part.text },
					});
					continue;
				}
				if (isAssistant && part.type === "thinking" && part.thinking.length > 0) {
					updates.push({
						sessionUpdate: "agent_thought_chunk",
						content: { type: "text", text: part.thinking },
					});
				}
			}
		}
		return updates;
	};

	/**
	 * Read a `session/list` cursor as the index the next page starts at.
	 *
	 * The cursor is opaque to the client, so it only ever carries what this mode
	 * put there. Anything else is rejected rather than restarted from the first
	 * page, which would replay sessions the client already holds.
	 */
	const readSessionListCursor = (cursor: string | undefined): number | undefined => {
		if (cursor === undefined) return 0;
		if (!/^\d+$/.test(cursor)) return undefined;
		const offset = Number(cursor);
		return Number.isSafeInteger(offset) ? offset : undefined;
	};

	/**
	 * Stream a stored session's history back to the client.
	 *
	 * The protocol splits the two entry points: `session/load` MUST replay the
	 * conversation and `session/resume` MUST NOT, so exactly one of them calls
	 * this. Replay goes out before the response that reports the session ready,
	 * which is what lets a client render the transcript it just asked for.
	 */
	const replayStoredSession = (sessionPath: string): void => {
		const entries = loadEntriesFromFile(sessionPath).filter(
			(entry): entry is SessionEntry => entry.type !== "session",
		);
		for (const update of buildReplayUpdates(entries)) {
			sendNotification("session/update", { sessionId: session.sessionId, update });
		}
	};

	const handleListSessions = async (id: JsonRpcId, params: ListSessionsParams): Promise<void> => {
		const offset = readSessionListCursor(params.cursor);
		if (offset === undefined) {
			sendError(id, ACP_JSON_RPC_ERRORS.invalidParams, `Invalid cursor: ${String(params.cursor)}`);
			return;
		}
		const sessions =
			params.cwd === undefined ? await SessionManager.listAll() : await SessionManager.list(params.cwd);
		// Both listings are ordered newest first, so an index is a stable page
		// boundary as long as the store does not change mid-pagination.
		const page = sessions.slice(offset, offset + SESSION_LIST_PAGE_SIZE);
		const nextOffset = offset + page.length;
		sendResponse(id, {
			sessions: toAcpSessionListEntries(page),
			// Omitted on the last page, which is how the protocol says "no more".
			...(nextOffset < sessions.length ? { nextCursor: String(nextOffset) } : {}),
		});
	};

	const handleResumeSession = async (id: JsonRpcId, params: ResumeSessionParams): Promise<void> => {
		let info = (await SessionManager.list(params.cwd)).find((candidate) => candidate.id === params.sessionId);
		if (!info) {
			info = (await SessionManager.listAll()).find((candidate) => candidate.id === params.sessionId);
		}
		if (!info) {
			sendError(id, ACP_JSON_RPC_ERRORS.invalidParams, `Session not found: ${params.sessionId}`);
			return;
		}
		if (info.cwd && resolvePath(info.cwd) !== resolvePath(params.cwd)) {
			sendError(id, ACP_JSON_RPC_ERRORS.invalidParams, `Session cwd does not match: ${info.cwd}`);
			return;
		}
		reportUnhonoredAdditionalDirectories(params.additionalDirectories);
		const previousMcpServers = getHostMcpServerOverlay();
		const missingAuth = missingAuthError();
		if (missingAuth !== undefined) {
			sendError(id, ACP_JSON_RPC_ERRORS.authRequired, missingAuth);
			return;
		}
		applyClientMcpServers(params.mcpServers);
		const switched = await withMcpOverlayRollback(previousMcpServers, async () => {
			await releaseSessionScopedClientState();
			return runtimeHost.switchSession(info.path, { cwdOverride: params.cwd });
		});
		if (switched.cancelled) {
			setHostMcpServerOverlay(previousMcpServers);
			sendError(id, ACP_JSON_RPC_ERRORS.requestCancelled, "Session resume was cancelled before the session changed");
			return;
		}

		// No replay here, and that is the protocol's rule rather than a choice:
		// resume reattaches to a session the client is already showing, so
		// streaming the history again would duplicate every message on screen.
		// `session/load` is the entry point that replays.
		sendResponse(id, { modes: buildSessionModeState(), configOptions: buildConfigOptions() });
	};

	const handleDeleteSession = async (id: JsonRpcId, sessionId: string): Promise<void> => {
		if (sessionId === session.sessionId) {
			sendError(id, ACP_JSON_RPC_ERRORS.invalidParams, "Cannot delete the active session");
			return;
		}
		const info = (await SessionManager.listAll()).find((candidate) => candidate.id === sessionId);
		if (!info) {
			sendError(id, ACP_JSON_RPC_ERRORS.invalidParams, `Session not found: ${sessionId}`);
			return;
		}
		try {
			await unlink(info.path);
		} catch (error: unknown) {
			sendError(id, ACP_JSON_RPC_ERRORS.internal, `Failed to delete session: ${String(error)}`);
			return;
		}
		sendResponse(id, {});
	};

	const handleCloseSession = async (id: JsonRpcId, params: CloseSessionParams): Promise<void> => {
		if (params.sessionId !== session.sessionId) {
			sendError(id, ACP_JSON_RPC_ERRORS.invalidParams, `Unknown sessionId: ${params.sessionId}`);
			return;
		}
		const previousMcpServers = getHostMcpServerOverlay();
		sessionClosing = true;
		try {
			await releaseSessionScopedClientState();
			await session.abort();
			// The replacement owns teardown of the old session, including extension
			// shutdown and disposal. Starting without client MCP servers leaves an
			// inert placeholder instead of reconnecting the session being closed.
			// `sessionClosing` rejects prompts and other session mutations until the
			// overlay and replacement are consistent again.
			setHostMcpServerOverlay(undefined);
			const result = await withMcpOverlayRollback(previousMcpServers, () => runtimeHost.newSession());
			if (result.cancelled) {
				setHostMcpServerOverlay(previousMcpServers);
				sendError(id, ACP_JSON_RPC_ERRORS.unavailable, "Session close was cancelled during runtime teardown");
				return;
			}
			// The old session file remains on disk, but its id no longer names the
			// active runtime, so a later prompt is rejected until load or resume.
			sendResponse(id, {});
		} finally {
			sessionClosing = false;
		}
	};

	/**
	 * Session modes are the Step permission tiers, which are exactly what ACP
	 * modes describe: a named policy that changes tool availability and how much
	 * the agent may do without asking.
	 */
	const buildSessionModeState = (): SessionModeState => ({
		currentModeId: currentPermissionPresetId() ?? STEP_PERMISSION_PRESETS[0]!.id,
		availableModes: STEP_PERMISSION_PRESETS.map((preset) => ({
			id: preset.id,
			name: preset.label,
			description: preset.description,
		})),
	});

	/** Read the permission tier back out of the label the extension published. */
	const currentPermissionPresetId = (): string | undefined => {
		const text = publishedPermissionLabel;
		if (text === undefined || !text.startsWith(PERMISSION_STATUS_PREFIX)) return undefined;
		const label = text.slice(PERMISSION_STATUS_PREFIX.length).replace(/\s*\(auto-resume\)$/, "");
		return STEP_PERMISSION_PRESETS.find((preset) => preset.label === label)?.id;
	};

	/**
	 * Configuration options offered to the client.
	 *
	 * Only selectors the session can actually change are listed: the model, and
	 * the reasoning level when the active model has one. An empty list means the
	 * client shows no selector rather than one that does nothing.
	 */
	const MODEL_CONFIG_OPTION_ID = "model";
	const THINKING_CONFIG_OPTION_ID = "thinking";

	const buildConfigOptions = (): SessionConfigOption[] => {
		const options: SessionConfigOption[] = [];
		const models = session.modelRuntime.getAvailableSnapshot();
		if (models.length > 0) {
			const current = session.model;
			options.push({
				id: MODEL_CONFIG_OPTION_ID,
				name: "Model",
				description: "Model used for the next request",
				category: "model",
				type: "select",
				currentValue: current ? modelOptionValue(current) : "",
				options: models.map((model) => ({
					value: modelOptionValue(model),
					name: model.name || model.id,
				})),
			});
		}
		if (session.supportsThinking()) {
			const levels = session.getAvailableThinkingLevels();
			options.push({
				id: THINKING_CONFIG_OPTION_ID,
				name: "Reasoning effort",
				category: "thought_level",
				type: "select",
				currentValue: session.thinkingLevel,
				options: levels.map((level) => ({ value: level, name: level })),
			});
		}
		return options;
	};

	const modelOptionValue = (model: Model<any>): string => `${model.provider}/${model.id}`;

	const notifyCurrentMode = (): void => {
		if (!initialized) return;
		sendNotification("session/update", {
			sessionId: session.sessionId,
			update: { sessionUpdate: "current_mode_update", currentModeId: buildSessionModeState().currentModeId },
		});
	};

	const notifyConfigOptions = (): void => {
		if (!initialized) return;
		sendNotification("session/update", {
			sessionId: session.sessionId,
			update: { sessionUpdate: "config_option_update", configOptions: buildConfigOptions() },
		});
	};

	/**
	 * Change the permission tier by running the same extension command the TUI runs.
	 *
	 * The policy lives in the step extension, so this mode asks it to change
	 * rather than reimplementing the tiers. That also keeps the full-access risk
	 * confirmation, which the extension routes back through the ACP permission
	 * surface like any other approval.
	 */
	const applyPermissionPreset = async (presetId: string): Promise<boolean> => {
		const command = session.extensionRunner.getCommand("permissions");
		if (!command) return false;
		try {
			await command.handler(presetId, session.extensionRunner.createCommandContext());
		} catch (error: unknown) {
			const reason = error instanceof Error ? error.message : String(error);
			process.stderr.write(`[acp] permission command failed: ${reason}
`);
			return false;
		}
		return true;
	};

	/**
	 * Refuse a session before it starts when nothing can authenticate it.
	 *
	 * A session with no credential fails on the first request with a provider
	 * error the client cannot act on. ACP has a dedicated code for this, and a
	 * client that receives it runs the `authenticate` flow instead.
	 */
	const missingAuthError = (): string | undefined => {
		// Only the Step provider is gated, and only on the two credential sources
		// this product owns. Gating on the runtime provider snapshot would reject
		// sessions before the first availability refresh has run, which is a startup
		// race rather than a missing credential.
		if (session.model?.provider !== STEP_PROVIDER_ID) return undefined;
		if (process.env.STEP_API_KEY?.trim()) return undefined;
		if (readStepLoginCredential(getStepAuthPath()) !== undefined) return undefined;
		return "No Step credentials found. Set STEP_API_KEY or call authenticate.";
	};

	const handleSetSessionMode = async (id: JsonRpcId, params: SetSessionModeParams): Promise<void> => {
		if (params.sessionId !== session.sessionId) {
			sendError(id, ACP_JSON_RPC_ERRORS.invalidParams, `Unknown sessionId: ${params.sessionId}`);
			return;
		}
		const preset = getStepPermissionPreset(params.modeId);
		if (!preset) {
			sendError(id, ACP_JSON_RPC_ERRORS.invalidParams, `Unknown mode: ${params.modeId}`);
			return;
		}
		if (!(await applyPermissionPreset(preset.id))) {
			sendError(id, ACP_JSON_RPC_ERRORS.internal, `Could not switch to mode: ${params.modeId}`);
			return;
		}
		const state = buildSessionModeState();
		notifyCurrentMode();
		sendResponse(id, state);
	};

	const handleSetSessionConfigOption = async (id: JsonRpcId, params: SetSessionConfigOptionParams): Promise<void> => {
		if (params.sessionId !== session.sessionId) {
			sendError(id, ACP_JSON_RPC_ERRORS.invalidParams, `Unknown sessionId: ${params.sessionId}`);
			return;
		}
		if (params.optionId === MODEL_CONFIG_OPTION_ID) {
			if (typeof params.value !== "string") {
				sendError(id, ACP_JSON_RPC_ERRORS.invalidParams, "model value must be a string");
				return;
			}
			const model = session.modelRuntime
				.getAvailableSnapshot()
				.find((candidate) => modelOptionValue(candidate) === params.value);
			if (!model) {
				sendError(id, ACP_JSON_RPC_ERRORS.invalidParams, `Unknown model: ${params.value}`);
				return;
			}
			try {
				await session.setModel(model);
			} catch (error: unknown) {
				sendError(
					id,
					ACP_JSON_RPC_ERRORS.internal,
					`Could not switch model: ${error instanceof Error ? error.message : String(error)}`,
				);
				return;
			}
		} else if (params.optionId === THINKING_CONFIG_OPTION_ID) {
			if (typeof params.value !== "string") {
				sendError(id, ACP_JSON_RPC_ERRORS.invalidParams, "thinking value must be a string");
				return;
			}
			const level = params.value as Parameters<typeof session.setThinkingLevel>[0];
			if (!session.getAvailableThinkingLevels().includes(level)) {
				sendError(id, ACP_JSON_RPC_ERRORS.invalidParams, `Unknown reasoning level: ${params.value}`);
				return;
			}
			session.setThinkingLevel(level);
		} else {
			sendError(id, ACP_JSON_RPC_ERRORS.invalidParams, `Unknown config option: ${params.optionId}`);
			return;
		}
		const configOptions = buildConfigOptions();
		notifyConfigOptions();
		sendResponse(id, { configOptions });
	};

	/**
	 * ACP `session/set_model`.
	 *
	 * An alias, not a second selector: it is the model half of
	 * `session/set_config_option`, carried over from the older unstable surface.
	 * The method is outside the v1 schema, so it is accepted because clients that
	 * talk to agents which implement it will send it, and the response mirrors
	 * `session/set_config_option` because there is no spec shape to follow.
	 */
	const handleSetSessionModel = async (id: JsonRpcId, params: SetSessionModelParams): Promise<void> => {
		if (params.sessionId !== session.sessionId) {
			sendError(id, ACP_JSON_RPC_ERRORS.invalidParams, `Unknown sessionId: ${params.sessionId}`);
			return;
		}
		if (typeof params.modelId !== "string") {
			sendError(id, ACP_JSON_RPC_ERRORS.invalidParams, "modelId must be a string");
			return;
		}
		const model = session.modelRuntime
			.getAvailableSnapshot()
			.find((candidate) => modelOptionValue(candidate) === params.modelId);
		if (!model) {
			sendError(id, ACP_JSON_RPC_ERRORS.invalidParams, `Unknown model: ${params.modelId}`);
			return;
		}
		try {
			await session.setModel(model);
		} catch (error: unknown) {
			sendError(
				id,
				ACP_JSON_RPC_ERRORS.internal,
				`Could not switch model: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		const configOptions = buildConfigOptions();
		notifyConfigOptions();
		sendResponse(id, { configOptions });
	};

	/**
	 * ACP `session/fork`.
	 *
	 * Also outside the v1 schema. The engine already has the primitive, so this
	 * is a thin mapping: resolve the source session, copy its history into a new
	 * session file in the same project, and make it active. The response mirrors
	 * `session/new` for the same reason `session/set_model` mirrors
	 * `session/set_config_option`: no spec shape exists to follow.
	 *
	 * The request's own `mcpServers` is applied to the forked session, matching
	 * `session/new`. `cwd` and `additionalDirectories` are validated and then
	 * ignored, which is what the protocol's own extension agents do, because a
	 * fork inherits the source session's project rather than relocating it.
	 */
	const handleForkSession = async (id: JsonRpcId, params: ForkSessionParams): Promise<void> => {
		let info = (await SessionManager.list(params.cwd)).find((candidate) => candidate.id === params.sessionId);
		if (!info) {
			info = (await SessionManager.listAll()).find((candidate) => candidate.id === params.sessionId);
		}
		if (!info) {
			sendError(id, ACP_JSON_RPC_ERRORS.invalidParams, `Session not found: ${params.sessionId}`);
			return;
		}
		if (info.cwd && resolvePath(info.cwd) !== resolvePath(params.cwd)) {
			sendError(id, ACP_JSON_RPC_ERRORS.invalidParams, `Session cwd does not match: ${info.cwd}`);
			return;
		}
		const missingAuth = missingAuthError();
		if (missingAuth !== undefined) {
			sendError(id, ACP_JSON_RPC_ERRORS.authRequired, missingAuth);
			return;
		}
		const previousMcpServers = getHostMcpServerOverlay();
		const mcp = applyClientMcpServers(params.mcpServers ?? []);
		if (mcp.rejected.length > 0) {
			process.stderr.write(`[acp] ignoring MCP servers with unsupported transports: ${mcp.rejected.join(", ")}
`);
		}
		let forked: SessionManager;
		try {
			forked = SessionManager.forkFrom(info.path, params.cwd);
		} catch (error: unknown) {
			setHostMcpServerOverlay(previousMcpServers);
			sendError(
				id,
				ACP_JSON_RPC_ERRORS.internal,
				`Could not fork session: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		const forkedPath = forked.getSessionFile();
		if (!forkedPath) {
			setHostMcpServerOverlay(previousMcpServers);
			sendError(id, ACP_JSON_RPC_ERRORS.internal, "Forked session was not persisted");
			return;
		}
		const switched = await withMcpOverlayRollback(previousMcpServers, async () => {
			await releaseSessionScopedClientState();
			return runtimeHost.switchSession(forkedPath, { cwdOverride: params.cwd });
		});
		if (switched.cancelled) {
			setHostMcpServerOverlay(previousMcpServers);
			await unlink(forkedPath).catch((error: unknown) => {
				process.stderr.write(`[acp] could not remove cancelled fork ${forkedPath}: ${String(error)}\n`);
			});
			sendError(id, ACP_JSON_RPC_ERRORS.requestCancelled, "Session fork was cancelled before the session changed");
			return;
		}
		sendResponse(id, {
			sessionId: forked.getSessionId(),
			modes: buildSessionModeState(),
			configOptions: buildConfigOptions(),
		});
	};

	/**
	 * Authentication methods this agent can offer.
	 *
	 * The terminal method is only advertised when the client said it can run the
	 * agent in an interactive terminal, because that is the only way Step's
	 * browser login can happen. The API-key method needs form elicitation,
	 * because that is the only ACP surface that can collect the key.
	 */
	const buildAuthMethods = (): AuthMethod[] => {
		const methods: AuthMethod[] = [];
		if (clientSupportsTerminalAuth) {
			methods.push({
				id: STEP_TERMINAL_AUTH_METHOD_ID,
				name: "Log in with a Step account",
				description: "Opens a terminal running `step login`. Finish the browser flow there.",
				type: "terminal",
				args: ["login"],
			});
		}
		if (clientSupportsFormElicitation) {
			methods.push({
				id: STEP_API_KEY_AUTH_METHOD_ID,
				name: "Step API key",
				description: "Paste an API key from the Step platform.",
			});
		}
		return methods;
	};

	/**
	 * `authenticate` for the API-key method.
	 *
	 * The key is written to the same credential store `step login` uses, so a
	 * later process finds it without asking again. The account profile is asked
	 * for in the same form because it selects the endpoint, and guessing it would
	 * turn a typo into an authentication failure the user cannot explain.
	 */
	const handleAuthenticate = async (id: JsonRpcId, methodId: string): Promise<void> => {
		const method = buildAuthMethods().find((candidate) => candidate.id === methodId);
		if (!method) {
			sendError(id, ACP_JSON_RPC_ERRORS.invalidParams, `Unknown auth method: ${methodId}`);
			return;
		}
		if (method.type === "terminal") {
			sendError(id, ACP_JSON_RPC_ERRORS.invalidParams, `Method ${methodId} is run by the client, not by the agent`);
			return;
		}
		const profiles = resolveStepLoginProfiles().filter((profile) => profile.credentialSource === "apiKey");
		if (profiles.length === 0) {
			sendError(id, ACP_JSON_RPC_ERRORS.unavailable, "No API-key account profiles are available");
			return;
		}
		const content = await elicitForm({
			prompt: [
				"Choose the Step account and paste its API key.",
				...profiles.map((profile) => `- ${profile.id}: ${profile.title}`),
			].join("\n"),
			properties: {
				profile: {
					type: "string",
					title: "Account",
					enum: profiles.map((profile) => profile.id),
				},
				apiKey: {
					type: "string",
					title: "API key",
				},
			},
			required: ["profile", "apiKey"],
		});
		const profile = content?.profile;
		const apiKey = content?.apiKey;
		if (typeof profile !== "string" || typeof apiKey !== "string" || apiKey.trim().length === 0) {
			sendError(id, ACP_JSON_RPC_ERRORS.invalidParams, "Authentication was not completed");
			return;
		}
		if (!profiles.some((candidate) => candidate.id === profile)) {
			sendError(id, ACP_JSON_RPC_ERRORS.invalidParams, `Unknown account profile: ${profile}`);
			return;
		}
		try {
			await writeStepLoginCredential({
				authPath: getStepAuthPath(),
				profile: profile as Parameters<typeof writeStepLoginCredential>[0]["profile"],
				apiKey,
			});
		} catch (error: unknown) {
			sendError(
				id,
				ACP_JSON_RPC_ERRORS.internal,
				`Could not store the credential: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		// The stored credential is picked up on the next request. Refreshing here
		// also repopulates the model list the config option selector shows.
		void session.modelRuntime.getAvailable().catch(() => undefined);
		notifyConfigOptions();
		sendResponse(id, {});
	};

	/**
	 * `logout` removes the stored Step credential and the account session.
	 *
	 * Sessions already running keep their in-memory credential until they end:
	 * the protocol makes no promise about them, and pulling it mid-turn would
	 * fail a turn that is already streaming.
	 */
	const handleLogout = async (id: JsonRpcId): Promise<void> => {
		try {
			await clearStepLoginState();
			await logoutStepCredentials();
		} catch (error: unknown) {
			sendError(
				id,
				ACP_JSON_RPC_ERRORS.internal,
				`Could not log out: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		void session.modelRuntime.getAvailable().catch(() => undefined);
		notifyConfigOptions();
		sendResponse(id, {});
	};

	const handleRequest = async (request: JsonRpcRequest): Promise<void> => {
		const id = request.id;
		const isRequest = id !== undefined;
		const params = request.params;

		if (request.method !== "initialize" && !initialized) {
			if (isRequest) {
				sendError(id, ACP_JSON_RPC_ERRORS.notInitialized, "Client must call initialize first");
			}
			return;
		}
		if (sessionClosing && request.method !== "session/cancel") {
			if (isRequest) {
				sendError(id, ACP_JSON_RPC_ERRORS.unavailable, "Session close is in progress");
			}
			return;
		}

		switch (request.method) {
			case "initialize": {
				if (initialized) {
					if (isRequest) {
						sendError(id, ACP_JSON_RPC_ERRORS.invalidRequest, "Client has already initialized this connection");
					}
					return;
				}
				const validation = validateInitializeParams(params);
				if (!validation.ok) {
					if (isRequest) {
						sendError(id, ACP_JSON_RPC_ERRORS.invalidParams, validation.message);
					}
					return;
				}
				initialized = true;
				clientSupportsFormElicitation = validation.value.clientCapabilities?.elicitation?.form != null;
				clientSupportsTerminalAuth = validation.value.clientCapabilities?.auth?.terminal === true;
				clientSupportsFsRead = validation.value.clientCapabilities?.fs?.readTextFile === true;
				clientSupportsFsWrite = validation.value.clientCapabilities?.fs?.writeTextFile === true;
				clientSupportsTerminal = validation.value.clientCapabilities?.terminal === true;
				installClientFileSystemBridge();
				installClientTerminalHost();
				if (isRequest) {
					sendResponse(id, {
						agentCapabilities: {
							loadSession: true,
							promptCapabilities: {
								image: true,
								audio: false,
								// `resource` blocks are accepted and inlined into the prompt,
								// which is what the capability promises.
								embeddedContext: true,
							},
							mcpCapabilities: {
								// stdio is mandatory in ACP and is what `session/new` accepts by
								// default. Both remote transports the protocol defines are advertised:
								// the engine connects Streamable HTTP, and SSE is wired through its own
								// transport even though the protocol marks it deprecated, because
								// clients still send it.
								http: true,
								sse: true,
							},
							// ACP gates every optional session method behind a capability, so a
							// client that follows the spec will not call an unadvertised one.
							// An empty object means "supported"; the key names carry no value.
							sessionCapabilities: {
								list: {},
								close: {},
								delete: {},
								resume: {},
							},
							auth: { logout: {} },
						},
						agentInfo: {
							name: "Step Code",
							version: VERSION,
						},
						authMethods: buildAuthMethods(),
						protocolVersion: ACP_PROTOCOL_VERSION,
					});
				}
				return;
			}

			case "session/new": {
				if (!isRequest) return;
				const validation = validateNewSessionParams(params);
				if (!validation.ok) {
					sendError(id, ACP_JSON_RPC_ERRORS.invalidParams, validation.message);
					return;
				}
				await handleNewSession(id, validation.cwd, validation.mcpServers, validation.additionalDirectories);
				return;
			}

			case "session/load": {
				if (!isRequest) return;
				const validation = validateLoadSessionParams(params);
				if (!validation.ok) {
					sendError(id, ACP_JSON_RPC_ERRORS.invalidParams, validation.message);
					return;
				}
				await handleLoadSession(id, {
					sessionId: validation.sessionId,
					cwd: validation.cwd,
					mcpServers: validation.mcpServers,
					additionalDirectories: validation.additionalDirectories,
				});
				return;
			}

			case "session/prompt": {
				if (!isRequest) return;
				const validation = validatePromptParams(params);
				if (!validation.ok) {
					sendError(id, ACP_JSON_RPC_ERRORS.invalidParams, validation.message);
					return;
				}
				// Do not await the turn here: stdin must stay readable so
				// session/cancel and session/request_permission responses arrive.
				void handlePrompt(id, validation.value);
				return;
			}

			case "session/resume": {
				if (!isRequest) return;
				const validation = validateResumeSessionParams(params);
				if (!validation.ok) {
					sendError(id, ACP_JSON_RPC_ERRORS.invalidParams, validation.message);
					return;
				}
				await handleResumeSession(id, validation.value);
				return;
			}

			case "session/list": {
				if (!isRequest) return;
				const validation = validateListSessionsParams(params);
				if (!validation.ok) {
					sendError(id, ACP_JSON_RPC_ERRORS.invalidParams, validation.message);
					return;
				}
				await handleListSessions(id, validation.value);
				return;
			}

			case "session/delete": {
				if (!isRequest) return;
				const validation = validateDeleteSessionParams(params);
				if (!validation.ok) {
					sendError(id, ACP_JSON_RPC_ERRORS.invalidParams, validation.message);
					return;
				}
				await handleDeleteSession(id, validation.value.sessionId);
				return;
			}

			case "session/close": {
				if (!isRequest) return;
				const validation = validateCloseSessionParams(params);
				if (!validation.ok) {
					sendError(id, ACP_JSON_RPC_ERRORS.invalidParams, validation.message);
					return;
				}
				await handleCloseSession(id, validation.value);
				return;
			}

			case "authenticate": {
				if (!isRequest) return;
				const validation = validateAuthenticateParams(params);
				if (!validation.ok) {
					sendError(id, ACP_JSON_RPC_ERRORS.invalidParams, validation.message);
					return;
				}
				await handleAuthenticate(id, validation.value.methodId);
				return;
			}

			case "logout": {
				if (!isRequest) return;
				await handleLogout(id);
				return;
			}

			case "session/set_mode": {
				if (!isRequest) return;
				const validation = validateSetSessionModeParams(params);
				if (!validation.ok) {
					sendError(id, ACP_JSON_RPC_ERRORS.invalidParams, validation.message);
					return;
				}
				await handleSetSessionMode(id, validation.value);
				return;
			}

			case "session/set_config_option": {
				if (!isRequest) return;
				const validation = validateSetSessionConfigOptionParams(params);
				if (!validation.ok) {
					sendError(id, ACP_JSON_RPC_ERRORS.invalidParams, validation.message);
					return;
				}
				await handleSetSessionConfigOption(id, validation.value);
				return;
			}

			case "session/set_model": {
				if (!isRequest) return;
				const validation = validateSetSessionModelParams(params);
				if (!validation.ok) {
					sendError(id, ACP_JSON_RPC_ERRORS.invalidParams, validation.message);
					return;
				}
				await handleSetSessionModel(id, validation.value);
				return;
			}

			case "session/fork": {
				if (!isRequest) return;
				const validation = validateForkSessionParams(params);
				if (!validation.ok) {
					sendError(id, ACP_JSON_RPC_ERRORS.invalidParams, validation.message);
					return;
				}
				await handleForkSession(id, validation.value);
				return;
			}

			case "session/cancel": {
				if (isRequest) return;
				const sessionId =
					typeof params === "object" && params !== null
						? (params as { sessionId?: unknown }).sessionId
						: undefined;
				if (sessionId !== session.sessionId) {
					process.stderr.write(`[acp] ignoring cancellation for unknown sessionId: ${String(sessionId)}\n`);
					return;
				}
				for (const promptId of activePromptIds) {
					cancelledPromptIds.add(promptId);
				}
				for (const requestId of [...pendingClientRequests.keys()]) {
					settleClientRequest(requestId, undefined);
				}
				await session.abort();
				return;
			}

			default: {
				if (isRequest) {
					sendError(id, ACP_JSON_RPC_ERRORS.methodNotFound, `Unsupported method: ${request.method}`);
				}
			}
		}
	};

	/**
	 * Route a client response to whichever request it answers.
	 *
	 * The parser lives with the caller. Error responses retain their JSON-RPC
	 * code so filesystem and terminal fallback policy can distinguish an absent
	 * method from a refused or failed operation.
	 */
	const handleClientResponse = (response: JsonRpcResponseObject) => {
		if (response.error === undefined && response.result === undefined) return;
		const id = response.id;
		if (typeof id !== "string" && typeof id !== "number") return;
		if (response.error !== undefined) {
			rejectClientRequest(String(id), new AcpClientRequestError(response.error.code, response.error.message));
			return;
		}
		settleClientRequest(String(id), response.result);
	};

	const handleCancelNotification = (params: unknown) => {
		if (typeof params !== "object" || params === null) return;
		const requestId = (params as { requestId?: unknown }).requestId;
		if (typeof requestId === "string" || typeof requestId === "number") {
			// JSON-RPC cancellation targets an individual agent-to-client request.
			// Prompt turns have their own ACP session/cancel notification.
			settleClientRequest(String(requestId), undefined);
		}
	};

	const handleInputLine = async (line: string) => {
		const parsed = parseJsonRpcLine(line);
		if (parsed.error) {
			sendError(null, parsed.error.code, parsed.error.message);
			await waitForRawStdoutBackpressure();
			return;
		}
		if (parsed.response) {
			handleClientResponse(parsed.response);
			return;
		}
		if (!parsed.request) return;
		const request = parsed.request;

		if (request.method === "$/cancel_request") {
			handleCancelNotification(request.params);
			return;
		}

		if (request.id === undefined) {
			if (request.method === "session/cancel") {
				try {
					await handleRequest(request);
				} catch (error: unknown) {
					process.stderr.write(`[acp] cancellation failed: ${String(error)}\n`);
				}
			}
			return;
		}

		try {
			await handleRequest(request);
		} catch (error: unknown) {
			// Runtime and filesystem failures belong to this request. They must not
			// become an unhandled rejection that takes down the protocol process.
			sendError(
				request.id ?? null,
				ACP_JSON_RPC_ERRORS.internal,
				error instanceof Error ? error.message : String(error),
			);
		}
		await waitForRawStdoutBackpressure();
	};

	async function shutdown(exitCode = 0, signal?: NodeJS.Signals): Promise<never> {
		if (shuttingDown) {
			process.exit(exitCode);
		}
		shuttingDown = true;
		killTrackedDetachedChildren();
		await releaseSessionScopedClientState();
		setClientFileSystemBridge(undefined);
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		for (const requestId of [...pendingClientRequests.keys()]) {
			settleClientRequest(requestId, undefined);
		}
		unsubscribe?.();
		unsubscribeBackpressure?.();
		await runtimeHost.dispose();
		detachInput();
		process.stdin.pause();
		if (signal !== "SIGTERM") {
			await flushRawStdout();
		}
		process.exit(exitCode);
	}

	const onInputEnd = () => {
		void shutdown();
	};
	process.stdin.on("end", onInputEnd);

	detachInput = (() => {
		const detachJsonl = attachJsonlLineReader(process.stdin, (line) => {
			void handleInputLine(line).catch((error: unknown) => {
				// The request boundary above returns protocol errors. This last guard
				// covers framing and output failures that have no safe response path.
				process.stderr.write(`[acp] input processing failed: ${String(error)}\n`);
			});
		});
		return () => {
			detachJsonl();
			process.stdin.off("end", onInputEnd);
		};
	})();

	// Keep process alive forever
	return new Promise(() => {});
}
