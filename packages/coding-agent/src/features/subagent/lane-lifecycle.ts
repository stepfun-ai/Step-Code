/**
 * Background-lane lifecycle: lane creation, the `startLane` turn state machine
 * (generation-guarded callbacks + queued follow-up prompts), the shared
 * stop/reply verbs, and the registry of live rpc children keyed by lane
 * session id. Tool registration and child-process io stay in step-subagent.ts.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@step-harness/agent-core";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import type { StepSubagentDetails, StepSubagentRpcSession, SubagentParams } from "../step-subagent.ts";
import { SUBAGENT_SESSION_ID_PREFIX } from "./helpers.ts";
import {
	type BackgroundLaneSubscribeLevel,
	maybeNotifyLaneProgress,
	notifyLaneEvent,
	notifyLaneFinal,
} from "./lane-events.ts";

export interface BackgroundAgentLane {
	id: string;
	alias?: string;
	group?: string;
	params: SubagentParams;
	ctx: ExtensionContext;
	controller: AbortController;
	status: "running" | "completed" | "failed" | "aborted";
	details: StepSubagentDetails;
	result?: AgentToolResult<StepSubagentDetails>;
	promise: Promise<AgentToolResult<StepSubagentDetails>>;
	queuedPrompts: string[];
	startedAt: number;
	updatedAt: number;
	/** Incremented whenever a lane starts a new turn; stale child callbacks are ignored. */
	runGeneration: number;
	/** Notification detail level requested at spawn time. */
	subscribe: BackgroundLaneSubscribeLevel;
	/** Timestamp of the last background_progress notification (throttle anchor). */
	lastProgressNotifyAt: number;
	/**
	 * Stable `--session-id` for this lane's rpc child. Reused across replies and
	 * crash respawns so the child's transcript continues from disk.
	 */
	sessionId: string;
}

/** Lane-scoped runtime wiring passed by background lanes into the child runner. */
export interface StepSubagentLaneRuntime {
	/** Parent-side hook invoked when the child emits a progress-report event. */
	onNeedsInput?: (message: string) => void;
	/** Parent-side hook fired when a dead keep-alive child is respawned. */
	onChildRespawn?: () => void;
	/** Stable per-lane child session id; task index N > 0 gets a `-N` suffix. */
	sessionId?: string;
	/** Keep rpc children alive after each turn so replies reuse the process. */
	keepAlive?: boolean;
}

/** Live children by subagent session id. One parent process owns its children. */
export const liveSubagentSessions = new Map<string, StepSubagentRpcSession>();

export function getLiveSubagentSession(sessionId: string | undefined): StepSubagentRpcSession | undefined {
	if (!sessionId) return undefined;
	const session = liveSubagentSessions.get(sessionId);
	return session?.isAlive() ? session : undefined;
}

/** All live rpc children belonging to one lane session. Task index 0 uses the
 * lane session id itself; parallel task N > 0 uses the `-N` suffix assigned in
 * executeSubagent. Session ids are UUID-based, so the prefix cannot collide
 * with another lane's ids. */
function getLiveLaneSessions(sessionId: string | undefined): StepSubagentRpcSession[] {
	if (!sessionId) return [];
	const prefix = `${sessionId}-`;
	const sessions: StepSubagentRpcSession[] = [];
	for (const [id, session] of liveSubagentSessions) {
		if ((id === sessionId || id.startsWith(prefix)) && session.isAlive()) sessions.push(session);
	}
	return sessions;
}

function laneStatusFromDetails(details: StepSubagentDetails): BackgroundAgentLane["status"] {
	if (details.results.some((record) => record.status === "running")) {
		return "running";
	}
	if (details.results.some((record) => record.status === "failed")) {
		return "failed";
	}
	if (details.results.some((record) => record.status === "aborted")) {
		return "aborted";
	}
	return "completed";
}

export function laneMatches(
	lane: BackgroundAgentLane,
	selector: {
		agentId?: string;
		agent_id?: string;
		alias?: string;
		group?: string;
	},
): boolean {
	const agentId = selector.agentId ?? selector.agent_id;
	if (agentId) return lane.id === agentId;
	if (selector.alias) return lane.alias === selector.alias;
	if (selector.group) return lane.group === selector.group;
	return true;
}

export function controlResult(text: string): AgentToolResult<undefined>;
export function controlResult<TDetails>(text: string, details: TDetails): AgentToolResult<TDetails>;
export function controlResult<TDetails>(text: string, details?: TDetails): AgentToolResult<TDetails | undefined> {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

/** Wiring the lane lifecycle needs from the extension factory in step-subagent.ts. */
export interface LaneLifecycleHost {
	pi: ExtensionAPI;
	/** Lane registry owned by the extension factory (agent_send selects from it). */
	lanes: Map<string, BackgroundAgentLane>;
	/** Resolved global Step agent root (`options.agentDir`). */
	agentDir: string;
	/** `executeSubagent` with the factory's resolved options already bound. */
	executeSubagent: (
		params: SubagentParams,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<StepSubagentDetails> | undefined,
		ctx: ExtensionContext,
		laneRuntime?: StepSubagentLaneRuntime,
	) => Promise<AgentToolResult<StepSubagentDetails>>;
	updateLaneWidget: (lane: BackgroundAgentLane) => void;
}

export interface LaneLifecycle {
	createLane: (params: SubagentParams, ctx: ExtensionContext) => BackgroundAgentLane;
	startLane: (lane: BackgroundAgentLane, params: SubagentParams) => void;
	stopLane: (lane: BackgroundAgentLane) => string;
	replyToLane: (lane: BackgroundAgentLane, prompt: string, interrupt: boolean) => string;
}

export function createLaneLifecycle(host: LaneLifecycleHost): LaneLifecycle {
	const { pi, lanes, agentDir, executeSubagent, updateLaneWidget } = host;
	const startLane = (lane: BackgroundAgentLane, params: SubagentParams): void => {
		const generation = lane.runGeneration + 1;
		lane.runGeneration = generation;
		lane.controller = new AbortController();
		lane.status = "running";
		lane.updatedAt = Date.now();
		lane.lastProgressNotifyAt = Date.now();
		const runParams = { ...params, run_in_background: undefined };
		const onUpdate = (partial: AgentToolResult<StepSubagentDetails>): void => {
			if (lane.runGeneration !== generation) return;
			if (partial.details) {
				lane.details = {
					...partial.details,
					agentId: lane.id,
					status: "running",
					startedAt: lane.startedAt,
					updatedAt: Date.now(),
				};
				lane.updatedAt = Date.now();
			}
			maybeNotifyLaneProgress(pi, lane);
			updateLaneWidget(lane);
		};
		const laneRuntime: StepSubagentLaneRuntime = {
			onNeedsInput: (message) => {
				if (lane.runGeneration !== generation) return;
				notifyLaneEvent(pi, lane, "background_needs_input", message);
			},
			onChildRespawn: () => {
				if (lane.runGeneration !== generation) return;
				notifyLaneEvent(
					pi,
					lane,
					"background_restarted",
					"the previous child process exited; a new child resumed its transcript from disk",
				);
			},
			sessionId: lane.sessionId,
			keepAlive: true,
		};
		const promise = executeSubagent(runParams, lane.controller.signal, onUpdate, lane.ctx, laneRuntime);
		lane.promise = promise;
		void promise
			.then((result) => {
				if (lane.runGeneration !== generation) return;
				lane.result = result;
				lane.details = {
					...(result.details ?? lane.details),
					agentId: lane.id,
					status: result.details ? laneStatusFromDetails(result.details) : "completed",
					startedAt: lane.startedAt,
					updatedAt: Date.now(),
				};
				lane.status = lane.details.status ?? "completed";
				lane.updatedAt = Date.now();
				if (lane.queuedPrompts.length === 0 || lane.status === "aborted") {
					notifyLaneFinal(pi, lane);
				}
				updateLaneWidget(lane);
				const next = lane.queuedPrompts.shift();
				if (next && lane.status !== "aborted") {
					startLane(lane, { ...lane.params, task: next, run_in_background: undefined });
				}
			})
			.catch((error: unknown) => {
				if (lane.runGeneration !== generation) return;
				lane.status = "failed";
				lane.updatedAt = Date.now();
				lane.result = controlResult(
					`Background agent ${lane.id} failed: ${error instanceof Error ? error.message : String(error)}`,
					lane.details,
				);
				notifyLaneFinal(pi, lane);
				updateLaneWidget(lane);
			});
	};
	const createLane = (params: SubagentParams, ctx: ExtensionContext): BackgroundAgentLane => {
		const id = randomUUID().slice(0, 8);
		const now = Date.now();
		const mode: StepSubagentDetails["mode"] =
			(params.chain?.length ?? 0) > 0 ? "chain" : (params.tasks?.length ?? 0) > 0 ? "parallel" : "single";
		const details: StepSubagentDetails = {
			mode,
			agentScope: params.agentScope ?? "user",
			userAgentsDir: path.join(agentDir, "agents"),
			projectAgentsDir: null,
			results: [],
			agentId: id,
			status: "running",
			startedAt: now,
			updatedAt: now,
		};
		const lane = {
			id,
			...(params.alias?.trim() ? { alias: params.alias.trim() } : {}),
			...(params.group?.trim() ? { group: params.group.trim() } : {}),
			params,
			ctx,
			controller: new AbortController(),
			status: "running" as const,
			details,
			promise: Promise.resolve(controlResult("pending", details)),
			queuedPrompts: [],
			startedAt: now,
			updatedAt: now,
			runGeneration: 0,
			subscribe: (params.subscribe ?? "final") as BackgroundLaneSubscribeLevel,
			lastProgressNotifyAt: now,
			sessionId: `${SUBAGENT_SESSION_ID_PREFIX}${randomUUID()}`,
		} satisfies BackgroundAgentLane;
		lanes.set(id, lane);
		return lane;
	};
	/** Shared "stop" verb: interrupt a lane's run and end its rpc children. A
	 * parallel lane owns one keep-alive child per task (session ids with `-N`
	 * suffixes), so every live child is stopped, not only task 0's. */
	const stopLane = (lane: BackgroundAgentLane): string => {
		const live = getLiveLaneSessions(lane.sessionId);
		if (lane.status !== "running") {
			if (live.length === 0) return `Agent ${lane.id} is already ${lane.status}`;
			for (const session of live) session.stop();
			const processes = live.length === 1 ? "its idle child process" : `${live.length} idle child processes`;
			return `Agent ${lane.id} is ${lane.status}; shut down ${processes}`;
		}
		lane.queuedPrompts.length = 0;
		lane.runGeneration += 1;
		const interrupted = lane.promise;
		lane.controller.abort();
		for (const session of live) session.stop();
		lane.status = "aborted";
		lane.updatedAt = Date.now();
		updateLaneWidget(lane);
		// Notify only after the aborted run has actually wound down. The
		// generation bump above keeps the run's own .then from double-firing.
		void interrupted
			.catch(() => undefined)
			.then(() => {
				if (lane.status === "aborted") notifyLaneEvent(pi, lane, "background_interrupted");
			});
		return `Interrupted agent ${lane.id}`;
	};
	/** Shared "reply" verb: deliver a prompt into the lane's ongoing transcript. */
	const replyToLane = (lane: BackgroundAgentLane, prompt: string, interrupt: boolean): string => {
		const live = getLiveSubagentSession(lane.sessionId);
		if (live?.isTurnActive()) {
			const delivered = live.send(
				interrupt
					? { type: "steer", id: randomUUID(), message: prompt }
					: { type: "follow_up", id: randomUUID(), message: prompt },
			);
			if (delivered) {
				lane.updatedAt = Date.now();
				return interrupt
					? `Steered agent ${lane.id}; the prompt interrupts its current turn`
					: `Queued follow-up for agent ${lane.id}; it runs when the current turn completes`;
			}
		}
		if (lane.status === "running") {
			// No live rpc child to inject into (for example a custom runner):
			// fall back to queue/restart semantics.
			if (!interrupt) {
				lane.queuedPrompts.push(prompt);
				return `Queued follow-up for agent ${lane.id}`;
			}
			lane.controller.abort();
			lane.queuedPrompts.length = 0;
			startLane(lane, { ...lane.params, task: prompt, run_in_background: undefined });
			return `Interrupted agent ${lane.id} and started the follow-up`;
		}
		startLane(lane, { ...lane.params, task: prompt, run_in_background: undefined });
		return `Started follow-up for agent ${lane.id}; its transcript continues from the previous turns`;
	};
	return { createLane, startLane, stopLane, replyToLane };
}
