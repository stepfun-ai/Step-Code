/**
 * Session lifecycle, ported from legacy app.js. Feature code calls these as
 * plain functions; they update the store, and components re-render from it.
 *
 * Legacy `render*` calls that followed a state change (renderTimeline,
 * renderSessionLists, renderPreferenceControls, populateModels, the
 * `#stopRun` / `#prompt` / `#sendButton` toggles) are gone: those views are
 * derived from the store now. Legacy line numbers are noted per function.
 */

import { t } from "../i18n";
import { api, apiSend, errorMessage, setUnauthorizedHandler } from "../lib/api";
import { splitAttachedFiles } from "../lib/attached-files";
import { writeClipboard } from "../lib/clipboard";
import { basename, clipDetail, compact, toolArgs, toolInputDetail, toolInputSummary } from "../lib/format";
import { contentText, skillInvocation } from "../lib/markdown";
import { FULL_ACCESS_PRESET, isFullAccessRisk } from "../lib/permissions";
import { isDesktopHost } from "../platform/host";
import { assistantBlocks } from "./assistant-content";
import { observePerformance } from "./performance";
import { type AppState, getState, mapWith, setState, setUi } from "./store";
import { backgroundSubagentStatuses, subagentTasks } from "./subagent-tasks";
import { readThinkingTimings } from "./thinking-timing";
import type {
	AccountReport,
	AgentMessage,
	ApprovalRequest,
	BootstrapPayload,
	ChildAgentLink,
	ClarificationRequest,
	ContentPart,
	DraftModels,
	FileChange,
	LoginReport,
	QueueState,
	SelectionRequest,
	SessionEntry,
	SessionRetry,
	SessionSnapshot,
	SessionStatus,
	SessionSummary,
	ThinkingTimings,
	TimelineItem,
	ToolArgs,
	ToolTimelineItem,
	WebWorkspace,
} from "./types";

/* ── Errors and banners ──────────────────────────────────────────────────── */

let toastTimer: ReturnType<typeof setTimeout> | undefined;
let toastSeq = 0;

/** Show the top-centre toast for 4.2s (legacy `showError`, 3184-3193). `danger=false` is the neutral tone. */
export function showError(message: string, danger = true): void {
	toastSeq += 1;
	const seq = toastSeq;
	setState({ toast: { message, tone: danger ? "danger" : "neutral", seq } });
	if (toastTimer !== undefined) clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		if (getState().toast?.seq === seq) setState({ toast: null });
	}, 4200);
}

/**
 * The launch token is single-use and the signing secret is per config root, so
 * a stale cookie is a normal occurrence rather than a bug. Say so loudly:
 * otherwise every subsequent call fails silently and the UI just looks empty.
 * (legacy `showAuthBanner`, 689-692)
 */
export function showAuthBanner(): void {
	setUi({ authExpired: true });
}

setUnauthorizedHandler(showAuthBanner);

/** Copy to the clipboard and report the outcome in the toast (legacy `copyText`, 2098-2105). */
export async function copyText(value: string, successText: string = t("copied")): Promise<void> {
	try {
		await writeClipboard(value);
		showError(successText, false);
	} catch {
		showError(t("browserCopyDenied"));
	}
}

/* ── Selectors shared by several features ────────────────────────────────── */

/** Display title of a session (legacy `sessionTitle`, 719-725). */
export function sessionTitle(session: Partial<SessionSummary> | null | undefined): string {
	// A conversation opened with a skill starts with (and is auto-named after) the skill's whole instructions.
	const text = splitAttachedFiles(session?.name || session?.firstMessage || "").text;
	const skill = text ? skillInvocation(text) : null;
	return (
		(skill ? skill.request || skill.name : text) ||
		(session?.id ? `Session ${session.id.slice(0, 8)}` : t("newConversation"))
	);
}

/** Effective status of a session row (legacy `taskStatus`, 731-737). */
export function taskStatus(state: AppState, session: SessionSummary): SessionStatus {
	if (state.current?.id === session.id) return state.current.status ?? "idle";
	return state.statusById.get(session.id) ?? ((session.messageCount ?? 0) > 0 ? "completed" : "idle");
}

/** Every folder the UI knows as a workspace, sorted by name (legacy `knownWorkspaces`, 1082-1095). */
export function knownWorkspaces(state: AppState): string[] {
	const values = new Set<string>();
	if (state.bootstrapCwd) values.add(state.bootstrapCwd);
	if (state.draftCwd) values.add(state.draftCwd);
	if (state.current?.cwd) values.add(state.current.cwd);
	for (const workspace of state.workspaces) if (workspace.available) values.add(workspace.path);
	for (const session of state.sessions) {
		if (session.cwd && session.cwdAvailable !== false) values.add(session.cwd);
	}
	const hidden = new Set(state.workspaces.filter((workspace) => workspace.hidden).map((workspace) => workspace.path));
	return [...values]
		.filter((path) => !hidden.has(path))
		.sort((left, right) => basename(left).localeCompare(basename(right), "zh-CN"));
}

/** The cwd new work should target: current session, else draft, else launch folder. */
export function activeCwd(state: AppState = getState()): string {
	return state.current?.cwd || state.draftCwd || state.bootstrapCwd;
}

/** `${provider}\u0000${id}` key of a model (legacy `modelKey`). */
export function modelKey(model: { readonly provider: string; readonly id: string }): string {
	return `${model.provider}\u0000${model.id}`;
}

/* ── Snapshots and timeline ──────────────────────────────────────────────── */

/** Upsert a snapshot into the session list (legacy `mergeSessionSummary`, 2345-2352). */
export function mergeSessionSummary(
	sessions: readonly SessionSummary[],
	snapshot: SessionSummary,
): readonly SessionSummary[] {
	const index = sessions.findIndex((session) => session.id === snapshot.id);
	if (index < 0) return [snapshot, ...sessions];
	const next = [...sessions];
	next[index] = { ...sessions[index], ...snapshot };
	return next;
}

/**
 * The file change of a finished edit/write call: both tools record a unified
 * patch in their result details; `write` says why when it recorded none.
 */
function fileChange(name: string, args: unknown, result: AgentMessage | undefined): FileChange | undefined {
	if ((name !== "edit" && name !== "write") || !result || result.isError) return undefined;
	const details = (result.details ?? {}) as {
		patch?: unknown;
		untracked?: unknown;
	};
	const input = (args ?? {}) as { path?: unknown; file_path?: unknown };
	const path = typeof input.path === "string" ? input.path : input.file_path;
	if (typeof path !== "string" || !path.trim()) return undefined;
	if (typeof details.patch === "string") return { path, patch: details.patch };
	const reason = details.untracked;
	return {
		path,
		untracked: reason === "too_large" || reason === "binary" || reason === "unreadable" ? reason : "unknown",
	};
}

/**
 * The child agents a tool result points at. A subagent call lists each child's
 * session id in `details.results`; a workflow call names its run, whose agents
 * the host looks up. Both are structured fields, never parsed from text.
 */
export function childAgents(name: string, details: unknown): Pick<ToolTimelineItem, "children" | "workflowRun"> {
	if (!details || typeof details !== "object") return {};
	const value = details as { results?: unknown; runId?: unknown; schemaVersion?: unknown };
	if (name === "workflow" && typeof value.runId === "string" && value.schemaVersion === 1) {
		return { workflowRun: value.runId };
	}
	if (!Array.isArray(value.results)) return {};
	const children = (value.results as readonly unknown[]).flatMap((result): ChildAgentLink[] => {
		const record = (result ?? {}) as { sessionId?: unknown; agent?: unknown; task?: unknown };
		if (typeof record.sessionId !== "string" || !record.sessionId) return [];
		const agent = typeof record.agent === "string" ? record.agent : "";
		const task = typeof record.task === "string" ? compact(record.task, 60) : "";
		return [{ sessionId: record.sessionId, label: [agent, task].filter(Boolean).join(" · ") }];
	});
	return children.length ? { children } : {};
}

/** `{ args }` for a tool item when the call has arguments a row names, else nothing. */
function withArgs(input: unknown): { args?: ToolArgs } {
	const args = toolArgs(input);
	return args ? { args } : {};
}

/** Image parts of a message's content. */
/** The data URLs of a message's image blocks (`{ type: "image", mimeType, data }`). */
function imageSources(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	return (content as readonly ContentPart[]).flatMap((part) =>
		part?.type === "image" && typeof part.mimeType === "string" && typeof part.data === "string"
			? [`data:${part.mimeType};base64,${part.data}`]
			: [],
	);
}

/**
 * Project session entries into timeline rows (legacy `timelineFromEntries`, 2055-2096).
 *
 * A failed request the kernel retried is followed directly by the next
 * assistant attempt (an auto-resume adds a user message in between instead).
 * Such failures fold into one `retry` row. `retry` is the kernel's retry under
 * way, which makes the trailing failure part of the live series.
 */
export function timelineFromEntries(entries: readonly SessionEntry[] = [], retry?: SessionRetry): TimelineItem[] {
	const items: TimelineItem[] = [];
	const toolResults = new Map<string, NonNullable<SessionEntry["message"]>>();
	for (const entry of entries) {
		if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolCallId) {
			toolResults.set(entry.message.toolCallId, entry.message);
		}
	}
	const messages = entries.filter((entry) => entry.type === "message" && entry.message);
	for (const [index, entry] of messages.entries()) {
		const message = entry.message;
		if (!message || message.role === "toolResult") continue;
		const text = contentText(message.content);
		const images = message.role === "user" ? imageSources(message.content) : [];
		// A failed request leaves an assistant message with no content; without a row the error was invisible.
		const error =
			message.role === "assistant" && message.stopReason === "error"
				? String(message.errorMessage || t("modelRequestFailed"))
				: "";
		const next = messages[index + 1]?.message;
		if (error && (next ? next.role === "assistant" : retry !== undefined)) {
			// The kernel dropped the attempt from its context, so tool calls it streamed before failing never ran.
			const last = items.at(-1);
			if (last?.kind === "retry") items[items.length - 1] = { ...last, errors: [...last.errors, error] };
			else items.push({ itemId: `retry-${entry.id}`, kind: "retry", errors: [error] });
			continue;
		}
		if (message.role !== "assistant" && (text || message.role === "user")) {
			// Every user message opens a turn (the host's turn boundary), even one without text.
			items.push({
				itemId: `message-${entry.id}`,
				entryId: entry.id,
				kind: "message",
				role: message.role,
				content: text,
				...(images.length ? { images } : {}),
				...(error ? { error } : {}),
				usage: entry.usage,
				timestamp: entry.timestamp,
			});
		}
		if (message.role === "assistant") {
			let hasText = false;
			const thinkingTimings = readThinkingTimings(entry.thinkingTimings, true);
			for (const block of assistantBlocks(message.content)) {
				if (block.type === "thinking") {
					items.push({
						itemId: `message-${entry.id}-thinking-${block.index}`,
						entryId: entry.id,
						kind: "thinking",
						content: block.thinking,
						running: false,
						...(thinkingTimings?.[block.index] ? { timing: thinkingTimings[block.index] } : {}),
					});
					continue;
				}
				if (block.type === "text") {
					if (!error)
						items.push({
							itemId: hasText ? `message-${entry.id}-text-${block.index}` : `message-${entry.id}`,
							entryId: entry.id,
							kind: "message",
							role: "assistant",
							content: block.text,
							usage: hasText ? undefined : entry.usage,
							timestamp: entry.timestamp,
						});
					hasText = true;
					continue;
				}
				const result = toolResults.get(String(block.id));
				const imported = Boolean(entry.imported);
				const importedUnknown =
					imported &&
					(!result ||
						(result.details &&
							typeof result.details === "object" &&
							"importedStatus" in result.details &&
							result.details.importedStatus === "unknown"));
				const change = imported ? undefined : fileChange(String(block.name ?? ""), block.arguments, result);
				const links = imported ? {} : childAgents(String(block.name ?? ""), result?.details);
				items.push({
					itemId: `tool-${block.id}`,
					kind: "tool",
					state: importedUnknown ? "unknown" : result?.isError ? "failed" : result ? "completed" : "pending",
					...(imported ? { imported: true } : {}),
					toolName: String(block.name ?? ""),
					inputSummary: toolInputSummary(block.arguments),
					outputSummary: result ? compact(contentText(result.content)) : "",
					inputDetail: toolInputDetail(block.arguments),
					outputDetail: result ? clipDetail(contentText(result.content)) : "",
					...withArgs(block.arguments),
					...(change ? { change } : {}),
					...links,
					...(!imported && block.name === "subagent"
						? {
								subagentTasks: subagentTasks(
									block.arguments,
									result?.details,
									result?.isError ? "failed" : result ? "completed" : "pending",
								),
							}
						: {}),
				});
			}
			if (error)
				items.push({
					itemId: `message-${entry.id}`,
					entryId: entry.id,
					kind: "message",
					role: "assistant",
					content: "",
					error,
					usage: entry.usage,
					timestamp: entry.timestamp,
				});
		}
	}
	if (retry) {
		const last = items.at(-1);
		if (last?.kind === "retry") items[items.length - 1] = { ...last, live: retry };
		// The failed attempt is not recorded yet (or not in this branch): the retry still shows.
		else items.push({ itemId: "retry-live", kind: "retry", errors: [retry.errorMessage], live: retry });
	}
	const background = backgroundSubagentStatuses(entries);
	return items.map((item) =>
		item.kind === "tool" && item.subagentTasks
			? {
					...item,
					subagentTasks: item.subagentTasks.map((task, _index, tasks) => {
						const laneStatus = task.backgroundAgentId ? background.get(task.backgroundAgentId) : undefined;
						if (!laneStatus || (tasks.length > 1 && task.status !== "running" && task.status !== "queued"))
							return task;
						// A lane's completion does not establish whether a still-queued chain step executed.
						return {
							...task,
							status:
								tasks.length > 1 && task.status === "queued" && laneStatus !== "running"
									? "unknown"
									: laneStatus,
						};
					}),
				}
			: item,
	);
}

/**
 * Approvals announced on the stream and not yet decided. A snapshot fetched
 * just before the announcement does not list them yet; without this the
 * refresh that follows `approval_required` wiped the card and left the session
 * "waiting" with nothing to answer.
 */
const liveApprovals = new Map<string, ApprovalRequest>();
const liveClarifications = new Map<string, ClarificationRequest>();
const resolvedClarifications = new Set<string>();
/** Kernel selections already answered; ids are unique per host process. */
const resolvedSelections = new Set<string>();

/** Record an answered selection so a snapshot that raced the answer does not reopen it. */
export function forgetSelection(id: string): void {
	resolvedSelections.add(id);
}

/** Drop an approval once it is decided or its session is no longer waiting. */
export function forgetApproval(id: string): void {
	liveApprovals.delete(id);
}

/** Pending approvals from the snapshot plus any the stream announced since. */
function approvalItems(snapshot: SessionSnapshot): TimelineItem[] {
	const pending = new Map<string, ApprovalRequest>();
	for (const approval of snapshot.pendingApprovals ?? []) pending.set(approval.id, approval);
	for (const approval of liveApprovals.values()) {
		if (approval.sessionId === snapshot.id && !pending.has(approval.id)) pending.set(approval.id, approval);
	}
	return [...pending.values()].map((approval) => ({
		itemId: `approval-${approval.id}`,
		kind: "approval",
		approval,
	}));
}

/**
 * Make `snapshot` the current session (legacy `renderSnapshot`, 2992-3011).
 * Everything the legacy function painted is derived from these fields.
 */
export function renderSnapshot(snapshot: SessionSnapshot): void {
	const pending = new Map((snapshot.pendingClarifications ?? []).map((request) => [request.id, request]));
	for (const request of liveClarifications.values()) {
		if (request.sessionId === snapshot.id) pending.set(request.id, request);
	}
	for (const id of resolvedClarifications) pending.delete(id);
	snapshot = {
		...snapshot,
		pendingClarifications: [...pending.values()],
		// A response that left before an answer must not reopen the dialog.
		pendingSelections: (snapshot.pendingSelections ?? []).filter((request) => !resolvedSelections.has(request.id)),
	};
	setState((state) => {
		const timelineItems = [...timelineFromEntries(snapshot.entries, snapshot.retry), ...approvalItems(snapshot)];
		const pendingTurn =
			state.pendingTurn && countUserMessages(timelineItems) > state.pendingTurn.userCount ? null : state.pendingTurn;
		return {
			current: snapshot,
			performanceRun: state.current?.id === snapshot.id ? state.performanceRun : null,
			policiesCache: snapshot.policies ?? state.policiesCache,
			draftCwd: snapshot.cwd,
			draftPolicy: snapshot.permissionPreset || "approve-for-me",
			draftSelection: null,
			draftFullAccessAnswer: "",
			draftPolicyPicked: false,
			// Not the snapshot's model: a draft that inherited it would PATCH a new
			// session back onto whatever the last opened session ran (and persist it
			// as the global default). An explicit pick is persisted by the server.
			draftModel: "",
			draftThinking: "",
			statusById: mapWith(state.statusById, snapshot.id, snapshot.status),
			unreadById: mapWith(state.unreadById, snapshot.id, false),
			sessions: mergeSessionSummary(state.sessions, snapshot),
			timelineItems,
			pendingTurn,
		};
	});
}

/** User messages in a timeline; `pendingTurn` compares this before and after a send. */
export function countUserMessages(items: readonly TimelineItem[]): number {
	return items.filter((item) => item.kind === "message" && item.role === "user").length;
}

/** Show `queue` as the session's pending messages, from the stream or a queue route's response. */
export function applyQueueState(sessionId: string, queue: QueueState): void {
	setState((state) =>
		state.current?.id === sessionId
			? { current: { ...state.current, queuedMessages: queue.queued, steeringMessages: queue.steering } }
			: {},
	);
}

/* ── Live stream ─────────────────────────────────────────────────────────── */

let stream: EventSource | null = null;

/** Close the current session's event stream, if any. */
export function closeStream(): void {
	stream?.close();
	stream = null;
	setState({ performanceRun: null });
	liveApprovals.clear();
	liveClarifications.clear();
	resolvedClarifications.clear();
}

interface AgentStreamEvent {
	readonly type: string;
	readonly message?: { readonly role?: string; readonly content?: unknown; readonly usage?: unknown };
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly args?: unknown;
	readonly partialResult?: { readonly content?: unknown; readonly details?: unknown };
	readonly result?: { readonly content?: unknown; readonly details?: unknown };
	readonly isError?: boolean;
	readonly assistantMessageEvent?: { readonly type?: string; readonly contentIndex?: number };
}

function updateTimeline(update: (items: readonly TimelineItem[]) => readonly TimelineItem[]): void {
	setState((state) => ({ timelineItems: update(state.timelineItems) }));
}

/** Replace the row with the same id in place, or append it. */
function upsertItem(items: readonly TimelineItem[], item: TimelineItem): readonly TimelineItem[] {
	const index = items.findIndex((candidate) => candidate.itemId === item.itemId);
	if (index < 0) return [...items, item];
	const next = [...items];
	next[index] = item;
	return next;
}

function updateToolItem(
	toolCallId: string | undefined,
	update: (item: TimelineItem & { kind: "tool" }) => TimelineItem,
) {
	updateTimeline((items) =>
		items.map((item) => (item.kind === "tool" && item.itemId === `tool-${toolCallId}` ? update(item) : item)),
	);
}

/**
 * The turn being streamed: its text so far plus the tool calls whose
 * arguments are still arriving. Showing the calls (and a thinking marker)
 * live matters: a model writing a file streams the whole file as arguments,
 * and with text alone the page sat still until the turn ended.
 */
export function liveMessageTimeline(
	items: readonly TimelineItem[],
	content: unknown,
	thinkingIndex?: number,
	thinkingTimings?: ThinkingTimings,
): readonly TimelineItem[] {
	const blocks = assistantBlocks(content);
	const callIds = new Set(blocks.filter((block) => block.type === "toolCall").map((block) => `tool-${block.id}`));
	const next = items.filter((item) => !item.itemId.startsWith("message-live") && !callIds.has(item.itemId));
	let hasText = false;
	for (const call of blocks) {
		if (call.type === "thinking") {
			next.push({
				itemId: `message-live-thinking-${call.index}`,
				kind: "thinking",
				content: call.thinking,
				running: call.index === thinkingIndex,
				...(thinkingTimings?.[call.index] ? { timing: thinkingTimings[call.index] } : {}),
			});
		} else if (call.type === "text") {
			next.push({
				itemId: hasText ? `message-live-text-${call.index}` : "message-live",
				kind: "message",
				role: "assistant",
				content: call.text,
			});
			hasText = true;
		} else {
			const itemId = `tool-${call.id}`;
			const existing = items.find((item) => item.itemId === itemId);
			// Once execution started the row is owned by the tool_execution_* events.
			if (existing?.kind === "tool" && existing.state !== "pending") {
				next.push(existing);
				continue;
			}
			next.push({
				itemId,
				kind: "tool",
				state: "pending",
				toolName: String(call.name ?? ""),
				inputSummary: toolInputSummary(call.arguments),
				outputSummary: existing?.kind === "tool" ? existing.outputSummary : "",
				inputDetail: toolInputDetail(call.arguments),
				outputDetail: existing?.kind === "tool" ? existing.outputDetail : "",
				...withArgs(call.arguments),
				...(call.name === "subagent"
					? {
							subagentTasks:
								existing?.kind === "tool" && existing.subagentTasks?.length
									? existing.subagentTasks
									: subagentTasks(call.arguments, undefined, "pending"),
						}
					: {}),
				...(existing?.kind === "tool" ? { children: existing.children, workflowRun: existing.workflowRun } : {}),
			});
		}
	}
	if (!blocks.length) next.push({ itemId: "message-live", kind: "message", role: "assistant", content: "" });
	return next;
}

/** message_update fires per token; render at most once per frame. */
let pendingLiveContent: {
	readonly content: unknown;
	readonly thinkingIndex?: number;
	readonly thinkingTimings?: ThinkingTimings;
} | null = null;
let liveFrame = 0;

function scheduleLiveMessage(content: unknown, thinkingIndex?: number, thinkingTimings?: ThinkingTimings): void {
	pendingLiveContent = { content, thinkingIndex, thinkingTimings };
	if (liveFrame) return;
	liveFrame = requestAnimationFrame(() => {
		liveFrame = 0;
		const pending = pendingLiveContent;
		pendingLiveContent = null;
		if (pending)
			updateTimeline((items) =>
				liveMessageTimeline(items, pending.content, pending.thinkingIndex, pending.thinkingTimings),
			);
	});
}

/** Apply a buffered message_update now, so later events land after it. */
function flushLiveMessage(): void {
	if (liveFrame) cancelAnimationFrame(liveFrame);
	liveFrame = 0;
	const pending = pendingLiveContent;
	pendingLiveContent = null;
	if (pending)
		updateTimeline((items) =>
			liveMessageTimeline(items, pending.content, pending.thinkingIndex, pending.thinkingTimings),
		);
}

function handleAgentEvent(agentEvent: AgentStreamEvent, thinkingTimings?: ThinkingTimings): void {
	if (
		agentEvent.type === "agent_start" ||
		agentEvent.type === "message_start" ||
		agentEvent.type === "message_end" ||
		agentEvent.type === "agent_settled"
	) {
		setState((state) => ({
			performanceRun: observePerformance(state.performanceRun, agentEvent, performance.now()),
		}));
	}
	if (agentEvent.type === "message_update") {
		const event = agentEvent.assistantMessageEvent;
		scheduleLiveMessage(
			agentEvent.message?.content,
			event?.type === "thinking_start" || event?.type === "thinking_delta" ? event.contentIndex : undefined,
			thinkingTimings,
		);
		return;
	}
	flushLiveMessage();
	if (thinkingTimings) {
		updateTimeline((items) =>
			items.map((item) => {
				if (item.kind !== "thinking" || !item.itemId.startsWith("message-live-thinking-")) return item;
				const index = item.itemId.slice("message-live-thinking-".length);
				return thinkingTimings[index] ? { ...item, timing: thinkingTimings[index] } : item;
			}),
		);
	}
	if (
		agentEvent.type === "message_end" ||
		agentEvent.type === "tool_execution_start" ||
		agentEvent.type === "agent_settled"
	) {
		updateTimeline((items) =>
			items.map((item) => (item.kind === "thinking" && item.running ? { ...item, running: false } : item)),
		);
	}
	if (agentEvent.type === "message_start" && agentEvent.message?.role === "user") {
		// The prompt entered the loop: show it in place now; the refresh after
		// its message_end replaces this row with the recorded entry.
		const content = contentText(agentEvent.message.content);
		const images = imageSources(agentEvent.message.content);
		setState((state) => ({
			pendingTurn: null,
			timelineItems: upsertItem(state.timelineItems, {
				itemId: "message-user-live",
				kind: "message",
				role: "user",
				content,
				...(images.length ? { images } : {}),
			}),
		}));
	}
	if (agentEvent.type === "tool_execution_start") {
		updateTimeline((items) =>
			upsertItem(items, {
				itemId: `tool-${agentEvent.toolCallId}`,
				kind: "tool",
				state: "pending",
				toolName: String(agentEvent.toolName ?? ""),
				inputSummary: toolInputSummary(agentEvent.args),
				outputSummary: "",
				inputDetail: toolInputDetail(agentEvent.args),
				outputDetail: "",
				...withArgs(agentEvent.args),
				...(agentEvent.toolName === "subagent"
					? { subagentTasks: subagentTasks(agentEvent.args, undefined, "pending") }
					: {}),
			}),
		);
	}
	if (agentEvent.type === "tool_execution_update") {
		const output = contentText(agentEvent.partialResult?.content);
		updateToolItem(agentEvent.toolCallId, (item) => ({
			...item,
			outputSummary: compact(output),
			outputDetail: clipDetail(output),
			// A running subagent call already knows its children's session ids.
			...childAgents(item.toolName, agentEvent.partialResult?.details),
			...(item.toolName === "subagent"
				? {
						subagentTasks: subagentTasks(
							undefined,
							agentEvent.partialResult?.details,
							"pending",
							item.subagentTasks,
						),
					}
				: {}),
		}));
	}
	if (agentEvent.type === "tool_execution_end") {
		const output = contentText(agentEvent.result?.content) || JSON.stringify(agentEvent.result ?? {});
		updateToolItem(agentEvent.toolCallId, (item) => ({
			...item,
			state: agentEvent.isError ? "failed" : "completed",
			outputSummary: compact(output),
			outputDetail: clipDetail(output),
			...childAgents(item.toolName, agentEvent.result?.details),
			...(item.toolName === "subagent"
				? {
						subagentTasks: subagentTasks(
							undefined,
							agentEvent.result?.details,
							agentEvent.isError ? "failed" : "completed",
							item.subagentTasks,
						),
					}
				: {}),
		}));
	}
	if (
		agentEvent.type === "message_end" ||
		agentEvent.type === "entry_appended" ||
		agentEvent.type === "session_info_changed" ||
		agentEvent.type === "agent_settled" ||
		// The snapshot carries the retry (attempt, backoff) and folds the failures it retries.
		agentEvent.type === "auto_retry_start" ||
		agentEvent.type === "auto_retry_end"
	) {
		void refreshCurrent().catch(() => {});
		void refreshSessions().catch(() => {});
	}
}

/** Subscribe to a session's SSE stream, replacing any previous one (legacy `connectStream`, 3013-3109). */
export function connectStream(id: string): void {
	stream?.close();
	setState({ performanceRun: null });
	const source = new EventSource(`/api/v1/sessions/${id}/events`);
	stream = source;
	source.addEventListener("snapshot", (event) => {
		if (stream === source) renderSnapshot(JSON.parse((event as MessageEvent).data));
	});
	source.addEventListener("agent", (event) => {
		if (stream !== source) return;
		const payload = JSON.parse((event as MessageEvent).data) as {
			event: AgentStreamEvent;
			thinkingTimings?: unknown;
		};
		handleAgentEvent(payload.event, readThinkingTimings(payload.thinkingTimings));
	});
	source.addEventListener("status", (event) => {
		const payload = JSON.parse((event as MessageEvent).data) as {
			status: SessionStatus;
			unread: boolean;
		};
		if (payload.status !== "waiting") liveApprovals.clear();
		setState((state) => ({
			// Only a running turn can still record the pending message.
			pendingTurn: state.current?.id === id && payload.status !== "running" ? null : state.pendingTurn,
			statusById: mapWith(state.statusById, id, payload.status),
			unreadById: mapWith(state.unreadById, id, payload.unread),
			current:
				state.current?.id === id
					? { ...state.current, status: payload.status, unread: payload.unread }
					: state.current,
		}));
	});
	source.addEventListener("queue", (event) => {
		if (stream === source) applyQueueState(id, JSON.parse((event as MessageEvent).data) as QueueState);
	});
	source.addEventListener("approval_required", (event) => {
		const approval = JSON.parse((event as MessageEvent).data).approval as ApprovalRequest;
		liveApprovals.set(approval.id, approval);
		updateTimeline((items) =>
			items.some((item) => item.itemId === `approval-${approval.id}`)
				? items
				: [...items, { itemId: `approval-${approval.id}`, kind: "approval", approval }],
		);
	});
	source.addEventListener("clarification_required", (event) => {
		const request = JSON.parse((event as MessageEvent).data).clarification as ClarificationRequest;
		if (stream !== source || request.sessionId !== id) return;
		liveClarifications.set(request.id, request);
		setState((state) => ({
			current:
				state.current?.id === id
					? {
							...state.current,
							pendingClarifications: [
								...(state.current.pendingClarifications ?? []).filter((item) => item.id !== request.id),
								request,
							],
						}
					: state.current,
		}));
	});
	source.addEventListener("clarification_resolved", (event) => {
		if (stream !== source) return;
		const requestId = JSON.parse((event as MessageEvent).data).id as string;
		liveClarifications.delete(requestId);
		resolvedClarifications.add(requestId);
		setState((state) => ({
			current:
				state.current?.id === id
					? {
							...state.current,
							pendingClarifications: (state.current.pendingClarifications ?? []).filter(
								(item) => item.id !== requestId,
							),
						}
					: state.current,
		}));
	});
	// Kernel selectors (the Full Access risk question). The snapshot carries
	// them too, so a reload or a PATCH that raised one shows the same dialog.
	source.addEventListener("selection_required", (event) => {
		const request = JSON.parse((event as MessageEvent).data).selection as SelectionRequest;
		if (stream !== source || request.sessionId !== id) return;
		setState((state) => ({
			current:
				state.current?.id === id
					? {
							...state.current,
							pendingSelections: [
								...(state.current.pendingSelections ?? []).filter((item) => item.id !== request.id),
								request,
							],
						}
					: state.current,
		}));
	});
	source.addEventListener("selection_resolved", (event) => {
		if (stream !== source) return;
		const requestId = JSON.parse((event as MessageEvent).data).id as string;
		resolvedSelections.add(requestId);
		setState((state) => ({
			current:
				state.current?.id === id
					? {
							...state.current,
							pendingSelections: (state.current.pendingSelections ?? []).filter((item) => item.id !== requestId),
						}
					: state.current,
		}));
	});
	source.addEventListener("web_error", (event) => {
		setState({ pendingTurn: null });
		showError(JSON.parse((event as MessageEvent).data).message || "运行错误");
	});
	source.onerror = () => {
		if (stream !== source) return;
		// A disconnected interval is unobserved, not slow generation.
		setState({ performanceRun: null });
		setTimeout(() => void refreshCurrent().catch(() => {}), 600);
	};
}

/* ── Session list and current session ────────────────────────────────────── */

/** Reload the session list (legacy `refreshSessions`, 3111-3115). */
export async function refreshSessions(): Promise<void> {
	const data = await api<{ sessions: SessionSummary[] }>("/api/v1/sessions");
	setState({ sessions: data.sessions });
}

/** Reload the current session's snapshot (legacy `refreshCurrent`, 3117-3120). */
export async function refreshCurrent(): Promise<void> {
	const current = getState().current;
	if (!current) return;
	const snapshot = await api<SessionSnapshot>(`/api/v1/sessions/${current.id}`);
	if (getState().current?.id === current.id) renderSnapshot(snapshot);
}

/** Reload the registered workspaces (legacy `refreshWorkspaces`, 1984-1987). */
export async function refreshWorkspaces(): Promise<void> {
	const data = await api<{ workspaces: WebWorkspace[] }>("/api/v1/workspaces");
	setState({ workspaces: data.workspaces });
}

/** Open a session and follow its stream (legacy `openSession`, 3122-3130). */
export async function openSession(id: string): Promise<void> {
	choseSession = true;
	setUi({ midView: null, childView: null });
	setState({ pendingTurn: null });
	try {
		const snapshot = await api<SessionSnapshot>(`/api/v1/sessions/${id}`);
		renderSnapshot(snapshot);
		connectStream(id);
	} catch (error) {
		showError(errorMessage(error));
	}
}

/** Ask the composer to focus `#prompt`. */
export function requestPromptFocus(): void {
	setUi((ui) => ({ promptFocusRequest: ui.promptFocusRequest + 1 }));
}

/**
 * Leave the current session and start an unsaved draft in `cwd` (legacy
 * `startDraft`, 3132-3151). The session is created on the first send.
 */
export function startDraft(cwd: string = getState().bootstrapCwd): void {
	choseSession = true;
	closeStream();
	const draftCwd = cwd || getState().bootstrapCwd;
	setState((state) => {
		const current = state.current;
		return {
			draftPolicy: current ? current.permissionPreset || state.draftPolicy : state.draftPolicy,
			draftSelection: null,
			draftFullAccessAnswer: "",
			draftPolicyPicked: false,
			// A new conversation starts on the server's default model and effort
			// (see renderSnapshot); only a pick made in this draft overrides them.
			draftModel: current ? "" : state.draftModel,
			draftThinking: current ? "" : state.draftThinking,
			current: null,
			timelineItems: [],
			pendingTurn: null,
			draftCwd,
		};
	});
	// A new conversation replaces whatever covers the pane (cron / plugin market, a child agent).
	setUi({ midView: null, childView: null });
	requestPromptFocus();
	void loadDraftModels(draftCwd);
}

/**
 * Ask the host which model a new session in `cwd` would start on, so the
 * draft's model panel shows it (and its catalog and effort) before the first
 * send. Fetched per draft: a sign-in or an explicit pick changes the answer.
 */
async function loadDraftModels(cwd: string): Promise<void> {
	try {
		const draftModels = await api<DraftModels>(`/api/v1/models?cwd=${encodeURIComponent(cwd)}`);
		// A late answer for a draft the user already left must not repaint another one.
		const state = getState();
		if (!state.current && state.draftCwd === cwd)
			setState({
				draftModels,
				policiesCache: draftModels.policies ?? state.policiesCache,
				...(!state.draftPolicyPicked && draftModels.permissionPreset
					? { draftPolicy: draftModels.permissionPreset, draftFullAccessAnswer: "" }
					: {}),
			});
	} catch (error) {
		showError(errorMessage(error));
	}
}

/**
 * The current session, creating it from the draft (cwd, policy, model,
 * thinking level) when there is none yet (legacy `createSessionIfNeeded`,
 * 3153-3182).
 */
export async function createSessionIfNeeded(): Promise<SessionSnapshot> {
	const state = getState();
	if (state.current) return state.current;
	let snapshot = await apiSend<SessionSnapshot>("/api/v1/sessions", "POST", {
		cwd: state.draftCwd || state.bootstrapCwd,
	});
	// A session whose settings already name Full Access asks the risk question
	// itself at start (and runs as Approve for Me until answered). Switching
	// tier on top of that would raise a second copy of the same question.
	const askedAtStart = snapshot.pendingSelections?.some(isFullAccessRisk) ?? false;
	if (!askedAtStart && state.draftPolicy && snapshot.permissionPreset !== state.draftPolicy) {
		snapshot = await apiSend<SessionSnapshot>(`/api/v1/sessions/${snapshot.id}/policy`, "PATCH", {
			preset: state.draftPolicy,
		});
	}
	// The user already answered the risk question in the draft; hand that
	// answer to the kernel instead of asking twice. Without one (a tier carried
	// over from another session), the question stays open for the dialog.
	const risk = snapshot.pendingSelections?.find(isFullAccessRisk);
	if (risk && state.draftPolicy === FULL_ACCESS_PRESET && state.draftFullAccessAnswer) {
		snapshot = await apiSend<SessionSnapshot>(`/api/v1/sessions/${snapshot.id}/selections/response`, "POST", {
			id: risk.id,
			value: state.draftFullAccessAnswer,
		});
	}
	if (state.draftModel) {
		const [provider, modelId] = state.draftModel.split("\u0000");
		if (provider && modelId && (snapshot.model?.provider !== provider || snapshot.model?.id !== modelId)) {
			snapshot = await apiSend<SessionSnapshot>(`/api/v1/sessions/${snapshot.id}/model`, "PATCH", {
				provider,
				modelId,
			});
		}
	}
	// Always send a draft's pick: the host clamps it to the model the session
	// ended up on, the same way the draft panel did (`clampEffort`). Skipping
	// a level the model lacks would start the session on the default instead.
	if (state.draftThinking && snapshot.thinkingLevel !== state.draftThinking) {
		snapshot = await apiSend<SessionSnapshot>(`/api/v1/sessions/${snapshot.id}/thinking`, "PATCH", {
			level: state.draftThinking,
		});
	}
	renderSnapshot(snapshot);
	connectStream(snapshot.id);
	await refreshSessions();
	return snapshot;
}

/** Stop the running turn of the current session (legacy `interruptCurrent`, 3245-3254). */
export async function interruptCurrent(): Promise<void> {
	const current = getState().current;
	if (!current || (current.status !== "running" && current.status !== "waiting")) return;
	try {
		await apiSend(`/api/v1/sessions/${current.id}/interrupt`, "POST");
	} catch (error) {
		showError(errorMessage(error));
	}
}

/* ── Bootstrap (legacy IIFE, 3886-3919, and `exchange`, 694-707) ──────────── */

/** Trade the one-time `#token=` from the launch link for the session cookie. */
export async function exchange(): Promise<void> {
	const token = new URLSearchParams(location.hash.slice(1)).get("token");
	if (!token) return;
	try {
		await apiSend("/auth/exchange", "POST", { token });
		history.replaceState(null, "", `${location.pathname}${location.search}`);
	} catch (error) {
		showAuthBanner();
		throw error;
	}
}

export interface BootstrapOptions {
	/** Opens the file tree for `?tree=1` (features/files/actions.ts `openTree`). */
	readonly openTree?: (project: { cwd: string }) => Promise<void>;
}

/**
 * Ask the host who is signed in (name and avatar) for the sidebar footer. A
 * failure keeps the previous answer: the footer falls back to the credential
 * label, so there is nothing to report.
 */
export async function refreshAccount(): Promise<void> {
	try {
		setState({ account: await api<AccountReport>("/api/v1/account") });
	} catch {
		// Decoration only; see above.
	}
}

let bootstrapped = false;
let resumeAfterLogin: (() => void) | undefined;
/**
 * Set once the page has opened or started a conversation itself. Bootstrap keeps
 * awaiting the session list and would otherwise replace a draft or a session the
 * user picked while it was still loading.
 */
let choseSession = false;

/**
 * Close the Desktop sign-in gate with the fresh credential report and let a
 * paused bootstrap continue. Sessions are opened only after this, so none is
 * built while `auth.json` is still empty.
 */
export function completeLogin(login: LoginReport): void {
	setState({ login });
	void refreshAccount();
	setUi({ loginRequired: false });
	const resume = resumeAfterLogin;
	resumeAfterLogin = undefined;
	resume?.();
}

/**
 * Sign in, load workspaces and sessions, then open the most relevant session
 * (or start a draft in the launch folder). Runs once per page load; a second
 * call (React StrictMode double effects) is ignored because the launch token
 * cannot be exchanged twice.
 */
export async function bootstrap(options: BootstrapOptions = {}): Promise<void> {
	if (bootstrapped) return;
	bootstrapped = true;
	try {
		await exchange();
		const boot = await api<BootstrapPayload>("/api/v1/bootstrap");
		setState({
			bootstrapCwd: boot.cwd,
			directoryPicker: boot.directoryPicker === "native" ? "native" : "browse",
			login: boot.login ?? null,
			draftCwd: boot.cwd,
		});
		if (boot.login?.configured) void refreshAccount();
		// Desktop asks for a credential before anything else; a browser host
		// keeps the terminal `step login` path and its banner.
		if (isDesktopHost() && boot.login && !boot.login.configured) {
			await new Promise<void>((resolve) => {
				resumeAfterLogin = resolve;
				setUi({ loginRequired: true });
			});
		}
		await refreshWorkspaces();
		await refreshSessions();
		const sessions = getState().sessions;
		const first =
			sessions.find((session) => !session.archived && session.cwdAvailable !== false && session.cwd === boot.cwd) ??
			sessions.find((session) => !session.archived && session.cwdAvailable !== false);
		// The user may have picked a conversation or started a draft while the lists loaded; that choice wins.
		if (!choseSession) {
			if (first) await openSession(first.id);
			else startDraft(boot.cwd);
		} else if (!getState().current) {
			// That draft was started before `cwd` was known, so its model and preset lists are still missing.
			await loadDraftModels(getState().draftCwd);
		}
		if (location.search.includes("tree=1")) {
			const project = getState().sessions.find(
				(session) => !session.archived && session.cwd && session.cwdAvailable !== false,
			);
			if (project?.cwd && options.openTree) await options.openTree({ cwd: project.cwd });
		}
	} catch (error) {
		showError(errorMessage(error));
	}
}
