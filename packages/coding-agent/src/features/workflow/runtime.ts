import path from "node:path";
import type { AgentToolResult } from "@step-harness/agent-core";
import type { ExtensionContext } from "../../core/extensions/types.ts";
import {
	type StepTelemetryKnownEventName,
	type StepTelemetryProperties,
	type StepTelemetryReporter,
	trackStepTelemetry,
} from "../../step/telemetry.ts";
import { acquireWorkflowAdmission, type WorkflowAdmissionLease } from "./admission.ts";
import { createDefaultWorkflowAgentRunner, normalizeWorkflowAgentValue } from "./agent-runner.ts";
import {
	clampWorkflowAgentLimit,
	clampWorkflowConcurrency,
	WorkflowBudget,
	WorkflowBudgetExceeded,
	WorkflowSemaphore,
} from "./budget.ts";
import {
	buildDeveloperPrompt,
	buildPlannerPrompt,
	buildQaPrompt,
	evidenceWindow,
	HOH_DEVELOPER_SCHEMA,
	HOH_EVIDENCE_SCHEMA,
	HOH_PLAN_SCHEMA,
	readCoverageDelta,
	readSpecCoverage,
	redactHohValue,
} from "./hoh.ts";
import { type WorkflowJournal, workflowHash, workflowJsonValue } from "./journal.ts";
import { WorkflowProgressStore } from "./progress.ts";
import { isSafeParseSchema, validateWorkflowSchema } from "./schema.ts";
import {
	checkWorkflowPathAccess,
	classifyWorkflowToolEffect,
	isWorkflowPathInside,
	resolveWorkflowToolProfile,
	type WorkflowAcl,
} from "./tool-profile.ts";
import type {
	IterateEvidence,
	IterateOptions,
	IterateResult,
	WorkflowAgentOptions,
	WorkflowAgentRunner,
	WorkflowAgentRunResult,
	WorkflowJournalEntry,
	WorkflowProgress,
	WorkflowProgressAgent,
	WorkflowRunResult,
	WorkflowTaskFailure,
	WorkflowUsage,
} from "./types.ts";
import { emptyWorkflowUsage, mergeWorkflowUsage, workflowUsageTokens } from "./types.ts";
import { runInQuickJs, type WorkflowVmHost, type WorkflowVmOptions, type WorkflowVmResult } from "./vm.ts";

const DEFAULT_MAX_ITERATIONS = 20;
const MAX_MAX_ITERATIONS = 100;
const DEFAULT_STAGNATION_LIMIT = 3;
const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60 * 1_000;
const MAX_AGENT_TIMEOUT_MS = 60 * 60 * 1_000;

export interface WorkflowRuntimeOptions {
	cwd: string;
	runId: string;
	name: string;
	journal: WorkflowJournal;
	progress?: WorkflowProgressStore;
	/** Live snapshots for tool updates; persistence remains owned by the progress store. */
	onProgress?: (progress: WorkflowProgress) => void;
	runner?: WorkflowAgentRunner;
	telemetry?: StepTelemetryReporter;
	budgetTotal?: number | null;
	maxConcurrency?: number;
	/** Trusted host/provider ceiling, never a model-authored override. */
	providerConcurrencyLimit?: number;
	maxAgents?: number;
	agentTimeoutMs?: number;
	/** Grace for an injected runner to settle after cancellation. Production children exit within 10s. */
	runnerCleanupTimeoutMs?: number;
	context?: ExtensionContext;
	nestedWorkflow?: (name: string, args: unknown, parent: WorkflowRuntime, depth: number) => Promise<unknown>;
	signal?: AbortSignal;
	vmExecutor?: (
		script: string,
		args: unknown,
		host: WorkflowVmHost,
		options?: WorkflowVmOptions,
	) => Promise<WorkflowVmResult>;
	now?: () => number;
}

export class WorkflowSchemaError extends Error {
	readonly errors: string[];
	readonly attempts: number;

	constructor(errors: string[], attempts: number) {
		super(
			`Workflow agent returned a value that does not match its schema after ${attempts} attempt${attempts === 1 ? "" : "s"}`,
		);
		this.name = "WorkflowSchemaError";
		this.errors = [...errors];
		this.attempts = attempts;
	}
}

export class WorkflowRuntime {
	readonly runId: string;
	readonly cwd: string;
	readonly name: string;
	readonly budget: WorkflowBudget;
	readonly semaphore: WorkflowSemaphore;
	private readonly concurrency: NonNullable<WorkflowProgress["concurrency"]>;
	private readonly journal: WorkflowJournal;
	private readonly progress: WorkflowProgressStore;
	private readonly onProgress?: WorkflowRuntimeOptions["onProgress"];
	private readonly runner: WorkflowAgentRunner;
	private readonly telemetry?: StepTelemetryReporter;
	private readonly context?: ExtensionContext;
	private readonly now: () => number;
	private readonly vmExecutor: NonNullable<WorkflowRuntimeOptions["vmExecutor"]>;
	private readonly nestedWorkflow?: WorkflowRuntimeOptions["nestedWorkflow"];
	private readonly signal?: AbortSignal;
	private readonly maxAgents: number;
	private readonly agentTimeoutMs: number;
	private readonly runnerCleanupTimeoutMs: number;
	private readonly controller = new AbortController();
	private readonly pendingOperations = new Set<Promise<unknown>>();
	private readonly nodeErrors = new WeakSet<object>();
	private readonly nestedTaskFailures: WorkflowTaskFailure[] = [];
	private readonly recordedFailures = new Set<number>();
	private admission?: WorkflowAdmissionLease;
	private lifecycle: "idle" | "running" | "closing" | "closed" = "idle";
	private sequence = 0;
	private agentCount = 0;
	private cacheHits = 0;
	/**
	 * Set once a live call in this run may have changed the environment. Cached
	 * results recorded against the previous environment are then stale unless the
	 * call never touched it.
	 */
	private environmentChanged = false;
	private phases: Array<{ title: string; detail?: string }> = [];
	private startedAt = 0;
	private activeWriterId: string | undefined;
	private previousCoverage = 0;
	/** Budget errors remain terminal even if the script catches an agent rejection. */
	private budgetError: WorkflowBudgetExceeded | undefined;

	constructor(options: WorkflowRuntimeOptions) {
		this.runId = options.runId;
		this.cwd = path.resolve(options.cwd);
		this.name = options.name.trim() || "workflow";
		this.journal = options.journal;
		this.onProgress = options.onProgress;
		this.budget = new WorkflowBudget(options.budgetTotal);
		const ceiling = clampWorkflowConcurrency(options.providerConcurrencyLimit);
		const limit = Math.min(ceiling, clampWorkflowConcurrency(options.maxConcurrency));
		this.concurrency = { requested: options.maxConcurrency, ceiling, limit, cap: limit };
		this.semaphore = new WorkflowSemaphore(limit);
		this.maxAgents = clampWorkflowAgentLimit(options.maxAgents);
		this.agentTimeoutMs = clampAgentTimeout(options.agentTimeoutMs);
		this.runnerCleanupTimeoutMs = options.runnerCleanupTimeoutMs ?? 12_000;
		this.runner = options.runner ?? createDefaultWorkflowAgentRunner();
		this.telemetry = options.telemetry;
		this.context = options.context;
		this.signal = AbortSignal.any([
			this.controller.signal,
			...[options.signal, options.context?.signal].filter((signal): signal is AbortSignal => signal !== undefined),
		]);
		this.nestedWorkflow = options.nestedWorkflow;
		this.now = options.now ?? Date.now;
		this.vmExecutor = options.vmExecutor ?? runInQuickJs;
		const startedAt = this.readNow();
		this.startedAt = startedAt;
		const initial: WorkflowProgress = {
			schemaVersion: 1,
			runId: this.runId,
			name: this.name,
			status: "running",
			concurrency: { ...this.concurrency },
			startedAt,
			updatedAt: startedAt,
			agents: [],
			completedAgents: 0,
			totalAgents: 0,
			spentTokens: 0,
		};
		this.progress =
			options.progress ?? new WorkflowProgressStore(options.journal.paths.progressPath, initial, this.now);
	}

	async runScript(script: string, args: unknown, vmOptions: WorkflowVmOptions = {}): Promise<WorkflowRunResult> {
		if (this.lifecycle !== "idle") throw new Error("Workflow run is already started or closed");
		this.lifecycle = "running";
		this.admission ??= acquireWorkflowAdmission(this.concurrency.ceiling);
		try {
			await this.journal.initialize(script);
			await this.updateProgress({ status: "running", message: "Workflow started" });
			this.track("workflow_started", { phase_count: 0 });
			if (this.signal?.aborted || this.context?.signal?.aborted) {
				throw new Error("Workflow operation was aborted");
			}
			const vmResult = await this.vmExecutor(script, args, this.host(0), {
				...vmOptions,
				signal: this.signal,
				filename: vmOptions.filename ?? this.journal.paths.scriptPath,
			});
			if (this.pendingOperations.size > 0)
				throw new Error(
					"Workflow script returned with unawaited agent calls or workflow/iterate operations; await the complete operation",
				);
			if (this.signal?.aborted || this.context?.signal?.aborted) {
				// A swallowing script (parallel()/pipeline() null-on-error) can absorb the abort
				// thrown by semaphore.acquire()/the runner and return normally; recheck here so a
				// cancelled run reports "aborted" instead of a silent "completed".
				throw new Error("Workflow operation was aborted");
			}
			if (this.budgetError) throw this.budgetError;
			const budgetTotal = this.budget.total();
			if (budgetTotal !== null && this.budget.spent() > budgetTotal) {
				// The script may have swallowed the per-call WorkflowBudgetExceeded (e.g. via
				// parallel()/pipeline() null-on-error). Fail the run closed regardless so a
				// budget breach is never silently reported as a completed run.
				throw new WorkflowBudgetExceeded(budgetTotal, this.budget.spent(), 0);
			}
			const finishedAt = this.readNow();
			const snapshot = this.progress.current();
			const failures = snapshot.agents.filter((agent) => agent.status === "failed" || agent.status === "aborted");
			const taskFailures = [...this.nestedTaskFailures, ...(vmResult.taskFailures ?? [])];
			const status =
				failures.length === 0 && taskFailures.length === 0
					? "completed"
					: snapshot.completedAgents > 0
						? "partial_failed"
						: "failed";
			await this.updateProgress({
				status,
				taskFailures,
				spentTokens: this.budget.spent(),
				message:
					status !== "completed"
						? `Workflow finished with ${failures.length} failed nodes and ${taskFailures.length} failed callbacks`
						: "Workflow completed",
			}).catch(() => undefined);
			this.track("workflow_finished", {
				status,
				agent_count: this.agentCount,
				cache_hits: this.cacheHits,
				spent_tokens: this.budget.spent(),
			});
			// The computed result is authoritative; a failed final disk write must not turn a
			// completed run into a thrown error.
			await Promise.all([this.journal.flush(), this.progress.flush()]).catch(() => undefined);
			return {
				schemaVersion: 1,
				runId: this.runId,
				name: this.name,
				status,
				summary: {
					total: snapshot.totalAgents,
					completed: snapshot.completedAgents,
					failed: failures.length,
					...(taskFailures.length ? { failedCallbacks: taskFailures.length } : {}),
				},
				...(taskFailures.length ? { taskFailures } : {}),
				timing: {
					runElapsedMs: finishedAt - this.startedAt,
					maxNodeExecutionMs: Math.max(
						0,
						...snapshot.agents.map((agent) =>
							agent.startedAt === undefined || agent.finishedAt === undefined
								? 0
								: agent.finishedAt - agent.startedAt,
						),
					),
				},
				failures,
				concurrency: this.concurrencySnapshot(),
				value: vmResult.value,
				meta: vmResult.meta,
				scriptPath: this.journal.paths.scriptPath,
				startedAt: this.startedAt,
				finishedAt,
				spentTokens: this.budget.spent(),
				cacheHits: this.cacheHits,
				agentCalls: this.agentCount,
				phases: [...this.phases],
			};
		} catch (error: unknown) {
			const status: WorkflowProgress["status"] =
				this.signal?.aborted || this.context?.signal?.aborted
					? "aborted"
					: error instanceof WorkflowBudgetExceeded
						? "budget_exceeded"
						: "failed";
			this.lifecycle = "closing";
			try {
				// A progress write failure must never replace the run's terminal error, and a
				// run whose disk writes fail must still publish its terminal state.
				await this.updateProgress({
					status: "stopping",
					message: `${errorMessage(error)}; cancelling unfinished nodes`,
				}).catch(() => undefined);
			} finally {
				this.controller.abort(error);
				await Promise.allSettled([...this.pendingOperations]);
			}
			await this.updateProgress({ status, spentTokens: this.budget.spent(), message: errorMessage(error) }).catch(
				() => undefined,
			);
			this.track("workflow_finished", {
				status,
				agent_count: this.agentCount,
				cache_hits: this.cacheHits,
				spent_tokens: this.budget.spent(),
			});
			await Promise.all([this.journal.flush(), this.progress.flush()]).catch(() => undefined);
			throw error;
		} finally {
			this.lifecycle = "closed";
			this.controller.abort();
			this.semaphore.dispose();
			this.admission?.release();
			this.admission = undefined;
		}
	}

	async runNestedScript(
		script: string,
		args: unknown,
		depth: number,
		vmOptions: WorkflowVmOptions = {},
	): Promise<unknown> {
		if (depth > 1) throw new Error("Nested workflow depth is limited to one level");
		const result = await this.vmExecutor(script, args, this.host(depth), { ...vmOptions, signal: this.signal });
		this.nestedTaskFailures.push(
			...(result.taskFailures ?? []).map((failure) => ({
				...failure,
				script: vmOptions.filename ?? "nested workflow",
			})),
		);
		return result.value;
	}

	agent(prompt: string, options: WorkflowAgentOptions = {}): Promise<unknown> {
		return this.trackOperation(() => this.runAgent(prompt, options));
	}

	private trackOperation<T>(start: () => Promise<T>): Promise<T> {
		if (this.lifecycle === "closed" || this.lifecycle === "closing")
			return Promise.reject(new Error("Workflow scope is closed"));
		this.admission ??= acquireWorkflowAdmission(this.concurrency.ceiling);
		const pending = Promise.resolve().then(() => {
			if (this.lifecycle === "closed" || this.lifecycle === "closing") throw new Error("Workflow scope is closed");
			return start();
		});
		this.pendingOperations.add(pending);
		const settled = (): void => {
			this.pendingOperations.delete(pending);
			if (this.lifecycle === "idle" && this.pendingOperations.size === 0) {
				this.admission?.release();
				this.admission = undefined;
			}
		};
		void pending.then(settled, settled);
		return pending;
	}

	private async runAgent(prompt: string, options: WorkflowAgentOptions): Promise<unknown> {
		const normalizedPrompt = normalizePrompt(prompt);
		const normalizedOptions = this.normalizeAgentOptions(options);
		const seq = this.sequence;
		this.sequence += 1;
		if (this.agentCount >= this.maxAgents) throw new Error(`Workflow exceeded the ${this.maxAgents}-agent limit`);
		this.agentCount += 1;
		const callHash = workflowHash({ prompt: normalizedPrompt, options: serializableOptions(normalizedOptions) });
		// Decide replay before the first await: calls a script issues together all
		// see the environment as it was before any of their live siblings ran a tool.
		const cached = this.takeCached(callHash, normalizedOptions);
		const task = normalizedPrompt.replace(/\s+/gu, " ").slice(0, 200);
		const label = normalizedOptions.label?.trim() || task;
		const agentId = `${this.runId}-${seq + 1}`;
		const identity = { id: agentId, label, task, phase: normalizedOptions.phase };
		if (cached) {
			this.cacheHits += 1;
			await this.journal.append({
				...cached.entry,
				seq,
				result: cached.result,
				callId: agentId,
				prompt: normalizedPrompt,
				options: workflowJsonValue(serializableOptions(normalizedOptions)),
				status: "cached",
				createdAt: this.readNow(),
			});
			await this.updateProgress({
				agent: {
					...identity,
					status: "cached",
					finishedAt: this.readNow(),
					usageTokens: workflowUsageTokens(cached.entry.usage),
				},
				spentTokens: this.budget.spent(),
			});
			this.track("workflow_agent_finished", {
				status: "cached",
				cached: true,
				token_count: workflowUsageTokens(cached.entry.usage),
			});
			this.track("workflow_resumed", { cache_hits: this.cacheHits });
			return cached.result;
		}

		const retries = clampRetries(normalizedOptions.retries);
		const parentSignal = this.signal ?? this.context?.signal;
		let release: (() => void) | undefined;
		let releaseShared: (() => void) | undefined;
		const shared = this.admission!.semaphore;
		let startedAt: number | undefined;
		let lastErrors: string[] = [];
		let totalUsage: WorkflowUsage = emptyWorkflowUsage();
		let rateLimitRetries = 0;
		let cleanupIncomplete = false;
		let timedOut = false;
		// Only the runner's structured provider classification can indicate congestion.
		// Error text, agent output, node labels and ids are never classified.
		let providerFailureKind: WorkflowAgentRunResult["errorKind"];
		let schemaAttempt = 0;
		let runnerInvoked = false;
		let toolActivityObserved = true;
		let worldAccess = false;
		let requestEpoch = this.semaphore.epoch;
		let sharedEpoch = shared.epoch;
		try {
			await this.updateProgress({ agent: { ...identity, status: "queued" } });
			this.validateMounts(normalizedOptions);
			release = await this.semaphore.acquire(parentSignal);
			releaseShared = await shared.acquire(parentSignal);
			if (parentSignal?.aborted) throw new Error("Workflow operation was aborted");
			// Check after acquiring a slot so queued waves see completed calls' spend.
			// Already-running calls can still overshoot by one concurrency wave.
			this.requireRemainingBudget();
			if (normalizedOptions.writable && normalizedOptions.writable.length > 0) {
				if (this.activeWriterId) {
					throw new Error(
						`Workflow single-writer violation: ${this.activeWriterId} already owns a writable mount`,
					);
				}
				this.activeWriterId = agentId;
			}
			startedAt = this.readNow();
			requestEpoch = this.semaphore.epoch;
			sharedEpoch = shared.epoch;
			await this.updateProgress({
				agent: { ...identity, status: "running", startedAt },
				totalAgents: this.agentCount,
			});
			this.track("workflow_agent_started", {
				label_length: label.length,
				phase_length: normalizedOptions.phase?.length ?? 0,
			});
			for (let attempt = 1; attempt <= retries; attempt += 1) {
				schemaAttempt = attempt;
				if (attempt > 1) {
					try {
						this.requireRemainingBudget();
					} catch (error) {
						await this.appendFailure(
							seq,
							callHash,
							normalizedPrompt,
							normalizedOptions,
							totalUsage,
							attempt - 1,
							errorMessage(error),
							rateLimitRetries,
						);
						throw error;
					}
				}
				const attemptPrompt =
					attempt === 1
						? normalizedPrompt
						: `${normalizedPrompt}\n\n<workflow-retry attempt="${attempt}">Previous output failed schema validation: ${lastErrors.join("; ")}</workflow-retry>`;
				let raw: WorkflowAgentRunResult;
				const attemptController = new AbortController();
				const relayAbort = (): void => attemptController.abort(parentSignal?.reason);
				if (parentSignal?.aborted) relayAbort();
				else parentSignal?.addEventListener("abort", relayAbort, { once: true });
				if (attemptController.signal.aborted)
					throw attemptController.signal.reason ?? new Error("Workflow operation was aborted");
				let timeout: ReturnType<typeof setTimeout> | undefined;
				let runnerPromise: Promise<WorkflowAgentRunResult> | undefined;
				let cancelAttempt: (() => void) | undefined;
				let settling: Promise<WorkflowAgentRunResult | undefined> | undefined;
				// After cancellation the runner gets a bounded grace to settle. Returns its
				// late result so the usage it reports can still be accounted.
				const settleRunner = (): Promise<WorkflowAgentRunResult | undefined> => {
					settling ??= (async () => {
						if (!runnerPromise || !attemptController.signal.aborted) return undefined;
						let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
						try {
							const settled = await Promise.race([
								runnerPromise.then(
									(value) => ({ value }),
									() => ({ value: undefined }),
								),
								new Promise<undefined>((resolve) => {
									cleanupTimer = setTimeout(() => resolve(undefined), this.runnerCleanupTimeoutMs);
								}),
							]);
							if (settled) return settled.value;
							// An injected runner violated the cancellation contract. Keep its
							// shared slot reserved until it settles; never admit replacement
							// work on top of an operation that may still be using the backend.
							cleanupIncomplete = true;
							const retainedLease = acquireWorkflowAdmission(this.concurrency.ceiling);
							const retainedRelease = releaseShared;
							releaseShared = undefined;
							const done = (): void => {
								retainedRelease?.();
								retainedLease.release();
							};
							void runnerPromise.then(done, done);
							return undefined;
						} finally {
							if (cleanupTimer) clearTimeout(cleanupTimer);
						}
					})();
					return settling;
				};
				try {
					const cancelled = new Promise<never>((_resolve, reject) => {
						cancelAttempt = () =>
							reject(attemptController.signal.reason ?? new Error("Workflow operation was aborted"));
						attemptController.signal.addEventListener("abort", cancelAttempt, { once: true });
						if (attemptController.signal.aborted) cancelAttempt();
						timeout = setTimeout(() => {
							timedOut = true;
							attemptController.abort(
								new Error(
									`Workflow agent ${label} timed out after ${this.agentTimeoutMs}ms (execution only; queue time excluded)`,
								),
							);
						}, this.agentTimeoutMs);
					});
					runnerInvoked = true;
					runnerPromise = this.runner({
						prompt: attemptPrompt,
						options: normalizedOptions,
						cwd: this.cwd,
						signal: attemptController.signal,
						runId: this.runId,
						agentId,
						onToolExecutionStart: (toolName) => {
							const effect = classifyWorkflowToolEffect(toolName);
							if (effect !== "none") worldAccess = true;
							if (effect === "mutate") this.environmentChanged = true;
						},
						onModelRequest: (event) => {
							if (attemptController.signal.aborted) return;
							if (event.type === "started") {
								requestEpoch = this.semaphore.epoch;
								sharedEpoch = shared.epoch;
							}
							if (event.type === "succeeded") {
								this.semaphore.succeeded(requestEpoch);
								shared.succeeded(sharedEpoch);
								// The next request in this turn (a resample after leaked tool-call
								// markup) has no "started" event of its own.
								requestEpoch = this.semaphore.epoch;
								sharedEpoch = shared.epoch;
							}
							if (event.type === "rate_limit") {
								rateLimitRetries++;
								this.semaphore.throttle(requestEpoch, event.delayMs);
								shared.throttle(sharedEpoch, event.delayMs);
								requestEpoch = this.semaphore.epoch;
								sharedEpoch = shared.epoch;
							}
							void this.updateProgress({
								concurrency: this.concurrencySnapshot(),
								agent: {
									...identity,
									status: "running",
									startedAt,
									rateLimitRetries,
									retry:
										event.type === "rate_limit"
											? { attempt: event.attempt, maxRetries: event.maxRetries, delayMs: event.delayMs }
											: undefined,
								},
							}).catch(() => undefined);
						},
					});
					raw = await Promise.race([runnerPromise, cancelled]);
					if (raw.toolActivityObserved !== true) toolActivityObserved = false;
				} catch (error: unknown) {
					// A thrown attempt cannot vouch that every tool start was reported.
					toolActivityObserved = false;
					// A timed-out or aborted attempt still spent tokens. The runner reports
					// them when it settles, after the race has already been decided.
					const late = await settleRunner();
					if (late) {
						const lateUsage = normalizeUsage(late.usage);
						totalUsage = mergeWorkflowUsage(totalUsage, lateUsage);
						try {
							this.budget.consume(lateUsage);
						} catch (budgetError: unknown) {
							if (budgetError instanceof WorkflowBudgetExceeded) this.budgetError ??= budgetError;
						}
					}
					if (!attemptController.signal.aborted) providerFailureKind = thrownErrorKind(error);
					await this.appendFailure(
						seq,
						callHash,
						normalizedPrompt,
						normalizedOptions,
						totalUsage,
						attempt,
						errorMessage(error),
						rateLimitRetries,
					);
					throw error;
				} finally {
					if (timeout) clearTimeout(timeout);
					if (cancelAttempt) attemptController.signal.removeEventListener("abort", cancelAttempt);
					parentSignal?.removeEventListener("abort", relayAbort);
					await settleRunner();
				}
				const usage = normalizeUsage(raw.usage);
				totalUsage = mergeWorkflowUsage(totalUsage, usage);
				try {
					this.budget.consume(usage);
				} catch (error: unknown) {
					if (error instanceof WorkflowBudgetExceeded) this.budgetError ??= error;
					await this.appendFailure(
						seq,
						callHash,
						normalizedPrompt,
						normalizedOptions,
						totalUsage,
						attempt,
						errorMessage(error),
						rateLimitRetries,
					);
					throw error;
				}
				if (raw.status === "failed" || raw.status === "aborted") {
					const failure = raw.errorMessage ?? raw.text ?? `Workflow agent ${label} ${raw.status}`;
					providerFailureKind = raw.errorKind;
					await this.appendFailure(
						seq,
						callHash,
						normalizedPrompt,
						normalizedOptions,
						totalUsage,
						attempt,
						failure,
						rateLimitRetries,
					);
					throw new Error(failure);
				}
				const value = normalizeWorkflowAgentValue(raw);
				const validation = validateWorkflowSchema(normalizedOptions.schema, value, true);
				if (!validation.valid) {
					lastErrors = validation.errors;
					this.track("workflow_schema_failed", { attempt, error_count: lastErrors.length });
					if (attempt < retries) continue;
					await this.appendFailure(
						seq,
						callHash,
						normalizedPrompt,
						normalizedOptions,
						totalUsage,
						attempt,
						lastErrors.join("; "),
						rateLimitRetries,
					);
					throw new WorkflowSchemaError(lastErrors, attempt);
				}
				const finalValue = normalizedOptions.schema ? validation.value : value;
				await this.journal.append({
					schemaVersion: 1,
					seq,
					callId: agentId,
					callHash,
					prompt: normalizedPrompt,
					options: workflowJsonValue(serializableOptions(normalizedOptions)),
					status: "completed",
					result: finalValue,
					usage: totalUsage,
					attempt,
					createdAt: this.readNow(),
					rateLimitRetries,
					...(toolActivityObserved ? { worldAccess } : {}),
				});
				await this.updateProgress({
					agent: {
						...identity,
						status: "completed",
						rateLimitRetries,
						retry: undefined,
						startedAt,
						finishedAt: this.readNow(),
						usageTokens: workflowUsageTokens(totalUsage),
					},
					spentTokens: this.budget.spent(),
				});
				this.track("workflow_agent_finished", {
					status: "completed",
					cached: false,
					token_count: workflowUsageTokens(totalUsage),
				});
				return finalValue;
			}
			throw new WorkflowSchemaError(lastErrors, retries);
		} catch (error: unknown) {
			const message =
				errorMessage(error) +
				(cleanupIncomplete ? "; runner did not settle after cancellation; its shared slot remains reserved" : "");
			const rateLimited = providerFailureKind === "rate_limit";
			// Classify before recording anything. A failed journal or progress write must
			// not replace the node's own error, and the marker has to exist before the
			// bridge can ask for it, or parallel()/pipeline() reports this node failure a
			// second time as a callback failure.
			const propagated = error instanceof Error ? error : new Error(errorMessage(error));
			this.nodeErrors.add(propagated);
			// Recording is best effort: the node already failed, and a disk error must not
			// turn that into a different terminal error for the run.
			if (!this.recordedFailures.has(seq)) {
				await this.appendFailure(
					seq,
					callHash,
					normalizedPrompt,
					normalizedOptions,
					totalUsage,
					schemaAttempt,
					message,
					rateLimitRetries,
				);
			}
			if (rateLimited) {
				this.semaphore.throttle(requestEpoch, 1000);
				shared.throttle(sharedEpoch, 1000);
			}
			await this.updateProgress({
				concurrency: this.concurrencySnapshot(),
				agent: {
					...identity,
					status: parentSignal?.aborted ? "aborted" : "failed",
					error: {
						code: rateLimited
							? rateLimitRetries > 0
								? "RATE_LIMIT_RETRIES_EXHAUSTED"
								: "RATE_LIMITED"
							: error instanceof WorkflowSchemaError
								? "SCHEMA_VALIDATION_FAILED"
								: timedOut
									? "NODE_TIMEOUT"
									: "NODE_FAILED",
						message: message.slice(0, 2000),
						retryable: rateLimited,
						...(rateLimited ? { retryExhausted: rateLimitRetries > 0 } : {}),
					},
					rateLimitRetries,
					retry: undefined,
					startedAt,
					finishedAt: this.readNow(),
					usageTokens: workflowUsageTokens(totalUsage),
				},
				spentTokens: this.budget.spent(),
			}).catch(() => undefined);
			if (error instanceof WorkflowBudgetExceeded)
				this.track("workflow_budget_exceeded", {
					spent_tokens: error.spentTokens,
					requested_tokens: error.requestedTokens,
				});
			throw propagated;
		} finally {
			// Without a complete tool report, a live call may have changed anything.
			if (runnerInvoked && !toolActivityObserved) this.environmentChanged = true;
			releaseShared?.();
			release?.();
			if (this.activeWriterId === agentId) this.activeWriterId = undefined;
		}
	}

	/**
	 * Find a replayable result for this call. Runtime schemas (safeParse objects)
	 * cannot be hashed, so their calls always run live. A cached result must still
	 * satisfy the call's schema, and once this run may have changed the
	 * environment only results that never touched it remain valid.
	 */
	private takeCached(
		callHash: string,
		options: WorkflowAgentOptions,
	): { entry: WorkflowJournalEntry; result: unknown } | undefined {
		if (isSafeParseSchema(options.schema)) return undefined;
		let result: unknown;
		const entry = this.journal.getCached(callHash, (candidate) => {
			if (this.environmentChanged && candidate.worldAccess !== false) return false;
			if (options.schema === undefined) {
				result = candidate.result;
				return true;
			}
			const validation = validateWorkflowSchema(options.schema, candidate.result, true);
			result = validation.value;
			return validation.valid;
		});
		return entry ? { entry, result } : undefined;
	}

	phase(title: string): void {
		if (this.lifecycle === "closed") return;
		const normalized = title.trim().slice(0, 200);
		if (!normalized) return;
		this.phases.push({ title: normalized });
		void this.updateProgress({
			currentPhase: normalized,
			phaseIndex: this.phases.length - 1,
			totalAgents: this.agentCount,
		}).catch(() => undefined);
		this.track("workflow_phase", { title_length: normalized.length, phase_index: this.phases.length - 1 });
	}

	log(message: string): void {
		if (this.lifecycle === "closed") return;
		const normalized = message.trim().slice(0, 2_000);
		if (!normalized) return;
		void this.updateProgress({ message: normalized }).catch(() => undefined);
	}

	async iterate(rawOptions: Record<string, unknown>): Promise<unknown> {
		const options = normalizeIterateOptions(rawOptions, this.cwd);
		const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
		const targetCoverage = options.stopWhenSpecCoverage ?? 0.95;
		const stagnationLimit = options.stagnationLimit ?? DEFAULT_STAGNATION_LIMIT;
		const evidence: IterateEvidence[] = [];
		let stagnation = 0;
		let coverage = this.previousCoverage;
		let stopReason = "max_iterations";
		for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
			this.track("workflow_hoh_iteration", { iteration });
			this.phase(`Iteration ${iteration} — Planner`);
			const promptInput = {
				spec: options.spec,
				iteration,
				artifactPath: options.artifactPath ?? this.cwd,
				previousEvidence: evidenceWindow(evidence),
			};
			const plan = await this.agent(buildPlannerPrompt(promptInput), {
				label: `planner:${iteration}`,
				phase: `iteration-${iteration}/planner`,
				agentType: options.planner ?? "planner",
				toolProfile: "hoh-planner",
				readOnly: [options.artifactPath ?? this.cwd],
				schema: HOH_PLAN_SCHEMA,
			});
			if (!hasObjective(plan)) {
				stopReason = "empty_objective";
				const stopped = this.makeStoppedEvidence(iteration, plan, null, null, coverage, 0, stopReason);
				evidence.push(stopped);
				await this.writeEvidence(options, stopped);
				break;
			}

			this.phase(`Iteration ${iteration} — Developer`);
			const developer = await this.agent(buildDeveloperPrompt(promptInput, plan), {
				label: `developer:${iteration}`,
				phase: `iteration-${iteration}/developer`,
				agentType: options.developer ?? "general",
				toolProfile: "hoh-developer",
				writable: [options.artifactPath ?? this.cwd],
				readOnly: [],
				schema: HOH_DEVELOPER_SCHEMA,
			});

			this.phase(`Iteration ${iteration} — QA`);
			const qa = await this.agent(buildQaPrompt(promptInput, plan, developer), {
				label: `qa:${iteration}`,
				phase: `iteration-${iteration}/qa`,
				agentType: options.qa ?? "review",
				toolProfile: "hoh-qa",
				readOnly: [options.artifactPath ?? this.cwd],
				schema: HOH_EVIDENCE_SCHEMA,
			});
			const nextCoverage = readSpecCoverage(qa, coverage);
			const delta = readCoverageDelta(qa, coverage, nextCoverage);
			coverage = nextCoverage;
			const reachedTarget = coverage >= targetCoverage;
			if (delta <= 0) stagnation += 1;
			else stagnation = 0;
			const shouldStop = reachedTarget || iteration === maxIterations || stagnation >= stagnationLimit;
			if (reachedTarget) stopReason = "coverage_target";
			else if (stagnation >= stagnationLimit) stopReason = "stagnation";
			else if (iteration === maxIterations) stopReason = "max_iterations";
			const completed = this.makeStoppedEvidence(
				iteration,
				plan,
				developer,
				qa,
				coverage,
				delta,
				shouldStop ? stopReason : "continue",
			);
			evidence.push(completed);
			await this.writeEvidence(options, completed);
			if (shouldStop) break;
		}
		this.previousCoverage = coverage;
		const result: IterateResult = {
			iterations: evidence.length,
			status: stopReason === "coverage_target" ? "completed" : "stopped",
			stopReason,
			specCoverage: coverage,
			evidence,
		};
		this.track("workflow_hoh_finished", {
			iterations: result.iterations,
			stop_reason: result.stopReason,
			spec_coverage_percent: Math.round(coverage * 100),
		});
		return result;
	}

	private requireRemainingBudget(): void {
		const total = this.budget.total();
		if (total !== null && this.budget.remaining() <= 0) {
			this.budgetError ??= new WorkflowBudgetExceeded(total, this.budget.spent(), 0);
			throw this.budgetError;
		}
	}

	private async updateProgress(patch: Partial<WorkflowProgress> & { agent?: WorkflowProgressAgent }): Promise<void> {
		if (this.lifecycle === "closed") return;
		let snapshot: WorkflowProgress;
		try {
			snapshot = await this.progress.update({ ...patch, concurrency: this.concurrencySnapshot() });
		} catch {
			// progress.json is a projection. The in-memory state is already updated when a
			// write fails, and a disk error here must not fail a node whose work finished.
			snapshot = this.progress.current();
		}
		try {
			this.onProgress?.(snapshot);
		} catch {
			// A live-update listener is a consumer of the projection. Its failure must not
			// change run accounting, or one node failure is reported twice.
		}
	}

	private concurrencySnapshot(): NonNullable<WorkflowProgress["concurrency"]> {
		return {
			...this.concurrency,
			cap: Math.min(this.semaphore.max, this.admission?.semaphore.max ?? this.semaphore.max),
			sharedActive: this.admission?.semaphore.active ?? 0,
		};
	}

	private host(depth: number): WorkflowVmHost {
		return {
			isNodeFailure: (error) =>
				error !== null &&
				typeof error === "object" &&
				(this.nodeErrors.has(error) ||
					(error as { __workflowNodeFailure?: boolean }).__workflowNodeFailure === true),
			agent: (prompt, options) => this.agent(prompt, options as WorkflowAgentOptions),
			phase: (title) => this.phase(title),
			log: (message) => this.log(message),
			iterate: (options) => this.trackOperation(() => this.iterate(options)),
			nestedWorkflow: (name, args) => {
				if (depth >= 1) return Promise.reject(new Error("Nested workflow depth is limited to one level"));
				if (!this.nestedWorkflow) return Promise.reject(new Error(`Nested workflow "${name}" is not available`));
				return this.trackOperation(() => this.nestedWorkflow!(name, args, this, depth));
			},
			budgetSpent: () => this.budget.spent(),
			budgetRemaining: () => this.budget.remaining(),
			budgetTotal: () => this.budget.total(),
		};
	}

	private normalizeAgentOptions(options: WorkflowAgentOptions): WorkflowAgentOptions {
		const profile = resolveWorkflowToolProfile(options.toolProfile);
		return {
			...(options.label?.trim() ? { label: options.label.trim().slice(0, 200) } : {}),
			...(options.phase?.trim() ? { phase: options.phase.trim().slice(0, 200) } : {}),
			...(options.schema !== undefined ? { schema: options.schema } : {}),
			...(options.toolProfile !== undefined ? { toolProfile: profile ?? "*" } : {}),
			...(options.readOnly
				? {
						readOnly: options.readOnly
							.map((item) => item.trim())
							.filter(Boolean)
							.slice(0, 64),
					}
				: {}),
			...(options.writable
				? {
						writable: options.writable
							.map((item) => item.trim())
							.filter(Boolean)
							.slice(0, 64),
					}
				: {}),
			...(options.agentType?.trim() ? { agentType: options.agentType.trim().slice(0, 100) } : {}),
			...(options.model?.trim() ? { model: options.model.trim().slice(0, 200) } : {}),
			...(options.effort?.trim() ? { effort: options.effort.trim().slice(0, 32) } : {}),
			...(options.retries !== undefined ? { retries: clampRetries(options.retries) } : {}),
		};
	}

	private validateMounts(options: WorkflowAgentOptions): void {
		const acl: WorkflowAcl = { readOnly: options.readOnly, writable: options.writable };
		for (const mount of options.readOnly ?? []) {
			if (!isWorkflowPathInside(this.cwd, mount)) {
				this.track("workflow_acl_blocked", { operation: "read", reason_code: "outside_cwd" });
				throw new Error(`Workflow readOnly mount must stay inside the working directory: ${mount}`);
			}
			const decision = checkWorkflowPathAccess(this.cwd, mount, "read", acl);
			if (!decision.allowed) {
				this.track("workflow_acl_blocked", { operation: "read", reason_code: "invalid_mount" });
				throw new Error(decision.reason ?? "Invalid workflow readOnly mount");
			}
		}
		for (const mount of options.writable ?? []) {
			if (!isWorkflowPathInside(this.cwd, mount)) {
				this.track("workflow_acl_blocked", { operation: "write", reason_code: "outside_cwd" });
				throw new Error(`Workflow writable mount must stay inside the working directory: ${mount}`);
			}
			const decision = checkWorkflowPathAccess(this.cwd, mount, "write", acl);
			if (!decision.allowed) {
				this.track("workflow_acl_blocked", { operation: "write", reason_code: "outside_mount" });
				throw new Error(decision.reason ?? "Invalid workflow writable mount");
			}
		}
	}

	private makeStoppedEvidence(
		iteration: number,
		plan: unknown,
		developer: unknown,
		qa: unknown,
		coverage: number,
		delta: number,
		stopReason: string,
	): IterateEvidence {
		return {
			iteration,
			plan: redactHohValue(plan),
			developer: redactHohValue(developer),
			evidence: redactHohValue(qa),
			specCoverage: coverage,
			coverageDelta: delta,
			status: stopReason === "continue" ? "completed" : "stopped",
			...(stopReason !== "continue" ? { stopReason } : {}),
			createdAt: this.readNow(),
		};
	}

	private async writeEvidence(options: IterateOptions, evidence: IterateEvidence): Promise<void> {
		await this.journal.appendEvidence(workflowJsonValue(evidence), options.evidencePath);
		this.track("workflow_hoh_evidence_written", {
			iteration: evidence.iteration,
			spec_coverage_percent: Math.round(evidence.specCoverage * 100),
			coverage_delta_percent: Math.round(evidence.coverageDelta * 100),
		});
	}

	private async appendFailure(
		seq: number,
		callHash: string,
		prompt: string,
		options: WorkflowAgentOptions,
		usage: WorkflowUsage,
		attempt: number,
		error: string,
		rateLimitRetries = 0,
	): Promise<void> {
		// Recording a failure is best effort. The node already failed, so a journal
		// write error must never replace the node's own error, change the run's
		// terminal status, or skip failure classification.
		await this.journal
			.append({
				schemaVersion: 1,
				seq,
				callId: `${this.runId}-${seq + 1}`,
				callHash,
				prompt,
				options: workflowJsonValue(serializableOptions(options)),
				status: this.signal?.aborted ? "aborted" : "failed",
				usage,
				attempt,
				rateLimitRetries,
				createdAt: this.readNow(),
				error: error.slice(0, 2_000),
			})
			.catch(() => undefined);
		this.recordedFailures.add(seq);
	}

	private track(event: StepTelemetryKnownEventName, properties: Record<string, string | number | boolean>): void {
		if (this.lifecycle === "closed") return;
		if (this.telemetry) trackStepTelemetry(this.telemetry, event, properties as StepTelemetryProperties);
		const record = {
			schemaVersion: 1 as const,
			event,
			runId: this.runId,
			createdAt: this.readNow(),
			properties,
		};
		void this.journal.appendTelemetry(record).catch(() => undefined);
	}

	private readNow(): number {
		try {
			const value = this.now();
			return Number.isFinite(value) ? value : Date.now();
		} catch {
			return Date.now();
		}
	}
}

function normalizePrompt(prompt: string): string {
	if (typeof prompt !== "string" || !prompt.trim()) throw new Error("workflow agent() requires a non-empty prompt");
	return prompt.trim().slice(0, 32_000);
}

function normalizeUsage(usage: Partial<WorkflowUsage> | undefined): WorkflowUsage {
	return mergeWorkflowUsage(emptyWorkflowUsage(), usage);
}

function serializableOptions(options: WorkflowAgentOptions): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(options)) {
		if (
			key === "schema" &&
			value &&
			typeof value === "object" &&
			typeof (value as { safeParse?: unknown }).safeParse === "function"
		) {
			result[key] = { type: "runtime-schema" };
		} else {
			result[key] = value;
		}
	}
	return result;
}

function clampRetries(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return 3;
	return Math.max(1, Math.min(3, Math.floor(value)));
}

function clampAgentTimeout(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return DEFAULT_AGENT_TIMEOUT_MS;
	return Math.max(1_000, Math.min(MAX_AGENT_TIMEOUT_MS, Math.floor(value)));
}

function hasObjective(value: unknown): boolean {
	return (
		!!value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		typeof (value as Record<string, unknown>).objective === "string" &&
		Boolean(((value as Record<string, unknown>).objective as string).trim())
	);
}

function normalizeIterateOptions(raw: Record<string, unknown>, cwd: string): IterateOptions {
	const spec = typeof raw.spec === "string" ? raw.spec.trim() : "";
	if (!spec) throw new Error("iterate() requires a non-empty spec");
	const maxIterations = integerInRange(raw.maxIterations, 1, MAX_MAX_ITERATIONS);
	const stopWhenSpecCoverage = numberInRange(raw.stopWhenSpecCoverage, 0, 1);
	const stagnationLimit = integerInRange(raw.stagnationLimit, 1, 10);
	const artifactPath = resolveOptionalWorkflowPath(cwd, raw.artifactPath, "artifactPath");
	const evidencePath = resolveOptionalWorkflowPath(cwd, raw.evidencePath, "evidencePath");
	return {
		spec: spec.slice(0, 32_000),
		...(maxIterations === undefined ? {} : { maxIterations }),
		...(artifactPath ? { artifactPath } : {}),
		...(evidencePath ? { evidencePath } : {}),
		...(stopWhenSpecCoverage === undefined ? {} : { stopWhenSpecCoverage }),
		...(typeof raw.planner === "string" && raw.planner.trim() ? { planner: raw.planner.trim() } : {}),
		...(typeof raw.developer === "string" && raw.developer.trim() ? { developer: raw.developer.trim() } : {}),
		...(typeof raw.qa === "string" && raw.qa.trim() ? { qa: raw.qa.trim() } : {}),
		...(stagnationLimit === undefined ? {} : { stagnationLimit }),
	};
}

function resolveOptionalWorkflowPath(cwd: string, value: unknown, label: string): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	const resolved = path.resolve(cwd, value.trim());
	if (!isWorkflowPathInside(cwd, resolved))
		throw new Error(`iterate() ${label} must stay inside the working directory`);
	return resolved;
}

function integerInRange(value: unknown, min: number, max: number): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.max(min, Math.min(max, Math.floor(value)));
}

function numberInRange(value: unknown, min: number, max: number): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.max(min, Math.min(max, value));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function workflowToolResult(value: WorkflowRunResult): AgentToolResult<WorkflowRunResult> {
	return {
		content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
		details: value,
		isError: value.status !== "completed",
	};
}

export { WorkflowBudgetExceeded };

/** A runner may throw an error that carries the provider's structured kind. */
function thrownErrorKind(error: unknown): WorkflowAgentRunResult["errorKind"] {
	if (!error || typeof error !== "object" || !("errorKind" in error)) return undefined;
	const kind = (error as { errorKind?: unknown }).errorKind;
	return kind === "rate_limit" ||
		kind === "quota" ||
		kind === "auth" ||
		kind === "transient" ||
		kind === "invalid_request"
		? kind
		: undefined;
}
