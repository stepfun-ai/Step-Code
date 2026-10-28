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
import { arrangementChanged, pruneSessionPreferences, writeSessionPreferences } from "./session-order";
import { type AppState, getState, mapWith, setState, setUi, type ToastState } from "./store";
import { backgroundSubagentStatuses, subagentTasks } from "./subagent-tasks";
import { restoreTagGroups, updateTagGroups } from "./tag-group-persistence";
import { pruneTagGroups, withoutSessionTag } from "./tag-groups";
import { readThinkingTimings } from "./thinking-timing";
import type {
	AccountReport,
	ApprovalRequest,
	BootstrapPayload,
	ChildAgentLink,
	ClarificationRequest,
	ContentPart,
	DraftModels,
	FileChange,
	LoginReport,
	NoticeItem,
	QueueState,
	SelectionRequest,
	SessionEntry,
	SessionLiveStatus,
	SessionRetry,
	SessionSnapshot,
	SessionStatus,
	SessionSummary,
	SideAnswer,
	TextInputRequest,
	ThinkingTimings,
	TimelineItem,
	ToolArgs,
	ToolTimelineItem,
	WebWorkspace,
} from "./types";

/* ── Errors and banners ──────────────────────────────────────────────────── */

let toastTimer: ReturnType<typeof setTimeout> | undefined;
let toastSeq = 0;

/** Notices are page-local command output; keep the newest so a chatty command cannot grow the list forever. */
const NOTICE_LIMIT = 20;
/** Side answers kept per session, matching the host's own bound. */
const SIDE_ANSWER_LIMIT = 30;
/**
 * Answers whose tab the reader closed. The host keeps them (they are its history),
 * so without this a snapshot refresh would resurrect the tab they dismissed.
 */
const dismissedSideAnswers = new Set<string>();

/** Stop restoring one answer's tab after the reader closed it. */
export function forgetSideAnswer(id: string): void {
	dismissedSideAnswers.add(id);
}

/** The answers a snapshot should restore: everything the reader has not closed. */
export function restorableSideAnswers(answers: readonly SideAnswer[]): readonly SideAnswer[] {
	return answers.filter((answer) => !dismissedSideAnswers.has(answer.id));
}
let noticeSeq = 0;

/**
 * Append a command notice to the transcript. Notices are this page's view of
 * `ui.notify`: they are never persisted and never enter the model's context.
 */
/**
 * Goal lifecycle state the right rail's goal panel already shows: a notice
 * would only repeat it as a bubble. Warnings that need a decision still show.
 */
const GOAL_STATUS_NOTICE =
	/^(Goal set: |Goal (paused|resumed|cleared|updated)\.|Goal commands: |Goal: .*\(iteration |Stopped a queued goal turn |Goal .+ is (paused|blocked|usage_limited))/u;

/** Whether a notice only restates goal state the goal panel already renders. */
export function goalStatusNotice(text: string): boolean {
	return GOAL_STATUS_NOTICE.test(text.trim());
}

export function pushNotice(level: NoticeItem["level"], text: string, options?: { readonly markdown?: boolean }): void {
	if (goalStatusNotice(text)) return;
	const current = getState().current;
	noticeSeq += 1;
	const item: NoticeItem = {
		id: `notice-${noticeSeq}`,
		sessionId: current?.id ?? "",
		level,
		text,
		...(options?.markdown ? { markdown: true } : {}),
	};
	setState((state) => ({ notices: [...state.notices, item].slice(-NOTICE_LIMIT) }));
}

/**
 * What opens side answers in the rail. `state/session.ts` must not import a
 * feature (features import it), so the tab actions install themselves here.
 */
let openSideAnswerTab: (answer: SideAnswer) => void = () => {};
let syncSideAnswerTabs: (answers: readonly SideAnswer[]) => void = () => {};
let dropSideAnswerTabs: () => void = () => {};

/** Called once by `features/files/actions.ts`; keeps the reducer free of feature imports. */
export function installSideAnswerTabs(actions: {
	open: (answer: SideAnswer) => void;
	sync: (answers: readonly SideAnswer[]) => void;
	drop: () => void;
}): void {
	openSideAnswerTab = actions.open;
	syncSideAnswerTabs = actions.sync;
	dropSideAnswerTabs = actions.drop;
}

/**
 * What scopes file preview tabs to their session (`features/files/session-scope.ts`).
 * Installed by the files feature for the same reason as the side-answer actions.
 */
let switchPreviewSession: (previousId: string | undefined, nextId: string | undefined) => void = () => {};
let forgetPreviewSession: (sessionId: string) => void = () => {};

/** Called once by `features/files/session-scope.ts`. */
export function installPreviewSessionScope(actions: {
	switch: (previousId: string | undefined, nextId: string | undefined) => void;
	forget: (sessionId: string) => void;
}): void {
	switchPreviewSession = actions.switch;
	forgetPreviewSession = actions.forget;
}

/**
 * File one `/btw` answer: keep it on the session (so the rail can list it) and
 * open it as its own tab, the way asking the question is what the user wanted.
 * The conversation, its entries and the model's context are untouched.
 */
export function applySideAnswer(answer: SideAnswer): void {
	setState((state) => ({
		current: state.current
			? {
					...state.current,
					sideAnswers: [
						...(state.current.sideAnswers ?? []).filter((item) => item.id !== answer.id),
						answer,
					].slice(-SIDE_ANSWER_LIMIT),
				}
			: state.current,
	}));
	openSideAnswerTab(answer);
}

/** Remove one notice the reader dismissed. */
export function dismissNotice(id: string): void {
	setState((state) => ({ notices: state.notices.filter((notice) => notice.id !== id) }));
}

/** Show the top-centre toast for 4.2s (legacy `showError`, 3184-3193). `danger=false` is the neutral tone. */
export function showError(message: string, danger = true): void {
	showToast(message, danger ? "danger" : "neutral");
}

/** A short, self-dismissing announcement. State the UI already draws says nothing else. */
export function showToast(message: string, tone: ToastState["tone"] = "neutral"): void {
	toastSeq += 1;
	const seq = toastSeq;
	setState({ toast: { message, tone, seq } });
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

/**
 * Copy to the clipboard and report the outcome in the toast (legacy `copyText`, 2098-2105).
 * `successText: null` skips the success toast for a button that confirms in place.
 */
export async function copyText(value: string, successText: string | null = t("copied")): Promise<boolean> {
	try {
		await writeClipboard(value);
		if (successText !== null) showError(successText, false);
		return true;
	} catch {
		showError(t("browserCopyDenied"));
		return false;
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

/** A folder the user removed from workspace navigation; its chats stay readable. */
export function isHiddenWorkspace(state: AppState, path: string | undefined): boolean {
	if (!path) return false;
	return state.workspaces.some((workspace) => workspace.hidden === true && workspace.path === path);
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
	return [...values]
		.filter((path) => !isHiddenWorkspace(state, path))
		.sort((left, right) => basename(left).localeCompare(basename(right), "zh-CN"));
}

/** The cwd new work should target: current session, else draft, else launch folder. */
export function activeCwd(state: AppState = getState()): string {
	return state.current?.cwd || state.draftCwd || state.bootstrapCwd;
}

/**
 * The folder the host falls back to for new work when no workspace is on offer.
 * It is the launch folder, or the home folder when the user removed the launch
 * folder from navigation (see the host's `defaultCwd`).
 */
export function defaultProjectCwd(state: AppState = getState()): string {
	return state.defaultCwd || state.bootstrapCwd;
}

/**
 * Whether `path` is the implicit default project instead of a workspace the user
 * registered. That is the home fallback the host reports after the launch folder
 * was removed: the page names it "默认项目" rather than the last user name.
 * Registering the folder turns it back into a normal workspace with its own name.
 */
export function isDefaultProject(state: AppState, path: string | undefined): boolean {
	if (!path || !state.defaultCwdFallback || !state.defaultCwd) return false;
	if (path !== state.defaultCwd) return false;
	return !state.workspaces.some(
		(workspace) => workspace.available && workspace.hidden !== true && workspace.path === path,
	);
}

/**
 * Whether `path` is the first-use workspace the host created under Documents.
 * Its folder name is the fixed, language-neutral `default-workspace`, so the
 * page shows it in the reader's language instead.
 */
export function isDefaultWorkspace(state: AppState, path: string | undefined): boolean {
	if (!path) return false;
	return state.workspaces.some((workspace) => workspace.default === true && workspace.path === path);
}

/**
 * The name to show for a workspace folder: "默认项目" for the fallback folder,
 * "默认工作区" for the first-use workspace, otherwise the folder's own name.
 * Without this the fallback was presented under the last user name, which named
 * neither a workspace nor a project.
 */
export function workspaceLabel(state: AppState, path: string): string {
	if (isDefaultProject(state, path)) return t("defaultProject");
	return isDefaultWorkspace(state, path) ? t("defaultWorkspace") : basename(path);
}

/**
 * Where a new conversation may start when the folder it would have used has
 * been removed from workspace navigation.
 *
 * Removing a workspace keeps its chats, so one of them can still be open and
 * "New conversation" would otherwise inherit that folder through `activeCwd()`.
 * The picker cannot even list a removed folder, so the composer then named a
 * workspace the user had deleted and sent a message into it — and any
 * folder-scoped request (the file tree, git, `@` completion) came back with
 * "Folder is not a known workspace". Prefer the launch folder, then any
 * workspace still on offer.
 *
 * When none of those is on offer the fallback is the host's default workspace
 * (`state.defaultCwd`), not the launch folder: the launch folder is Desktop's
 * last picked folder, which is exactly the folder the user may have just
 * removed, so reusing it made every "New conversation" in an empty workspace
 * list start in the deleted folder. The default is the home folder there.
 */
export function workspaceForNewConversation(state: AppState = getState()): string {
	const wanted = activeCwd(state);
	if (!isHiddenWorkspace(state, wanted)) return wanted;
	if (state.bootstrapCwd && !isHiddenWorkspace(state, state.bootstrapCwd)) return state.bootstrapCwd;
	const offered = knownWorkspaces(state)[0];
	if (offered) return offered;
	if (state.defaultCwd && !isHiddenWorkspace(state, state.defaultCwd)) return state.defaultCwd;
	return state.bootstrapCwd;
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

/** File-changing tools: the built-in names and the Step tool profile's, which Web sessions use. */
const FILE_CHANGE_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "edit_file", "write_file"]);

/**
 * The file change of a finished edit/write call. `edit`, `write` and Step's
 * `edit_file` record a unified patch in their result details; `write` says why
 * when it recorded none. Step's `write_file` records no patch (an untracked
 * change), and `changed: false` when the file already held the content.
 * `result` is the recorded tool result, or a live `tool_execution_end`'s
 * result with the event's own `isError`.
 */
function fileChange(
	name: string,
	args: unknown,
	result: { readonly details?: unknown; readonly isError?: boolean } | undefined,
): FileChange | undefined {
	if (!FILE_CHANGE_TOOLS.has(name) || !result || result.isError) return undefined;
	const details = (result.details ?? {}) as {
		patch?: unknown;
		untracked?: unknown;
		changed?: unknown;
	};
	if (details.changed === false) return undefined;
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

/**
 * The proposal an `exit_plan_mode` call submitted.
 *
 * `details` is the only structured copy: the plan file may change afterwards,
 * and `planHash` is what binds a decision to the text the user reviewed. A
 * result without those fields is a guard result ("not in plan mode", unreadable
 * file), which stays a plain tool row.
 */
export function planReview(details: unknown): Pick<ToolTimelineItem, "planReview"> {
	if (!details || typeof details !== "object") return {};
	const value = details as {
		planFilePath?: unknown;
		planContents?: unknown;
		planHash?: unknown;
		outcome?: unknown;
	};
	if (
		typeof value.planFilePath !== "string" ||
		typeof value.planContents !== "string" ||
		typeof value.planHash !== "string"
	) {
		return {};
	}
	const outcome = value.outcome;
	if (
		outcome !== "approved" &&
		outcome !== "feedback" &&
		outcome !== "dismissed" &&
		outcome !== "external_approval_required"
	) {
		return {};
	}
	return {
		planReview: {
			planFilePath: value.planFilePath,
			planContents: value.planContents,
			planHash: value.planHash,
			outcome,
			// Only a handoff to the user is actionable; the other outcomes were
			// already resolved inside a host that could ask.
			pending: outcome === "external_approval_required",
		},
	};
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
 * How many conversational messages a compaction replaced: everything since the
 * previous compaction, before the first entry this one keeps. Earlier summaries
 * are not counted again. The branch still holds the summarized entries, so this
 * counts the transcript rows the summary stands in for, not the session file.
 */
function compactedMessageCount(
	entries: readonly SessionEntry[],
	compactionIndex: number,
	firstKeptEntryId: unknown,
): number {
	// An earlier compaction already accounts for everything before it.
	let start = 0;
	for (let index = compactionIndex - 1; index >= 0; index -= 1) {
		if (entries[index]?.type === "compaction") {
			start = index + 1;
			break;
		}
	}
	const keptIndex =
		typeof firstKeptEntryId === "string" ? entries.findIndex((entry) => entry.id === firstKeptEntryId) : -1;
	const end = keptIndex >= 0 && keptIndex < compactionIndex ? keptIndex : compactionIndex;
	let count = 0;
	for (const entry of entries.slice(start, end)) {
		if (entry.type === "message" && (entry.message?.role === "user" || entry.message?.role === "assistant")) {
			count += 1;
		}
	}
	return count;
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
	/*
	 * A command that expands into its own user message (`/plan <task>`) journals
	 * the task twice — once as the host's echo, once as the message the kernel
	 * sends. The echo carries the badge, so the identical message that follows
	 * it is dropped from the timeline (it stays journaled for the model).
	 */
	let echoArgs: string | null = null;
	// Separators seen so far, for labelling a round whose projected number is missing.
	let goalRounds = 0;
	const toolResults = new Map<string, NonNullable<SessionEntry["message"]>>();
	for (const entry of entries) {
		if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolCallId) {
			toolResults.set(entry.message.toolCallId, entry.message);
		}
	}
	const messages = entries.filter((entry) => entry.type === "message" && entry.message);
	const messagePosition = new Map(messages.map((entry, index) => [entry.id, index]));
	for (const [entryIndex, entry] of entries.entries()) {
		if (entry.type === "compaction") {
			items.push({
				itemId: `compaction-${entry.id}`,
				kind: "compaction",
				summary: typeof entry.summary === "string" ? entry.summary : "",
				...(typeof entry.tokensBefore === "number" ? { tokensBefore: entry.tokensBefore } : {}),
				removedMessages: compactedMessageCount(entries, entryIndex, entry.firstKeptEntryId),
				...(typeof entry.timestamp === "string" ? { timestamp: entry.timestamp } : {}),
			});
			continue;
		}
		// The host's echo of a kernel slash command: the transcript's only record of the typed line.
		if (entry.type === "custom" && entry.customType === "stepcode-web.command-echo") {
			const command = typeof entry.command === "string" ? entry.command : "";
			if (command) {
				items.push({
					itemId: `command-${entry.id}`,
					kind: "command",
					entryId: entry.id,
					command,
					...(typeof entry.timestamp === "string" ? { timestamp: entry.timestamp } : {}),
				});
				echoArgs = /^\/[A-Za-z0-9][\w.:-]*\s*([\s\S]*)$/u.exec(command)?.[1]?.trim() || null;
			}
			continue;
		}
		// The goal's continuation message starts the next round; the flow marks
		// it with a separator so a run reads as rounds, not one long stream.
		if (entry.type === "custom_message" && entry.customType === "step-goal") {
			goalRounds += 1;
			const projected = entry.goalRound;
			items.push({
				itemId: `goal-round-${entry.id}`,
				kind: "goal-round",
				round: typeof projected === "number" && projected > 0 ? projected : goalRounds + 1,
				...(typeof entry.timestamp === "string" ? { timestamp: entry.timestamp } : {}),
			});
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (!message || message.role === "toolResult") continue;
		if (message.role === "user" && echoArgs !== null) {
			const duplicate = contentText(message.content).trim() === echoArgs;
			echoArgs = null;
			if (duplicate) continue;
		}
		const index = messagePosition.get(entry.id) ?? 0;
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
			// A prompt command's expansion is shown as the line the user typed.
			const promptCommand =
				message.role === "user" && typeof entry.promptCommand === "string" && entry.promptCommand
					? entry.promptCommand
					: undefined;
			// Every user message opens a turn (the host's turn boundary), even one without text.
			items.push({
				itemId: `message-${entry.id}`,
				entryId: entry.id,
				kind: "message",
				role: message.role,
				content: promptCommand ?? text,
				...(promptCommand ? { promptCommand: true } : {}),
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
				const change = fileChange(String(block.name ?? ""), block.arguments, result);
				const links = childAgents(String(block.name ?? ""), result?.details);
				items.push({
					itemId: `tool-${block.id}`,
					kind: "tool",
					state: result?.isError ? "failed" : result ? "completed" : "pending",
					toolName: String(block.name ?? ""),
					inputSummary: toolInputSummary(block.arguments),
					outputSummary: result ? compact(contentText(result.content)) : "",
					inputDetail: toolInputDetail(block.arguments),
					outputDetail: result ? clipDetail(contentText(result.content)) : "",
					...withArgs(block.arguments),
					...(change ? { change } : {}),
					...links,
					// The proposal comes from the persisted result, not the live event, so
					// a snapshot refresh (which follows every finished message) keeps the
					// review card. Without this it flashed once and vanished.
					...(block.name === "exit_plan_mode" ? planReview(result?.details) : {}),
					...(block.name === "subagent"
						? {
								subagentTasks: subagentTasks(
									block.arguments,
									result?.details,
									result?.isError ? "failed" : result ? "completed" : "pending",
									[],
									// A rejected dispatch reports no per-task result: its error is the
									// only account of why the run did not happen.
									result?.isError ? clipDetail(contentText(result.content)) : undefined,
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
	const rows = items.map((item) =>
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
	return settlePlanReviews(rows);
}

/**
 * A plan review is actionable only while nothing has superseded it.
 *
 * Each decision the card sends is an ordinary user message, so a user message
 * after the proposal is the decision. A newer `exit_plan_mode` proposal
 * supersedes an older one. The card itself stays in the transcript as the
 * record of that round; it just stops offering buttons.
 */
function settlePlanReviews(items: TimelineItem[]): TimelineItem[] {
	let latest = -1;
	items.forEach((item, index) => {
		if (item.kind === "tool" && item.planReview) latest = index;
	});
	if (latest < 0) return items;
	const decided = items.some((item, index) => index > latest && item.kind === "message" && item.role === "user");
	return items.map((item, index) => {
		if (item.kind !== "tool" || !item.planReview) return item;
		const pending = item.planReview.pending && index === latest && !decided;
		return pending === item.planReview.pending ? item : { ...item, planReview: { ...item.planReview, pending } };
	});
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

/**
 * Newest stream revision seen per session. Status and agent events are pushed,
 * so they are newer than an HTTP snapshot that was serialized before them; the
 * revision is what tells the two apart (see `renderSnapshot`).
 */
const streamRevisions = new Map<string, number>();

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
 * `adoptDraft` marks the session a draft just became: what the draft opened in
 * the rail (files, a waiting side answer) is that session's, so it stays.
 * `fromStream` marks the snapshot this page's own stream opened with: it is the
 * connection's current state, not a read that may have been overtaken.
 * `fromAction` marks the answer to a mutation this page asked for (a policy or
 * model change, answering a dialog): its fields carry that action, so a stream
 * event that overtook it makes the page re-read rather than discard it.
 */
export function renderSnapshot(
	snapshot: SessionSnapshot,
	options: { readonly adoptDraft?: boolean; readonly fromStream?: boolean; readonly fromAction?: boolean } = {},
): void {
	const newest = streamRevisions.get(snapshot.id);
	// A stop is a stream event: a snapshot read issued while the turn still ran
	// describes a state the page has already left. Painting it back restored the
	// running status and the stop control after the stop.
	const overtaken =
		!options.fromStream && snapshot.revision !== undefined && newest !== undefined && snapshot.revision < newest;
	// An answer to this page's own action still carries the change the user asked
	// for, so it is applied even when a stream event overtook it; only the fields
	// the stream owns (transcript, run status, its clock) are held back.
	if (overtaken && !options.fromAction) return;
	const holdStream = overtaken;
	if (snapshot.revision !== undefined) {
		streamRevisions.set(
			snapshot.id,
			options.fromStream ? snapshot.revision : Math.max(snapshot.revision, newest ?? 0),
		);
	}
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
	const previousSessionId = getState().current?.id;
	setState((state) => {
		const live = state.current?.id === snapshot.id ? state.current : undefined;
		const timelineItems = holdStream
			? state.timelineItems
			: [...timelineFromEntries(snapshot.entries, snapshot.retry), ...approvalItems(snapshot)];
		const pendingTurn = holdStream
			? state.pendingTurn
			: state.pendingTurn && countUserMessages(timelineItems) > state.pendingTurn.userCount
				? null
				: state.pendingTurn;
		// The stream reported a newer run than this answer describes.
		const current =
			holdStream && live
				? {
						...snapshot,
						status: live.status,
						unread: live.unread,
						compacting: live.compacting,
						queuedMessages: live.queuedMessages,
						steeringMessages: live.steeringMessages,
					}
				: snapshot;
		return {
			current,
			performanceRun: !holdStream && state.current?.id !== snapshot.id ? null : state.performanceRun,
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
			statusById: holdStream ? state.statusById : mapWith(state.statusById, snapshot.id, snapshot.status),
			unreadById: holdStream ? state.unreadById : mapWith(state.unreadById, snapshot.id, false),
			sessions: mergeSessionSummary(state.sessions, current),
			timelineItems,
			pendingTurn,
			// The snapshot is authoritative when the page (re)loads; live
			// `compaction_start` / `compaction_end` events refine it afterwards.
			compacting: holdStream ? state.compacting : snapshot.compacting === true,
		};
	});
	// File tabs and side answers belong to one session, so the previous session's
	// are put away before this session's are restored; another session's file
	// must never sit beside this conversation as if it were its output. A
	// reloaded page then shows the side-answer history again.
	if (previousSessionId !== snapshot.id && !options.adoptDraft) {
		switchPreviewSession(previousSessionId, snapshot.id);
		dropSideAnswerTabs();
	}
	syncSideAnswerTabs(restorableSideAnswers(snapshot.sideAnswers ?? []));
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
	setState({ performanceRun: null, compacting: false });
	liveApprovals.clear();
	liveClarifications.clear();
	resolvedClarifications.clear();
	streamRevisions.clear();
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
	/** `compaction_start` / `compaction_end` carry the reason and, on failure, the message. */
	readonly reason?: string;
	readonly errorMessage?: string;
}

/** Remember the newest revision this page has applied for `id`. */
function noteRevision(id: string, revision: number | undefined): void {
	if (revision === undefined || !Number.isSafeInteger(revision)) return;
	streamRevisions.set(id, Math.max(revision, streamRevisions.get(id) ?? 0));
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

function handleAgentEvent(
	agentEvent: AgentStreamEvent,
	thinkingTimings?: ThinkingTimings,
	promptCommand?: string,
): void {
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
	if (agentEvent.type === "compaction_start") {
		// A manual compaction is answered by the compaction row, not by a turn, so
		// the bubble drawn for `/compact` goes away. A threshold/overflow
		// compaction happens inside a real turn (before `agent_start` is even
		// announced), and that bubble must survive it.
		const manual = agentEvent.reason === "manual";
		setState({ compacting: true, ...(manual ? { pendingTurn: null } : {}) });
	}
	if (agentEvent.type === "compaction_end") {
		setState({ compacting: false });
		// A refusal or a failed summarization is command output: say why, where
		// the command was typed. The row itself appears from the session entry.
		if (agentEvent.errorMessage) pushNotice("warning", agentEvent.errorMessage);
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
		// its message_end replaces this row with the recorded entry. A prompt
		// command shows as the line the user typed, not the template it became.
		const content = promptCommand ?? contentText(agentEvent.message.content);
		const images = imageSources(agentEvent.message.content);
		setState((state) => ({
			pendingTurn: null,
			timelineItems: upsertItem(state.timelineItems, {
				itemId: "message-user-live",
				kind: "message",
				role: "user",
				content,
				...(promptCommand ? { promptCommand: true } : {}),
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
			// The end event carries no arguments: the row kept the path from the start event.
			// Without this the turn's changes stayed empty until a snapshot read succeeded.
			change: fileChange(
				item.toolName,
				item.args,
				agentEvent.result && { details: agentEvent.result.details, isError: agentEvent.isError === true },
			),
			...childAgents(item.toolName, agentEvent.result?.details),
			...(item.toolName === "exit_plan_mode" ? planReview(agentEvent.result?.details) : {}),
			...(item.toolName === "subagent"
				? {
						subagentTasks: subagentTasks(
							undefined,
							agentEvent.result?.details,
							agentEvent.isError ? "failed" : "completed",
							item.subagentTasks,
							agentEvent.isError ? clipDetail(output) : undefined,
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
		// The compaction entry is written without `entry_appended`; the end event
		// is what makes the new row and the lowered context usage visible.
		agentEvent.type === "compaction_end" ||
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
	// A new stream is a new order: its own snapshot is the current state, and the
	// revisions this page saw before it belong to a connection that is gone.
	streamRevisions.delete(id);
	const source = new EventSource(`/api/v1/sessions/${id}/events`);
	stream = source;
	source.addEventListener("snapshot", (event) => {
		if (stream === source) renderSnapshot(JSON.parse((event as MessageEvent).data), { fromStream: true });
	});
	source.addEventListener("agent", (event) => {
		if (stream !== source) return;
		const payload = JSON.parse((event as MessageEvent).data) as {
			event: AgentStreamEvent;
			thinkingTimings?: unknown;
			promptCommand?: unknown;
			revision?: number;
		};
		noteRevision(id, payload.revision);
		const promptCommand =
			typeof payload.promptCommand === "string" && payload.promptCommand ? payload.promptCommand : undefined;
		handleAgentEvent(payload.event, readThinkingTimings(payload.thinkingTimings), promptCommand);
	});
	source.addEventListener("status", (event) => {
		if (stream !== source) return;
		const payload = JSON.parse((event as MessageEvent).data) as {
			status: SessionStatus;
			unread: boolean;
			revision?: number;
		};
		noteRevision(id, payload.revision);
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
		if (stream !== source) return;
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
	source.addEventListener("text_input_required", (event) => {
		const request = JSON.parse((event as MessageEvent).data).input as TextInputRequest;
		if (stream !== source || request.sessionId !== id) return;
		setState((state) => ({
			current:
				state.current?.id === id
					? {
							...state.current,
							pendingTextInputs: [
								...(state.current.pendingTextInputs ?? []).filter((item) => item.id !== request.id),
								request,
							],
						}
					: state.current,
		}));
	});
	source.addEventListener("text_input_resolved", (event) => {
		if (stream !== source) return;
		const requestId = JSON.parse((event as MessageEvent).data).id as string;
		setState((state) => ({
			current:
				state.current?.id === id
					? {
							...state.current,
							pendingTextInputs: (state.current.pendingTextInputs ?? []).filter((item) => item.id !== requestId),
						}
					: state.current,
		}));
	});
	// Command output (`ui.notify`). It is a notice row, not a message: it never
	// enters the session file, so it lives for this page load only.
	source.addEventListener("notice", (event) => {
		if (stream !== source) return;
		const notice = JSON.parse((event as MessageEvent).data) as {
			level?: string;
			text?: string;
			markdown?: boolean;
			transient?: boolean;
		};
		if (typeof notice.text !== "string" || !notice.text) return;
		const level =
			notice.level === "warning" || notice.level === "error" || notice.level === "info" ? notice.level : "info";
		if (notice.transient) {
			// An announcement about state the UI already renders (plan mode, the
			// permission tier): show it, then let it go. It must not become a row in
			// a conversation the user did not send anything to.
			showToast(notice.text, level === "error" ? "danger" : "neutral");
			return;
		}
		pushNotice(level, notice.text, notice.markdown ? { markdown: true } : undefined);
		// A command answered in place (`/btw`, `/status`, a refusal) starts no turn,
		// so the optimistic bubble that `sendMessage` drew would otherwise sit
		// under a "thinking" indicator forever. Only a command can be answered
		// this way: a prompt's notices (session start, permission) belong to a
		// turn whose bubble must stay until its message is recorded.
		setState((state) => ({
			pendingTurn: /^\s*\/[A-Za-z0-9]/u.test(state.pendingTurn?.text ?? "") ? null : state.pendingTurn,
		}));
	});
	// A `/btw` answer: its own tab in the rail, never a transcript row.
	source.addEventListener("side-answer", (event) => {
		if (stream !== source) return;
		const answer = JSON.parse((event as MessageEvent).data).answer as SideAnswer;
		if (!answer || typeof answer.id !== "string") return;
		applySideAnswer(answer);
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

/**
 * Sessions this page created that the host does not list yet. The host lists
 * session files, so a session appears as soon as its first prompt is written;
 * a draft that was created but never sent still needs the optimistic row.
 */
const unlistedSessions = new Set<string>();

/** Stop keeping `id` in the list before the host lists it (it was deleted). */
export function forgetUnlistedSession(id: string): void {
	unlistedSessions.delete(id);
}

/**
 * A session the host deleted is forgotten completely: its optimistic row, the
 * group tag it carried and its place in the sidebar arrangement. The tag is a
 * record about that session, so leaving it behind kept a group in the picker
 * that no session could ever name again; a place or a pin would outlive the row
 * it belongs to.
 */
export function forgetDeletedSession(id: string): void {
	forgetUnlistedSession(id);
	const state = getState();
	const arrangement = pruneSessionPreferences(
		state,
		new Set(state.sessions.map((session) => session.id).filter((sessionId) => sessionId !== id)),
	);
	if (arrangementChanged(state, arrangement)) writeSessionPreferences(arrangement);
	updateTagGroups((groups) => withoutSessionTag(groups, id));
	setState({
		pinnedSessions: arrangement.pinnedSessions,
		sessionOrder: arrangement.sessionOrder,
	});
}

let sessionListRequest = 0;
let sessionListApplied = 0;

/** Reload the list immediately; successful recovery only gates the later group prune. */
export async function refreshSessions(): Promise<void> {
	const request = ++sessionListRequest;
	const recovery = restoreTagGroups();
	const data = await api<{ sessions: SessionSummary[] }>("/api/v1/sessions");
	if (request < sessionListApplied) return;
	sessionListApplied = request;
	// The arrangement is pruned against what the list will hold, so a deleted
	// session cannot keep a pin or a dragged place that no row can clear.
	const before = getState();
	const listed = new Set(data.sessions.map((session) => session.id));
	for (const id of listed) unlistedSessions.delete(id);
	const keptBefore = before.sessions.filter((session) => unlistedSessions.has(session.id));
	const presentBefore = new Set([...keptBefore, ...data.sessions].map((session) => session.id));
	if (before.current) presentBefore.add(before.current.id);
	const arrangement = pruneSessionPreferences(before, presentBefore);
	if (arrangementChanged(before, arrangement)) writeSessionPreferences(arrangement);
	setState((state) => {
		const kept = state.sessions.filter((session) => unlistedSessions.has(session.id));
		const live = data.sessions.flatMap((session): SessionLiveStatus[] =>
			session.status ? [{ id: session.id, status: session.status, unread: session.unread === true }] : [],
		);
		return {
			sessions: [...kept, ...data.sessions],
			...foldLiveStatuses(state, live, listed),
			pinnedSessions: arrangement.pinnedSessions,
			sessionOrder: arrangement.sessionOrder,
		};
	});
	void recovery.then((restored) => {
		if (!restored || request !== sessionListApplied) return;
		updateTagGroups((groups) => {
			// Re-evaluate selection and the latest successful list before and after a pruning save.
			const state = getState();
			const present = new Set(state.sessions.map((session) => session.id));
			if (state.current) present.add(state.current.id);
			return pruneTagGroups(groups, present);
		}, true);
	});
}

/** Keep the open session's snapshot in step with a row action done from a menu. */
function patchCurrentSession(id: string, fields: Partial<SessionSummary>): void {
	setState((state) => (state.current?.id === id ? { current: { ...state.current, ...fields } } : {}));
}

export type SessionAction = "rename" | "archive" | "delete";

/** Close `#renameSessionDialog`; ignored while its request runs, so the result still lands. */
export function closeRenameSession(): void {
	if (getState().ui.renameSession?.pending) return;
	setUi({ renameSession: null });
}

/**
 * Submit `#renameSessionDialog`. The dialog closes once the host accepted the name; a failure keeps it
 * open with the typed name so the user can retry, and reports the error in the toast. A late success
 * only closes the dialog it belongs to, and a failed list refresh does not turn into a failed rename.
 */
export async function renameSession(name: string): Promise<void> {
	const target = getState().ui.renameSession;
	const trimmed = name.trim();
	if (!target || target.pending || !trimmed) return;
	setUi({ renameSession: { ...target, pending: true } });
	try {
		// The host trims the name to its own limit; the returned snapshot is what it stored.
		const saved = await apiSend<SessionSummary>(`/api/v1/sessions/${target.sessionId}/name`, "PATCH", {
			name: trimmed,
		});
		patchCurrentSession(target.sessionId, { name: saved.name?.trim() || trimmed });
	} catch (error) {
		setUi((ui) =>
			ui.renameSession?.sessionId === target.sessionId ? { renameSession: { ...target, pending: false } } : {},
		);
		showError(errorMessage(error));
		return;
	}
	setUi((ui) => (ui.renameSession?.sessionId === target.sessionId ? { renameSession: null } : {}));
	// The rename already succeeded; a failed list refresh must not report it as a failure.
	await refreshSessions().catch(() => {});
}

/**
 * Rename / archive / delete one session (legacy `openSessionMenu` click
 * handler, 1297-1328). Called from the sidebar's row menu and the
 * conversation header's menu. Rename only opens `#renameSessionDialog`
 * (`renameSession` saves); archive and delete patch the open session's
 * snapshot so the header does not wait for the next SSE snapshot.
 */
export async function runSessionAction(action: SessionAction, session: SessionSummary): Promise<void> {
	try {
		if (action === "rename") {
			// The dialog submits through renameSession; nothing changed yet, so there is nothing to refresh.
			setUi({ renameSession: { sessionId: session.id, name: sessionTitle(session), pending: false } });
			return;
		}
		if (action === "archive") {
			const archived = !session.archived;
			await apiSend(`/api/v1/sessions/${session.id}/archive`, "PATCH", { archived });
			patchCurrentSession(session.id, { archived });
		}
		if (action === "delete" && window.confirm(t("confirmDelete", { name: sessionTitle(session) }))) {
			await apiSend(`/api/v1/sessions/${session.id}`, "DELETE");
			forgetDeletedSession(session.id);
			const state = getState();
			if (state.current?.id === session.id) startDraft(state.bootstrapCwd);
			// After leaving it: leaving a session stashes its tabs.
			forgetPreviewSession(session.id);
		}
		await refreshSessions();
	} catch (error) {
		showError(errorMessage(error));
	}
}

/**
 * Re-read the host's status of the sessions this page does not follow. Their
 * rows otherwise keep whatever status they had when the page left them, so a
 * run that ended in the background would still read "running".
 */
export async function refreshSessionStatuses(): Promise<void> {
	const data = await api<{ sessions: SessionLiveStatus[] }>("/api/v1/session-status");
	setState((state) => {
		const known = new Set([...state.statusById.keys(), ...state.unreadById.keys()]);
		for (const entry of data.sessions) known.add(entry.id);
		return foldLiveStatuses(state, data.sessions, known);
	});
}

/**
 * Status and unread flags with the host's `live` answer applied to every
 * session in `known` (the sessions that answer covers). One of them missing
 * from `live` is not open in the host: nothing runs there and nothing is
 * unread, so its row falls back to its saved state. The session this page
 * follows is left alone; its own stream is the fresher source.
 */
export function foldLiveStatuses(
	state: Pick<AppState, "current" | "statusById" | "unreadById">,
	live: readonly SessionLiveStatus[],
	known: Iterable<string>,
): Pick<AppState, "statusById" | "unreadById"> {
	const byId = new Map(live.map((entry) => [entry.id, entry]));
	const statusById = new Map(state.statusById);
	const unreadById = new Map(state.unreadById);
	for (const id of known) {
		if (id === state.current?.id) continue;
		const entry = byId.get(id);
		if (entry) {
			statusById.set(id, entry.status);
			unreadById.set(id, entry.unread);
		} else {
			statusById.delete(id);
			unreadById.delete(id);
		}
	}
	return { statusById, unreadById };
}

/** A session this page does not follow is still running or waiting, as far as the page knows. */
export function backgroundSessionBusy(state: Pick<AppState, "current" | "statusById">): boolean {
	for (const [id, status] of state.statusById) {
		if (id !== state.current?.id && (status === "running" || status === "waiting")) return true;
	}
	return false;
}

/** Reload the current session's snapshot (legacy `refreshCurrent`, 3117-3120). */
export async function refreshCurrent(): Promise<void> {
	const current = getState().current;
	if (!current) return;
	const snapshot = await api<SessionSnapshot>(`/api/v1/sessions/${current.id}`);
	if (getState().current?.id === current.id) renderSnapshot(snapshot);
}

/**
 * Reload the registered workspaces and the host's default workspace (legacy
 * `refreshWorkspaces`, 1984-1987). The default comes along because removing the
 * launch folder changes it mid-session, and the reroute that follows a removal
 * has to land in the folder that replaced it.
 */
export async function refreshWorkspaces(): Promise<void> {
	const data = await api<{
		workspaces: WebWorkspace[];
		defaultCwd?: string;
		defaultCwdFallback?: boolean;
	}>("/api/v1/workspaces");
	setState((state) => ({
		workspaces: data.workspaces,
		defaultCwd: typeof data.defaultCwd === "string" && data.defaultCwd ? data.defaultCwd : state.defaultCwd,
		defaultCwdFallback:
			typeof data.defaultCwdFallback === "boolean" ? data.defaultCwdFallback : state.defaultCwdFallback,
	}));
}

/** Open a session and follow its stream (legacy `openSession`, 3122-3130). */
export async function openSession(id: string): Promise<void> {
	choseSession = true;
	// The draft this page left behind is gone: it was never a session, so its
	// placeholder row must not survive under the workspace it named.
	setUi({ midView: null, childView: null, openingSession: id, draftRow: null });
	setState({ pendingTurn: null });
	try {
		const snapshot = await api<SessionSnapshot>(`/api/v1/sessions/${id}`);
		// A later pick owns the pane; this answer arriving late must not repaint it.
		if (getState().ui.openingSession !== id) return;
		renderSnapshot(snapshot);
		connectStream(id);
	} catch (error) {
		if (getState().ui.openingSession === id) showError(errorMessage(error));
	} finally {
		if (getState().ui.openingSession === id) setUi({ openingSession: null });
	}
}

/** Ask the composer to focus `#prompt`. */
export function requestPromptFocus(): void {
	setUi((ui) => ({ promptFocusRequest: ui.promptFocusRequest + 1 }));
}

/**
 * Leave the current session and start an unsaved draft in `cwd` (legacy
 * `startDraft`, 3132-3151). The session is created on the first send.
 * `listed` marks a conversation the user asked for, so the sidebar shows a
 * placeholder row for it right away instead of only after the first send.
 */
export function startDraft(cwd: string = getState().bootstrapCwd, options: { readonly listed?: boolean } = {}): void {
	choseSession = true;
	closeStream();
	// A new conversation shows none of the session it leaves in the rail.
	const leaving = getState().current?.id;
	if (leaving) {
		switchPreviewSession(leaving, undefined);
		dropSideAnswerTabs();
	}
	const draftCwd = cwd || getState().bootstrapCwd;
	// A folder removed from workspace navigation keeps its chats but is no
	// target for new work; see `workspaceForNewConversation`.
	const startIn = isHiddenWorkspace(getState(), draftCwd) ? workspaceForNewConversation() : draftCwd;
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
			draftCwd: startIn,
		};
	});
	// A new conversation replaces whatever covers the pane (cron / plugin market, a child agent),
	// and a session still loading from an earlier pick.
	setUi({ midView: null, childView: null, openingSession: null, draftRow: options.listed ? startIn : null });
	requestPromptFocus();
	void loadDraftModels(startIn);
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
 * Re-read the host's model catalog after a settings visit: a model provider
 * added or removed there must reach the picker without a new conversation.
 * The open session re-reads `models.json` in place; a draft simply asks again.
 */
export async function refreshModelCatalog(): Promise<void> {
	const state = getState();
	if (state.current) {
		try {
			renderSnapshot(await apiSend<SessionSnapshot>(`/api/v1/sessions/${state.current.id}/models/refresh`, "POST"), {
				fromAction: true,
			});
		} catch (error) {
			showError(errorMessage(error));
		}
		return;
	}
	await loadDraftModels(state.draftCwd || state.bootstrapCwd);
}

/**
 * The current session, creating it from the draft (cwd, policy, model,
 * thinking level) when there is none yet (legacy `createSessionIfNeeded`,
 * 3153-3182). `firstMessage` titles the new sidebar row until the host lists it.
 */
export async function createSessionIfNeeded(firstMessage?: string): Promise<SessionSnapshot> {
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
	// Show the row now, titled by the message being sent; the host lists the
	// session once its first prompt is written (see `unlistedSessions`).
	unlistedSessions.add(snapshot.id);
	const now = new Date().toISOString();
	setState((current) => ({
		sessions: mergeSessionSummary(current.sessions, {
			id: snapshot.id,
			cwd: snapshot.cwd,
			created: now,
			modified: now,
			...(firstMessage ? { firstMessage } : {}),
		}),
	}));
	// The real row replaces the draft placeholder.
	setUi({ draftRow: null });
	renderSnapshot(snapshot, { adoptDraft: true });
	connectStream(snapshot.id);
	void refreshSessions().catch(() => {});
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
 * Close the sign-in gate without a Step credential (bring your own key).
 *
 * Step is not required: a user may run custom models from `models.json`
 * instead. Bootstrap continues as after a sign-in; the caller opens the place
 * where those models are configured.
 */
export function continueWithoutLogin(): void {
	setUi({ loginRequired: false });
	const resume = resumeAfterLogin;
	resumeAfterLogin = undefined;
	resume?.();
}

/**
 * Whether bootstrap must wait behind the sign-in gate.
 *
 * Only when no model can run at all: no Step credential and no usable custom
 * model. Desktop asks on every such start; plain Web keeps its terminal
 * `step login` path and asks only after an explicit sign-out from the page.
 */
export function signInGateNeeded(input: {
	readonly desktop: boolean;
	readonly signedOut: boolean;
	readonly login: LoginReport | null;
	readonly customModels: boolean;
}): boolean {
	if (!input.login || input.login.configured || input.customModels) return false;
	return input.desktop || input.signedOut;
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
		// A Step sign-out may have completed only partially; its notice survives
		// the reload that removed the credential.
		if (typeof sessionStorage !== "undefined") {
			const notice = sessionStorage.getItem("stepcode:logoutNotice");
			if (notice) {
				sessionStorage.removeItem("stepcode:logoutNotice");
				showError(notice, false);
			}
		}
		const boot = await api<BootstrapPayload>("/api/v1/bootstrap");
		setState({
			bootstrapCwd: boot.cwd,
			// The launch folder unless the user removed it; then the host reports
			// the home fallback the page names "默认项目".
			defaultCwd: boot.defaultCwd || boot.cwd,
			defaultCwdFallback: boot.defaultCwdFallback === true,
			directoryPicker: boot.directoryPicker === "native" ? "native" : "browse",
			login: boot.login ?? null,
			draftCwd: boot.cwd,
			// Only what the host actually reported: an absent field stays absent
			// rather than being invented from the page's own bundle.
			build: {
				...(typeof boot.version === "string" && boot.version ? { version: boot.version } : {}),
				...(typeof boot.buildTime === "string" && !Number.isNaN(Date.parse(boot.buildTime))
					? { madeAt: boot.buildTime }
					: {}),
			},
		});
		if (boot.login?.configured) void refreshAccount();
		// An explicit Step sign-out in plain Web sets this so the page asks for a
		// credential instead of opening sessions that cannot call a model. A first
		// visit still keeps the terminal `step login` path and its banner.
		const signedOut =
			typeof sessionStorage !== "undefined" && sessionStorage.getItem("stepcode:signInRequired") === "1";
		if (signedOut && typeof sessionStorage !== "undefined") sessionStorage.removeItem("stepcode:signInRequired");
		if (
			signInGateNeeded({
				desktop: isDesktopHost(),
				signedOut,
				login: boot.login ?? null,
				customModels: boot.customModels === true,
			})
		) {
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
	} finally {
		// The pane stops loading here even when a step failed: from now on an empty stream is an empty conversation.
		setState({ booted: true });
	}
}
