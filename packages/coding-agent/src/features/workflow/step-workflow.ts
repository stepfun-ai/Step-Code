import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionFactory,
	InlineExtension,
} from "../../core/extensions/types.ts";
import { resolveStepStorageRoot } from "../../step/storage-root.ts";
import type { StepTelemetryReporter } from "../../step/telemetry.ts";
import { createDefaultWorkflowAgentRunner } from "./agent-runner.ts";
import { createWorkflowRunPaths, newWorkflowRunId, resolveWorkflowRoot, WorkflowJournal } from "./journal.ts";
import { formatWorkflowStatus, listSavedWorkflows, listWorkflowRuns } from "./progress.ts";
import { resolveWorkflowRegistration, WORKFLOW_VM_UNAVAILABLE_WARNING } from "./registration-gate.ts";
import {
	renderWorkflowCall,
	renderWorkflowResult,
	type WorkflowRenderState,
	workflowProgressResult,
} from "./rendering.ts";
import { WorkflowRuntime, workflowToolResult } from "./runtime.ts";
import { isWorkflowPathInside } from "./tool-profile.ts";
import type { WorkflowAgentRunner, WorkflowProgress, WorkflowRunResult } from "./types.ts";
import type { UltraloopTurnState } from "./ultraloop-opt-in.ts";
import { type runInIsolatedVm, WORKFLOW_MAX_SCRIPT_BYTES } from "./vm.ts";

export const WorkflowParams = Type.Object({
	script: Type.Optional(Type.String({ description: "Inline JavaScript workflow script" })),
	scriptPath: Type.Optional(Type.String({ description: "Path to a JavaScript workflow script" })),
	name: Type.Optional(Type.String({ description: "Saved workflow name" })),
	args: Type.Optional(Type.Unknown({ description: "JSON arguments exposed as the script's args value" })),
	resumeFromRunId: Type.Optional(Type.String({ description: "Resume the matching cached journal prefix" })),
	budget: Type.Optional(Type.Integer({ minimum: 0, description: "Optional input+output token budget" })),
	maxConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
	agentTimeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 3_600_000 })),
});

export type WorkflowRequest = {
	script?: string;
	scriptPath?: string;
	name?: string;
	args?: unknown;
	resumeFromRunId?: string;
	budget?: number;
	maxConcurrency?: number;
	agentTimeoutMs?: number;
};

export interface StepWorkflowExtensionOptions {
	telemetry?: StepTelemetryReporter;
	enabled?: boolean;
	runner?: WorkflowAgentRunner;
	vmExecutor?: typeof runInIsolatedVm;
	maxConcurrency?: number;
	maxAgents?: number;
	agentTimeoutMs?: number;
	budgetTotal?: number | null;
	homeRoot?: string;
	/** Read at execute time for the "+500k" turn directive; written by the ultraloop opt-in extension. */
	turnState?: UltraloopTurnState;
}

interface ResolvedScript {
	name: string;
	script: string;
	sourcePath?: string;
}

/** Resolve one inline, path, or saved workflow source. */
export async function resolveWorkflowScript(
	cwd: string,
	request: WorkflowRequest,
	homeRoot = resolveStepStorageRoot(),
): Promise<ResolvedScript> {
	const selected =
		Number(Boolean(request.script?.trim())) +
		Number(Boolean(request.scriptPath?.trim())) +
		Number(Boolean(request.name?.trim()));
	if (selected !== 1) throw new Error("workflow requires exactly one of script, scriptPath, or name");
	let sourcePath: string | undefined;
	let script: string;
	let name: string;
	if (request.script?.trim()) {
		script = request.script;
		name = "inline";
	} else if (request.scriptPath?.trim()) {
		sourcePath = path.resolve(cwd, request.scriptPath);
		if (!isWorkflowPathInside(cwd, sourcePath)) {
			throw new Error("workflow scriptPath must stay inside the working directory");
		}
		script = await readFile(sourcePath, "utf8");
		name = path.basename(sourcePath, path.extname(sourcePath));
	} else {
		name = normalizeSavedName(request.name ?? "");
		const projectRoot = path.join(path.resolve(cwd), ".stepcode", "workflows", "saved");
		const globalRoot = path.join(path.resolve(homeRoot), "workflows", "saved");
		const projectPath = path.join(projectRoot, `${name}.js`);
		const globalPath = path.join(globalRoot, `${name}.js`);
		sourcePath =
			isWorkflowPathInside(cwd, projectRoot) &&
			(await exists(projectPath)) &&
			isWorkflowPathInside(projectRoot, projectPath)
				? projectPath
				: (await exists(globalPath)) && isWorkflowPathInside(globalRoot, globalPath)
					? globalPath
					: undefined;
		if (!sourcePath) throw new Error(`Saved workflow "${name}" was not found`);
		script = await readFile(sourcePath, "utf8");
	}
	if (Buffer.byteLength(script, "utf8") > WORKFLOW_MAX_SCRIPT_BYTES)
		throw new Error(`Workflow script exceeds ${WORKFLOW_MAX_SCRIPT_BYTES} bytes`);
	return { name: name.slice(0, 200), script, ...(sourcePath ? { sourcePath } : {}) };
}

function normalizeSavedName(name: string): string {
	const normalized = name.trim().replace(/\.js$/iu, "");
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(normalized)) throw new Error("Invalid saved workflow name");
	return normalized;
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

/** Register the feature-gated Workflow tool and /workflows status command. */
export function createStepWorkflowExtension(options: StepWorkflowExtensionOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		const registration = resolveWorkflowRegistration(options);
		if (!registration.enabled) {
			if (registration.reason === "vm-unavailable") {
				let warned = false;
				pi.on("session_start", (_event, ctx) => {
					if (warned) return;
					warned = true;
					ctx.ui.notify(WORKFLOW_VM_UNAVAILABLE_WARNING, "warning");
				});
			}
			return;
		}
		const activeRuns = new Set<AbortController>();
		const runner = options.runner ?? createDefaultWorkflowAgentRunner();
		const homeRoot = options.homeRoot ?? resolveStepStorageRoot();

		pi.registerTool<typeof WorkflowParams, WorkflowProgress | WorkflowRunResult, WorkflowRenderState>({
			name: "workflow",
			label: "Workflow",
			renderShell: "self",
			renderCall: renderWorkflowCall,
			renderResult: renderWorkflowResult,
			description: `Run an isolated JavaScript workflow that coordinates many agents through phase(), parallel(), pipeline(), agent(), and the HoH iterate() loop. Scripts run in a sandboxed VM (no process, require, network, wall clock, or randomness); every agent call is journaled under .stepcode/workflows/runs so runs can resume. Provide exactly one of script (inline), scriptPath, or name (saved workflow); /workflows lists saved workflows and recent runs.

OPT-IN REQUIRED. Use this tool only when the user has opted in via one of: the keyword "ultraloop" (or Claude Code's spelling "ultracode") in the current message; an explicit request such as "use a workflow", "run a workflow", "fan out agents", or "orchestrate this with subagents"; ultraloop turned on for the session (a system-reminder confirms it — see the Ultraloop section below); a saved workflow invoked by name; or a skill that instructs it. The harness attaches a customType:"ultraloop-opt-in" system-reminder to the opting turn — per-turn signals produce a "the user included ..." reminder, session-standing mode produces an "Ultraloop is on for the session ..." reminder that repeats every turn until /ultraloop off. Saved-workflow or skill invocations are valid opt-in even without a reminder. Never infer opt-in from task shape — a large or parallel-looking task is not consent, per-turn opt-in from an earlier turn does not carry forward, and this tool being registered (STEP_ENABLE_WORKFLOW) is an environment capability, not consent. Without any signal, prefer targeted tools: a single subagent (Agent tool), search_files, or read_file; for calendar-based deferral prefer cron_create; for a multi-turn objective prefer create_goal.

Ultraloop session-standing mode. When a system-reminder confirms ultraloop is on for the session, the opt-in is standing until /ultraloop off: author and run a workflow for every substantive task by default, the goal is the most exhaustive, correct answer you can produce, and token cost is not a constraint. For multi-phase work (understand → design → implement → review), that often means several workflows in sequence — one per phase — so you stay in the loop between them. Lean toward orchestrating with workflows and adversarially verifying findings unless the work is already verified. Solo only on conversational turns or trivial mechanical edits. When session mode is off, revert to the per-turn opt-in rule above.

When NOT to use: single-file edits, one-shot lookups, targeted exploration answerable in about 3 queries, or any task whose current message carries no opt-in signal.

Single-phase patterns:
- Understand: parallel readers over subsystems → one structured map.
- Design: N approaches from different angles → judge panel scores → synthesized proposal.
- Review: split into dimensions → finders per dimension → adversarial verification of each finding.
- Research: multi-modal sweep → deep-read the survivors → synthesize.
- Migrate: discover call sites → transform each → verify each.

Quality patterns — spend agents on verification, not only generation:
- Adversarial verify: N skeptics per finding, each a distinct lens; majority refutation kills it.
- Judge panel: several attempts from different angles, judged and synthesized.
- Loop-until-dry: keep spawning finders until K consecutive rounds return nothing new.
- Multi-modal sweep: parallel agents each searching a different way (naming, structure, history, docs).
- Completeness critic: one final agent asks "what is missing?".
No silent caps: log() whatever you drop — top-N truncations, skipped retries, sampling.

Sizing: default medium; keep a run under ~15 agents unless the user asks for scale.

Mechanics:
- parallel(tasks) IS a barrier: it awaits every task before returning, and a task that throws resolves to null in the result array — the call never rejects, so .filter(Boolean) before using the results. pipeline(items, ...stages) runs each item's stage chain concurrently with NO barrier between stages: item A can be in stage 3 while item B is still in stage 1, and a stage sees only its own item, never sibling items' earlier-stage output. Stage callbacks receive (prevResult, originalItem, index); a stage that throws drops that item to null and skips its remaining stages. Both accept at most 4096 entries. Prefer pipeline(); insert a parallel() barrier between stages only when stage N truly needs every stage N-1 result (dedup, early exit, cross-referencing).
- agent(prompt, {schema}) forces structured JSON output and retries schema mismatches up to 3 attempts, feeding validation errors back; failed attempts still consume budget.
- Give agent() a short descriptive label; the live tool row shows running/queued counts, assigned tasks, phases, and terminal states while the workflow executes.
- Budgets fail closed once spend crosses the limit; budget.total is null when unlimited, so guard adaptive waves with budget.total && budget.remaining() > estimate. A "+500k"-style token target in the user's current message becomes the run's default budget; an explicit budget parameter overrides it.
- Resume: resumeFromRunId with the same script and args is a 100% cache hit on the unchanged prefix; after the first callHash mismatch, everything after it re-runs live. The tool result includes runId and the persisted scriptPath (.stepcode/workflows/runs/<runId>/script.js) — edit that file and re-invoke with scriptPath to iterate without resending the source.
- Determinism: Date, new Date(), and Math.random() throw inside the VM. Pass timestamps via args; vary prompts by index, not randomness.
- iterate({spec, ...}) runs a read-only Planner → single-writer Developer → independent read-only QA loop with schema-guarded evidence and stops on coverage target, stagnation, max iterations, empty objective, or budget. Use it for spec-driven build loops; hand-roll agent() with readOnly/writable mounts when roles or stop conditions differ.
- args takes real JSON values, not JSON-encoded strings, and is exposed as the script's args global.
- Compose with other primitives: cron_create can inject a prompt on schedule that opts into workflow ("run the security-audit workflow tonight"); create_goal can carry a multi-turn objective whose continuation prompts can, in turn, opt into workflow; agent() calls inside a workflow use the same subagent runner the Agent tool would.`,
			promptSnippet: "Run a structured multi-agent workflow",
			promptGuidelines: [
				'Use workflow only when the user has opted in: the keyword "ultraloop" (or Claude Code\'s spelling "ultracode") or an explicit request in the current message (use a workflow / run a workflow / fan out agents / orchestrate this with subagents), ultraloop turned on for the session (a system-reminder confirms it), invoking a saved workflow by name, or a skill that instructs it. Otherwise prefer targeted tools by name: a single subagent (Agent tool), search_files, or read_file. For calendar-based deferral prefer cron_create; for a multi-turn objective prefer create_goal; workflow only when both fan-out and structure are needed.',
				"Never infer workflow opt-in from task shape or size, and never carry a per-turn opt-in forward from an earlier turn; a harness system-reminder confirms keyword, phrase, and session-standing opt-ins (saved-workflow and skill invocations are valid without one), and the tool being registered (STEP_ENABLE_WORKFLOW) is an environment capability, not consent.",
				"When ultraloop is on for the session, the opt-in is standing: author and run a workflow for every substantive task by default, treat token cost as unconstrained, and aim for the most exhaustive correct answer. For multi-phase work, run several workflows in sequence — one per phase — so you stay in the loop between them. Lean toward adversarially verifying findings unless the work is already verified. Solo only on conversational turns or trivial mechanical edits.",
				"Use a short inline script for experiments and a saved script or scriptPath for repeatable work; /workflows lists saved workflows and recent runs, and /ultraloop toggles session-standing mode.",
				"Default to a medium run under ~15 agents unless the user asks for scale or ultraloop is on for the session, and log() anything dropped silently: top-N truncations, skipped retries, sampling.",
				"Spend agents on verification: adversarial verify with perspective-diverse skeptics (majority-refute kills a finding), judge panels over single attempts, multi-modal sweeps, loop-until-dry stopping after K empty rounds, and a final completeness critic.",
				"Prefer pipeline() for per-item flows; it runs each item's stage chain concurrently with no barrier between stages, so a stage never sees sibling items' earlier-stage output. Stage callbacks receive (prevResult, originalItem, index), and a throwing stage drops that item to null and skips its remaining stages. Use a parallel() wave between stages only when a stage needs every previous-stage result (dedup, early exit, cross-referencing).",
				"parallel(tasks) is a barrier: it awaits every task function before returning; a task that throws resolves to null in the result array, so .filter(Boolean) the results.",
				"Pass schema to agent() whenever a later stage consumes the result; mismatches are retried up to 3 attempts with validation errors appended, then the call fails.",
				"Budgets fail closed; budget.total is null when unlimited, so guard adaptive extra waves with budget.total && budget.remaining() > estimate. A \"+500k\"-style token target in the user's message sets the run's default budget; an explicit budget parameter overrides it.",
				"Resume with resumeFromRunId plus the identical script and args to replay the cached journal prefix; the first changed call and everything after it re-run live. The tool result's scriptPath points at the persisted script copy — edit it and re-invoke with scriptPath to iterate.",
				"The VM throws on Date, new Date(), and Math.random() and exposes no process, require, or network; pass timestamps through args and vary prompts by index.",
				"Use iterate({spec, ...}) for the Planner → single-writer Developer → independent QA loop with built-in coverage, stagnation, max-iteration, empty-objective, and budget stops; hand-roll agent() with readOnly/writable mounts when roles or stop conditions differ.",
			],
			parameters: WorkflowParams,
			execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
				const controller = new AbortController();
				const abort = (): void => controller.abort();
				if (signal?.aborted) abort();
				else signal?.addEventListener("abort", abort, { once: true });
				activeRuns.add(controller);
				try {
					const request = params as WorkflowRequest;
					const source = await resolveWorkflowScript(ctx.cwd, request, homeRoot);
					const workflowRoot = resolveWorkflowRoot(ctx.cwd);
					if (!isWorkflowPathInside(ctx.cwd, workflowRoot)) {
						throw new Error("Workflow run root must stay inside the working directory");
					}
					const runId = newWorkflowRunId();
					const paths = createWorkflowRunPaths(ctx.cwd, runId);
					const resumeFrom = await resolveResumePaths(ctx.cwd, request.resumeFromRunId);
					const journal = new WorkflowJournal(paths, resumeFrom);
					const runtime = new WorkflowRuntime({
						cwd: ctx.cwd,
						runId,
						name: source.name,
						journal,
						onProgress: onUpdate
							? (progress) => {
									// Ignore late child cleanup after this tool execution has settled.
									if (activeRuns.has(controller)) onUpdate(workflowProgressResult(progress));
								}
							: undefined,
						runner,
						telemetry: options.telemetry,
						budgetTotal: request.budget ?? options.turnState?.budgetTotal ?? options.budgetTotal,
						maxConcurrency: request.maxConcurrency ?? options.maxConcurrency,
						maxAgents: options.maxAgents,
						agentTimeoutMs: request.agentTimeoutMs ?? options.agentTimeoutMs,
						context: { ...ctx, signal: controller.signal },
						signal: controller.signal,
						vmExecutor: options.vmExecutor,
						nestedWorkflow: async (name, nestedArgs, parent, depth) => {
							const nested = await resolveWorkflowScript(ctx.cwd, { name }, homeRoot);
							return parent.runNestedScript(nested.script, nestedArgs, depth + 1, {
								filename: nested.sourcePath ?? `${nested.name}.js`,
								replay: Boolean(request.resumeFromRunId),
							});
						},
					});
					const result = await runtime.runScript(source.script, request.args ?? null, {
						filename: source.sourcePath ?? `${source.name}.js`,
						replay: Boolean(request.resumeFromRunId),
					});
					return workflowToolResult(result);
				} finally {
					activeRuns.delete(controller);
					if (signal) signal.removeEventListener("abort", abort);
				}
			},
		});

		pi.registerCommand("workflows", {
			description: "List saved workflows and recent workflow runs",
			handler: async (_args: string, ctx: ExtensionCommandContext) => {
				const [saved, runs] = await Promise.all([listSavedWorkflows(ctx.cwd, homeRoot), listWorkflowRuns(ctx.cwd)]);
				ctx.ui.notify(formatWorkflowStatus(runs, saved), "info");
			},
		});

		pi.on("session_shutdown", () => {
			for (const controller of activeRuns) controller.abort();
			activeRuns.clear();
		});
	};
}

async function resolveResumePaths(
	cwd: string,
	runId: string | undefined,
): Promise<ReturnType<typeof createWorkflowRunPaths> | undefined> {
	if (!runId?.trim()) return undefined;
	const paths = createWorkflowRunPaths(cwd, runId.trim());
	const runsRoot = path.join(resolveWorkflowRoot(cwd), "runs");
	if (
		!isWorkflowPathInside(cwd, runsRoot) ||
		!isWorkflowPathInside(runsRoot, paths.runDir) ||
		!isWorkflowPathInside(cwd, paths.journalPath) ||
		!(await exists(paths.runDir)) ||
		!(await exists(paths.journalPath))
	) {
		throw new Error(`Workflow resume run "${runId.trim()}" was not found`);
	}
	return paths;
}

export const stepWorkflowExtensionInline: InlineExtension = {
	name: "Step workflow",
	factory: createStepWorkflowExtension(),
	hidden: true,
};
