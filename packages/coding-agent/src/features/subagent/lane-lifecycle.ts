/**
 * Background-lane lifecycle: lane creation, the `startLane` turn state machine
 * (generation-guarded callbacks + queued follow-up prompts), the shared
 * stop/reply/status verbs, idle child expiry, session shutdown, and the
 * registry of live rpc children keyed by lane session id. Tool registration and
 * child-process io stay in step-subagent.ts.
 */

import { randomBytes, randomUUID } from "node:crypto";
import type { AgentToolResult, AgentToolUpdateCallback } from "@step-harness/agent-core";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import type { StepSubagentDetails, StepSubagentRpcSession, SubagentParams } from "../step-subagent.ts";
import type { PreparedSubagentRun, SubagentPreflight } from "./execute.ts";
import { SUBAGENT_SESSION_ID_PREFIX } from "./helpers.ts";
import {
	type BackgroundLaneSubscribeLevel,
	buildLaneFinalDetail,
	laneSummaryLines,
	maybeNotifyLaneProgress,
	notifyLaneEvent,
} from "./lane-events.ts";

export interface BackgroundAgentLane {
	/** `lane_` followed by 8 hex digits; unique among this session's lanes. */
	id: string;
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
	/** Wall-clock limit for each turn, in ms. */
	turnTimeoutMs: number;
	/** Pending expiry of the lane's idle keep-alive children. */
	idleTimer?: ReturnType<typeof setTimeout>;
	/** Set when idle expiry stopped the children, so the next reply's respawn is expected. */
	idleExpired?: boolean;
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
	/** Wall-clock limit for each child turn, in ms. */
	turnTimeoutMs?: number;
}

/** Live children by subagent session id. One parent process owns its children. */
export const liveSubagentSessions = new Map<string, StepSubagentRpcSession>();

export function getLiveSubagentSession(sessionId: string | undefined): StepSubagentRpcSession | undefined {
	if (!sessionId) return undefined;
	const session = liveSubagentSessions.get(sessionId);
	return session?.isAlive() ? session : undefined;
}

/** All rpc children belonging to one lane session, live or still exiting. Task
 * index 0 uses the lane session id itself; parallel task N > 0 uses the `-N`
 * suffix assigned in executeSubagent. Session ids are UUID-based, so the prefix
 * cannot collide with another lane's ids. */
function getLaneSessions(sessionId: string, liveOnly = true): StepSubagentRpcSession[] {
	const prefix = `${sessionId}-`;
	const sessions: StepSubagentRpcSession[] = [];
	for (const [id, session] of liveSubagentSessions) {
		if ((id === sessionId || id.startsWith(prefix)) && (!liveOnly || session.isAlive())) sessions.push(session);
	}
	return sessions;
}

function laneStatusFromDetails(details: StepSubagentDetails): BackgroundAgentLane["status"] {
	if (details.results.some((record) => record.status === "running" || record.status === "queued")) {
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

export function controlResult(text: string): AgentToolResult<undefined>;
export function controlResult<TDetails>(text: string, details: TDetails): AgentToolResult<TDetails>;
export function controlResult<TDetails>(text: string, details?: TDetails): AgentToolResult<TDetails | undefined> {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

/** Running lanes one session may hold. Checked and reserved synchronously, so concurrent calls cannot overshoot. */
export const MAX_RUNNING_LANES = 8;
/** Idle keep-alive children are stopped after this long; a later reply respawns them from the transcript. */
export const LANE_IDLE_TTL_MS = 10 * 60_000;
/** How long session shutdown waits for stopped children before forcing them down. */
export const LANE_SHUTDOWN_WAIT_MS = 3_000;
/**
 * Finished lanes kept for `agent_send` reply/status. Older finished lanes are
 * forgotten (their idle children stopped) once their notification is out; their
 * child transcripts stay on disk.
 */
export const MAX_RETAINED_FINISHED_LANES = 16;
/** Tail of the last output returned by `agent_send` status. */
const STATUS_OUTPUT_TAIL_CHARS = 32_000;

/** Wiring the lane lifecycle needs from the extension factory in step-subagent.ts. */
export interface LaneLifecycleHost {
	pi: ExtensionAPI;
	/** Lane registry owned by the extension factory (agent_send selects from it). */
	lanes: Map<string, BackgroundAgentLane>;
	/** Preflight with the factory's resolved options already bound. */
	prepare: (params: SubagentParams, ctx: ExtensionContext) => Promise<SubagentPreflight>;
	/** Execution with the factory's resolved options already bound. */
	run: (
		prepared: PreparedSubagentRun,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<StepSubagentDetails> | undefined,
		ctx: ExtensionContext,
		laneRuntime: StepSubagentLaneRuntime,
	) => Promise<AgentToolResult<StepSubagentDetails>>;
	/** Directory that receives oversized notification output. */
	outputDirectory: (ctx: ExtensionContext) => string;
	updateLaneWidget: (lane: BackgroundAgentLane) => void;
	clearLaneWidget: () => void;
}

export interface LaneLifecycle {
	/**
	 * Create and start a lane for an already prepared call. Returns an error
	 * string, and creates nothing, when the session is at its running-lane limit.
	 */
	launchLane: (
		params: SubagentParams,
		ctx: ExtensionContext,
		prepared: PreparedSubagentRun,
		turnTimeoutMs: number,
	) => BackgroundAgentLane | string;
	stopLane: (lane: BackgroundAgentLane) => string;
	replyToLane: (lane: BackgroundAgentLane, prompt: string, interrupt: boolean) => string;
	laneStatus: (lane: BackgroundAgentLane) => string;
	/**
	 * Stop every lane this session owns, wait up to LANE_SHUTDOWN_WAIT_MS for
	 * their children, force the rest down, and forget the lanes. Callbacks from
	 * the stopped runs are dropped. Resolves with the number of lanes that were
	 * still running.
	 */
	shutdown: () => Promise<number>;
}

type LaneTurnSource = { prepared: PreparedSubagentRun } | { params: SubagentParams };

export function createLaneLifecycle(host: LaneLifecycleHost): LaneLifecycle {
	const { pi, lanes, updateLaneWidget } = host;
	/** Bumped by shutdown; lanes and callbacks from an earlier epoch are dead. */
	let epoch = 0;
	const laneEpochs = new WeakMap<BackgroundAgentLane, number>();
	const isCurrent = (lane: BackgroundAgentLane, generation: number): boolean =>
		laneEpochs.get(lane) === epoch && lane.runGeneration === generation;

	const clearIdleTimer = (lane: BackgroundAgentLane): void => {
		if (lane.idleTimer) clearTimeout(lane.idleTimer);
		lane.idleTimer = undefined;
	};

	/** After a turn settles, stop its keep-alive children once they have idled for LANE_IDLE_TTL_MS. */
	const armIdleTimer = (lane: BackgroundAgentLane): void => {
		clearIdleTimer(lane);
		if (getLaneSessions(lane.sessionId).length === 0) return;
		const generation = lane.runGeneration;
		lane.idleTimer = setTimeout(() => {
			lane.idleTimer = undefined;
			if (!isCurrent(lane, generation) || lane.status === "running") return;
			const live = getLaneSessions(lane.sessionId);
			if (live.length === 0) return;
			lane.idleExpired = true;
			for (const session of live) session.stop();
		}, LANE_IDLE_TTL_MS);
		lane.idleTimer.unref?.();
	};

	/** Finished lanes whose final notification has not been sent yet; never evicted. */
	const pendingFinal = new WeakSet<BackgroundAgentLane>();

	/** Forget the oldest finished lanes beyond MAX_RETAINED_FINISHED_LANES. */
	const evictFinishedLanes = (): void => {
		const finished = [...lanes.values()]
			.filter((lane) => lane.status !== "running" && !pendingFinal.has(lane))
			.sort((a, b) => a.updatedAt - b.updatedAt);
		for (const lane of finished.slice(0, Math.max(0, finished.length - MAX_RETAINED_FINISHED_LANES))) {
			clearIdleTimer(lane);
			for (const session of getLaneSessions(lane.sessionId)) session.stop();
			lanes.delete(lane.id);
		}
	};

	const deliverFinal = async (lane: BackgroundAgentLane, generation: number): Promise<void> => {
		pendingFinal.add(lane);
		try {
			const detail = await buildLaneFinalDetail(lane, host.outputDirectory(lane.ctx));
			if (!isCurrent(lane, generation)) return;
			notifyLaneEvent(
				pi,
				lane,
				lane.status === "failed"
					? "background_failed"
					: lane.status === "aborted"
						? "background_interrupted"
						: "background_done",
				detail,
			);
		} finally {
			pendingFinal.delete(lane);
			if (laneEpochs.get(lane) === epoch) evictFinishedLanes();
		}
	};

	const startLane = (lane: BackgroundAgentLane, source: LaneTurnSource): void => {
		clearIdleTimer(lane);
		const generation = lane.runGeneration + 1;
		lane.runGeneration = generation;
		lane.controller = new AbortController();
		lane.status = "running";
		lane.updatedAt = Date.now();
		lane.lastProgressNotifyAt = Date.now();
		const signal = lane.controller.signal;
		const onUpdate = (partial: AgentToolResult<StepSubagentDetails>): void => {
			if (!isCurrent(lane, generation)) return;
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
				if (!isCurrent(lane, generation)) return;
				notifyLaneEvent(pi, lane, "background_needs_input", message);
			},
			onChildRespawn: () => {
				if (!isCurrent(lane, generation)) return;
				// Idle expiry stopped the child on purpose; resuming it is routine.
				if (lane.idleExpired) return;
				notifyLaneEvent(
					pi,
					lane,
					"background_restarted",
					"the previous child process exited; a new child resumed its transcript from disk",
				);
			},
			sessionId: lane.sessionId,
			keepAlive: true,
			turnTimeoutMs: lane.turnTimeoutMs,
		};
		const promise = (async () => {
			let prepared: PreparedSubagentRun;
			if ("prepared" in source) prepared = source.prepared;
			else {
				const preflight = await host.prepare(source.params, lane.ctx);
				if (!preflight.ok) return preflight.result;
				prepared = preflight.run;
			}
			return host.run(prepared, signal, onUpdate, lane.ctx, laneRuntime);
		})();
		lane.promise = promise;
		void promise
			.then((result) => {
				if (!isCurrent(lane, generation)) return;
				lane.idleExpired = false;
				lane.result = result;
				lane.details = {
					...(result.details ?? lane.details),
					agentId: lane.id,
					status:
						result.details && result.details.results.length > 0
							? laneStatusFromDetails(result.details)
							: result.isError
								? "failed"
								: "completed",
					startedAt: lane.startedAt,
					updatedAt: Date.now(),
				};
				lane.status = lane.details.status ?? "completed";
				lane.updatedAt = Date.now();
				const next = lane.status === "aborted" ? undefined : lane.queuedPrompts.shift();
				if (next) {
					startLane(lane, { params: followUpParams(lane, next) });
					return;
				}
				lane.queuedPrompts.length = 0;
				updateLaneWidget(lane);
				armIdleTimer(lane);
				void deliverFinal(lane, generation);
			})
			.catch((error: unknown) => {
				if (!isCurrent(lane, generation)) return;
				lane.status = "failed";
				lane.updatedAt = Date.now();
				lane.details = { ...lane.details, status: "failed", updatedAt: lane.updatedAt };
				lane.result = controlResult(
					`Background lane ${lane.id} failed: ${error instanceof Error ? error.message : String(error)}`,
					lane.details,
				);
				updateLaneWidget(lane);
				armIdleTimer(lane);
				void deliverFinal(lane, generation);
			});
	};

	const newLaneId = (): string => {
		let id: string;
		do id = `lane_${randomBytes(4).toString("hex")}`;
		while (lanes.has(id));
		return id;
	};

	const launchLane: LaneLifecycle["launchLane"] = (params, ctx, prepared, turnTimeoutMs) => {
		// Check and reserve in one synchronous step: `subagent` calls in a batch
		// run concurrently, and an await between the two would let them overshoot.
		const running = [...lanes.values()].filter((lane) => lane.status === "running").length;
		if (running >= MAX_RUNNING_LANES) {
			return `This session already has ${running} running background lanes (limit ${MAX_RUNNING_LANES}). Wait for a lane to finish, stop one with agent_send action:"stop", or run this call in the foreground.`;
		}
		const id = newLaneId();
		const now = Date.now();
		const details: StepSubagentDetails = {
			mode: prepared.mode,
			agentScope: prepared.scope,
			userAgentsDir: prepared.discovery.userAgentsDir,
			projectAgentsDir: prepared.discovery.projectAgentsDir,
			results: [],
			agentId: id,
			status: "running",
			startedAt: now,
			updatedAt: now,
		};
		const lane: BackgroundAgentLane = {
			id,
			params,
			ctx,
			controller: new AbortController(),
			status: "running",
			details,
			promise: Promise.resolve(controlResult("pending", details)),
			queuedPrompts: [],
			startedAt: now,
			updatedAt: now,
			runGeneration: 0,
			subscribe: params.subscribe === "progress" ? "progress" : "final",
			lastProgressNotifyAt: now,
			sessionId: `${SUBAGENT_SESSION_ID_PREFIX}${randomUUID()}`,
			turnTimeoutMs,
		};
		laneEpochs.set(lane, epoch);
		lanes.set(id, lane);
		startLane(lane, { prepared });
		return lane;
	};

	/** Shared "stop" verb: interrupt a lane's run and end its rpc children. A
	 * parallel lane owns one keep-alive child per task (session ids with `-N`
	 * suffixes), so every live child is stopped, not only task 0's. */
	const stopLane = (lane: BackgroundAgentLane): string => {
		const live = getLaneSessions(lane.sessionId);
		if (lane.status !== "running") {
			clearIdleTimer(lane);
			if (live.length === 0) return `Lane ${lane.id} is already ${lane.status}`;
			for (const session of live) session.stop();
			const processes = live.length === 1 ? "its idle child process" : `${live.length} idle child processes`;
			return `Lane ${lane.id} is ${lane.status}; shut down ${processes}`;
		}
		lane.queuedPrompts.length = 0;
		const generation = lane.runGeneration + 1;
		lane.runGeneration = generation;
		const interrupted = lane.promise;
		lane.controller.abort();
		for (const session of live) session.stop();
		lane.status = "aborted";
		lane.updatedAt = Date.now();
		// Keep the lane until its interrupted notification is out.
		pendingFinal.add(lane);
		lane.details = { ...lane.details, status: "aborted", updatedAt: lane.updatedAt };
		updateLaneWidget(lane);
		// Notify only after the aborted run has actually wound down, with what it
		// produced. The generation bump above keeps the run's own .then from
		// double-firing.
		void interrupted
			.then(
				(result) => {
					if (!isCurrent(lane, generation)) return;
					lane.result = result;
					if (result.details) {
						lane.details = { ...result.details, agentId: lane.id, status: "aborted", startedAt: lane.startedAt };
					}
				},
				() => undefined,
			)
			.then(() => {
				if (isCurrent(lane, generation) && lane.status === "aborted") return deliverFinal(lane, generation);
				pendingFinal.delete(lane);
			});
		return `Stopped lane ${lane.id}; you will get one notification once it has wound down`;
	};

	/** Single-mode params for a follow-up turn. Approval was given when the lane started. */
	const followUpParams = (lane: BackgroundAgentLane, prompt: string): SubagentParams => ({
		agent: lane.details.results[0]?.agent ?? lane.params.agent,
		task: prompt,
		cwd: lane.params.cwd,
		agentScope: lane.params.agentScope,
		confirmProjectAgents: false,
	});

	/** Shared "reply" verb: deliver a prompt into a single-agent lane's ongoing transcript. */
	const replyToLane = (lane: BackgroundAgentLane, prompt: string, interrupt: boolean): string => {
		if (lane.details.mode !== "single") {
			return `agent_send: reply only works for single-agent lanes; lane ${lane.id} ran in ${lane.details.mode} mode. Start a new subagent call with the follow-up task instead.`;
		}
		const live = getLiveSubagentSession(lane.sessionId);
		if (lane.status === "running" && live?.isTurnActive()) {
			const delivered = live.send(
				interrupt
					? { type: "steer", id: randomUUID(), message: prompt }
					: { type: "follow_up", id: randomUUID(), message: prompt },
			);
			if (delivered) {
				lane.updatedAt = Date.now();
				return interrupt
					? `Steered lane ${lane.id}; the prompt interrupts its current turn`
					: `Queued follow-up for lane ${lane.id}; it runs when the current turn completes`;
			}
		}
		if (lane.status === "running") {
			// No live rpc child to inject into (for example a custom runner):
			// fall back to queue/restart semantics.
			if (!interrupt) {
				lane.queuedPrompts.push(prompt);
				return `Queued follow-up for lane ${lane.id}`;
			}
			lane.controller.abort();
			lane.queuedPrompts.length = 0;
			startLane(lane, { params: followUpParams(lane, prompt) });
			return `Interrupted lane ${lane.id} and started the follow-up`;
		}
		const running = [...lanes.values()].filter((entry) => entry.status === "running").length;
		if (running >= MAX_RUNNING_LANES) {
			return `agent_send: this session already has ${running} running background lanes (limit ${MAX_RUNNING_LANES}); wait for one to finish before replying to lane ${lane.id}.`;
		}
		startLane(lane, { params: followUpParams(lane, prompt) });
		return `Started follow-up for lane ${lane.id}; its transcript continues from the previous turns. You will be notified when it finishes.`;
	};

	const laneStatus = (lane: BackgroundAgentLane): string => {
		const agents = [...new Set(lane.details.results.map((record) => record.agent))];
		const lines = [
			`Lane ${lane.id}: ${lane.status}${agents.length > 0 ? ` (${agents.join(", ")})` : ""}`,
			...laneSummaryLines(lane),
		];
		const output =
			lane.result?.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n")
				.trim() ?? "";
		if (output) {
			const tail = output.length > STATUS_OUTPUT_TAIL_CHARS;
			lines.push(
				`${lane.status === "running" ? "Output of the previous turn" : "Output"}${tail ? ` (last ${STATUS_OUTPUT_TAIL_CHARS} characters; the child session holds the rest)` : ""}:\n${tail ? output.slice(-STATUS_OUTPUT_TAIL_CHARS) : output}`,
			);
		} else if (lane.status !== "running") lines.push("Output: (none)");
		if (lane.status === "running") {
			lines.push("The lane is still running; you will be notified when it finishes. Do not poll.");
		}
		return lines.join("\n\n");
	};

	const shutdown = async (): Promise<number> => {
		epoch += 1;
		const owned = [...lanes.values()];
		lanes.clear();
		host.clearLaneWidget();
		const running = owned.filter((lane) => lane.status === "running").length;
		const sessions: StepSubagentRpcSession[] = [];
		const runs: Promise<unknown>[] = [];
		for (const lane of owned) {
			clearIdleTimer(lane);
			lane.queuedPrompts.length = 0;
			lane.runGeneration += 1;
			if (lane.status === "running") {
				lane.controller.abort();
				lane.status = "aborted";
				runs.push(lane.promise.catch(() => undefined));
			}
			for (const session of getLaneSessions(lane.sessionId, false)) {
				session.stop();
				sessions.push(session);
			}
		}
		if (runs.length === 0 && sessions.length === 0) return running;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const settled = Promise.all([...runs, ...sessions.map((session) => session.exited)]).then(() => true);
		const timedOut = new Promise<boolean>((resolve) => {
			timer = setTimeout(() => resolve(false), LANE_SHUTDOWN_WAIT_MS);
			timer.unref?.();
		});
		const clean = await Promise.race([settled, timedOut]);
		if (timer) clearTimeout(timer);
		if (!clean) for (const session of sessions) session.terminate();
		return running;
	};

	return { launchLane, stopLane, replyToLane, laneStatus, shutdown };
}
