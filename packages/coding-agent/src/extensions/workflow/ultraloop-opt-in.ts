/**
 * Ultraloop opt-in for the workflow tool, mirroring Claude Code's opt-in surface.
 * STEP_ENABLE_WORKFLOW gates tool REGISTRATION at process start; this extension
 * gates USAGE via two independent signals — either grants consent:
 *
 *   1) per-turn signal: the keyword "ultraloop" or an explicit trigger phrase
 *      in the current message. Attaches a customType:"ultraloop-opt-in"
 *      system-reminder to exactly that turn; the flag resets on agent_end.
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

const KEYWORD = /\bultraloop\b/iu;
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

/** Returns the matched opt-in token, or undefined when this turn carries no signal. */
export function detectUltraloopOptIn(prompt: string): string | undefined {
	for (const re of OPT_IN_PATTERNS) {
		const match = prompt.match(re)?.[0];
		if (match !== undefined) return match;
	}
	return undefined;
}

export function buildUltraloopReminder(token: string): string {
	const signal = token.toLowerCase() === "ultraloop" ? 'the keyword "ultraloop"' : `the phrase "${token}"`;
	return `<system-reminder>The user included ${signal}, opting this turn into multi-agent orchestration — use the workflow tool to fulfill the request.</system-reminder>`;
}

export function buildUltraloopSessionReminder(): string {
	return "<system-reminder>Ultraloop is on for the session — the user has authorized multi-agent orchestration until they turn it off with /ultraloop off. Author and run a workflow for every substantive task by default; the goal is the most exhaustive, correct answer you can produce, and token cost is not a constraint. For multi-phase work (understand → design → implement → review), run several workflows in sequence — one per phase — so you stay in the loop between them. Lean toward orchestrating with workflows and adversarially verifying findings unless the work is already verified. Solo only on conversational turns or trivial mechanical edits.</system-reminder>";
}

export interface UltraloopOptInExtensionOptions {
	enabled?: boolean;
	/** Presence-checked to mirror the workflow tool's vmExecutor escape; passed through to isWorkflowRegistrationEnabled. */
	vmExecutor?: unknown;
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

		// Session boundary resets standing mode; each new session starts opted-out.
		pi.on("session_start", () => {
			sessionMode = false;
			optedInThisTurn = false;
		});

		// Fires after the user submits a prompt, before the agent loop; the returned
		// message lands in exactly this turn's context (BeforeAgentStartEventResult.message).
		pi.on("before_agent_start", (event) => {
			const token = detectUltraloopOptIn(event.prompt);
			optedInThisTurn = token !== undefined;

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

		// Per-turn opt-in never outlives its turn; session-standing mode persists.
		pi.on("agent_end", () => {
			optedInThisTurn = false;
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
