/**
 * Step's plan-mode extension.
 *
 * The implementation follows Pi's plan-mode example, but uses Step's
 * model-facing tool names. State and interaction still go through Pi's
 * ExtensionAPI; there is no parallel plan state machine in the Step layer.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
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
import { compareTaskIds, type StepTask } from "./step-tasks.ts";

const PLAN_TOOLS = ["read_file", "find_files", "search_files", "list_directory", "run_command", "clarify_user"];
const MUTATING_TOOLS = new Set(["write_file", "edit_file", "write", "edit"]);

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
			if (!toolsBeforePlanMode) toolsBeforePlanMode = pi.getActiveTools();
			const activeToolNames = pi.getActiveTools();
			pi.setActiveTools(unique([...activeToolNames.filter((name) => !MUTATING_TOOLS.has(name)), ...PLAN_TOOLS]));
		};
		// enable() strips the mutating tools from the active set; re-add them so
		// the plan file itself stays writable. The tool_call hook below restricts
		// them to the plan file while plan mode is on.
		const allowPlanFileWrites = (): void => {
			pi.setActiveTools(unique([...pi.getActiveTools(), "write_file", "edit_file"]));
		};
		const restore = (): void => {
			if (toolsBeforePlanMode) {
				pi.setActiveTools(toolsBeforePlanMode);
			} else {
				pi.setActiveTools(
					unique([
						"read_file",
						"find_files",
						"search_files",
						"list_directory",
						"run_command",
						"write_file",
						"edit_file",
						...pi.getActiveTools(),
					]),
				);
			}
			toolsBeforePlanMode = undefined;
		};
		const toggle = (ctx: ExtensionContext): void => {
			enabled = !enabled;
			if (enabled) {
				planSource = "user";
				enable();
				recordPlanEnter(options.telemetry, "user");
				ctx.ui.notify("Plan mode enabled. File mutation and command execution are disabled.", "info");
			} else {
				recordPlanExit(options.telemetry, planSource, "toggled_off");
				planSource = undefined;
				restore();
				ctx.ui.notify("Plan mode disabled.", "info");
			}
			updateStatus(ctx, enabled, planSource);
			persistPlanState();
		};
		const resolvePlanFilePath = (ctx: ExtensionContext): string =>
			planFilePath ?? getPlanFilePath(ctx.sessionManager.getSessionId(), ctx.cwd);

		const planModeController: StepPlanModeController = {
			isPlanModeActive: () => enabled,
			enterPlanMode: (ctx) => {
				enabled = true;
				planSource = "agent";
				enable();
				allowPlanFileWrites();
				planFilePath = getPlanFilePath(ctx.sessionManager.getSessionId(), ctx.cwd);
				recordPlanEnter(options.telemetry, "agent");
				updateStatus(ctx, enabled, planSource);
				persistPlanState();
				return planFilePath;
			},
			exitPlanMode: (outcome, ctx) => {
				recordPlanExit(options.telemetry, planSource, outcome);
				enabled = false;
				planSource = undefined;
				restore();
				persistPlanState();
				updateStatus(ctx, enabled, planSource);
			},
			resolvePlanFilePath,
		};

		pi.registerFlag("plan", {
			description: "Start in plan mode (read-only exploration)",
			type: "boolean",
			default: false,
		});
		pi.registerCommand("plan", {
			description: "Toggle plan mode (read-only exploration)",
			handler: async (_args, ctx) => toggle(ctx),
		});
		pi.registerCommand("todos", {
			description: "Show session tasks tracked with the task_* tools",
			handler: async (_args, ctx) => {
				// Read the step-tasks extension's latest persisted snapshot. Every
				// task mutation persists a full snapshot, so the newest step-tasks
				// entry is the live task list without cross-extension coupling.
				const latestTasksEntry = [...ctx.sessionManager.getEntries()]
					.reverse()
					.find((candidate) => candidate.type === "custom" && candidate.customType === "step-tasks") as
					| { data?: { tasks?: StepTask[] } }
					| undefined;
				const tasks = (latestTasksEntry?.data?.tasks ?? []).filter(
					(task): task is StepTask => !!task && typeof task.id === "string" && typeof task.subject === "string",
				);
				if (tasks.length === 0) {
					ctx.ui.notify("No tasks tracked. Use task_create to add some.", "info");
					return;
				}
				const statusMarkers: Record<string, string> = { completed: "done", in_progress: "wip" };
				const tasksById = new Map(tasks.map((task) => [task.id, task]));
				const taskLines = tasks
					.sort((a, b) => compareTaskIds(a.id, b.id))
					.map((task) => {
						const statusMarker = statusMarkers[task.status] ?? "todo";
						const ownerLabel = task.owner ? ` @${task.owner}` : "";
						// Same semantics as task_list: report only blockers that still
						// exist and are not completed.
						const openBlockers = (Array.isArray(task.blockedBy) ? task.blockedBy : []).filter((blockerId) => {
							const blocker = tasksById.get(blockerId);
							return blocker !== undefined && blocker.status !== "completed";
						});
						const blockersLabel = openBlockers.length > 0 ? ` (blocked by ${openBlockers.join(", ")})` : "";
						return `${statusMarker} ${task.id}. ${task.subject}${ownerLabel}${blockersLabel}`;
					});
				ctx.ui.notify(taskLines.join("\n"), "info");
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

		pi.on("session_start", async (_event, ctx) => {
			const flagEnabled = pi.getFlag("plan") === true;
			if (flagEnabled) {
				enabled = true;
				planSource = "user";
			}
			const persistedPlanEntry = [...ctx.sessionManager.getEntries()]
				.reverse()
				.find((candidate) => candidate.type === "custom" && candidate.customType === "step-plan") as
				| { data?: PlanState & LegacyPlanTodoFields }
				| undefined;
			const restoredPlanState = persistedPlanEntry?.data;
			if (restoredPlanState) {
				enabled = restoredPlanState.enabled;
				toolsBeforePlanMode = restoredPlanState.toolsBeforePlanMode;
				planFilePath = restoredPlanState.planFilePath;
				planSource = restoredPlanState.planSource ?? (enabled ? "unknown" : undefined);
				migrateLegacyPlanTodos({
					persistedPlanState: restoredPlanState,
					events,
					extensionContext: ctx,
					persistMigratedPlanState: persistPlanState,
				});
			} else if (flagEnabled) {
				// A fresh session started with --plan is a real plan-mode entry;
				// restoring a persisted state is not.
				recordPlanEnter(options.telemetry, "user");
			}
			if (enabled) {
				enable();
				allowPlanFileWrites();
			}
			updateStatus(ctx, enabled, planSource);
		});
	};

export const stepPlanExtension = createStepPlanExtension();
