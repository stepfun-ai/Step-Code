import path from "node:path";
import type { AgentToolResult } from "@step-harness/agent-core";
import type { ExtensionContext } from "../../core/extensions/types.ts";
import {
	type StepTelemetryKnownEventName,
	type StepTelemetryProperties,
	type StepTelemetryReporter,
	trackStepTelemetry,
} from "../../step/telemetry.ts";
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
import { validateWorkflowSchema } from "./schema.ts";
import {
	checkWorkflowPathAccess,
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
	WorkflowProgress,
	WorkflowProgressAgent,
	WorkflowRunResult,
	WorkflowUsage,
} from "./types.ts";
import { emptyWorkflowUsage, mergeWorkflowUsage, workflowUsageTokens } from "./types.ts";
import { runInIsolatedVm, type WorkflowVmHost, type WorkflowVmOptions, type WorkflowVmResult } from "./vm.ts";

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
	maxAgents?: number;
	agentTimeoutMs?: number;
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
	private sequence = 0;
	private agentCount = 0;
	private cacheHits = 0;
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
		this.semaphore = new WorkflowSemaphore(clampWorkflowConcurrency(options.maxConcurrency));
		this.maxAgents = clampWorkflowAgentLimit(options.maxAgents);
		this.agentTimeoutMs = clampAgentTimeout(options.agentTimeoutMs);
		this.runner = options.runner ?? createDefaultWorkflowAgentRunner();
		this.telemetry = options.telemetry;
		this.context = options.context;
		this.signal = options.signal;
		this.nestedWorkflow = options.nestedWorkflow;
		this.now = options.now ?? Date.now;
		this.vmExecutor = options.vmExecutor ?? runInIsolatedVm;
		const startedAt = this.readNow();
		this.startedAt = startedAt;
		const initial: WorkflowProgress = {
			schemaVersion: 1,
			runId: this.runId,
			name: this.name,
			status: "running",
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
		await this.journal.initialize(script);
		await this.updateProgress({ status: "running", message: "Workflow started" });
		this.track("workflow_started", { phase_count: 0 });
		try {
			if (this.signal?.aborted || this.context?.signal?.aborted) {
				throw new Error("Workflow operation was aborted");
			}
			const vmResult = await this.vmExecutor(script, args, this.host(0), {
				...vmOptions,
				filename: vmOptions.filename ?? this.journal.paths.scriptPath,
			});
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
			await this.updateProgress({
				status: "completed",
				spentTokens: this.budget.spent(),
				message: "Workflow completed",
			});
			this.track("workflow_finished", {
				status: "completed",
				agent_count: this.agentCount,
				cache_hits: this.cacheHits,
				spent_tokens: this.budget.spent(),
			});
			await Promise.all([this.journal.flush(), this.progress.flush()]);
			return {
				schemaVersion: 1,
				runId: this.runId,
				name: this.name,
				status: "completed",
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
			await this.updateProgress({ status, spentTokens: this.budget.spent(), message: errorMessage(error) });
			this.track("workflow_finished", {
				status,
				agent_count: this.agentCount,
				cache_hits: this.cacheHits,
				spent_tokens: this.budget.spent(),
			});
			await Promise.all([this.journal.flush(), this.progress.flush()]);
			throw error;
		}
	}

	async runNestedScript(
		script: string,
		args: unknown,
		depth: number,
		vmOptions: WorkflowVmOptions = {},
	): Promise<unknown> {
		if (depth > 1) throw new Error("Nested workflow depth is limited to one level");
		const result = await this.vmExecutor(script, args, this.host(depth), vmOptions);
		return result.value;
	}

	async agent(prompt: string, options: WorkflowAgentOptions = {}): Promise<unknown> {
		const normalizedPrompt = normalizePrompt(prompt);
		const normalizedOptions = this.normalizeAgentOptions(options);
		const seq = this.sequence;
		this.sequence += 1;
		if (this.agentCount >= this.maxAgents) throw new Error(`Workflow exceeded the ${this.maxAgents}-agent limit`);
		this.agentCount += 1;
		const callHash = workflowHash({ prompt: normalizedPrompt, options: serializableOptions(normalizedOptions) });
		const cached = this.journal.getCached(seq, callHash);
		const task = normalizedPrompt.replace(/\s+/gu, " ").slice(0, 200);
		const label = normalizedOptions.label?.trim() || task;
		const agentId = `${this.runId}-${seq + 1}`;
		const identity = { id: agentId, label, task, phase: normalizedOptions.phase };
		if (cached) {
			this.cacheHits += 1;
			await this.journal.append({
				...cached,
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
					usageTokens: workflowUsageTokens(cached.usage),
				},
				spentTokens: this.budget.spent(),
			});
			this.track("workflow_agent_finished", {
				status: "cached",
				cached: true,
				token_count: workflowUsageTokens(cached.usage),
			});
			this.track("workflow_resumed", { cache_hits: this.cacheHits });
			return cached.result;
		}

		const retries = clampRetries(normalizedOptions.retries);
		const parentSignal = this.signal ?? this.context?.signal;
		let release: (() => void) | undefined;
		let startedAt: number | undefined;
		let lastErrors: string[] = [];
		let totalUsage: WorkflowUsage = emptyWorkflowUsage();
		try {
			await this.updateProgress({ agent: { ...identity, status: "queued" } });
			this.validateMounts(normalizedOptions);
			release = await this.semaphore.acquire(parentSignal);
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
			await this.updateProgress({
				agent: { ...identity, status: "running", startedAt },
				totalAgents: this.agentCount,
			});
			this.track("workflow_agent_started", {
				label_length: label.length,
				phase_length: normalizedOptions.phase?.length ?? 0,
			});
			for (let attempt = 1; attempt <= retries; attempt += 1) {
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
				let timeout: ReturnType<typeof setTimeout> | undefined;
				try {
					const timedOut = new Promise<never>((_resolve, reject) => {
						timeout = setTimeout(() => {
							attemptController.abort();
							reject(new Error(`Workflow agent ${label} timed out after ${this.agentTimeoutMs}ms`));
						}, this.agentTimeoutMs);
					});
					raw = await Promise.race([
						this.runner({
							prompt: attemptPrompt,
							options: normalizedOptions,
							cwd: this.cwd,
							signal: attemptController.signal,
							runId: this.runId,
							agentId,
						}),
						timedOut,
					]);
				} catch (error: unknown) {
					await this.appendFailure(
						seq,
						callHash,
						normalizedPrompt,
						normalizedOptions,
						totalUsage,
						attempt,
						errorMessage(error),
					);
					throw error;
				} finally {
					if (timeout) clearTimeout(timeout);
					parentSignal?.removeEventListener("abort", relayAbort);
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
					);
					throw error;
				}
				if (raw.status === "failed" || raw.status === "aborted") {
					const failure = raw.errorMessage ?? raw.text ?? `Workflow agent ${label} ${raw.status}`;
					await this.appendFailure(
						seq,
						callHash,
						normalizedPrompt,
						normalizedOptions,
						totalUsage,
						attempt,
						failure,
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
				});
				await this.updateProgress({
					agent: {
						...identity,
						status: "completed",
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
			await this.updateProgress({
				agent: {
					...identity,
					status: parentSignal?.aborted ? "aborted" : "failed",
					startedAt,
					finishedAt: this.readNow(),
					usageTokens: workflowUsageTokens(totalUsage),
				},
				spentTokens: this.budget.spent(),
			});
			if (error instanceof WorkflowBudgetExceeded)
				this.track("workflow_budget_exceeded", {
					spent_tokens: error.spentTokens,
					requested_tokens: error.requestedTokens,
				});
			throw error;
		} finally {
			release?.();
			if (this.activeWriterId === agentId) this.activeWriterId = undefined;
		}
	}

	phase(title: string): void {
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
		const snapshot = await this.progress.update(patch);
		this.onProgress?.(snapshot);
	}

	private host(depth: number): WorkflowVmHost {
		return {
			agent: (prompt, options) => this.agent(prompt, options as WorkflowAgentOptions),
			phase: (title) => this.phase(title),
			log: (message) => this.log(message),
			iterate: (options) => this.iterate(options),
			nestedWorkflow: (name, args) => {
				if (depth >= 1) return Promise.reject(new Error("Nested workflow depth is limited to one level"));
				if (!this.nestedWorkflow) return Promise.reject(new Error(`Nested workflow "${name}" is not available`));
				return this.nestedWorkflow(name, args, this, depth);
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
	): Promise<void> {
		await this.journal.append({
			schemaVersion: 1,
			seq,
			callId: `${this.runId}-${seq + 1}`,
			callHash,
			prompt,
			options: workflowJsonValue(serializableOptions(options)),
			status: "failed",
			usage,
			attempt,
			createdAt: this.readNow(),
			error: error.slice(0, 2_000),
		});
	}

	private track(event: StepTelemetryKnownEventName, properties: Record<string, string | number | boolean>): void {
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

export function workflowToolResult<T>(value: T): AgentToolResult<T> {
	return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
}

export { WorkflowBudgetExceeded };
