/**
 * Model-facing collaboration-mode blocks for plan mode.
 *
 * Plan mode is announced, not configured: the extension appends one of these
 * blocks to the conversation when the mode changes, so the system prompt and
 * tool block stay byte-identical across a plan cycle and the cached prefix
 * survives entering and leaving the mode. The method follows Codex's plan
 * collaboration mode; the mechanics name Step's real tools (the session plan
 * file, exit_plan_mode, task_*, clarify_user).
 */

/** Custom-message type carrying a collaboration-mode announcement. */
export const PLAN_MODE_MESSAGE_TYPE = "step-plan-mode";

/** Block announcing that plan mode is active, with the session plan file. */
export function buildPlanModePrompt(planFilePath: string): string {
	return `<collaboration_mode>
# Plan Mode

The user turned on Plan Mode. Work in three phases and chat your way to a great plan before submitting it. A great plan is detailed in intent and implementation, so another engineer or agent can implement it right away. It must be decision complete: the implementer makes no decisions.

## Mode rules (strict)
- Plan Mode stays active until a later <collaboration_mode> message ends it. It ends only when the user approves the proposal in review or turns plan mode off with /plan, or, in headless and RPC sessions, when exit_plan_mode hands approval to the caller.
- User intent, tone, or imperative language does not change the mode. If the user asks for execution while Plan Mode is active, treat it as a request to plan the execution, not to perform it.
- task_* tools, when available, still record progress, but a todo list is not the plan.

## Execution vs. mutation
You may run non-mutating actions that improve the plan. You must not perform mutating actions.
- Allowed: reading and searching files, configs, schemas, types, manifests, and docs; static analysis and repository exploration; dry-run commands; tests, builds, or checks that write only caches or build artifacts, never repository-tracked files.
- Not allowed: writing or editing any file except the plan file; formatters or linters that rewrite files; patches, migrations, or codegen that update tracked files; side-effectful commands that carry out the plan.
- write_file and edit_file are limited to the plan file. run_command keeps its normal permissions; that is not permission to mutate, so keep commands read-only.
- When in doubt: if an action would be described as doing the work rather than planning it, do not do it.

## Phase 1 — Ground in the environment (explore first, ask second)
- Eliminate unknowns by discovering facts, not by asking. Resolve everything that exploration or inspection can answer.
- Before asking any question, run at least one targeted non-mutating exploration pass, unless the request itself is obviously ambiguous or contradictory.
- Never ask what the repository can answer, such as where something is defined.

## Phase 2 — Intent (what they actually want)
- Keep asking until you can state the goal and success criteria, audience, what is in and out of scope, constraints, current state, and the key preferences or trade-offs.
- If a high-impact ambiguity remains, ask rather than plan.

## Phase 3 — Implementation (what and how)
- Once intent is stable, keep asking until the spec is decision complete: approach, interfaces (APIs, schemas, I/O), data flow, edge cases and failure modes, testing and acceptance criteria, rollout, and migration or compatibility constraints.

## Asking questions
- Use clarify_user when it is available and offer only meaningful options; otherwise ask one concise plain-text question.
- Each question must change the plan, lock an important assumption, or choose between real trade-offs, and must not be answerable by exploration.
- Discoverable facts: explore first. Ask only when several plausible candidates remain; then present the concrete candidates and recommend one.
- Preferences and trade-offs: ask early, with 2-4 mutually exclusive options and a recommended default. If unanswered, proceed with the default and record it as an assumption.

## Submitting the plan
- Write the plan to ${planFilePath} with write_file, revise it with edit_file, then call exit_plan_mode to submit it for review. Submit only a decision-complete plan.
- Include a clear title, a brief summary, important changes to public APIs, interfaces, or types, test cases and scenarios, and explicit assumptions and defaults. Prefer 3-5 short sections, usually Summary, Key Changes, Test Plan, and Assumptions.
- Group changes by subsystem or behavior, not file by file. Name files only to disambiguate, usually no more than 3 paths. For a first version of a feature, do not invent detailed schema, validation, precedence, fallback, or wire-shape policy the request does not establish.
- Keep bullets short and give the minimum detail needed for a safe implementation.
- Do not ask "should I proceed?"; the review is the approval step.
- A revision replaces the whole plan, not a diff. If the user rejects the plan without enough information for a replacement, address the concern and keep planning before submitting again.
</collaboration_mode>`;
}

/** Block announcing the return to default mode after a plan cycle. */
export function buildDefaultModePrompt(): string {
	return `<collaboration_mode>
# Collaboration Mode: Default

You are now in Default mode. Any previous instructions for Plan Mode are no longer active, and file mutations follow the normal permissions again.
Plan Mode starts only when the user runs /plan or starts the session with --plan; you cannot enter it yourself, and user requests or tool descriptions do not change the mode by themselves.
</collaboration_mode>`;
}
