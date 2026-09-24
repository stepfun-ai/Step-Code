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
import { type Message, StringEnum, type Usage } from "@step-harness/providers";
import { type Static, Type } from "typebox";
import { CONFIG_DIR_NAME } from "../config.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory, InlineExtension } from "../core/extensions/types.ts";
import { resolveStepAgentDir, resolveStepConfigDir } from "../step/environment.ts";
import type { StepTelemetryReporter } from "../step/telemetry.ts";
import { formatBuiltinAgentGuidance, type StepAgentConfig, type StepAgentScope } from "./step-subagent-agents.ts";
import { executeSubagent } from "./subagent/execute.ts";
import { allocateStepWorktree, cloneUsage, isRecordValue, SUBAGENT_SESSION_ID_PREFIX } from "./subagent/helpers.ts";
import {
	type BackgroundAgentLane,
	controlResult,
	createLaneLifecycle,
	getLiveSubagentSession,
	laneMatches,
} from "./subagent/lane-lifecycle.ts";
import {
	laneWidgetLines,
	renderSubagentResult,
	SubagentListWidget,
	subagentListSignature,
} from "./subagent/rendering.ts";
import { createSubagentRpcSession } from "./subagent/rpc-adapter.ts";

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
// renderSubagentResult/laneWidgetLines) moved to ./subagent/rendering.ts and
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

const MAX_PARALLEL_TASKS = 8;
const DEFAULT_CONCURRENCY = 4;
export const MAX_JSON_LINE_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGES = 256;
export const CHILD_MARKER = "STEPCODE_SUBAGENT_CHILD";

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
}

export interface StepSubagentRunInput {
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
	 * Abandon the turn after this many ms with no output from the child.
	 * Defaults to `resolveSubagentTurnIdleTimeoutMs()`; `0` disables the watchdog.
	 */
	turnIdleTimeoutMs?: number;
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
	status: "running" | "completed" | "failed" | "aborted";
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
	/** Maximum number of tasks accepted in one parallel call. */
	maxParallelTasks?: number;
	/** Number of child processes allowed to run at once. */
	maxConcurrency?: number;
	/** Optional isolated git worktree implementation. */
	worktreeManager?: StepWorktreeManager;
	/** Optional child runner, primarily useful for embedded hosts/tests. */
	runner?: StepSubagentRunner;
	/** Optional process reporter; telemetry never owns child execution. */
	telemetry?: StepTelemetryReporter;
}

// Keep the model-facing contract identical to Pi's subagent example. Step
// adapts discovery, process invocation, storage, telemetry, and theme only.
export const StepTaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

export const StepChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const StepAgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const StepSubscribeSchema = StringEnum(["final", "progress", "none"] as const, {
	description:
		'Notification level for background lanes. "final" (default) sends one completion notification, "progress" adds throttled progress updates, "none" is fire-and-forget.',
	default: "final",
});

const StepSubagentParamsSchema = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(StepTaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(StepChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(StepAgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	subscribe: Type.Optional(StepSubscribeSchema),
});

type PublicSubagentParams = Static<typeof StepSubagentParamsSchema>;

/** Internal controls retained for Step's background-lane implementation. They
 * are intentionally absent from the model-facing Pi schema. */
interface StepSubagentRuntimeParams {
	run_in_background?: boolean;
	alias?: string;
	group?: string;
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
	if (live) return live.runTurn(input);
	if (spawnedSubagentSessions.has(sessionId)) input.onChildRespawn?.();
	spawnedSubagentSessions.add(sessionId);
	const session = await createSubagentRpcSession(input, sessionId);
	return session.runTurn(input);
}

export function makeToolResult(details: StepSubagentDetails, text: string): AgentToolResult<StepSubagentDetails> {
	return { content: [{ type: "text", text }], details };
}

const AgentSendTargetSchema = Type.Object({
	agent_id: Type.Optional(Type.String({ description: "Background agent id" })),
	alias: Type.Optional(Type.String({ description: "Background agent alias" })),
	group: Type.Optional(Type.String({ description: "Background agent group (fans out to every member)" })),
	all: Type.Optional(Type.Boolean({ description: "Address every background agent" })),
});

const AgentSendSchema = Type.Object({
	to: AgentSendTargetSchema,
	action: StringEnum(["reply", "stop"] as const, {
		description: '"reply" sends prompt to the lane\'s ongoing transcript; "stop" interrupts and ends the lane.',
	}),
	prompt: Type.Optional(Type.String({ description: 'Message to deliver for action:"reply"' })),
	interrupt: Type.Optional(
		Type.Boolean({
			description:
				'With action:"reply": true steers the lane immediately, false (default) queues the prompt to run after the lane\'s current turn.',
		}),
	),
});

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
			Math.min(options.maxConcurrency ?? DEFAULT_CONCURRENCY, options.maxParallelTasks ?? MAX_PARALLEL_TASKS),
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
		const laneWidgetKey = (id: string): string => `step-agent:${id}`;
		const updateLaneWidget = (lane: BackgroundAgentLane): void => {
			if (!lane.ctx.hasUI) return;
			try {
				lane.ctx.ui.setWidget(laneWidgetKey(lane.id), laneWidgetLines(lane), {
					placement: "aboveEditor",
				});
			} catch {
				// A host may tear down its UI while a detached child is finishing.
			}
		};
		const { createLane, startLane, stopLane, replyToLane } = createLaneLifecycle({
			pi,
			lanes,
			agentDir: resolved.agentDir,
			executeSubagent: (runParams, signal, onUpdate, ctx, laneRuntime) =>
				executeSubagent(runParams, signal, onUpdate, ctx, resolved, laneRuntime),
			updateLaneWidget,
		});

		pi.registerTool<typeof StepSubagentParamsSchema, StepSubagentDetails>({
			name: "subagent",
			label: "Subagent",
			description: [
				"Delegate tasks to specialized subagents with isolated context.",
				"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
				formatBuiltinAgentGuidance(),
				`Default agent scope is "user" (from ${path.join(resolved.agentDir, "agents")}).`,
				`To enable project-local agents in ${resolved.configDirName}/agents, set agentScope: "both" (or "project").`,
			].join(" "),
			parameters: StepSubagentParamsSchema,
			execute: async (toolCallId, params, signal, onUpdate, ctx) => {
				// Background lanes remain available to embedded Step callers through
				// the internal extension API, while ordinary model calls follow Pi's
				// blocking single/parallel/chain contract.
				if ((params as SubagentParams).run_in_background) {
					const backgroundParams = params as SubagentParams;
					const hasParallelInput = (backgroundParams.tasks?.length ?? 0) > 0;
					const hasChainInput = (backgroundParams.chain?.length ?? 0) > 0;
					const hasSingleInput =
						!hasParallelInput &&
						!hasChainInput &&
						Boolean(backgroundParams.agent?.trim() && backgroundParams.task?.trim());
					// Do not create a detached lane for malformed input. Returning the
					// normal validation result keeps the error attached to this tool call
					// instead of emitting a misleading background_done notification.
					if (Number(hasSingleInput) + Number(hasParallelInput) + Number(hasChainInput) !== 1) {
						return executeSubagent(backgroundParams, signal, onUpdate, ctx, resolved);
					}
					const lane = createLane(backgroundParams, ctx);
					startLane(lane, backgroundParams);
					const details: StepSubagentDetails = {
						...lane.details,
						results: [...lane.details.results],
					};
					const monitorHint =
						lane.subscribe === "none"
							? "Fire-and-forget lane: no notifications will be sent."
							: `Lane events arrive automatically as <agent-notification> messages (subscribe: ${lane.subscribe}).`;
					return makeToolResult(
						details,
						`Started background agent ${lane.id}${lane.alias ? ` (${lane.alias})` : ""}. ${monitorHint}`,
					);
				}
				return withSubagentListWidget(toolCallId, ctx, onUpdate, (update) =>
					executeSubagent(params as SubagentParams, signal, update, ctx, resolved),
				);
			},
			renderCall: (params, theme) => {
				if (params.chain && params.chain.length > 0) {
					return new Text(
						`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", `chain (${params.chain.length} steps)`)}\n  ${theme.fg("dim", params.chain[0]?.task ?? "...")}`,
						0,
						0,
					);
				}
				if (params.tasks && params.tasks.length > 0) {
					return new Text(
						`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", `parallel (${params.tasks.length} tasks)`)}\n  ${theme.fg("dim", params.tasks[0]?.task ?? "...")}`,
						0,
						0,
					);
				}
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", params.agent ?? "...")}\n  ${theme.fg("dim", params.task ?? "...")}`,
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
				"Send a message to background agents created by subagent with run_in_background=true.",
				'action:"reply" delivers prompt into the lane\'s ongoing transcript (interrupt:false queues it after the current turn, interrupt:true steers immediately).',
				'action:"stop" interrupts the lane and ends its child process.',
				"Address one lane with to.agent_id or to.alias, or fan out with to.group / to.all.",
			].join(" "),
			parameters: AgentSendSchema,
			executionMode: "sequential",
			execute: async (_id, params) => {
				const to = params.to ?? {};
				if (!to.agent_id && !to.alias && !to.group && to.all !== true) {
					return controlResult("agent_send: provide to.agent_id, to.alias, to.group, or to.all");
				}
				const selected = [...lanes.values()].filter((lane) => to.all === true || laneMatches(lane, to));
				if (selected.length === 0) return controlResult("agent_send: no matching background agents");
				if (params.action === "reply") {
					const prompt = params.prompt?.trim();
					if (!prompt) return controlResult('agent_send: prompt is required for action:"reply"');
					return controlResult(
						selected.map((lane) => replyToLane(lane, prompt, params.interrupt === true)).join("\n"),
						selected.map((lane) => lane.details),
					);
				}
				return controlResult(
					selected.map((lane) => stopLane(lane)).join("\n"),
					selected.map((lane) => lane.details),
				);
			},
		});

		// S3 (docs/improvement-plan.md): agent_reply/agent_wait/agent_interrupt/
		// agent_list are hard-deleted. agent_send covers reply (follow_up), steer
		// (reply + interrupt), and stop (abort); lane lifecycle arrives as
		// <agent-notification> events instead of wait/list polling.
	};
}

export const stepSubagentExtensionInline: InlineExtension = {
	name: "Step subagent",
	factory: createStepSubagentExtension(),
	hidden: true,
};
