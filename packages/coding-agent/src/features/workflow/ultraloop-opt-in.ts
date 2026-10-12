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
 *      attached when the mode differs from the last state in the active
 *      context. Unchanged turns reuse it; turning off revokes standing consent.
 *
 * Soft gate only — off-consent workflow calls are journaled via appendEntry,
 * never blocked (no silent behavior; saved-workflow by name and skill-driven
 * calls are legitimate opt-ins per the static guidance and will show up as
 * benign off-consent telemetry entries, cross-referenceable by toolCallId).
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionFactory } from "../../core/extensions/types.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import { isWorkflowRegistrationEnabled } from "./registration-gate.ts";

const ULTRALOOP_SESSION_MODE_ENTRY = "ultraloop-session-mode";

interface UltraloopSessionModeData {
	enabled: boolean;
}

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

export function buildUltraloopReminder(token: string, workflowAvailable = true): string {
	const lower = token.toLowerCase();
	const signal = lower === "ultraloop" || lower === "ultracode" ? `the keyword "${lower}"` : `the phrase "${token}"`;
	if (!workflowAvailable) {
		return `<system-reminder>The user included ${signal}, requesting multi-agent orchestration for this turn. The workflow tool is not active in the current tool profile. Explain this limitation instead of attempting to call it; the session switch and find_tools do not expand tool access.</system-reminder>`;
	}
	return `<system-reminder>The user included ${signal}, opting this turn into multi-agent orchestration — use the workflow tool to fulfill the request.</system-reminder>`;
}

export function buildUltraloopSessionReminder(): string {
	return "<system-reminder>Ultraloop is on for the session — the user has authorized multi-agent orchestration until they turn it off with /ultraloop off. Author and run a workflow for every substantive task by default; the goal is the most exhaustive, correct answer you can produce, and token cost is not a constraint. For multi-phase work (understand → design → implement → review), run several workflows in sequence — one per phase — so you stay in the loop between them. Lean toward orchestrating with workflows and adversarially verifying findings unless the work is already verified. Solo only on conversational turns or trivial mechanical edits.</system-reminder>";
}

function buildUltraloopSessionOffReminder(): string {
	return "<system-reminder>Ultracode session mode is off. Previous session-wide workflow authorization no longer applies. Use workflow only for a new explicit per-turn request, a saved workflow invoked by name, or a skill instruction. Do not carry earlier per-turn authorization forward.</system-reminder>";
}

interface ReminderRecord {
	customType: string;
	content: unknown;
	details?: unknown;
}

/** Inspect only runtime-authored entries in the selected context, not user text. */
function lastSessionMode(records: readonly ReminderRecord[]): boolean | undefined {
	for (let index = records.length - 1; index >= 0; index--) {
		const record = records[index]!;
		if (record.customType !== "ultraloop-opt-in" && record.customType !== "ultraloop-discovery") continue;
		const details = record.details;
		if (!details || typeof details !== "object") continue;
		if ("sessionMode" in details && typeof details.sessionMode === "boolean") return details.sessionMode;
		// Read reminders from sessions written before transition-based notices.
		if ("source" in details && details.source === "session") return true;
		if (record.customType === "ultraloop-discovery" && typeof record.content === "string") {
			if (record.content.includes("Current session mode: off.")) return false;
			if (record.content.includes("Current session mode: on.")) return true;
		}
	}
	return undefined;
}

function persistedSessionMode(entries: readonly SessionEntry[]): boolean | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type !== "custom" || entry.customType !== ULTRALOOP_SESSION_MODE_ENTRY) continue;
		const data = entry.data;
		if (typeof data === "object" && data !== null && "enabled" in data && typeof data.enabled === "boolean") {
			return data.enabled;
		}
	}
	return undefined;
}

function sessionModeReminder(sessionMode: boolean, previous: boolean | undefined) {
	if (sessionMode ? previous === true : previous !== true) return undefined;
	const content = sessionMode ? buildUltraloopSessionReminder() : buildUltraloopSessionOffReminder();
	return {
		customType: "ultraloop-opt-in",
		// Standing consent can outlive a tool-profile change. State the constraint
		// conditionally rather than persisting a snapshot of tool availability.
		content: `${content}\nIf the workflow tool is not active in the current tool profile, explain the limitation instead of attempting to call it. Consult the current active tools; session mode does not expand tool access.`,
		display: false,
		details: { source: "session", sessionMode },
	};
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

		// Session boundaries restore only the latest mode entry from this session;
		// sessions without a saved mode start opted-out.
		pi.on("session_start", (_event, ctx) => {
			sessionMode = persistedSessionMode(ctx.sessionManager.getEntries()) ?? false;
			optedInThisTurn = false;
			setTurnBudget(undefined);
			ctx.ui.setStatus("ultracode", sessionMode ? "Ultracode on" : undefined);
		});

		// BeforeAgentStartEventResult.message is appended after the real user input
		// and retained in session history. Read the selected branch before deciding
		// whether it needs a new state announcement; do not cache an emitted flag.
		pi.on("before_agent_start", (event, ctx) => {
			const token = detectUltraloopOptIn(event.prompt);
			optedInThisTurn = token !== undefined;
			setTurnBudget(detectUltraloopBudget(event.prompt));
			const previous = lastSessionMode(
				ctx.sessionManager.buildContextEntries().filter((entry) => entry.type === "custom_message"),
			);
			const modeReminder = sessionModeReminder(sessionMode, previous);

			// Session-standing wins when both signals fire: the LLM already knows
			// workflow is authorized for the whole session; a per-turn reminder
			// on top is redundant noise.
			if (sessionMode || token === undefined) return modeReminder ? { message: modeReminder } : undefined;
			return {
				message: {
					customType: "ultraloop-opt-in",
					content: [modeReminder?.content, buildUltraloopReminder(token, pi.getActiveTools().includes("workflow"))]
						.filter(Boolean)
						.join("\n\n"),
					display: false,
					details: { source: "turn", token, ...(modeReminder ? { sessionMode: false } : {}) },
				},
			};
		});

		// Compaction/live-context edits can remove an earlier announcement, and
		// commands can toggle the mode during streaming without before_agent_start.
		// Reconcile against the actual provider context in those cases. This fallback
		// is request-local: it does not append duplicate entries to session history.
		pi.on("context", (event) => {
			const previous = lastSessionMode(event.messages.filter((message) => message.role === "custom"));
			const message = sessionModeReminder(sessionMode, previous);
			if (!message) return;
			return { messages: [...event.messages, { role: "custom" as const, ...message, timestamp: Date.now() }] };
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

		const command = {
			description:
				"Ultracode multi-agent workflows. Use /ultracode on, off, status, or help; /ultraloop is an alias.",
			getArgumentCompletions: (prefix: string) =>
				[
					{ value: "on", label: "on", description: "Enable workflows for this session" },
					{ value: "off", label: "off", description: "Return to one-turn opt-in" },
					{ value: "status", label: "status", description: "Show the current session mode" },
					{ value: "help", label: "help", description: "Show session and one-turn usage" },
				].filter((item) => item.value.startsWith(prefix.trim().toLowerCase())),
			handler: async (args: string, ctx: ExtensionCommandContext) => {
				const token = args.trim().toLowerCase();
				if (token === "on") {
					sessionMode = true;
					pi.appendEntry(ULTRALOOP_SESSION_MODE_ENTRY, {
						enabled: true,
					} satisfies UltraloopSessionModeData);
					ctx.ui.setStatus("ultracode", "Ultracode on");
					ctx.ui.notify(
						"Ultracode is on for the session. Multi-agent workflows are authorized until /ultracode off or the session ends.",
						"info",
					);
					return;
				}
				if (token === "off") {
					sessionMode = false;
					pi.appendEntry(ULTRALOOP_SESSION_MODE_ENTRY, {
						enabled: false,
					} satisfies UltraloopSessionModeData);
					ctx.ui.setStatus("ultracode", undefined);
					ctx.ui.notify("Ultracode session mode is off. Use ultracode: <task> for one-turn opt-in.", "info");
					return;
				}
				if (token === "status") {
					ctx.ui.notify(`Ultracode session mode: ${sessionMode ? "on" : "off"}.`, "info");
					return;
				}
				if (token === "" || token === "help") {
					ctx.ui.notify(
						[
							`Ultracode session mode: ${sessionMode ? "on" : "off"}.`,
							"Ultracode (Ultraloop) coordinates parallel agents through workflows.",
							"/ultracode on      Enable for this session (can use more tokens)",
							"/ultracode off     Return to one-turn opt-in",
							"/ultracode status  Show the current mode",
							"/ultracode help    Show this help",
							"One turn: ultracode: <task> (or ultraloop: <task>)",
							"/ultraloop is an alias with the same controls and state.",
						].join("\n"),
						"info",
					);
					return;
				}
				ctx.ui.notify("Usage: /ultracode [on|off|status|help] (/ultraloop is an alias).", "warning");
			},
		};
		pi.registerCommand("ultracode", command);
		pi.registerCommand("ultraloop", {
			...command,
			description: "Alias for /ultracode: multi-agent workflows with the same on/off/status/help controls.",
		});
	};
}
