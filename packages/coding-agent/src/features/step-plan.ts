/**
 * Step's plan-mode extension.
 *
 * The implementation follows Pi's plan-mode example, but uses Step's
 * model-facing tool names. State and interaction still go through Pi's
 * ExtensionAPI; there is no parallel plan state machine in the Step layer.
 *
 * Only the user enters plan mode (/plan or --plan). The mode is announced to
 * the model by appending a collaboration-mode block when it changes, never by
 * editing the system prompt or tool list, so the cached prefix survives a plan
 * cycle.
 */

import { existsSync, readFileSync } from "node:fs";
import type { AgentMessage } from "@step-harness/agent-core";
import type { EventBus } from "../core/event-bus.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ToolCallEventResult,
} from "../core/extensions/types.ts";
import { resolveToCwd } from "../core/tools/path-utils.ts";
import { type StepTelemetryReporter, trackStepTelemetry } from "../step/telemetry.ts";
import { getThenRunCommand } from "../step/then-run.ts";
import { findLegacyUnansweredHandoff } from "./plan-handoff.ts";
import { type LegacyPlanTodoFields, migrateLegacyPlanTodos } from "./plan-mode-migration.ts";
import {
	buildDefaultModePrompt,
	buildPlanModePrompt,
	PLAN_MODE_MESSAGE_TYPE,
	PLAN_MODE_PROMPT_VERSION,
} from "./plan-mode-prompt.ts";
import {
	getPlanFilePath,
	hashPlanContents,
	registerPlanModeTools,
	type StepPlanExitOutcome,
	type StepPlanModeController,
} from "./plan-mode-tools.ts";

const PLAN_TOOLS = [
	"read_file",
	"find_files",
	"search_files",
	"list_directory",
	"run_command",
	"clarify_user",
	"write_file",
	"edit_file",
	"exit_plan_mode",
];
const MUTATING_TOOLS = new Set(["write_file", "edit_file", "write", "edit"]);
const PLAN_TASK_TOOLS = new Set(["exit_plan_mode", "task_create", "task_update", "task_get", "task_list"]);

/**
 * Who put the session into plan mode. Only the user can now; "agent" is kept so
 * sessions written while the enter_plan_mode tool existed still restore.
 */
export type StepPlanSource = "user" | "agent" | "unknown";

interface PlanState {
	/**
	 * Format of this entry. 2 marks an entry that never narrowed the tool list;
	 * 3 also records the decision fact, so a wait left by an older build — which
	 * only the transcript could describe — is migrated once at restore.
	 */
	version?: 2 | 3;
	enabled: boolean;
	/**
	 * Legacy only: the list a narrowing entry replaced. Older builds dropped the
	 * editing tools on entry and could only restore by replaying this snapshot,
	 * so sessions written by them still rely on it. This build appends only the
	 * plan tools a profile lacks and remembers just those additions.
	 */
	toolsBeforePlanMode?: string[];
	planFilePath?: string;
	/**
	 * Hash of the proposal waiting for the user's answer.
	 *
	 * A decision fact, not a projection: set by the handoff, cleared by approval,
	 * revision, or leaving. Absent means nothing is waiting.
	 */
	pendingProposalHash?: string;
	/** "user" for /plan or --plan; "agent" only in sessions from the enter_plan_mode era. */
	planSource?: StepPlanSource;
}

/** The mode a collaboration-mode block told the model about. */
interface PlanModeAnnouncement {
	mode: "plan" | "default";
	planFilePath?: string;
	/** Content version of a Plan block; absent in blocks written before it. */
	version?: number;
}

interface AnnouncementRecord {
	customType?: string;
	details?: unknown;
}

/** Last announcement in the selected context; only runtime-authored custom messages count. */
function lastAnnouncement(records: readonly AnnouncementRecord[]): PlanModeAnnouncement | undefined {
	for (let index = records.length - 1; index >= 0; index--) {
		const record = records[index]!;
		if (record.customType !== PLAN_MODE_MESSAGE_TYPE) continue;
		const details = record.details;
		if (!details || typeof details !== "object" || !("mode" in details)) continue;
		if (details.mode === "default") return { mode: "default" };
		if (details.mode === "plan") {
			const planFilePath =
				"planFilePath" in details && typeof details.planFilePath === "string" ? details.planFilePath : undefined;
			const version = "version" in details && typeof details.version === "number" ? details.version : undefined;
			return { mode: "plan", planFilePath, ...(version === undefined ? {} : { version }) };
		}
	}
	return undefined;
}

/**
 * The block to append so the model's view matches the live mode, or undefined
 * when it already does. `planFilePath` is defined exactly when plan mode is on.
 *
 * `visible` is the last announcement the request still carries; `recorded` is
 * the last one in the branch history, including any that compaction summarized
 * away. An active mode must be visible, so a compacted Plan block is restored.
 * Leaving the mode is owed a Default block whenever Plan was the last recorded
 * announcement, even if that block was compacted: the summary can still carry
 * its rules. A branch that never announced plan mode needs no Default block.
 */
function announcementFor(
	planFilePath: string | undefined,
	visible: PlanModeAnnouncement | undefined,
	recorded: PlanModeAnnouncement | undefined,
) {
	if (planFilePath !== undefined) {
		// A block written by an older build states older rules; resuming it keeps
		// the model on those rules until a new turn appends the current one.
		const current = visible?.version === PLAN_MODE_PROMPT_VERSION;
		if (visible?.mode === "plan" && visible.planFilePath === planFilePath && current) return undefined;
		const details: PlanModeAnnouncement = {
			mode: "plan",
			planFilePath,
			version: PLAN_MODE_PROMPT_VERSION,
		};
		return {
			customType: PLAN_MODE_MESSAGE_TYPE,
			content: buildPlanModePrompt(planFilePath),
			display: false,
			details,
		};
	}
	if (recorded?.mode !== "plan") return undefined;
	const details: PlanModeAnnouncement = { mode: "default" };
	return { customType: PLAN_MODE_MESSAGE_TYPE, content: buildDefaultModePrompt(), display: false, details };
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

/** True when both lists hold the same tool names in the same order. */
function sameToolOrder(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((name, index) => name === right[index]);
}

const publishedPlanModes = new WeakMap<object, boolean>();
/** Plan path the live mode owns, so an in-memory override wins over the branch. */
const publishedPlanPaths = new WeakMap<object, string>();
/** Sessions whose host loaded this extension, so the permission pre-check can opt in. */
const planExtensionSessions = new WeakSet<object>();

export function markPlanExtensionMounted(sessionManager: object): void {
	planExtensionSessions.add(sessionManager);
}

export function isPlanExtensionMounted(sessionManager: object): boolean {
	return planExtensionSessions.has(sessionManager);
}
export function getStepPlanMode(manager: object): string {
	const value = publishedPlanModes.get(manager);
	return value === undefined ? "Unknown" : value ? "Plan" : "Default";
}

/** Latest plan state recorded on the branch, for hosts and guards. */
export interface StepPlanState {
	enabled: boolean;
	planFilePath?: string;
	planSource: StepPlanSource;
	/** Hash of the proposal waiting for the user's answer, when one is. */
	pendingProposalHash?: string;
}

/**
 * Plan mode as of the latest `step-plan` entry on the branch.
 *
 * Reads persisted state rather than the in-memory marker, so a guard that runs
 * before this process replayed `session_start` still sees the right answer.
 */
export function getStepPlanState(
	entries: readonly { type: string; customType?: string; data?: unknown }[],
): StepPlanState | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type !== "custom" || entry.customType !== "step-plan") continue;
		const data = entry.data;
		if (!data || typeof data !== "object" || !("enabled" in data) || typeof data.enabled !== "boolean") continue;
		const source = "planSource" in data ? data.planSource : undefined;
		return {
			enabled: data.enabled,
			planSource: source === "user" || source === "agent" ? source : "unknown",
			...("planFilePath" in data && typeof data.planFilePath === "string"
				? { planFilePath: data.planFilePath }
				: {}),
			...("pendingProposalHash" in data && typeof data.pendingProposalHash === "string"
				? { pendingProposalHash: data.pendingProposalHash }
				: {}),
		};
	}
	return undefined;
}

/**
 * The wait recorded on a session's branch, tolerating a session without one.
 *
 * The protocol hosts accept lightweight session facades in tests and embeds, and
 * a reply they owe the caller must not be the thing a missing branch breaks.
 */
export function pendingProposalOf(session: {
	sessionManager?: { getBranch?: () => readonly { type: string; customType?: string; data?: unknown }[] };
}): { pendingProposalHash?: string } | undefined {
	let branch: readonly { type: string; customType?: string; data?: unknown }[];
	try {
		branch = session.sessionManager?.getBranch?.() ?? [];
	} catch {
		// A session that cannot report its branch has no recorded wait.
		return undefined;
	}
	return getStepPlanState(branch);
}

export interface PlanModeToolCallDecision {
	planFilePath: string;
	targetPath: string;
	targetsPlanFile: boolean;
	block?: ToolCallEventResult;
}

/**
 * Plan mode's verdict on one tool call, or undefined when it decides nothing.
 *
 * The single source of truth for the plan-file boundary, shared by the Step
 * permission pre-check and this extension's own guard. Two spellings would
 * drift, and the drift is silent: a path one side accepts and the other blocks
 * is an edit the user is asked to approve and then refused.
 *
 * The live marker is authoritative when this process has published one: it is
 * only set after the matching state was persisted, so the common hot path costs
 * one WeakMap read instead of walking the branch. A process that has not seen
 * the session yet falls back to the branch.
 */
export function planModeToolCallDecision(options: {
	manager: { getBranch(): readonly { type: string; customType?: string; data?: unknown }[]; getSessionId(): string };
	cwd: string;
	toolName: string;
	input: unknown;
}): PlanModeToolCallDecision | undefined {
	if (!MUTATING_TOOLS.has(options.toolName)) return undefined;
	const live = publishedPlanModes.get(options.manager);
	if (live === false) return undefined;
	const state = live === true ? undefined : getStepPlanState(options.manager.getBranch());
	if (live !== true && !state?.enabled) return undefined;
	const planFilePath =
		publishedPlanPaths.get(options.manager) ??
		state?.planFilePath ??
		getPlanFilePath(options.manager.getSessionId(), options.cwd);
	const input = options.input;
	const targetPath =
		input && typeof input === "object" && "path" in input && typeof input.path === "string" ? input.path : "";
	const thenRun = getThenRunCommand(options.toolName, input);
	if (targetPath && resolveToCwd(targetPath, options.cwd) === resolveToCwd(planFilePath, options.cwd)) {
		// `then_run` is a shell command fused into the mutation, and gates elsewhere
		// already treat it as an embedded `run_command`. Writing the plan file is
		// allowed; the command that would run with it is not, or plan mode would
		// hand out arbitrary file writes through the one path it permits.
		if (thenRun !== undefined) {
			return {
				planFilePath,
				targetPath,
				targetsPlanFile: true,
				block: {
					block: true,
					reason: [
						"Plan mode is active, so this file mutation was blocked: `then_run` runs a shell command, which is not part of writing the plan.",
						`Target: ${targetPath}`,
						`Command: ${thenRun}`,
						"Write the plan file without `then_run`; verify the plan after the user approves it.",
					].join("\n"),
				},
			};
		}
		return { planFilePath, targetPath, targetsPlanFile: true };
	}
	if (thenRun !== undefined) {
		return {
			planFilePath,
			targetPath,
			targetsPlanFile: false,
			block: {
				block: true,
				reason: [
					`Plan mode is active, so this file mutation was blocked. Only the plan file may be written: ${planFilePath}`,
					`Target: ${targetPath || "(no path provided)"}`,
					`Command: ${thenRun}`,
					"Plan mode is a permission restriction, not a missing tool: do not retry this edit or rephrase the path.",
					"Write the implementation proposal to the plan file with write_file, then call exit_plan_mode to submit it for review.",
				].join("\n"),
			},
		};
	}
	return {
		planFilePath,
		targetPath,
		targetsPlanFile: false,
		block: {
			block: true,
			reason: [
				`Plan mode is active, so this file mutation was blocked. Only the plan file may be written: ${planFilePath}`,
				`Target: ${targetPath || "(no path provided)"}`,
				"Plan mode is a permission restriction, not a missing tool: do not retry this edit or rephrase the path.",
				"run_command keeps its normal permissions, but stay read-only while planning: do not use it to write or patch files.",
				"Write the implementation proposal to the plan file with write_file, then call exit_plan_mode to submit it for review.",
			].join("\n"),
		},
	};
}

/**
 * Status-bar chip: "Planning (user|agent|unknown)" while plan mode is on,
 * cleared (normal) otherwise.
 */
function updateStatus(
	ctx: ExtensionContext,
	enabled: boolean,
	planSource: StepPlanSource | undefined,
	planFilePath?: string,
): void {
	publishedPlanModes.set(ctx.sessionManager, enabled);
	if (enabled && planFilePath) publishedPlanPaths.set(ctx.sessionManager, planFilePath);
	else publishedPlanPaths.delete(ctx.sessionManager);
	if (enabled) {
		ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", `Planning (${planSource ?? "unknown"})`));
	} else {
		ctx.ui.setStatus("plan-mode", undefined);
	}
}

function recordPlanEnter(telemetry: StepTelemetryReporter | undefined, source: StepPlanSource): void {
	if (!telemetry) return;
	trackStepTelemetry(telemetry, "plan_mode_entered", { source });
}

function recordPlanExit(
	telemetry: StepTelemetryReporter | undefined,
	source: StepPlanSource | undefined,
	outcome: StepPlanExitOutcome,
): void {
	if (!telemetry) return;
	trackStepTelemetry(telemetry, "plan_mode_exited", { source: source ?? "unknown", outcome });
}

function recordPlanUpdate(
	telemetry: StepTelemetryReporter | undefined,
	source: StepPlanSource | undefined,
	created: boolean,
): void {
	if (!telemetry) return;
	trackStepTelemetry(telemetry, "plan_updated", { source: source ?? "unknown", created });
}

/** Create Step's native plan extension. */
export const createStepPlanExtension =
	(options: { telemetry?: StepTelemetryReporter } = {}): ExtensionFactory =>
	(pi: ExtensionAPI): void => {
		let enabled = false;
		/** Plan tools this process appended on entry; the only thing exit removes. */
		let planModeAddedTools: string[] | undefined;
		let planFilePath: string | undefined;
		let planSource: StepPlanSource | undefined;
		/**
		 * Hash of the proposal waiting for this user's answer.
		 *
		 * Set when the handoff records the reviewed snapshot, cleared by every
		 * decision. It is the one answer to "is a human decision pending", so the
		 * automatic-turn guard and the hosts read it instead of scanning the
		 * transcript for shape.
		 */
		let pendingProposal: string | undefined;
		// The event bus is optional so minimal embedder/test harnesses that stub
		// ExtensionAPI keep working without one.
		const events = (pi as { events?: EventBus }).events;

		/**
		 * Persist the branch's plan state.
		 *
		 * `carriesLegacyTools` is only set when rewriting a legacy entry during
		 * migration: the entry it replaces is the sole record of the list plan mode
		 * narrowed, so dropping it would strand that session on the next restore.
		 * Ordinary entries never carry a snapshot — this build appends tools
		 * instead of replacing the list.
		 */
		const persistPlanState = (carriesLegacyTools?: string[], nextEnabled = enabled): void => {
			pi.appendEntry("step-plan", {
				version: 3,
				enabled: nextEnabled,
				planFilePath,
				planSource: nextEnabled ? planSource : undefined,
				...(pendingProposal ? { pendingProposalHash: pendingProposal } : {}),
				...(carriesLegacyTools ? { toolsBeforePlanMode: carriesLegacyTools } : {}),
			});
		};
		/**
		 * Plan mode is a permission narrowing, not a capability change.
		 *
		 * The model keeps every tool it already had; the `tool_call` hook below
		 * denies mutations outside the plan file. Rebuilding the list would rewrite
		 * the request's tool block, which the provider serializes ahead of the
		 * system prompt and messages: one such edit invalidates the cached prefix
		 * for the whole conversation, so a single plan entry can re-bill hundreds of
		 * thousands of prompt tokens.
		 *
		 * A session that does not already offer every plan tool still has to gain
		 * them (a Pi-native profile lacks the Step aliases). Append only what is
		 * missing and keep the existing order, so the common Step profile — which
		 * already offers all of them — leaves the tool block byte-identical.
		 */
		const enable = (): void => {
			const active = pi.getActiveTools();
			const missing = PLAN_TOOLS.filter((name) => !active.includes(name));
			if (missing.length === 0) return;
			planModeAddedTools = missing;
			pi.setActiveTools([...active, ...missing]);
		};
		const restoreTools = (): void => {
			const added = planModeAddedTools;
			planModeAddedTools = undefined;
			if (!added || added.length === 0) return;
			// Remove only what entering added, so tools activated in the meantime
			// (a late MCP catalog, find_tools) keep their place in the list.
			const live = pi.getActiveTools();
			const remaining = live.filter((name) => !added.includes(name));
			if (remaining.length !== live.length) pi.setActiveTools(remaining);
		};
		const recordedAnnouncement = (ctx: ExtensionContext): PlanModeAnnouncement | undefined =>
			lastAnnouncement(ctx.sessionManager.getBranch().filter((entry) => entry.type === "custom_message"));
		const resolvePlanFilePath = (ctx: ExtensionContext): string =>
			planFilePath ?? getPlanFilePath(ctx.sessionManager.getSessionId(), ctx.cwd);
		const enter = (ctx: ExtensionContext): void => {
			markPlanExtensionMounted(ctx.sessionManager);
			const previousPath = planFilePath;
			// Entering is not a decision on a proposal from an earlier round. A fact
			// left by a caller handoff would otherwise be approvable against a
			// snapshot the user is no longer looking at.
			const previousPending = pendingProposal;
			pendingProposal = undefined;
			enabled = true;
			planSource = "user";
			planFilePath = resolvePlanFilePath(ctx);
			// Persist before publishing the live marker: a failed write must leave the
			// session exactly as it was, not enter a mode that resume cannot see.
			try {
				persistPlanState();
			} catch (error) {
				enabled = false;
				planSource = undefined;
				planFilePath = previousPath;
				pendingProposal = previousPending;
				throw error;
			}
			enable();
			recordPlanEnter(options.telemetry, planSource);
			updateStatus(ctx, enabled, planSource, planFilePath);
			ctx.ui.notify(
				`Plan mode enabled. Draft your proposal at ${planFilePath}; file-editing tools are limited to this path. Commands still use normal permissions.`,
				"info",
			);
		};
		/**
		 * Leave plan mode because its decision is over.
		 *
		 * Only a user decision comes through here — approval, or leaving. A caller
		 * handoff leaves through {@link handOffProposal}, which keeps the wait.
		 */
		const exit = (outcome: StepPlanExitOutcome, ctx: ExtensionContext): void => {
			if (!enabled) return;
			const previousPending = pendingProposal;
			pendingProposal = undefined;
			try {
				// Persist before lifting the live restriction: a failed write must leave
				// the session in plan mode, not strand the branch saying it is still on.
				persistPlanState(undefined, false);
			} catch (error) {
				// The write is the record; without it the decision never happened, so
				// the in-memory wait has to stay with the mode.
				pendingProposal = previousPending;
				throw error;
			}
			recordPlanExit(options.telemetry, planSource, outcome);
			enabled = false;
			planSource = undefined;
			restoreTools();
			updateStatus(ctx, enabled, planSource);
		};
		/**
		 * Leave plan mode because the user said so.
		 *
		 * Nothing else tells the model: the Default announcement only reaches its
		 * next request, so a run still streaming would keep going and, with the
		 * boundary lifted, start implementing the plan the user just rejected. End
		 * that work here instead of leaving it to read the mode change.
		 */
		const leaveByUser = (outcome: StepPlanExitOutcome, ctx: ExtensionContext): void => {
			// `exit` is a no-op outside the mode, and stopping a run the user never
			// put into plan mode would cut an ordinary answer short.
			if (!enabled) return;
			exit(outcome, ctx);
			if (!ctx.isIdle()) ctx.abort();
		};
		/**
		 * Late decisions must not be applied to the wrong proposal.
		 *
		 * The fact is written with the mode. A failed write leaves the branch
		 * saying something else, so the memory cannot keep the new value: a wait
		 * nobody recorded would hold every automatic turn back with no way to see
		 * why, and a decision nobody recorded would let work past a plan the user
		 * never approved.
		 */
		const writePendingProposal = (next: string | undefined): void => {
			const previous = pendingProposal;
			pendingProposal = next;
			try {
				persistPlanState();
			} catch (error) {
				pendingProposal = previous;
				throw error;
			}
		};
		const recordPendingProposal = (planHash: string): void => writePendingProposal(planHash);
		/**
		 * Record the wait and leave the mode in one write.
		 *
		 * Two writes would leave a window where the branch says a proposal waits
		 * but the caller never received one, or the reverse. The exit path is the
		 * only place that can publish the mode change, so it is inlined here rather
		 * than layered on top of `exit`.
		 */
		const handOffProposal = (planHash: string, outcome: StepPlanExitOutcome, ctx: ExtensionContext): void => {
			if (!enabled) {
				writePendingProposal(planHash);
				return;
			}
			const previousPending = pendingProposal;
			const previousSource = planSource;
			pendingProposal = planHash;
			enabled = false;
			planSource = undefined;
			try {
				persistPlanState(undefined, false);
			} catch (error) {
				pendingProposal = previousPending;
				enabled = true;
				planSource = previousSource;
				throw error;
			}
			recordPlanExit(options.telemetry, previousSource, outcome);
			restoreTools();
			updateStatus(ctx, enabled, planSource);
		};
		const clearPendingProposal = (): void => {
			if (pendingProposal === undefined) return;
			writePendingProposal(undefined);
		};
		const planModeController: StepPlanModeController = {
			isPlanModeActive: () => enabled,
			exitPlanMode: exit,
			resolvePlanFilePath,
			recordPendingProposal,
			handOffProposal,
			clearPendingProposal,
		};

		pi.registerFlag("plan", {
			description: "Start in plan mode (draft a proposal for approval)",
			type: "boolean",
			default: false,
		});
		pi.registerCommand("plan", {
			description:
				"Toggle plan mode with `/plan`, or `/plan on` and `/plan off` to state it outright. `/plan <task>` plans a task, `/plan approve [hash]` accepts a submitted proposal",
			handler: async (args, ctx) => {
				const prompt = args.trim();
				if (!prompt) {
					// The host draws the mode; a notice for it would be a row nobody
					// typed, on the screen the user is already reading.
					if (enabled) leaveByUser("toggled_off", ctx);
					else enter(ctx);
					return;
				}
				// Absolute verbs, so a host that can only send text can express
				// "leave" and "approve" without racing a toggle. A queued `/plan`
				// would otherwise flip whatever state the turn left behind.
				if (prompt === "on") {
					// The absolute counterpart of `off`, so a host never sends a toggle
					// whose effect depends on the state a turn left behind.
					if (!enabled) enter(ctx);
					return;
				}
				if (prompt === "off") {
					// Leaving is a decision even when the mode already ended: a caller
					// handoff leaves the proposal waiting, and the user saying "off" is
					// the answer that releases it.
					if (enabled) leaveByUser("toggled_off", ctx);
					else clearPendingProposal();
					return;
				}
				// `/plan approve` answers the proposal, `/plan approve <hash>` answers
				// that one. A hash is 64 lowercase hex characters, so any other text
				// after the verb is a task and falls through to the branch below.
				const namedProposal = /^approve\s+([0-9a-f]{64})$/.exec(prompt)?.[1];
				if (prompt === "approve" || namedProposal !== undefined) {
					// The user accepted the proposal the host showed them. Leaving the
					// mode and starting the implementation turn are one decision: the
					// only way this turn runs with file mutations enabled.
					//
					// The verb may name the proposal it answers. A host that draws the
					// card knows which snapshot the user clicked, and a decision that
					// arrives after a newer submission must not approve that one — the
					// file being current says nothing about which proposal was on screen.
					if (pendingProposal === undefined) {
						ctx.ui.notify("No plan is waiting for approval.", "warning");
						return;
					}
					if (namedProposal !== undefined && namedProposal !== pendingProposal) {
						ctx.ui.notify("That proposal is no longer waiting for approval.", "warning");
						return;
					}
					// The approval belongs to the snapshot the user read. A file edited
					// after the review cannot be approved by a click that approved other
					// text, so reread it and compare — the same rule the terminal applies.
					let current: string | undefined;
					try {
						current = hashPlanContents(readFileSync(resolvePlanFilePath(ctx), "utf8"));
					} catch {
						// Deleted or unreadable: not the reviewed snapshot either.
					}
					if (current !== pendingProposal) {
						// Nothing was decided: the wait stays, so automatic work keeps
						// holding until someone reviews the text that is on disk now.
						ctx.ui.notify("The plan changed since it was submitted; ask for a new review.", "warning");
						return;
					}
					// A caller handoff already left the mode; the caller answering in
					// text is the decision it was waiting for.
					if (enabled) exit("approved", ctx);
					else clearPendingProposal();
					// The decision itself is the command; this is only the instruction it
					// carries. As a user message it would read as a second thing the user
					// said, next to the command row they actually sent.
					pi.sendMessage(
						{
							customType: "step-plan-approved",
							display: false,
							content:
								"The user approved the plan. Plan mode is off and file mutations are re-enabled. Implement it now, using the plan file as the reference; do not silently diverge from it.",
						},
						{ triggerTurn: true },
					);
					return;
				}
				// `/plan <task>` is "plan this", never "toggle": make sure plan mode is
				// on, then hand the task to the model as an ordinary user turn. Slash
				// commands run even mid-stream; queue the task behind the current turn
				// in that case instead of throwing.
				//
				// A note on a proposal under review replaces it: the old snapshot is no
				// longer waiting for an answer, so the session does not hold a gate for
				// a proposal nobody is looking at. The notes are the whole message —
				// plan mode already tells the model that changes mean updating the plan
				// file and submitting again. A second, hidden instruction could not be
				// kept in the same request as the notes: the follow-up queue delivers
				// one message per request by default, so it would arrive on its own and
				// could send the model back to submit a plan it had not revised.
				if (!enabled) enter(ctx);
				clearPendingProposal();
				// Expand a leading `/skill:` or prompt template in the task, as the same
				// text sent without `/plan` would be (the web composer puts its plan
				// prefix in front of a picked skill).
				//
				// The words are the user's, forwarded: a proposal submitted by the turn
				// this waited behind must not turn their request for changes into
				// extension traffic that the pending-decision guard then holds back.
				pi.sendUserMessage(prompt, {
					expandPromptTemplates: true,
					source: ctx.mode === "tui" ? "interactive" : "rpc",
					...(ctx.isIdle() ? {} : { deliverAs: "followUp" as const }),
				});
			},
		});
		registerPlanModeTools(pi, planModeController);
		pi.on("tool_call", async (event, ctx) => {
			const decision = planModeToolCallDecision({
				manager: ctx.sessionManager,
				cwd: ctx.cwd,
				toolName: event.toolName,
				input: event.input,
			});
			if (decision?.targetsPlanFile && !decision.block) {
				// Allowed: the mutation targets the plan file itself. This runs
				// before the write lands, so a missing file marks the plan's creation.
				recordPlanUpdate(options.telemetry, planSource, !existsSync(decision.planFilePath));
			}
			return decision?.block;
		});

		// Announce mode changes by appending a collaboration-mode block, never by
		// rewriting the system prompt or tool list. The block persists with the
		// turn, so later requests reuse it from the cached history.
		pi.on("before_agent_start", async (_event, ctx) => {
			// Who can answer this proposal?
			//
			// A host with a review surface asks its user while the mode is on, so the
			// fact stays until an explicit verb — there a question is not consent. But
			// a pending left by a caller handoff (`enabled` already false) has no
			// surface left to answer it, even on this host: opening such a session in
			// the app must not lock it, so the next user turn is the decision.
			if (pendingProposal !== undefined && (!enabled || !ctx.planReviewSurface)) clearPendingProposal();
			const visible = lastAnnouncement(
				ctx.sessionManager.buildContextEntries().filter((entry) => entry.type === "custom_message"),
			);
			const message = announcementFor(
				enabled ? resolvePlanFilePath(ctx) : undefined,
				visible,
				recordedAnnouncement(ctx),
			);
			return message ? { message } : undefined;
		});

		// The context hook reconciles the request view without writing history.
		// Compaction can summarize the announcement away, and the mode can change
		// mid-run (exit_plan_mode approval, /plan while streaming) without a new
		// before_agent_start. It also scrubs hidden meta messages persisted by
		// sessions from older versions of this extension.
		pi.on("context", async (event, ctx) => {
			const messages = event.messages.filter((message) => {
				const candidate = message as AgentMessage & { customType?: string };
				return (
					candidate.customType !== "step-plan-context" && candidate.customType !== "step-plan-execution-context"
				);
			});
			const visible = lastAnnouncement(
				messages.filter((message) => message.role === "custom") as readonly AnnouncementRecord[],
			);
			const message = announcementFor(
				enabled ? resolvePlanFilePath(ctx) : undefined,
				visible,
				recordedAnnouncement(ctx),
			);
			if (!message) return { messages };
			return { messages: [...messages, { role: "custom" as const, ...message, timestamp: Date.now() }] };
		});

		const restorePlanState = (ctx: ExtensionContext, startWithPlan = false): void => {
			// Legacy tool lists predate these capabilities. Preserve only the ones
			// already active; ordinary tools still follow the saved branch selection.
			const activePlanTaskTools = pi.getActiveTools().filter((name) => PLAN_TASK_TOOLS.has(name));
			// Undo whatever the previous branch's entry applied before reading the next.
			restoreTools();
			const planStates = [...ctx.sessionManager.getBranch()].reverse().flatMap((entry) => {
				if (entry.type !== "custom" || entry.customType !== "step-plan") return [];
				const data = entry.data;
				// Skip malformed entries the same way `getStepPlanState` does, so a
				// branch and its live marker never disagree about the same history.
				if (!data || typeof data !== "object" || !("enabled" in data) || typeof data.enabled !== "boolean") {
					return [];
				}
				return [data as PlanState & LegacyPlanTodoFields];
			});
			const restoredPlanState = planStates[0];
			// The list to undo belongs to whichever entry narrowed it. An on-entry
			// wins over an older carried snapshot, so a newer plan session never
			// replays an earlier one's list; an off branch falls back to the last
			// entry that recorded one. This build records nothing on entry, so its
			// own entries only reach here after carrying a legacy list forward.
			const governingEntry = planStates.find((state) => state?.enabled || state?.toolsBeforePlanMode !== undefined);
			const legacyBaseline = governingEntry?.toolsBeforePlanMode;
			enabled = restoredPlanState?.enabled ?? false;
			planFilePath = restoredPlanState?.planFilePath;
			planSource = enabled ? (restoredPlanState?.planSource ?? "unknown") : undefined;
			// A proposal still waiting survives a restart, including a caller handoff
			// that already left the mode: the guard must keep holding work until
			// someone answers it, and only the answer clears this.
			pendingProposal = restoredPlanState?.pendingProposalHash;
			// An entry older than the fact recorded the wait only in the transcript.
			// Migrate it once, so upgrading does not silently lift the gate on a
			// session whose proposal nobody has answered.
			if (restoredPlanState && (restoredPlanState.version ?? 2) < 3) {
				pendingProposal = findLegacyUnansweredHandoff(ctx.sessionManager)?.planHash;
				// Written back once, so every reader of the branch — the automatic-turn
				// guard, the RPC and SDK replies, a host's card — sees one fact rather
				// than a migrated memory next to an entry that still lacks it.
				if (pendingProposal !== undefined) {
					try {
						persistPlanState();
					} catch {
						// The wait still holds this process; the next restore retries the
						// migration because the entry stays below version 3.
					}
				}
			}
			if (legacyBaseline) {
				const baseline = unique([...legacyBaseline, ...activePlanTaskTools]);
				if (!sameToolOrder(pi.getActiveTools(), baseline)) pi.setActiveTools(baseline);
			}
			if (enabled) {
				planFilePath = resolvePlanFilePath(ctx);
				enable();
			}
			if (restoredPlanState) {
				migrateLegacyPlanTodos({
					persistedPlanState: restoredPlanState,
					events,
					extensionContext: ctx,
					persistMigratedPlanState: () => persistPlanState(legacyBaseline),
				});
			}
			if (startWithPlan && !enabled) {
				enter(ctx);
				return;
			}
			updateStatus(ctx, enabled, planSource, planFilePath);
		};
		pi.on("session_start", async (event, ctx) => {
			// Two extensions in one runner receive different API objects, so the
			// presence marker is keyed by the session the pre-check also reads.
			markPlanExtensionMounted(ctx.sessionManager);
			// A proposal nobody has answered must not be continued past by an
			// automatic turn starter. The session asks this before any of them, so
			// each feature does not need its own copy of the rule. The answer comes
			// from the session fact the handoff records, not from the transcript: a
			// scan cannot tell an answer from a question, and cannot see a decision
			// that wrote no user message (`/plan off`).
			ctx.registerAutomaticTurnGuard?.(() => pendingProposal !== undefined);
			restorePlanState(ctx, event.reason === "startup" && pi.getFlag("plan") === true);
		});
		pi.on("session_tree", async (_event, ctx) => {
			markPlanExtensionMounted(ctx.sessionManager);
			restorePlanState(ctx);
		});
	};

export const stepPlanExtension = createStepPlanExtension();
