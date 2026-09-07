/**
 * Model-facing plan-mode tools: enter_plan_mode and exit_plan_mode.
 *
 * The tools own only the interaction surface (guards, review select, result
 * texts). Plan-mode state lives in the step-plan extension and is driven
 * through {@link StepPlanModeController}, so the tools stay stateless.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";

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

const PLAN_PREVIEW_MAX_CHARS = 2000;

function readPlanPreview(planFilePath: string): string {
	if (!statSync(planFilePath).isFile()) throw new Error("The plan path is not a regular file");
	const planContent = readFileSync(planFilePath, "utf8");
	if (planContent.trim().length === 0) throw new Error("The plan file is empty or whitespace-only");
	if (planContent.length <= PLAN_PREVIEW_MAX_CHARS) return planContent;
	return `${planContent.slice(0, PLAN_PREVIEW_MAX_CHARS)}\n... (truncated, full plan in file)`;
}

async function requestPlanRefinement(
	pi: ExtensionAPI,
	extensionContext: ExtensionContext,
	planFilePath: string,
): Promise<AgentToolResult<undefined>> {
	const refinement = await extensionContext.ui.editor("Refine the plan:", "");
	if (!refinement?.trim()) {
		return controlResult("Refinement cancelled by the user. Staying in plan mode.");
	}
	pi.sendUserMessage(`Plan refinement requested. Update ${planFilePath} based on:\n\n${refinement.trim()}`, {
		deliverAs: "followUp",
	});
	return controlResult(
		"Awaiting user notes: the user requested refinements (delivered as a follow-up message). Staying in plan mode; update the plan file and call exit_plan_mode again.",
	);
}

/** Register enter_plan_mode and exit_plan_mode against the given controller. */
export function registerPlanModeTools(pi: ExtensionAPI, planMode: StepPlanModeController): void {
	pi.registerTool({
		name: "enter_plan_mode",
		label: "Enter plan mode",
		description:
			"Enter plan mode to explore the codebase and draft a proposal for approval. File-editing tools are limited to the announced session plan file; commands still use normal permissions.",
		promptSnippet: "Enter plan mode and draft a proposal for approval",
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
			"Exit plan mode once the session proposal is ready for review. The user chooses to execute it, stay in plan mode, or request refinements. Requires a readable, nonempty regular plan file.",
		promptSnippet: "Exit plan mode after writing the plan file",
		parameters: Type.Object({}),
		execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
			if (!planMode.isPlanModeActive()) return controlResult("Not in plan mode.");
			const planFilePath = planMode.resolvePlanFilePath(ctx);
			if (!existsSync(planFilePath)) {
				return controlResult(
					`No plan file at ${planFilePath}. Check the path and permissions, then write it with write_file and call exit_plan_mode again.`,
				);
			}
			let planPreview: string;
			try {
				planPreview = readPlanPreview(planFilePath);
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
					`Cannot gate approval in rpc child context. Plan file at ${planFilePath}; caller should approve externally. Plan mode exited and file mutations are re-enabled.\n\nPlan contents:\n${planPreview}`,
				);
			}
			if (!ctx.hasUI) {
				planMode.exitPlanMode("auto_headless", ctx);
				return controlResult(
					`Plan mode exited. Plan file kept at ${planFilePath} for reference.\n\nPlan contents:\n${planPreview}\n\nCannot show interactive prompt; caller must gate approval externally.`,
				);
			}
			const choice = await ctx.ui.select(`Plan ready for review (${planFilePath}):\n\n${planPreview}`, [
				"Execute the plan",
				"Stay in plan mode",
				"Refine the plan",
			]);
			if (choice === "Execute the plan") {
				planMode.exitPlanMode("approved", ctx);
				return controlResult(
					`The user approved the plan. Plan mode exited and file mutations are re-enabled. Execute the plan now, using ${planFilePath} as the reference; do not silently diverge from it.`,
				);
			}
			if (choice === "Refine the plan") {
				return await requestPlanRefinement(pi, ctx, planFilePath);
			}
			// "Stay in plan mode" also covers a dismissed dialog.
			return controlResult(
				"Staying in plan mode. Continue planning and call exit_plan_mode again when the plan is ready.",
			);
		},
	});
}
