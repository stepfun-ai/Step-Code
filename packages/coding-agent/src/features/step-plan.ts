/**
 * Step's plan-mode extension.
 *
 * The implementation follows Pi's plan-mode example, but uses Step's
 * model-facing tool names. State and interaction still go through Pi's
 * ExtensionAPI; there is no parallel plan state machine in the Step layer.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import type { AgentMessage } from "@step-harness/agent-core";
import type { EventBus } from "../core/event-bus.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "../core/extensions/types.ts";
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
	enabled: boolean;
	toolsBeforePlanMode?: string[];
	planFilePath?: string;
	/** "user" for /plan or --plan, "agent" for enter_plan_mode. */
	planSource?: StepPlanSource;
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

/**
 * Status-bar chip: "Planning (user|agent|unknown)" while plan mode is on,
 * cleared (normal) otherwise.
 */
function updateStatus(ctx: ExtensionContext, enabled: boolean, planSource: StepPlanSource | undefined): void {
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
		let toolsBeforePlanMode: string[] | undefined;
		let planFilePath: string | undefined;
		let planSource: StepPlanSource | undefined;
		// The event bus is optional so minimal embedder/test harnesses that stub
		// ExtensionAPI keep working without one.
		const events = (pi as { events?: EventBus }).events;

		const persistPlanState = (): void => {
			pi.appendEntry("step-plan", { enabled, toolsBeforePlanMode, planFilePath, planSource });
		};
		const enable = (): void => {
			toolsBeforePlanMode ??= pi.getActiveTools();
			// Keep plan-file writes available; tool_call restricts their target.
			pi.setActiveTools(unique([...toolsBeforePlanMode.filter((name) => !MUTATING_TOOLS.has(name)), ...PLAN_TOOLS]));
		};
		const restoreTools = (): void => {
			if (toolsBeforePlanMode) pi.setActiveTools(toolsBeforePlanMode);
			toolsBeforePlanMode = undefined;
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
			const toolInput = event.input as Record<string, unknown>;
			const targetPath = typeof toolInput.path === "string" ? toolInput.path : "";
			if (targetPath && path.resolve(ctx.cwd, targetPath) === path.resolve(planPath)) {
				// Allowed: the mutation targets the plan file itself. This runs
				// before the write lands, so a missing file marks the plan's creation.
				recordPlanUpdate(options.telemetry, planSource, !existsSync(planPath));
				return;
			}
			return {
				block: true,
				reason: `Plan mode blocked this file mutation. Only the plan file may be written: ${planPath}\nTarget: ${targetPath || "(no path provided)"}`,
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
			// Undo the previous branch's tool restriction before reading the new one.
			restoreTools();
			const planStates = [...ctx.sessionManager.getBranch()]
				.reverse()
				.flatMap((entry) =>
					entry.type === "custom" && entry.customType === "step-plan"
						? [entry.data as (PlanState & LegacyPlanTodoFields) | undefined]
						: [],
				);
			const restoredPlanState = planStates[0];
			// Off snapshots omit transient tools; a preceding plan entry retains the baseline.
			const savedTools = planStates.find((state) => state?.toolsBeforePlanMode)?.toolsBeforePlanMode;
			enabled = restoredPlanState?.enabled ?? false;
			toolsBeforePlanMode = savedTools ? unique([...savedTools, ...activePlanTaskTools]) : undefined;
			planFilePath = restoredPlanState?.planFilePath;
			planSource = enabled ? (restoredPlanState?.planSource ?? "unknown") : undefined;
			if (enabled) {
				planFilePath = resolvePlanFilePath(ctx);
				enable();
			} else {
				restoreTools();
			}
			if (restoredPlanState) {
				migrateLegacyPlanTodos({
					persistedPlanState: restoredPlanState,
					events,
					extensionContext: ctx,
					persistMigratedPlanState: persistPlanState,
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
