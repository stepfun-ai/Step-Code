/**
 * Model-facing plan-mode tool: exit_plan_mode.
 *
 * There is deliberately no entry tool: only the user enters plan mode, through
 * /plan or --plan, both owned by the step-plan extension.
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
export type StepPlanExitOutcome = "approved" | "toggled_off" | "auto_headless" | "auto_rpc";

/** State transitions the plan-mode tools drive on the step-plan extension. */
export interface StepPlanModeController {
	isPlanModeActive(): boolean;
	/** Leave plan mode: restore any tools plan mode added, persist state, record telemetry. */
	exitPlanMode(outcome: StepPlanExitOutcome, extensionContext: ExtensionContext): void;
	/** Plan file path for this session (persisted or derived from the session id). */
	resolvePlanFilePath(extensionContext: ExtensionContext): string;
	/**
	 * A proposal is waiting for this user's answer.
	 *
	 * This is a session fact, not a projection: the handoff records the reviewed
	 * snapshot here, and every decision clears it. Hosts and the automatic-turn
	 * guard read it instead of inferring "still waiting" from the transcript, so
	 * a question typed past the proposal cannot look like an answer and an
	 * answered proposal cannot look pending.
	 */
	recordPendingProposal(planHash: string): void;
	/** The hash of the proposal waiting for an answer, or undefined. */
	pendingProposalHash(): string | undefined;
	/** The proposal was answered (approved, revised, or left); nothing waits now. */
	clearPendingProposal(): void;
}

/**
 * Identity of a proposal's exact text.
 *
 * Shared by the review that shows it and the approval that must match it: two
 * spellings of "the same plan" would let a click approve text the user did not
 * read.
 */
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
	return {
		content: [{ type: "text", text }],
		details: undefined,
		terminate,
		...(terminate ? { stopTurn: true } : {}),
	};
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
	return { content: [{ type: "text", text }], details, terminate, ...(terminate ? { stopTurn: true } : {}) };
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
 * Run the interactive review in the TUI.
 *
 * The dialog offers approval and a line of feedback, nothing else. It has no
 * deadline: the user decides when to answer, and the run's signal closes the
 * dialog if the turn is cancelled. A plan review is a human decision, not a
 * request with a transport budget.
 */
async function reviewPlanInteractively(
	extensionContext: ExtensionContext,
	planFilePath: string,
	planContents: string,
	signal: AbortSignal | undefined,
): Promise<PlanReviewResult> {
	return extensionContext.ui.custom<PlanReviewResult>(
		(tui, theme, _keybindings, done) =>
			new PlanReviewComponent({
				planFilePath,
				planContents,
				signal,
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

/** Register exit_plan_mode against the given controller. */
export function registerPlanModeTools(pi: ExtensionAPI, planMode: StepPlanModeController): void {
	pi.registerTool({
		name: "exit_plan_mode",
		label: "Exit plan mode",
		// The plan body owns its own framing: the Step shell's default body pass
		// strips blank rows and clips to a five-line budget behind ctrl+o.
		renderShell: "self",
		renderResult: renderPlanReviewResult,
		description:
			"Submit the written proposal for review. Requires a readable, nonempty regular plan file. The user decides; you do not. In a host that can show the proposal and collect a decision — the terminal dialog is one — the proposal is shown and this turn ends, and plan mode stays until they answer: approval leaves planning and starts the work, a request for changes arrives as a new user message, and leaving keeps the mode off. A host without that surface hands the proposal to its caller, which must obtain approval before execution. If no proposal was written, answer read-only questions directly and keep plan mode active until the user turns it off.",
		promptSnippet: "Submit the written proposal for review",
		parameters: Type.Object({}),
		// A decision barrier: later calls in this batch must not run behind it.
		executionMode: "sequential",
		execute: async (_toolCallId, _params, signal, _onUpdate, ctx) => {
			if (!planMode.isPlanModeActive()) {
				return controlResult(
					"Not in plan mode. Only the user starts plan mode, with /plan or --plan; continue the task in the current mode.",
				);
			}
			const planFilePath = planMode.resolvePlanFilePath(ctx);
			if (!existsSync(planFilePath)) {
				// A request that needs no proposal may be answered directly, but a
				// missing file is not permission to leave: only the user turns the
				// mode off, otherwise every later edit would be unguarded.
				return controlResult(
					`No plan file at ${planFilePath}. Plan mode stays active. If this request needs no proposal, answer directly without changing files; only the user can turn plan mode off with /plan. Otherwise write the proposal with write_file, then call exit_plan_mode again.`,
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
			const reviewed = (outcome: PlanReviewOutcome, feedback?: string): PlanReviewDetails => ({
				planFilePath,
				planContents,
				planHash,
				planModeExited: !planMode.isPlanModeActive(),
				// Who owns the decision, not what carries it. A host that draws the
				// proposal has a person answering, whatever transport it uses; without
				// that surface the caller owns approval.
				approvalSource: ctx.planReviewSurface || (ctx.mode !== "rpc" && ctx.hasUI) ? "user" : "external",
				outcome,
				...(feedback === undefined ? {} : { feedback }),
			});
			// Every handoff leaves a proposal awaiting approval, so no automatic
			// starter continues past it. A host that can ask the user keeps the fact
			// until an explicit decision; one that cannot clears it on the caller's
			// next message, which is the only channel it has. The terminal dialog
			// answers in-process, so it never records one.
			if (ctx.planReviewSurface) {
				planMode.recordPendingProposal(planHash);
				// The host draws the proposal and can collect an answer, which is what
				// the terminal dialog does. Plan mode stays on until the user decides:
				// leaving on submission would let any later message — a question as
				// easily as an approval — authorize the work. The turn ends so the host
				// can ask.
				return reviewedResult(
					`The proposal was submitted for review and this turn ends now. Do not call exit_plan_mode again in this turn; the user answers through the host, and a request for changes comes back as a new user message. Plan mode stays on, so file mutations stay limited to ${planFilePath}. Do not execute until the user approves.\n\nPlan file: ${planFilePath}\n\nPlan contents:\n${planContents}`,
					reviewed("external_approval_required"),
					true,
				);
			}
			// An RPC child has a dialog bridge (hasUI is true) but no real user
			// behind it, so its dialog can be auto-cancelled. Exit plan mode, but end
			// this turn: the caller still owns approval before execution. A proposal
			// answered by nobody still has to hold automatic starters back, so the
			// handoff records it here too.
			if (ctx.mode === "rpc") {
				planMode.recordPendingProposal(planHash);
				planMode.exitPlanMode("auto_rpc", ctx);
				ctx.ui.notify(
					"RPC host has no plan-review bridge; caller approval is required before execution.",
					"warning",
				);
				return reviewedResult(
					`Cannot gate approval in this RPC host. Plan file at ${planFilePath}; caller should approve externally. This turn ends now; do not execute until the caller approves.\n\nPlan contents:\n${planContents}`,
					reviewed("external_approval_required"),
					true,
				);
			}
			if (!ctx.hasUI) {
				planMode.recordPendingProposal(planHash);
				planMode.exitPlanMode("auto_headless", ctx);
				return reviewedResult(
					`Plan mode exited. Plan file kept at ${planFilePath} for reference.\n\nPlan contents:\n${planContents}\n\nCannot show interactive prompt; caller must gate approval externally. This turn ends now.`,
					reviewed("external_approval_required"),
					true,
				);
			}
			const review = await reviewPlanInteractively(ctx, planFilePath, planContents, signal);
			if (signal?.aborted) {
				return controlResult("The plan review was aborted. Planning remains active.", true);
			}
			if (review?.action === "execute") {
				// The approval belongs to the exact snapshot the user read. Reread the
				// file: a plan edited while the dialog was open cannot be approved by
				// the click that approved the old text.
				let unchanged = false;
				try {
					unchanged = hashPlanContents(readPlanContents(planFilePath)) === planHash;
				} catch {
					// A deleted or unreadable file cannot be the approved snapshot.
				}
				if (!unchanged) {
					ctx.ui.notify(
						"The plan changed during review. Submit the current proposal for a new review.",
						"warning",
					);
					return controlResult(
						"The plan changed or is no longer readable. Plan mode stays active; the earlier approval cannot authorize a different proposal. Wait for the user to request a new review.",
						true,
					);
				}
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
