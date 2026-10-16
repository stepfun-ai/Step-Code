/** Shared, JSON-only contracts for the Step Workflow runtime. */

export type WorkflowJsonPrimitive = string | number | boolean | null;
export type WorkflowJsonValue = WorkflowJsonPrimitive | WorkflowJsonValue[] | { [key: string]: WorkflowJsonValue };

/** A deliberately small JSON-Schema surface. TypeBox schemas are compatible. */
export interface WorkflowJsonSchema {
	type?: string | string[];
	title?: string;
	description?: string;
	properties?: Record<string, WorkflowJsonSchema>;
	items?: WorkflowJsonSchema;
	required?: string[];
	additionalProperties?: boolean | WorkflowJsonSchema;
	enum?: WorkflowJsonValue[];
	const?: WorkflowJsonValue;
	anyOf?: WorkflowJsonSchema[];
	oneOf?: WorkflowJsonSchema[];
	allOf?: WorkflowJsonSchema[];
	not?: WorkflowJsonSchema;
	pattern?: string;
	minimum?: number;
	maximum?: number;
	minLength?: number;
	maxLength?: number;
	minItems?: number;
	maxItems?: number;
	[key: string]: unknown;
}

export interface WorkflowUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface WorkflowAgentOptions {
	label?: string;
	phase?: string;
	schema?: unknown;
	toolProfile?: string | string[];
	readOnly?: string[];
	writable?: string[];
	agentType?: string;
	model?: string;
	effort?: string;
	retries?: number;
}

export interface WorkflowAgentRunInput {
	onModelRequest?: (event: import("../../core/rate-limit.ts").ModelRequestProgress) => void;
	prompt: string;
	options: WorkflowAgentOptions;
	cwd: string;
	signal?: AbortSignal;
	/** Stable run/agent identifiers useful to injected runners and ACL hooks. */
	runId: string;
	agentId: string;
	/** Reports each tool the agent starts, before the tool runs. */
	onToolExecutionStart?: (toolName: string) => void;
}

export interface WorkflowAgentRunResult {
	/** Structured value when the runner already parsed one. */
	value?: unknown;
	/** Plain assistant text when no structured value was returned. */
	text?: string;
	usage?: Partial<WorkflowUsage>;
	status?: "completed" | "failed" | "aborted";
	errorMessage?: string;
	/** Structured provider failure class for a failed run; never inferred from text. */
	errorKind?: import("@step-harness/providers").ProviderErrorKind;
	model?: string;
	/** True when every tool start was reported through onToolExecutionStart. */
	toolActivityObserved?: boolean;
}

export type WorkflowAgentRunner = (input: WorkflowAgentRunInput) => Promise<WorkflowAgentRunResult>;

export interface WorkflowPhase {
	title: string;
	detail?: string;
}

export interface WorkflowMeta {
	name?: string;
	description?: string;
	phases?: WorkflowPhase[];
	roleSchemas?: Record<string, WorkflowJsonSchema>;
}

export interface WorkflowProgressAgent {
	error?: { code: string; message: string; retryable: boolean; retryExhausted?: boolean };
	rateLimitRetries?: number;
	retry?: { attempt: number; maxRetries: number; delayMs: number };
	id: string;
	label: string;
	/** Bounded summary of the assigned prompt, independent of an optional short label. */
	task?: string;
	phase?: string;
	status: "queued" | "running" | "completed" | "failed" | "aborted" | "cached";
	startedAt?: number;
	finishedAt?: number;
	usageTokens?: number;
}

export interface WorkflowProgress {
	taskFailures?: WorkflowTaskFailure[];
	schemaVersion: 1;
	runId: string;
	name: string;
	status: "running" | "stopping" | "completed" | "partial_failed" | "failed" | "aborted" | "budget_exceeded";
	concurrency?: { requested?: number; ceiling: number; limit: number; cap: number; sharedActive?: number };
	startedAt: number;
	updatedAt: number;
	currentPhase?: string;
	phaseIndex?: number;
	agents: WorkflowProgressAgent[];
	completedAgents: number;
	totalAgents: number;
	spentTokens: number;
	message?: string;
}

export interface WorkflowRunResult {
	schemaVersion: 1;
	runId: string;
	name: string;
	status: "completed" | "partial_failed" | "failed" | "aborted";
	summary?: { total: number; completed: number; failed: number; failedCallbacks?: number };
	/** Callback failures can happen before agent() is reached; they are not extra agent nodes. */
	taskFailures?: WorkflowTaskFailure[];
	/** Node execution includes model/tool/retry/shutdown time; not just tool-reported duration. */
	timing?: { runElapsedMs: number; maxNodeExecutionMs: number };
	failures?: WorkflowProgressAgent[];
	concurrency?: WorkflowProgress["concurrency"];
	value: unknown;
	meta: WorkflowMeta;
	/** Persisted copy of the executed script; edit and re-invoke with scriptPath to iterate. */
	scriptPath?: string;
	startedAt: number;
	finishedAt: number;
	spentTokens: number;
	cacheHits: number;
	agentCalls: number;
	phases: WorkflowPhase[];
	stopReason?: string;
}

export interface WorkflowTaskFailure {
	script?: string;
	primitive: "parallel" | "pipeline";
	index: number;
	stage?: number;
	message: string;
}

export interface IterateOptions {
	spec: string;
	maxIterations?: number;
	artifactPath?: string;
	evidencePath?: string;
	stopWhenSpecCoverage?: number;
	planner?: string;
	developer?: string;
	qa?: string;
	stagnationLimit?: number;
}

export interface IterateEvidence {
	iteration: number;
	plan: unknown;
	developer: unknown;
	evidence: unknown;
	specCoverage: number;
	coverageDelta: number;
	status: "completed" | "stopped";
	stopReason?: string;
	createdAt: number;
}

export interface IterateResult {
	iterations: number;
	status: "completed" | "stopped";
	stopReason: string;
	specCoverage: number;
	evidence: IterateEvidence[];
}

export interface WorkflowJournalEntry {
	schemaVersion: 1;
	seq: number;
	callId: string;
	callHash: string;
	prompt: string;
	options: WorkflowJsonValue;
	status: "completed" | "failed" | "aborted" | "cached";
	result?: unknown;
	usage: WorkflowUsage;
	attempt: number;
	/** Request-level 429 retries across this node's schema attempts. */
	rateLimitRetries?: number;
	createdAt: number;
	error?: string;
	/**
	 * Whether the call used any tool that reads or changes the workspace or the
	 * network. Absent when the runner did not report tool activity.
	 */
	worldAccess?: boolean;
}

export interface WorkflowTelemetryRecord {
	schemaVersion: 1;
	event: string;
	runId: string;
	createdAt: number;
	properties: Record<string, WorkflowJsonPrimitive>;
}

export function emptyWorkflowUsage(): WorkflowUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 0,
	};
}

export function workflowUsageTokens(usage: Partial<WorkflowUsage> | undefined): number {
	if (!usage) return 0;
	return nonNegative(usage.input) + nonNegative(usage.output);
}

function nonNegative(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function mergeWorkflowUsage(base: WorkflowUsage, addition: Partial<WorkflowUsage> | undefined): WorkflowUsage {
	if (!addition) return { ...base };
	return {
		input: base.input + nonNegative(addition.input),
		output: base.output + nonNegative(addition.output),
		cacheRead: base.cacheRead + nonNegative(addition.cacheRead),
		cacheWrite: base.cacheWrite + nonNegative(addition.cacheWrite),
		cost: base.cost + nonNegative(addition.cost),
		contextTokens: Math.max(base.contextTokens, nonNegative(addition.contextTokens)),
		turns: base.turns + nonNegative(addition.turns),
	};
}
