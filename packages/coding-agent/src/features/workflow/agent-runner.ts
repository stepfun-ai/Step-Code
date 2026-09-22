import path from "node:path";
import type { ThinkingLevel } from "@step-harness/agent-core";
import { finalOutput, isFailed, resultText, runStepSubagentProcess } from "../step-subagent.ts";
import { discoverStepAgents, formatStepAgentCatalog, resolveStepAgent } from "../step-subagent-agents.ts";
import { WORKFLOW_SESSION_ID_PREFIX } from "../subagent/helpers.ts";
import { resolveWorkflowToolProfile } from "./tool-profile.ts";
import type { WorkflowAgentRunner, WorkflowAgentRunResult, WorkflowUsage } from "./types.ts";

export interface DefaultWorkflowAgentRunnerOptions {
	agentDir?: string;
	configDirName?: string;
	includeBuiltinAgents?: boolean;
}

/** Build the production runner on top of Step's existing rpc subagent path. */
export function createDefaultWorkflowAgentRunner(options: DefaultWorkflowAgentRunnerOptions = {}): WorkflowAgentRunner {
	return async (input) => {
		const discovery = await discoverStepAgents(input.cwd, {
			agentDir: options.agentDir,
			configDirName: options.configDirName,
			includeBuiltin: options.includeBuiltinAgents !== false,
			scope: "both",
		});
		const requestedName = input.options.agentType?.trim() || "general";
		const agent = resolveStepAgent(discovery.agents, requestedName);
		if (!agent) {
			throw new Error(
				`Unknown workflow agent "${requestedName}". Available: ${formatStepAgentCatalog(discovery.agents)}`,
			);
		}
		const tools =
			input.options.toolProfile === undefined ? agent.tools : resolveWorkflowToolProfile(input.options.toolProfile);
		const prompt = buildAgentPrompt(input.prompt, input.options.schema);
		const result = await runStepSubagentProcess({
			agent: {
				...agent,
				...(tools ? { tools } : {}),
			},
			task: prompt,
			cwd: path.resolve(input.cwd),
			model: input.options.model,
			thinkingLevel: thinkingLevel(input.options.effort),
			signal: input.signal,
			sessionId: `${WORKFLOW_SESSION_ID_PREFIX}${input.runId}-${input.agentId}`,
			keepAlive: false,
			workflowAcl: {
				baseCwd: input.cwd,
				...(input.options.readOnly ? { readOnly: input.options.readOnly } : {}),
				...(input.options.writable ? { writable: input.options.writable } : {}),
			},
		});
		const usage = usageFromSubagent(result.usage);
		if (isFailed(result)) {
			return {
				text: resultText(result),
				usage,
				status: result.stopReason === "aborted" ? "aborted" : "failed",
				errorMessage: result.errorMessage ?? result.stderr,
				...(result.model ? { model: result.model } : {}),
			};
		}
		const text = finalOutput(result.messages) || resultText(result);
		return {
			text,
			usage,
			status: "completed",
			...(result.model ? { model: result.model } : {}),
		};
	};
}

function buildAgentPrompt(prompt: string, schema: unknown): string {
	if (!schema || typeof schema !== "object") return prompt;
	let serialized: string;
	try {
		serialized = JSON.stringify(schema);
	} catch {
		return prompt;
	}
	return [
		prompt,
		"",
		"<workflow-structured-output>",
		"Return exactly one JSON value matching this JSON Schema. Do not wrap it in Markdown fences or add commentary.",
		serialized.slice(0, 32_000),
		"</workflow-structured-output>",
	].join("\n");
}

function thinkingLevel(value: string | undefined): ThinkingLevel | undefined {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "minimal" || normalized === "low" || normalized === "medium" || normalized === "high") {
		return normalized;
	}
	return undefined;
}

function usageFromSubagent(value: {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}): WorkflowUsage {
	return {
		input: finite(value.input),
		output: finite(value.output),
		cacheRead: finite(value.cacheRead),
		cacheWrite: finite(value.cacheWrite),
		cost: finite(value.cost),
		contextTokens: finite(value.contextTokens),
		turns: finite(value.turns),
	};
}

function finite(value: number): number {
	return Number.isFinite(value) && value > 0 ? value : 0;
}

export function normalizeWorkflowAgentValue(result: WorkflowAgentRunResult): unknown {
	if (result.value !== undefined) return result.value;
	const text = result.text?.trim() ?? "";
	if (!text) return "";
	const withoutFence = text
		.replace(/^```(?:json)?\s*/iu, "")
		.replace(/\s*```$/u, "")
		.trim();
	try {
		return JSON.parse(withoutFence);
	} catch {
		return result.text;
	}
}
