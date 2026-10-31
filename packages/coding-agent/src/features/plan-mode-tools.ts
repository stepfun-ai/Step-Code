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
import type { ClarificationResult } from "../core/extensions/clarification.ts";
import type { ExtensionAPI, ExtensionContext, PlanReviewResult } from "../core/extensions/types.ts";
import {
	PLAN_REVIEW_PROMPT,
	PlanReviewComponent,
	type PlanReviewDetails,
	type PlanReviewOutcome,
	renderPlanReviewResult,
} from "../render/plan-review.ts";
import { raceWithAbortSignal } from "../utils/abort.ts";
import { resolvePath } from "../utils/paths.ts";

/** Exit outcome dimension for plan_mode_exited telemetry. */
export type StepPlanExitOutcome = "approved" | "toggled_off" | "auto_headless" | "auto_rpc";

export interface StepPlanReviewState {
	id: string;
	planHash: string;
	outcome: PlanReviewOutcome | "pending" | "unanswered" | "superseded";
}

/** State transitions the plan-mode tools drive on the step-plan extension. */
export interface StepPlanModeController {
	isPlanModeActive(): boolean;
	/** Records submission without leaving plan mode; only one review may be pending. */
	beginReview(
		id: string,
		planHash: string,
	):
		| {
				signal: AbortSignal;
				settle(outcome: StepPlanReviewState["outcome"]): boolean;
		  }
		| undefined;
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

/** Normalize a host answer at the approval boundary; approval is never inferred. */
export function parsePlanReviewResult(value: unknown): PlanReviewResult | undefined {
	if (!value || typeof value !== "object" || !("action" in value)) return undefined;
	if (value.action === "execute" || value.action === "dismissed") return { action: value.action };
	if (value.action === "unavailable" && "reason" in value && value.reason === "proposal_too_large") {
		return { action: "unavailable", reason: "proposal_too_large" };
	}
	if (value.action === "feedback" && "text" in value && typeof value.text === "string" && value.text.trim()) {
		return { action: "feedback", text: value.text.trim() };
	}
	return undefined;
}

function clarificationPlanReview(result: ClarificationResult): PlanReviewResult | undefined {
	if (result.cancelled === true) return { action: "dismissed" };
	if (result.cancelled !== false || !Array.isArray(result.answers) || result.answers.length !== 1) return undefined;
	const answer = result.answers[0];
	if (!answer || answer.id !== "plan-review") return undefined;
	if (answer.skipped) return { action: "dismissed" };
	if (answer.wasCustom === true) return parsePlanReviewResult({ action: "feedback", text: answer.value });
	if (answer.wasCustom !== false) return undefined;
	return parsePlanReviewResult({ action: answer.value });
}

/** Use native plan review, a structured question host, or the in-process TUI. */
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
	if (extensionContext.ui.clarify) {
		const result = await extensionContext.ui.clarify(
			[
				{
					id: "plan-review",
					label: "Plan review",
					question: PLAN_REVIEW_PROMPT,
					// Generic question hosts can present the complete proposal without a new UI.
					reason: planContents,
					intent: { kind: "plan_review", planFilePath, planHash },
					options: [
						{ label: "Execute the plan", value: "execute" },
						{ label: "Keep planning", value: "dismissed" },
					],
					allowFreeform: true,
				},
			],
			signal,
		);
		return clarificationPlanReview(result);
	}
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

/** The tool enforces the deadline even if a host ignores its cancellation signal. */
async function reviewWithDeadline(
	ctx: ExtensionContext,
	planFilePath: string,
	planContents: string,
	planHash: string,
	runSignal: AbortSignal | undefined,
	reviewSignal: AbortSignal,
): Promise<PlanReviewResult | undefined> {
	const timeout = new AbortController();
	const signal = AbortSignal.any([timeout.signal, reviewSignal, ...(runSignal ? [runSignal] : [])]);
	const timer = setTimeout(() => timeout.abort(), PLAN_REVIEW_TIMEOUT_MS);
	try {
		if (signal.aborted) return undefined;
		return parsePlanReviewResult(
			await raceWithAbortSignal(reviewPlanInteractively(ctx, planFilePath, planContents, planHash, signal), signal),
		);
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
		// Tell the host to close abandoned work on errors as well as timeout/abort.
		timeout.abort();
	}
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
			"Submit the written proposal for review. Requires a readable, nonempty regular plan file. TUI hosts and hosts providing a reviewPlan or clarify UI capability wait for the user: approval exits planning, while feedback or dismissal keeps it active. Headless runs and RPC hosts without those capabilities hand approval to the caller and end this turn; the caller must approve before execution. If no proposal was written, answer read-only questions directly and keep plan mode active until the user turns it off.",
		promptSnippet: "Submit the written proposal for review",
		parameters: Type.Object({}),
		executionMode: "sequential",
		execute: async (toolCallId, _params, signal, _onUpdate, ctx) => {
			let submission: ReturnType<StepPlanModeController["beginReview"]>;
			try {
				if (!planMode.isPlanModeActive()) {
					return controlResult(
						"Not in plan mode. Only the user starts plan mode, with /plan or --plan; continue the task in the current mode.",
					);
				}
				const planFilePath = planMode.resolvePlanFilePath(ctx);
				if (!existsSync(planFilePath)) {
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
				submission = planMode.beginReview(toolCallId, planHash);
				if (!submission) return controlResult("A plan review is already pending. Wait for its result.", true);
				// Legacy external handoffs end this turn; the caller still owns approval.
				if (ctx.mode === "rpc" && !ctx.ui.reviewPlan && !ctx.ui.clarify) {
					submission.settle("external_approval_required");
					planMode.exitPlanMode("auto_rpc", ctx);
					ctx.ui.notify(
						"RPC host has no plan-review bridge; caller approval is required before execution.",
						"warning",
					);
					return reviewedResult(
						`Cannot gate approval in this RPC host. Plan file at ${planFilePath}; caller should approve externally. This turn ends now; do not execute until the caller approves.\n\nPlan contents:\n${planContents}`,
						reviewed("external_approval_required", "external"),
						true,
					);
				}
				if (!ctx.hasUI) {
					submission.settle("external_approval_required");
					planMode.exitPlanMode("auto_headless", ctx);
					return reviewedResult(
						`Plan mode exited. Plan file kept at ${planFilePath} for reference.\n\nPlan contents:\n${planContents}\n\nCannot show interactive prompt; caller must gate approval externally. This turn ends now.`,
						reviewed("external_approval_required", "external"),
						true,
					);
				}
				const bridged = Boolean(ctx.ui.reviewPlan || ctx.ui.clarify);
				const nativeSignal = AbortSignal.any([submission.signal, ...(signal ? [signal] : [])]);
				let review: PlanReviewResult | undefined;
				try {
					review = bridged
						? await reviewWithDeadline(ctx, planFilePath, planContents, planHash, signal, submission.signal)
						: parsePlanReviewResult(
								await raceWithAbortSignal(
									reviewPlanInteractively(ctx, planFilePath, planContents, planHash, nativeSignal),
									nativeSignal,
								),
							);
				} catch (error) {
					if (submission.signal.aborted)
						return controlResult(
							"Plan mode changed while the review was open. The old review cannot authorize this session.",
							true,
						);
					submission.settle("unanswered");
					if (signal?.aborted) return controlResult("The plan review was aborted. Planning remains active.", true);
					throw error;
				}
				if (submission.signal.aborted)
					return controlResult(
						"Plan mode changed while the review was open. The old review cannot authorize this session.",
						true,
					);
				if (signal?.aborted) review = undefined;
				const refinement = review?.action === "feedback" ? review.text : "";
				if (review?.action === "unavailable") {
					submission.settle("unanswered");
					return controlResult(
						"The proposal is too large for this host to display. Plan mode stays active. Shorten the plan, preserving its essential decisions, then submit it again for review.",
					);
				}
				if (review?.action === "execute") {
					let unchanged = false;
					try {
						unchanged =
							createHash("sha256").update(readPlanContents(planFilePath), "utf8").digest("hex") === planHash;
					} catch {
						// A deleted or unreadable file cannot be the approved snapshot.
					}
					if (!unchanged) {
						submission.settle("superseded");
						ctx.ui.notify(
							"The plan changed during review. Submit the current proposal for a new review.",
							"warning",
						);
						return controlResult(
							"The plan changed or is no longer readable. Plan mode stays active; the earlier approval cannot authorize a different proposal. Wait for the user to request a new review.",
							true,
						);
					}
					if (!submission.settle("approved")) return controlResult("This review is no longer current.", true);
					planMode.exitPlanMode("approved", ctx);
					return reviewedResult(
						`The user approved the plan. Plan mode exited and file mutations are re-enabled. Execute the plan now, using ${planFilePath} as the reference; do not silently diverge from it.`,
						reviewed("approved", "user"),
					);
				}
				// An empty note decided nothing: the component refuses to submit one, and
				// a bridge that sends one is answering with a non-answer.
				if (refinement.length > 0) {
					if (!submission.settle("feedback")) return controlResult("This review is no longer current.", true);
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
				const noDecision = bridged && review === undefined;
				if (!submission.settle(noDecision ? "unanswered" : "dismissed"))
					return controlResult("This review is no longer current.", true);
				if (noDecision) {
					ctx.ui.notify(
						"The plan review was not answered. Planning remains active; no execution was approved.",
						"warning",
					);
					return reviewedResult(
						UNANSWERED_REVIEW_RESULT,
						reviewed("dismissed", "external", undefined, true),
						true,
					);
				}
				return reviewedResult(STAY_IN_PLAN_MODE_RESULT, reviewed("dismissed", "user"), true);
			} catch (error) {
				try {
					submission?.settle("unanswered");
				} catch {
					// Preserve the original failure; a failed persist cannot remove the live restriction.
				}
				return {
					...controlResult(`Plan review failed: ${error instanceof Error ? error.message : String(error)}`, true),
					isError: true,
				};
			}
		},
	});
}
