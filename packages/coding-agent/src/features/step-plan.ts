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

import { existsSync } from "node:fs";
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
import { type LegacyPlanTodoFields, migrateLegacyPlanTodos } from "./plan-mode-migration.ts";
import { buildDefaultModePrompt, buildPlanModePrompt, PLAN_MODE_MESSAGE_TYPE } from "./plan-mode-prompt.ts";
import {
	getPlanFilePath,
	registerPlanModeTools,
	type StepPlanExitOutcome,
	type StepPlanModeController,
	type StepPlanReviewState,
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
	/** Written by this build. Its presence marks an entry that never narrowed the tool list. */
	version?: 2;
	enabled: boolean;
	/**
	 * Legacy only: the list a narrowing entry replaced. Older builds dropped the
	 * editing tools on entry and could only restore by replaying this snapshot,
	 * so sessions written by them still rely on it. This build appends only the
	 * plan tools a profile lacks and remembers just those additions.
	 */
	toolsBeforePlanMode?: string[];
	planFilePath?: string;
	/** "user" for /plan or --plan; "agent" only in sessions from the enter_plan_mode era. */
	planSource?: StepPlanSource;
	review?: StepPlanReviewState;
}

/** The mode a collaboration-mode block told the model about. */
interface PlanModeAnnouncement {
	mode: "plan" | "default";
	planFilePath?: string;
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
			return { mode: "plan", planFilePath };
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
		if (visible?.mode === "plan" && visible.planFilePath === planFilePath) return undefined;
		const details: PlanModeAnnouncement = { mode: "plan", planFilePath };
		return {
			customType: PLAN_MODE_MESSAGE_TYPE,
			content: buildPlanModePrompt(planFilePath),
			display: false,
			details,
		};
	}
	if (recorded?.mode !== "plan" || visible?.mode === "default") return undefined;
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
export function getStepPlanMode(manager: object): string {
	const value = publishedPlanModes.get(manager);
	return value === undefined ? "Unknown" : value ? "Plan" : "Default";
}

/** Plan state read from the selected branch, including before the extension restores. */
export interface StepPlanState {
	enabled: boolean;
	planFilePath?: string;
	planSource: StepPlanSource;
	review?: StepPlanReviewState;
}

function readPlanReviewState(value: unknown): StepPlanReviewState | undefined {
	if (
		!value ||
		typeof value !== "object" ||
		!("id" in value) ||
		typeof value.id !== "string" ||
		!("planHash" in value) ||
		typeof value.planHash !== "string" ||
		!("outcome" in value)
	)
		return undefined;
	const outcome = value.outcome;
	if (
		outcome !== "pending" &&
		outcome !== "approved" &&
		outcome !== "feedback" &&
		outcome !== "dismissed" &&
		outcome !== "external_approval_required" &&
		outcome !== "unanswered" &&
		outcome !== "superseded"
	)
		return undefined;
	return { id: value.id, planHash: value.planHash, outcome };
}

export function getStepPlanState(
	entries: readonly { type: string; customType?: string; data?: unknown }[],
): StepPlanState | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type !== "custom" || entry.customType !== "step-plan") continue;
		const data = entry.data;
		if (!data || typeof data !== "object" || !("enabled" in data) || typeof data.enabled !== "boolean") continue;
		const source = "planSource" in data ? data.planSource : undefined;
		const review = readPlanReviewState("review" in data ? data.review : undefined);
		return {
			enabled: data.enabled,
			...(review ? { review } : {}),
			planSource: source === "user" || source === "agent" ? source : "unknown",
			...("planFilePath" in data && typeof data.planFilePath === "string"
				? { planFilePath: data.planFilePath }
				: {}),
		};
	}
	return undefined;
}

export interface PlanModeToolCallDecision {
	planFilePath: string;
	targetPath: string;
	targetsPlanFile: boolean;
	block?: ToolCallEventResult;
}

/** One plan-file boundary, shared by permission preflight and the plan guard. */
export function planModeToolCallDecision(options: {
	manager: { getBranch(): readonly { type: string; customType?: string; data?: unknown }[]; getSessionId(): string };
	cwd: string;
	toolName: string;
	input: unknown;
}): PlanModeToolCallDecision | undefined {
	if (!MUTATING_TOOLS.has(options.toolName)) return undefined;
	const state = getStepPlanState(options.manager.getBranch());
	// A failed persist or a non-recording embedder must not remove a live restriction.
	if (!state?.enabled && publishedPlanModes.get(options.manager) !== true) return undefined;
	const planFilePath = state?.planFilePath ?? getPlanFilePath(options.manager.getSessionId(), options.cwd);
	const input = options.input;
	const targetPath =
		input && typeof input === "object" && "path" in input && typeof input.path === "string" ? input.path : "";
	if (targetPath && resolveToCwd(targetPath, options.cwd) === resolveToCwd(planFilePath, options.cwd)) {
		return { planFilePath, targetPath, targetsPlanFile: true };
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
function updateStatus(ctx: ExtensionContext, enabled: boolean, planSource: StepPlanSource | undefined): void {
	publishedPlanModes.set(ctx.sessionManager, enabled);
	if (enabled) {
		const label = `Planning (${planSource ?? "unknown"})`;
		ctx.ui.setStatus("plan-mode", ctx.ui.theme ? ctx.ui.theme.fg("warning", label) : label);
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
		let review: StepPlanReviewState | undefined;
		let reviewController: AbortController | undefined;
		const invalidateReview = (): void => {
			const controller = reviewController;
			reviewController = undefined;
			if (controller && review?.outcome === "pending") review = { ...review, outcome: "superseded" };
			controller?.abort();
		};
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
		const persistPlanState = (
			carriesLegacyTools?: string[],
			nextState?: Pick<PlanState, "enabled" | "planSource">,
		): void => {
			pi.appendEntry("step-plan", {
				version: 2,
				enabled: nextState?.enabled ?? enabled,
				planFilePath,
				planSource: nextState ? nextState.planSource : planSource,
				...(review ? { review } : {}),
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
			invalidateReview();
			review = undefined;
			enabled = true;
			publishedPlanModes.set(ctx.sessionManager, true);
			planSource = "user";
			planFilePath = resolvePlanFilePath(ctx);
			enable();
			recordPlanEnter(options.telemetry, planSource);
			updateStatus(ctx, enabled, planSource);
			persistPlanState();
			ctx.ui.notify(
				`Plan mode enabled. Draft your proposal at ${planFilePath}; file-editing tools are limited to this path. Commands still use normal permissions.`,
				"info",
			);
		};
		const exit = (outcome: StepPlanExitOutcome, ctx: ExtensionContext): void => {
			if (!enabled) return;
			invalidateReview();
			// Commit the mode change before removing the live restriction.
			persistPlanState(undefined, { enabled: false });
			recordPlanExit(options.telemetry, planSource, outcome);
			enabled = false;
			planSource = undefined;
			restoreTools();
			updateStatus(ctx, enabled, planSource);
		};
		const planModeController: StepPlanModeController = {
			isPlanModeActive: () => enabled,
			beginReview: (id, planHash) => {
				if (!enabled || reviewController) return undefined;
				const controller = new AbortController();
				reviewController = controller;
				review = { id, planHash, outcome: "pending" };
				try {
					persistPlanState();
				} catch (error) {
					invalidateReview();
					throw error;
				}
				return {
					signal: controller.signal,
					settle: (outcome) => {
						if (!enabled || reviewController !== controller) return false;
						reviewController = undefined;
						review = { id, planHash, outcome };
						persistPlanState();
						return true;
					},
				};
			},
			exitPlanMode: exit,
			resolvePlanFilePath,
		};

		pi.registerFlag("plan", {
			description: "Start in plan mode (draft a proposal for approval)",
			type: "boolean",
			default: false,
		});
		pi.registerCommand("plan", {
			description: "Toggle plan mode, or `/plan <task>` to start planning a task right away",
			handler: async (args, ctx) => {
				const prompt = args.trim();
				if (!prompt) {
					if (enabled) {
						exit("toggled_off", ctx);
						ctx.ui.notify("Plan mode disabled.", "info");
					} else {
						enter(ctx);
					}
					return;
				}
				// `/plan <task>` is "plan this", never "toggle": make sure plan mode is on,
				// then hand the task to the model as an ordinary user turn. Tool
				// restriction has already been applied by enter(), so the turn starts
				// with the plan-mode tool set. Slash commands run even mid-stream; queue
				// the task behind the current turn in that case instead of throwing.
				if (enabled && reviewController) {
					invalidateReview();
					persistPlanState();
				}
				if (!enabled) enter(ctx);
				pi.sendUserMessage(prompt, {
					expandPromptTemplates: true,
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
			if (decision?.targetsPlanFile) {
				recordPlanUpdate(options.telemetry, planSource, !existsSync(decision.planFilePath));
			}
			return decision?.block;
		});

		// Announce mode changes by appending a collaboration-mode block, never by
		// rewriting the system prompt or tool list. The block persists with the
		// turn, so later requests reuse it from the cached history.
		pi.on("before_agent_start", async (_event, ctx) => {
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
			invalidateReview();
			// Legacy tool lists predate these capabilities. Preserve only the ones
			// already active; ordinary tools still follow the saved branch selection.
			const activePlanTaskTools = pi.getActiveTools().filter((name) => PLAN_TASK_TOOLS.has(name));
			// Undo whatever the previous branch's entry applied before reading the next.
			restoreTools();
			const planStates = [...ctx.sessionManager.getBranch()]
				.reverse()
				.flatMap((entry) =>
					entry.type === "custom" && entry.customType === "step-plan"
						? [entry.data as (PlanState & LegacyPlanTodoFields) | undefined]
						: [],
				);
			const restoredPlanState = planStates[0];
			// The list to undo belongs to whichever entry narrowed it. An on-entry
			// wins over an older carried snapshot, so a newer plan session never
			// replays an earlier one's list; an off branch falls back to the last
			// entry that recorded one. This build records nothing on entry, so its
			// own entries only reach here after carrying a legacy list forward.
			const governingEntry = planStates.find((state) => state?.enabled || state?.toolsBeforePlanMode !== undefined);
			const legacyBaseline = governingEntry?.toolsBeforePlanMode;
			const state = getStepPlanState(ctx.sessionManager.getBranch());
			enabled = state?.enabled ?? false;
			planFilePath = state?.planFilePath;
			planSource = enabled ? (state?.planSource ?? "unknown") : undefined;
			review = state?.review;
			const recoveredReview = review?.outcome === "pending";
			if (review && recoveredReview) review = { ...review, outcome: "unanswered" };
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
			if (recoveredReview) persistPlanState(legacyBaseline);
			if (startWithPlan && !enabled) {
				enter(ctx);
				return;
			}
			updateStatus(ctx, enabled, planSource);
		};
		pi.on("session_start", async (event, ctx) => {
			restorePlanState(ctx, event.reason === "startup" && pi.getFlag("plan") === true);
		});
		pi.on("session_tree", async (_event, ctx) => restorePlanState(ctx));
		pi.on("session_shutdown", () => invalidateReview());
	};

export const stepPlanExtension = createStepPlanExtension();
