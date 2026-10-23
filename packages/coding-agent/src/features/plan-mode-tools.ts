/**
 * Model-facing plan-mode tools: enter_plan_mode and exit_plan_mode.
 *
 * The tools own only the interaction surface (guards, review dialog, result
 * texts). Plan-mode state lives in the step-plan extension and is driven
 * through {@link StepPlanModeController}, so the tools stay stateless.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { AgentToolResult } from "@step-harness/agent-core";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import {
	PlanReviewComponent,
	type PlanReviewDetails,
	type PlanReviewOutcome,
	type PlanReviewResult,
	renderPlanReviewResult,
} from "../render/plan-review.ts";
import { resolvePath } from "../utils/paths.ts";

/** Exit outcome dimension for plan_mode_exited telemetry. */
export type StepPlanExitOutcome =
	| "approved"
	| "toggled_off"
	/** Left planning without writing anything: nothing to review, nothing approved. */
	| "no_proposal"
	| "auto_headless"
	| "auto_rpc";

/** State transitions the plan-mode tools drive on the step-plan extension. */
export interface StepPlanModeController {
	isPlanModeActive(): boolean;
	/** Plan mode is on because the user asked for it (`/plan`, `--plan`), not through enter_plan_mode. */
	enteredByUser(): boolean;
	/**
	 * Agent-initiated entry (the enter_plan_mode tool); user entry is the
	 * /plan toggle owned by the extension. Returns the session plan file path.
	 */
	enterPlanMode(extensionContext: ExtensionContext): string;
	/**
	 * Leave plan mode: restore any tools plan mode added, persist state, record telemetry.
	 * `submittedPlanHash` records a proposal handed to an external reviewer.
	 */
	exitPlanMode(outcome: StepPlanExitOutcome, extensionContext: ExtensionContext, submittedPlanHash?: string): void;
	/** Plan file path for this session (persisted or derived from the session id). */
	resolvePlanFilePath(extensionContext: ExtensionContext): string;
	/** The proposal with this hash was already handed to an external reviewer. */
	wasSubmitted(planHash: string): boolean;
	/**
	 * The plan file still holds exactly what it held when this round entered plan
	 * mode, so the round produced no proposal. A file left over from an earlier
	 * round is not an answer to the current request, even when this process has
	 * no record of it being submitted.
	 */
	unchangedSinceEnter(planHash: string): boolean;
}

/** Identity of a proposal's exact text, as reported in review details. */
export function hashPlanContents(planContents: string): string {
	return createHash("sha256").update(planContents, "utf8").digest("hex");
}

/** Select a new per-session plan path; the extension retains saved paths on restore. */
export function getPlanFilePath(sessionId: string, projectCwd?: string): string {
	const cwd = projectCwd ?? process.cwd();
	const planDir = process.env.STEP_CODING_AGENT_PLAN_DIR?.trim();
	return path.join(
		planDir ? resolvePath(planDir, cwd) : path.join(cwd, ".stepcode", "plans"),
		`session-${sessionId}.md`,
	);
}

/**
 * `terminate` asks the agent loop to stop after this tool batch instead of
 * streaming another response, handing the turn back to the user.
 */
function controlResult(text: string, terminate = false): AgentToolResult<PlanReviewDetails | undefined> {
	return { content: [{ type: "text", text }], details: undefined, terminate };
}

/**
 * A review or external-approval handoff, carrying the plan for the transcript.
 *
 * The dialog is torn down as soon as it closes, taking the plan it drew with
 * it; renderPlanReviewResult puts it back on the tool row.
 */
function reviewedResult(
	text: string,
	details: PlanReviewDetails,
	terminate = false,
): AgentToolResult<PlanReviewDetails | undefined> {
	return { content: [{ type: "text", text }], details, terminate };
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
	"The user dismissed the review without approving the plan or leaving notes. Staying in plan mode. " +
	"Stop here and wait for the user; do not call exit_plan_mode again until they ask for another review.";

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
				// Not an error and not uncertain state: a model that probes here has to
				// learn that the mode is on and that probing is never needed.
				const origin = planMode.enteredByUser()
					? "the host turned it on for the user's /plan request"
					: "it was turned on earlier";
				return controlResult(
					`Plan mode is already on (${origin}); this call changed nothing and was not needed. Do not call enter_plan_mode again. Write your proposal to ${planMode.resolvePlanFilePath(ctx)} using write_file or edit_file, then call exit_plan_mode once when it is ready.`,
				);
			}
			const planFilePath = planMode.enterPlanMode(ctx);
			return controlResult(
				`Plan mode is now on. Explore the repository, then write your proposal to ${planFilePath} using write_file. Call exit_plan_mode once when it is ready for review.`,
			);
		},
	});
	pi.registerTool({
		name: "exit_plan_mode",
		label: "Exit plan mode",
		// The plan body owns its own framing: the Step shell's default body pass
		// strips blank rows and clips to a five-line budget behind ctrl+o.
		renderShell: "self",
		renderResult: renderPlanReviewResult,
		description:
			"Submit the written proposal for review; call it once. Requires a readable, nonempty regular plan file. In interactive mode, user approval exits planning; staying, refining, or cancelling keeps it active. In headless and RPC modes, exits without interactive approval; the caller must gate approval externally before execution. There, calling it without a new proposal only leaves plan mode, for a request that needs no plan.",
		promptSnippet: "Submit the written proposal for review",
		parameters: Type.Object({}),
		execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
			if (!planMode.isPlanModeActive()) {
				return controlResult(
					"Plan mode is already off, so there is nothing to submit or leave. Do not call exit_plan_mode again; to submit a revised proposal later, call enter_plan_mode first.",
				);
			}
			const planFilePath = planMode.resolvePlanFilePath(ctx);
			// No review dialog can be shown: approval belongs to the caller (rpc) or
			// nobody is there to ask (headless).
			const external = ctx.mode === "rpc" || !ctx.hasUI;
			// Said in the persisted result so a later turn, which no longer sees the
			// request-local reminder, still knows the mode was the user's.
			const offText = planMode.enteredByUser()
				? "Plan mode, which the host turned on for the user's /plan request, is now off"
				: "Plan mode is now off";
			const leaveWithoutProposal = (reason: string): AgentToolResult<PlanReviewDetails | undefined> => {
				// Nothing new was written, so there is nothing to review and no decision
				// for the user: the model decided this request needs no plan. Requiring
				// a file here trapped the session in plan mode — the model answered
				// directly, nothing ever submitted, and every later file edit stayed
				// blocked. Resubmitting an untouched earlier proposal would post a
				// second review card for a plan the user already has.
				planMode.exitPlanMode("no_proposal", ctx);
				return controlResult(
					`${offText}. ${reason}, so there is nothing to review and the user is not being asked to approve anything. Answer the request directly. Do not call exit_plan_mode or enter_plan_mode again for this request.`,
				);
			};
			if (!existsSync(planFilePath)) {
				if (external) return leaveWithoutProposal(`No proposal was written at ${planFilePath}`);
				// The terminal can always review, and its user leaves with /plan: a
				// missing file is a proposal not yet written, not a decision to leave.
				return controlResult(
					`No proposal at ${planFilePath}, so there is nothing to review yet and plan mode stays on. Write the plan there with write_file, then call exit_plan_mode once. If this request needs no plan, answer directly and tell the user they can turn plan mode off with /plan; do not call exit_plan_mode for that.`,
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
			const planHash = hashPlanContents(planContents);
			if (external && planMode.unchangedSinceEnter(planHash)) {
				return leaveWithoutProposal(
					`${planFilePath} still holds the content it had before this request and nothing new was written`,
				);
			}
			if (external && planMode.wasSubmitted(planHash)) {
				return leaveWithoutProposal(
					`${planFilePath} still holds the proposal already submitted earlier and nothing new was written`,
				);
			}
			const reviewed = (outcome: PlanReviewOutcome, feedback?: string): PlanReviewDetails => ({
				planFilePath,
				planContents,
				planHash,
				planModeExited: !planMode.isPlanModeActive(),
				approvalSource: ctx.mode === "rpc" || !ctx.hasUI ? "external" : "user",
				outcome,
				...(feedback === undefined ? {} : { feedback }),
			});
			if (ctx.mode === "rpc") {
				// An rpc child has a dialog bridge (hasUI is true) but no real user
				// behind it, so its extension_ui_request select can be auto-cancelled
				// to "Stay", leaving the child idle in plan mode forever. Exit plan mode
				// and hand approval to the caller. Interactive hosts that drive the
				// session over rpc (StepCode Web/Desktop) land here too: they show the
				// proposal in their own UI, so the result must neither claim the user
				// approved nor imply the work may start.
				planMode.exitPlanMode("auto_rpc", ctx, planHash);
				// No notice: leaving plan mode is state the host already draws (the strip
				// closes, the review card appears). An announcement would be a row nobody
				// typed, and the tool result already tells the model what happened.
				return reviewedResult(
					`${offText} and the proposal was submitted for review. Exiting reports that the investigation is finished; it does not authorize implementation. Do not call exit_plan_mode again; wait for the user's decision before changing files.\n\nPlan file: ${planFilePath}\n\nPlan contents:\n${planContents}`,
					reviewed("external_approval_required"),
				);
			}
			if (!ctx.hasUI) {
				planMode.exitPlanMode("auto_headless", ctx, planHash);
				return reviewedResult(
					`Plan mode exited. Plan file kept at ${planFilePath} for reference.\n\nPlan contents:\n${planContents}\n\nCannot show interactive prompt; caller must gate approval externally. Do not call exit_plan_mode again.`,
					reviewed("external_approval_required"),
				);
			}
			const review = await reviewPlanInteractively(ctx, planFilePath, planContents);
			if (review?.action === "execute") {
				planMode.exitPlanMode("approved", ctx);
				return reviewedResult(
					`The user approved the plan. Plan mode exited and file mutations are re-enabled. Execute the plan now, using ${planFilePath} as the reference; do not silently diverge from it.`,
					reviewed("approved"),
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
				return reviewedResult(
					"The user requested refinements. Their notes follow immediately as the next user message; do not ask what to change. Staying in plan mode: apply the notes to the plan file and call exit_plan_mode again.",
					reviewed("feedback", review.text),
				);
			}
			// Dismissed, or a host that cannot show the dialog at all. Terminate the
			// batch: the old result told the model to "call exit_plan_mode again when
			// the plan is ready", and since nothing about the plan had changed it
			// re-submitted at once, re-opening the dialog on every Escape.
			return reviewedResult(STAY_IN_PLAN_MODE_RESULT, reviewed("dismissed"), true);
		},
	});
}
