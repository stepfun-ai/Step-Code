/**
 * Step's plan-mode extension.
 *
 * The implementation follows Pi's plan-mode example, but uses Step's
 * model-facing tool names. State and interaction still go through Pi's
 * ExtensionAPI; there is no parallel plan state machine in the Step layer.
 */

import { existsSync } from "node:fs";
import type { AgentMessage } from "@step-harness/agent-core";
import type { EventBus } from "../core/event-bus.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "../core/extensions/types.ts";
import { resolveToCwd } from "../core/tools/path-utils.ts";
import { type StepTelemetryReporter, trackStepTelemetry } from "../step/telemetry.ts";
import { type LegacyPlanTodoFields, migrateLegacyPlanTodos } from "./plan-mode-migration.ts";
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
];
const MUTATING_TOOLS = new Set(["write_file", "edit_file", "write", "edit"]);
const PLAN_TASK_TOOLS = new Set([
	"enter_plan_mode",
	"exit_plan_mode",
	"task_create",
	"task_update",
	"task_get",
	"task_list",
]);

/** Who put the session into plan mode. */
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
	/** "user" for /plan or --plan, "agent" for enter_plan_mode. */
	planSource?: StepPlanSource;
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
		const resolvePlanFilePath = (ctx: ExtensionContext): string =>
			planFilePath ?? getPlanFilePath(ctx.sessionManager.getSessionId(), ctx.cwd);
		const enter = (source: StepPlanSource, ctx: ExtensionContext): string => {
			enabled = true;
			planSource = source;
			planFilePath = resolvePlanFilePath(ctx);
			enable();
			recordPlanEnter(options.telemetry, source);
			updateStatus(ctx, enabled, planSource);
			persistPlanState();
			if (source === "user") {
				ctx.ui.notify(
					`Plan mode enabled. Draft your proposal at ${planFilePath}; file-editing tools are limited to this path. Commands still use normal permissions.`,
					"info",
				);
			}
			return planFilePath;
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
			enterPlanMode: (ctx) => enter("agent", ctx),
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
						enter("user", ctx);
					}
					return;
				}
				// `/plan <task>` is "plan this", never "toggle": make sure plan mode is on,
				// then hand the task to the model as an ordinary user turn. Tool
				// restriction has already been applied by enter(), so the turn starts
				// with the plan-mode tool set. Slash commands run even mid-stream; queue
				// the task behind the current turn in that case instead of throwing.
				if (!enabled) enter("user", ctx);
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

		// Plan-mode state is carried by the enter_plan_mode/exit_plan_mode tool
		// results; nothing is injected into the context. This hook only scrubs
		// the hidden meta messages persisted by sessions from older versions of
		// this extension.
		pi.on("context", async (event) => {
			return {
				messages: event.messages.filter((message) => {
					const candidate = message as AgentMessage & { customType?: string };
					return (
						candidate.customType !== "step-plan-context" && candidate.customType !== "step-plan-execution-context"
					);
				}),
			};
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
				enter("user", ctx);
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
