import type { AssistantMessage, Usage } from "@step-harness/providers";
import type {
	AgentEndEvent,
	AgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
	MessageEndEvent,
	SessionCompactEvent,
	SessionStartEvent,
	ToolCallEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolResultEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "../core/extensions/types.ts";
import type {
	ModelRequestCompleted,
	ModelRequestObserver,
	ModelRequestStarted,
} from "../core/model-request-observer.ts";
import type {
	StepTelemetryPrimitive as RegistryTelemetryPrimitive,
	StepTelemetryEventPayloads,
	StepTelemetryKnownEventName,
} from "./telemetry-events.ts";
import { isStepTraceRequestAllowedForRuntime } from "./trace-headers.ts";

/** Event understood by the legacy Step analytics collector for model calls. */
export type StepModelRequestEventName = Extract<StepTelemetryKnownEventName, "model_request_completed">;

/** All events that are part of the reviewed Step telemetry contract. */
export type StepTelemetryEventName = StepTelemetryKnownEventName;

export type StepTelemetryPrimitive = RegistryTelemetryPrimitive;
export type StepTelemetryProperties = Readonly<Record<string, StepTelemetryPrimitive>>;

/**
 * Known-event payloads are partial at the producer boundary.  This keeps
 * adapters useful while a request is being assembled, while still rejecting a
 * misspelled field on a known event.  The runtime fills only the fields a
 * producer actually knows; the wire contract remains flat and allowlisted.
 */
export type StepTelemetryPropertiesFor<K extends StepTelemetryEventName> = Readonly<
	Partial<StepTelemetryEventPayloads[K]>
>;

export type { StepTelemetryKnownEventName } from "./telemetry-events.ts";

/** Ambient identity updates stamped onto subsequent telemetry envelopes. */
export interface StepTelemetryContextPatch {
	readonly sessionId?: string;
	/** Ambient build channel; accepted for parity with the legacy client. */
	readonly channel?: string;
	/** Product version stamped on the envelope. */
	readonly version?: string;
	/** Runtime platform stamped on the envelope. */
	readonly platform?: string;
	readonly deviceId?: string;
	readonly uid?: string;
	readonly username?: string;
	readonly commit?: string;
}

/** Per-record context override. Session identity is snapshotted at track time. */
export interface StepTelemetryTrackOptions {
	/** Explicit session id for this record; falls back to the foreground session. */
	readonly sessionId?: string;
	/** Compatibility shape for embedders that already pass a context object. */
	readonly context?: Pick<StepTelemetryContextPatch, "sessionId">;
}

/** Small injection seam for the host's existing telemetry client. */
export interface StepTelemetryReporter {
	/** Runtime-compatible reporter surface. Use `trackStepTelemetry` for static payload checking. */
	track(
		event: StepTelemetryEventName,
		properties: StepTelemetryProperties,
		options?: StepTelemetryTrackOptions,
	): void | Promise<void>;
	/**
	 * Compatibility escape hatch for a host that emits an event not yet in the
	 * reviewed registry. New Step producers should add the event first.
	 */
	setContext?(patch: StepTelemetryContextPatch): void;
}

/** Statically typed producer helper for the reviewed event registry. */
export function trackStepTelemetry<K extends StepTelemetryEventName>(
	reporter: StepTelemetryReporter,
	event: K,
	properties: StepTelemetryPropertiesFor<K>,
	options?: StepTelemetryTrackOptions,
): void {
	try {
		void Promise.resolve(reporter.track(event, properties as StepTelemetryProperties, options)).catch(
			() => undefined,
		);
	} catch {
		// Telemetry must never affect the caller's work.
	}
}

/** Values used by the permission events shared with the legacy Step collector. */
export interface StepPermissionDecisionTelemetry {
	readonly toolName: string;
	/** Policy result (`allow`, `confirm`, or `deny`). `action` is accepted as an alias. */
	readonly mode?: string;
	readonly action?: string;
	readonly risk?: string;
	readonly hazardous?: boolean;
}

export interface StepPermissionApprovalTelemetry {
	readonly toolName: string;
	readonly decision: string;
	readonly risk?: string;
}

/** Context-independent knobs for the lifecycle adapter. */
export interface StepLifecycleTelemetryOptions {
	/** Injectable monotonic-ish clock, in milliseconds, for deterministic tests. */
	readonly now?: () => number;
	/** Override the mode dimension used by `session_started`; defaults to `normal`. */
	readonly agentMode?: string | ((event: SessionStartEvent, ctx: ExtensionContext) => string);
	/** Override resume detection when the host has a richer persisted-session signal. */
	readonly isResumed?: (event: SessionStartEvent, ctx: ExtensionContext) => boolean;
}

/** Handlers can be passed directly to the corresponding `pi.on()` calls. */
export interface StepLifecycleTelemetryHandlers {
	onSessionStart(event: SessionStartEvent, ctx: ExtensionContext): void;
	onAgentStart(event: AgentStartEvent, ctx: ExtensionContext): void;
	onAgentEnd(event: AgentEndEvent, ctx: ExtensionContext): void;
	onTurnStart(event: TurnStartEvent, ctx: ExtensionContext): void;
	onTurnEnd(event: TurnEndEvent, ctx: ExtensionContext): void;
	onInput(event: InputEvent, ctx: ExtensionContext): void;
	onSessionCompact(event: SessionCompactEvent, ctx: ExtensionContext): void;
	onMessageEnd(event: MessageEndEvent, ctx: ExtensionContext): void;
	onToolCall(event: ToolCallEvent, ctx: ExtensionContext): void;
	onToolResult(event: ToolResultEvent, ctx: ExtensionContext): void;
	onToolExecutionStart(event: ToolExecutionStartEvent, ctx: ExtensionContext): void;
	onToolExecutionEnd(event: ToolExecutionEndEvent, ctx: ExtensionContext): void;
}

/**
 * Lifecycle adapter for Step's product telemetry.
 *
 * Pi already owns the event loop and emits a richer event stream than the old
 * Step CLI. This adapter only pairs those events and projects the small,
 * primitive payloads consumed by Step analytics. It has no dependency on the
 * process telemetry runtime, so an extension or an embedding host can inject
 * whichever reporter it already owns.
 *
 * `agent_start`/`agent_end` delimit one product turn (which may contain several
 * Pi `turn_start`/`turn_end` iterations). The latter are used solely to count
 * `step_count`; this preserves the old goal/turn metric rather than emitting a
 * row for every model/tool iteration.
 */
export interface StepLifecycleTelemetry extends StepLifecycleTelemetryHandlers {
	/** Register all lifecycle callbacks on a Pi extension API in one call. */
	register(api: Pick<ExtensionAPI, "on">): void;
	/** Record a policy decision, including allows. */
	recordPermissionDecision(info: StepPermissionDecisionTelemetry): void;
	/** Record the answer to a confirmation prompt. */
	recordPermissionApproval(info: StepPermissionApprovalTelemetry): void;
	/** Mark a tool call as blocked so its completion is classified as denied. */
	markToolBlocked(toolCallId: string): void;
	/** Drop in-flight state when a host tears down a session without agent_end. */
	reset(): void;
}

interface ActiveLifecycleTurn {
	startedAt: number;
	stepCount: number;
	toolCallIds: Set<string>;
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	seenAssistantMessages: WeakSet<object>;
}

interface PendingToolCall {
	toolName: string;
	startedAt: number;
}

const PERMISSION_DENIED_CODE = "PERMISSION_DENIED";
const KNOWN_TOOL_ERROR_CODES = new Set([
	"BLOCKED_BY_PLUGIN",
	"INVALID_ARGUMENTS",
	PERMISSION_DENIED_CODE,
	"TOOL_EXECUTION_FAILED",
	"UNKNOWN_TOOL",
]);

/**
 * Create a best-effort lifecycle reporter. Every callback is synchronous from
 * Pi's perspective; reporter promises are deliberately not awaited.
 */
export function createStepLifecycleTelemetry(
	reporter: StepTelemetryReporter,
	options: StepLifecycleTelemetryOptions = {},
): StepLifecycleTelemetry {
	const now = options.now ?? Date.now;
	let activeTurn: ActiveLifecycleTurn | undefined;
	const pendingTools = new Map<string, PendingToolCall>();
	const completedToolIds = new Set<string>();
	const blockedToolIds = new Set<string>();
	let activeSessionId: string | undefined;

	const track = <K extends StepTelemetryEventName>(
		event: K,
		properties: StepTelemetryPropertiesFor<K>,
		options?: StepTelemetryTrackOptions,
	): void => {
		safeTrack(reporter, event, properties as StepTelemetryProperties, {
			sessionId: options?.sessionId ?? activeSessionId,
		});
	};

	const readNow = (): number => {
		try {
			const value = now();
			return Number.isFinite(value) ? value : Date.now();
		} catch {
			return Date.now();
		}
	};

	const ensureTurn = (startedAt = readNow()): ActiveLifecycleTurn => {
		if (activeTurn) return activeTurn;
		activeTurn = {
			startedAt,
			stepCount: 0,
			toolCallIds: new Set(),
			inputTokens: 0,
			cachedInputTokens: 0,
			outputTokens: 0,
			seenAssistantMessages: new WeakSet(),
		};
		return activeTurn;
	};

	const addAssistantUsage = (message: AssistantMessage | { usage?: Usage }): void => {
		const turn = activeTurn;
		if (!turn || !message || typeof message !== "object") return;
		const objectMessage = message as object;
		if (turn.seenAssistantMessages.has(objectMessage)) return;
		turn.seenAssistantMessages.add(objectMessage);
		const usage = message.usage;
		if (!usage || typeof usage !== "object") return;
		// Accept Pi's camelCase Usage shape and the old snake_case shape. The latter
		// keeps this adapter useful to hosts that proxy legacy Step events.
		turn.inputTokens += readNonNegativeNumber(usage, "input", "prompt_tokens");
		turn.cachedInputTokens +=
			readNonNegativeNumber(usage, "cacheRead", "cache_read_input_tokens") +
			readNonNegativeNumber(usage, "cacheWrite", "cache_creation_input_tokens");
		turn.outputTokens += readNonNegativeNumber(usage, "output", "completion_tokens");
	};

	const trackToolCompletion = (
		toolCallId: string,
		toolName: string,
		isError: boolean,
		errorCode: string | undefined,
	): void => {
		const normalizedId = safeDimension(toolCallId, "");
		if (!normalizedId || completedToolIds.has(normalizedId)) return;
		const pending = pendingTools.get(normalizedId);
		if (!pending) return;
		pendingTools.delete(normalizedId);
		completedToolIds.add(normalizedId);
		const normalizedCode = normalizeToolErrorCode(errorCode, blockedToolIds.has(normalizedId), isError);
		blockedToolIds.delete(normalizedId);
		track("tool_call_completed", {
			tool_name: safeDimension(toolName || pending.toolName),
			outcome:
				normalizedCode === PERMISSION_DENIED_CODE || normalizedCode === "denied"
					? "denied"
					: isError
						? "error"
						: "ok",
			error_code: normalizedCode,
			duration_ms: safeMetric(readNow() - pending.startedAt),
		});
	};

	const handlers: StepLifecycleTelemetryHandlers = {
		onSessionStart(event, ctx) {
			activeSessionId = undefined;
			try {
				const sessionId = ctx.sessionManager.getSessionId();
				activeSessionId = safeDimension(sessionId ?? "", "") || undefined;
				if (activeSessionId) reporter.setContext?.({ sessionId: activeSessionId });
			} catch {
				// Session identity is diagnostic context; a stale host must not block UI.
			}
			const resumed = options.isResumed
				? safeBoolean(() => options.isResumed!(event, ctx))
				: defaultResumed(event, ctx);
			const agentModeResolver = options.agentMode;
			const agentMode =
				typeof agentModeResolver === "function"
					? safeDimension(safeString(() => agentModeResolver(event, ctx)))
					: safeDimension(agentModeResolver ?? "normal");
			const uiMode = mapUiMode(ctx.mode);
			// A fresh session always starts a fresh aggregate, even when a host reuses
			// the extension instance for `/new` or `/resume`.
			activeTurn = undefined;
			pendingTools.clear();
			completedToolIds.clear();
			blockedToolIds.clear();
			track("session_started", {
				resumed,
				agent_mode: agentMode,
				ui_mode: uiMode,
			});
		},

		onAgentStart(_event, _ctx) {
			// A well-formed Pi loop cannot nest agents. Reset defensively if a host
			// starts another run before sending the previous terminal event.
			activeTurn = {
				startedAt: readNow(),
				stepCount: 0,
				toolCallIds: new Set(),
				inputTokens: 0,
				cachedInputTokens: 0,
				outputTokens: 0,
				seenAssistantMessages: new WeakSet(),
			};
			pendingTools.clear();
			completedToolIds.clear();
			blockedToolIds.clear();
		},

		onAgentEnd(event, _ctx) {
			const turn = activeTurn;
			activeTurn = undefined;
			pendingTools.clear();
			completedToolIds.clear();
			blockedToolIds.clear();
			if (!turn) return;
			const lastAssistant = findLastAssistant(event.messages);
			const outcome =
				lastAssistant?.stopReason === "aborted"
					? "interrupted"
					: lastAssistant?.stopReason === "error"
						? "error"
						: "ok";
			track("turn_completed", {
				duration_ms: safeMetric(readNow() - turn.startedAt),
				step_count: turn.stepCount,
				tool_call_count: turn.toolCallIds.size,
				outcome,
				input_token_count: turn.inputTokens,
				cached_input_token_count: turn.cachedInputTokens,
				output_token_count: turn.outputTokens,
			});
		},

		onTurnStart(event, _ctx) {
			const turn = ensureTurn();
			const index = Number.isFinite(event.turnIndex) && event.turnIndex >= 0 ? Math.trunc(event.turnIndex) + 1 : 0;
			turn.stepCount = Math.max(turn.stepCount, index || turn.stepCount + 1);
		},

		onTurnEnd(event, _ctx) {
			const turn = ensureTurn();
			const index = Number.isFinite(event.turnIndex) && event.turnIndex >= 0 ? Math.trunc(event.turnIndex) + 1 : 0;
			turn.stepCount = Math.max(turn.stepCount, index || turn.stepCount + 1);
			if (event.message?.role === "assistant") addAssistantUsage(event.message);
			for (const result of event.toolResults ?? []) {
				const id = safeDimension(result.toolCallId, "");
				if (id) turn.toolCallIds.add(id);
			}
		},

		onInput(event, _ctx) {
			// Pi emits the input hook before it drains a steering queue. Record only
			// actual steer deliveries; idle prompts and follow-ups are covered by the
			// enclosing turn event and must not inflate the steering metric.
			if (event.streamingBehavior !== "steer" || !activeTurn) return;
			const inputCount = readPositiveInteger(event as unknown as Record<string, unknown>, "inputCount");
			track("turn_steered", {
				step: Math.max(1, activeTurn.stepCount),
				input_count: inputCount ?? 1,
			});
		},

		onSessionCompact(event, ctx) {
			const firstKeptEntryId = event.compactionEntry.firstKeptEntryId;
			let summarizedMessageCount = 0;
			try {
				// Full Pi sessions expose getBranch(); minimal embedders and older
				// hosts may only expose getEntries(). Keep those hosts observable
				// instead of silently reporting every compaction as empty.
				const sessionManager = ctx.sessionManager as unknown as {
					getBranch?: () => readonly { id: string; type: string }[];
					getEntries?: () => readonly { id: string; type: string }[];
				};
				const branch = sessionManager.getBranch?.() ?? sessionManager.getEntries?.() ?? [];
				const firstKeptIndex = branch.findIndex((entry) => entry.id === firstKeptEntryId);
				if (firstKeptIndex >= 0) {
					summarizedMessageCount = branch
						.slice(0, firstKeptIndex)
						.filter((entry) => entry.type === "message").length;
				}
			} catch {
				// A host may expose a minimal session manager. The event remains useful
				// with a bounded zero count in that case.
			}
			track("compaction_finished", {
				mode: safeDimension(event.reason),
				summarized_message_count: Math.max(0, summarizedMessageCount),
				step: Math.max(0, activeTurn?.stepCount ?? 0),
			});
		},

		onMessageEnd(event, _ctx) {
			if (event.message.role === "assistant") addAssistantUsage(event.message);
		},

		onToolCall(event, _ctx) {
			const id = safeDimension(event.toolCallId, "");
			if (!id) return;
			ensureTurn().toolCallIds.add(id);
			pendingTools.set(id, {
				toolName: safeDimension(event.toolName),
				startedAt: readNow(),
			});
			completedToolIds.delete(id);
		},

		onToolResult(event, _ctx) {
			const id = safeDimension(event.toolCallId, "");
			if (!id) return;
			trackToolCompletion(id, event.toolName, event.isError, readToolErrorCode(event.details));
		},

		onToolExecutionStart(event, _ctx) {
			const id = safeDimension(event.toolCallId, "");
			if (!id) return;
			ensureTurn().toolCallIds.add(id);
			// Execution timing is more faithful than tool_call timing because the
			// latter includes an interactive approval prompt. When both hooks are
			// registered, replace the provisional start with this one.
			pendingTools.set(id, {
				toolName: safeDimension(event.toolName),
				startedAt: readNow(),
			});
			completedToolIds.delete(id);
		},

		onToolExecutionEnd(event, _ctx) {
			const id = safeDimension(event.toolCallId, "");
			if (!id) return;
			trackToolCompletion(id, event.toolName, event.isError, readToolErrorCode(event.result));
		},
	};

	const lifecycle: StepLifecycleTelemetry = {
		...handlers,
		register(api) {
			api.on("session_start", handlers.onSessionStart);
			api.on("session_compact", handlers.onSessionCompact);
			api.on("agent_start", handlers.onAgentStart);
			api.on("agent_end", handlers.onAgentEnd);
			api.on("turn_start", handlers.onTurnStart);
			api.on("turn_end", handlers.onTurnEnd);
			api.on("input", handlers.onInput);
			api.on("message_end", handlers.onMessageEnd);
			api.on("tool_call", handlers.onToolCall);
			api.on("tool_result", handlers.onToolResult);
			api.on("tool_execution_start", handlers.onToolExecutionStart);
			api.on("tool_execution_end", handlers.onToolExecutionEnd);
		},
		recordPermissionDecision(info) {
			const mode = normalizePermissionDimension(info.mode ?? info.action, "unknown");
			track("permission_decision", {
				tool_name: safeDimension(info.toolName),
				mode,
				risk: normalizePermissionDimension(info.risk, "unknown"),
				hazardous: info.hazardous === true,
			});
		},
		recordPermissionApproval(info) {
			track("permission_approval_result", {
				tool_name: safeDimension(info.toolName),
				decision: normalizeApprovalDecision(info.decision),
				risk: normalizePermissionDimension(info.risk, "unknown"),
			});
		},
		markToolBlocked(toolCallId) {
			const id = safeDimension(toolCallId, "");
			if (id) blockedToolIds.add(id);
		},
		reset() {
			activeSessionId = undefined;
			activeTurn = undefined;
			pendingTools.clear();
			completedToolIds.clear();
			blockedToolIds.clear();
		},
	};

	return lifecycle;
}

export interface StepModelRequestObserverOptions {
	/** Hosts whose requests are also captured by the server-side observer. */
	readonly observerBaseUrls?: readonly string[];
	/** Override endpoint classification when the host owns an endpoint registry. */
	readonly classifyEndpoint?: (baseUrl: string) => string;
	/** Override server-side observer routing detection. */
	readonly isObserverRouted?: (request: ModelRequestStarted | ModelRequestCompleted) => boolean;
}

/**
 * Adapt the neutral request observer to the fields used by Step's old query
 * system. The request URL is used only for classification and is never emitted.
 */
export function createStepModelRequestObserver(
	reporter: StepTelemetryReporter,
	options: StepModelRequestObserverOptions = {},
): ModelRequestObserver {
	const classifyEndpoint = options.classifyEndpoint ?? classifyStepEndpoint;
	const isObserverRouted =
		options.isObserverRouted ??
		((request) =>
			options.observerBaseUrls && options.observerBaseUrls.length > 0
				? matchesBaseUrl(request.baseUrl, options.observerBaseUrls)
				: isStepTraceRequestAllowedForRuntime(request.provider, request.baseUrl));

	return {
		onRequestCompleted(request) {
			// Match the old transport's trace gate: requests without a session trace
			// are capability/auth probes, not user model calls, and must not inflate
			// model-request telemetry.
			if (!hasValidRequestTrace(request)) return;
			try {
				reporter.setContext?.(request.sessionId ? { sessionId: request.sessionId } : {});
			} catch {
				// A host context callback is diagnostic only. It must not prevent the
				// request event from reaching the reporter.
			}
			const endpointKind = readEndpointKind(classifyEndpoint, request.baseUrl);
			const routedViaCloudTrace = readObserverRouted(isObserverRouted, request);
			safeTrack(
				reporter,
				"model_request_completed",
				{
					provider: safeDimension(request.provider),
					model: safeDimension(request.model),
					duration_ms: safeMetric(request.durationMs),
					ttft_ms: request.ttftMs === null ? null : safeMetric(request.ttftMs),
					endpoint_kind: safeDimension(endpointKind),
					outcome: request.outcome,
					status_code: safeStatusCode(request.statusCode),
					streamed: request.streamed,
					routed_via_cloud_trace: routedViaCloudTrace,
				},
				{ sessionId: request.sessionId },
			);
		},
	};
}

function readEndpointKind(classify: (baseUrl: string) => string, baseUrl: string): string {
	try {
		const value = classify(baseUrl);
		return value === "platform" || value === "custom" || value === "local" ? value : "custom";
	} catch {
		return "custom";
	}
}

function readObserverRouted(
	isObserverRouted: (request: ModelRequestStarted | ModelRequestCompleted) => boolean,
	request: ModelRequestCompleted,
): boolean {
	try {
		return isObserverRouted(request) === true;
	} catch {
		return false;
	}
}

/** Keep dimensions bounded and free of control characters before they leave the process. */
function safeDimension(value: string, fallback = "unknown"): string {
	if (typeof value !== "string") return fallback;
	const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
	if (!normalized) return fallback;
	return normalized.length > 256 ? normalized.slice(0, 256) : normalized;
}

function safeMetric(value: number): number {
	return Number.isFinite(value) && value >= 0 ? value : 0;
}

function safeStatusCode(value: number): number {
	return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function hasValidRequestTrace(request: ModelRequestCompleted): boolean {
	// The core observer carries the Pi trace identity as sessionId. A missing
	// identity means the call was made outside an admitted user session (for
	// example a catalog/auth probe), matching the legacy `if (!request.trace)`
	// guard in the transport.
	return !!request.sessionId?.trim().length;
}

/** Default endpoint classifier aligned with the old Step telemetry vocabulary. */
export function classifyStepEndpoint(
	baseUrl: string,
	env: Record<string, string | undefined> = process.env,
): "platform" | "custom" | "local" {
	let hostname: string;
	try {
		hostname = new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return "custom";
	}

	if (
		hostname === "localhost" ||
		hostname === "127.0.0.1" ||
		hostname === "::1" ||
		hostname === "[::1]" ||
		hostname.endsWith(".localhost")
	) {
		return "local";
	}

	return isStepPlatformHost(hostname, env) ? "platform" : "custom";
}

const PLATFORM_ENDPOINT_ENV_NAMES = [
	"STEP_BASE_URL",
	"STEP_MODELS_PROXY_BASE_URL",
	"STEPCLI_MODELS_PROXY_BASE_URL",
	"STEPFUN_MESSAGES_ENDPOINT",
	"STEP_CLI_CLOUD_TRACE_ENDPOINT",
	"STEPCLI_CLOUD_TRACE_ENDPOINT",
	"STEP_CLI_CLOUD_TRACE_ORIGIN",
	"STEPCLI_CLOUD_TRACE_ORIGIN",
] as const;
const STEP_PLATFORM_HOSTS = new Set([
	"models-proxy.stepfun-inc.com",
	"api.stepfun.com",
	"test-openapi-stepcliobserserver.c.stepfun-inc.net",
]);

function isStepPlatformHost(hostname: string, env: Record<string, string | undefined>): boolean {
	// Keep this set in lockstep with the legacy MODEL_PLATFORM_ENDPOINTS
	// registry. Matching arbitrary subdomains would classify a user's
	// `evil.stepfun.com` endpoint as platform traffic.
	if (STEP_PLATFORM_HOSTS.has(hostname)) {
		return true;
	}

	// The legacy endpoint registry treated an explicitly configured model/trace
	// host as platform-owned even when it was an internal staging hostname. Do
	// the same here without emitting the host itself in telemetry.
	for (const name of PLATFORM_ENDPOINT_ENV_NAMES) {
		for (const candidate of (env[name] ?? "").split(",")) {
			try {
				if (new URL(candidate.trim()).hostname.toLowerCase() === hostname) return true;
			} catch {
				// Ignore malformed overrides; they cannot identify a platform host.
			}
		}
	}
	return false;
}

function matchesBaseUrl(url: string, baseUrls: readonly string[] | undefined): boolean {
	if (!baseUrls || baseUrls.length === 0) return false;
	const normalizedUrl = normalizeUrlPrefix(url);
	return baseUrls.some((baseUrl) => {
		const normalizedBase = normalizeUrlPrefix(baseUrl);
		return (
			normalizedBase.length > 0 &&
			(normalizedUrl === normalizedBase ||
				normalizedUrl.startsWith(`${normalizedBase}/`) ||
				normalizedUrl.startsWith(`${normalizedBase}?`) ||
				normalizedUrl.startsWith(`${normalizedBase}#`))
		);
	});
}

function normalizeUrlPrefix(value: string): string {
	return value.trim().replace(/\/+$/u, "");
}

function readNonNegativeNumber(value: unknown, primary: string, legacy: string): number {
	if (!value || typeof value !== "object") return 0;
	const record = value as Record<string, unknown>;
	const candidate = record[primary] ?? record[legacy];
	return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 ? candidate : 0;
}

function safeBoolean(read: () => boolean): boolean {
	try {
		return read() === true;
	} catch {
		return false;
	}
}

function safeString(read: () => string): string {
	try {
		const value = read();
		return typeof value === "string" ? value : "unknown";
	} catch {
		return "unknown";
	}
}

function defaultResumed(event: SessionStartEvent, ctx: ExtensionContext): boolean {
	if (event.reason === "resume" || event.reason === "fork") return true;
	try {
		return ctx.sessionManager.getEntries().length > 0;
	} catch {
		return false;
	}
}

function mapUiMode(mode: ExtensionContext["mode"]): string {
	switch (mode) {
		case "tui":
			return "interactive";
		case "rpc":
			return "service";
		case "json":
			return "json";
		case "print":
			return "headless";
		default:
			return "unknown";
	}
}

function findLastAssistant(
	messages: readonly { role: string; stopReason?: string }[],
): { role: "assistant"; stopReason?: string } | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role === "assistant") return message as { role: "assistant"; stopReason?: string };
	}
	return undefined;
}

function readToolErrorCode(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const direct = record.code ?? record.errorCode;
	if (typeof direct === "string") return direct;
	const nested = record.error;
	if (nested && typeof nested === "object" && typeof (nested as Record<string, unknown>).code === "string") {
		return (nested as Record<string, unknown>).code as string;
	}
	return undefined;
}

function normalizeToolErrorCode(errorCode: string | undefined, blocked: boolean, isError: boolean): string | null {
	if (blocked) return PERMISSION_DENIED_CODE;
	if (!isError) return null;
	if (!errorCode) return "unspecified";
	return KNOWN_TOOL_ERROR_CODES.has(errorCode) ? errorCode : "other";
}

function normalizePermissionDimension(value: string | undefined, fallback: string): string {
	const normalized = safeDimension(value ?? "", fallback).toLowerCase();
	if (normalized === fallback) return fallback;
	return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
}

function readPositiveInteger(value: Record<string, unknown>, key: string): number | undefined {
	const candidate = value[key];
	if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
		return undefined;
	}
	const normalized = Math.trunc(candidate);
	return normalized > 0 ? normalized : undefined;
}

/** Map Pi/Step UI shorthand to the legacy approval result vocabulary. */
function normalizeApprovalDecision(value: string | undefined): string {
	const normalized = normalizePermissionDimension(value, "unknown");
	switch (normalized) {
		case "allow":
		case "approved":
		case "approve":
			return "allow-once";
		case "denied":
		case "reject":
			return "deny";
		default:
			return normalized;
	}
}

function safeTrack(
	reporter: StepTelemetryReporter,
	event: StepTelemetryEventName,
	properties: StepTelemetryProperties,
	options?: StepTelemetryTrackOptions,
): void {
	try {
		void Promise.resolve(reporter.track(event, properties, options)).catch(() => undefined);
	} catch {
		// Telemetry is best effort and must never affect the agent loop.
	}
}
