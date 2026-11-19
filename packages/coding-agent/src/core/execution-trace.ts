/**
 * The session's execution trace: when each tool call ran and how it ended.
 *
 * Written as `step.tool_execution` custom entries, append-only and outside the
 * model context. A call that executes gets a `start` entry when it actually
 * begins (after approval) and an `end` entry when it settles; a call that never
 * executes gets only an `end`. Writing the two halves separately is what lets a
 * reader tell "started but never finished" (the process died) from "never
 * recorded".
 *
 * Timestamps come from the agent loop's own events, not from when this recorder
 * gets to handle them, so slow listeners cannot pull parallel calls' end times
 * together.
 */

import { randomUUID } from "node:crypto";
import {
	type AgentEvent,
	readCommandExecutionOutcome,
	type ToolExecutionStartedContext,
} from "@step-harness/agent-core";
import type { AssistantMessage } from "@step-harness/providers/compat";
import {
	type RequestLedger,
	type RequestPurpose,
	type RequestUsageProvenance,
	readRequestUsage,
	USAGE_PROVENANCE_ENTRY_TYPE,
} from "./request-provenance.ts";
import { THINKING_TIMING_ENTRY_TYPE, ThinkingClock } from "./thinking-timing.ts";

export const TOOL_EXECUTION_ENTRY_TYPE = "step.tool_execution";

/**
 * How a call ended.
 *
 * - `ok` / `error`: executed; `error` when the result is marked as an error.
 * - `timeout`: executed and stopped by a timeout (`details.timedOut`).
 * - `aborted`: executed and interrupted, or still open when the session or process ended.
 * - `denied`: a person refused the approval prompt.
 * - `blocked`: a policy refused it without asking (see `blockedBy`).
 * - `not_run`: it never started (see `notRunReason`).
 */
export type ToolExecutionOutcome = "ok" | "error" | "timeout" | "aborted" | "denied" | "blocked" | "not_run";

export interface ToolExecutionStartData {
	readonly version: 1;
	readonly phase: "start";
	readonly toolCallId: string;
	readonly toolName: string;
	/** Session entry of the assistant message that issued the call. */
	readonly assistantEntryId?: string;
	readonly startedAt: number;
	/** When the call was issued and began waiting for approval or its batch; only when it differs from `startedAt`. */
	readonly queuedAt?: number;
}

export interface ToolExecutionEndData {
	readonly version: 1;
	readonly phase: "end";
	readonly toolCallId: string;
	readonly endedAt: number;
	readonly outcome: ToolExecutionOutcome;
	/** Present on calls that never executed, so a reader can still measure how long the decision took. */
	readonly queuedAt?: number;
	/** Time the tool spent waiting for a person's answer while it ran. */
	readonly waitingForUserMs?: number;
	readonly blockedBy?: string;
	readonly notRunReason?: string;
}

type ToolExecutionStartEvent = Extract<AgentEvent, { type: "tool_execution_start" }>;
type ToolExecutionEndEvent = Extract<AgentEvent, { type: "tool_execution_end" }>;

/** Where entries go; normally `SessionManager.appendCustomEntry`. Returns the entry id. */
export type ExecutionTraceAppend = (customType: string, data: ToolExecutionStartData | ToolExecutionEndData) => string;

/** A policy block without its own code; extensions that return no `blockedBy`. */
const UNNAMED_BLOCKER = "extension";
/** The blocker code permission policies use when a person refused the prompt. */
const PERSON_BLOCKER = "user";

export class ToolExecutionRecorder {
	private readonly append: ExecutionTraceAppend;
	private readonly queuedAt = new Map<string, number>();
	/** Calls with a `start` entry and no `end` yet; backfilled as aborted on teardown. */
	private readonly open = new Set<string>();
	private readonly startEntryIds = new Map<string, string>();
	private readonly startTimes = new Map<string, number>();

	constructor(append: ExecutionTraceAppend) {
		this.append = append;
	}

	/** The loop issued a call: it now waits for approval, validation, or its batch. */
	queued(event: ToolExecutionStartEvent): void {
		this.queuedAt.set(event.toolCallId, event.at ?? Date.now());
	}

	/** The call's `execute` is about to run. */
	started(context: ToolExecutionStartedContext, assistantEntryId: string | undefined): void {
		const { toolCall, at } = context;
		const queuedAt = this.queuedAt.get(toolCall.id);
		const data: ToolExecutionStartData = {
			version: 1,
			phase: "start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			...(assistantEntryId ? { assistantEntryId } : {}),
			startedAt: at,
			...(queuedAt !== undefined && queuedAt !== at ? { queuedAt } : {}),
		};
		const entryId = this.write(data);
		this.open.add(toolCall.id);
		this.startTimes.set(toolCall.id, at);
		if (entryId) this.startEntryIds.set(toolCall.id, entryId);
		liveRecorders.add(this);
		installExitBackfill();
	}

	/** The call settled. `aborted` is whether the run's signal had fired by then. */
	ended(event: ToolExecutionEndEvent, aborted: boolean): void {
		const endedAt = event.at ?? Date.now();
		const queuedAt = this.queuedAt.get(event.toolCallId);
		this.queuedAt.delete(event.toolCallId);
		this.open.delete(event.toolCallId);
		this.startEntryIds.delete(event.toolCallId);
		this.startTimes.delete(event.toolCallId);
		if (this.open.size === 0) liveRecorders.delete(this);

		const notExecuted = event.notExecuted;
		let data: ToolExecutionEndData;
		if (notExecuted?.kind === "blocked") {
			const blockedBy = notExecuted.by ?? UNNAMED_BLOCKER;
			data =
				blockedBy === PERSON_BLOCKER
					? { version: 1, phase: "end", toolCallId: event.toolCallId, endedAt, outcome: "denied" }
					: { version: 1, phase: "end", toolCallId: event.toolCallId, endedAt, outcome: "blocked", blockedBy };
			if (queuedAt !== undefined) data = { ...data, queuedAt };
		} else if (notExecuted?.kind === "not_run") {
			data = {
				version: 1,
				phase: "end",
				toolCallId: event.toolCallId,
				endedAt,
				outcome: "not_run",
				notRunReason: notExecuted.reason,
				...(queuedAt !== undefined ? { queuedAt } : {}),
			};
		} else {
			const waitingForUserMs = readWaitingForUserMs(event.result);
			data = {
				version: 1,
				phase: "end",
				toolCallId: event.toolCallId,
				endedAt,
				outcome: executedOutcome(event, aborted),
				...(waitingForUserMs !== undefined ? { waitingForUserMs } : {}),
			};
		}
		this.write(data);
	}

	/** Entry id of the open `start` record for a call, for linking other records to it. */
	startEntryId(toolCallId: string): string | undefined {
		return this.startEntryIds.get(toolCallId);
	}

	/** When an open call started, before `ended` forgets it. */
	startedAt(toolCallId: string): number | undefined {
		return this.startTimes.get(toolCallId);
	}

	/**
	 * Close every call that started and never ended as `aborted`, at `at`.
	 *
	 * Runs on session teardown and at process exit; synchronous because an exit
	 * handler cannot await. Calls that never started are not backfilled: without
	 * a start there is nothing a reader would wait on.
	 */
	closeOpen(at: number = Date.now()): void {
		for (const toolCallId of this.open) {
			this.write({ version: 1, phase: "end", toolCallId, endedAt: at, outcome: "aborted" });
		}
		this.open.clear();
		this.startEntryIds.clear();
		this.startTimes.clear();
		this.queuedAt.clear();
		liveRecorders.delete(this);
	}

	private write(data: ToolExecutionStartData | ToolExecutionEndData): string | undefined {
		try {
			return this.append(TOOL_EXECUTION_ENTRY_TYPE, data);
		} catch {
			// The trace describes the run; failing to write it must not fail the tool.
			return undefined;
		}
	}
}

function executedOutcome(event: ToolExecutionEndEvent, aborted: boolean): ToolExecutionOutcome {
	const details = readDetails(event.result);
	// Shell tools report their executor's facts in `details.execution`; a command
	// that exits non-zero is a completed call, not a failed one (see `AgentToolResult.isError`).
	const command = readCommandExecutionOutcome(details?.execution);
	if (details?.timedOut === true || command?.status === "timed_out") return "timeout";
	if (command?.status === "canceled") return "aborted";
	if (!event.isError) return "ok";
	return aborted ? "aborted" : "error";
}

function readDetails(result: unknown): Record<string, unknown> | undefined {
	if (!result || typeof result !== "object") return undefined;
	const details = (result as { details?: unknown }).details;
	return details && typeof details === "object" && !Array.isArray(details)
		? (details as Record<string, unknown>)
		: undefined;
}

function readWaitingForUserMs(result: unknown): number | undefined {
	const value = readDetails(result)?.waitingForUserMs;
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

/** Recorders with open calls; the exit handler closes them. Emptied as calls end. */
const liveRecorders = new Set<{ closeOpen(at?: number): void }>();
let exitBackfillInstalled = false;

function installExitBackfill(): void {
	if (exitBackfillInstalled) return;
	exitBackfillInstalled = true;
	// `exit` handlers run synchronously, including after `process.exit()`, which is
	// how several hosts leave. Session appends are synchronous file writes, so the
	// backfill lands before the process is gone. SIGKILL cannot be observed; those
	// calls keep only their `start`.
	process.on("exit", () => {
		const at = Date.now();
		// Calls first, so each turn's end follows the ends of the calls it contained.
		const open = [...liveRecorders];
		for (const recorder of open) if (recorder instanceof ToolExecutionRecorder) recorder.closeOpen(at);
		for (const recorder of open) if (!(recorder instanceof ToolExecutionRecorder)) recorder.closeOpen(at);
	});
}

export const TURN_ENTRY_TYPE = "step.turn";

/**
 * What started a turn.
 *
 * - `user`: a person's message.
 * - `cron`: a scheduled task fired.
 * - `goal`: an active goal continued on its own.
 * - `notification`: a background subagent lane reported back.
 * - `resume`: autopilot resumed an interrupted run.
 * - `other`: any other message that starts a run.
 */
export type TurnTrigger = "user" | "cron" | "goal" | "notification" | "resume" | "other";

/** `aborted`: someone stopped it; `error`: it failed after any retries; `completed` otherwise. */
export type TurnOutcome = "completed" | "aborted" | "error";

export interface TurnStartData {
	readonly version: 1;
	readonly turnId: string;
	readonly phase: "start";
	readonly at: number;
	/** The message that started the turn: the person's input, or the injected message. */
	readonly userEntryId: string;
	readonly trigger: TurnTrigger;
}

export interface TurnEndData {
	readonly version: 1;
	readonly turnId: string;
	readonly phase: "end";
	readonly at: number;
	readonly outcome: TurnOutcome;
}

/**
 * `step.turn`: one entry when a turn starts and one when it settles, so a reader
 * can tell a turn the user stopped from one whose records are simply missing.
 *
 * A turn starts with the message that begins a run, and a queued follow-up the
 * run picks up later starts the next one. Steering typed into a running turn
 * belongs to that turn, and so do the session's own automatic retries.
 */
export class TurnRecorder {
	private readonly append: (customType: string, data: TurnStartData | TurnEndData) => string;
	private readonly newId: () => string;
	private open: { turnId: string; lastStopReason?: string } | undefined;

	constructor(append: (customType: string, data: TurnStartData | TurnEndData) => string, newId: () => string) {
		this.append = append;
		this.newId = newId;
	}

	get isOpen(): boolean {
		return this.open !== undefined;
	}

	start(userEntryId: string, trigger: TurnTrigger, at: number = Date.now()): void {
		if (this.open) this.end(undefined, at);
		const turnId = this.newId();
		this.open = { turnId };
		this.write({ version: 1, turnId, phase: "start", at, userEntryId, trigger });
		liveRecorders.add(this);
		installExitBackfill();
	}

	/** Remember how the turn's latest reply stopped; it decides the outcome. */
	observeReply(stopReason: string): void {
		if (this.open) this.open.lastStopReason = stopReason;
	}

	/**
	 * Close the open turn. `failed` is the session's own verdict for a run that
	 * produced no usable answer; `aborted` whether someone stopped the run, which
	 * the last reply does not show when the stop came during a tool call, a retry
	 * wait or a compaction.
	 */
	end(failed: boolean | undefined, at: number = Date.now(), aborted = false): void {
		const open = this.open;
		if (!open) return;
		this.open = undefined;
		liveRecorders.delete(this);
		const outcome: TurnOutcome =
			aborted || open.lastStopReason === "aborted"
				? "aborted"
				: failed || open.lastStopReason === "error"
					? "error"
					: "completed";
		this.write({ version: 1, turnId: open.turnId, phase: "end", at, outcome });
	}

	/** A turn cut short by teardown or exit was not completed. */
	closeOpen(at: number = Date.now()): void {
		const open = this.open;
		if (!open) return;
		this.open = undefined;
		liveRecorders.delete(this);
		this.write({ version: 1, turnId: open.turnId, phase: "end", at, outcome: "aborted" });
	}

	private write(data: TurnStartData | TurnEndData): void {
		try {
			this.append(TURN_ENTRY_TYPE, data);
		} catch {
			// The trace describes the run; failing to write it must not fail the run.
		}
	}
}

/** Custom message types that start work by themselves, and the trigger each records. */
export const TURN_TRIGGER_BY_CUSTOM_TYPE: Readonly<Record<string, TurnTrigger>> = {
	"step-cron": "cron",
	"step-goal": "goal",
	"agent-notification": "notification",
};

export interface SessionExecutionTraceOptions {
	/** Writes one custom session entry and returns its id (`SessionManager.appendCustomEntry`). */
	readonly append: (customType: string, data: unknown) => string;
	readonly sessionId: () => string;
	/** The session's model requests, from `sdk.ts`; without it only replies carrying their own provenance are recorded. */
	readonly ledger?: RequestLedger;
	readonly newId?: () => string;
}

/**
 * Everything the session writes about how it ran, behind one object:
 * `step.tool_execution`, `step.turn`, `step.thinking_timing` and
 * `step.usage_provenance` with its retry chain.
 *
 * `AgentSession` only reports what happened, through the `on*` hooks, at the
 * points where it already persists messages; all state and record shapes live
 * here. Writing never fails the session: every append is best effort.
 */
export class SessionExecutionTrace {
	private readonly options: SessionExecutionTraceOptions;
	private readonly tools: ToolExecutionRecorder;
	private readonly turns: TurnRecorder;
	private readonly thinking = new ThinkingClock();
	/** Session entry of each persisted reply, so a tool call can name the reply that issued it. */
	private readonly replyEntryIds = new WeakMap<object, string>();
	private lastReplyEntryId: string | undefined;
	/** Start time and trace entry of calls whose end is being delivered to extensions. */
	private readonly endingToolStarts = new Map<string, ToolExecutionStart>();
	private userMessageIsSteering = false;
	/** The last reply request recorded, so a retry can name the attempt it repeats. */
	private lastReplyRequest: { requestId: string; attempt: number } | undefined;
	/** Set when the session decided to re-send the last request; consumed by the next reply. */
	private pendingRetryOf: { requestId: string; attempt: number } | undefined;

	constructor(options: SessionExecutionTraceOptions) {
		this.options = options;
		this.tools = new ToolExecutionRecorder((customType, data) => options.append(customType, data));
		this.turns = new TurnRecorder(
			(customType, data) => options.append(customType, data),
			options.newId ?? (() => randomUUID()),
		);
	}

	/** An agent-loop event, before anything awaits; `aborted` is whether the run's signal had fired. */
	onAgentEvent(event: AgentEvent, aborted: boolean): void {
		if (event.type === "tool_execution_start") this.tools.queued(event);
		else if (event.type === "tool_execution_end") {
			const startedAt = this.tools.startedAt(event.toolCallId);
			const traceEntryId = this.tools.startEntryId(event.toolCallId);
			if (startedAt !== undefined)
				this.endingToolStarts.set(event.toolCallId, { startedAt, ...(traceEntryId ? { traceEntryId } : {}) });
			this.tools.ended(event, aborted);
		}
		this.thinking.observe(event);
	}

	/** A tool call's `execute` is about to run (`Agent.onToolExecutionStarted`). */
	readonly onToolStarted = (context: ToolExecutionStartedContext): void => {
		this.tools.started(context, this.replyEntryIds.get(context.assistantMessage) ?? this.lastReplyEntryId);
	};

	/** When the ending call started and its trace entry, once, for the extension event that reports the end. */
	takeEndingToolStart(toolCallId: string): ToolExecutionStart | undefined {
		const started = this.endingToolStarts.get(toolCallId);
		this.endingToolStarts.delete(toolCallId);
		return started;
	}

	/** A user message is being delivered; `steering` when it came from the steering queue. */
	onUserMessageStart(steering: boolean): void {
		// New input is a new request chain, not a retry of the last failed one.
		this.pendingRetryOf = undefined;
		// Steering joins the running turn; a prompt or a queued follow-up starts one.
		this.userMessageIsSteering = steering;
	}

	onUserMessagePersisted(entryId: string, text: string, autoResumePrompt: string): void {
		if (!this.userMessageIsSteering || !this.turns.isOpen) {
			this.turns.start(entryId, text === autoResumePrompt ? "resume" : "user");
		}
		this.userMessageIsSteering = false;
	}

	/**
	 * An extension's message was persisted. One that starts work (a cron fire, a
	 * goal continuation, a lane notice) opens a turn when a run is active and none
	 * is open; mode notices and context-only reports never start one.
	 */
	onCustomMessagePersisted(entryId: string, customType: string, runActive: boolean): void {
		const trigger = TURN_TRIGGER_BY_CUSTOM_TYPE[customType];
		if (trigger && runActive && !this.turns.isOpen) this.turns.start(entryId, trigger);
	}

	/**
	 * A reply was persisted: close its thinking timing and record its request.
	 * Returns the request's provenance for the `usage_recorded` extension event.
	 */
	onReplyPersisted(message: AssistantMessage, entryId: string): RequestUsageProvenance | undefined {
		this.turns.observeReply(message.stopReason);
		this.lastReplyEntryId = entryId;
		this.replyEntryIds.set(message, entryId);
		const thinking = this.thinking.completed(entryId);
		if (thinking) this.write(THINKING_TIMING_ENTRY_TYPE, thinking);
		const provenance = this.options.ledger?.claimReply(message) ?? readRequestUsage(message);
		if (!provenance) return undefined;
		const retryOf = this.pendingRetryOf;
		this.pendingRetryOf = undefined;
		const attempt = retryOf ? retryOf.attempt + 1 : 1;
		this.lastReplyRequest = { requestId: provenance.requestId, attempt };
		const sessionId = this.options.sessionId();
		this.write(USAGE_PROVENANCE_ENTRY_TYPE, {
			version: 1,
			...provenance,
			sessionId,
			originSessionId: sessionId,
			usageEntryId: entryId,
			attempt,
			...(retryOf ? { retryOfRequestId: retryOf.requestId } : {}),
		});
		return provenance;
	}

	/** The session will re-send the last request (an automatic retry, or after overflow compaction). */
	onRetryScheduled(): void {
		this.pendingRetryOf = this.lastReplyRequest;
	}

	/** A scheduled retry was given up; the next request starts a new chain. */
	onRetryCancelled(): void {
		this.pendingRetryOf = undefined;
	}

	/** The run settled; `failed` is the session's verdict, `aborted` whether someone stopped it. */
	onRunSettled(failed: boolean, aborted: boolean): void {
		this.turns.end(failed, Date.now(), aborted);
	}

	/**
	 * Run a summary request (compaction, branch summary) with its model requests
	 * tagged by `purpose`. Requests of a failed attempt are recorded without a
	 * summary entry; call `recordSummary` with the entry the summary produced.
	 */
	async withSummaryPurpose<T>(purpose: RequestPurpose, run: () => Promise<T>): Promise<T> {
		// Requests an earlier attempt left unrecorded belong to that attempt.
		this.recordSummary(purpose, undefined);
		const ledger = this.options.ledger;
		const previous = ledger?.purpose;
		if (ledger) ledger.purpose = purpose;
		try {
			return await run();
		} catch (error) {
			this.recordSummary(purpose, undefined);
			throw error;
		} finally {
			if (ledger) ledger.purpose = previous;
		}
	}

	/** Record the `purpose` requests made since the last call, naming the entry they produced (if any). */
	recordSummary(purpose: RequestPurpose, summaryEntryId: string | undefined): void {
		const sessionId = this.options.sessionId();
		for (const request of this.options.ledger?.claimPurpose(purpose) ?? []) {
			this.write(USAGE_PROVENANCE_ENTRY_TYPE, {
				version: 1,
				...request,
				sessionId,
				originSessionId: sessionId,
				purpose,
				...(summaryEntryId ? { summaryEntryId } : {}),
			});
		}
	}

	/** Teardown: calls and the turn still open end as aborted. */
	dispose(): void {
		this.tools.closeOpen();
		this.turns.closeOpen();
	}

	private write(customType: string, data: unknown): void {
		try {
			this.options.append(customType, data);
		} catch {
			// The trace describes the run; failing to write it must not fail the run.
		}
	}
}

/** When a call started and the trace entry of that start. */
export interface ToolExecutionStart {
	readonly startedAt: number;
	readonly traceEntryId?: string;
}
