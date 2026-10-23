import type { AssistantMessage, Context, Model, RetryPolicy, SimpleStreamOptions } from "@step-harness/providers";
import { redactSecretString } from "../../step/secret-redaction.ts";

export interface SummaryRequestDiagnostics {
	stage?: string;
	provider: string;
	model: string;
	api: string;
	contextWindow: number;
	modelMaxTokens: number;
	selectedMaxTokens?: number;
	observedMaxTokens?: number;
	inputTokensEstimated: number;
	reasoning: string;
	attempts: number;
	durationMs: number;
	stopReason?: string;
	errorKind?: string;
	rawStopReason?: string;
	usage?: AssistantMessage["usage"];
}

const responses = new WeakMap<AssistantMessage, SummaryRequestDiagnostics>();

/** Capture only numeric budget fields, never the prompt, headers, or credentials. */
export function observeSummaryPayload(payload: unknown): number | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const record = payload as Record<string, unknown>;
	for (const key of ["max_output_tokens", "max_tokens", "max_completion_tokens"]) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	}
	return undefined;
}

export function createSummaryDiagnostics(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions,
): SummaryRequestDiagnostics {
	return {
		provider: redactSecretString(model.provider),
		model: redactSecretString(model.id),
		api: model.api,
		contextWindow: model.contextWindow,
		modelMaxTokens: model.maxTokens,
		selectedMaxTokens: options.maxTokens,
		inputTokensEstimated: Math.ceil(JSON.stringify(context).length / 4),
		reasoning: options.reasoning ?? "off",
		attempts: 0,
		durationMs: 0,
	};
}

export function saveSummaryDiagnostics(response: AssistantMessage, diagnostics: SummaryRequestDiagnostics): void {
	responses.set(response, diagnostics);
}

export function getSummaryDiagnostics(response: AssistantMessage): SummaryRequestDiagnostics | undefined {
	return responses.get(response);
}

export class SummaryFailure extends Error {
	readonly diagnostics: SummaryRequestDiagnostics;

	constructor(message: string, diagnostics: SummaryRequestDiagnostics) {
		super(redactSecretString(message));
		this.name = "SummaryFailure";
		this.diagnostics = diagnostics;
	}
}

export function summaryFailure(message: string, response: AssistantMessage): Error {
	const diagnostics = responses.get(response);
	return diagnostics ? new SummaryFailure(message, diagnostics) : new Error(redactSecretString(message));
}

export function formatSummaryDiagnostics(d: SummaryRequestDiagnostics): string {
	return `Summary request: stage=${d.stage ?? "unknown"}, provider=${d.provider}, model=${d.model}, api=${d.api}; contextWindow=${d.contextWindow}, model.maxTokens=${d.modelMaxTokens}, selectedMaxTokens=${d.selectedMaxTokens ?? "unknown"}, observedPayloadMaxTokens=${d.observedMaxTokens ?? "unknown"}, inputTokensEstimated=${d.inputTokensEstimated}, reasoning=${d.reasoning}; attempts=${d.attempts}, durationMs=${d.durationMs}, stopReason=${d.stopReason ?? "unknown"}, errorKind=${d.errorKind ?? "unknown"}.`;
}

export function formatRetryPolicy(retry: RetryPolicy): string {
	return `retry.enabled=${retry.enabled}, retry.maxRetries=${retry.maxRetries}, retry.baseDelayMs=${retry.baseDelayMs}`;
}
