/**
 * Ultraloop opt-in for the workflow tool, mirroring Claude Code's opt-in surface.
 * Tool REGISTRATION is on by default (STEP_DISABLE_WORKFLOW turns it off); this
 * extension gates USAGE via two independent signals — either grants consent:
 *
 *   1) per-turn signal: the keyword "ultraloop" (or Claude Code's spelling
 *      "ultracode") or an explicit trigger phrase in the current message.
 *      Attaches a customType:"ultraloop-opt-in" system-reminder to exactly
 *      that turn; the flag resets on agent_settled after retries and compaction.
 *      A "+500k"-style token target in the same message becomes the turn's
 *      default workflow budget.
 *
 *   2) session-standing mode: the user turns on ultraloop for the whole
 *      session via /ultraloop on. A session-scoped system-reminder is
 *      attached to every subsequent turn until /ultraloop off, or the
 *      session ends. Mirrors Claude Code's "Ultracode is on for the session"
 *      opt-in.
 *
 * Soft gate only — off-consent workflow calls are journaled via appendEntry,
 * never blocked (no silent behavior; saved-workflow by name and skill-driven
 * calls are legitimate opt-ins per the static guidance and will show up as
 * benign off-consent telemetry entries, cross-referenceable by toolCallId).
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionFactory } from "../../core/extensions/types.ts";
import { isWorkflowRegistrationEnabled } from "./registration-gate.ts";

// "ultracode" is Claude Code's name for the same opt-in; users switching
// between the two products type it interchangeably, so both spellings grant
// the per-turn signal.
const KEYWORD = /\bultra(?:loop|code)\b/iu;
// Keep in sync with the opt-in phrase list in the workflow tool description,
// its promptGuidelines, and the "# Workflow orchestration" system-prompt bullet:
// "use a workflow", "run a workflow", "fan out agents", "orchestrate this with subagents".
const TRIGGER_PHRASES: readonly RegExp[] = [
	/\buse (?:a|the) workflow\b/iu,
	/\brun (?:a|the) (?:[\w-]+ )?workflow\b/iu,
	/\bfan out agents\b/iu,
	/\borchestrate (?:this|it) with sub-?agents\b/iu,
];
const OPT_IN_PATTERNS: readonly RegExp[] = [KEYWORD, ...TRIGGER_PHRASES];

/**
 * Claude Code-style per-turn token target: "+500k" or "+1.5m" anywhere in the
 * message. The suffix is required so pasted diffs ("+5 lines") never match.
 */
const BUDGET_DIRECTIVE = /(?:^|[\s(（])\+(\d+(?:\.\d+)?)\s*([km])\b/iu;

/** Returns the matched opt-in token, or undefined when this turn carries no signal. */
export function detectUltraloopOptIn(prompt: string): string | undefined {
	for (const re of OPT_IN_PATTERNS) {
		const match = prompt.match(re)?.[0];
		if (match !== undefined) return match;
	}
	return undefined;
}

/** Returns the "+500k"-style token target for this turn, or undefined. */
export function detectUltraloopBudget(prompt: string): number | undefined {
	const match = prompt.match(BUDGET_DIRECTIVE);
	if (!match?.[1] || !match[2]) return undefined;
	const scale = match[2].toLowerCase() === "m" ? 1_000_000 : 1_000;
	const value = Math.floor(Number(match[1]) * scale);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function buildUltraloopReminder(token: string): string {
	const lower = token.toLowerCase();
	const signal = lower === "ultraloop" || lower === "ultracode" ? `the keyword "${lower}"` : `the phrase "${token}"`;
	return `<system-reminder>The user included ${signal}, opting this turn into multi-agent orchestration — use the workflow tool to fulfill the request.</system-reminder>`;
}

export function buildUltraloopSessionReminder(): string {
	return "<system-reminder>Ultraloop is on for the session — the user has authorized multi-agent orchestration until they turn it off with /ultraloop off. Author and run a workflow for every substantive task by default; the goal is the most exhaustive, correct answer you can produce, and token cost is not a constraint. For multi-phase work (understand → design → implement → review), run several workflows in sequence — one per phase — so you stay in the loop between them. Lean toward orchestrating with workflows and adversarially verifying findings unless the work is already verified. Solo only on conversational turns or trivial mechanical edits.</system-reminder>";
}

/**
 * Per-turn state shared between the opt-in extension (writer) and the
 * workflow tool (reader). Both are constructed by step-capabilities with the
 * same object; the indirection exists because extensions cannot see each
 * other's closures.
 */
export interface UltraloopTurnState {
	/** Token target parsed from a "+500k"-style directive in the current turn. */
	budgetTotal?: number;
}

export interface UltraloopOptInExtensionOptions {
	enabled?: boolean;
	/** Presence-checked to mirror the workflow tool's vmExecutor escape; passed through to isWorkflowRegistrationEnabled. */
	vmExecutor?: unknown;
	/** Written each turn with the parsed "+500k" target (or undefined). */
	turnState?: UltraloopTurnState;
}

/**
 * Registration gate is delegated to isWorkflowRegistrationEnabled so this
 * extension can never subscribe when the workflow tool itself did not
 * register.
 */
export function createUltraloopOptInExtension(options: UltraloopOptInExtensionOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		if (!isWorkflowRegistrationEnabled(options)) return;

		let optedInThisTurn = false;
		let sessionMode = false;
		const setTurnBudget = (value: number | undefined): void => {
			if (options.turnState) options.turnState.budgetTotal = value;
		};

		// Session boundary resets standing mode; each new session starts opted-out.
		pi.on("session_start", () => {
			sessionMode = false;
			optedInThisTurn = false;
			setTurnBudget(undefined);
		});

		// Fires after the user submits a prompt, before the agent loop; the returned
		// message lands in exactly this turn's context (BeforeAgentStartEventResult.message).
		pi.on("before_agent_start", (event) => {
			const token = detectUltraloopOptIn(event.prompt);
			optedInThisTurn = token !== undefined;
			setTurnBudget(detectUltraloopBudget(event.prompt));

			// Session-standing wins when both signals fire: the LLM already knows
			// workflow is authorized for the whole session; a per-turn reminder
			// on top is redundant noise.
			if (sessionMode) {
				return {
					message: {
						customType: "ultraloop-opt-in",
						content: buildUltraloopSessionReminder(),
						display: false,
						details: { source: "session" },
					},
				};
			}

			if (token === undefined) return;
			return {
				message: {
					customType: "ultraloop-opt-in",
					content: buildUltraloopReminder(token),
					display: false,
					details: { source: "turn", token },
				},
			};
		});

		// Soft-gate telemetry: journal off-consent workflow calls; never block.
		// Either signal counts as consent — saved-workflow by name and skill-driven
		// calls without a detectable token remain valid per the static guidance.
		pi.on("tool_call", (event) => {
			if (event.toolName !== "workflow") return;
			if (optedInThisTurn || sessionMode) return;
			pi.appendEntry("ultraloop-opt-in", { offConsentCall: true, toolCallId: event.toolCallId });
		});

		// Internal agent_end events also fire before retries and compaction recovery.
		// Clear only when the product run settles; the next prompt also replaces this state.
		pi.on("agent_settled", () => {
			optedInThisTurn = false;
			setTurnBudget(undefined);
		});

		pi.registerCommand("ultraloop", {
			description:
				'Enable multi-agent workflow orchestration. Usage: /ultraloop [on|off|status] for session-standing mode; prefix a message with "ultraloop:" for one-turn opt-in.',
			handler: async (args: string, ctx: ExtensionCommandContext) => {
				const token = args.trim().toLowerCase();
				if (token === "on") {
					sessionMode = true;
					ctx.ui.notify(
						"Ultraloop is on for the session. The workflow tool is authorized until you run /ultraloop off.",
						"info",
					);
					return;
				}
				if (token === "off") {
					sessionMode = false;
					ctx.ui.notify("Ultraloop session mode is off. Workflow now requires a per-turn opt-in signal.", "info");
					return;
				}
				if (token === "" || token === "status") {
					ctx.ui.notify(`Ultraloop session mode: ${sessionMode ? "on" : "off"}.`, "info");
					return;
				}
				ctx.ui.notify("Usage: /ultraloop [on|off|status]", "warning");
			},
		});
	};
}
