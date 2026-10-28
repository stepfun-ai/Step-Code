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
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "../core/extensions/types.ts";
import { resolveToCwd } from "../core/tools/path-utils.ts";
import { type StepTelemetryReporter, trackStepTelemetry } from "../step/telemetry.ts";
import { type LegacyPlanTodoFields, migrateLegacyPlanTodos } from "./plan-mode-migration.ts";
import { buildDefaultModePrompt, buildPlanModePrompt, PLAN_MODE_MESSAGE_TYPE } from "./plan-mode-prompt.ts";
import {
	getPlanFilePath,
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
export function getStepPlanMode(manager: object): string {
	const value = publishedPlanModes.get(manager);
	return value === undefined ? "Unknown" : value ? "Plan" : "Default";
}

/**
 * Status-bar chip: "Planning (user|agent|unknown)" while plan mode is on,
 * cleared (normal) otherwise.
 */
function updateStatus(ctx: ExtensionContext, enabled: boolean, planSource: StepPlanSource | undefined): void {
	publishedPlanModes.set(ctx.sessionManager, enabled);
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
		const persistPlanState = (carriesLegacyTools?: string[]): void => {
			pi.appendEntry("step-plan", {
				version: 2,
				enabled,
				planFilePath,
				planSource,
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
			enabled = true;
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
			recordPlanExit(options.telemetry, planSource, outcome);
			enabled = false;
			planSource = undefined;
			restoreTools();
			persistPlanState();
			updateStatus(ctx, enabled, planSource);
		};
		const planModeController: StepPlanModeController = {
			isPlanModeActive: () => enabled,
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
				if (!enabled) enter(ctx);
				pi.sendUserMessage(prompt, ctx.isIdle() ? {} : { deliverAs: "followUp" });
			},
		});
		registerPlanModeTools(pi, planModeController);
		pi.on("tool_call", async (event, ctx) => {
			if (!enabled || !MUTATING_TOOLS.has(event.toolName)) return;
			const planPath = resolvePlanFilePath(ctx);
			const toolInput = (event.input ?? {}) as Record<string, unknown>;
			const targetPath = typeof toolInput.path === "string" ? toolInput.path : "";
			// Resolve exactly as the file tools do (`~`, `@`, unicode spaces), so an
			// allowed target cannot land somewhere else than the guard checked.
			if (targetPath && resolveToCwd(targetPath, ctx.cwd) === resolveToCwd(planPath, ctx.cwd)) {
				// Allowed: the mutation targets the plan file itself. This runs
				// before the write lands, so a missing file marks the plan's creation.
				recordPlanUpdate(options.telemetry, planSource, !existsSync(planPath));
				return;
			}
			return {
				block: true,
				reason: [
					`Plan mode is active, so this file mutation was blocked. Only the plan file may be written: ${planPath}`,
					`Target: ${targetPath || "(no path provided)"}`,
					"Plan mode is a permission restriction, not a missing tool: do not retry this edit or rephrase the path.",
					"run_command keeps its normal permissions, but stay read-only while planning: do not use it to write or patch files.",
					`Write the implementation proposal to the plan file with write_file, then call exit_plan_mode to submit it for review.`,
				].join("\n"),
			};
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
			enabled = restoredPlanState?.enabled ?? false;
			planFilePath = restoredPlanState?.planFilePath;
			planSource = enabled ? (restoredPlanState?.planSource ?? "unknown") : undefined;
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
			updateStatus(ctx, enabled, planSource);
		};
		pi.on("session_start", async (event, ctx) => {
			restorePlanState(ctx, event.reason === "startup" && pi.getFlag("plan") === true);
		});
		pi.on("session_tree", async (_event, ctx) => restorePlanState(ctx));
	};

export const stepPlanExtension = createStepPlanExtension();
