/**
 * Client-side shapes of what the StepCode Web host returns. They mirror
 * apps/web/src (runtime.ts snapshot(), files.ts, workspaces.ts, login.ts,
 * approval.ts) loosely: the client tolerates missing optional fields exactly as
 * the legacy app.js did.
 */

import type { TagColor } from "../i18n/messages";

/** Host-owned interactive shells; independent of Agent tool execution. */
export interface TerminalInfo {
	readonly id: string;
	readonly cwd: string;
	readonly title: string;
	readonly shell: string;
	readonly status: "starting" | "running" | "exited" | "failed";
	readonly cols: number;
	readonly rows: number;
	readonly pid?: number;
	readonly exitCode?: number;
	readonly error?: string;
}
export type TerminalSupport = { readonly available: true } | { readonly available: false; readonly reason: string };
export interface TerminalSnapshot {
	readonly info: TerminalInfo;
	readonly seq: number;
	readonly truncated: boolean;
	readonly chunks: readonly { readonly seq: number; readonly data: string }[];
}

/** Host-wide embedded-browser projection, independent of model sessions. */
export interface EmbeddedBrowserTab {
	readonly id: string;
	readonly title: string;
	readonly url: string;
	readonly loading: boolean;
	readonly canGoBack: boolean;
	readonly canGoForward: boolean;
	readonly zoom: number;
	readonly error?: string;
	readonly notice?: "download" | "upload" | "dialog" | "popup" | "navigation";
}
export interface EmbeddedBrowserSnapshot {
	readonly revision: number;
	readonly activeId: string | null;
	readonly tabs: readonly EmbeddedBrowserTab[];
}
export interface EmbeddedBrowserFrame {
	readonly tabId: string;
	/** The page's CSS viewport; pointer coordinates use this space. */
	readonly width: number;
	readonly height: number;
	/** The whole captured image; the page is its top-left `width` x `height`. Older hosts omit it. */
	readonly surfaceWidth?: number;
	readonly surfaceHeight?: number;
	readonly data: string;
}

export type SessionStatus = "idle" | "running" | "waiting" | "completed" | "failed";

export interface ModelRef {
	readonly provider: string;
	readonly id: string;
}

export interface ModelInfo extends ModelRef {
	readonly name?: string;
	readonly api?: string;
	readonly reasoning?: boolean;
	readonly contextWindow?: number;
	readonly maxTokens?: number;
	readonly input?: readonly string[];
	readonly cost?: unknown;
	/** Thinking levels this model supports (runtime.ts `projectModel`). */
	readonly thinkingLevels?: readonly string[];
}

/** GET /api/v1/models: what a new session in a folder would start on (runtime.ts `predictDraftModel`). */
export interface DraftModels {
	readonly model?: ModelRef;
	readonly thinkingLevel?: string;
	readonly availableThinkingLevels: readonly string[];
	readonly models: readonly ModelInfo[];
	/** The tier the Step settings name for this folder; a new session starts on it. */
	readonly permissionPreset?: string;
	/** The presets the picker offers, so a draft lists them before any session exists. */
	readonly policies?: readonly PolicyPreset[];
	/** Full Access was granted with "don't ask again"; picking it needs no confirmation. */
	readonly fullAccessAcknowledged?: boolean;
}

export interface PolicyPreset {
	readonly id: string;
	readonly label: string;
	readonly description: string;
}

export interface Usage {
	readonly input: number;
	readonly output: number;
	readonly [key: string]: unknown;
}

/** One content part of an agent message. */
export interface ContentPart {
	readonly type: string;
	readonly text?: string;
	readonly thinking?: string;
	readonly redacted?: boolean;
	readonly id?: string;
	readonly name?: string;
	readonly arguments?: unknown;
	readonly [key: string]: unknown;
}

export interface AgentMessage {
	readonly role: string;
	readonly content?: string | readonly ContentPart[];
	readonly toolCallId?: string;
	readonly isError?: boolean;
	readonly usage?: Usage;
	readonly [key: string]: unknown;
}

/** A projected session entry (runtime.ts `projectEntry`). */
export interface SessionEntry {
	readonly id: string;
	readonly type: string;
	readonly timestamp?: string;
	readonly message?: AgentMessage;
	readonly usage?: Usage;
	readonly thinkingTimings?: ThinkingTimings;
	/** Lifecycle-only metadata on custom_message / agent-notification entries. */
	readonly details?: unknown;
	readonly [key: string]: unknown;
}

export interface ImportCandidate {
	readonly id: string;
	readonly source: "codex" | "claude-code";
	readonly sessionId: string;
	readonly title: string;
	readonly cwd: string;
	readonly modified: string;
	readonly archived: boolean;
	readonly version: string;
}

export interface ImportPreview extends ImportCandidate {
	readonly fingerprint: string;
	readonly messageCount: number;
	readonly toolCount: number;
	readonly warnings: readonly { readonly code: string; readonly count: number }[];
	readonly excerpt: string;
}

export interface ImportJob {
	readonly id: string;
	readonly createdAt: string;
	readonly status: "running" | "completed" | "cancelled" | "interrupted";
	readonly total: number;
	readonly results: readonly {
		readonly candidateId: string;
		readonly title?: string;
		readonly status: "imported" | "skipped" | "failed";
		readonly sessionId?: string;
		readonly error?: string;
		readonly warning?: string;
	}[];
}

/** A row of GET /api/v1/sessions. Snapshots are merged into these rows too. */
export interface SessionSummary {
	readonly id: string;
	readonly cwd?: string;
	readonly name?: string;
	readonly firstMessage?: string;
	readonly created?: string;
	readonly modified?: string;
	readonly messageCount?: number;
	readonly archived?: boolean;
	readonly cwdAvailable?: boolean;
	readonly status?: SessionStatus;
	readonly unread?: boolean;
	readonly [key: string]: unknown;
}

/** One hit of GET /api/v1/search (session-search.ts `WebSearchHit`). */
export interface SessionSearchHit {
	readonly sessionId: string;
	readonly cwd: string;
	/** Null for a title match, or for every hit while the index is degraded. */
	readonly entryId: string | null;
	readonly entryType?: string;
	readonly role?: string;
	readonly ts: number;
	/** Excerpt; each match is wrapped in U+0002 / U+0003. */
	readonly snippet: string;
}

/** GET /api/v1/search (session-search.ts `WebSearchResult`). */
export interface SessionSearchResult {
	readonly hits: readonly SessionSearchHit[];
	readonly coverage: { readonly indexed: number; readonly total: number };
	readonly state: "ready" | "backfilling" | "degraded";
}

/** GET /api/v1/sessions/:id and the SSE `snapshot` event (runtime.ts `snapshot()`). */
export interface SessionSnapshot extends SessionSummary {
	readonly cwd: string;
	readonly status: SessionStatus;
	readonly sessionFile?: string;
	readonly entries?: readonly SessionEntry[];
	readonly model?: ModelRef;
	readonly permissionPreset?: string;
	readonly policies?: readonly PolicyPreset[];
	readonly thinkingLevel?: string;
	readonly availableThinkingLevels?: readonly string[];
	readonly models?: readonly ModelInfo[];
	/** Tool calls still waiting for a verdict; the stream only announces each one once. */
	readonly pendingApprovals?: readonly ApprovalRequest[];
	readonly pendingClarifications?: readonly ClarificationRequest[];
	/** Kernel selectors waiting for an answer (src/selection.ts), e.g. the Full Access risk question. */
	readonly pendingSelections?: readonly SelectionRequest[];
	/** User entry ids of turns whose file changes were reverted (runtime.ts `revertTurn`). */
	readonly revertedTurns?: readonly string[];
	/** Messages sent during a turn, waiting for it to end (src/message-queue.ts). */
	readonly queuedMessages?: readonly QueuedMessage[];
	/** Steered messages the kernel has not delivered to the running turn yet. */
	readonly steeringMessages?: readonly SteeringMessage[];
	/** The kernel retrying a failed model request right now (runtime.ts `RetryTracker`). */
	readonly retry?: SessionRetry;
}

/** GET /api/v1/sessions/{id}/inspector; read-only runtime projections. */
export interface SessionInspector {
	readonly sessionId: string;
	readonly plan?: { readonly id: string; readonly title: string };
	readonly tasks: readonly {
		readonly id: string;
		readonly subject: string;
		readonly description: string;
		readonly status: "pending" | "in_progress" | "completed";
	}[];
	readonly skillCount: number;
	readonly mcpScope: "process";
	readonly mcp: readonly { readonly name: string; readonly status: string }[];
	readonly stats: {
		readonly tokens: {
			readonly input: number;
			readonly output: number;
			readonly cacheRead: number;
			readonly cacheWrite: number;
			readonly total: number;
		};
		readonly cost: number;
		readonly contextUsage?: {
			readonly tokens: number | null;
			readonly contextWindow: number;
			readonly percent: number | null;
		};
	};
}

/** Snapshot `retry` (src/retry-state.ts `WebRetryState`). */
export interface SessionRetry {
	/** 1-based attempt about to run. */
	readonly attempt: number;
	readonly maxAttempts: number;
	/** Backoff before the attempt starts. */
	readonly delayMs: number;
	/** Host epoch milliseconds when the retry was scheduled. */
	readonly startedAt: number;
	readonly errorMessage: string;
	readonly reason?: "rate_limit";
}

/** A steered message waiting for the running turn (src/message-queue.ts `SteeringMessageView`). */
export interface SteeringMessage {
	readonly text: string;
	readonly images: readonly { readonly mimeType: string; readonly data: string }[];
}

/** A queued message as the host lists it (src/message-queue.ts `QueuedMessageView`). */
export interface QueuedMessage {
	readonly id: string;
	readonly text: string;
	readonly attachments: readonly { readonly name: string; readonly kind: "image" | "text" }[];
	readonly files: readonly { readonly id: string; readonly name: string }[];
}

/** The `queue` SSE event and the queue routes' response (runtime.ts `WebQueueState`). */
export interface QueueState {
	readonly queued: readonly QueuedMessage[];
	readonly steering: readonly SteeringMessage[];
}

export interface ClarificationQuestion {
	readonly id: string;
	readonly label: string;
	readonly question: string;
	readonly reason?: string;
	readonly options: readonly { readonly label: string; readonly value: string; readonly description?: string }[];
	readonly allowFreeform: boolean;
}

/** A kernel `ui.select` dialog (src/selection.ts). Options are the kernel's own labels, echoed back verbatim. */
export interface SelectionRequest {
	readonly id: string;
	readonly sessionId: string;
	readonly title: string;
	readonly options: readonly string[];
}

export interface ClarificationRequest {
	readonly id: string;
	readonly sessionId: string;
	readonly questions: readonly ClarificationQuestion[];
}

export type ClarificationReply = { readonly id: string } & (
	| { readonly optionIndex: number }
	| { readonly text: string }
	| { readonly skipped: true }
);

export interface ApprovalRequest {
	readonly id: string;
	readonly sessionId: string;
	readonly toolName: string;
	readonly message: string;
	readonly input?: Readonly<Record<string, unknown>>;
	readonly reason?: string;
	readonly createdAt: number;
	readonly preview?: {
		readonly path?: string;
		readonly before?: string;
		readonly after?: string;
	};
}

export interface MessageTimelineItem {
	readonly itemId: string;
	readonly kind: "message";
	readonly entryId?: string;
	readonly role: string;
	readonly content: string;
	/** Data URLs of the images attached to a user message; a message can be images only. */
	readonly images?: readonly string[];
	readonly usage?: Usage;
	readonly timestamp?: string;
	/** The model request failed (assistant `stopReason: "error"`); the provider's message. */
	readonly error?: string;
}

export type ToolState = "pending" | "completed" | "failed" | "unknown";

export interface ThinkingTiming {
	readonly startedAt: number;
	readonly endedAt?: number;
}

export type ThinkingTimings = Readonly<Record<string, ThinkingTiming>>;

export interface ThinkingTimelineItem {
	readonly itemId: string;
	readonly kind: "thinking";
	readonly entryId?: string;
	readonly content: string;
	/** True only while this structured thinking block is being streamed. */
	readonly running: boolean;
	readonly timing?: ThinkingTiming;
}

export interface ToolTimelineItem {
	readonly imported?: boolean;
	readonly itemId: string;
	readonly kind: "tool";
	readonly state: ToolState;
	readonly toolName: string;
	readonly inputSummary: string;
	readonly outputSummary: string;
	/** Full arguments and result, shown when the row is expanded. */
	readonly inputDetail?: string;
	readonly outputDetail?: string;
	/** The arguments the row shows by name (path, command...), when the call had them. */
	readonly args?: ToolArgs;
	/** A successful edit/write: its path argument and the unified patch from the result `details.patch`. */
	readonly change?: FileChange;
	/** Subagents this call started, from the result `details.results[].sessionId`. */
	readonly children?: readonly ChildAgentLink[];
	/** Validated presentation of the subagent tool's structured per-task records. */
	readonly subagentTasks?: readonly SubagentTask[];
	/** A workflow call's run id; its agents come from `GET /sessions/{id}/children?workflowRun=`. */
	readonly workflowRun?: string;
}

/** A child agent a tool call started. Its transcript is read-only. */
export interface ChildAgentLink {
	readonly sessionId: string;
	readonly label: string;
}

export type SubagentStatus = "queued" | "running" | "completed" | "failed" | "aborted" | "skipped" | "unknown";

export interface SubagentTask {
	readonly agent: string;
	readonly task: string;
	readonly status: SubagentStatus;
	readonly sessionId?: string;
	readonly backgroundAgentId?: string;
	readonly model?: string;
	readonly turns?: number;
	readonly error?: string;
}

/** GET /api/v1/sessions/{id}/children/{childId} (child-sessions.ts `ChildTranscript`). */
export interface ChildSessionSnapshot {
	readonly id: string;
	readonly parentId: string;
	readonly cwd: string;
	readonly modified: string;
	readonly readOnly: true;
	readonly entries: readonly SessionEntry[];
}

/** A row of GET /api/v1/sessions/{id}/children?workflowRun= (child-sessions.ts `ChildSummary`). */
export interface ChildAgentSummary {
	readonly id: string;
	readonly title: string;
	readonly messageCount: number;
	readonly modified: string;
}

/** Tool arguments a tool row names instead of listing `key=value` pairs. */
export interface ToolArgs {
	/** `path` or `file_path` (read, write, edit, grep, find, ls). */
	readonly path?: string;
	/** `bash` command. */
	readonly command?: string;
	/** `read` start line (1-based). */
	readonly offset?: number;
	/** `grep` / `find` pattern. */
	readonly pattern?: string;
}

/** Why an edit/write has no patch (host `SkippedChange.reason`). */
export type UntrackedReason = "too_large" | "binary" | "unreadable" | "unknown";

export interface FileChange {
	readonly path: string;
	/** Unified patch, LF. Absent when none was recorded; then `untracked` says why. */
	readonly patch?: string;
	readonly untracked?: UntrackedReason;
}

/** Response of `POST /sessions/{id}/turns/{turnId}/revert`. */
export interface TurnRevertResult {
	readonly snapshot: SessionSnapshot;
	readonly paths: readonly string[];
	readonly skipped: ReadonlyArray<{ readonly path: string; readonly reason: UntrackedReason }>;
}

export interface ApprovalTimelineItem {
	readonly itemId: string;
	readonly kind: "approval";
	readonly approval: ApprovalRequest;
}

/**
 * Failed model requests the kernel retried, folded into one row instead of a
 * red card each. The final failure of a series that gave up stays a message
 * row with `error`.
 */
export interface RetryTimelineItem {
	readonly itemId: string;
	readonly kind: "retry";
	/** The provider error of each retried attempt, oldest first. */
	readonly errors: readonly string[];
	/** Set on the series the kernel is retrying right now. */
	readonly live?: SessionRetry;
}

export type TimelineItem =
	| MessageTimelineItem
	| ThinkingTimelineItem
	| ToolTimelineItem
	| ApprovalTimelineItem
	| RetryTimelineItem;

export interface WebWorkspace {
	readonly path: string;
	readonly name: string;
	/** False when the directory has since been moved or deleted. */
	readonly available: boolean;
	/** Removed from workspace navigation without deleting sessions. */
	readonly hidden?: boolean;
}

export interface LoginReport {
	readonly source: "environment" | "auth.json" | "none";
	readonly provider?: string;
	readonly profile?: string;
	readonly userId?: string;
	readonly path?: string;
	readonly configured: boolean;
	readonly validity?: string;
	readonly loginCommand: string;
	/** Step Plan page of the credential's region (src/login.ts): where Upgrade leads. */
	readonly planUrl: string;
}

/** `GET /api/v1/account` (src/account.ts `AccountReport`): the signed-in account for the sidebar. */
export interface AccountReport {
	readonly status: "ready" | "missing" | "expired" | "unavailable";
	readonly account?: { readonly name: string; readonly avatarUrl?: string; readonly uid?: string };
}

/** One of the four `step login` profiles (src/login.ts `LoginMethod`). */
export interface LoginMethod {
	readonly id: "step_plan" | "step_plan_oversea" | "platform_cn" | "platform_oversea";
	readonly credentialSource: "browser" | "apiKey";
	readonly region: "cn" | "global";
	readonly keyPageUrl: string;
}

/** `GET /api/v1/login/browser` (src/login.ts `BrowserLoginState`). */
export interface BrowserLoginState {
	readonly state: "idle" | "pending" | "completed" | "failed";
	readonly profile?: string;
	readonly authUrl?: string;
	readonly error?: string;
}

export interface BootstrapPayload {
	readonly cwd: string;
	readonly directoryPicker?: string;
	readonly login?: LoginReport | null;
}

export interface TreeEntry {
	readonly name: string;
	/** Path relative to the workspace root, with `/` separators. */
	readonly path: string;
	readonly kind: "directory" | "file";
}

export type WorkspaceFile =
	| { readonly kind: "text"; readonly path: string; readonly size: number; readonly content: string }
	| { readonly kind: "image"; readonly path: string; readonly size: number; readonly mimeType: string }
	| { readonly kind: "binary" | "too-large"; readonly path: string; readonly size: number };

/** GET /api/v1/directories (the in-page workspace browser). */
export interface DirectoryListing {
	readonly path: string;
	readonly parent: string;
	readonly directories: ReadonlyArray<{ readonly name: string; readonly path: string }>;
}

export interface TagGroup {
	readonly key: TagColor;
	readonly name: string;
}

/** A file staged for the next message. `data` is base64. */
export interface Attachment {
	readonly name: string;
	readonly mimeType: string;
	readonly data: string;
	readonly kind: "image" | "text";
}

/** POST /api/v1/uploads (uploads.ts `SavedUpload`): the host's copy of a pasted file. */
export interface UploadedFile {
	/** Named in a message's `files` list; the host then adds the file's content. */
	readonly id: string;
	readonly path: string;
	readonly name: string;
	readonly size: number;
}

/** GET /api/v1/sessions/:id/skills and /api/v1/workspace/skills (runtime.ts `WebSkill`). */
export interface WebSkill {
	readonly name: string;
	readonly description: string;
}

/** GET /api/v1/mcp (coding-agent `StepMcpStatus`). */
export interface McpServerStatus {
	readonly name: string;
	readonly status: "connecting" | "connected" | "failed" | "disabled";
	readonly toolCount: number;
	readonly error?: string;
}

/**
 * A server declaration as `config.toml` stores it (`StepMcpServerConfig`):
 * `command` for stdio, `url` for streamable HTTP.
 */
export interface McpServerConfig {
	readonly command?: string;
	readonly args?: readonly string[];
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly url?: string;
	readonly http_headers?: Readonly<Record<string, string>>;
	readonly bearer_token_env_var?: string;
	readonly env_http_headers?: Readonly<Record<string, string>>;
	readonly startup_timeout_sec?: number;
	readonly tool_timeout_sec?: number;
	readonly enabled_tools?: readonly string[];
	readonly disabled_tools?: readonly string[];
	readonly oauth?: {
		readonly client_id?: string;
		readonly client_secret?: string;
		readonly scopes?: readonly string[];
		readonly callback_port?: number;
	};
	readonly enabled?: boolean;
}

/** `GET /api/v1/settings/mcp` entry (src/settings.ts `WebMcpServer`). */
export interface SettingsMcpServer {
	readonly name: string;
	readonly source: "user" | "plugin";
	readonly pluginName?: string;
	readonly transport: "stdio" | "http";
	readonly enabled: boolean;
	readonly config?: McpServerConfig;
	readonly status?: McpServerStatus["status"];
	readonly toolCount?: number;
	readonly error?: string;
}

/** `GET /api/v1/settings/plugins` (src/settings.ts `WebPluginCatalog`). */
export interface SettingsPluginCatalog {
	readonly installed: ReadonlyArray<{
		readonly id: string;
		readonly name: string;
		readonly version?: string;
		readonly description?: string;
		readonly mcpServers: readonly string[];
		readonly warnings: readonly string[];
	}>;
	readonly available: ReadonlyArray<{
		readonly name: string;
		readonly description?: string;
		readonly marketplace: string;
		readonly installed: boolean;
	}>;
	readonly marketplaces: ReadonlyArray<{
		readonly name: string;
		readonly kind: "builtin" | "git" | "local";
		readonly origin: string | null;
	}>;
	readonly warnings: readonly string[];
}

/** `GET /api/v1/settings/models` entry (src/model-providers.ts `WebModelProvider`). */
export interface SettingsModelProvider {
	readonly id: string;
	readonly name: string;
	readonly baseUrl: string;
	readonly api: string;
	readonly models: ReadonlyArray<{
		readonly id: string;
		readonly name?: string;
		readonly contextWindow?: number;
		readonly maxTokens?: number;
		readonly input?: readonly string[];
		readonly reasoning?: boolean;
		readonly thinkingLevelMap?: Readonly<Record<string, string | null>>;
	}>;
	/** Where the key comes from; the key itself is never sent to the browser. */
	readonly credential: "stored" | "configured" | "none";
}

/** `POST /api/v1/settings/models/discover` candidate (providers `DiscoveredModel`). */
export interface DiscoveredModelEntry {
	readonly id: string;
	readonly name: string;
	readonly contextWindow?: number;
	readonly maxTokens?: number;
}

/** `GET /api/v1/settings/skills` entry (src/settings.ts `WebSkillEntry`). */
export interface SettingsSkill {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly source: "user" | "plugin";
	readonly pluginName?: string;
	readonly location: string;
	readonly enabled: boolean;
	readonly toggleable: boolean;
	readonly deletable: boolean;
}
