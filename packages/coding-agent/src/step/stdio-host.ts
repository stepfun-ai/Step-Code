/**
 * Step's length-prefixed SDK host.
 *
 * The host owns only the wire protocol. Agent execution, queueing, persistence,
 * and session replacement stay in pi's AgentSession/AgentSessionRuntime.
 */

import { once } from "node:events";
import type {
	AgentMessage,
	AgentTool,
	BeforeToolCallContext,
	BeforeToolCallResult,
	ThinkingLevel,
} from "@step-harness/agent-core";
import type { ImageContent, Model, TextContent } from "@step-harness/providers";
import { Type } from "typebox";
import type { AgentSession, AgentSessionEvent } from "../core/agent-session.ts";
import type { AgentSessionRuntimeHost } from "../core/agent-session-runtime.ts";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../core/extensions/types.ts";
import type { Theme } from "../theme/theme.ts";
import { STEP_DEFAULT_PROVIDER } from "./defaults.ts";
import { listStepSessions } from "./session.ts";
import {
	encodeStepStdioFrame,
	STEP_MAX_FRAME_BYTES,
	STEP_PROTOCOL_NAME,
	STEP_PROTOCOL_VERSION,
	type StepFrame,
	StepStdioFrameDecoder,
	StepStdioProtocolViolation,
} from "./stdio.ts";

type FrameWriter = (chunk: Buffer) => boolean | undefined;

const PERMISSION_REQUEST_TIMEOUT_MS = 60_000;
const PERMISSION_RESPONSE_GRACE_MS = 10_000;
const SDK_TOOL_TIMEOUT_MS = 120_000;
const SDK_TOOL_RESPONSE_GRACE_MS = 10_000;
const SDK_HOOK_TIMEOUT_MS = 30_000;
const SDK_HOOK_RESPONSE_GRACE_MS = 5_000;
const PERMISSION_MODES = new Set(["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk"]);

export interface StepSdkHookRegistration {
	event: string;
	matchers: Array<{ index: number; matcher?: string }>;
}

export interface StepSdkHookOutput {
	continue?: boolean;
	decision?: "approve" | "block";
	reason?: string;
	systemMessage?: string;
	additionalContext?: string;
	interrupt?: boolean;
}

interface StepSdkToolDescriptor {
	serverName: string;
	toolName: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

interface StepQueryOptions {
	permissionMode?: string;
	hasPermissionCallback?: boolean;
	includePartialMessages?: boolean;
	model?: string;
	maxThinkingTokens?: number;
	maxTurns?: number;
	outputFormat?: { type?: string; schema?: Record<string, unknown> };
	sdkTools?: StepSdkToolDescriptor[];
	hooks?: StepSdkHookRegistration[];
	sandbox?: { enabled?: boolean; [key: string]: unknown };
	[key: string]: unknown;
}

type QueryBridgeCleanup = () => void;

export interface StepStdioHostOptions {
	runtimeHost: AgentSessionRuntimeHost;
	runtimeVersion?: string;
	input?: NodeJS.ReadableStream;
	output?: NodeJS.WritableStream;
	/** Supply this before main() takes over stdout when frames must remain binary. */
	writeFrame?: FrameWriter;
	diagnostics?: (line: string) => void;
	/** Optional process termination hook. Omit it when embedding or unit testing. */
	onExitRequested?: (code: number) => void;
}

interface ActiveQuery {
	id: string;
	sessionId: string;
	startedAt: number;
	numTurns: number;
	options: StepQueryOptions;
	optionWarnings: string[];
	streamingInput: boolean;
	inputEnded: boolean;
	inputQueue: Array<{ text: string; images?: ImageContent[] }>;
	inputPumpRunning: boolean;
	turnsInFlight: number;
	interrupted: boolean;
	errorMessage?: string;
	finished: boolean;
}

interface PendingRequest {
	resolve: (frame: StepFrame | undefined) => void;
	timer: ReturnType<typeof setTimeout>;
}

/** A small, testable protocol host used by `step --sdk-stdio`. */
export class StepStdioHost {
	readonly #options: StepStdioHostOptions;
	readonly #decoder = new StepStdioFrameDecoder();
	readonly #diagnostics: (line: string) => void;
	readonly #pendingRequests = new Map<string, PendingRequest>();
	readonly #signalCleanups: Array<() => void> = [];
	#session: AgentSession;
	#removeSessionListener: (() => void) | undefined;
	#removeRuntimeListener: (() => void) | undefined;
	#removeInputListeners: (() => void) | undefined;
	#activeQuery: ActiveQuery | undefined;
	#queryBridgeCleanup: QueryBridgeCleanup | undefined;
	/** Serialize session extension binding across runtime replacements. */
	#bindingTail: Promise<void> = Promise.resolve();
	#boundSession: AgentSession | undefined;
	#pendingBindingSession: AgentSession | undefined;
	#pendingBindingPromise: Promise<void> | undefined;
	#nextId = 0;
	#sequence = 0;
	#closed = false;
	#closePromise: Promise<void> | undefined;
	#resolveClosed!: () => void;
	readonly #closedPromise = new Promise<void>((resolve) => {
		this.#resolveClosed = resolve;
	});
	#writeTail: Promise<void> = Promise.resolve();

	constructor(options: StepStdioHostOptions) {
		this.#options = options;
		this.#session = options.runtimeHost.session;
		this.#diagnostics = options.diagnostics ?? ((line) => process.stderr.write(`${line}\n`));
	}

	/** Attach stdin and keep the process alive until the peer or runtime closes. */
	async run(): Promise<void> {
		if (this.#closed) return;
		this.#removeRuntimeListener = this.#options.runtimeHost.onSessionChange((session) => {
			void this.#queueBindSession(session).catch((error) => this.#report(error));
		});
		// AgentSessionRuntime awaits this hook after publishing a replacement. The
		// synchronous listener above keeps compatibility with lightweight runtime
		// facades, while the shared queue makes the two notifications idempotent.
		this.#options.runtimeHost.setRebindSession?.((session) => this.#queueBindSession(session));
		await this.#queueBindSession(this.#session);
		this.#attachInput();
		this.#installSignals();
		await this.#closedPromise;
	}

	/** Idempotent shutdown, useful for tests and embedding hosts. */
	async close(code = 0): Promise<void> {
		if (!this.#closePromise) this.#closePromise = this.#shutdown(code);
		await this.#closePromise;
	}

	get closed(): boolean {
		return this.#closed;
	}

	#queueBindSession(session: AgentSession): Promise<void> {
		if (this.#closed) return Promise.resolve();
		if (this.#boundSession === session) return Promise.resolve();
		if (this.#pendingBindingSession === session && this.#pendingBindingPromise) {
			return this.#pendingBindingPromise;
		}

		const binding = this.#bindingTail.then(() => this.#bindSession(session));
		this.#bindingTail = binding.then(
			() => undefined,
			() => undefined,
		);
		this.#pendingBindingSession = session;
		this.#pendingBindingPromise = binding;
		void binding.then(
			() => {
				if (this.#pendingBindingPromise === binding) {
					this.#pendingBindingSession = undefined;
					this.#pendingBindingPromise = undefined;
				}
			},
			() => {
				if (this.#pendingBindingPromise === binding) {
					this.#pendingBindingSession = undefined;
					this.#pendingBindingPromise = undefined;
				}
			},
		);
		return binding;
	}

	async #bindSession(session: AgentSession): Promise<void> {
		if (this.#closed) return;
		const previousSession = this.#session;
		if (previousSession !== session) {
			const query = this.#activeQuery;
			if (query && !query.finished) {
				query.interrupted = true;
				query.inputEnded = true;
				query.inputQueue.length = 0;
				query.errorMessage = "the active session was replaced";
				this.#finishQuery(query, true, new Error(query.errorMessage));
			}
		}
		this.#removeSessionListener?.();
		this.#session = session;
		this.#removeSessionListener = session.subscribe((event) => this.#onSessionEvent(event));
		await session.bindExtensions({
			mode: "rpc",
			uiContext: this.#createUiContext(session.sessionId),
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: (options) => this.#options.runtimeHost.newSession(options),
				fork: async (entryId, options) => {
					const result = await this.#options.runtimeHost.fork(entryId, options);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await session.navigateTree(targetId, options);
					return { cancelled: result.cancelled };
				},
				switchSession: (sessionPath, options) => this.#options.runtimeHost.switchSession(sessionPath, options),
				reload: () => session.reload(),
			},
			shutdownHandler: () => {
				void this.close(0);
			},
			onError: (error) => this.#emitEvent("extension_error", error),
		});
		if (!this.#closed) this.#boundSession = session;
	}

	#attachInput(): void {
		const input = (this.#options.input ?? process.stdin) as NodeJS.ReadableStream & {
			resume?: () => void;
		};
		const onData = (chunk: Buffer | string): void => {
			try {
				for (const frame of this.#decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) {
					this.#route(frame);
				}
			} catch (error) {
				const message = error instanceof StepStdioProtocolViolation ? error.message : String(error);
				this.#diagnostics(`[sdk-stdio] protocol violation: ${message}`);
				void this.close(1);
			}
		};
		const onEnd = (): void => {
			try {
				this.#decoder.end();
				void this.close(0);
			} catch (error) {
				this.#diagnostics(
					`[sdk-stdio] incomplete input: ${error instanceof Error ? error.message : String(error)}`,
				);
				void this.close(1);
			}
		};
		input.on("data", onData as (...args: unknown[]) => void);
		input.on("end", onEnd as (...args: unknown[]) => void);
		input.on("close", onEnd as (...args: unknown[]) => void);
		input.resume?.();
		this.#removeInputListeners = () => {
			input.off?.("data", onData as (...args: unknown[]) => void);
			input.off?.("end", onEnd as (...args: unknown[]) => void);
			input.off?.("close", onEnd as (...args: unknown[]) => void);
			input.pause?.();
		};
	}

	#installSignals(): void {
		for (const signal of ["SIGTERM", "SIGINT"] as const) {
			const handler = (): void => void this.close(signal === "SIGINT" ? 130 : 143);
			process.once(signal, handler);
			this.#signalCleanups.push(() => process.off(signal, handler));
		}
	}

	#route(frame: StepFrame): void {
		if (frame.kind === "response") {
			const pending = frame.replyTo ? this.#pendingRequests.get(frame.replyTo) : undefined;
			if (pending && frame.replyTo) {
				this.#pendingRequests.delete(frame.replyTo);
				clearTimeout(pending.timer);
				pending.resolve(frame);
			}
			return;
		}
		if (frame.kind !== "request") return;
		void this.#dispatch(frame).catch((error) => this.#respondError(frame, "CONFIG_INVALID", error));
	}

	async #dispatch(frame: StepFrame): Promise<void> {
		if (frame.method === "initialize") {
			this.#initialize(frame);
			return;
		}
		if (!this.#initialized) {
			this.#respondError(frame, "PROTOCOL_VIOLATION", new Error("initialize is required first"));
			return;
		}
		switch (frame.method) {
			case "query.start":
				await this.#queryStart(frame);
				return;
			case "query.input":
				await this.#queryInput(frame);
				return;
			case "query.input_end":
				await this.#queryInputEnd(frame);
				return;
			case "query.interrupt":
				await this.#queryInterrupt(frame);
				return;
			case "query.set_permission_mode":
				this.#setPermissionMode(frame);
				return;
			case "query.set_model":
				await this.#setModel(frame);
				return;
			case "query.set_max_thinking_tokens":
				this.#setThinking(frame);
				return;
			case "query.get_context_usage":
				this.#respond(frame, this.#contextUsage());
				return;
			case "runtime.supported_models":
				this.#respond(frame, this.#supportedModels());
				return;
			case "runtime.supported_commands":
				this.#respond(frame, this.#session.extensionRunner.getRegisteredCommands());
				return;
			case "runtime.supported_agents":
				this.#respond(frame, []);
				return;
			case "runtime.account_info":
				this.#respond(frame, this.#accountInfo());
				return;
			case "mcp.status":
				this.#respond(frame, []);
				return;
			case "session.list":
				await this.#sessionList(frame);
				return;
			case "session.get":
				await this.#sessionGet(frame);
				return;
			case "session.messages":
				await this.#sessionMessages(frame);
				return;
			case "session.rename":
				this.#sessionRename(frame);
				return;
			case "session.tag":
				this.#respond(frame, { ok: false, supported: false, reason: "Step has labels, not session tags." });
				return;
			case "session.compact":
				await this.#sessionCompact(frame);
				return;
			case "settings.resolve":
				this.#respond(frame, { settings: {}, sources: [] });
				return;
			case "runtime.shutdown":
				this.#respond(frame, { ok: true });
				void this.close(0);
				return;
			default:
				this.#respondError(frame, "PROTOCOL_VIOLATION", new Error(`unknown method "${frame.method}"`));
		}
	}

	#initialized = false;
	#initialize(frame: StepFrame): void {
		const payload = asRecord(frame.payload);
		const range = asRecord(payload.protocolRange);
		const min = numberOr(range.min, 1);
		const max = numberOr(range.max, 1);
		if (min > STEP_PROTOCOL_VERSION || max < STEP_PROTOCOL_VERSION) {
			this.#respondError(
				frame,
				"PROTOCOL_VERSION_UNSUPPORTED",
				new Error(`runtime speaks protocol ${STEP_PROTOCOL_VERSION}`),
			);
			void this.close(1);
			return;
		}
		this.#initialized = true;
		this.#respond(frame, {
			runtimeVersion: this.#options.runtimeVersion ?? "step",
			selectedProtocol: STEP_PROTOCOL_VERSION,
			// Reverse requests are initiated by this host and answered by the SDK
			// peer. Advertise them so callers can decide whether to send the
			// corresponding query options.
			capabilities: ["streaming-input", "sdk-tools", "permission-callback", "hooks", "sessions"],
			limits: { maxFrameBytes: STEP_MAX_FRAME_BYTES, maxConcurrentQueries: 1 },
		});
	}

	async #queryStart(frame: StepFrame): Promise<void> {
		if (this.#activeQuery && !this.#activeQuery.finished) {
			this.#respondError(frame, "SESSION_BUSY", new Error("the runtime serves one query at a time"));
			return;
		}
		const payload = asRecord(frame.payload);
		const rawOptions = asRecord(payload.options);
		if (rawOptions.permissionMode !== undefined && typeof rawOptions.permissionMode !== "string") {
			this.#respondError(frame, "CONFIG_INVALID", new Error("permissionMode must be a string"));
			return;
		}
		const options = normalizeQueryOptions(rawOptions);
		// The SDK always serializes a concrete mode. Keep the same default at the
		// runtime boundary for older/hand-written clients: without a callback,
		// approval-requiring tools must fail closed instead of running unguarded.
		options.hasPermissionCallback = options.hasPermissionCallback === true;
		options.permissionMode ??= options.hasPermissionCallback ? "default" : "dontAsk";
		if (options.permissionMode !== undefined && !PERMISSION_MODES.has(options.permissionMode)) {
			this.#respondError(frame, "CONFIG_INVALID", new Error(`unknown permission mode: ${options.permissionMode}`));
			return;
		}
		if (options.sandbox?.enabled === true) {
			this.#respondError(
				frame,
				"SANDBOX_UNAVAILABLE",
				new Error("sandbox.enabled was requested but the Step runtime has no sandbox adapter"),
			);
			return;
		}
		const optionWarnings = collectOptionWarnings(options);
		try {
			if (options.model) await this.#setModelReference(options.model);
			if (typeof options.maxThinkingTokens === "number") {
				this.#session.setThinkingLevel(thinkingLevelForTokens(options.maxThinkingTokens));
			}
		} catch (error) {
			this.#respondError(frame, "CONFIG_INVALID", error);
			return;
		}
		const query: ActiveQuery = {
			id: `q_${++this.#nextId}`,
			sessionId: this.#session.sessionId,
			startedAt: Date.now(),
			numTurns: 0,
			options,
			optionWarnings,
			streamingInput: payload.streamingInput === true,
			inputEnded: payload.streamingInput !== true,
			inputQueue: [],
			inputPumpRunning: false,
			turnsInFlight: 0,
			interrupted: false,
			errorMessage: undefined,
			finished: false,
		};
		this.#activeQuery = query;
		this.#queryBridgeCleanup?.();
		this.#queryBridgeCleanup = this.#installQueryBridges(query);
		this.#respond(frame, { queryId: query.id, sessionId: query.sessionId });
		this.#emitMessage(query, {
			type: "system",
			subtype: "init",
			session_id: query.sessionId,
			cwd: this.#options.runtimeHost.cwd,
			model: modelReference(this.#session.model),
			permissionMode: options.permissionMode,
			tools: this.#session.getActiveToolNames(),
			mcp_servers: [],
			...(query.optionWarnings.length > 0 ? { warnings: [...query.optionWarnings] } : {}),
		});
		const prompt = typeof payload.prompt === "string" ? payload.prompt : undefined;
		if (prompt !== undefined && prompt.length > 0) {
			void this.#runTurn(query, prompt);
		} else if (!query.streamingInput) {
			query.inputEnded = true;
			this.#maybeFinish(query);
		}
	}

	async #queryInput(frame: StepFrame): Promise<void> {
		const query = this.#queryForFrame(frame);
		if (!query) return;
		if (!query.streamingInput) {
			this.#respondError(frame, "CONFIG_INVALID", new Error("query.input requires streamingInput"));
			return;
		}
		if (query.inputEnded) {
			this.#respondError(frame, "PROTOCOL_VIOLATION", new Error("query.input received after query.input_end"));
			return;
		}
		const payload = asRecord(frame.payload);
		const input = readQueryInput(payload);
		if (!input) {
			this.#respondError(frame, "CONFIG_INVALID", new Error("query.input requires text"));
			return;
		}
		query.inputQueue.push(input);
		this.#respond(frame, { accepted: true });
		void this.#pumpStreamingInput(query);
	}

	async #queryInputEnd(frame: StepFrame): Promise<void> {
		const query = this.#queryForFrame(frame);
		if (!query) return;
		if (!query.streamingInput) {
			this.#respondError(frame, "CONFIG_INVALID", new Error("query.input_end requires streamingInput"));
			return;
		}
		if (query.inputEnded) {
			this.#respondError(frame, "PROTOCOL_VIOLATION", new Error("query.input_end received twice"));
			return;
		}
		query.inputEnded = true;
		this.#respond(frame, { accepted: true });
		void this.#pumpStreamingInput(query);
	}

	async #queryInterrupt(frame: StepFrame): Promise<void> {
		const query = this.#queryForFrame(frame);
		if (!query) return;
		query.interrupted = true;
		query.inputEnded = true;
		query.inputQueue.length = 0;
		await this.#session.abort();
		this.#respond(frame, { interrupted: true });
		this.#finishQuery(query, true);
	}

	#setPermissionMode(frame: StepFrame): void {
		const query = this.#queryForFrame(frame);
		if (!query) return;
		const mode = asRecord(frame.payload).mode;
		if (typeof mode !== "string" || !PERMISSION_MODES.has(mode)) {
			this.#respondError(
				frame,
				"CONFIG_INVALID",
				new Error(`unknown permission mode: ${typeof mode === "string" ? mode : String(mode)}`),
			);
			return;
		}
		query.options.permissionMode = mode;
		this.#respond(frame, { ok: true, permissionMode: mode });
	}

	/**
	 * Serialize streaming SDK turns at the protocol boundary. AgentSession owns
	 * the actual steering/follow-up queues; this small queue only prevents a
	 * burst of wire frames from invoking prompt() concurrently before Pi has
	 * observed the previous turn's settled state.
	 */
	async #pumpStreamingInput(query: ActiveQuery): Promise<void> {
		if (query.inputPumpRunning || query.finished || this.#closed) return;
		query.inputPumpRunning = true;
		try {
			while (!query.finished) {
				const next = query.inputQueue.shift();
				if (!next) {
					if (query.inputEnded && query.turnsInFlight === 0 && this.#session.isIdle) {
						this.#finishQuery(query, query.interrupted || query.errorMessage !== undefined);
					}
					return;
				}
				const completed = await this.#runTurn(query, next.text, undefined, next.images);
				if (!completed || query.finished) return;
				this.#emitMessage(query, {
					type: "status",
					session_id: query.sessionId,
					status: "turn_complete",
					detail: `turn ${query.numTurns} settled`,
				});
			}
		} finally {
			query.inputPumpRunning = false;
			if (!query.finished && (query.inputQueue.length > 0 || query.inputEnded)) {
				void this.#pumpStreamingInput(query);
			}
		}
	}

	async #runTurn(
		query: ActiveQuery,
		text: string,
		behavior?: "steer" | "followUp",
		images?: ImageContent[],
	): Promise<boolean> {
		if (query.finished || this.#closed) return false;
		query.turnsInFlight += 1;
		query.numTurns += 1;
		try {
			const promptHook = await this.#runSdkHook(query, "UserPromptSubmit", "", {
				prompt: text,
				cwd: this.#options.runtimeHost.cwd,
			});
			if (promptHook?.systemMessage) {
				this.#emitEvent("user_notification", { message: promptHook.systemMessage, type: "info" });
			}
			if (isBlockingHookOutput(promptHook)) {
				throw new Error(promptHook?.reason ?? "blocked by an SDK UserPromptSubmit hook");
			}
			await this.#session.prompt(text, {
				source: "rpc",
				...(images && images.length > 0 ? { images } : {}),
				...(behavior && this.#session.isStreaming ? { streamingBehavior: behavior } : {}),
			});
			const stopHook = await this.#runSdkHook(query, "Stop", "", {
				cwd: this.#options.runtimeHost.cwd,
			});
			if (stopHook?.systemMessage) {
				this.#emitEvent("user_notification", { message: stopHook.systemMessage, type: "info" });
			}
		} catch (error) {
			query.errorMessage = error instanceof Error ? error.message : String(error);
			this.#emitMessage(query, {
				type: "status",
				session_id: query.sessionId,
				status: "error",
				detail: error instanceof Error ? error.message : String(error),
			});
			this.#finishQuery(query, true, error);
			return false;
		} finally {
			query.turnsInFlight -= 1;
			this.#maybeFinish(query);
		}
		return true;
	}

	#maybeFinish(query: ActiveQuery): void {
		if (
			query.finished ||
			query.turnsInFlight > 0 ||
			query.inputPumpRunning ||
			query.inputQueue.length > 0 ||
			!query.inputEnded ||
			!this.#session.isIdle
		)
			return;
		this.#finishQuery(query, query.interrupted || query.errorMessage !== undefined);
	}

	#finishQuery(query: ActiveQuery, isError: boolean, cause?: unknown): void {
		if (query.finished) return;
		query.finished = true;
		const text = this.#session.getLastAssistantText() ?? "";
		this.#emitMessage(query, {
			type: "result",
			subtype: isError ? "error_during_execution" : "success",
			session_id: query.sessionId,
			duration_ms: Date.now() - query.startedAt,
			duration_api_ms: Date.now() - query.startedAt,
			is_error: isError,
			num_turns: query.numTurns,
			...(isError
				? {
						errors: [
							cause instanceof Error
								? cause.message
								: (query.errorMessage ?? (query.interrupted ? "Interrupted" : "Agent execution failed")),
						],
					}
				: { result: text }),
		});
		this.#queryBridgeCleanup?.();
		this.#queryBridgeCleanup = undefined;
	}

	/** Attach query-scoped tools and lifecycle callbacks to Pi's Agent instance. */
	#installQueryBridges(query: ActiveQuery): QueryBridgeCleanup {
		const session = this.#session;
		// The production AgentSession always exposes Pi's Agent instance. Keep the
		// adapter tolerant of lightweight embedded/test sessions that only implement
		// the public session facade; those sessions cannot host query-scoped bridges.
		const agent = session.agent;
		if (!agent) return () => {};
		const previousTools = agent.state.tools;
		const previousBeforeToolCall = agent.beforeToolCall;
		const previousAfterToolCall = agent.afterToolCall;
		const sdkTools = (query.options.sdkTools ?? []).map((descriptor) => this.#createSdkTool(query, descriptor));
		const existingNames = new Set(previousTools.map((tool) => tool.name));
		const acceptedTools = sdkTools.filter((tool) => {
			if (existingNames.has(tool.name)) {
				query.optionWarnings.push(
					`sdk tool '${tool.name}' conflicts with an existing tool and was not registered.`,
				);
				return false;
			}
			existingNames.add(tool.name);
			return true;
		});
		if (acceptedTools.length > 0) agent.state.tools = [...previousTools, ...acceptedTools];

		if (query.options.permissionMode || (query.options.hooks?.length ?? 0) > 0) {
			agent.beforeToolCall = async (context, signal) => {
				const baseResult = await previousBeforeToolCall?.(context, signal);
				if (baseResult?.block) return baseResult;
				const hook = await this.#runSdkHook(
					query,
					"PreToolUse",
					context.toolCall.name,
					{
						tool_name: context.toolCall.name,
						tool_input: jsonSafe(context.args),
						cwd: this.#options.runtimeHost.cwd,
					},
					context.toolCall.id,
				);
				if (hook?.systemMessage)
					this.#emitEvent("user_notification", { message: hook.systemMessage, type: "info" });
				if (isBlockingHookOutput(hook)) {
					return { block: true, reason: hook?.reason ?? "blocked by an SDK PreToolUse hook", terminate: true };
				}
				return await this.#approvalForTool(query, context);
			};
			agent.afterToolCall = async (context, signal) => {
				const baseResult = await previousAfterToolCall?.(context, signal);
				const hook = await this.#runSdkHook(
					query,
					"PostToolUse",
					context.toolCall.name,
					{
						tool_name: context.toolCall.name,
						tool_input: jsonSafe(context.args),
						tool_response: jsonSafe(context.result),
						cwd: this.#options.runtimeHost.cwd,
					},
					context.toolCall.id,
				);
				if (hook?.systemMessage)
					this.#emitEvent("user_notification", { message: hook.systemMessage, type: "info" });
				return baseResult;
			};
		}

		return () => {
			if (session !== this.#session) return;
			agent.state.tools = previousTools;
			agent.beforeToolCall = previousBeforeToolCall;
			agent.afterToolCall = previousAfterToolCall;
		};
	}

	#createSdkTool(query: ActiveQuery, descriptor: StepSdkToolDescriptor): AgentTool<any> {
		const name = `${descriptor.serverName}__${descriptor.toolName}`;
		return {
			name,
			label: name,
			description: descriptor.description ?? `SDK tool ${descriptor.serverName}/${descriptor.toolName}`,
			parameters: Type.Unsafe(descriptor.inputSchema ?? { type: "object", additionalProperties: true }),
			execute: async (toolCallId, params, signal) => {
				if (signal?.aborted) throw new Error(`SDK tool ${name} was aborted before dispatch`);
				const response = await this.#reverseRequest(
					"sdk_tool.invoke",
					{
						serverName: descriptor.serverName,
						toolName: descriptor.toolName,
						input: jsonSafe(params),
						toolUseId: toolCallId,
						timeoutMs: SDK_TOOL_TIMEOUT_MS,
					},
					SDK_TOOL_TIMEOUT_MS + SDK_TOOL_RESPONSE_GRACE_MS,
					query.sessionId,
				);
				if (!response) throw new Error(`SDK tool ${name} did not respond within ${SDK_TOOL_TIMEOUT_MS}ms`);
				if (response.error) throw new Error(`SDK tool ${name} failed: ${response.error.message}`);
				const payload = asRecord(response.payload);
				const content = sdkContentBlocks(payload.content);
				const text = content.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n");
				if (payload.isError === true) throw new Error(text || `SDK tool ${name} failed`);
				return { content: content.length > 0 ? content : [{ type: "text", text: "" }], details: jsonSafe(payload) };
			},
		};
	}

	async #approvalForTool(
		query: ActiveQuery,
		context: BeforeToolCallContext,
	): Promise<BeforeToolCallResult | undefined> {
		const mode = query.options.permissionMode ?? "default";
		const toolName = context.toolCall.name;
		if (!requiresSdkApproval(toolName) || mode === "bypassPermissions") return undefined;
		if (mode === "plan" || mode === "dontAsk") {
			return { block: true, reason: `tool ${toolName} is not allowed in permission mode ${mode}`, terminate: true };
		}
		if (mode === "acceptEdits" && isEditTool(toolName)) return undefined;
		if (query.options.hasPermissionCallback !== true) {
			return {
				block: true,
				reason: "approval required but no interactive permission callback is available",
				terminate: true,
			};
		}
		return this.#requestSdkApproval(query, context);
	}

	async #requestSdkApproval(
		query: ActiveQuery,
		context: BeforeToolCallContext,
	): Promise<BeforeToolCallResult | undefined> {
		const toolUseId = `perm_${++this.#nextId}`;
		const response = await this.#reverseRequest(
			"permission.request",
			{
				toolName: context.toolCall.name,
				input: jsonSafe(context.args),
				toolUseId,
				decisionReason: "tool execution requires approval",
				timeoutMs: PERMISSION_REQUEST_TIMEOUT_MS,
			},
			PERMISSION_REQUEST_TIMEOUT_MS + PERMISSION_RESPONSE_GRACE_MS,
			query.sessionId,
		);
		const payload = asRecord(response?.payload);
		if (payload.behavior === "allow") return undefined;
		const reason =
			typeof payload.message === "string" ? payload.message : "permission request timed out or was denied";
		const active = this.#activeQuery;
		if (active && !active.finished) {
			this.#emitMessage(active, {
				type: "permission_denied",
				session_id: active.sessionId,
				tool_name: context.toolCall.name,
				message: reason,
			});
		}
		return { block: true, reason, terminate: false };
	}

	async #runSdkHook(
		query: ActiveQuery,
		event: string,
		subject: string,
		input: Record<string, unknown>,
		toolUseId?: string,
	): Promise<StepSdkHookOutput | undefined> {
		for (const registration of query.options.hooks ?? []) {
			if (registration.event !== event) continue;
			for (const matcher of registration.matchers) {
				if (!matchesSdkHookMatcher(matcher.matcher, subject)) continue;
				const response = await this.#reverseRequest(
					"hook.invoke",
					{ event, matcherIndex: matcher.index, toolUseId, input: jsonSafe(input) },
					SDK_HOOK_TIMEOUT_MS + SDK_HOOK_RESPONSE_GRACE_MS,
					query.sessionId,
				);
				if (!response) return { decision: "block", reason: `SDK hook ${event} timed out` };
				if (response.error) return { decision: "block", reason: response.error.message };
				const output = asRecord(response.payload) as StepSdkHookOutput;
				if (isBlockingHookOutput(output)) return output;
			}
		}
		return undefined;
	}

	#queryForFrame(frame: StepFrame): ActiveQuery | undefined {
		const query = this.#activeQuery;
		const payload = asRecord(frame.payload);
		const requested = frame.sessionId ?? (typeof payload.queryId === "string" ? payload.queryId : undefined);
		if (
			!query ||
			query.finished ||
			(requested !== undefined && requested !== query.id && requested !== query.sessionId)
		) {
			this.#respondError(frame, "SESSION_NOT_FOUND", new Error("no matching active query"));
			return undefined;
		}
		return query;
	}

	async #setModel(frame: StepFrame): Promise<void> {
		const query = this.#queryForFrame(frame);
		if (!query) return;
		const payload = asRecord(frame.payload);
		const reference = typeof payload.model === "string" ? payload.model : "";
		try {
			await this.#setModelReference(reference);
		} catch (error) {
			this.#respondError(frame, "MODEL_UNAVAILABLE", error);
			return;
		}
		this.#respond(frame, { ok: true, model: modelReference(this.#session.model) });
	}

	async #setModelReference(reference: string): Promise<void> {
		if (!reference) throw new Error("model is required");
		const slash = reference.indexOf("/");
		const provider = slash > 0 ? reference.slice(0, slash) : (this.#session.model?.provider ?? STEP_DEFAULT_PROVIDER);
		const modelId = slash > 0 ? reference.slice(slash + 1) : reference;
		const model = this.#session.modelRuntime.getModel(provider, modelId) as Model<any> | undefined;
		if (!model) {
			throw new Error(`model ${reference} is not available`);
		}
		await this.#session.setModel(model);
	}

	#setThinking(frame: StepFrame): void {
		const query = this.#queryForFrame(frame);
		if (!query) return;
		const payload = asRecord(frame.payload);
		const tokens = typeof payload.tokens === "number" ? payload.tokens : 0;
		const level: ThinkingLevel =
			tokens <= 0
				? "off"
				: tokens < 2_000
					? "minimal"
					: tokens < 8_000
						? "low"
						: tokens < 20_000
							? "medium"
							: tokens < 50_000
								? "high"
								: "xhigh";
		this.#session.setThinkingLevel(level);
		this.#respond(frame, { ok: true, applied: true, level });
	}

	#contextUsage(): Record<string, unknown> {
		const usage = this.#session.getContextUsage();
		if (!usage) return {};
		return {
			input_tokens: usage.tokens,
			max_input_tokens: usage.contextWindow,
			percent_used: usage.percent === null ? null : usage.percent / 100,
		};
	}

	#supportedModels(): Array<Record<string, unknown>> {
		return this.#session.modelRuntime.getAvailableSnapshot().map((model) => ({
			id: `${model.provider}/${model.id}`,
			provider: model.provider,
			model: model.id,
			displayName: model.name ?? model.id,
		}));
	}

	#accountInfo(): Record<string, unknown> {
		return Object.fromEntries(
			this.#session.modelRuntime
				.getProviders()
				.map((provider) => [provider.id, this.#session.modelRuntime.getProviderAuthStatus(provider.id)]),
		);
	}

	async #sessionList(frame: StepFrame): Promise<void> {
		const manager = this.#session.sessionManager;
		const sessions = manager.isPersisted()
			? await listStepSessions(manager.getCwd(), {
					agentDir: this.#options.runtimeHost.services.agentDir,
					sessionDir: manager.getSessionDir(),
				})
			: [];
		const limit = asRecord(frame.payload).limit;
		const selected = typeof limit === "number" && limit >= 0 ? sessions.slice(0, limit) : sessions;
		this.#respond(frame, {
			sessions: selected.map((session) => ({
				id: session.id,
				cwd: session.cwd,
				name: session.name ?? null,
				created_at: session.created.toISOString(),
				updated_at: session.modified.toISOString(),
				message_count: session.messageCount,
				preview: session.firstMessage,
			})),
		});
	}

	async #sessionGet(frame: StepFrame): Promise<void> {
		const id = asRecord(frame.payload).sessionId;
		if (typeof id !== "string") {
			this.#respondError(frame, "SESSION_NOT_FOUND", new Error("sessionId is required"));
			return;
		}
		const manager = this.#session.sessionManager;
		const sessions = manager.isPersisted()
			? await listStepSessions(manager.getCwd(), {
					agentDir: this.#options.runtimeHost.services.agentDir,
					sessionDir: manager.getSessionDir(),
				})
			: [];
		const found = sessions.find((session) => session.id === id);
		this.#respond(frame, {
			session: found
				? { id: found.id, cwd: found.cwd, name: found.name ?? null, updated_at: found.modified.toISOString() }
				: null,
		});
	}

	async #sessionMessages(frame: StepFrame): Promise<void> {
		const payload = asRecord(frame.payload);
		const id = typeof payload.sessionId === "string" ? payload.sessionId : this.#session.sessionId;
		if (id !== this.#session.sessionId) {
			this.#respondError(frame, "SESSION_NOT_FOUND", new Error("only the active session can be inspected"));
			return;
		}
		let messages = this.#session.messages.map((message, index) => this.#projectMessage(message, id, index));
		if (typeof payload.offset === "number") messages = messages.slice(Math.max(0, payload.offset));
		if (typeof payload.limit === "number") messages = messages.slice(0, Math.max(0, payload.limit));
		this.#respond(frame, { messages });
	}

	#sessionRename(frame: StepFrame): void {
		const payload = asRecord(frame.payload);
		const id = typeof payload.sessionId === "string" ? payload.sessionId : this.#session.sessionId;
		if (id !== this.#session.sessionId) {
			this.#respondError(frame, "SESSION_NOT_FOUND", new Error("only the active session can be renamed"));
			return;
		}
		const name =
			typeof payload.name === "string" ? payload.name : typeof payload.title === "string" ? payload.title : "";
		this.#session.setSessionName(name);
		this.#respond(frame, { ok: true, name: this.#session.sessionName ?? null });
	}

	async #sessionCompact(frame: StepFrame): Promise<void> {
		const id = asRecord(frame.payload).sessionId;
		if (id !== undefined && id !== this.#session.sessionId) {
			this.#respondError(frame, "SESSION_NOT_FOUND", new Error("only the active session can be compacted"));
			return;
		}
		try {
			const result = await this.#session.compact();
			this.#respond(frame, { ok: true, result });
		} catch (error) {
			this.#respondError(frame, "CONFIG_INVALID", error);
		}
	}

	#onSessionEvent(event: AgentSessionEvent): void {
		const query = this.#activeQuery;
		if (!query || query.finished) return;
		if (event.type === "message_start" && event.message.role === "assistant") {
			this.#emitMessage(query, this.#projectMessage(event.message, query.sessionId, this.#sequence));
		} else if (event.type === "message_update") {
			const update = event.assistantMessageEvent as { type?: string; delta?: string };
			if (
				query.options.includePartialMessages === true &&
				update.type === "text_delta" &&
				typeof update.delta === "string"
			) {
				this.#emitMessage(query, {
					type: "stream_event",
					session_id: query.sessionId,
					parent_tool_use_id: null,
					event: { type: "content_block_delta", delta: { type: "text_delta", text: update.delta } },
				});
			}
		} else if (event.type === "message_end" && event.message.role === "assistant") {
			this.#emitMessage(query, this.#projectMessage(event.message, query.sessionId, this.#sequence));
		} else if (event.type === "tool_execution_end") {
			this.#emitMessage(query, {
				type: "user",
				session_id: query.sessionId,
				parent_tool_use_id: null,
				message: {
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: event.toolCallId,
							content: toolResultText(event.result),
							is_error: event.isError,
						},
					],
				},
			});
		} else if (event.type === "agent_settled") {
			this.#maybeFinish(query);
		}
	}

	#emitMessage(query: ActiveQuery, message: Record<string, unknown>): void {
		this.#write({
			protocol: STEP_PROTOCOL_NAME,
			version: STEP_PROTOCOL_VERSION,
			kind: "event",
			id: `evt_${++this.#nextId}`,
			method: "query.message",
			sessionId: query.sessionId,
			sequence: ++this.#sequence,
			payload: { queryId: query.id, message },
		});
	}

	#emitEvent(method: string, payload: unknown): void {
		const query = this.#activeQuery;
		this.#write({
			protocol: STEP_PROTOCOL_NAME,
			version: STEP_PROTOCOL_VERSION,
			kind: "event",
			id: `evt_${++this.#nextId}`,
			method,
			...(query ? { sessionId: query.sessionId } : {}),
			sequence: ++this.#sequence,
			payload: jsonSafe(payload),
		});
	}

	#projectMessage(message: AgentMessage, sessionId: string, index: number): Record<string, unknown> {
		if (message.role === "user") {
			return {
				type: "user",
				session_id: sessionId,
				parent_tool_use_id: null,
				message: { role: "user", content: jsonSafe(message.content) },
			};
		}
		if (message.role === "toolResult") {
			return {
				type: "user",
				session_id: sessionId,
				parent_tool_use_id: null,
				message: {
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: message.toolCallId,
							content: toolResultText(message),
							is_error: message.isError,
						},
					],
				},
			};
		}
		if (message.role === "assistant") {
			return {
				type: "assistant",
				session_id: sessionId,
				parent_tool_use_id: null,
				message: {
					id: `msg_${index}`,
					role: "assistant",
					content: projectContent(message.content),
					model: message.model,
					...(message.usage ? { usage: projectUsage(message.usage) } : {}),
				},
			};
		}
		return { type: message.role, session_id: sessionId, message: jsonSafe(message) };
	}

	#createUiContext(sessionId = this.#session.sessionId): ExtensionUIContext {
		const host = this;
		const dialog = <T>(
			method: string,
			payload: Record<string, unknown>,
			fallback: T,
			opts?: ExtensionUIDialogOptions,
		): Promise<T> => {
			if (opts?.signal?.aborted) return Promise.resolve(fallback);
			return this.#reverseRequest(method, payload, opts?.timeout ?? 60_000, sessionId).then((frame) => {
				const value = asRecord(frame?.payload);
				return (
					typeof value.value === "string"
						? value.value
						: typeof value.confirmed === "boolean"
							? value.confirmed
							: fallback
				) as T;
			});
		};
		return {
			select: (title, options, opts) =>
				dialog("user_dialog.request", { kind: "select", title, options }, undefined, opts),
			confirm: (title, message, opts) =>
				dialog("user_dialog.request", { kind: "confirm", title, message }, false, opts),
			input: (title, placeholder, opts) =>
				dialog("user_dialog.request", { kind: "input", title, placeholder }, undefined, opts),
			notify: (message, type) => this.#emitEvent("user_notification", { message, type }),
			onTerminalInput: () => () => {},
			setStatus: (key, text) => this.#emitEvent("ui.status", { key, text }),
			setWorkingMessage: (message) => this.#emitEvent("ui.working", { message }),
			setWorkingVisible: (visible) => this.#emitEvent("ui.working", { visible }),
			setWorkingIndicator: (options?: WorkingIndicatorOptions) => this.#emitEvent("ui.working", { options }),
			setHiddenThinkingLabel: (label) => this.#emitEvent("ui.thinking_label", { label }),
			setWidget: (key, content, options?: ExtensionWidgetOptions) =>
				this.#emitEvent("ui.widget", {
					key,
					content: typeof content === "function" ? undefined : content,
					placement: options?.placement,
				}),
			setFooter: () => {},
			setHeader: () => {},
			setTitle: (title) => this.#emitEvent("ui.title", { title }),
			custom: async () => undefined as never,
			pasteToEditor: (text) => this.#emitEvent("ui.editor_text", { text }),
			setEditorText: (text) => this.#emitEvent("ui.editor_text", { text }),
			getEditorText: () => "",
			editor: (title, prefill) => dialog("user_dialog.request", { kind: "editor", title, prefill }, undefined),
			addAutocompleteProvider: () => {},
			setEditorComponent: () => {},
			getEditorComponent: () => undefined,
			get theme(): Theme {
				return host.#session.extensionRunner.getUIContext().theme;
			},
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false, error: "Theme switching is unavailable over sdk-stdio" }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		};
	}

	#reverseRequest(
		method: string,
		payload: unknown,
		timeoutMs: number,
		sessionId = this.#session.sessionId,
	): Promise<StepFrame | undefined> {
		const id = `req_${++this.#nextId}`;
		return new Promise((resolve) => {
			const timer = setTimeout(
				() => {
					this.#pendingRequests.delete(id);
					resolve(undefined);
				},
				Math.max(1, timeoutMs),
			);
			this.#pendingRequests.set(id, { resolve, timer });
			this.#write({
				protocol: STEP_PROTOCOL_NAME,
				version: STEP_PROTOCOL_VERSION,
				kind: "request",
				id,
				method,
				sessionId,
				payload: jsonSafe(payload),
			});
		});
	}

	#respond(frame: StepFrame, payload: unknown): void {
		this.#write({
			protocol: STEP_PROTOCOL_NAME,
			version: STEP_PROTOCOL_VERSION,
			kind: "response",
			id: `res_${++this.#nextId}`,
			replyTo: frame.id,
			sessionId: frame.sessionId,
			payload: jsonSafe(payload),
		});
	}

	#respondError(frame: StepFrame, code: string, error: unknown): void {
		this.#write({
			protocol: STEP_PROTOCOL_NAME,
			version: STEP_PROTOCOL_VERSION,
			kind: "response",
			id: `res_${++this.#nextId}`,
			replyTo: frame.id,
			sessionId: frame.sessionId,
			error: { code, message: error instanceof Error ? error.message : String(error) },
		});
	}

	#write(frame: StepFrame): void {
		if (this.#closed) return;
		let encoded: Buffer;
		try {
			encoded = encodeStepStdioFrame(frame, STEP_MAX_FRAME_BYTES);
		} catch (error) {
			this.#report(error);
			return;
		}
		const output = this.#options.output ?? process.stdout;
		const writer = this.#options.writeFrame ?? ((chunk: Buffer) => output.write(chunk));
		this.#writeTail = this.#writeTail.then(async () => {
			const accepted = writer(encoded);
			if (accepted === false) {
				await once(output as NodeJS.EventEmitter, "drain");
			}
		});
		void this.#writeTail.catch((error) => this.#report(error));
	}

	async #shutdown(code: number): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#removeInputListeners?.();
		this.#removeSessionListener?.();
		this.#removeRuntimeListener?.();
		// Do not let a replacement callback start another bind while shutdown is
		// waiting for the current one to settle. The runtime remains active until
		// `dispose()` below, so clear the callback before disposing it.
		this.#options.runtimeHost.setRebindSession?.(undefined);
		await this.#bindingTail.catch((error) => this.#report(error));
		for (const cleanup of this.#signalCleanups.splice(0)) cleanup();
		for (const [id, pending] of this.#pendingRequests) {
			clearTimeout(pending.timer);
			pending.resolve(undefined);
			this.#pendingRequests.delete(id);
		}
		this.#activeQuery &&
			!this.#activeQuery.finished &&
			(await this.#session.abort().catch((error) => this.#report(error)));
		this.#queryBridgeCleanup?.();
		this.#queryBridgeCleanup = undefined;
		await this.#options.runtimeHost.dispose().catch((error) => this.#report(error));
		await this.#writeTail.catch(() => {});
		// The host may be used directly (without a parent SDK keeping a request
		// loop alive). Mark the requested status and let Node drain remaining
		// cleanup handles naturally.
		process.exitCode = code;
		this.#resolveClosed();
		this.#options.onExitRequested?.(code);
	}

	#report(error: unknown): void {
		this.#diagnostics(`[sdk-stdio] ${error instanceof Error ? error.message : String(error)}`);
	}
}

function asRecord(value: unknown): Record<string, any> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

function numberOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Accept both Step's compact `{ text }` shape and the SDK's Anthropic-shaped
 * `{ message: { message: { content } } }` payload. Keeping this normalization
 * at the wire boundary lets the AgentSession continue to own content handling.
 */
function readQueryInput(payload: Record<string, any>): { text: string; images?: ImageContent[] } | undefined {
	if (typeof payload.text === "string") return { text: payload.text };
	if (typeof payload.message === "string") return { text: payload.message };

	const outer = asRecord(payload.message);
	const nested = asRecord(outer.message);
	const content = nested.content ?? outer.content ?? payload.content;
	if (typeof content === "string") return { text: content };
	if (!Array.isArray(content)) return undefined;

	const textParts: string[] = [];
	const images: ImageContent[] = [];
	for (const block of content) {
		const value = asRecord(block);
		if (value.type === "text" && typeof value.text === "string") {
			textParts.push(value.text);
			continue;
		}
		if (value.type !== "image") continue;
		const source = asRecord(value.source);
		const data =
			typeof value.data === "string" ? value.data : typeof source.data === "string" ? source.data : undefined;
		const mimeType =
			typeof value.mimeType === "string"
				? value.mimeType
				: typeof source.media_type === "string"
					? source.media_type
					: typeof source.mimeType === "string"
						? source.mimeType
						: undefined;
		if (data && mimeType) images.push({ type: "image", data, mimeType });
	}
	if (textParts.length === 0 && images.length === 0) return undefined;
	return { text: textParts.join(""), ...(images.length > 0 ? { images } : {}) };
}

function normalizeQueryOptions(value: unknown): StepQueryOptions {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
	const options = value as Record<string, unknown>;
	return {
		...options,
		...(typeof options.permissionMode === "string" ? { permissionMode: options.permissionMode } : {}),
		...(typeof options.hasPermissionCallback === "boolean"
			? { hasPermissionCallback: options.hasPermissionCallback }
			: {}),
		...(typeof options.includePartialMessages === "boolean"
			? { includePartialMessages: options.includePartialMessages }
			: {}),
		...(typeof options.model === "string" ? { model: options.model } : {}),
		...(typeof options.maxThinkingTokens === "number" ? { maxThinkingTokens: options.maxThinkingTokens } : {}),
		...(Array.isArray(options.sdkTools)
			? {
					sdkTools: options.sdkTools.filter(isSdkToolDescriptor),
				}
			: {}),
		...(Array.isArray(options.hooks) ? { hooks: options.hooks.filter(isSdkHookRegistration) } : {}),
	};
}

function isSdkToolDescriptor(value: unknown): value is StepSdkToolDescriptor {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const descriptor = value as Record<string, unknown>;
	return (
		typeof descriptor.serverName === "string" &&
		descriptor.serverName.length > 0 &&
		typeof descriptor.toolName === "string"
	);
}

function isSdkHookRegistration(value: unknown): value is StepSdkHookRegistration {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const registration = value as Record<string, unknown>;
	return typeof registration.event === "string" && Array.isArray(registration.matchers);
}

function collectOptionWarnings(options: StepQueryOptions): string[] {
	const warnings: string[] = [];
	const unsupported = [
		["fallbackModel", "automatic fallback model selection is not supported"],
		["additionalDirectories", "additional directory boundaries are not supported"],
		["mcpServers", "per-query MCP server configuration is not supported by this in-process host"],
		["plugins", "per-query plugin loading is not supported by this in-process host"],
		["agents", "per-query delegated agent definitions are not supported by this in-process host"],
	] as const;
	for (const [key, reason] of unsupported) {
		if (options[key] !== undefined) warnings.push(`${key} accepted but inert: ${reason}.`);
	}
	if (options.systemPrompt !== undefined) {
		warnings.push("systemPrompt overrides are not supported; the Step session system prompt remains active.");
	}
	if (options.appendSystemPrompt !== undefined) {
		warnings.push("appendSystemPrompt is not supported for an already-created Step session.");
	}
	if (options.maxTurns !== undefined) {
		warnings.push("maxTurns is not enforced by this adapter; Step's configured agent loop limit remains active.");
	}
	if (options.permissionMode === "bypassPermissions") {
		warnings.push(
			"permissionMode=bypassPermissions skips SDK approval callbacks; use it only in an isolated environment.",
		);
	}
	if (options.outputFormat !== undefined) {
		warnings.push("outputFormat is not validated by this adapter; the final text is returned unchanged.");
	}
	if (options.hooks) {
		const supported = new Set(["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop"]);
		const unsupportedHooks = [
			...new Set(options.hooks.map((hook) => hook.event).filter((event) => !supported.has(event))),
		];
		if (unsupportedHooks.length > 0)
			warnings.push(`hook events ${unsupportedHooks.join(", ")} have no Step lifecycle counterpart.`);
	}
	if (options.sandbox) {
		const inert = Object.keys(options.sandbox).filter((key) => key !== "enabled");
		if (inert.length > 0) warnings.push(`sandbox.${inert.join(", sandbox.")} is not configured by the Step host.`);
	}
	return warnings;
}

function thinkingLevelForTokens(tokens: number): ThinkingLevel {
	if (tokens <= 0) return "off";
	if (tokens < 2_000) return "minimal";
	if (tokens < 8_000) return "low";
	if (tokens < 20_000) return "medium";
	if (tokens < 50_000) return "high";
	return "xhigh";
}

function requiresSdkApproval(toolName: string): boolean {
	return !isReadOnlyTool(toolName);
}

function isReadOnlyTool(toolName: string): boolean {
	return new Set(["read", "grep", "find", "ls", "get_file", "search_files"]).has(toolName);
}

function isEditTool(toolName: string): boolean {
	return toolName === "edit" || toolName === "write" || toolName === "write_file" || toolName === "edit_file";
}

function matchesSdkHookMatcher(matcher: string | undefined, subject: string): boolean {
	if (!matcher) return true;
	try {
		return new RegExp(matcher).test(subject);
	} catch {
		return matcher === subject;
	}
}

function isBlockingHookOutput(output: StepSdkHookOutput | undefined): boolean {
	return output?.decision === "block" || output?.continue === false || output?.interrupt === true;
}

function sdkContentBlocks(value: unknown): Array<TextContent | ImageContent> {
	if (!Array.isArray(value)) {
		return typeof value === "string" ? [{ type: "text", text: value }] : [];
	}
	const result: Array<TextContent | ImageContent> = [];
	for (const block of value) {
		const item = asRecord(block);
		if (item.type === "text" && typeof item.text === "string") {
			result.push({ type: "text", text: item.text });
		} else if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
			result.push({ type: "image", data: item.data, mimeType: item.mimeType });
		}
	}
	return result;
}

function modelReference(model: Model<any> | undefined): string {
	return model ? `${model.provider}/${model.id}` : "unknown";
}

function projectContent(content: unknown): unknown[] {
	if (!Array.isArray(content)) return [{ type: "text", text: String(content ?? "") }];
	return content.map((block) => {
		const item = asRecord(block);
		if (item.type === "toolCall")
			return { type: "tool_use", id: item.id, name: item.name, input: item.arguments ?? {} };
		if (item.type === "thinking") return { type: "thinking", thinking: item.thinking ?? item.text ?? "" };
		return jsonSafe(item);
	});
}

function projectUsage(usage: unknown): Record<string, unknown> {
	const value = asRecord(usage);
	return {
		...(typeof value.input === "number" ? { input_tokens: value.input } : {}),
		...(typeof value.output === "number" ? { output_tokens: value.output } : {}),
		...(typeof value.cacheRead === "number" ? { cache_read_input_tokens: value.cacheRead } : {}),
		...(typeof value.cacheWrite === "number" ? { cache_creation_input_tokens: value.cacheWrite } : {}),
	};
}

function toolResultText(result: unknown): string {
	const value = asRecord(result);
	if (Array.isArray(value.content)) {
		return value.content
			.map((part) => asRecord(part).text)
			.filter((text): text is string => typeof text === "string")
			.join("");
	}
	return typeof value.error === "string" ? value.error : JSON.stringify(jsonSafe(result));
}

function jsonSafe(value: unknown, seen = new WeakSet<object>()): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "undefined") return null;
	if (typeof value !== "object") return `[${typeof value}]`;
	if (seen.has(value)) return "[Circular]";
	seen.add(value);
	if (Array.isArray(value)) {
		const result = value.map((item) => jsonSafe(item, seen));
		seen.delete(value);
		return result;
	}
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) result[key] = jsonSafe(item, seen);
	seen.delete(value);
	return result;
}
