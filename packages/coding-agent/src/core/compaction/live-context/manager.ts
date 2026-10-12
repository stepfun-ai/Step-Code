import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@step-harness/agent-core";
import type { AssistantMessage, Context, ToolResultMessage } from "@step-harness/providers";
import type { CustomMessage } from "../../messages.ts";
import { buildContextEntries, type SessionManager, sessionEntryToContextMessages } from "../../session-manager.ts";
import { resolveToCwd } from "../../tools/path-utils.ts";
import { type CompactionPreparation, estimateTokens } from "../compaction.ts";
import {
	applyLiveContext,
	digestMessages,
	type LiveContextDocument,
	renderLiveContext,
	renderLiveContextIndex,
	replaceLiveContextBodies,
} from "./document.ts";
import {
	createLiveContextReadView,
	LIVE_CONTEXT_READ_MAX_BYTES,
	LIVE_CONTEXT_READ_MAX_LINES,
	type LiveContextReadView,
} from "./read-view.ts";

export const LIVE_CONTEXT_ENTRY = "step-live-context";

interface Checkpoint {
	version: 1;
	revision: number;
	sourceCount: number;
	sourceDigest: string;
	sourceHashes?: string[];
	retrySourceIndexes?: number[];
	/** Messages omitted by the native loop (for example tool-parser resampling). */
	hostExcludedIndexes?: number[];
	messages: AgentMessage[];
	sourceIndexes: (number | null)[];
	diff?: string;
	archivePath?: string;
}
interface MappedContext {
	messages: AgentMessage[];
	sourceIndexes: (number | null)[];
}
export interface LiveContextOutcome {
	accepted: boolean;
	revision: number;
	reason?: string;
	beforeTokens?: number;
	afterTokens?: number;
	archivePath?: string;
}
export interface LiveContextStatus {
	revision: number;
	path: string;
	indexPath: string;
	archiveDirectory: string;
	tokens?: number;
	lastOutcome?: LiveContextOutcome;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function validContent(value: unknown, assistant = false): boolean {
	if (!Array.isArray(value)) return false;
	return value.every((part) => {
		if (!isRecord(part)) return false;
		switch (part.type) {
			case "text":
				return typeof part.text === "string";
			case "image":
				return !assistant && typeof part.data === "string" && typeof part.mimeType === "string";
			case "thinking":
				return assistant && typeof part.thinking === "string";
			case "toolCall":
				return (
					assistant && typeof part.id === "string" && typeof part.name === "string" && isRecord(part.arguments)
				);
			default:
				return false;
		}
	});
}

/** Validate the fields consumed by rendering, budgeting, and native provider replay. */
function validMessage(value: unknown): value is AgentMessage {
	if (!isRecord(value) || !finiteNumber(value.timestamp)) return false;
	switch (value.role) {
		case "user":
			return typeof value.content === "string" || validContent(value.content);
		case "assistant": {
			const usage = value.usage;
			const cost = isRecord(usage) ? usage.cost : undefined;
			return (
				validContent(value.content, true) &&
				typeof value.api === "string" &&
				typeof value.provider === "string" &&
				typeof value.model === "string" &&
				typeof value.stopReason === "string" &&
				["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"].includes(value.stopReason) &&
				isRecord(usage) &&
				["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every((key) => finiteNumber(usage[key])) &&
				isRecord(cost) &&
				["input", "output", "cacheRead", "cacheWrite", "total"].every((key) => finiteNumber(cost[key]))
			);
		}
		case "toolResult":
			return (
				validContent(value.content) &&
				typeof value.toolCallId === "string" &&
				typeof value.toolName === "string" &&
				typeof value.isError === "boolean"
			);
		case "custom":
			return (
				(typeof value.content === "string" || validContent(value.content)) &&
				typeof value.customType === "string" &&
				typeof value.display === "boolean"
			);
		case "compactionSummary":
			return typeof value.summary === "string" && finiteNumber(value.tokensBefore);
		case "branchSummary":
			return typeof value.summary === "string" && typeof value.fromId === "string";
		case "bashExecution":
			return typeof value.command === "string" && typeof value.output === "string";
		default:
			return false;
	}
}

function validOptionalIndexes(value: unknown, count: number): boolean {
	return (
		value === undefined ||
		(Array.isArray(value) && value.every((index) => Number.isSafeInteger(index) && index >= 0 && index < count))
	);
}

function checkpoint(value: unknown): Checkpoint | undefined {
	if (!value || typeof value !== "object") return undefined;
	const c = value as Partial<Checkpoint>;
	if (
		c.version !== 1 ||
		!Number.isSafeInteger(c.revision) ||
		c.revision! < 0 ||
		!Number.isSafeInteger(c.sourceCount) ||
		c.sourceCount! < 0 ||
		typeof c.sourceDigest !== "string" ||
		!/^[a-f0-9]{64}$/.test(c.sourceDigest) ||
		!Array.isArray(c.messages) ||
		!Array.isArray(c.sourceIndexes) ||
		c.messages.length !== c.sourceIndexes.length ||
		!c.messages.every(validMessage) ||
		!c.sourceIndexes.every((i) => i === null || (Number.isSafeInteger(i) && i >= 0 && i < c.sourceCount!)) ||
		!validOptionalIndexes(c.retrySourceIndexes, c.sourceCount!) ||
		!validOptionalIndexes(c.hostExcludedIndexes, c.sourceCount!) ||
		(c.sourceHashes !== undefined &&
			(!Array.isArray(c.sourceHashes) ||
				c.sourceHashes.length !== c.sourceCount ||
				!c.sourceHashes.every((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))))
	)
		return undefined;
	return c as Checkpoint;
}
/** Queued custom messages acquire a persistence timestamp; their content/control identity is unchanged. */
function sourceMessage(message: AgentMessage): AgentMessage {
	return message.role === "custom" ? { ...message, timestamp: 0 } : message;
}
function sourceHash(message: AgentMessage): string {
	return digestMessages([sourceMessage(message)]);
}
function sourceDigest(messages: AgentMessage[]): string {
	return digestMessages(messages.map(sourceMessage));
}

function retryOnly(message: AgentMessage): boolean {
	return (
		message.role === "assistant" &&
		(message.stopReason === "error" || message.stopReason === "length") &&
		!message.content.some((block) => block.type === "toolCall")
	);
}
function sourceIdentity(messages: AgentMessage[]) {
	return {
		sourceHashes: messages.map(sourceHash),
		retrySourceIndexes: messages.flatMap((m, i) => (retryOnly(m) ? [i] : [])),
	};
}
/** Only reconcile known failed provider responses; a changed user/tool/successful message invalidates the overlay. */
function alignCheckpoint(saved: Checkpoint, raw: AgentMessage[]): Checkpoint | undefined {
	if (raw.length >= saved.sourceCount && sourceDigest(raw.slice(0, saved.sourceCount)) === saved.sourceDigest)
		return saved;
	if (!Array.isArray(saved.sourceHashes) || saved.sourceHashes.length !== saved.sourceCount) return undefined;
	const retryIndexes = new Set([...(saved.retrySourceIndexes ?? []), ...(saved.hostExcludedIndexes ?? [])]);
	const positions = new Map<number, number>();
	let cursor = 0;
	for (let index = 0; index < saved.sourceHashes.length; ) {
		if (cursor < raw.length && sourceHash(raw[cursor]) === saved.sourceHashes[index]) {
			positions.set(index++, cursor++);
		} else if (cursor < raw.length && retryOnly(raw[cursor])) cursor++;
		else if (retryIndexes.has(index)) index++;
		else return undefined;
	}
	const messages: AgentMessage[] = [];
	const sourceIndexes: (number | null)[] = [];
	saved.messages.forEach((message, i) => {
		const source = saved.sourceIndexes[i];
		const position = source === null ? null : positions.get(source);
		if (position === undefined) return;
		messages.push(message);
		sourceIndexes.push(position);
	});
	return {
		...saved,
		sourceCount: cursor,
		sourceDigest: sourceDigest(raw.slice(0, cursor)),
		hostExcludedIndexes: (saved.hostExcludedIndexes ?? []).flatMap((index) =>
			positions.has(index) ? [positions.get(index)!] : [],
		),
		...sourceIdentity(raw.slice(0, cursor)),
		messages,
		sourceIndexes,
	};
}

function sumTokens(messages: AgentMessage[]): number {
	return messages.reduce((total, message) => total + estimateTokens(message), 0);
}
function visible(message: AgentMessage): boolean {
	return message.role !== "bashExecution" || !message.excludeFromContext;
}
function identity(messages: AgentMessage[]): MappedContext {
	const sourceIndexes: number[] = [];
	return {
		messages: messages.filter((message, i) => {
			if (!visible(message)) return false;
			sourceIndexes.push(i);
			return true;
		}),
		sourceIndexes,
	};
}
function atomicWrite(path: string, text: string): void {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

/** Session-owned CLM overlay. Raw messages, tool effects, and usage accounting stay in SessionManager. */
export class LiveContextManager {
	private readonly session: SessionManager;
	private readonly root: string;
	private readonly mirrorDirectory: string;
	private readonly path: string;
	private readonly indexPath: string;
	private readonly archiveDirectory: string;
	private revision = 0;
	private lastOutcome?: LiveContextOutcome;
	private lastDiff = "";
	private lastTokens?: number;
	private pending?: {
		raw: AgentMessage[];
		sourceDigest: string;
		sourceCount: number;
		mapped: MappedContext;
		document: LiveContextDocument;
		leaf: string | null;
		hostExcludedIndexes: number[];
	};
	private disposed = false;
	private factor = 1;
	private requestEstimate?: { tokens: number; model: string };
	private notice?: string;
	private pressureTiers = new Set<number>();

	constructor(session: SessionManager, options: { directory?: string } = {}) {
		this.session = session;
		this.root = join(
			options.directory ?? (session.getSessionFile() ? session.getSessionDir() : tmpdir()),
			"live-context",
			session.getSessionId(),
		);
		this.mirrorDirectory = join(this.root, `mirror-${randomUUID()}`);
		this.path = join(this.mirrorDirectory, "LIVE_CONTEXT.md");
		this.indexPath = join(this.mirrorDirectory, "CONTEXT_INDEX.md");
		this.archiveDirectory = join(this.root, "archive");
	}

	private map(raw: AgentMessage[]): MappedContext {
		const branch = this.session.getBranch();
		let selected: Checkpoint | undefined;
		this.revision = 0;
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "custom" && entry.customType === LIVE_CONTEXT_ENTRY) {
				const data = entry.data as { reset?: boolean; revision?: number } | undefined;
				if (data?.reset) {
					this.revision = data.revision ?? 0;
					break;
				}
				selected = checkpoint(entry.data);
				if (selected) break;
			}
			if (entry.type === "compaction") {
				const storedTail = checkpoint((entry.details as { liveContext?: unknown } | undefined)?.liveContext);
				const tail =
					storedTail && raw[0]?.role === "compactionSummary"
						? alignCheckpoint(storedTail, raw.slice(1))
						: undefined;
				if (tail) {
					selected = {
						...tail,
						sourceCount: tail.sourceCount + 1,
						sourceDigest: sourceDigest(raw.slice(0, tail.sourceCount + 1)),
						hostExcludedIndexes: tail.hostExcludedIndexes?.map((index) => index + 1),
						...sourceIdentity(raw.slice(0, tail.sourceCount + 1)),
						messages: [raw[0], ...tail.messages],
						sourceIndexes: [0, ...tail.sourceIndexes.map((n) => (n === null ? null : n + 1))],
					};
				}
				break;
			}
		}
		if (!selected) {
			this.lastDiff = "";
			return identity(raw);
		}
		this.revision = selected.revision;
		this.lastDiff = selected.diff ?? this.lastDiff;
		const aligned = alignCheckpoint(selected, raw);
		if (!aligned) {
			this.notice =
				"Live context checkpoint does not match this branch's current history. Using its canonical context until the next valid edit.";
			this.lastDiff = "";
			return identity(raw);
		}
		selected = aligned;
		const suffix = identity(raw.slice(selected.sourceCount));
		return {
			messages: [...selected.messages, ...suffix.messages],
			sourceIndexes: [
				...selected.sourceIndexes,
				...suffix.sourceIndexes.map((n) => (n === null ? null : n + selected.sourceCount)),
			],
		};
	}

	project(raw: AgentMessage[]): AgentMessage[] {
		return this.map(raw).messages;
	}

	async prepare(raw: AgentMessage[], canonical: AgentMessage[] = raw): Promise<AgentMessage[]> {
		const mapped = this.map(raw);
		if (this.disposed) return mapped.messages;
		const document = renderLiveContext(mapped.messages, this.revision, this.session.getSessionId());
		mkdirSync(this.mirrorDirectory, { recursive: true, mode: 0o700 });
		atomicWrite(this.path, document.text);
		atomicWrite(this.indexPath, renderLiveContextIndex(document, this.path));
		// The loop can omit resampled attempts while state/transcript retain them. Anchor
		// to state explicitly rather than guessing from text what the loop discarded.
		const positions: number[] = [];
		let cursor = 0;
		for (const message of raw) {
			while (cursor < canonical.length && sourceHash(canonical[cursor]) !== sourceHash(message)) cursor++;
			if (cursor >= canonical.length) throw new Error("Request context is not a subsequence of canonical state.");
			positions.push(cursor++);
		}
		const included = new Set(positions);
		this.pending = {
			raw: [...canonical],
			sourceDigest: sourceDigest(canonical),
			sourceCount: canonical.length,
			mapped: {
				messages: mapped.messages,
				sourceIndexes: mapped.sourceIndexes.map((index) => (index === null ? null : positions[index])),
			},
			document,
			leaf: this.session.getLeafId(),
			hostExcludedIndexes: canonical.flatMap((_message, index) => (included.has(index) ? [] : [index])),
		};
		this.lastTokens = sumTokens(mapped.messages);
		return mapped.messages;
	}

	/** The tool batch is already persisted. An edit can replace only the pre-request prefix. */
	async accept(
		raw: AgentMessage[],
		signal?: AbortSignal,
		minimum?: { tokens: number; ratio: number },
	): Promise<LiveContextOutcome | undefined> {
		const pending = this.pending;
		this.pending = undefined;
		if (!pending || this.disposed || signal?.aborted) return undefined;
		const reject = (reason: string): LiveContextOutcome => {
			const outcome = { accepted: false, revision: this.revision, reason };
			this.lastOutcome = outcome;
			this.notice = `Context edit rejected: ${reason}`;
			return outcome;
		};
		try {
			const text = readFileSync(this.path, "utf8");
			if (text === pending.document.text) return undefined;
			if (
				raw.length < pending.sourceCount ||
				sourceDigest(raw.slice(0, pending.sourceCount)) !== pending.sourceDigest ||
				(pending.leaf && !this.session.getBranch().some((entry) => entry.id === pending.leaf))
			)
				return reject("The source context or active branch changed while this draft was being edited.");
			const applied = applyLiveContext(text, pending.document);
			if (!applied.accepted) return reject(applied.reason ?? "Invalid context document.");
			if (!applied.changed) return undefined;
			const beforeTokens = sumTokens(pending.mapped.messages);
			const afterTokens = sumTokens(applied.messages);
			if (minimum && beforeTokens - afterTokens < Math.max(minimum.tokens, beforeTokens * minimum.ratio))
				return reject("The proposed edit does not reduce enough context to justify automatic maintenance.");
			signal?.throwIfAborted();
			mkdirSync(this.archiveDirectory, { recursive: true, mode: 0o700 });
			const revision = this.revision + 1;
			const archivePath = join(this.archiveDirectory, `revision-${revision}-${randomUUID()}.md`);
			writeFileSync(archivePath, pending.document.text, { mode: 0o600, flag: "wx" });
			const sourceIndexes = applied.sourceIndexes.map((index) =>
				index === null ? null : pending.mapped.sourceIndexes[index],
			);
			const saved: Checkpoint = {
				version: 1,
				revision,
				sourceCount: pending.sourceCount,
				sourceDigest: pending.sourceDigest,
				...sourceIdentity(pending.raw),
				hostExcludedIndexes: pending.hostExcludedIndexes,
				messages: applied.messages,
				sourceIndexes,
				diff: applied.diff,
				archivePath,
			};
			// Persist before activation; failure must not replace the working context.
			this.session.appendCustomEntry(LIVE_CONTEXT_ENTRY, saved);
			this.revision = revision;
			this.lastDiff = applied.diff;
			const outcome = {
				accepted: true,
				revision,
				beforeTokens,
				afterTokens,
				archivePath,
			};
			this.lastOutcome = outcome;
			this.notice = `Context revision ${revision} accepted (${outcome.beforeTokens} -> ${outcome.afterTokens} estimated tokens). Previous context: ${JSON.stringify(archivePath)}.`;
			this.requestEstimate = undefined;
			return outcome;
		} catch (error) {
			return reject(error instanceof Error ? error.message : String(error));
		}
	}

	/** Only the request-local maintenance tool calls this; all edits retain the ordinary validator. */
	async replace(
		raw: AgentMessage[],
		replacements: unknown,
		signal: AbortSignal,
		minimum: { tokens: number; ratio: number },
	): Promise<LiveContextOutcome> {
		if (!this.pending || this.disposed || signal.aborted)
			return { accepted: false, revision: this.revision, reason: "No active context draft." };
		const draft = replaceLiveContextBodies(this.pending.document, replacements);
		if ("reason" in draft) return { accepted: false, revision: this.revision, reason: draft.reason };
		signal.throwIfAborted();
		atomicWrite(this.path, draft.text);
		return (
			(await this.accept(raw, signal, minimum)) ?? {
				accepted: false,
				revision: this.revision,
				reason: "The proposed edit did not change the working context.",
			}
		);
	}

	boundReadOutput(
		input: {
			toolName: string;
			args: unknown;
			content: ToolResultMessage["content"];
			isError: boolean;
			details?: unknown;
		},
		cwd: string,
	): LiveContextReadView | undefined {
		if (!this.pending || this.disposed) return undefined;
		const args = isRecord(input.args) ? input.args : {};
		const path = args.path ?? args.file_path;
		let isMirrorPath = false;
		if (typeof path === "string" && !input.isError) {
			try {
				const resolved = resolveToCwd(path, cwd);
				isMirrorPath = resolved === this.path || realpathSync(resolved) === realpathSync(this.path);
			} catch {
				/* Remote/custom reads can still be recognized by their session document framing. */
			}
		}
		const details = isRecord(input.details) ? input.details : undefined;
		const truncation = details && isRecord(details.truncation) ? details.truncation : undefined;
		return createLiveContextReadView({
			...input,
			document: this.pending.document,
			mirrorPath: this.path,
			isMirrorPath,
			truncated:
				details?.stepTruncated === true ||
				truncation?.truncated === true ||
				truncation?.firstLineExceedsLimit === true,
		});
	}

	guidance(options: { automaticMaintenance?: boolean } = {}): string {
		const retention = options.automaticMaintenance
			? "The host handles routine context reductions at safe boundaries, retaining exact errors, decisions, failed approaches, and next actions. When the requested work and checks are complete, finish task tracking and return the final answer. Do not inspect or edit the mirror solely to wrap up a completed task."
			: "Summarize obsolete observations at completed subtasks, retaining exact errors, decisions, failed approaches, and next actions.";
		return `\n\n## Working context\nYour editable working conversation is at ${JSON.stringify(this.path)}. ${retention} When organizing context, use the small read-only index at ${JSON.stringify(this.indexPath)}, or the index already supplied in the compact request, to locate editable blocks. The conversation is already in your context. Tool reads of the mirror return a bounded index by default; only explicit ranges of at most ${LIVE_CONTEXT_READ_MAX_LINES} lines fitting ${LIVE_CONTEXT_READ_MAX_BYTES} bytes return quoted excerpts. Search for a specific fact instead of paginating the full mirror. Large tool-output echoes of the current mirror are also limited. Do not read or print the entire mirror back into tool output. Use a single local read-modify-write operation to replace selected old text bodies by ID, reading the current file inside that same tool call so metadata and headers remain current. Make one useful batched edit and wait for the acceptance notice; avoid repeated audits of framing or copying old logs. Changes apply after all tools in the turn finish; new tool results and user messages are preserved. Keep the metadata, retained headers, protected messages, and tool-call pairs intact. Add scratchpad notes using role=notes and id=new-<unique>. Batch edits when useful: changing an early prefix can invalidate later cache entries. Do not print the entire file back into context. Accepted edits archive the previous view under ${JSON.stringify(this.archiveDirectory)}. Files and notes do not change task completion, permissions, or goal state. Ordinary /compact and automatic overflow recovery remain available.\n`;
	}

	takeNotice(): CustomMessage | undefined {
		if (!this.notice) return undefined;
		const content = this.notice;
		this.notice = undefined;
		return { role: "custom", customType: "live-context-status", display: false, content, timestamp: Date.now() };
	}

	budgetNotice(
		tokens: number,
		contextWindow: number,
		options: { automaticMaintenance?: boolean } = {},
	): CustomMessage | undefined {
		if (!Number.isFinite(tokens) || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
		const ratio = tokens / contextWindow;
		this.pressureTiers = new Set([...this.pressureTiers].filter((tier) => ratio >= tier));
		const crossed = [0.6, 0.75, 0.9].filter((tier) => ratio >= tier && !this.pressureTiers.has(tier));
		if (crossed.length === 0) return undefined;
		for (const tier of crossed) this.pressureTiers.add(tier);
		const action = options.automaticMaintenance
			? "The host handles routine context reductions at safe boundaries when needed. Continue the requested work and finish task tracking and the final answer when complete."
			: `Consider one batched edit of ${JSON.stringify(this.path)} to retain useful findings and remove obsolete detail before native compaction is needed.`;
		return {
			role: "custom",
			customType: "live-context-status",
			display: false,
			timestamp: Date.now(),
			content: `Working context is approximately ${Math.ceil(tokens).toLocaleString("en-US")} / ${contextWindow.toLocaleString("en-US")} tokens. ${action}`,
		};
	}

	estimate(context: Context): number {
		const chars = (context.systemPrompt?.length ?? 0) + JSON.stringify(context.tools ?? []).length;
		const raw = Math.ceil(chars / 4) + sumTokens(context.messages);
		return Math.ceil(raw * this.factor);
	}
	recordRequest(context: Context, model: string): number {
		const estimate = this.estimate(context);
		this.requestEstimate = { tokens: estimate / this.factor, model };
		this.lastTokens = estimate;
		return estimate;
	}
	observeUsage(message: AssistantMessage): void {
		const request = this.requestEstimate;
		this.requestEstimate = undefined;
		if (
			!request ||
			request.model !== `${message.provider}/${message.model}` ||
			message.stopReason === "error" ||
			message.stopReason === "aborted"
		)
			return;
		const observed = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
		if (observed > 0 && request.tokens > 0)
			this.factor = Math.max(1, Math.min(4, 0.75 * this.factor + (0.25 * observed) / request.tokens));
	}

	/** Project the same source ranges chosen by the existing compactor; retain its prompts and skill/file tracking. */
	prepareCompaction(
		preparation: CompactionPreparation,
		raw: AgentMessage[],
	): { preparation: CompactionPreparation; tail: Checkpoint } {
		const mapped = this.map(raw);
		const branch = this.session.getBranch();
		const keptIndex = branch.findIndex((entry) => entry.id === preparation.firstKeptEntryId);
		if (keptIndex < 0) throw new Error("Native compaction selected an unknown retained entry.");
		const contextEntries = buildContextEntries(branch).flatMap((entry) =>
			sessionEntryToContextMessages(entry).map((message) => ({ id: entry.id, message })),
		);
		// Map occurrences to entry IDs. A hash set loses distinct, byte-identical
		// messages on opposite sides of the cut; custom enqueue timestamps differ.
		const occurrences = new Map<string, string[]>();
		for (const item of contextEntries) {
			const hash = sourceHash(item.message);
			const ids = occurrences.get(hash) ?? [];
			ids.push(item.id);
			occurrences.set(hash, ids);
		}
		const rawEntries = raw.map((message) => occurrences.get(sourceHash(message))?.shift());
		const prefixIds = new Set<string>();
		let cursor = keptIndex - 1;
		for (const message of [...preparation.turnPrefixMessages].reverse()) {
			for (; cursor >= 0; cursor--) {
				const entry = branch[cursor];
				if (
					sessionEntryToContextMessages(entry).some((candidate) => sourceHash(candidate) === sourceHash(message))
				) {
					prefixIds.add(entry.id);
					cursor--;
					break;
				}
			}
		}
		// Native buildSessionContext retains the chronological suffix, including any
		// previous compaction entries inside it; preserve that exact source baseline.
		const kept = branch
			.slice(keptIndex)
			.flatMap((entry) => sessionEntryToContextMessages(entry).map((message) => ({ id: entry.id, message })));
		const keptIds = new Set(kept.map((entry) => entry.id));
		const messagesToSummarize: AgentMessage[] = [];
		const turnPrefixMessages: AgentMessage[] = [];
		const projectedByEntry = new Map<string, AgentMessage>();
		mapped.messages.forEach((message, index) => {
			const source = mapped.sourceIndexes[index];
			const entryId = source === null ? undefined : rawEntries[source];
			if (entryId && keptIds.has(entryId)) projectedByEntry.set(entryId, message);
			else if (entryId && prefixIds.has(entryId)) turnPrefixMessages.push(message);
			else if (message.role !== "compactionSummary" || !preparation.previousSummary)
				messagesToSummarize.push(message);
		});
		const tailMessages: AgentMessage[] = [];
		const tailIndexes: number[] = [];
		kept.forEach((entry, index) => {
			const message = projectedByEntry.get(entry.id);
			if (!message) return;
			tailMessages.push(message);
			tailIndexes.push(index);
		});
		const keptRaw = kept.map((entry) => entry.message);
		const keptSources = new Set(rawEntries.filter((id): id is string => id !== undefined));
		return {
			preparation: {
				...preparation,
				messagesToSummarize,
				turnPrefixMessages,
				isSplitTurn: preparation.isSplitTurn && turnPrefixMessages.length > 0,
				tokensBefore: sumTokens(mapped.messages),
			},
			tail: {
				version: 1,
				revision: this.revision + 1,
				sourceCount: keptRaw.length,
				sourceDigest: sourceDigest(keptRaw),
				...sourceIdentity(keptRaw),
				hostExcludedIndexes: kept.flatMap((entry, index) => (keptSources.has(entry.id) ? [] : [index])),
				messages: tailMessages,
				sourceIndexes: tailIndexes,
			},
		};
	}

	reset(): void {
		this.session.appendCustomEntry(LIVE_CONTEXT_ENTRY, { version: 1, reset: true, revision: this.revision + 1 });
		this.revision++;
		this.pending = undefined;
		this.lastDiff = "";
		this.lastTokens = undefined;
		this.notice = "Working context reset to the current canonical session context.";
	}
	invalidate(): void {
		this.pending = undefined;
		this.requestEstimate = undefined;
	}
	status(): LiveContextStatus {
		return {
			revision: this.revision,
			path: this.path,
			indexPath: this.indexPath,
			archiveDirectory: this.archiveDirectory,
			tokens: this.lastTokens,
			lastOutcome: this.lastOutcome,
		};
	}
	diff(): string {
		return this.lastDiff || "No accepted context edits on this branch.";
	}
	dispose(): void {
		this.disposed = true;
		this.invalidate();
		rmSync(this.mirrorDirectory, { recursive: true, force: true });
	}
}
