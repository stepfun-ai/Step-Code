/**
 * Model-facing plan-mode tools: enter_plan_mode and exit_plan_mode.
 *
 * The tools own only the interaction surface (guards, review dialog, result
 * texts). Plan-mode state lives in the step-plan extension and is driven
 * through {@link StepPlanModeController}, so the tools stay stateless.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import { PlanReviewComponent, type PlanReviewResult } from "../modes/interactive/components/plan-review.ts";

/** Exit outcome dimension for plan_mode_exited telemetry. */
export type StepPlanExitOutcome = "approved" | "toggled_off" | "auto_headless" | "auto_rpc";

/** State transitions the plan-mode tools drive on the step-plan extension. */
export interface StepPlanModeController {
	isPlanModeActive(): boolean;
	/**
	 * Agent-initiated entry (the enter_plan_mode tool); user entry is the
	 * /plan toggle owned by the extension. Returns the session plan file path.
	 */
	enterPlanMode(extensionContext: ExtensionContext): string;
	/** Leave plan mode: restore tools, persist state, record telemetry. */
	exitPlanMode(outcome: StepPlanExitOutcome, extensionContext: ExtensionContext): void;
	/** Plan file path for this session (persisted or derived from the session id). */
	resolvePlanFilePath(extensionContext: ExtensionContext): string;
}

/** Absolute path of the per-session plan file under the project workspace. */
export function getPlanFilePath(sessionId: string, projectCwd?: string): string {
	return path.join(projectCwd ?? process.cwd(), ".step-cli", "plans", `session-${sessionId}.md`);
}

function controlResult(text: string): AgentToolResult<undefined> {
	return { content: [{ type: "text", text }], details: undefined };
}

/**
 * The plan is shown in full: a review that hides the end of the proposal asks the
 * user to approve something they have not read. The same text goes to the headless
 * and rpc callers, which must gate approval on it.
 */
function readPlanContents(planFilePath: string): string {
	if (!statSync(planFilePath).isFile()) throw new Error("The plan path is not a regular file");
	const planContent = readFileSync(planFilePath, "utf8");
	if (planContent.trim().length === 0) throw new Error("The plan file is empty or whitespace-only");
	return planContent;
}

const STAY_IN_PLAN_MODE_RESULT =
	"Staying in plan mode. Continue planning and call exit_plan_mode again when the plan is ready.";

/**
 * Run the interactive review.
 *
 * The dialog offers approval and a line of feedback, nothing else: a third
 * "keep going, no comment" choice told the model nothing that dismissing the
 * dialog does not already say, so Escape covers it.
 */
async function reviewPlanInteractively(
	extensionContext: ExtensionContext,
	planFilePath: string,
	planContents: string,
): Promise<PlanReviewResult> {
	return extensionContext.ui.custom<PlanReviewResult>(
		(tui, theme, _keybindings, done) =>
			new PlanReviewComponent({
				planFilePath,
				planContents,
				theme,
				onResult: done,
				onChange: () => tui.requestRender(),
			}),
		{
			// The footer keeps advertising model, cwd, and context budget under a dialog
			// that owns the whole decision, which reads as if input were still accepted.
			hideFooter: true,
			// The turn is blocked on the user: stop animating progress, and keep the
			// review time out of the tool's reported duration.
			waitingForApproval: true,
		},
	);
}

/** Register enter_plan_mode and exit_plan_mode against the given controller. */
export function registerPlanModeTools(pi: ExtensionAPI, planMode: StepPlanModeController): void {
	pi.registerTool({
		name: "enter_plan_mode",
		label: "Enter plan mode",
		description:
			"Enter plan mode to research and propose an implementation approach before coding, not to track todos. Returns the proposal file path; use write_file or edit_file to record the approach, trade-offs, steps, and validation for review. File-editing tools are limited to that file; commands still use normal permissions.",
		promptSnippet: "Enter planning to draft an implementation proposal",
		parameters: Type.Object({}),
		execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
			if (planMode.isPlanModeActive()) {
				return controlResult(
					`Already in plan mode. Write your proposal to ${planMode.resolvePlanFilePath(ctx)} using write_file or edit_file, then call exit_plan_mode when it is ready.`,
				);
			}
			const planFilePath = planMode.enterPlanMode(ctx);
			return controlResult(
				`Plan mode active. Explore the repository, then write your proposal to ${planFilePath} using write_file. Call exit_plan_mode when it is ready for review.`,
			);
		},
	});
	pi.registerTool({
		name: "exit_plan_mode",
		label: "Exit plan mode",
		description:
			"Submit the written proposal for review. Requires a readable, nonempty regular plan file. In interactive mode, user approval exits planning; staying, refining, or cancelling keeps it active. In headless and RPC modes, exits without interactive approval; the caller must gate approval externally before execution.",
		promptSnippet: "Submit the written proposal for review",
		parameters: Type.Object({}),
		execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
			if (!planMode.isPlanModeActive()) return controlResult("Not in plan mode.");
			const planFilePath = planMode.resolvePlanFilePath(ctx);
			if (!existsSync(planFilePath)) {
				return controlResult(
					`No plan file at ${planFilePath}. Check the path and permissions, then write it with write_file and call exit_plan_mode again.`,
				);
			}
			let planContents: string;
			try {
				planContents = readPlanContents(planFilePath);
			} catch (error) {
				return controlResult(
					`Cannot review the plan at ${planFilePath}: ${error instanceof Error ? error.message : String(error)}. Provide a readable, nonempty regular file containing your proposal with write_file, then call exit_plan_mode again.`,
				);
			}
			if (ctx.mode === "rpc") {
				// An rpc child has a dialog bridge (hasUI is true) but no real user
				// behind it, so its extension_ui_request select can be auto-cancelled
				// to "Stay", leaving the child idle in plan mode forever. Auto-approve
				// the exit instead and hand the approval to the caller.
				planMode.exitPlanMode("auto_rpc", ctx);
				ctx.ui.notify("rpc child auto-approved plan mode exit — user oversight was not gated", "warning");
				return controlResult(
					`Cannot gate approval in rpc child context. Plan file at ${planFilePath}; caller should approve externally. Plan mode exited and file mutations are re-enabled.\n\nPlan contents:\n${planContents}`,
				);
			}
			if (!ctx.hasUI) {
				planMode.exitPlanMode("auto_headless", ctx);
				return controlResult(
					`Plan mode exited. Plan file kept at ${planFilePath} for reference.\n\nPlan contents:\n${planContents}\n\nCannot show interactive prompt; caller must gate approval externally.`,
				);
			}
			const review = await reviewPlanInteractively(ctx, planFilePath, planContents);
			if (review?.action === "execute") {
				planMode.exitPlanMode("approved", ctx);
				return controlResult(
					`The user approved the plan. Plan mode exited and file mutations are re-enabled. Execute the plan now, using ${planFilePath} as the reference; do not silently diverge from it.`,
				);
			}
			if (review?.action === "feedback") {
				// Steer, don't follow up. This tool returns a result, so the agent keeps
				// running; the follow-up queue is only drained once it would stop on its
				// own. The model, told notes were coming but not seeing any, stopped by
				// asking clarify_user what to change — which never ends the run, so the
				// note stayed queued. Steering lands it before the very next response.
				pi.sendUserMessage(`Plan refinement requested. Update ${planFilePath} based on:\n\n${review.text}`, {
					deliverAs: "steer",
				});
				return controlResult(
					"The user requested refinements. Their notes follow immediately as the next user message; do not ask what to change. Staying in plan mode: apply the notes to the plan file and call exit_plan_mode again.",
				);
			}
			// Dismissed, or a host that cannot show the dialog at all.
			return controlResult(STAY_IN_PLAN_MODE_RESULT);
		},
	});
}
