/**
 * Step's native subagent extension.
 *
 * This is intentionally a thin adapter around the public Pi ExtensionAPI. A
 * child is another Step/Pi process in JSON mode, while the parent keeps the
 * normal AgentSession loop and native TUI renderer. No second session
 * authority is created here.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback, ThinkingLevel } from "@step-harness/agent-core";
import { Text } from "@step-harness/pi-tui";
import { type Message, type ProviderErrorKind, StringEnum, type Usage } from "@step-harness/providers";
import { type Static, Type } from "typebox";
import { CONFIG_DIR_NAME } from "../config.ts";
import { CHILD_SESSION_ORIGIN } from "../core/child-session.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory, InlineExtension } from "../core/extensions/types.ts";
import type { NewSessionOptions } from "../core/session-manager.ts";
import { resolveStepAgentDir, resolveStepConfigDir } from "../step/environment.ts";
import {
	isValidSubagentBackgroundTimeout,
	SUBAGENT_BACKGROUND_TIMEOUT_DEFAULT_SECONDS,
	SUBAGENT_BACKGROUND_TIMEOUT_MAX_SECONDS,
	SUBAGENT_BACKGROUND_TIMEOUT_MIN_SECONDS,
} from "../step/settings-manager.ts";
import type { StepTelemetryReporter } from "../step/telemetry.ts";
import { formatBuiltinAgentGuidance, type StepAgentConfig, type StepAgentScope } from "./step-subagent-agents.ts";
import { executeSubagent, prepareSubagentRun, runPreparedSubagent } from "./subagent/execute.ts";
import {
	allocateStepWorktree,
	cloneUsage,
	emptyUsage,
	isRecordValue,
	SUBAGENT_SESSION_ID_PREFIX,
} from "./subagent/helpers.ts";
import {
	type BackgroundAgentLane,
	controlResult,
	createLaneLifecycle,
	getLiveSubagentSession,
	MAX_RETAINED_FINISHED_LANES,
} from "./subagent/lane-lifecycle.ts";
import {
	renderAgentNotification,
	renderSubagentResult,
	SubagentListWidget,
	subagentListSignature,
} from "./subagent/rendering.ts";
import { createSubagentRpcSession } from "./subagent/rpc-adapter.ts";
import { clampWorkflowConcurrency } from "./workflow/budget.ts";

// Lane-notification primitives moved to ./subagent/lane-events.ts; re-exported
// here to keep this module's public surface stable.
export type { BackgroundLaneEvent, BackgroundLaneSubscribeLevel } from "./subagent/lane-events.ts";
export { escapeXmlAttr } from "./subagent/lane-events.ts";
// Lane lifecycle (createLane/startLane/stopLane/replyToLane) moved to
// ./subagent/lane-lifecycle.ts; the lane shape is re-exported for the same reason.
export type { BackgroundAgentLane } from "./subagent/lane-lifecycle.ts";
// Rpc child plumbing (stdout pre-router + rpc session wrapper) moved to
// ./subagent/rpc-adapter.ts; re-exported for the same reason.
export type { StepSubagentRpcSession, SubagentRpcLineHandlers } from "./subagent/rpc-adapter.ts";
export { routeSubagentRpcLine } from "./subagent/rpc-adapter.ts";

// The blocking orchestrator (executeSubagent + its task/aggregation helpers)
// moved to ./subagent/execute.ts and is imported above; it was never public.

// TUI render helpers (statusIcon/renderRecordSummary/renderExpandedRecord/
// renderSubagentResult/renderAgentNotification) moved to ./subagent/rendering.ts and
// are imported above; none were public.

// Pure utilities (usage math, sanitizeLabel/normalizeChildTools, the git
// worktree allocator, currentStepInvocation, isRecordValue) moved to
// ./subagent/helpers.ts; the public ones are re-exported for the same reason.
export {
	cloneUsage,
	currentStepInvocation,
	emptyUsage,
	isChildAgentSessionId,
	isRecordValue,
	normalizeChildTools,
	SUBAGENT_SESSION_ID_PREFIX,
	sanitizeLabel,
	WORKFLOW_SESSION_ID_PREFIX,
} from "./subagent/helpers.ts";

const MAX_PARALLEL_TASKS = 1000;
export const MAX_JSON_LINE_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGES = 256;
export const CHILD_MARKER = "STEPCODE_SUBAGENT_CHILD";

/**
 * Header fields a child agent process stamps on the session it creates, so the
 * session is recognisable as a child's without relying on its id. Empty outside
 * a child process. The env comes from `buildSubagentChildEnv`.
 */
export function childSessionHeader(
	env: NodeJS.ProcessEnv = process.env,
): Pick<NewSessionOptions, "origin" | "parentSessionId"> {
	if (env[CHILD_MARKER] !== "1") return {};
	const parentSessionId = env.STEPCODE_USAGE_PARENT_SESSION_ID?.trim();
	return { origin: CHILD_SESSION_ORIGIN, ...(parentSessionId ? { parentSessionId } : {}) };
}

export interface StepSubagentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface StepSubagentRunResult {
	messages: Message[];
	stderr: string;
	exitCode: number;
	usage: StepSubagentUsage;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	/** Live projection populated from Pi's JSON event stream. */
	activeText?: string;
	activeTool?: string;
	activeToolArgs?: string;
	activeToolOutput?: string;
	lastEvent?: string;
	startedAt?: number;
	updatedAt?: number;
	/** True when a keep-alive rpc child is still running and can accept replies. */
	pendingReply?: boolean;
	/** Child session id (`--session-id`); the transcript stays on disk after the child exits. */
	sessionId?: string;
	/** Child session JSONL path, when the child reported it. */
	sessionFile?: string;
	/** Titles of blocking dialogs the child raised and that were auto-cancelled (nobody can answer them). */
	cancelledPrompts?: string[];
}

export interface StepSubagentRunInput {
	onModelRequest?: (event: import("../core/rate-limit.ts").ModelRequestProgress) => void;
	parentCwd?: string;
	parentSessionId?: string;
	agent: StepAgentConfig;
	task: string;
	cwd: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	signal?: AbortSignal;
	onUpdate?: (result: StepSubagentRunResult) => void;
	/** Called when the child emits a `{"type":"progress-report"}` event to nag the parent. */
	onNeedsInput?: (message: string) => void;
	/** Called when a prior child for this session died and a new one is spawned to resume it. */
	onChildRespawn?: () => void;
	/**
	 * Stable child session id (`--session-id`). Reusing the id across turns and
	 * respawns continues the same on-disk transcript; generated when omitted.
	 */
	sessionId?: string;
	/** Keep the rpc child alive after the turn settles so replies reuse it. */
	keepAlive?: boolean;
	/**
	 * Resolve only after a non-keep-alive child has exited, so a caller holding a
	 * shared admission slot keeps it until the process has actually stopped.
	 * Workflow calls (workflowAcl) always wait.
	 */
	awaitExit?: boolean;
	/**
	 * Abandon the turn after this many ms with no output from the child.
	 * Defaults to `resolveSubagentTurnIdleTimeoutMs()`; `0` disables the watchdog.
	 */
	turnIdleTimeoutMs?: number;
	/**
	 * Wall-clock limit for one turn in ms; output does not reset it. The turn
	 * fails when it is reached. Omitted or `0` means no limit (foreground calls).
	 */
	turnTimeoutMs?: number;
	/** Workflow-owned path ACL passed to the child-side tool_call hook. */
	workflowAcl?: {
		baseCwd: string;
		readOnly?: string[];
		writable?: string[];
	};
}

/** Injectable runner used by embedders and tests. The default runner launches
 * the current Step executable/script, preserving the resolved Step provider. */
export type StepSubagentRunner = (input: StepSubagentRunInput) => Promise<StepSubagentRunResult>;

export interface StepWorktreeLease {
	path: string;
	branch: string;
	/** Remove the worktree and its temporary parent. Safe to call repeatedly. */
	cleanup(): Promise<void>;
}

export interface StepWorktreeManager {
	allocate(baseCwd: string, label: string): Promise<StepWorktreeLease>;
}

export interface StepSubagentResultRecord extends StepSubagentRunResult {
	agent: string;
	agentSource: StepAgentConfig["source"] | "unknown";
	task: string;
	/**
	 * `queued`: not started yet (a later chain step, or a parallel task waiting
	 * on maxConcurrency). `skipped`: a chain step that never started because an
	 * earlier step did not complete.
	 */
	status: "queued" | "running" | "completed" | "failed" | "aborted" | "skipped";
	step?: number;
	worktreePath?: string;
	worktreeBranch?: string;
}

export interface StepSubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: StepAgentScope;
	userAgentsDir: string;
	projectAgentsDir: string | null;
	results: StepSubagentResultRecord[];
	/** Present for background lanes and useful to a renderer/list command. */
	agentId?: string;
	status?: "running" | "completed" | "failed" | "aborted";
	startedAt?: number;
	updatedAt?: number;
}

export interface StepSubagentExtensionOptions {
	/** Global Step agent root. Defaults to `~/.stepcode/agent`. */
	agentDir?: string;
	/** Project resource directory. Defaults to `.stepcode`. */
	configDirName?: string;
	/** Include the built-in general/explore/review/planner roles. */
	includeBuiltinAgents?: boolean;
	/** Maximum batch size accepted in one parallel call; excess tasks queue instead of running. */
	maxParallelTasks?: number;
	/** Number of child processes allowed to run at once; tasks beyond this stay queued. */
	maxConcurrency?: number;
	/** Optional isolated git worktree implementation. */
	worktreeManager?: StepWorktreeManager;
	/** Optional child runner, primarily useful for embedded hosts/tests. */
	runner?: StepSubagentRunner;
	/** Optional process reporter; telemetry never owns child execution. */
	telemetry?: StepTelemetryReporter;
	/**
	 * Host-supplied background-lane settings (normally `[subagent]` in
	 * `config.toml`), read on every call so a reload takes effect.
	 */
	backgroundSettings?: () => StepSubagentBackgroundSettings | undefined;
}

export interface StepSubagentBackgroundSettings {
	/** `false` runs every `run_in_background` call in the foreground. */
	enabled?: boolean;
	/** Default per-turn wall-clock limit for background lanes, in seconds. */
	timeoutSeconds?: number;
}

// Keep the model-facing contract identical to Pi's subagent example. Step
// adapts discovery, process invocation, storage, telemetry, and theme only.
export const StepTaskItem = Type.Object(
	{
		agent: Type.String({ description: "Name of the agent to invoke" }),
		task: Type.String({ description: "Task to delegate to the agent" }),
		cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	},
	{ additionalProperties: false },
);

export const StepChainItem = Type.Object(
	{
		agent: Type.String({ description: "Name of the agent to invoke" }),
		task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
		cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	},
	{ additionalProperties: false },
);

const StepAgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const StepSubscribeSchema = StringEnum(["final", "progress"] as const, {
	description:
		'Notification level for a background lane. "final" (default) sends one notification when the lane ends; "progress" adds throttled progress updates that need no reply.',
	default: "final",
});

const StepSubagentParamsSchema = Type.Object(
	{
		agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
		task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
		tasks: Type.Optional(Type.Array(StepTaskItem, { description: "Array of {agent, task} for parallel execution" })),
		chain: Type.Optional(
			Type.Array(StepChainItem, { description: "Array of {agent, task} for sequential execution" }),
		),
		agentScope: Type.Optional(StepAgentScopeSchema),
		confirmProjectAgents: Type.Optional(
			Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
		),
		cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
		run_in_background: Type.Optional(
			Type.Boolean({
				description:
					"Run the call as a background lane and return its lane_id immediately. Default false: the call blocks and returns the result. Use the foreground when your next step needs the result; use the background only for independent work you can continue without. A finished lane wakes you with one <agent-notification>; never sleep or poll for it.",
				default: false,
			}),
		),
		timeout_seconds: Type.Optional(
			Type.Number({
				description: `Background lanes only: wall-clock limit for each turn of the lane, in seconds (${SUBAGENT_BACKGROUND_TIMEOUT_MIN_SECONDS}-${SUBAGENT_BACKGROUND_TIMEOUT_MAX_SECONDS}). The turn fails when it is reached. Defaults to the configured limit (${SUBAGENT_BACKGROUND_TIMEOUT_DEFAULT_SECONDS}s unless changed).`,
				minimum: SUBAGENT_BACKGROUND_TIMEOUT_MIN_SECONDS,
				maximum: SUBAGENT_BACKGROUND_TIMEOUT_MAX_SECONDS,
			}),
		),
		subscribe: Type.Optional(StepSubscribeSchema),
	},
	{ additionalProperties: false },
);

type PublicSubagentParams = Static<typeof StepSubagentParamsSchema>;

/** Internal controls for embedded Step callers. They are intentionally absent
 * from the model-facing schema. */
interface StepSubagentRuntimeParams {
	isolateWorkspace?: boolean;
	worktreeName?: string;
	retainWorktree?: boolean;
}

export type SubagentParams = PublicSubagentParams & StepSubagentRuntimeParams;

function isMessage(value: unknown): value is Message {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as { role?: unknown; content?: unknown };
	return (
		(candidate.role === "assistant" || candidate.role === "user" || candidate.role === "toolResult") &&
		(Array.isArray(candidate.content) || typeof candidate.content === "string")
	);
}

function isAssistantMessage(message: Message): message is Extract<Message, { role: "assistant" }> {
	return message.role === "assistant";
}

function assistantText(message: Message): string {
	if (!isAssistantMessage(message)) return "";
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

export function finalOutput(messages: readonly Message[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const text = assistantText(messages[index]);
		if (text) return text;
	}
	return "";
}

function usageFromMessage(message: Message, usage: StepSubagentUsage): void {
	if (!isAssistantMessage(message)) return;
	usage.turns += 1;
	const messageUsage = message.usage as Usage | undefined;
	if (!messageUsage) return;
	usage.input += messageUsage.input || 0;
	usage.output += messageUsage.output || 0;
	usage.cacheRead += messageUsage.cacheRead || 0;
	usage.cacheWrite += messageUsage.cacheWrite || 0;
	usage.contextTokens = messageUsage.totalTokens || usage.contextTokens;
	usage.cost += messageUsage.cost?.total || 0;
}

/**
 * The provider's structured failure class, only while the run's terminal error is
 * still the child's own model failure. A local failure (idle timeout, abort,
 * process exit) that replaced it has no provider kind.
 */
export function providerErrorKind(
	result: Pick<StepSubagentRunResult, "messages" | "stopReason" | "errorMessage">,
): ProviderErrorKind | undefined {
	if (result.stopReason !== "error") return undefined;
	for (let index = result.messages.length - 1; index >= 0; index--) {
		const message = result.messages[index];
		if (!isAssistantMessage(message)) continue;
		return message.stopReason === "error" && message.errorMessage === result.errorMessage
			? message.errorKind
			: undefined;
	}
	return undefined;
}

export function isFailed(result: Pick<StepSubagentRunResult, "exitCode" | "stopReason">): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

export function resultText(result: StepSubagentRunResult): string {
	if (isFailed(result)) return result.errorMessage || result.stderr || finalOutput(result.messages) || "(no output)";
	return finalOutput(result.messages) || "(no output)";
}

function appendMessage(messages: Message[], message: Message): void {
	messages.push(message);
	if (messages.length > MAX_MESSAGES) messages.splice(0, messages.length - MAX_MESSAGES);
}

export function parseJsonEvent(
	line: string,
	current: StepSubagentRunResult,
	onUpdate: ((result: StepSubagentRunResult) => void) | undefined,
): void {
	if (line.length === 0 || Buffer.byteLength(line, "utf8") > MAX_JSON_LINE_BYTES) return;
	let event: unknown;
	try {
		event = JSON.parse(line);
	} catch {
		return;
	}
	if (!event || typeof event !== "object" || Array.isArray(event)) return;
	const candidate = event as Record<string, unknown>;
	const type = typeof candidate.type === "string" ? candidate.type : "";
	current.lastEvent = type || current.lastEvent;
	current.updatedAt = Date.now();

	// JSON mode emits deltas without the cumulative assistant snapshot. Keep a
	// small live projection for the parent renderer while retaining final
	// messages as the authoritative result.
	if (type === "message_start") {
		current.activeText = "";
		current.activeTool = undefined;
		current.activeToolArgs = undefined;
		current.activeToolOutput = undefined;
	} else if (type === "message_update") {
		const update = isRecordValue(candidate.assistantMessageEvent) ? candidate.assistantMessageEvent : undefined;
		const updateType = typeof update?.type === "string" ? update.type : "";
		const delta =
			typeof update?.delta === "string" ? update.delta : typeof update?.text === "string" ? update.text : "";
		if (delta && /(?:text|reasoning|thinking).*delta|delta/u.test(updateType)) {
			current.activeText = `${current.activeText ?? ""}${delta}`.slice(-50_000);
		}
		if (update && updateType === "toolcall_start") {
			current.activeTool =
				typeof update.toolName === "string"
					? update.toolName
					: typeof update.name === "string"
						? update.name
						: "tool";
			current.activeToolArgs = "";
		} else if (updateType === "toolcall_delta" && delta) {
			current.activeToolArgs = `${current.activeToolArgs ?? ""}${delta}`.slice(-20_000);
		}
	} else if (type === "tool_execution_start") {
		current.activeTool = typeof candidate.toolName === "string" ? candidate.toolName : "tool";
		current.activeToolArgs = stringifyLiveValue(candidate.args);
		current.activeToolOutput = undefined;
	} else if (type === "tool_execution_update") {
		current.activeToolOutput = stringifyLiveValue(candidate.partialResult);
	} else if (type === "tool_execution_end") {
		current.activeToolOutput = stringifyLiveValue(candidate.result);
		current.activeTool = undefined;
		current.activeToolArgs = undefined;
	}

	const message = candidate.message;
	if ((type === "message_end" || type === "tool_result_end") && isMessage(message)) {
		appendMessage(current.messages, message);
		usageFromMessage(message, current.usage);
		if (isAssistantMessage(message)) {
			if (message.model) current.model = message.model;
			current.stopReason = message.stopReason;
			current.errorMessage = message.errorMessage;
			current.activeText = assistantText(message) || current.activeText;
			current.activeTool = undefined;
			current.activeToolArgs = undefined;
		}
	}
	onUpdate?.({
		...current,
		messages: [...current.messages],
		usage: cloneUsage(current.usage),
	});
}

function stringifyLiveValue(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string") return value.slice(-20_000);
	try {
		return JSON.stringify(value).slice(-20_000);
	} catch {
		return String(value).slice(-20_000);
	}
}

/**
 * Default child runner (S2a): one long-running `--mode rpc --session-id` child
 * per subagent session. Each call sends one `{type:"prompt"}` turn and resolves
 * when the child's run settles; with `keepAlive` the child survives the turn so
 * follow-up replies reuse its provider cache and transcript. A dead child is
 * respawned with the same session id and resumes the transcript from disk.
 */
/** Session ids that ever spawned a child in this process; a hit with no live
 * child means the previous child died and the new spawn is a recovery. */
const spawnedSubagentSessions = new Set<string>();

export async function runStepSubagentProcess(input: StepSubagentRunInput): Promise<StepSubagentRunResult> {
	const sessionId = input.sessionId?.trim() || `${SUBAGENT_SESSION_ID_PREFIX}${randomUUID()}`;
	const live = getLiveSubagentSession(sessionId);
	if (live) {
		const result = await live.runTurn(input);
		if ((input.workflowAcl || input.awaitExit) && !input.keepAlive) await live.exited;
		return result;
	}
	// A run cancelled before its child existed (session shutdown, a stopped lane)
	// must not spawn one: a keep-alive child would outlive the cancellation.
	if (input.signal?.aborted) {
		return {
			messages: [],
			stderr: "",
			exitCode: 0,
			usage: emptyUsage(),
			stopReason: "aborted",
			errorMessage: "Subagent was aborted",
			sessionId,
		};
	}
	if (spawnedSubagentSessions.has(sessionId)) input.onChildRespawn?.();
	spawnedSubagentSessions.add(sessionId);
	const session = await createSubagentRpcSession(input, sessionId);
	const result = await session.runTurn(input);
	// Cancelled while the child was starting: a keep-alive child would stay up with nobody to stop it.
	if (input.signal?.aborted && input.keepAlive) session.stop();
	// A workflow node or admitted subagent owns its child through process exit, not
	// just agent_settled. This keeps its shared admission slot until cancellation
	// has actually stopped the child, and lets queued work start without orphaned requests.
	if ((input.workflowAcl || input.awaitExit) && !input.keepAlive) await session.exited;
	return result;
}

export function makeToolResult(
	details: StepSubagentDetails,
	text: string,
	isError = false,
): AgentToolResult<StepSubagentDetails> {
	return {
		content: [{ type: "text", text }],
		details,
		...(isError || details.results.some((record) => record.status === "failed" || record.status === "aborted")
			? { isError: true }
			: {}),
	};
}

const AgentSendSchema = Type.Object(
	{
		lane_id: Type.Optional(
			Type.String({
				description:
					'Lane id returned by subagent with run_in_background:true (for example "lane_1a2b3c4d"). Required for reply and stop; omit with status to list every lane.',
			}),
		),
		action: StringEnum(["reply", "stop", "status"] as const, {
			description:
				'"reply" sends prompt into a single-agent lane\'s ongoing transcript; "stop" interrupts the lane and ends it; "status" returns the lane\'s state, usage, child session paths, and the tail of its last output.',
		}),
		prompt: Type.Optional(Type.String({ description: 'Message to deliver for action:"reply"' })),
		interrupt: Type.Optional(
			Type.Boolean({
				description:
					'With action:"reply": true steers the lane immediately, false (default) queues the prompt to run after the lane\'s current turn.',
			}),
		),
	},
	{ additionalProperties: false },
);

/** Environment switch that runs every `run_in_background` call in the foreground. */
export const SUBAGENT_BACKGROUND_DISABLE_ENV = "STEP_DISABLE_SUBAGENT_BACKGROUND";

function envFlagEnabled(value: string | undefined): boolean {
	return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "on";
}

/**
 * Why a `run_in_background` call must run in the foreground, or undefined when
 * it may detach. print and json runs end with their single prompt, so a lane
 * would be stopped before it could report; tui, rpc, and SDK hosts stay up.
 */
function backgroundUnavailableReason(
	ctx: ExtensionContext,
	settings: StepSubagentBackgroundSettings | undefined,
): string | undefined {
	if (ctx.mode === "print" || ctx.mode === "json") {
		return "Background execution is not available in this run mode; ran in the foreground.";
	}
	if (envFlagEnabled(process.env[SUBAGENT_BACKGROUND_DISABLE_ENV]) || settings?.enabled === false) {
		return "Background execution is disabled by configuration; ran in the foreground.";
	}
	return undefined;
}

/**
 * Per-turn wall-clock limit: the call's value, else the configured default,
 * else 3600s. The schema already bounds the call's value; an out-of-bounds
 * configured value is rejected by settings validation and reported at load,
 * so it falls back to the default here instead of being silently clamped.
 */
export function resolveBackgroundTimeoutMs(requested: number | undefined, configured: number | undefined): number {
	if (typeof requested === "number" && Number.isFinite(requested)) {
		const seconds = Math.min(
			SUBAGENT_BACKGROUND_TIMEOUT_MAX_SECONDS,
			Math.max(SUBAGENT_BACKGROUND_TIMEOUT_MIN_SECONDS, requested),
		);
		return Math.round(seconds) * 1000;
	}
	const seconds = isValidSubagentBackgroundTimeout(configured)
		? configured
		: SUBAGENT_BACKGROUND_TIMEOUT_DEFAULT_SECONDS;
	return seconds * 1000;
}

function prependNotice(
	result: AgentToolResult<StepSubagentDetails>,
	notice: string,
): AgentToolResult<StepSubagentDetails> {
	const [first, ...rest] = result.content;
	if (first?.type === "text")
		return { ...result, content: [{ ...first, text: `${notice}\n\n${first.text}` }, ...rest] };
	return { ...result, content: [{ type: "text", text: notice }, ...result.content] };
}

/**
 * Show a live lane list under the editor for the duration of a blocking
 * subagent call.
 *
 * Background lanes already have their own `aboveEditor` widget; the blocking
 * path had none, so a parallel run's only surface was the transcript tool row,
 * which the generic collapsed shell truncates. One component instance is reused
 * across updates: `setExtensionWidget` disposes the component it replaces, so
 * the instance deliberately has no `dispose` and the factory returns it again.
 */
async function withSubagentListWidget(
	toolCallId: string,
	ctx: ExtensionContext,
	onUpdate: AgentToolUpdateCallback<StepSubagentDetails> | undefined,
	run: (
		update: AgentToolUpdateCallback<StepSubagentDetails> | undefined,
	) => Promise<AgentToolResult<StepSubagentDetails>>,
): Promise<AgentToolResult<StepSubagentDetails>> {
	if (!ctx.hasUI) return run(onUpdate);
	const key = `step-subagent-list:${toolCallId}`;
	let widget: SubagentListWidget | undefined;
	// Last signature actually handed to the host. Children emit an update per
	// streamed delta, and every publish makes the host dispose the widget and
	// redraw; the rows only move on status and token changes, so the rest are
	// dropped here rather than paid for. The widget still takes each `details`,
	// so a later publish draws from the newest records.
	let published: string | undefined;
	const update: AgentToolUpdateCallback<StepSubagentDetails> = (result) => {
		onUpdate?.(result);
		const details = result.details;
		if (!details) return;
		widget?.setDetails(details);
		const signature = subagentListSignature(details);
		if (signature === published) return;
		published = signature;
		try {
			ctx.ui.setWidget(
				key,
				(_tui, theme) => {
					widget ??= new SubagentListWidget(details, theme);
					return widget;
				},
				{ placement: "belowEditor" },
			);
		} catch {
			// A host may tear its UI down mid-run; the list stays best-effort.
		}
	};
	try {
		return await run(update);
	} finally {
		try {
			ctx.ui.setWidget(key, undefined);
		} catch {
			// Never let widget cleanup mask the tool result.
		}
	}
}

/** Construct the hidden inline extension used by the Step launcher. */
export function createStepSubagentExtension(options: StepSubagentExtensionOptions = {}): ExtensionFactory {
	const resolved = {
		agentDir: path.resolve(options.agentDir ?? resolveStepAgentDir()),
		configDirName: options.configDirName?.trim() || resolveStepConfigDir() || CONFIG_DIR_NAME,
		includeBuiltinAgents: options.includeBuiltinAgents !== false,
		maxParallelTasks: Math.max(1, Math.min(MAX_PARALLEL_TASKS, options.maxParallelTasks ?? MAX_PARALLEL_TASKS)),
		maxConcurrency: Math.max(
			1,
			Math.min(clampWorkflowConcurrency(options.maxConcurrency), options.maxParallelTasks ?? MAX_PARALLEL_TASKS),
		),
		telemetry: options.telemetry,
		worktreeManager: options.worktreeManager ?? {
			allocate: allocateStepWorktree,
		},
		runner: options.runner ?? runStepSubagentProcess,
	};
	return (pi: ExtensionAPI): void => {
		// The child process inherits this marker. It still gets Step's provider and
		// tool profile, but does not recursively expose another subagent tool.
		if (process.env[CHILD_MARKER] === "1") return;

		const lanes = new Map<string, BackgroundAgentLane>();
		// Every background lane shares one list widget, built the same way as the
		// blocking call's list: a row per task with a fixed title and metrics. A
		// widget per lane, republished on every streamed delta with the child's
		// live text, reordered the lanes on each publish (the host re-inserts the
		// key) and changed height as lines wrapped, so the block flickered.
		//
		// Lanes stay listed until the whole batch settles, so the header reads
		// "2/4 complete" rather than shrinking as lanes finish; then it clears and
		// the transcript's agent-notification entries take over.
		//
		// Elapsed is read from the clock at render time. A blocking call gets its
		// redraws from the working indicator, but background lanes usually run
		// while the parent sits idle, so a 1s tick keeps the column moving; the
		// differential renderer only rewrites the cells that changed.
		const lanesWidgetKey = "step-agent-lanes";
		const shownLanes = new Set<string>();
		let lanesWidget: SubagentListWidget | undefined;
		let lanesPublished: string | undefined;
		let lanesTicker: ReturnType<typeof setInterval> | undefined;
		const stopLanesTicker = (): void => {
			if (lanesTicker) clearInterval(lanesTicker);
			lanesTicker = undefined;
		};
		const updateLaneWidget = (lane: BackgroundAgentLane): void => {
			if (!lane.ctx.hasUI) return;
			shownLanes.add(lane.id);
			// `lanes` iterates in creation order; `shownLanes` in first-update order,
			// which depends on which child streams first and would shuffle the rows.
			const batch = [...lanes.values()].filter((entry) => shownLanes.has(entry.id));
			try {
				if (batch.every((entry) => entry.status !== "running")) {
					shownLanes.clear();
					stopLanesTicker();
					lanesWidget = undefined;
					lanesPublished = undefined;
					lane.ctx.ui.setWidget(lanesWidgetKey, undefined);
					return;
				}
				const details: StepSubagentDetails = {
					...lane.details,
					mode: "parallel",
					results: batch.flatMap((entry) => entry.details.results),
				};
				lanesWidget?.setDetails(details);
				const signature = subagentListSignature(details);
				if (signature === lanesPublished) return;
				lanesPublished = signature;
				lane.ctx.ui.setWidget(
					lanesWidgetKey,
					(tui, theme) => {
						lanesWidget ??= new SubagentListWidget(details, theme, "background agents");
						if (!lanesTicker) {
							lanesTicker = setInterval(() => tui.requestRender(), 1_000);
							lanesTicker.unref?.();
						}
						return lanesWidget;
					},
					{ placement: "aboveEditor" },
				);
			} catch {
				// A host may tear down its UI while a detached child is finishing.
			}
		};
		let widgetCtx: ExtensionContext | undefined;
		const clearLaneWidget = (): void => {
			shownLanes.clear();
			stopLanesTicker();
			lanesWidget = undefined;
			lanesPublished = undefined;
			const ctx = widgetCtx;
			widgetCtx = undefined;
			if (!ctx?.hasUI) return;
			try {
				ctx.ui.setWidget(lanesWidgetKey, undefined);
			} catch {
				// The host may already have torn its UI down during shutdown.
			}
		};
		const trackedUpdateLaneWidget = (lane: BackgroundAgentLane): void => {
			if (lane.ctx.hasUI) widgetCtx = lane.ctx;
			updateLaneWidget(lane);
		};
		const lifecycle = createLaneLifecycle({
			pi,
			lanes,
			prepare: (runParams, ctx) => prepareSubagentRun(runParams, ctx, resolved, { requireKnownAgents: true }),
			run: (prepared, signal, onUpdate, ctx, laneRuntime) =>
				runPreparedSubagent(prepared, signal, onUpdate, ctx, resolved, laneRuntime),
			outputDirectory: (ctx) => path.join(ctx.sessionManager?.getSessionDir?.() || resolved.agentDir, "tool-output"),
			updateLaneWidget: trackedUpdateLaneWidget,
			clearLaneWidget,
		});

		// Lanes belong to this session runtime. Quit, signals, /new, /resume,
		// /fork, and reload all tear the runtime down through session_shutdown;
		// lanes are stopped rather than carried into the next session.
		pi.on("session_shutdown", async (event, ctx) => {
			const running = [...lanes.values()].filter((lane) => lane.status === "running").length;
			if (running > 0 && event.reason === "quit" && ctx.mode === "tui") {
				// The terminal UI has already stopped; tell the user why exit pauses.
				process.stderr.write(`Stopping ${running} background agent${running === 1 ? "" : "s"}...\n`);
			}
			await lifecycle.shutdown();
		});

		pi.registerMessageRenderer("agent-notification", renderAgentNotification);

		pi.registerTool<typeof StepSubagentParamsSchema, StepSubagentDetails>({
			name: "subagent",
			label: "Subagent",
			description: [
				"Delegate tasks to specialized subagents with isolated context.",
				"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
				"By default the call blocks until the agents finish and returns their results.",
				"With run_in_background:true it returns a lane_id at once and later sends one <agent-notification> when the lane ends; manage the lane with agent_send.",
				formatBuiltinAgentGuidance(),
				`Default agent scope is "user" (from ${path.join(resolved.agentDir, "agents")}).`,
				`To enable project-local agents in ${resolved.configDirName}/agents, set agentScope: "both" (or "project").`,
			].join(" "),
			parameters: StepSubagentParamsSchema,
			execute: async (toolCallId, params, signal, onUpdate, ctx) => {
				const callParams = params as SubagentParams;
				const foreground = (runParams: SubagentParams) =>
					withSubagentListWidget(toolCallId, ctx, onUpdate, (update) =>
						executeSubagent(runParams, signal, update, ctx, resolved),
					);
				if (!callParams.run_in_background) return foreground(callParams);

				const settings = options.backgroundSettings?.();
				const unavailable = backgroundUnavailableReason(ctx, settings);
				if (unavailable) {
					return prependNotice(await foreground({ ...callParams, run_in_background: false }), unavailable);
				}
				// Every check that can reject the call runs before the lane exists, so
				// a bad call returns an ordinary error and never sends a notification.
				const preflight = await prepareSubagentRun(callParams, ctx, resolved, { requireKnownAgents: true });
				if (!preflight.ok) return preflight.result;
				const lane = lifecycle.launchLane(
					callParams,
					ctx,
					preflight.run,
					resolveBackgroundTimeoutMs(callParams.timeout_seconds, settings?.timeoutSeconds),
				);
				if (typeof lane === "string") {
					const { mode, scope, discovery } = preflight.run;
					return makeToolResult(
						{
							mode,
							agentScope: scope,
							userAgentsDir: discovery.userAgentsDir,
							projectAgentsDir: discovery.projectAgentsDir,
							results: [],
						},
						lane,
						true,
					);
				}
				const details: StepSubagentDetails = { ...lane.details, results: [...lane.details.results] };
				return makeToolResult(
					details,
					[
						`Started background lane ${lane.id} (${preflight.run.mode}, ${preflight.run.tasks.length} task${preflight.run.tasks.length === 1 ? "" : "s"}; ${Math.round(lane.turnTimeoutMs / 1000)}s limit per turn).`,
						// Without this the parent, told to "wait for the lane", has no wait
						// primitive and falls back to `sleep` loops that delay the result.
						"Do not wait for it with sleep or polling: end your turn, or carry on with other work.",
						"You are woken with one <agent-notification> when the lane ends.",
						lane.subscribe === "progress"
							? "Progress <agent-notification> messages are informational; they need no reply."
							: "",
					]
						.filter(Boolean)
						.join(" "),
				);
			},
			renderCall: (params, theme) => {
				const background = params.run_in_background ? theme.fg("muted", " (background)") : "";
				if (params.chain && params.chain.length > 0) {
					return new Text(
						`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", `chain (${params.chain.length} steps)`)}${background}\n  ${theme.fg("dim", params.chain[0]?.task ?? "...")}`,
						0,
						0,
					);
				}
				if (params.tasks && params.tasks.length > 0) {
					return new Text(
						`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", `parallel (${params.tasks.length} tasks)`)}${background}\n  ${theme.fg("dim", params.tasks[0]?.task ?? "...")}`,
						0,
						0,
					);
				}
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", params.agent ?? "...")}${background}\n  ${theme.fg("dim", params.task ?? "...")}`,
					0,
					0,
				);
			},
			renderResult: (result, renderOptions, theme) => renderSubagentResult(result, renderOptions, theme),
		});

		pi.registerTool<typeof AgentSendSchema>({
			name: "agent_send",
			label: "Agent send",
			description: [
				"Manage a background lane created by subagent with run_in_background:true.",
				'action:"reply" delivers prompt into a single-agent lane\'s ongoing transcript (interrupt:false queues it after the current turn, interrupt:true steers immediately); parallel and chain lanes cannot take replies.',
				'action:"stop" interrupts the lane and ends its child processes.',
				'action:"status" reports the lane\'s state, usage, child session paths, and the tail of its last output; omit lane_id to list every lane. Lanes notify you when they end, so status is for a specific question, not for polling.',
			].join(" "),
			parameters: AgentSendSchema,
			executionMode: "sequential",
			execute: async (_id, params) => {
				const laneId = params.lane_id?.trim();
				if (!laneId) {
					if (params.action !== "status") {
						return controlResult(`agent_send: lane_id is required for action:"${params.action}"`);
					}
					const all = [...lanes.values()];
					if (all.length === 0) return controlResult("agent_send: this session has no background lanes");
					return controlResult(
						all
							.map((lane) => {
								const agents = [...new Set(lane.details.results.map((record) => record.agent))];
								return `${lane.id}: ${lane.status} (${lane.details.mode}${agents.length > 0 ? `; ${agents.join(", ")}` : ""})`;
							})
							.join("\n"),
						all.map((lane) => lane.details),
					);
				}
				const lane = lanes.get(laneId);
				if (!lane) {
					const known = [...lanes.keys()];
					return controlResult(
						`agent_send: no background lane "${laneId}" in this session${known.length > 0 ? `; known lanes: ${known.join(", ")}` : ""}. Only the ${MAX_RETAINED_FINISHED_LANES} most recent finished lanes are kept; an older lane's child session paths are in its notification. Start a new subagent call for further work.`,
					);
				}
				if (params.action === "status") return controlResult(lifecycle.laneStatus(lane), [lane.details]);
				if (params.action === "reply") {
					const prompt = params.prompt?.trim();
					if (!prompt) return controlResult('agent_send: prompt is required for action:"reply"');
					return controlResult(lifecycle.replyToLane(lane, prompt, params.interrupt === true), [lane.details]);
				}
				return controlResult(lifecycle.stopLane(lane), [lane.details]);
			},
		});

		// agent_reply/agent_wait/agent_interrupt/agent_list no longer exist.
		// agent_send covers reply (follow_up), steer (reply + interrupt), stop,
		// and a non-blocking status read; a lane's end arrives as one
		// <agent-notification> instead of wait/list polling.
	};
}

export const stepSubagentExtensionInline: InlineExtension = {
	name: "Step subagent",
	factory: createStepSubagentExtension(),
	hidden: true,
};
