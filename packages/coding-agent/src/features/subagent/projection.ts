/**
 * Projections of a subagent record for the two audiences that receive one.
 *
 * Both are explicit allowlists rather than a spread of the internal record. The
 * internal record is the authority (it feeds the model-facing text, the chain's
 * `{previous}` splice, and the child's own transcript); what leaves this module
 * is a display projection, and a field a renderer cannot use must not travel.
 *
 * Why this exists at all, given that live progress no longer reaches the JSON
 * log by default: a live frame is a *replacement snapshot*, and re-sending
 * accumulated state wastes the UI's own budget — projection cost, allocation,
 * redraw. The rule that keeps it small is the same one that keeps it correct:
 * send the current state, not the history.
 *
 * The byte budgets below are therefore a **repaint budget, not a log bound**.
 * Once progress has a channel of its own (see the follow-up in
 * `docs/research/.../README.md`), the roster cap and `omittedResults` exist only
 * to keep one frame cheap, and can be replaced by whatever that channel needs.
 */

import type { StepSubagentResultRecord } from "../step-subagent.ts";
import { cloneUsage } from "./helpers.ts";

/** Live frames are one per repaint; a renderer shows the newest lines only. */
const LIVE_TEXT_CHARS = 2_000;
const LIVE_TOOL_OUTPUT_CHARS = 1_000;
const LIVE_TOOL_ARGS_CHARS = 500;
/** A chain splices the previous step's whole answer into this field. */
const LIVE_TASK_CHARS = 600;
const LIVE_STDERR_CHARS = 2_000;
const LIVE_ERROR_CHARS = 2_000;
const LIVE_PROMPT_CHARS = 200;
const LIVE_CANCELLED_PROMPTS = 20;
/** Identifiers and paths are machine-read, so they keep both ends. */
const LIVE_IDENTIFIER_CHARS = 200;
const LIVE_PATH_CHARS = 500;
/**
 * One live roster. `MAX_PARALLEL_TASKS` allows 1000 tasks, and a renderer draws
 * a handful of rows plus a count, so the tail is reported rather than sent.
 *
 * Transitional: this bound only exists because a frame carries a whole roster.
 */
const LIVE_DETAILS_BYTES = 48 * 1024;

/** The final result is stored once per call and echoed by several events. */
const FINAL_TEXT_CHARS = 50_000;
const FINAL_TASK_CHARS = 2_000;
const FINAL_STDERR_CHARS = 2_000;
const FINAL_ERROR_CHARS = 2_000;
const FINAL_IDENTIFIER_CHARS = 200;
const FINAL_DETAILS_BYTES = 128 * 1024;
/** Outside the shared budget: a large batch must still identify every outcome. */
const FINAL_FIELD_FLOOR_CHARS = 96;

/** Keep the tail of a streamed field within `max` characters, marker included. */
function tailChars(value: string | undefined, max: number): string | undefined {
	if (value === undefined) return undefined;
	if (max <= 0) return "";
	if (value.length <= max) return value;
	if (max === 1) return "\u2026";
	return `\u2026${value.slice(-(max - 1))}`;
}

/** Keep both ends: the opening instruction and the inserted context. */
function clipMiddle(value: string, max: number): string {
	if (max <= 0) return "";
	if (value.length <= max) return value;
	if (max === 1) return "\u2026";
	const half = Math.max(1, Math.floor((max - 1) / 2));
	return `${value.slice(0, half)}\u2026${value.slice(-half)}`;
}

function boundedPrompts(prompts: string[] | undefined): string[] | undefined {
	if (!prompts || prompts.length === 0) return undefined;
	return prompts.slice(-LIVE_CANCELLED_PROMPTS).map((prompt) => tailChars(prompt, LIVE_PROMPT_CHARS) ?? "");
}

/** Serialized size, guarding against values JSON cannot represent. */
function serializedBytes(value: unknown): number {
	try {
		return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

/** Serialized field budget; rejected values must never escape at full size. */
interface Budget {
	remaining: number;
}

function take(budget: Budget, value: unknown): boolean {
	if (value === undefined) return true;
	const size = serializedBytes(value) + 1;
	if (size > budget.remaining) return false;
	budget.remaining -= size;
	return true;
}

/** A field that does not fit is omitted, never kept at full size. */
function withinBudget<T>(budget: Budget, value: T): T | undefined {
	return take(budget, value) ? value : undefined;
}

/**
 * One record for a live frame.
 *
 * `messages` is empty by construction: a live frame replaces the previous one,
 * and the transcript only changes at `message_end` — copying it per event
 * re-sends the same array hundreds of times between two of them.
 */
export function liveRecord(record: StepSubagentResultRecord): StepSubagentResultRecord {
	const prompts = boundedPrompts(record.cancelledPrompts);
	return {
		agent: clipMiddle(record.agent, LIVE_IDENTIFIER_CHARS),
		agentSource: record.agentSource,
		task: clipMiddle(record.task, LIVE_TASK_CHARS),
		status: record.status,
		exitCode: record.exitCode,
		messages: [],
		stderr: tailChars(record.stderr, LIVE_STDERR_CHARS) ?? "",
		usage: cloneUsage(record.usage),
		...(record.model === undefined ? {} : { model: clipMiddle(record.model, LIVE_IDENTIFIER_CHARS) }),
		...(record.stopReason === undefined ? {} : { stopReason: clipMiddle(record.stopReason, LIVE_IDENTIFIER_CHARS) }),
		...(record.errorMessage === undefined ? {} : { errorMessage: tailChars(record.errorMessage, LIVE_ERROR_CHARS) }),
		...(record.activeText === undefined ? {} : { activeText: tailChars(record.activeText, LIVE_TEXT_CHARS) }),
		...(record.activeTool === undefined ? {} : { activeTool: clipMiddle(record.activeTool, LIVE_IDENTIFIER_CHARS) }),
		...(record.activeToolArgs === undefined
			? {}
			: { activeToolArgs: tailChars(record.activeToolArgs, LIVE_TOOL_ARGS_CHARS) }),
		...(record.activeToolOutput === undefined
			? {}
			: { activeToolOutput: tailChars(record.activeToolOutput, LIVE_TOOL_OUTPUT_CHARS) }),
		...(record.lastEvent === undefined ? {} : { lastEvent: clipMiddle(record.lastEvent, LIVE_IDENTIFIER_CHARS) }),
		...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
		...(record.updatedAt === undefined ? {} : { updatedAt: record.updatedAt }),
		...(record.step === undefined ? {} : { step: record.step }),
		...(record.worktreePath === undefined ? {} : { worktreePath: clipMiddle(record.worktreePath, LIVE_PATH_CHARS) }),
		...(record.worktreeBranch === undefined
			? {}
			: { worktreeBranch: clipMiddle(record.worktreeBranch, LIVE_IDENTIFIER_CHARS) }),
		...(record.sessionId === undefined ? {} : { sessionId: clipMiddle(record.sessionId, LIVE_IDENTIFIER_CHARS) }),
		...(record.sessionFile === undefined ? {} : { sessionFile: clipMiddle(record.sessionFile, LIVE_PATH_CHARS) }),
		...(record.pendingReply === undefined ? {} : { pendingReply: record.pendingReply }),
		...(prompts === undefined ? {} : { cancelledPrompts: prompts }),
	};
}

/**
 * Bound a live roster by bytes and say how many records were left out.
 *
 * `MAX_PARALLEL_TASKS` allows 1000 tasks, so a complete roster costs O(tasks) on
 * every frame. A renderer draws a handful of rows plus a count, so the tail is
 * reported rather than silently dropped.
 */
export function liveRoster(records: readonly StepSubagentResultRecord[]): {
	results: StepSubagentResultRecord[];
	omittedResults?: number;
} {
	const budget: Budget = { remaining: LIVE_DETAILS_BYTES };
	const results: StepSubagentResultRecord[] = [];
	for (const record of records) {
		const projected = liveRecord(record);
		// The first record is always emitted: a roster that reports only a count
		// is less useful than one slightly over budget, and `liveRecord` bounds
		// every field it contains.
		if (results.length > 0 && !take(budget, projected)) break;
		if (results.length === 0) take(budget, projected);
		results.push(projected);
	}
	const omitted = records.length - results.length;
	return omitted > 0 ? { results, omittedResults: omitted } : { results };
}

/**
 * One record for the final tool result.
 *
 * The terminal result is a summary, not a transcript: `messages` is absent, and
 * the full history stays in the child session behind `sessionId`/`sessionFile`.
 * `activeText` falls back to the transcript's final assistant text, so a record
 * always renders even when the runner reported none.
 */
export function finalRecord(record: StepSubagentResultRecord, budget: Budget): StepSubagentResultRecord {
	const text = record.activeText || finalAssistantText(record);
	const fields = [
		{ value: record.task || "(unspecified task)", max: FINAL_TASK_CHARS, clip: clipMiddle },
		{ value: text, max: FINAL_TEXT_CHARS, clip: tailChars },
		{ value: record.stderr, max: FINAL_STDERR_CHARS, clip: tailChars },
		{ value: record.errorMessage, max: FINAL_ERROR_CHARS, clip: tailChars },
	];
	// Floors are bounded independently of the shared budget. Without them later
	// records lose their identity, output, and failure reason once a batch fills it.
	const floors = fields.map(({ value, clip }) => (value ? clip(value, FINAL_FIELD_FLOOR_CHARS) : value));
	let fieldsLeft = fields.filter(({ value }) => value).length;
	const projected = fields.map(({ value, max, clip }, index) => {
		if (!value) return floors[index];
		const allocation: Budget = { remaining: Math.floor(budget.remaining / fieldsLeft--) };
		const initial = allocation.remaining;
		let low = 0;
		let high = Math.min(value.length, max);
		// Search serialized bytes, not characters: JSON escapes can cost six bytes.
		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			if (serializedBytes(clip(value, middle)) + 1 <= allocation.remaining) low = middle;
			else high = middle - 1;
		}
		const expanded = low > FINAL_FIELD_FLOOR_CHARS ? withinBudget(allocation, clip(value, low)) : undefined;
		budget.remaining -= initial - allocation.remaining;
		return expanded ?? floors[index];
	});
	const [task, activeText, stderr, errorMessage] = projected;
	const prompts = withinBudget(budget, boundedPrompts(record.cancelledPrompts));
	return {
		agent: clipMiddle(record.agent, FINAL_IDENTIFIER_CHARS),
		agentSource: record.agentSource,
		task: task ?? "(unspecified task)",
		status: record.status,
		exitCode: record.exitCode,
		messages: [],
		stderr: stderr ?? "",
		usage: cloneUsage(record.usage),
		...(record.model === undefined ? {} : { model: clipMiddle(record.model, FINAL_IDENTIFIER_CHARS) }),
		...(record.stopReason === undefined ? {} : { stopReason: clipMiddle(record.stopReason, FINAL_IDENTIFIER_CHARS) }),
		...(errorMessage === undefined ? {} : { errorMessage }),
		...(activeText === undefined ? {} : { activeText }),
		...(record.activeTool === undefined ? {} : { activeTool: clipMiddle(record.activeTool, FINAL_IDENTIFIER_CHARS) }),
		...(record.lastEvent === undefined ? {} : { lastEvent: clipMiddle(record.lastEvent, FINAL_IDENTIFIER_CHARS) }),
		...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
		...(record.updatedAt === undefined ? {} : { updatedAt: record.updatedAt }),
		...(record.step === undefined ? {} : { step: record.step }),
		...(record.worktreePath === undefined ? {} : { worktreePath: clipMiddle(record.worktreePath, LIVE_PATH_CHARS) }),
		...(record.worktreeBranch === undefined
			? {}
			: { worktreeBranch: clipMiddle(record.worktreeBranch, FINAL_IDENTIFIER_CHARS) }),
		...(record.sessionId === undefined ? {} : { sessionId: clipMiddle(record.sessionId, FINAL_IDENTIFIER_CHARS) }),
		...(record.sessionFile === undefined ? {} : { sessionFile: clipMiddle(record.sessionFile, LIVE_PATH_CHARS) }),
		...(record.pendingReply === undefined ? {} : { pendingReply: record.pendingReply }),
		...(prompts === undefined ? {} : { cancelledPrompts: prompts }),
	};
}

/**
 * The whole call's final records, sharing one byte budget.
 *
 * Every record keeps small identity, output, and diagnostic floors, even when
 * those floors alone exceed the shared budget. Remaining bytes are divided
 * across records still to project; child output cannot starve a later outcome.
 */
export function finalRoster(records: readonly StepSubagentResultRecord[]): StepSubagentResultRecord[] {
	const budget: Budget = { remaining: FINAL_DETAILS_BYTES };
	return records.map((record, index) => {
		const allocation: Budget = { remaining: Math.floor(budget.remaining / (records.length - index)) };
		const initial = allocation.remaining;
		const result = finalRecord(record, allocation);
		budget.remaining -= initial - allocation.remaining;
		return result;
	});
}

/** The last assistant text in a record's transcript, if it has one. */
function finalAssistantText(record: StepSubagentResultRecord): string {
	for (let index = record.messages.length - 1; index >= 0; index -= 1) {
		const message = record.messages[index];
		if (message.role !== "assistant") continue;
		const text = message.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		if (text) return text;
	}
	return "";
}
