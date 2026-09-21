/**
 * Blocking subagent orchestration: mode selection (single/parallel/chain),
 * task normalization, project-agent confirmation, per-task execution with
 * optional worktree isolation and telemetry, bounded-concurrency fan-out, and
 * result aggregation. Tool registration, rendering, and the child runner stay
 * in step-subagent.ts.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@step-harness/agent-core";
import type { Static } from "typebox";
import type { ExtensionContext } from "../../core/extensions/types.ts";
import { type StepTelemetryReporter, trackStepTelemetry } from "../../step/telemetry.ts";
import {
	cloneUsage,
	emptyUsage,
	finalOutput,
	isFailed,
	makeToolResult,
	resultText,
	type StepChainItem,
	type StepSubagentDetails,
	type StepSubagentExtensionOptions,
	type StepSubagentResultRecord,
	type StepSubagentRunner,
	type StepSubagentRunResult,
	type StepTaskItem,
	type StepWorktreeLease,
	type StepWorktreeManager,
	type SubagentParams,
	sanitizeLabel,
} from "../step-subagent.ts";
import {
	discoverStepAgents,
	formatStepAgentCatalog,
	resolveStepAgent,
	type StepAgentConfig,
	type StepAgentDiscoveryResult,
	type StepAgentScope,
} from "../step-subagent-agents.ts";
import { truncateText } from "./lane-events.ts";
import type { StepSubagentLaneRuntime } from "./lane-lifecycle.ts";

interface StepSubagentTaskInput {
	agent: string;
	task: string;
	cwd?: string;
	model?: string;
	contextMode?: "inherit" | "fresh";
	isolateWorkspace?: boolean;
	worktreeName?: string;
	retainWorktree?: boolean;
}

function statusForResult(result: StepSubagentRunResult): StepSubagentResultRecord["status"] {
	if (result.exitCode === -1) return "running";
	if (result.stopReason === "aborted") return "aborted";
	return isFailed(result) ? "failed" : "completed";
}

function resultRecord(
	agent: string,
	task: string,
	result: StepSubagentRunResult,
	extra: Partial<Pick<StepSubagentResultRecord, "agentSource" | "step" | "worktreePath" | "worktreeBranch">> = {},
): StepSubagentResultRecord {
	return {
		agent,
		agentSource: extra.agentSource ?? "unknown",
		task,
		status: statusForResult(result),
		...result,
		...extra,
		usage: cloneUsage(result.usage),
	};
}

function makeEmptyResult(agent: string, task: string): StepSubagentResultRecord {
	return {
		agent,
		agentSource: "unknown",
		task,
		status: "running",
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		startedAt: Date.now(),
		updatedAt: Date.now(),
	};
}

function resultDetailsText(details: StepSubagentDetails): string {
	return details.results
		.map((result) => {
			const worktree = result.worktreePath ? ` worktree=${result.worktreePath}` : "";
			return `${result.agent}: ${result.status}${worktree}`;
		})
		.join("; ");
}

function buildDetails(
	mode: StepSubagentDetails["mode"],
	discovery: StepAgentDiscoveryResult,
	scope: StepAgentScope,
	results: StepSubagentResultRecord[],
): StepSubagentDetails {
	return {
		mode,
		agentScope: scope,
		userAgentsDir: discovery.userAgentsDir,
		projectAgentsDir: discovery.projectAgentsDir,
		results,
	};
}

async function mapWithConcurrency<T, R>(
	items: readonly T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
		while (true) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await fn(items[index], index);
		}
	});
	await Promise.all(workers);
	return results;
}

function makeFailureResult(
	agent: string,
	task: string,
	message: string,
	source: StepAgentConfig["source"] | "unknown" = "unknown",
): StepSubagentResultRecord {
	return resultRecord(
		agent,
		task,
		{
			messages: [],
			stderr: message,
			exitCode: 1,
			usage: emptyUsage(),
			stopReason: "error",
			errorMessage: message,
		},
		{ agentSource: source },
	);
}

function taskLabel(task: StepSubagentTaskInput, index?: number): string {
	return sanitizeLabel(task.worktreeName ?? task.agent, index === undefined ? "agent" : `agent-${index + 1}`);
}

function taskFromParams(params: SubagentParams): StepSubagentTaskInput | undefined {
	const task = params.task?.trim();
	const agent = params.agent?.trim();
	if (!task || !agent) return undefined;
	return {
		agent,
		task,
		cwd: params.cwd,
		isolateWorkspace: params.isolateWorkspace,
		worktreeName: params.worktreeName,
		retainWorktree: params.retainWorktree,
	};
}

function normalizeTaskInput(task: Static<typeof StepTaskItem> | Static<typeof StepChainItem>): StepSubagentTaskInput {
	const runtimeTask = task as Static<typeof StepTaskItem> & {
		isolateWorkspace?: boolean;
		worktreeName?: string;
		retainWorktree?: boolean;
	};
	return {
		agent: task.agent,
		task: task.task,
		cwd: task.cwd,
		isolateWorkspace: runtimeTask.isolateWorkspace,
		worktreeName: runtimeTask.worktreeName,
		retainWorktree: runtimeTask.retainWorktree,
	};
}

async function confirmProjectAgents(
	ctx: ExtensionContext,
	params: SubagentParams,
	discovery: StepAgentDiscoveryResult,
	tasks: readonly StepSubagentTaskInput[],
): Promise<boolean> {
	if (params.confirmProjectAgents === false || !ctx.hasUI || ctx.isProjectTrusted()) return true;
	if (params.agentScope === "user") return true;
	const projectNames = [
		...new Set(
			tasks
				.map((task) => resolveStepAgent(discovery.agents, task.agent)?.name ?? task.agent)
				.filter((name) => discovery.agents.some((agent) => agent.name === name && agent.source === "project")),
		),
	];
	if (projectNames.length === 0) return true;
	return ctx.ui.confirm(
		"Run project-local agents?",
		`Agents: ${projectNames.join(", ")}\nSource: ${discovery.projectAgentsDir ?? "(unknown)"}\n\nProject definitions are repository-controlled. Continue only for a trusted repository.`,
	);
}

export async function executeSubagent(
	params: SubagentParams,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<StepSubagentDetails> | undefined,
	ctx: ExtensionContext,
	options: Required<
		Pick<
			StepSubagentExtensionOptions,
			"agentDir" | "configDirName" | "includeBuiltinAgents" | "maxParallelTasks" | "maxConcurrency"
		>
	> & {
		worktreeManager: StepWorktreeManager;
		runner: StepSubagentRunner;
		telemetry?: StepTelemetryReporter;
	},
	laneRuntime?: StepSubagentLaneRuntime,
): Promise<AgentToolResult<StepSubagentDetails>> {
	const scope = params.agentScope ?? "user";
	const discovery = await discoverStepAgents(ctx.cwd, {
		agentDir: options.agentDir,
		configDirName: options.configDirName,
		includeBuiltin: options.includeBuiltinAgents,
		scope,
	});
	const parallelInput = params.tasks;
	const chainInput = params.chain;
	// This mirrors Pi's example: an empty optional array does not select a mode.
	const hasParallelInput = (parallelInput?.length ?? 0) > 0;
	const hasChainInput = (chainInput?.length ?? 0) > 0;
	const single = !hasParallelInput && !hasChainInput ? taskFromParams(params) : undefined;
	const parallel = hasParallelInput ? parallelInput!.map(normalizeTaskInput) : undefined;
	const chain = hasChainInput ? chainInput!.map(normalizeTaskInput) : undefined;
	const modeCount = Number(Boolean(single)) + Number(hasParallelInput) + Number(hasChainInput);
	if (modeCount !== 1) {
		const details = buildDetails("single", discovery, scope, []);
		return makeToolResult(
			details,
			`Invalid parameters. Provide exactly one mode. Available agents: ${formatStepAgentCatalog(discovery.agents)}`,
		);
	}
	if (parallel && parallel.length > options.maxParallelTasks) {
		const details = buildDetails("parallel", discovery, scope, []);
		return makeToolResult(
			details,
			`Too many parallel tasks (${parallel.length}); maximum is ${options.maxParallelTasks}.`,
		);
	}
	const tasks = parallel ?? chain ?? [single!];
	const mode: StepSubagentDetails["mode"] = chain ? "chain" : parallel ? "parallel" : "single";
	if (!(await confirmProjectAgents(ctx, params, discovery, tasks))) {
		const details = buildDetails(mode, discovery, scope, []);
		return makeToolResult(details, "Canceled: project-local agents not approved.");
	}

	const records = tasks.map((task) => makeEmptyResult(task.agent, task.task));
	const execution = parallel ? "background" : "blocking";
	const createdAt = tasks.map(() => Date.now());
	const createdTasks = new Set<number>();
	const reportCreated = (agent: StepAgentConfig, index: number): void => {
		if (!options.telemetry) return;
		createdTasks.add(index);
		trackStepTelemetry(options.telemetry, "subagent_task_created", {
			execution,
			agent_type: agent.name,
			model_profile: agent.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "inherited"),
		});
		createdAt[index] = Date.now();
	};
	const reportFinished = (record: StepSubagentResultRecord, index: number): void => {
		if (!options.telemetry || !createdTasks.has(index)) return;
		const status =
			record.status === "completed" ? "completed" : record.status === "aborted" ? "interrupted" : "error";
		trackStepTelemetry(options.telemetry, "subagent_task_finished", {
			execution,
			status,
			duration_ms: Math.max(0, Date.now() - (createdAt[index] ?? Date.now())),
		});
	};
	const emit = (mode: StepSubagentDetails["mode"]): void => {
		onUpdate?.(
			makeToolResult(
				buildDetails(
					mode,
					discovery,
					scope,
					records.map((record) => ({
						...record,
						messages: [...record.messages],
						usage: cloneUsage(record.usage),
					})),
				),
				resultDetailsText(buildDetails(mode, discovery, scope, records)),
			),
		);
	};

	const runOne = async (task: StepSubagentTaskInput, index: number): Promise<StepSubagentResultRecord> => {
		const agent = resolveStepAgent(discovery.agents, task.agent);
		if (!agent) {
			const failed = makeFailureResult(
				task.agent,
				task.task,
				`Unknown agent: "${task.agent}". Available agents: ${formatStepAgentCatalog(discovery.agents)}`,
			);
			records[index] = failed;
			emit(mode);
			reportFinished(failed, index);
			return failed;
		}
		reportCreated(agent, index);
		const baseCwd = path.resolve(ctx.cwd, task.cwd ?? ".");
		let worktree: StepWorktreeLease | undefined;
		let childCwd = baseCwd;
		try {
			if (task.isolateWorkspace) {
				worktree = await options.worktreeManager.allocate(baseCwd, taskLabel(task, index));
				childCwd = worktree.path;
			}
			const update = (partial: StepSubagentRunResult): void => {
				records[index] = resultRecord(agent.name, task.task, partial, {
					agentSource: agent.source,
					worktreePath: worktree?.path,
					worktreeBranch: worktree?.branch,
				});
				emit(parallel ? "parallel" : "single");
			};
			const child = await options.runner({
				agent,
				task: task.task,
				cwd: childCwd,
				model: task.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined),
				thinkingLevel: ctx.thinkingLevel,
				signal,
				onUpdate: update,
				onNeedsInput: laneRuntime?.onNeedsInput,
				onChildRespawn: laneRuntime?.onChildRespawn,
				sessionId: laneRuntime?.sessionId
					? index === 0
						? laneRuntime.sessionId
						: `${laneRuntime.sessionId}-${index}`
					: `subagent-${randomUUID()}`,
				keepAlive: laneRuntime?.keepAlive === true,
			});
			const completed = resultRecord(agent.name, task.task, child, {
				agentSource: agent.source,
				worktreePath: worktree?.path,
				worktreeBranch: worktree?.branch,
			});
			records[index] = completed;
			emit(mode);
			if (worktree && task.retainWorktree === false) await worktree.cleanup();
			reportFinished(completed, index);
			return completed;
		} catch (error) {
			if (worktree && task.retainWorktree === false) await worktree.cleanup().catch(() => undefined);
			const message = error instanceof Error ? error.message : String(error);
			const failed = makeFailureResult(agent.name, task.task, message, agent.source);
			records[index] = failed;
			emit(mode);
			reportFinished(failed, index);
			return failed;
		}
	};

	// Publish the roster before dispatching. Every other emit happens inside
	// runOne, so without this the first update waits on a child's first streamed
	// event — process spawn, its mcp servers, then a first token — and the live
	// list stays invisible for the tens of seconds a caller most wants it. The
	// records are already seeded by makeEmptyResult, so this renders every lane
	// at 0s, including ones still queued behind maxConcurrency.
	emit(mode);
	if (parallel) await mapWithConcurrency(parallel, options.maxConcurrency, runOne);
	else if (chain) {
		let previous = "";
		for (let index = 0; index < chain.length; index++) {
			const task = {
				...chain[index],
				// Function replacement inserts `previous` verbatim. A string replacement would
				// let $-patterns in the prior subagent's output ($&, $`, $', $$) be reinterpreted
				// by String.prototype.replace, corrupting the next task's prompt.
				task: chain[index].task.replace(/\{previous\}/g, () => previous),
			};
			const record = await runOne(task, index);
			previous = finalOutput(record.messages) || resultText(record);
			if (record.status !== "completed") break;
		}
	} else await runOne(tasks[0], 0);
	const finalDetails = buildDetails(mode, discovery, scope, records);
	if (mode === "parallel") {
		const success = records.filter((record) => record.status === "completed").length;
		const summaries = records.map(
			(record) => `### ${record.agent} (${record.status})\n\n${truncateText(resultText(record), 50_000)}`,
		);
		return makeToolResult(
			finalDetails,
			`Parallel: ${success}/${records.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
		);
	}
	const record = records[0];
	return makeToolResult(finalDetails, record ? resultText(record) : "(no output)");
}
