/**
 * A content-free summary of the session a feedback report is about.
 *
 * The transcript itself is attached separately. This summary answers "in what
 * state was the session when it went wrong" without a single character of user
 * content: which model and effort were in use, how many turns and tool calls
 * had run, which ones failed, what was spent, and which Step features were
 * active. Investigations start here, then read the transcript only for the
 * turn that matters.
 *
 * Derived from the persisted session entries, so the CLI (a file on disk), the
 * TUI and a host holding the branch in memory all produce the same values.
 */

import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { createInterface } from "node:readline";
import type { Usage } from "@step-harness/providers";
import type { SessionEntry } from "../../core/session-manager.ts";
import { redactSecretString } from "../secret-redaction.ts";
import { collapseHomePaths } from "./redact-home.ts";

/** How many failed calls keep their identity in the summary. */
const RECENT_ERROR_LIMIT = 10;
/** How many tool calls of the latest turn are kept; enough to see the shape of a run. */
const LAST_TURN_TOOL_LIMIT = 50;
/** How many compactions keep their before/after sizes. */
const COMPACTION_LIMIT = 20;
/** Guard against a pathological file: the summary never needs more lines than this. */
const MAX_SCANNED_LINES = 200_000;

export interface FeedbackRequestProvenance {
	/** Correlates this report with the model request in server-side logs. */
	requestId: string;
	provider?: string;
	model?: string;
	/** API dialect, which selects the adapter and its compat switches. */
	api?: string;
	reasoning?: string;
	sourceLeafId?: string | null;
	/** Catalog limits at dispatch. */
	contextWindow?: number;
	maxTokens?: number;
	/** Who answered, when auth or a proxy redirected the request. */
	responseProvider?: string;
	responseModel?: string;
	statusCode?: number;
	durationMs?: number;
	/** Absent means the stream produced no event before it settled. */
	ttftMs?: number | null;
	outcome?: "ok" | "http_error" | "transport_error";
}

export interface FeedbackSessionError {
	/**
	 * `tool` is a failed tool call, `model` a failed attempt the user did not
	 * stop, `aborted` an attempt the user (or the host) stopped. The last kind is
	 * how "it hung, so I cancelled" reaches a report.
	 */
	kind: "tool" | "model" | "aborted";
	toolName?: string;
	stopReason?: string;
	/** Structured provider failure class: rate_limit, quota, auth, transient, invalid_request. */
	errorKind?: string;
	/**
	 * The provider's own text, which for an HTTP failure carries the status and
	 * the response body. Bounded and secret-redacted; this is what names a
	 * rejected request ("concurrency reached, current: 11, limit: 10").
	 */
	message?: string;
	/** How long the attempt ran before it settled. */
	durationMs?: number;
	/** Time to the first stream event; absent means nothing ever arrived. */
	ttftMs?: number | null;
	/** How far it got: `thinking` means it was cancelled before any output. */
	reached?: "thinking" | "text" | "toolCall";
	/** Which side of the wire failed; a user stop is a transport outcome. */
	outcome?: "ok" | "http_error" | "transport_error";
	at?: string;
}

/**
 * One compaction, before and after.
 *
 * A long session compacts repeatedly; each row is one pass. `tokensAfter` is the
 * input size of the first request that followed, so a compaction that failed to
 * shrink the window shows up as a row whose two numbers are close. `unresolved`
 * marks the newest pass when no request followed it yet.
 */
export interface FeedbackCompaction {
	tokensBefore: number;
	tokensAfter?: number;
	at?: string;
	unresolved?: boolean;
}

/** Facts only a live host knows: the session file records none of them. */
export interface FeedbackRuntimeFacts {
	/** ask | approve-for-me | full-access. */
	permissionPreset?: string;
	/** Context tokens the host currently counts (may differ from the last request). */
	contextUsed?: number | null;
	contextWindow?: number;
	toolCount?: number;
	skillCount?: number;
	/** Configured MCP server names; identifiers only, never URLs or headers. */
	mcpServerNames?: string[];
}

export interface FeedbackSessionSummary {
	model?: { provider: string; id: string; api?: string };
	thinkingLevel?: string;
	/** Home directory collapsed to `~`; absent when the session header had none. */
	cwd?: string;
	counts: {
		turns: number;
		assistantMessages: number;
		toolCalls: number;
		toolErrors: number;
		failedAttempts: number;
		/** Attempts the user stopped, not failures of their own. */
		abortedAttempts: number;
		/** Attempts that hit the model's output limit (`stopReason: "length"`). */
		truncatedAttempts: number;
		/** Model requests recorded on the branch (`step.usage_provenance`). */
		modelRequests: number;
		compactions: number;
		customEntries: number;
	};
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		reasoning: number;
		total: number;
		/** Provider-reported cost, when the catalog has pricing for the model. */
		costUsd?: number;
		/** cacheRead / (input + cacheRead): a low rate explains slow or costly turns. */
		cacheHitRate?: number;
	};
	/**
	 * Before and after each compaction, oldest first, bounded to the last 20.
	 * `compactionTotals` summarises every pass, including ones dropped from the
	 * array, so a long session is still readable at a glance.
	 */
	compactions: FeedbackCompaction[];
	/**
	 * Every pass is counted in `passes`; the three size sums cover only passes a
	 * request followed, so `tokensBefore - tokensAfter === reclaimed` always holds.
	 * A pass still waiting on a request has no "after" and is excluded.
	 */
	compactionTotals?: {
		passes: number;
		resolved: number;
		tokensBefore: number;
		tokensAfter: number;
		reclaimed: number;
	};
	/** Host-supplied state the session file does not carry (permission tier, live context size). */
	runtime?: FeedbackRuntimeFacts;
	/** Thinking time the host observed, when it recorded any. */
	thinkingMs?: number;
	recentErrors: FeedbackSessionError[];
	/** The most recent turn's tool calls, in call order; names and outcomes only. */
	lastTurnTools: { name: string; isError: boolean }[];
	features: {
		planMode?: boolean;
		planSource?: string;
		goal?: string;
		tasks?: { completed: number; total: number };
	};
	/** The newest model request recorded on the branch, for server-side correlation. */
	request?: FeedbackRequestProvenance;
	/** The scan stopped at the line cap; counts cover only the newest lines and may be partial. */
	truncated?: boolean;
}

/** `home` is what `cwd` is collapsed against; tests and sandboxed hosts override it. */
export interface FeedbackSummaryOptions {
	readonly home?: string;
	/** Live host state the session file cannot provide. */
	readonly runtime?: FeedbackRuntimeFacts;
}

/**
 * Summarize the session **branch** the file ends on.
 *
 * Session files are append-only trees: navigating back, undoing, or forking
 * leaves abandoned entries in the same file, and a fork copies provenance
 * entries in. Counting every line would include turns the user rewound, pair a
 * compaction with a request from another branch, and report a `requestId` from
 * a branch nobody is looking at. So the last entry is followed back through
 * `parentId` to the root, and only that chain is summarized.
 */
export async function summarizeSessionFile(
	sessionFile: string,
	options: FeedbackSummaryOptions = {},
): Promise<FeedbackSessionSummary | undefined> {
	const stats = await fs.stat(sessionFile).catch(() => undefined);
	if (!stats?.isFile() || stats.size === 0) return undefined;
	const entries: (Record<string, unknown> | undefined)[] = [];
	let truncated = false;
	const lines = createInterface({
		input: createReadStream(sessionFile, "utf8"),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	try {
		for await (const line of lines) {
			entries.push(parseRecord(parseLine(line)));
			// A pathological file keeps its newest lines: the request and the error
			// a report is about are at the end, not the beginning. Evict in chunks;
			// one shift per line is quadratic on a file that is already too big.
			if (entries.length > MAX_SCANNED_LINES * 2) {
				entries.splice(0, MAX_SCANNED_LINES);
				truncated = true;
			}
		}
	} finally {
		lines.close();
	}
	const summary = createSummary(options);
	if (truncated) {
		// The branch cannot be walked across a gap, and the newest lines are the
		// ones a report needs, so keep the tail and say the counts are partial.
		summary.truncated = true;
		for (const entry of entries) summary.accept(entry);
		return summary.finish();
	}
	for (const entry of branchOf(entries)) summary.accept(entry);
	return summary.finish();
}

/** The chain the file ends on, oldest first. */
function branchOf(entries: readonly (Record<string, unknown> | undefined)[]): Record<string, unknown>[] {
	const byId = new Map<string, Record<string, unknown>>();
	for (const entry of entries) {
		if (entry && typeof entry.id === "string") byId.set(entry.id, entry);
	}
	// A trailing blank line or a crash-truncated final record leaves `undefined`
	// at the end; the leaf is the last entry that actually parsed.
	let endIndex = entries.length - 1;
	while (endIndex >= 0 && entries[endIndex] === undefined) endIndex -= 1;
	const last = endIndex >= 0 ? entries[endIndex] : undefined;
	if (!last) return [];
	const chain: Record<string, unknown>[] = [];
	const seen = new Set<string>();
	let current: Record<string, unknown> | undefined = last;
	while (current) {
		const id = typeof current.id === "string" ? current.id : undefined;
		if (id && seen.has(id)) break;
		if (id) seen.add(id);
		chain.push(current);
		const parent: unknown = current.parentId;
		current = typeof parent === "string" ? byId.get(parent) : undefined;
	}
	// A file with no `parentId` links (older format, or a single entry) is its
	// own branch; keep file order rather than inventing a chain.
	return chain.length <= 1 && entries.length > 1 ? entries.filter(isRecord) : chain.reverse();
}

function isRecord(value: Record<string, unknown> | undefined): value is Record<string, unknown> {
	return value !== undefined;
}

function parseRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Summarize entries a host already holds in memory (the same values as the file). */
export function summarizeSessionEntries(
	entries: readonly SessionEntry[],
	options: FeedbackSummaryOptions = {},
): FeedbackSessionSummary {
	const summary = createSummary(options);
	for (const entry of entries) summary.accept(entry);
	return summary.finish();
}

function parseLine(line: string): unknown {
	if (line.trim().length === 0) return undefined;
	try {
		return JSON.parse(line);
	} catch {
		// One unreadable line is not a reason to lose every count around it.
		return undefined;
	}
}

function createSummary(options: FeedbackSummaryOptions): {
	accept(entry: unknown): void;
	finish(): FeedbackSessionSummary;
	truncated: boolean;
} {
	const counts = {
		turns: 0,
		assistantMessages: 0,
		toolCalls: 0,
		toolErrors: 0,
		failedAttempts: 0,
		abortedAttempts: 0,
		truncatedAttempts: 0,
		modelRequests: 0,
		compactions: 0,
		customEntries: 0,
	};
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
	let costUsd: number | undefined;
	const compactions: FeedbackCompaction[] = [];
	/**
	 * Compactions still waiting for the next request's input size. The list, not
	 * a single slot, so back-to-back passes all resolve instead of the earlier
	 * ones silently staying unresolved.
	 */
	let unresolved: FeedbackCompaction[] = [];
	const compactionTotals = { passes: 0, resolved: 0, tokensBefore: 0, tokensAfter: 0, reclaimed: 0 };
	const state: {
		model?: FeedbackSessionSummary["model"];
		thinkingLevel?: string;
		cwd?: string;
		thinkingMs?: number;
		planMode?: boolean;
		planSource?: string;
		goal?: string;
		tasks?: { completed: number; total: number };
		request?: FeedbackRequestProvenance;
		truncated: boolean;
	} = { truncated: false };
	const recentErrors: FeedbackSessionError[] = [];
	/**
	 * Failed or cancelled attempts by session entry id. The timing lives in the
	 * `step.usage_provenance` entry that follows the message, so the two are
	 * joined here rather than left as a count.
	 */
	const attemptsByEntry = new Map<string, { error: FeedbackSessionError; at?: string }>();
	/** One row per call in the latest turn; a result resolves the row it belongs to. */
	const lastTurnTools: { id?: string; name: string; isError: boolean }[] = [];
	const callRows = new Map<string, number>();

	const pushError = (error: FeedbackSessionError, entryId?: string): void => {
		recentErrors.push(error);
		if (recentErrors.length > RECENT_ERROR_LIMIT) recentErrors.shift();
		if (entryId) attemptsByEntry.set(entryId, { error });
	};

	const pushCall = (id: string | undefined, name: string): void => {
		if (id) callRows.set(id, lastTurnTools.length);
		lastTurnTools.push({ ...(id ? { id } : {}), name, isError: false });
	};

	const resolveCall = (id: string | undefined, name: string, isError: boolean): void => {
		const row = id ? callRows.get(id) : undefined;
		if (row === undefined) {
			lastTurnTools.push({ ...(id ? { id } : {}), name, isError });
			return;
		}
		lastTurnTools[row] = { ...lastTurnTools[row], isError };
	};

	const acceptCustom = (record: Record<string, unknown>): void => {
		const data = record.data;
		if (!data || typeof data !== "object") return;
		const payload = data as Record<string, unknown>;
		switch (record.customType) {
			case "step-plan":
				if (typeof payload.enabled === "boolean") state.planMode = payload.enabled;
				if (typeof payload.planSource === "string") state.planSource = payload.planSource;
				return;
			case "step-goal":
				if (typeof payload.status === "string") state.goal = payload.status;
				return;
			case "step-tasks": {
				const list = Array.isArray(payload.tasks) ? payload.tasks : [];
				let total = 0;
				let completed = 0;
				for (const task of list) {
					const status = (task as { status?: unknown } | undefined)?.status;
					if (status === "deleted") continue;
					total += 1;
					if (status === "completed") completed += 1;
				}
				if (total > 0) state.tasks = { completed, total };
				return;
			}
			case "step.usage_provenance": {
				const requestId = payload.requestId;
				if (typeof requestId !== "string" || !requestId) return;
				counts.modelRequests += 1;
				// The timing of the attempt this provenance belongs to.
				const attempt =
					typeof payload.usageEntryId === "string" ? attemptsByEntry.get(payload.usageEntryId) : undefined;
				if (attempt) {
					if (typeof payload.durationMs === "number" && Number.isFinite(payload.durationMs)) {
						attempt.error.durationMs = payload.durationMs;
					}
					if (payload.ttftMs === null || typeof payload.ttftMs === "number") {
						attempt.error.ttftMs = payload.ttftMs;
					}
					const outcome = readOutcome(payload.outcome);
					if (outcome) attempt.error.outcome = outcome;
				}
				state.request = {
					requestId,
					...(typeof payload.requestedProvider === "string" ? { provider: payload.requestedProvider } : {}),
					...(typeof payload.requestedModel === "string" ? { model: payload.requestedModel } : {}),
					...(typeof payload.api === "string" ? { api: payload.api } : {}),
					...(typeof payload.reasoningAtDispatch === "string" ? { reasoning: payload.reasoningAtDispatch } : {}),
					...(typeof payload.sourceLeafId === "string" ? { sourceLeafId: payload.sourceLeafId } : {}),
					...(isPositiveNumber(payload.contextWindow) ? { contextWindow: payload.contextWindow } : {}),
					...(isPositiveNumber(payload.maxTokens) ? { maxTokens: payload.maxTokens } : {}),
					...(typeof payload.responseProvider === "string" ? { responseProvider: payload.responseProvider } : {}),
					...(typeof payload.responseModel === "string" ? { responseModel: payload.responseModel } : {}),
					...(isPositiveNumber(payload.statusCode) ? { statusCode: payload.statusCode } : {}),
					...(isPositiveNumber(payload.durationMs) ? { durationMs: payload.durationMs } : {}),
					...(payload.ttftMs === null || isPositiveNumber(payload.ttftMs) ? { ttftMs: payload.ttftMs } : {}),
					...(readOutcome(payload.outcome) ? { outcome: readOutcome(payload.outcome) } : {}),
				};
				return;
			}
			case "stepcode-web.thinking-timing": {
				const timings = payload.thinkingTimings;
				if (!timings || typeof timings !== "object") return;
				for (const timing of Object.values(timings as Record<string, unknown>)) {
					const value = timing as { startedAt?: unknown; endedAt?: unknown } | null;
					if (typeof value?.startedAt !== "number" || typeof value.endedAt !== "number") continue;
					const elapsed = value.endedAt - value.startedAt;
					if (elapsed > 0) state.thinkingMs = (state.thinkingMs ?? 0) + elapsed;
				}
				return;
			}
			default:
				return;
		}
	};

	const addUsage = (value: unknown): void => {
		if (!value || typeof value !== "object") return;
		const record = value as Partial<Usage> & Record<string, unknown>;
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning"] as const) {
			const amount = record[key];
			if (typeof amount === "number" && Number.isFinite(amount)) usage[key] += amount;
		}
		const total = record.totalTokens ?? record.total;
		if (typeof total === "number" && Number.isFinite(total)) usage.total += total;
		const cost = record.cost as { total?: unknown } | undefined;
		if (typeof cost?.total === "number" && Number.isFinite(cost.total)) {
			costUsd = (costUsd ?? 0) + cost.total;
		}
		// The first request after a compaction reports the context that is left.
		if (unresolved.length > 0 && typeof record.input === "number" && Number.isFinite(record.input)) {
			const cacheRead = typeof record.cacheRead === "number" ? record.cacheRead : 0;
			for (const pass of unresolved) {
				pass.tokensAfter = record.input + cacheRead;
				compactionTotals.resolved += 1;
				compactionTotals.tokensBefore += pass.tokensBefore;
				compactionTotals.tokensAfter += pass.tokensAfter;
				compactionTotals.reclaimed += pass.tokensBefore - pass.tokensAfter;
			}
			unresolved = [];
		}
	};

	const acceptAssistant = (record: Record<string, unknown>, entryId?: string): void => {
		counts.assistantMessages += 1;
		const provider = record.provider;
		const id = record.model;
		if (typeof provider === "string" && typeof id === "string") {
			state.model = { provider, id, ...(typeof record.api === "string" ? { api: record.api } : {}) };
		}
		addUsage(record.usage);
		if (record.stopReason === "aborted") {
			counts.abortedAttempts += 1;
			pushError({ ...attemptTiming(record), kind: "aborted", stopReason: "aborted" }, entryId);
		}
		if (record.stopReason === "length") counts.truncatedAttempts += 1;
		if (record.stopReason === "error") {
			counts.failedAttempts += 1;
			const message = record.errorMessage;
			pushError(
				{
					kind: "model",
					stopReason: "error",
					...attemptTiming(record),
					...(typeof record.errorKind === "string" ? { errorKind: record.errorKind } : {}),
					// The provider's own text: for an HTTP failure it carries the status
					// and the rejected-request body, which is the whole diagnosis.
					...(typeof message === "string" && message.trim()
						? { message: boundErrorText(collapseHomePaths(redactSecretString(message), options.home)) }
						: {}),
				},
				entryId,
			);
		}
		const content = record.content;
		if (!Array.isArray(content)) return;
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			const block = part as Record<string, unknown>;
			if (block.type !== "toolCall") continue;
			counts.toolCalls += 1;
			if (typeof block.name === "string") {
				pushCall(typeof block.id === "string" ? block.id : undefined, block.name);
			}
		}
	};

	const acceptMessage = (message: unknown, entryId?: string): void => {
		if (!message || typeof message !== "object") return;
		const record = message as Record<string, unknown>;
		if (record.role === "user") {
			counts.turns += 1;
			lastTurnTools.length = 0;
			callRows.clear();
			return;
		}
		if (record.role === "toolResult") {
			const isError = record.isError === true;
			const toolName = typeof record.toolName === "string" ? record.toolName : undefined;
			resolveCall(
				typeof record.toolCallId === "string" ? record.toolCallId : undefined,
				toolName ?? "unknown",
				isError,
			);
			if (!isError) return;
			counts.toolErrors += 1;
			pushError({
				kind: "tool",
				...(toolName ? { toolName } : {}),
				...(typeof record.timestamp === "number" ? { at: new Date(record.timestamp).toISOString() } : {}),
			});
			return;
		}
		if (record.role === "assistant") acceptAssistant(record, entryId);
	};

	return {
		get truncated(): boolean {
			return state.truncated;
		},
		set truncated(value: boolean) {
			state.truncated = value;
		},
		accept(entry: unknown): void {
			if (!entry || typeof entry !== "object") return;
			const record = entry as Record<string, unknown>;
			switch (record.type) {
				case "session":
					if (typeof record.cwd === "string" && record.cwd) {
						state.cwd = collapseHomePaths(record.cwd, options.home);
					}
					return;
				case "model_change":
					if (typeof record.provider === "string" && typeof record.modelId === "string") {
						state.model = { provider: record.provider, id: record.modelId };
					}
					return;
				case "thinking_level_change":
					if (typeof record.thinkingLevel === "string") state.thinkingLevel = record.thinkingLevel;
					return;
				case "compaction": {
					counts.compactions += 1;
					if (typeof record.tokensBefore === "number" && Number.isFinite(record.tokensBefore)) {
						const entry: FeedbackCompaction = {
							tokensBefore: record.tokensBefore,
							...(typeof record.timestamp === "string" ? { at: record.timestamp } : {}),
						};
						compactions.push(entry);
						if (compactions.length > COMPACTION_LIMIT) compactions.shift();
						unresolved.push(entry);
						compactionTotals.passes += 1;
					}
					return;
				}
				case "custom":
					counts.customEntries += 1;
					acceptCustom(record);
					return;
				case "message":
					acceptMessage(record.message, typeof record.id === "string" ? record.id : undefined);
					return;
				default:
					return;
			}
		},
		finish(): FeedbackSessionSummary {
			// A pass no request followed yet has no "after": say so rather than
			// leaving a reader to guess whether it shrank.
			for (const pass of unresolved) pass.unresolved = true;
			const cacheable = usage.input + usage.cacheRead;
			const runtime = options.runtime;
			const contextWindow = runtime?.contextWindow ?? state.request?.contextWindow;
			const model = state.model ?? requestModelOf(state.request);
			// An empty object reads as "the host supplied nothing to say" and is only
			// noise in a report.
			const facts = runtime ? runtimeFacts(runtime, contextWindow) : undefined;
			return {
				...(model ? { model } : {}),
				...(state.thinkingLevel ? { thinkingLevel: state.thinkingLevel } : {}),
				...(state.cwd ? { cwd: state.cwd } : {}),
				counts,
				usage: {
					...usage,
					...(costUsd !== undefined ? { costUsd } : {}),
					...(cacheable > 0 ? { cacheHitRate: usage.cacheRead / cacheable } : {}),
				},
				compactions,
				...(compactionTotals.passes > 0 ? { compactionTotals: { ...compactionTotals } } : {}),
				...(facts && Object.keys(facts).length > 0 ? { runtime: facts } : {}),
				...(state.thinkingMs && state.thinkingMs > 0 ? { thinkingMs: state.thinkingMs } : {}),
				recentErrors,
				lastTurnTools: lastTurnTools.slice(-LAST_TURN_TOOL_LIMIT).map(({ name, isError }) => ({ name, isError })),
				features: {
					...(state.planMode === undefined ? {} : { planMode: state.planMode }),
					...(state.planSource ? { planSource: state.planSource } : {}),
					...(state.goal ? { goal: state.goal } : {}),
					...(state.tasks ? { tasks: state.tasks } : {}),
				},
				...(state.request ? { request: state.request } : {}),
				...(state.truncated ? { truncated: true } : {}),
			};
		},
	};
}

function isPositiveNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** `model` may only carry provider/id/api; the window comes from the request or the host. */
function requestModelOf(request: FeedbackRequestProvenance | undefined): FeedbackSessionSummary["model"] | undefined {
	if (!request?.provider || !request.model) return undefined;
	return {
		provider: request.provider,
		id: request.model,
		...(request.api ? { api: request.api } : {}),
	};
}

function runtimeFacts(facts: FeedbackRuntimeFacts, contextWindow: number | undefined): FeedbackRuntimeFacts {
	const window = facts.contextWindow ?? contextWindow;
	const used = facts.contextUsed;
	return {
		...(facts.permissionPreset ? { permissionPreset: facts.permissionPreset } : {}),
		...(typeof used === "number" && Number.isFinite(used) ? { contextUsed: used } : {}),
		...(window && window > 0 ? { contextWindow: window } : {}),
		...(facts.toolCount !== undefined ? { toolCount: facts.toolCount } : {}),
		...(facts.skillCount !== undefined ? { skillCount: facts.skillCount } : {}),
		...(facts.mcpServerNames?.length ? { mcpServerNames: facts.mcpServerNames.slice(0, 32) } : {}),
	};
}

/**
 * What a settled message itself records: when it settled and how far it got.
 * Duration and time-to-first-token are not on the message — they are written to
 * the `step.usage_provenance` entry that follows and joined by entry id.
 */
function attemptTiming(record: Record<string, unknown>): Pick<FeedbackSessionError, "at" | "reached"> {
	return {
		...(typeof record.timestamp === "number" ? { at: new Date(record.timestamp).toISOString() } : {}),
		...reachedOf(record),
	};
}

/** The furthest block kind the attempt produced, when the message still has it. */
function reachedOf(record: Record<string, unknown>): Pick<FeedbackSessionError, "reached"> {
	const content = record.content;
	if (!Array.isArray(content)) return {};
	let reached: "thinking" | "text" | "toolCall" | undefined;
	for (const part of content) {
		const type = (part as { type?: unknown } | undefined)?.type;
		if (type === "toolCall") return { reached: "toolCall" };
		if (type === "text") reached = "text";
		else if (type === "thinking" && reached === undefined) reached = "thinking";
	}
	return reached ? { reached } : {};
}

/** One provider error line is enough to name the failure; the rest is noise. */
const ERROR_TEXT_MAX_CHARS = 600;

function boundErrorText(value: string): string {
	const text = value.trim().replace(/\s+/gu, " ");
	const characters = [...text];
	return characters.length <= ERROR_TEXT_MAX_CHARS
		? text
		: `${characters.slice(0, ERROR_TEXT_MAX_CHARS).join("")}… [truncated]`;
}

function readOutcome(value: unknown): "ok" | "http_error" | "transport_error" | undefined {
	return value === "ok" || value === "http_error" || value === "transport_error" ? value : undefined;
}
