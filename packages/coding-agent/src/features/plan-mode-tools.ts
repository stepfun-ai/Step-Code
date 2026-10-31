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
import type { ExtensionAPI, ExtensionContext, PlanReviewResult } from "../core/extensions/types.ts";
import {
	PLAN_REVIEW_PROMPT,
	PlanReviewComponent,
	type PlanReviewDetails,
	type PlanReviewOutcome,
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

const UNANSWERED_REVIEW_RESULT =
	"The plan review was not answered: the review bridge was cancelled, timed out, or failed. " +
	"Staying in plan mode. Stop here and wait for the user; do not call exit_plan_mode again until they ask for another review.";

/**
 * How long a bridged review may block before it counts as "no decision".
 *
 * A reviewer reads the whole proposal before approving it, so this sits far above
 * the 60s dialog default. The tool passes the budget explicitly; a host only
 * backstops it.
 */
const PLAN_REVIEW_TIMEOUT_MS = 600_000;

/**
 * Run the interactive review.
 *
 * The dialog offers approval and a line of feedback, nothing else: a third
 * "keep going, no comment" choice told the model nothing that dismissing the
 * dialog does not already say, so Escape covers it.
 *
 * A host whose UI bridge reaches a real user answers through `ui.reviewPlan`,
 * which carries the plan snapshot over the wire; every other host renders the
 * component in process. The in-process component always answers with a decision,
 * while a bridged host resolves `undefined` when no decision was reached — a
 * cancelled, timed-out, or failing bridge must never read as approval.
 */
async function reviewPlanInteractively(
	extensionContext: ExtensionContext,
	planFilePath: string,
	planContents: string,
	planHash: string,
	signal: AbortSignal | undefined,
): Promise<PlanReviewResult | undefined> {
	if (extensionContext.ui.reviewPlan) {
		return await extensionContext.ui.reviewPlan(
			{ planFilePath, planContents, planHash, title: PLAN_REVIEW_PROMPT },
			{ timeout: PLAN_REVIEW_TIMEOUT_MS, signal },
		);
	}
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
			"Submit the written proposal for review. Requires a readable, nonempty regular plan file. In the TUI and in RPC hosts that bridge a review dialog (sdk-stdio), the user approves execution, requests refinements, or dismisses; approval exits planning, while refining or dismissing keeps it active. In headless runs and RPC hosts without a review bridge, it exits without interactive approval; the caller must gate approval externally before execution.",
		promptSnippet: "Submit the written proposal for review",
		parameters: Type.Object({}),
		execute: async (_toolCallId, _params, signal, _onUpdate, ctx) => {
			if (!planMode.isPlanModeActive()) {
				return controlResult(
					"Not in plan mode. Only the user starts plan mode, with /plan or --plan; continue the task in the current mode.",
				);
			}
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
			const planHash = createHash("sha256").update(planContents, "utf8").digest("hex");
			const reviewed = (
				outcome: PlanReviewOutcome,
				approvalSource: "user" | "external",
				feedback?: string,
				bridgeFailed?: boolean,
			): PlanReviewDetails => ({
				planFilePath,
				planContents,
				planHash,
				planModeExited: !planMode.isPlanModeActive(),
				approvalSource,
				outcome,
				...(feedback === undefined ? {} : { feedback }),
				...(bridgeFailed ? { bridgeFailed: true } : {}),
			});
			// An rpc host without a bridged review (subagent lanes, whose dialogs the
			// parent auto-cancels) has nobody to decide, so exit plan mode and hand
			// approval to the caller. Checked before hasUI: an rpc host may also bind
			// no UI at all, and that keeps today's rpc handoff rather than the
			// headless one.
			if (ctx.mode === "rpc" && !ctx.ui.reviewPlan) {
				planMode.exitPlanMode("auto_rpc", ctx);
				ctx.ui.notify("rpc child auto-approved plan mode exit — user oversight was not gated", "warning");
				return reviewedResult(
					`Cannot gate approval in rpc child context. Plan file at ${planFilePath}; caller should approve externally. Plan mode exited and file mutations are re-enabled.\n\nPlan contents:\n${planContents}`,
					reviewed("external_approval_required", "external"),
				);
			}
			if (!ctx.hasUI) {
				planMode.exitPlanMode("auto_headless", ctx);
				return reviewedResult(
					`Plan mode exited. Plan file kept at ${planFilePath} for reference.\n\nPlan contents:\n${planContents}\n\nCannot show interactive prompt; caller must gate approval externally.`,
					reviewed("external_approval_required", "external"),
				);
			}
			// A real user decides: the TUI renders the dialog in process, and an rpc
			// host with a review bridge (sdk-stdio) waits for the desktop's answer. A
			// bridge that times out, aborts, errors, or answers unparseably resolves
			// undefined, and a host implementation that throws is caught here and
			// counts the same way. Either way the batch ends without exiting plan
			// mode, so a failed review can never hand the model an approval it never
			// received. Note the batch boundary: terminate stops the loop after this
			// tool batch, which does not constrain tools the model batched with it.
			const bridged = ctx.ui.reviewPlan !== undefined;
			let review: PlanReviewResult | undefined;
			// `ui.reviewPlan` is a public extension API, so a third-party host can
			// answer it without the in-repo bridge's strict parsing. Reading the note
			// inside the try, behind a type guard, keeps a malformed answer in the
			// "no decision" bucket instead of throwing past the terminate below.
			let refinement = "";
			try {
				review = await reviewPlanInteractively(ctx, planFilePath, planContents, planHash, signal);
				refinement = review?.action === "feedback" && typeof review.text === "string" ? review.text.trim() : "";
			} catch {
				review = undefined;
			}
			if (review?.action === "execute") {
				planMode.exitPlanMode("approved", ctx);
				return reviewedResult(
					`The user approved the plan. Plan mode exited and file mutations are re-enabled. Execute the plan now, using ${planFilePath} as the reference; do not silently diverge from it.`,
					reviewed("approved", "user"),
				);
			}
			// An empty note decided nothing: the component refuses to submit one, and
			// a bridge that sends one is answering with a non-answer.
			if (refinement.length > 0) {
				// Steer, don't follow up. This tool returns a result, so the agent keeps
				// running; the follow-up queue is only drained once it would stop on its
				// own. The model, told notes were coming but not seeing any, stopped by
				// asking clarify_user what to change — which never ends the run, so the
				// note stayed queued. Steering lands it before the very next response.
				pi.sendUserMessage(`Plan refinement requested. Update ${planFilePath} based on:\n\n${refinement}`, {
					deliverAs: "steer",
				});
				return reviewedResult(
					"The user requested refinements. Their notes follow immediately as the next user message; do not ask what to change. Staying in plan mode: apply the notes to the plan file and call exit_plan_mode again.",
					reviewed("feedback", "user", refinement),
				);
			}
			// Dismissed, or a bridge that never reached a decision (timeout, abort,
			// host error, unparseable or empty answer). Terminate the batch: the old
			// result told the model to "call exit_plan_mode again when the plan is
			// ready", and since nothing about the plan had changed it re-submitted at
			// once, re-opening the dialog on every Escape. `bridgeFailed` records the
			// cases where nobody decided at all, as opposed to a user who declined.
			const noDecision =
				bridged && (review === undefined || (review.action === "feedback" && refinement.length === 0));
			// A bridge that never reached a decision is not a user who declined: the
			// model is told the review went unanswered, and the details name the
			// external owner instead of recording a user decision that never happened.
			if (noDecision) {
				return reviewedResult(UNANSWERED_REVIEW_RESULT, reviewed("dismissed", "external", undefined, true), true);
			}
			return reviewedResult(STAY_IN_PLAN_MODE_RESULT, reviewed("dismissed", "user"), true);
		},
	});
}
