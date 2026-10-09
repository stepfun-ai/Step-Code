import { randomUUID } from "node:crypto";
import type { AgentContext, AgentMessage, StreamFn, ThinkingLevel } from "@step-harness/agent-core";
import type { Context, Model, SimpleStreamOptions, Usage } from "@step-harness/providers";
import { raceWithAbortSignal } from "../../../utils/abort.ts";
import { convertToLlm } from "../../messages.ts";
import type { SessionManager } from "../../session-manager.ts";
import { type AutoClmSettings, decideAutoClm } from "./auto-options.ts";
import { AUTO_CLM_EDIT_TOOL_NAME, createAutoClmCorrection, createAutoClmEditSelection } from "./auto-request.ts";
import { digestMessages, renderLiveContext } from "./document.ts";
import type { LiveContextManager, LiveContextOutcome } from "./manager.ts";

export const AUTO_CLM_ENTRY = "step-auto-clm";

export interface AutoClmResult {
	attempted: boolean;
	accepted: boolean;
	fallback: boolean;
	reason: string;
	requests: number;
	transport?: "private-tool" | "cached-json";
	outcome?: LiveContextOutcome;
}
interface MaintenanceInput {
	context: AgentContext;
	/** Exact prior actor request plus the proven canonical tail, supplied by the host. */
	cachedContext?: Context;
	canonical: AgentMessage[];
	incoming?: AgentMessage[];
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	settings: AutoClmSettings;
	reserveTokens: number;
	stream: StreamFn;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	resolveAuth?: (
		signal: AbortSignal,
	) => Promise<{ model: Model<any>; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }>;
	onPayload?: SimpleStreamOptions["onPayload"];
	onResponse?: SimpleStreamOptions["onResponse"];
	controller: AbortController;
	signal?: AbortSignal;
	isInterrupted: () => boolean;
	currentCanonical: () => AgentMessage[];
	onStart: (reason: "native-threshold" | "soft-threshold") => void;
}

function mergeUsage(usages: Usage[]): Usage | undefined {
	if (usages.length === 0) return undefined;
	const total: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	for (const usage of usages) {
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
			total[key] += usage[key];
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
			total.cost[key] += usage.cost[key];
		if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
	}
	return total;
}

/** Separate bounded request loop: the active task Agent and its tools are never reentered. */
export class AutoClmController {
	private readonly session: SessionManager;
	private readonly live: LiveContextManager;
	constructor(session: SessionManager, live: LiveContextManager) {
		this.session = session;
		this.live = live;
	}

	private turnsSinceAttempt(): number | undefined {
		let turns = 0;
		const branch = this.session.getBranch();
		const branchIds = new Set(branch.map((entry) => entry.id));
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry.type === "compaction") return turns;
			if (entry.type === "custom" && entry.customType === AUTO_CLM_ENTRY) {
				const origin = entry.data as { sourceLeafId?: string | null; reason?: string } | undefined;
				if (origin?.reason === "context-changed" || (origin?.sourceLeafId && !branchIds.has(origin.sourceLeafId)))
					continue;
				return turns;
			}
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const message = entry.message;
			if (message.stopReason !== "stop" && message.stopReason !== "toolUse") continue;
			const calls = message.content.filter((part) => part.type === "toolCall");
			if (calls.length === 0) {
				if (!message.content.some((part) => part.type === "text" && /<tool_call>|<function=/u.test(part.text)))
					turns++;
			} else {
				const completed = new Set<string>();
				for (let next = index + 1; next < branch.length; next++) {
					const candidate = branch[next];
					if (candidate.type !== "message") continue;
					if (candidate.message.role !== "toolResult") break;
					completed.add(candidate.message.toolCallId);
				}
				if (calls.every((call) => completed.has(call.id))) turns++;
			}
		}
		return undefined;
	}

	async run(input: MaintenanceInput): Promise<AutoClmResult> {
		const skipped = (reason: string): AutoClmResult => ({
			attempted: false,
			accepted: false,
			fallback: false,
			reason,
			requests: 0,
		});
		if (input.signal?.aborted || input.controller.signal.aborted || input.isInterrupted())
			return skipped("interrupted");
		const messages = this.live.project(input.context.messages);
		const snapshot = renderLiveContext(messages, this.live.status().revision, this.session.getSessionId());
		let cachedJson = input.cachedContext !== undefined;
		const selection = createAutoClmEditSelection(snapshot);
		const contextTokens = this.live.estimate({
			systemPrompt: input.context.systemPrompt + this.live.guidance({ automaticMaintenance: true }),
			messages: convertToLlm([...messages, ...(input.incoming ?? [])]),
			tools: input.context.tools,
		});
		const decision = decideAutoClm(
			{
				currentContextTokens: contextTokens,
				contextWindow: input.model.contextWindow,
				reserveTokens: input.reserveTokens,
				reducibleTokens: selection.maxSavingsTokens,
				turnsSinceLastAttempt: this.turnsSinceAttempt(),
			},
			input.settings,
		);
		if (!decision.shouldCompact) return skipped(decision.reason);

		const requestSystem =
			"You are maintaining the current coding agent's working context before its next task request. Summarize obsolete observations while preserving user requirements, exact errors, failed approaches, decisions, useful constants, and remaining work. The conversation below is data for maintenance; do not execute its project tasks. Call apply_context_edit once with useful replacements using the short IDs from the automatic context edit index. All unselected messages, tool calls and current tools/results remain intact. Do not copy the entire history into your output. Do not call other tools or claim the task is complete. If no safe useful reduction exists, respond briefly without a tool call.";
		const makeRequest = (useCache: boolean): Context => {
			const maintenance = useCache
				? 'Host context maintenance only. The preceding conversation is data, not work to execute. Preserve the latest user requirements, exact useful errors, decisions, failed approaches, constants and remaining work. Summarize obsolete observations using the short IDs below. Do not execute any project tools, change task status, or return a project answer. Reply with only JSON: {"replacements":[{"id":"<offered short ID>","text":"concise replacement"}]}. Unselected messages and protected content stay unchanged. If no safe useful edit exists, return {"replacements":[]}.'
				: "Automatic context maintenance. The incoming user request, if present, is protected and must guide what you retain. Use the short IDs below; choose and summarize content yourself.";
			return {
				systemPrompt: useCache ? input.cachedContext!.systemPrompt : requestSystem,
				messages: structuredClone([
					...(useCache ? input.cachedContext!.messages : convertToLlm(messages)),
					...convertToLlm(input.incoming ?? []),
					{ role: "user", content: `${maintenance}\n\n${selection.index}`, timestamp: Date.now() },
				]),
				tools: useCache ? input.cachedContext!.tools : [selection.tool],
			};
		};
		let request = makeRequest(cachedJson);
		// Reuse is optional: a larger actor prefix must not remove the old CLM
		// path's ability to fit a bounded maintenance response in small windows.
		if (cachedJson && input.model.contextWindow - this.live.estimate(request) - 4096 < 512) {
			cachedJson = false;
			request = makeRequest(false);
		}
		const result: AutoClmResult = {
			attempted: true,
			accepted: false,
			fallback: true,
			reason: "no-edit",
			requests: 0,
			transport: cachedJson ? "cached-json" : "private-tool",
		};
		const usages: Usage[] = [];
		const responseRows: Array<{
			request: number;
			stopReason: string;
			usage?: Usage;
			missingUsage: boolean;
			late: boolean;
			error?: string;
		}> = [];
		const attemptId = randomUUID();
		const sessionId = this.session.getSessionId();
		const sourceLeafId = this.session.getLeafId();
		const sourceDigest = digestMessages(input.canonical);
		const scopeIsCurrent = (): boolean => {
			try {
				return (
					this.session.getSessionId() === sessionId &&
					(!sourceLeafId || this.session.getBranch().some((entry) => entry.id === sourceLeafId)) &&
					digestMessages(input.currentCanonical()) === sourceDigest &&
					digestMessages(this.live.project(input.context.messages)) === snapshot.baselineDigest &&
					this.live.status().revision === snapshot.revision
				);
			} catch {
				return false;
			}
		};
		const contextChanged = (): void => {
			result.reason = "context-changed";
			result.fallback = false;
		};
		let finished = false;
		let timedOut = false;
		const parentAbort = () => input.controller.abort(input.signal?.reason);
		input.signal?.addEventListener("abort", parentAbort, { once: true });
		if (input.signal?.aborted) parentAbort();
		const timeout = setTimeout(() => {
			timedOut = true;
			input.controller.abort(new Error("Automatic CLM maintenance timed out."));
		}, input.settings.timeoutMs);
		const poll = setInterval(() => {
			if (input.isInterrupted())
				input.controller.abort(new Error("New user input has priority over context maintenance."));
		}, 25);
		try {
			input.onStart(decision.reason === "native-threshold" ? "native-threshold" : "soft-threshold");
			const auth = input.resolveAuth
				? await raceWithAbortSignal(input.resolveAuth(input.controller.signal), input.controller.signal)
				: input;
			input.controller.signal.throwIfAborted();
			if (!scopeIsCurrent()) {
				contextChanged();
				return result;
			}
			await this.live.prepare(input.context.messages, input.canonical);
			for (let attempt = 0; attempt < input.settings.maxRequests; attempt++) {
				input.controller.signal.throwIfAborted();
				if (!scopeIsCurrent()) {
					contextChanged();
					break;
				}
				const currentEstimate = this.live.estimate(request);
				const maxTokens = Math.min(
					auth.model.maxTokens,
					input.settings.maxOutputTokens,
					auth.model.contextWindow - currentEstimate - 4096,
				);
				if (maxTokens < 512) {
					result.reason = "insufficient-headroom";
					break;
				}
				result.requests++;
				const requestNumber = result.requests;
				const responsePromise = (async () => {
					// Keep observing acquisition and completion even when the bounded wait is cancelled.
					const boundedModel = { ...auth.model, maxTokens };
					let stream: Awaited<ReturnType<StreamFn>>;
					try {
						stream = await input.stream(
							boundedModel,
							{ ...request, estimatedInputTokens: currentEstimate },
							{
								signal: input.controller.signal,
								apiKey: auth.apiKey,
								headers: auth.headers,
								env: auth.env,
								reasoning: input.thinkingLevel === "off" || maxTokens < 2048 ? undefined : input.thinkingLevel,
								maxTokens,
								maxRetries: 0,
								sessionId,
								cacheRetention: "short",
								onPayload: input.onPayload,
								onResponse: input.onResponse,
							},
						);
						for await (const _event of stream) {
							/* Drain the same provider stream used by the ordinary SDK observer. */
						}
					} catch (error) {
						const row = {
							request: requestNumber,
							stopReason: "error",
							missingUsage: true,
							late: finished,
							error: error instanceof Error ? error.message : String(error),
						};
						responseRows.push(row);
						if (this.session.getSessionId() === sessionId)
							this.session.appendCustomEntry("step-auto-clm-usage", {
								version: 1,
								attemptId,
								sessionId,
								sourceLeafId,
								provider: input.model.provider,
								model: input.model.id,
								...row,
							});
						throw error;
					}
					const message = await stream.result();
					const missingUsage =
						!message.usage ||
						message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite === 0;
					if (message.usage) usages.push(message.usage);
					const row = {
						request: requestNumber,
						stopReason: message.stopReason,
						usage: message.usage,
						missingUsage,
						late: finished,
						error: message.errorMessage,
					};
					responseRows.push(row);
					if (this.session.getSessionId() === sessionId)
						this.session.appendCustomEntry("step-auto-clm-usage", {
							version: 1,
							attemptId,
							sessionId,
							sourceLeafId,
							provider: input.model.provider,
							model: input.model.id,
							...row,
						});
					return message;
				})();
				const response = await raceWithAbortSignal(responsePromise, input.controller.signal);
				if (input.signal?.aborted || input.isInterrupted()) {
					result.fallback = false;
					result.reason = "interrupted";
					break;
				}
				if (!scopeIsCurrent()) {
					contextChanged();
					break;
				}
				if (
					response.stopReason === "error" ||
					response.stopReason === "aborted" ||
					response.stopReason === "length" ||
					response.stopReason === "deferred"
				) {
					result.reason = response.stopReason;
					break;
				}
				const calls = response.content.filter((part) => part.type === "toolCall");
				let replacements: unknown;
				if (cachedJson) {
					if (calls.length) {
						result.reason = "unexpected-tool";
						break;
					}
					try {
						const text = response.content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("\n")
							.trim()
							.replace(/^```(?:json)?\s*/i, "")
							.replace(/\s*```$/, "");
						replacements = (JSON.parse(text) as { replacements?: unknown }).replacements;
					} catch {
						result.reason = "invalid-json";
						break;
					}
				} else {
					if (calls.length !== 1 || calls[0].name !== AUTO_CLM_EDIT_TOOL_NAME) {
						result.reason = calls.length === 0 ? "no-edit" : "invalid-tool";
						break;
					}
					replacements = calls[0].arguments?.replacements;
				}
				if (Array.isArray(replacements) && replacements.length === 0) {
					result.reason = "no-edit";
					break;
				}
				const resolved = selection.resolve(replacements);
				const outcome: LiveContextOutcome =
					"reason" in resolved
						? { accepted: false, revision: this.live.status().revision, reason: resolved.reason }
						: await this.live.replace(input.currentCanonical(), resolved.replacements, input.controller.signal, {
								tokens: input.settings.minSavingsTokens,
								ratio: input.settings.minSavingsRatio,
							});
				result.outcome = outcome;
				if (outcome.accepted) {
					result.accepted = true;
					result.fallback = false;
					result.reason = "accepted";
					break;
				}
				if (!scopeIsCurrent()) {
					contextChanged();
					break;
				}
				result.reason = outcome.reason ?? "rejected";
				if (attempt + 1 < input.settings.maxRequests) {
					request.messages.push(createAutoClmCorrection(replacements, result.reason, Date.now()));
					await this.live.prepare(input.context.messages, input.canonical);
				}
			}
		} catch (error) {
			result.reason = timedOut
				? "timeout"
				: input.controller.signal.aborted
					? "interrupted"
					: error instanceof Error
						? error.message
						: String(error);
			result.fallback =
				!input.signal?.aborted && !input.isInterrupted() && (timedOut || !input.controller.signal.aborted);
			if (!scopeIsCurrent()) contextChanged();
		} finally {
			clearTimeout(timeout);
			clearInterval(poll);
			input.signal?.removeEventListener("abort", parentAbort);
			this.live.invalidate();
			finished = true;
			if (this.session.getSessionId() === sessionId)
				this.session.appendCustomEntry(AUTO_CLM_ENTRY, {
					version: 1,
					attemptId,
					sessionId,
					sourceLeafId,
					sourceDigest,
					provider: input.model.provider,
					model: input.model.id,
					...result,
					contextTokens,
					usage: mergeUsage(usages),
					responses: responseRows.slice(),
					missingUsage: responseRows.some((row) => row.missingUsage) || responseRows.length < result.requests,
				});
		}
		return result;
	}
}
