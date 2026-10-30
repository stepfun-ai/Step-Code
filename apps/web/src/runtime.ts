import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntime,
	attachSessionIndex,
	clampThinkingLevel,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createStepAgentSessionServices,
	createStepCapabilitiesExtensionInline,
	createStepCronExtension,
	createStepExtensionInline,
	createStepGoalExtension,
	createStepProviderConfig,
	createStepSessionManager,
	createStepSessionManagerFactory,
	createStepSettingsManager,
	createStepToolProfile,
	DEFAULT_THINKING_LEVEL,
	DefaultResourceLoader,
	defaultStepPluginsDir,
	discoverStepPluginResourcePaths,
	type ExtensionUIContext,
	type FeedbackEvidence,
	FULL_ACCESS_RISK_OPTIONS,
	findInitialModel,
	formatFeedbackBundleFailureDetails,
	formatFeedbackBundleSkipMessage,
	formatFeedbackPendingDetails,
	getStepAuthPath,
	getStepGoal,
	getStepMcpStatuses,
	getStepPlanState,
	getSupportedThinkingLevels,
	type InlineExtension,
	isChildAgentSession,
	listAllStepSessions,
	ModelRuntime,
	NOOP_OBSERVABILITY_PROVIDER,
	normalizeFeedbackCategory,
	openStepSession,
	plainTheme,
	prepareFeedbackEvidence as prepareKernelFeedbackEvidence,
	readFeedbackUsername,
	readGlobalStepDefaults,
	readStepBuildIdentity,
	readSubagentLaneSnapshot,
	resolveFeedbackEndpoint,
	resolveFeedbackSettings,
	resolveStepAgentDir,
	resolveStepConfigDir,
	resolveStepConfigRoot,
	resolveStepStorageRoot,
	type SessionEntry,
	type SessionIndex,
	type SessionInfo,
	type SideAnswer,
	STEP_APP_SYSTEM_PROMPT_PRODUCT,
	STEP_DEFAULT_MODEL,
	STEP_PERMISSION_PRESETS,
	STEP_PROVIDER_ID,
	STEPCODE_VERSION,
	type StepGlobalDefaults,
	type StepGoalRecord,
	type StepMcpStatus,
	type StepPermissionPresetId,
	type StepSettingsManager,
	SUBAGENT_LANE_CHANNEL,
	SUBAGENT_RESPONSE_ENTRY,
	type SubagentLaneSnapshot,
	submitFeedback as submitKernelFeedback,
	syncStepLoginProfileEndpoint,
	THINKING_LEVEL_OPTIONS,
	withSessionIndex,
} from "@step-harness/coding-agent";
import { ApprovalBroker, type ApprovalRequest } from "./approval.ts";
import { type WebAttachment, withTextAttachments } from "./attachments.ts";
import { ClarificationBroker, type ClarificationEvent } from "./clarification.ts";
import { feedbackCategoryFor } from "./feedback.ts";
import {
	describeFeedbackEvidence,
	FeedbackDrafts,
	type WebFeedbackDraft,
	type WebFeedbackPreview,
} from "./feedback-report.ts";
import { projectInspectorTasks } from "./inspector.ts";
import {
	MessageQueue,
	type QueuedFile,
	type QueuedMessage,
	type QueuedMessageView,
	SteeringImages,
	type SteeringMessageView,
} from "./message-queue.ts";
import {
	LivePromptCommands,
	PROMPT_COMMAND_TYPE,
	pairPromptCommands,
	promptCommandRecord,
	promptMessageText,
	type WebPromptCommand,
	webPromptCommands,
} from "./prompt-commands.ts";
import { RetryTracker } from "./retry-state.ts";
import { SelectionBroker, type SelectionEvent, type SelectionRequest, selectionSelect } from "./selection.ts";
import { generateSessionTitle, type SlashCommandKind, sessionTitleInput } from "./session-title.ts";
import { type WebSkill, webSkills } from "./skills.ts";
import { resolveSubagentCliPath } from "./subagent-cli.ts";
import { retainSubagentLane } from "./subagent-lane-cache.ts";
import { projectSubagentNotification } from "./subagent-notification.ts";
import { TextInputBroker, type TextInputEvent, textInput } from "./text-input.ts";
import { savedThinkingTimings, THINKING_TIMING_TYPE, ThinkingClock, type ThinkingTimings } from "./thinking-timing.ts";
import {
	type FileAtTurn,
	fileAtTurnEnd,
	revertedTurnIds,
	type SkippedChange,
	TURN_REVERT_TYPE,
	TurnRevertError,
	TurnReverter,
	turnRevertNotice,
} from "./turn-changes.ts";
import { withUploadedFiles } from "./uploads.ts";
import { claimWebSessionWriter } from "./writer-lease.ts";

// Re-exported so the server and tests have one import site for attachment types.
export { classifyAttachment, MAX_ATTACHMENT_BYTES, type WebAttachment, withTextAttachments } from "./attachments.ts";
export type { QueuedFile, QueuedMessageView } from "./message-queue.ts";

/** How long a session may spend discovering the account's model catalog. */
const MODEL_CATALOG_REFRESH_TIMEOUT_MS = 10_000;

/**
 * Pull the signed-in account's real model catalog from `{base}/v1/models`.
 *
 * `models.json` is only an offline baseline, and neither `getAvailableSnapshot()`
 * nor `Models.getAvailable()` touches the network, so a host that wants the real
 * list has to refresh explicitly. Must run after the agent services are built:
 * each provider registration schedules a cache-only refresh that rebuilds the
 * catalog from models.json and would otherwise undo this one.
 *
 * Failures are swallowed on purpose — `fetchStepModels` already falls back to the
 * baseline, and a session must stay usable offline.
 */
async function refreshStepModelCatalog(modelRuntime: ModelRuntime): Promise<void> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), MODEL_CATALOG_REFRESH_TIMEOUT_MS);
	try {
		await modelRuntime.refresh({ allowNetwork: true, signal: controller.signal });
	} catch {
		// Catalog discovery is best-effort; the baseline models remain selectable.
	} finally {
		clearTimeout(timeout);
	}
}

/** What this session's listeners are told; `emit` stamps each one with its revision. */
export type WebEventBody =
	| { type: "subagent_lane"; lane: SubagentLaneSnapshot | null }
	| ClarificationEvent
	| SelectionEvent
	| TextInputEvent
	| {
			type: "agent";
			event: AgentSessionEvent;
			thinkingTimings?: ThinkingTimings;
			/** On a user `message_start`: the prompt-command line it expanded from (see `prompt-commands.ts`). */
			promptCommand?: string;
	  }
	| { type: "approval_required"; approval: ApprovalRequest }
	| {
			/**
			 * Command output the kernel published through `ui.notify`. It is a
			 * notice in the transcript, never a prompt: nothing here enters the
			 * model's context or the session file.
			 */
			type: "notice";
			level: "info" | "warning" | "error";
			text: string;
			markdown?: boolean;
			/** Restates host-rendered state (plan mode, permission tier): shown briefly, not kept. */
			transient?: boolean;
	  }
	| {
			/**
			 * A `/btw` answer, for the rail. Side answers are process memory, like the
			 * terminal panel's history: never a session entry, never model context.
			 */
			type: "side-answer";
			answer: WebSideAnswer;
	  }
	| { type: "status"; status: WebSessionStatus; unread: boolean }
	| ({ type: "queue" } & WebQueueState)
	| { type: "error"; message: string };

/**
 * One published event, ordered by `revision`. The number is monotonic per bound
 * session and lets a reader tell an HTTP snapshot from before an event it has
 * already applied (see the client's `renderSnapshot`).
 */
export type WebEvent = WebEventBody & { readonly revision: number };

/**
 * Messages the user sent during a turn and nothing has run yet: `queued` waits
 * for the turn to end (editable), `steering` is already in the kernel and is
 * delivered before its next model call (read-only).
 */
export interface WebQueueState {
	readonly queued: readonly QueuedMessageView[];
	readonly steering: readonly SteeringMessageView[];
}

export type WebSessionStatus = "idle" | "running" | "waiting" | "completed" | "failed";

/**
 * MCP server statuses. With a session manager, what that session connected;
 * otherwise the list of the session that started last in this process. Servers
 * are pooled per process, so sessions share connections, but each session
 * still discovers its own set (project plugins depend on its cwd and trust).
 */
export function mcpStatuses(session?: object): StepMcpStatus[] {
	return getStepMcpStatuses(session);
}

/** One `/btw` answer as the rail shows it. */
export interface WebSideAnswer {
	readonly id: string;
	readonly question: string;
	readonly text: string;
	readonly model?: string;
	/** The request was cancelled or produced nothing usable. */
	readonly unavailable?: boolean;
	readonly createdAt: number;
}

/** Side answers kept per session: enough to scroll back through, bounded like the terminal's history. */
const SIDE_ANSWER_LIMIT = 30;

/** The session modes the composer can toggle. Each is independent of the others. */
export type WebMode = "goal" | "plan" | "ultraloop";

/** What the goal strip's buttons and edit form ask for. */
export type WebGoalAction = "start" | "pause" | "resume" | "edit" | "clear";

/**
 * The official StepCode CLI currently persists sessions through Pi's native
 * SessionManager (JSONL v3). This registry prevents two Web sessions in the
 * same host process from appending to one file at once. It is intentionally
 * not presented as a cross-process lock: older CLI builds do not participate
 * in a shared lease protocol and must be closed before Web takes ownership.
 */
function webUiContext(
	broker: ApprovalBroker,
	clarifications: ClarificationBroker,
	selections: SelectionBroker,
	textInputs: TextInputBroker,
	notify: (notice: {
		level: "info" | "warning" | "error";
		text: string;
		markdown?: boolean;
		transient?: boolean;
	}) => void,
	sideAnswer: (answer: SideAnswer) => void,
): ExtensionUIContext {
	const unsupported = async <T>(fallback: T): Promise<T> => fallback;
	return {
		clarify: (questions, signal) => clarifications.ask(questions, signal),
		select: selectionSelect(selections),
		// The broker derives the tool and the grant key from the dialog title.
		confirm: (title, message, options) => broker.confirm(title, message, options?.signal),
		input: textInput(textInputs),
		// A command's answer is a notice in the transcript, not a prompt: it never
		// reaches the model or the session file.
		notify: (message, type, options) =>
			notify({
				level: type ?? "info",
				text: message,
				...(options?.markdown ? { markdown: true } : {}),
				...(options?.transient ? { transient: true } : {}),
			}),
		// `/btw` answers get a rail tab instead of a transcript row.
		sideAnswer,
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async <T>() => unsupported<T>(undefined as T),
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme() {
			// `ExtensionUIContext.theme` is required, and extensions style status
			// text unconditionally. Identity styling keeps those calls working
			// without emitting ANSI into HTML or a notice.
			return plainTheme;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "Theme switching is not available on Web" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

/**
 * The resources a provenance entry names, structurally matching the kernel's
 * `UsageResources`. The Web host renders no `/usage` panel, so it records these
 * only for the session's `step.usage_provenance` entries.
 */
export interface WebUsageResources {
	agents: string[];
	skills: { name: string; filePath: string }[];
}

/**
 * Extensions the Web/Desktop host mounts, in registration order.
 *
 * Exported for the assembly regression test: the list used to lose `goal` and
 * `cron` silently, which unregistered their slash commands and tools — `/goal`
 * then reached the model as ordinary text. Keep the test's expectations in step
 * with this list rather than re-deriving it at each call site.
 *
 * `usageRecording` is optional because recording provenance is separate from the
 * `/usage` UI this host does not render; a caller without one records nothing.
 */
export function webExtensions(
	settingsManager: StepSettingsManager,
	broker: ApprovalBroker,
	onPermissionChange: (preset: StepPermissionPresetId) => void,
	usageRecording?: () => WebUsageResources,
	onLane?: (lane: SubagentLaneSnapshot | null) => void,
): InlineExtension[] {
	const telemetry = NOOP_OBSERVABILITY_PROVIDER.createReporter();
	const persisted = settingsManager.getStepSettings();
	const permission = {
		initialPreset: (persisted.permissionPreset ?? "approve-for-me") as StepPermissionPresetId,
		nonInteractiveApproval: persisted.nonInteractiveApproval ?? "deny",
	};
	const webHostExtension: InlineExtension = {
		name: "StepCode Web host",
		hidden: true,
		factory: (pi) => {
			if (onLane) {
				pi.events.on(SUBAGENT_LANE_CHANNEL, (value) => {
					const lane = readSubagentLaneSnapshot(value);
					if (lane) onLane(lane);
				});
				pi.on("session_shutdown", () => onLane(null));
			}
			pi.on("tool_call", (event) => {
				broker.captureToolCall(event.toolCallId, event.toolName, event.input);
			});
		},
	};
	return [
		webHostExtension,
		createStepExtensionInline({
			telemetry,
			permission,
			stepSettings: () => settingsManager,
			onPermissionChange,
			traceHeaderPolicy: NOOP_OBSERVABILITY_PROVIDER.traceHeaderPolicy(),
			usageRecording,
		}),
		// The client's ultraloop pick rides one message; the host offers no
		// standing `/ultraloop on` switch to revoke, so neither register it nor
		// revive a standing entry carried in from a CLI session.
		//
		// Capabilities registers plan, tasks, subagent, workflow, and ultraloop —
		// but NOT goal or cron. Those are separate extensions, and omitting one
		// leaves its tools and slash commands unregistered: `/goal` then reaches
		// the model as ordinary text, and the session has no create_goal.
		createStepCapabilitiesExtensionInline({
			telemetry,
			cliPath: resolveSubagentCliPath(),
			ultraloopSessionMode: false,
			subagent: {
				// A child runs `--mode rpc` with no window of its own, so its
				// permission dialog used to be cancelled and a subagent's write
				// failed without anyone being asked. Show it on this session's
				// approval stream instead: the dialog body carries the tool's
				// summarized input (path, content, command).
				requestApproval: (prompt) => broker.confirm(prompt.title, prompt.message, prompt.signal),
			},
		}),
		createStepCronExtension({ telemetry }),
		createStepGoalExtension({ telemetry }),
	];
}

/** The provider/model a Web session starts on. */
export interface WebDefaultModel {
	provider: string;
	modelId?: string;
}

/**
 * Resolve the session default the same way the CLI's `withStepDefaults` does:
 * config.toml first, then the Step product default when the provider is Step.
 *
 * Without the product fallback, a config with no `defaultModel` leaves model
 * resolution to "first available", which is whatever order `{base}/v1/models`
 * happens to return (e.g. `step-3.7-flash` instead of `step-5-preview`).
 */
export function resolveWebDefaultModel(defaults: StepGlobalDefaults): WebDefaultModel {
	const provider = defaults.provider ?? STEP_PROVIDER_ID;
	const modelId = defaults.model ?? (provider === STEP_PROVIDER_ID ? STEP_DEFAULT_MODEL : undefined);
	return modelId ? { provider, modelId } : { provider };
}

/** Prefer the default model when the catalog lists it; otherwise the first listed model. */
export function pickFallbackModel<T extends { provider: string; id: string }>(
	available: readonly T[],
	preferred: WebDefaultModel,
): T | undefined {
	const match = preferred.modelId
		? available.find((model) => model.provider === preferred.provider && model.id === preferred.modelId)
		: undefined;
	return match ?? available[0];
}

type CatalogModel = ReturnType<ModelRuntime["getAvailableSnapshot"]>[number];

/** Picker row for one catalog model; `thinkingLevels` lets a draft show effort before a session exists. */
export function projectModel(model: CatalogModel, providerName?: string) {
	return {
		provider: model.provider,
		// The picker partitions the catalog by provider; the declared name is
		// the section heading, the id only its fallback.
		...(providerName && providerName !== model.provider ? { providerName } : {}),
		id: model.id,
		name: model.name,
		api: model.api,
		reasoning: model.reasoning ?? false,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		input: model.input,
		cost: model.cost,
		thinkingLevels: getSupportedThinkingLevels(model),
	};
}

/** What the composer's model panel shows: a session snapshot, or a draft's prediction of one. */
export interface WebModelSource {
	model?: { provider: string; id: string };
	thinkingLevel?: string;
	availableThinkingLevels: string[];
	models: ReturnType<typeof projectModel>[];
}

/**
 * The declared display name of every provider that has models in the snapshot,
 * for the picker's per-provider section headings. An unknown provider keeps its
 * id, which `getProvider` already falls back to.
 */
function providerNamesOf(modelRuntime: ModelRuntime): Map<string, string> {
	const names = new Map<string, string>();
	for (const model of modelRuntime.getAvailableSnapshot()) {
		if (!names.has(model.provider)) {
			names.set(model.provider, modelRuntime.getProvider(model.provider)?.name ?? model.provider);
		}
	}
	return names;
}

/** Every catalog model with its provider's name attached, as both pickers paint them. */
function projectedModels(modelRuntime: ModelRuntime): ReturnType<typeof projectModel>[] {
	const names = providerNamesOf(modelRuntime);
	return modelRuntime.getAvailableSnapshot().map((model) => projectModel(model, names.get(model.provider)));
}

/** The kernel's Full Access risk question, recognised by its exact option list. */
function isFullAccessRiskRequest(request: SelectionRequest): boolean {
	return (
		request.options.length === FULL_ACCESS_RISK_OPTIONS.length &&
		FULL_ACCESS_RISK_OPTIONS.every((option, index) => request.options[index] === option)
	);
}

/** The permission presets a session offers, labelled straight from the kernel so the UI never invents its own copy. */
export function webPermissionPresets(): { id: StepPermissionPresetId; label: string; description: string }[] {
	return STEP_PERMISSION_PRESETS.map((preset) => ({
		id: preset.id,
		label: preset.label,
		description: preset.description,
	}));
}

/**
 * What a draft (no session yet) shows in its composer: the model it would start
 * on, plus the permission tier the Step settings for its folder name and the
 * presets to choose from, so the picker is complete before the first send.
 */
export interface WebDraftSource extends WebModelSource {
	permissionPreset: StepPermissionPresetId;
	policies: ReturnType<typeof webPermissionPresets>;
	/** The user chose "don't ask again" for Full Access, so a draft need not ask either. */
	fullAccessAcknowledged: boolean;
}

/**
 * The model and thinking level a new session in `cwd` would start on.
 *
 * Mirrors session creation step by step so a draft can show the real choice
 * instead of a placeholder: settings default (project, then config.toml), then
 * the product default via `resolveWebDefaultModel`, resolved by the kernel's
 * `findInitialModel`; `adoptFallbackModel`'s rule when that resolves nothing
 * listed; then the session's thinking-level order (per-model, global default,
 * kernel default), clamped to what the model supports.
 */
export async function predictDraftModel(
	modelRuntime: ModelRuntime,
	settings: Pick<
		StepSettingsManager,
		"getDefaultProvider" | "getDefaultModel" | "getDefaultThinkingLevel" | "getAllModelThinkingLevels"
	>,
	globalDefaults: StepGlobalDefaults,
): Promise<WebModelSource> {
	const available = modelRuntime.getAvailableSnapshot();
	const defaults = resolveWebDefaultModel(globalDefaults);
	const preferred: WebDefaultModel = {
		provider: settings.getDefaultProvider() ?? defaults.provider,
		modelId: settings.getDefaultModel() ?? defaults.modelId,
	};
	const modelThinkingLevels = settings.getAllModelThinkingLevels();
	const initial = await findInitialModel({
		scopedModels: [],
		isContinuing: false,
		defaultProvider: preferred.provider,
		defaultModelId: preferred.modelId,
		defaultThinkingLevel: settings.getDefaultThinkingLevel(),
		modelThinkingLevels,
		modelRuntime,
	});
	const resolved = initial.model;
	const model =
		resolved && available.some((candidate) => modelsMatch(candidate, resolved))
			? resolved
			: pickFallbackModel(available, preferred);
	const models = projectedModels(modelRuntime);
	if (!model) return { availableThinkingLevels: [], models };
	const wanted =
		modelThinkingLevels[`${model.provider}/${model.id}`] ??
		settings.getDefaultThinkingLevel() ??
		DEFAULT_THINKING_LEVEL;
	return {
		model: { provider: model.provider, id: model.id },
		thinkingLevel: clampThinkingLevel(model, wanted),
		availableThinkingLevels: getSupportedThinkingLevels(model),
		models,
	};
}

/** The image attachments as kernel image content; text attachments are inlined by `withTextAttachments`. */
function imagesOf(attachments: readonly WebAttachment[]): { type: "image"; data: string; mimeType: string }[] {
	return attachments
		.filter((attachment) => attachment.kind === "image")
		.map((attachment) => ({ type: "image" as const, data: attachment.data, mimeType: attachment.mimeType }));
}

/** Whether an entry is a persisted user message, which is what makes a prompt not the first. */
function isUserEntry(entry: SessionEntry): boolean {
	if (entry.type !== "message") return false;
	return (entry.message as { role?: unknown }).role === "user";
}

/**
 * The kernel consumes a slash command without journaling the text the user sent
 * (`AgentSession.prompt` executes extension commands directly), so the flow
 * shows a command's effects — a goal card, a compaction row — but never the
 * command line itself. The host echoes it as a custom entry: presentation
 * only, never model context (the same rule as the thinking timings).
 */
export const COMMAND_ECHO_TYPE = "stepcode-web.command-echo";

/**
 * Kernel extension commands reachable from the composer. `/mcp`, `/btw` and
 * `/feedback` are client-side surfaces and never arrive at `send`; the
 * `ultracode:` keyword form is an ordinary message and journals on its own.
 */
const ECHOED_COMMANDS: ReadonlySet<string> = new Set([
	"goal",
	"plan",
	"init",
	"compact",
	"permissions",
	"ultraloop",
	"ultracode",
	"todos",
	"cron",
	"workflows",
	"plugin",
	"llama",
]);

/**
 * The command line to echo for `text`, or null when it is not a kernel
 * command. `/skill:` never echoes: its expansion journals as a user message
 * that already carries the skill badge.
 */
export function commandEchoText(text: string): string | null {
	const name = /^\/([A-Za-z0-9][\w.:-]*)(?:\s|$)/u.exec(text)?.[1];
	if (!name || !ECHOED_COMMANDS.has(name)) return null;
	return text.trim();
}

/**
 * Command names a prompt template cannot take over: the kernel commands the
 * composer reaches and the Web surfaces it handles itself. An open session
 * also knows its registered extension commands (see `WebSession.commands`).
 */
function isReservedCommandName(name: string): boolean {
	return ECHOED_COMMANDS.has(name) || name === "mcp" || name === "btw" || name === "feedback";
}

/** Commands `AgentSession` handles itself, before any extension command (`_handleLiveContextCommand`). */
const LIVE_CONTEXT_COMMANDS: ReadonlySet<string> = new Set(["clm", "clm-compact"]);

/** Same provider and model id, which is all a resolved model needs to match. */
function modelsMatch(left: { provider: string; id: string }, right: { provider: string; id: string }): boolean {
	return left.provider === right.provider && left.id === right.id;
}

/**
 * The round a goal continuation message starts (the extension's
 * `details.iteration` counts completed runs), for the flow's round separator.
 * Validated like the subagent notification: a malformed number must not
 * invent a round.
 */
function goalRoundOf(entry: SessionEntry): number | undefined {
	if (entry.type !== "custom_message" || entry.customType !== "step-goal") return undefined;
	const iteration = (entry.details as { iteration?: unknown } | undefined)?.iteration;
	return typeof iteration === "number" && Number.isSafeInteger(iteration) && iteration >= 0
		? iteration + 1
		: undefined;
}

export function projectEntry(entry: SessionEntry): Record<string, unknown> {
	// Only assistant turns carry usage; other message kinds have none to report.
	const usage =
		entry.type === "message" && entry.message.role === "assistant" && !entry.imported
			? entry.message.usage
			: undefined;
	const notification =
		entry.type === "custom_message" ? projectSubagentNotification(entry.customType, entry.details) : undefined;
	// The command echo's text rides the custom entry's data.
	const echo = commandEchoOf(entry);
	const goalRound = goalRoundOf(entry);
	return {
		id: entry.id,
		type: entry.type,
		timestamp: entry.timestamp,
		...(entry.imported ? { imported: entry.imported } : {}),
		...(entry.type === "message" ? { message: entry.message } : {}),
		...(usage ? { usage } : {}),
		...(entry.type === "custom_message" ? { content: entry.content, customType: entry.customType } : {}),
		...(notification ? { details: notification } : {}),
		...(entry.type === "custom" && entry.customType === SUBAGENT_RESPONSE_ENTRY
			? { customType: entry.customType, data: entry.data }
			: {}),
		...(goalRound === undefined ? {} : { goalRound }),
		...(echo === undefined ? {} : { customType: COMMAND_ECHO_TYPE, command: echo }),
		// A compaction row shows what it replaced: the summary, the prompt volume
		// before it, and the entry that stays canonical after it.
		...(entry.type === "compaction"
			? {
					summary: entry.summary,
					tokensBefore: entry.tokensBefore,
					firstKeptEntryId: entry.firstKeptEntryId,
				}
			: {}),
		...(entry.type === "branch_summary" ? { summary: entry.summary } : {}),
	};
}

/** The echoed command line of a command-echo custom entry, or undefined for every other entry. */
function commandEchoOf(entry: SessionEntry): string | undefined {
	if (entry.type !== "custom" || entry.customType !== COMMAND_ECHO_TYPE) return undefined;
	const text = (entry.data as { text?: unknown } | undefined)?.text;
	return typeof text === "string" && text ? text : undefined;
}

/**
 * Whether a tool batch that ends the branch is missing a result.
 *
 * A settled batch can end the transcript: a tool or permission hook can
 * terminate the run, and a manual `/clm` stops after the turn whose context edit
 * was accepted. Only a call without its result proves the run was cut off while
 * the tool was still running.
 */
function hasUnansweredToolCall(entries: readonly SessionEntry[], resultIndex: number): boolean {
	let batchIndex = -1;
	for (let index = resultIndex - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "message") continue;
		if (entry.message.role !== "assistant") continue;
		if (!entry.message.content.some((block) => block.type === "toolCall")) continue;
		batchIndex = index;
		break;
	}
	const batch = batchIndex < 0 ? undefined : entries[batchIndex];
	if (batch?.type !== "message" || batch.message.role !== "assistant") return false;
	const calls = batch.message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []));
	if (!calls.length) return false;
	const answered = new Set<string>();
	for (let index = batchIndex + 1; index < entries.length; index++) {
		const entry = entries[index];
		if (entry?.type === "message" && entry.message.role === "toolResult") answered.add(entry.message.toolCallId);
	}
	return calls.some((id) => !answered.has(id));
}

/**
 * Whether the newest turn on this branch was cut off rather than finished.
 *
 * A host that stops mid-turn records the partial reply as `aborted`, and a crash
 * leaves the branch ending in a shape only an unfinished turn produces. Both used
 * to read as a conversation that simply ended early; this lets the page say a run
 * was interrupted. Derived from entries so the answer survives a restart, and
 * false while a turn runs, where an unanswered prompt is just the turn still
 * starting.
 *
 * Tool work needs care: a branch may legitimately end on a tool result (a tool or
 * permission hook terminated the run, or a manual `/clm` stopped after its
 * accepted edit), so a trailing result only counts when its call never answered.
 * A trailing tool-use assistant has no results at all, which is the killed-host
 * shape. Errors and truncated replies are not "interrupted": they are rendered
 * as what they are.
 */
export function hasInterruptedTurn(entries: readonly SessionEntry[], running: boolean): boolean {
	if (running) return false;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "message") continue;
		// Imported tails are source snapshots, not evidence of a stopped native turn.
		if (entry.imported) return false;
		const message = entry.message;
		if (message.role === "user") return true;
		if (message.role === "toolResult") return hasUnansweredToolCall(entries, index);
		if (message.role === "assistant") return message.stopReason === "aborted" || message.stopReason === "toolUse";
	}
	return false;
}

/**
 * Timing is host presentation metadata, not a field added to provider messages.
 * So is `promptCommand`: the line a user message expanded from, when it was a
 * prompt command (`prompt-commands.ts`), so the flow shows that line instead
 * of the whole template.
 */
export function projectEntries(entries: readonly SessionEntry[]): Record<string, unknown>[] {
	const timings = savedThinkingTimings(entries);
	const promptCommands = pairPromptCommands(entries);
	return entries.map((entry) => {
		const thinkingTimings =
			entry.type === "message" && entry.message.role === "assistant"
				? timings.get(entry.message.timestamp)
				: undefined;
		const promptCommand = promptCommands.get(entry.id);
		return {
			...projectEntry(entry),
			...(thinkingTimings ? { thinkingTimings } : {}),
			...(promptCommand ? { promptCommand } : {}),
		};
	});
}

/** The summary board's goal section data, or undefined when the session has no goal to show. */
export function projectGoal(goal: StepGoalRecord | undefined): Record<string, unknown> | undefined {
	if (!goal) return undefined;
	return {
		id: goal.id,
		objective: goal.objective,
		status: goal.status,
		tokensUsed: goal.tokensUsed,
		// Active-only elapsed time; the client ticks from it between refreshes.
		timeUsedSeconds: goal.timeUsedSeconds,
		...(goal.tokenBudget === undefined ? {} : { tokenBudget: goal.tokenBudget }),
		// Completed runs, not a stop condition: the client shows it as progress.
		rounds: goal.iteration,
	};
}

/**
 * Plan mode as a client reads it. `enabled` drives the composer's plan affordance;
 * `planFilePath` is the file an open plan is drafting into.
 */
export function projectPlanMode(
	state: { enabled: boolean; planFilePath?: string; planSource: string } | undefined,
): Record<string, unknown> {
	return {
		enabled: state?.enabled ?? false,
		...(state?.planFilePath ? { planFilePath: state.planFilePath } : {}),
		...(state?.enabled ? { planSource: state.planSource } : {}),
	};
}

/** The text of a recorded user message, whichever shape the kernel stored. */
function userMessageText(content: string | readonly { readonly type: string; readonly text?: string }[]): string {
	if (typeof content === "string") return content;
	return content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join(" ");
}

/** The entry a nameless fork starts from: the last thing the user said. */
function lastUserEntryId(session: AgentSession): string | undefined {
	const branch = session.sessionManager.getBranch();
	return [...branch].reverse().find((entry) => entry.type === "message" && entry.message.role === "user")?.id;
}

/** Appended to the parent title by every fork, so a fork of a fork reads `_fork_fork`. */
const FORK_SUFFIX = "_fork";
/** Keep the suffix visible: a fork of a very long title is shortened, not truncated past the suffix. */
const FORK_TITLE_MAX = 96;
/** A session named after its prompt-command line keeps the name a sidebar row can show. */
const PROMPT_COMMAND_NAME_MAX = 96;

function forkTitleOf(parent: string): string {
	const room = FORK_TITLE_MAX - FORK_SUFFIX.length;
	const base = parent.length <= room ? parent : `${parent.slice(0, room - 1).trimEnd()}…`;
	return `${base}${FORK_SUFFIX}`;
}

export class WebSession {
	readonly broker: ApprovalBroker;
	readonly clarifications: ClarificationBroker;
	readonly selections: SelectionBroker;
	readonly textInputs: TextInputBroker;
	/** `/btw` answers of this session, oldest first. Process memory, never persisted. */
	private sideAnswers: WebSideAnswer[] = [];
	private readonly listeners = new Set<(event: WebEvent) => void>();
	private readonly subagentLanes = new Map<string, SubagentLaneSnapshot>();
	private runtime!: AgentSessionRuntime;
	private session!: AgentSession;
	private status: WebSessionStatus = "idle";
	private readonly closeListeners = new Set<() => void>();
	private unread = false;
	/**
	 * Set once `close` starts. Anything that would start work must check it: a
	 * queued dispatch or a request already parsed when shutdown began would
	 * otherwise start a turn on a disposed session, spending a model call whose
	 * reply has nowhere to land.
	 */
	private closing = false;
	/**
	 * Prompts accepted but not yet running.
	 *
	 * The kernel only starts a run after its pre-run work (auth, compaction
	 * check, `before_agent_start` hooks such as MCP reconciliation), and until
	 * then neither its run state nor this session's status says "busy". A
	 * shutdown in that window would dispose the session with the prompt still in
	 * memory, so the count is part of `isBusy` and shutdown waits for the run.
	 */
	private pendingPrompts = 0;
	/** Pages following this session's event stream right now; a run that ends in front of one is already seen. */
	private viewers = 0;
	private unsubscribeSession?: () => void;
	private unsubscribeRuntimeSessionChange?: () => void;
	private releaseWriterLease?: () => void;
	/**
	 * Set by the store: re-keys a session after a fork, when the same object
	 * starts advertising the new session id.
	 */
	adopt?: (previousId: string, id: string, session: WebSession) => void;
	/** Receives this session's file writes, including those of forks and /new. */
	private index?: SessionIndexSink;
	private writerLeasePath?: string;
	private archived = false;
	private readonly reverter = new TurnReverter();
	/** Set while `fork` swaps the session, so a second click cannot branch again. */
	private forking = false;
	/** Status a pending selection interrupted, restored once it is answered. */
	private statusBeforeSelection?: WebSessionStatus;
	/** Set while `setPolicy` waits to learn whether its command raised a dialog. */
	private selectionRaised?: () => void;
	/** The `/permissions` command still running behind an open dialog. */
	private pendingPolicy?: Promise<void>;
	/**
	 * The tier the kernel is enforcing right now. It can differ from the Step
	 * settings: a "this session" Full Access grant is not persisted, and a
	 * persisted Full Access still waiting for its risk acknowledgment runs as
	 * Approve for Me.
	 */
	private livePermission?: StepPermissionPresetId;
	/** Messages sent while a turn runs; the next one starts when the run settles (see `dispatchQueued`). */
	private readonly queue = new MessageQueue(() => this.emit({ type: "queue", ...this.queueState() }));
	/** The images of the kernel's pending steering messages, which it lists as text only. */
	private readonly steeringImages = new SteeringImages();
	/** Set by `interrupt`: the run it stops settles without starting the next queued message. */
	private holdQueue = false;
	/** The last run ended in an error or abort; its settle leaves the queue for the user. */
	private lastRunFailed = false;
	/**
	 * The last run was stopped by the user rather than failing on its own.
	 *
	 * Both reach `status: "failed"`, but a turn the user interrupted has no
	 * finished reply, so the client must not credit it with a model and a time.
	 */
	private lastRunAborted = false;
	/** The kernel's retry of a failed model request, while one is scheduled or running. */
	private readonly retry = new RetryTracker();
	/** Prompt-command lines sent but not yet seen as a user `message_start`. */
	private readonly livePromptCommands = new LivePromptCommands();
	/**
	 * Counts what this session's listeners have been told. A snapshot stamped
	 * with an older revision describes a state the page has already moved past;
	 * a reader that still applied it would resurrect a stopped turn's status.
	 */
	private revision = 0;
	/** Settles when the bound session's `session_start` handlers (MCP startup included) have finished. */
	private extensionsReady: Promise<void> = Promise.resolve();
	/** Startup of the bound session; replaced on fork or /new so a stale binding cannot report into it. */
	private extensionsStartup: { settled: boolean } = { settled: true };
	/**
	 * A sent message waiting for extension startup before it becomes a prompt.
	 * Other messages queue behind it, and `interrupt` cancels it back into the queue.
	 */
	private startingPrompt?: { cancelled: boolean };
	/** One background attempt to name this session after its first prompt has run. */
	private sessionTitleGenerated = false;
	/**
	 * Feedback evidence prepared for the dialog the user is reading, until the
	 * submission that consumes it (see `feedback-report.ts`).
	 */
	private readonly feedbackDrafts = new FeedbackDrafts((evidence) => this.describeFeedbackPreview(evidence));

	private constructor(
		id: string,
		cwd: string,
		agentDir: string,
		modelRuntime: ModelRuntime,
		sessionManager: ReturnType<typeof createStepSessionManager>,
		writerOwnerId: string,
	) {
		this.id = id;
		this.cwd = cwd;
		this.agentDir = agentDir;
		this.modelRuntime = modelRuntime;
		this.sessionManager = sessionManager;
		this.writerOwnerId = writerOwnerId;
		this.clarifications = new ClarificationBroker(
			() => this.id,
			(event) => {
				if (event.type === "clarification_required") this.setStatus("waiting", false);
				this.emit(event);
				if (
					event.type === "clarification_resolved" &&
					!this.clarifications.pendingRequests().length &&
					!this.broker.pendingRequests().length
				)
					this.setStatus("running", false);
			},
		);
		this.broker = new ApprovalBroker(id, (event) => {
			if (event.type === "approval_required") this.setStatus("waiting", false);
			this.emit(event);
		});
		// A kernel selector blocks whatever asked for it, so it is a wait: the
		// session cannot proceed until the user answers. Unlike approvals it can
		// also be raised outside a turn (a `/permissions` switch, or the Full
		// Access gate at session start), so the status it interrupted is restored
		// rather than assumed to be "running".
		this.selections = new SelectionBroker(
			() => this.id,
			(event) => {
				if (event.type === "selection_required" && this.status !== "waiting") {
					this.statusBeforeSelection = this.status;
					this.setStatus("waiting", false);
				}
				if (event.type === "selection_required") this.selectionRaised?.();
				this.emit(event);
				if (
					event.type === "selection_resolved" &&
					!this.selections.pendingRequests().length &&
					!this.textInputs.pendingRequests().length &&
					!this.clarifications.pendingRequests().length &&
					!this.broker.pendingRequests().length
				) {
					this.setStatus(this.statusBeforeSelection ?? "idle", false);
					this.statusBeforeSelection = undefined;
				}
			},
		);
		// A kernel text prompt is a wait too: the command is suspended until the
		// answer arrives. It shares the "waiting" projection with selectors so the
		// composer does not start a second turn behind a half-answered dialog.
		this.textInputs = new TextInputBroker(
			() => this.id,
			(event) => {
				if (event.type === "text_input_required" && this.status !== "waiting") {
					this.statusBeforeSelection = this.status;
					this.setStatus("waiting", false);
				}
				this.emit(event);
				if (
					event.type === "text_input_resolved" &&
					!this.textInputs.pendingRequests().length &&
					!this.selections.pendingRequests().length &&
					!this.clarifications.pendingRequests().length &&
					!this.broker.pendingRequests().length
				) {
					// The saved status can be stale: the run may have settled while the
					// dialog was open. The live session knows whether one is active.
					this.setStatus(this.session.isStreaming ? "running" : (this.statusBeforeSelection ?? "idle"), false);
					this.statusBeforeSelection = undefined;
				}
			},
		);
	}

	/** Follows the live session: a fork or /new swaps the manager underneath. */
	id: string;
	readonly cwd: string;
	private readonly agentDir: string;
	private readonly modelRuntime: ModelRuntime;
	private readonly sessionManager: ReturnType<typeof createStepSessionManager>;
	private readonly writerOwnerId: string;

	static async create(options: {
		cwd: string;
		sessionId?: string;
		sessionPath?: string;
		index?: SessionIndexSink;
	}): Promise<WebSession> {
		const agentDir = resolveStepAgentDir();
		const cwd = options.cwd;
		const authPath = getStepAuthPath();
		// The stored credential names a login region, and the provider reads that
		// region's endpoints from the environment. The CLI does this before it
		// builds a session; without it a `step_plan` credential is sent to the
		// default endpoint, discovery fails, and the session has no model at all.
		syncStepLoginProfileEndpoint(authPath);
		const modelRuntime = await ModelRuntime.create({
			authPath,
			modelsPath: join(resolveStepConfigRoot(), "models.json"),
		});
		modelRuntime.registerProvider(STEP_PROVIDER_ID, createStepProviderConfig());
		const writerOwnerId = randomUUID();
		const releaseWriterLease = options.sessionPath
			? claimWebSessionWriter(options.sessionPath, writerOwnerId)
			: undefined;
		try {
			const sessionManager = options.sessionPath
				? openStepSession(options.sessionPath, { agentDir, cwd, cwdOverride: cwd })
				: createStepSessionManager(cwd, {
						agentDir,
						newSession: options.sessionId ? { id: options.sessionId } : undefined,
					});
			if (options.index) attachSessionIndex(sessionManager, options.index);
			const instance = new WebSession(
				sessionManager.getSessionId(),
				cwd,
				agentDir,
				modelRuntime,
				sessionManager,
				writerOwnerId,
			);
			instance.index = options.index;
			instance.releaseWriterLease = releaseWriterLease;
			instance.writerLeasePath = options.sessionPath ? resolve(options.sessionPath) : undefined;
			await instance.start();
			// After start(): building the services re-registers the Step provider,
			// and each registration resets the catalog to the models.json baseline.
			await refreshStepModelCatalog(modelRuntime);
			return instance;
		} catch (error) {
			releaseWriterLease?.();
			throw error;
		}
	}

	private async start(): Promise<void> {
		const initialSessionFile = this.sessionManager.getSessionFile();
		const resolvedInitialSessionFile = initialSessionFile ? resolve(initialSessionFile) : undefined;
		if (resolvedInitialSessionFile && resolvedInitialSessionFile !== this.writerLeasePath) {
			const claim = claimWebSessionWriter(resolvedInitialSessionFile, this.writerOwnerId);
			this.releaseWriterLease?.();
			this.releaseWriterLease = claim;
			this.writerLeasePath = resolvedInitialSessionFile;
		}
		const createRuntime = async (options: {
			cwd: string;
			agentDir: string;
			sessionManager: ReturnType<typeof createStepSessionManager>;
			sessionStartEvent?: {
				type: "session_start";
				reason: "startup" | "reload" | "new" | "resume" | "fork";
				previousSessionFile?: string;
			};
		}) => {
			const settingsManager = createStepSettingsManager(options.cwd, options.agentDir, {
				configDirName: resolveStepConfigDir(),
			});
			// Read per session: config.toml can change while the host runs, and the
			// CLI re-reads it at every launch.
			const defaults = resolveWebDefaultModel(readGlobalStepDefaults());
			const services = await createStepAgentSessionServices({
				cwd: options.cwd,
				agentDir: options.agentDir,
				authPath: getStepAuthPath(),
				configDirName: resolveStepConfigDir(),
				settingsManager,
				modelRuntime: this.modelRuntime,
				resourceLoaderOptions: {
					extensionFactories: webExtensions(
						settingsManager,
						this.broker,
						(preset) => {
							this.livePermission = preset;
						},
						// The session does not exist yet when the extension list is built,
						// so recording resolves its skill list lazily, once it does.
						() => this.usageResources(),
						(lane) => {
							if (!lane) this.subagentLanes.clear();
							else {
								retainSubagentLane(this.subagentLanes, lane);
							}
							this.emit({ type: "subagent_lane", lane });
						},
					),
				},
			});
			// Resolve the model against a populated catalog. `models.json` is only an
			// offline baseline and Step ships none, so an unrefreshed runtime offers
			// zero models and the session is left on the `unknown` placeholder.
			await refreshStepModelCatalog(this.modelRuntime);
			// The Step model-facing tools, exactly as the CLI mounts them. Without
			// this the host runs Pi's builtins (`read`/`write`/`edit`/`bash`) while the
			// prompt, the plan extension and the CLI all name Step's tools
			// (`read_file`/`write_file`/`run_command`), so plan mode activated tools
			// that did not exist and the model could not write its own proposal.
			const profileTools = createStepToolProfile(options.cwd, {
				agentDir: options.agentDir,
				searchWeb: { authPath: getStepAuthPath() },
				read: { autoResizeImages: settingsManager.getImageAutoResize() },
				bash: {
					commandPrefix: settingsManager.getShellCommandPrefix(),
					shellPath: settingsManager.getShellPath(),
				},
			});
			const created = await createAgentSessionFromServices({
				services,
				sessionManager: options.sessionManager,
				...(profileTools.length ? { customTools: profileTools, noTools: "builtin" as const } : {}),
				sessionStartEvent: options.sessionStartEvent,
				// Same defaults the CLI injects into argv (`withStepDefaults`): the
				// persisted provider/model from config.toml, with the product
				// provider and model as the fallback. The settings manager already
				// carries the persisted thinking level, so it is not repeated here.
				defaultProvider: defaults.provider,
				...(defaults.modelId ? { defaultModelId: defaults.modelId } : {}),
				// The app identity and the Step operating contract come from
				// coding-agent: Desktop runs this host, so both share one definition
				// instead of the host assembling a prompt of its own.
				systemPromptProduct: STEP_APP_SYSTEM_PROMPT_PRODUCT,
			});
			return { ...created, services, diagnostics: services.diagnostics };
		};
		try {
			this.runtime = await createAgentSessionRuntime(createRuntime, {
				cwd: this.cwd,
				agentDir: this.agentDir,
				sessionManager: this.sessionManager,
				sessionManagerFactory: this.index
					? withSessionIndex(createStepSessionManagerFactory(this.agentDir), this.index)
					: createStepSessionManagerFactory(this.agentDir),
			});
			this.bindSession(this.runtime.session);
			this.unsubscribeRuntimeSessionChange = this.runtime.onSessionChange((session) => this.bindSession(session));
		} catch (error) {
			this.releaseWriterLease?.();
			this.releaseWriterLease = undefined;
			this.writerLeasePath = undefined;
			throw error;
		}
	}

	private bindSession(session: AgentSession): void {
		this.clarifications.clear();
		// A replaced session's dialogs answer nothing: the kernel's generation
		// guard already ignores them. Dismiss them so the new session starts clean.
		this.selections.clear();
		this.textInputs.clear();
		// A prepared report describes the conversation it was prepared from. After
		// a fork or `/new` that is a different branch and a different file, so a
		// token from before the rebind must not submit it under the new id.
		this.feedbackDrafts.clear();
		this.livePermission = undefined;
		// Keep the advertised id in step with the session actually bound, so a
		// fork or /new does not leave the UI pointing at the previous session.
		//
		// The store key is deliberately not moved here: only `fork()` returns an
		// id the client navigates to. A `/clear` or `switchSession` keeps its key
		// pointing at this object, which is what the open page still polls.
		this.id = session.sessionManager.getSessionId();
		const sessionFile = session.sessionManager.getSessionFile();
		const resolvedSessionFile = sessionFile ? resolve(sessionFile) : undefined;
		if (resolvedSessionFile !== this.writerLeasePath) {
			let claim: (() => void) | undefined;
			try {
				claim = resolvedSessionFile ? claimWebSessionWriter(resolvedSessionFile, this.writerOwnerId) : undefined;
			} catch (error) {
				this.publishError(error instanceof Error ? error.message : String(error));
				return;
			}
			this.releaseWriterLease?.();
			this.releaseWriterLease = claim;
			this.writerLeasePath = resolvedSessionFile;
		}
		this.unsubscribeSession?.();
		this.session = session;
		this.retry.clear();
		void this.adoptFallbackModel(session);
		const thinkingClock = new ThinkingClock();
		this.unsubscribeSession = session.subscribe((event) => {
			const thinkingTimings = thinkingClock.observe(event);
			if (event.type === "message_end" || event.type === "agent_end" || event.type === "agent_settled") {
				const observation = thinkingClock.completed();
				if (observation) {
					try {
						session.sessionManager.appendCustomEntry(THINKING_TIMING_TYPE, observation);
					} catch (error) {
						// Diagnostic metadata must not prevent canonical message persistence.
						this.emit({
							type: "error",
							message: `Could not save thinking elapsed time: ${error instanceof Error ? error.message : String(error)}`,
						});
					}
				}
			}
			if (event.type === "agent_start") {
				// A new run supersedes the outcome that was waiting to be seen.
				this.setStatus("running", false);
				this.holdQueue = false;
				this.lastRunFailed = false;
				this.lastRunAborted = false;
			}
			if (event.type === "agent_settled") this.setStatus("completed", this.unseen());
			if (event.type === "agent_end") {
				const stops = event.messages.flatMap((message) =>
					message.role === "assistant" ? [message.stopReason] : [],
				);
				// A failure the kernel is about to retry is not the run's outcome: the
				// session keeps running through the backoff (`auto_retry_start` follows).
				if (stops.includes("error") && !event.willRetry) this.setStatus("failed", this.unseen());
				this.lastRunFailed = stops.includes("error") || stops.includes("aborted");
				// An error may also carry `aborted` after a retry gave up; the user's
				// own stop is the case with no error at all.
				this.lastRunAborted = !stops.includes("error") && stops.includes("aborted");
			}
			this.retry.apply(event);
			if (event.type === "auto_retry_start" && this.status !== "running") this.setStatus("running", false);
			if (event.type === "queue_update") this.emit({ type: "queue", ...this.queueState() });
			// A prompt command's expansion arrives as an ordinary user message; the
			// line it came from rides the live event (the snapshot pairs it from the journal).
			const promptCommand =
				event.type === "message_start"
					? this.livePromptCommands.take(promptMessageText(event.message) ?? "")
					: undefined;
			this.emit({
				type: "agent",
				event,
				...(thinkingTimings ? { thinkingTimings } : {}),
				...(promptCommand ? { promptCommand } : {}),
			});
			if (event.type === "agent_settled") {
				const hold = this.holdQueue || this.lastRunFailed;
				this.holdQueue = false;
				// Deferred: the kernel finishes settling after its listeners return,
				// and an extension may have started a follow-up run in the meantime.
				if (!hold) setImmediate(() => this.dispatchQueued());
			}
			// A manual compaction settles no run, so queued messages wait for this
			// event instead. Auto compaction is part of a run: its retry continues
			// the turn, and `agent_settled` dispatches the queue after that.
			if (event.type === "compaction_end" && event.reason === "manual" && !this.session.isStreaming) {
				setImmediate(() => this.dispatchQueued());
			}
		});
		// Extension startup (MCP servers above all) registers tools after binding.
		// A prompt sent before it settles goes out without them, so the first
		// message of a new chat could not call any MCP tool. `send` waits on this.
		const bound = { settled: false };
		this.extensionsStartup = bound;
		const binding = session.bindExtensions({
			mode: "rpc",
			uiContext: webUiContext(
				this.broker,
				this.clarifications,
				this.selections,
				this.textInputs,
				(notice) => this.emit({ type: "notice", ...notice }),
				(answer) => this.recordSideAnswer(answer),
			),
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: (options) => this.runtime.newSession(options),
				fork: (entryId, options) => this.runtime.fork(entryId, options),
				navigateTree: (targetId, options) => session.navigateTree(targetId, options),
				switchSession: (path, options) => this.runtime.switchSession(path, options),
				reload: () => session.reload(),
			},
			onError: (error) => this.emit({ type: "error", message: error.error }),
		});
		this.extensionsReady = binding.then(
			() => {
				bound.settled = true;
			},
			(caught: unknown) => {
				bound.settled = true;
				// A failed startup keeps the tools it did register; the session stays
				// usable, so report it instead of blocking prompts.
				if (this.extensionsStartup === bound)
					this.emit({
						type: "error",
						message: `Extension startup failed: ${caught instanceof Error ? caught.message : String(caught)}`,
					});
			},
		);
	}

	private setStatus(status: WebSessionStatus, unread = this.unread): void {
		this.status = status;
		this.unread = unread;
		this.emit({ type: "status", status, unread });
	}

	private emit(event: WebEventBody): void {
		this.revision += 1;
		const stamped: WebEvent = { ...event, revision: this.revision };
		for (const listener of this.listeners) listener(stamped);
	}

	publishError(message: string): void {
		this.emit({ type: "error", message });
		this.setStatus("failed", this.unseen());
	}

	/** An outcome nobody is watching stays unread until a page opens the session. */
	private unseen(): boolean {
		return this.viewers === 0;
	}

	/** Status and unread flag, for session rows that do not follow this session's stream. */
	liveStatus(): { status: WebSessionStatus; unread: boolean } {
		return { status: this.status, unread: this.unread };
	}

	subscribe(listener: (event: WebEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * A page opened this session and follows its stream: whatever it ended with
	 * is now seen, and so is any outcome reached while the page stays. The
	 * returned release must be called once, when that stream closes.
	 */
	watch(): () => void {
		this.viewers += 1;
		if (this.unread) this.setStatus(this.status, false);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.viewers -= 1;
		};
	}

	/** Called once when the session is closed; an SSE stream ends so the page reconnects. */
	onClose(listener: () => void): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	/** A turn is running, waiting on the user, or accepted and still being set up. */
	isBusy(): boolean {
		return this.status === "running" || this.status === "waiting" || this.pendingPrompts > 0;
	}

	/**
	 * Give a session a real model when resolution produced none.
	 *
	 * Discovery is a network call with no built-in baseline, so a credential that
	 * is valid but momentarily unusable leaves the session on the `unknown`
	 * placeholder. Sending then fails with "No API key found for the selected
	 * model", which names no provider and hides the real problem. The default
	 * model, or else any model the runtime lists, is a better answer.
	 */
	private async adoptFallbackModel(session: AgentSession): Promise<void> {
		const available = this.modelRuntime.getAvailableSnapshot();
		// A model the runtime does not list is one agent-core could not resolve,
		// including the `unknown` placeholder it falls back to.
		const current = session.model;
		if (current && available.some((model) => modelsMatch(model, current))) return;
		const fallback = pickFallbackModel(available, resolveWebDefaultModel(readGlobalStepDefaults()));
		if (!fallback) return;
		try {
			await session.setModel(fallback);
		} catch (error) {
			// A model that fails to apply is not worth failing the session over:
			// the user still has the picker, and the error would otherwise be lost.
			this.publishError(error instanceof Error ? error.message : String(error));
		}
	}

	/** A revert is writing files right now; prompts wait for it. */
	isReverting(): boolean {
		return this.reverter.isBusy();
	}

	/**
	 * Start a turn with `text`. `followUp` is for queued messages: should a run
	 * have started since the caller looked, the kernel queues the message after
	 * it instead of rejecting it.
	 */
	async send(text: string, attachments: readonly WebAttachment[] = [], followUp = false): Promise<void> {
		if (this.isReverting()) throw new Error("Wait for the revert to finish");
		await this.promptTracked(() => {
			this.unread = false;
			return this.sendWithinTurn(text, attachments, followUp);
		});
	}

	/**
	 * Run one kernel prompt under the session's lifecycle.
	 *
	 * The composer's path is `send`, but session control reaches the kernel
	 * directly: `/goal <objective>` starts a real turn, and `/plan` /
	 * `/ultraloop` can too. All of them must refuse work once closing and count
	 * as a pending turn until their run starts, or shutdown disposes the session
	 * with the prompt still in memory — the same loss `send` guards against.
	 * Commands that only configure the session (`/permissions`, `/goal pause`)
	 * settle without a run; waiting for one exits as soon as they do.
	 */
	private async promptTracked(start: () => Promise<void>): Promise<void> {
		if (this.closing) throw new Error("This session is closing");
		this.pendingPrompts += 1;
		try {
			await start();
		} finally {
			this.pendingPrompts -= 1;
		}
	}

	private async sendWithinTurn(text: string, attachments: readonly WebAttachment[], followUp: boolean): Promise<void> {
		if (!this.extensionsStartup.settled) {
			if (this.startingPrompt) {
				// A second message before the first could start waits behind it.
				this.queue.add({ text, attachments, files: [] });
				return;
			}
			const starting = { cancelled: false };
			this.startingPrompt = starting;
			const before = this.status;
			// The page already shows the pending turn; report it as running so
			// further messages queue behind it instead of racing it.
			if (before !== "waiting") this.setStatus("running", false);
			try {
				await this.extensionsReady;
			} finally {
				if (this.startingPrompt === starting) this.startingPrompt = undefined;
			}
			if (starting.cancelled) {
				// Stopped before it began: keep what the user sent, like a stopped turn does.
				this.queue.prepend([{ text, attachments }]);
				return;
			}
			try {
				await this.promptNow(text, attachments, followUp);
			} finally {
				// A message the kernel handled without a run (an extension command)
				// never emits agent_start/agent_settled; do not leave it "running".
				if (this.status === "running" && !this.session.isStreaming) this.setStatus(before, false);
			}
			return;
		}
		await this.promptNow(text, attachments, followUp);
	}

	private async promptNow(text: string, attachments: readonly WebAttachment[], followUp: boolean): Promise<void> {
		this.echoCommand(text);
		this.maybeGenerateSessionTitle(text);
		const images = imagesOf(attachments);
		const sent = withTextAttachments(text, attachments);
		const promptCommand = this.recordPromptCommand(text, sent);
		if (promptCommand) this.nameAfterPromptCommand(promptCommand);
		await this.session.prompt(sent, {
			source: "rpc",
			...(images.length ? { images } : {}),
			...(followUp ? { streamingBehavior: "followUp" as const } : {}),
		});
	}

	/**
	 * Journal the command line of a kernel slash command before the kernel
	 * consumes it (see `COMMAND_ECHO_TYPE`). Queued sends replay through
	 * `send`, so they echo when they actually run.
	 */
	private echoCommand(text: string): void {
		const command = commandEchoText(text);
		if (command) this.session.sessionManager.appendCustomEntry(COMMAND_ECHO_TYPE, { text: command });
	}

	/**
	 * Journal the line of a prompt command before the kernel expands it (see
	 * `prompt-commands.ts`), so the flow can show that line instead of the
	 * template; returns that line. Presentation only: a failure to record it
	 * must not stop the prompt, which then simply shows expanded.
	 */
	private recordPromptCommand(typed: string, sent: string): string | undefined {
		const record = promptCommandRecord(typed, sent, this.session.promptTemplates);
		if (!record) return undefined;
		try {
			this.session.sessionManager.appendCustomEntry(PROMPT_COMMAND_TYPE, record);
			this.livePromptCommands.add(record);
			return record.text;
		} catch (error) {
			this.emit({
				type: "error",
				message: `Could not record the command line: ${error instanceof Error ? error.message : String(error)}`,
			});
			return undefined;
		}
	}

	/**
	 * A session opened by a prompt command is named after that line. Without a
	 * name the sidebar falls back to the first message, which is the whole
	 * expanded template, and a slash line is never sent for a generated title.
	 */
	private nameAfterPromptCommand(line: string): void {
		if (this.sessionTitleGenerated || this.session.sessionName) return;
		if (this.session.sessionManager.getBranch().some(isUserEntry)) return;
		this.sessionTitleGenerated = true;
		const name = line.replace(/\s+/g, " ").trim();
		this.session.setSessionName(
			name.length > PROMPT_COMMAND_NAME_MAX ? `${name.slice(0, PROMPT_COMMAND_NAME_MAX - 3)}...` : name,
		);
	}

	/**
	 * Name the session after its first input, whatever that input triggers (a
	 * plain prompt, a `/goal` objective, a skill), with a fire-and-forget
	 * sidecar call on the session's own model. A goal session journals no user
	 * message, so without this its sidebar row has no title at all. A failure
	 * is dropped. One attempt per open session, and a name set while it runs
	 * (the user renamed) always wins.
	 */
	private maybeGenerateSessionTitle(text: string): void {
		if (this.sessionTitleGenerated || this.session.sessionName) return;
		// A user message already on the branch means this send is not the first prompt.
		if (this.session.sessionManager.getBranch().some(isUserEntry)) return;
		const input = sessionTitleInput(text, (name) => this.slashCommandKind(name));
		if (!input) return;
		const model = this.session.model;
		if (!model) return;
		this.sessionTitleGenerated = true;
		// The session under `this.session` can change while the call runs (fork,
		// /new); the title belongs to the session whose first prompt seeded it.
		const session = this.session;
		void generateSessionTitle(this.modelRuntime, model, input)
			.then((title) => {
				if (!title || session !== this.session || session.sessionName) return;
				session.setSessionName(title);
			})
			.catch(() => {
				// Decoration only: a failed sidecar must not surface as a session error.
			});
	}

	/**
	 * What the kernel does with a leading `/name`, in its own dispatch order:
	 * a registered command (extension commands, the kernel's built-in
	 * live-context commands, and the reserved names the composer reaches) runs
	 * first, then a prompt template expands; anything else is plain prompt text.
	 */
	private slashCommandKind(name: string): SlashCommandKind {
		if (LIVE_CONTEXT_COMMANDS.has(name) || isReservedCommandName(name)) return "command";
		if (this.session.extensionRunner.getCommand(name)) return "command";
		if (this.session.promptTemplates.some((template) => template.name === name)) return "template";
		return undefined;
	}

	/** Hand `text` to the running turn, read before its next model call; refused for extension commands. */
	async steer(text: string, attachments: readonly WebAttachment[] = []): Promise<void> {
		const images = imagesOf(attachments);
		const sent = withTextAttachments(text, attachments);
		this.recordPromptCommand(text, sent);
		await this.session.steer(sent, images.length ? images : undefined);
		const queued = this.session.getSteeringMessages().at(-1);
		if (queued === undefined || !images.length) return;
		// The kernel published the steer before its images were recorded here.
		this.steeringImages.record(
			queued,
			attachments.filter((attachment) => attachment.kind === "image"),
		);
		this.emit({ type: "queue", ...this.queueState() });
	}

	queueState(): WebQueueState {
		return { queued: this.queue.views(), steering: this.steeringViews() };
	}

	private steeringViews(): SteeringMessageView[] {
		return this.steeringImages.match(this.session.getSteeringMessages()).map(({ text, images }) => ({
			text,
			images: images.map(({ mimeType, data }) => ({ mimeType, data })),
		}));
	}

	/** Whether a message sent now has to wait: a run is active, the context is being compacted, or the session waits on the user. */
	private mustQueue(): boolean {
		return (
			this.session.isStreaming ||
			this.session.isCompacting ||
			this.startingPrompt !== undefined ||
			this.status === "waiting" ||
			this.isReverting()
		);
	}

	/**
	 * Accept a message sent while a turn runs. It waits in the queue, editable,
	 * until the run settles. When nothing runs (the turn ended while the request
	 * was in flight) and nothing is queued before it, it starts at once.
	 */
	enqueue(input: { text: string; attachments: readonly WebAttachment[]; files: readonly QueuedFile[] }): void {
		// Shutdown is in progress: nothing queued now will ever run.
		if (this.closing) return;
		const item = this.queue.add(input);
		if (!this.mustQueue() && this.queue.size === 1) this.dispatchQueued(item.id);
	}

	editQueued(id: string, text: string): boolean {
		return this.queue.edit(id, text);
	}

	removeQueued(id: string): boolean {
		return this.queue.take(id) !== undefined;
	}

	/**
	 * Start the next queued message (or `id`) as a new turn, unless one must
	 * still wait. Its run's settle dispatches the one after it.
	 */
	private dispatchQueued(id?: string): boolean {
		// Shutdown is in progress: a turn started now would be disposed mid-stream.
		if (this.closing) return false;
		if (this.mustQueue()) return false;
		const item = id ? this.queue.take(id) : this.queue.shift();
		if (!item) return false;
		void this.sendQueued(item).catch((caught: unknown) => {
			this.publishError(caught instanceof Error ? caught.message : String(caught));
		});
		return true;
	}

	private async sendQueued(item: QueuedMessage): Promise<void> {
		const text = await withUploadedFiles(
			item.text,
			item.files.map((file) => file.id),
		);
		await this.send(text, item.attachments, true);
	}

	/**
	 * "Steer" queued messages (`ids`, or all of them): hand each to the running
	 * turn, which reads it before its next model call. With no run active the
	 * first one starts a new turn instead and the rest keep waiting. A message
	 * the kernel refuses to steer (an extension command) stays queued and its
	 * error is thrown after the others were handed over.
	 */
	async steerQueued(ids?: readonly string[]): Promise<boolean> {
		const known = new Set(this.queue.views().map((item) => item.id));
		const targets = ids ? ids.filter((id) => known.has(id)) : [...known];
		if (!targets.length) return false;
		if (!this.session.isStreaming) {
			if (this.status === "waiting" || this.isReverting())
				throw new Error("The session is waiting; try again later");
			return this.dispatchQueued(targets[0]);
		}
		const refused: QueuedMessage[] = [];
		let failure: unknown;
		for (const id of targets) {
			const item = this.queue.take(id);
			if (!item) continue;
			try {
				const text = await withUploadedFiles(
					item.text,
					item.files.map((file) => file.id),
				);
				await this.steer(text, item.attachments);
			} catch (caught) {
				refused.push(item);
				failure ??= caught;
			}
		}
		this.queue.restore(refused);
		if (failure) throw failure;
		return true;
	}

	async rename(name: string): Promise<void> {
		const trimmed = name.trim().slice(0, 20);
		if (!trimmed) throw new Error("Session name cannot be empty");
		this.session.setSessionName(trimmed);
	}

	/**
	 * Switch the permission tier through the official `/permissions` command, so
	 * the live permission controller, auto-resume and persistence stay in sync
	 * (reloading the extension tree would invalidate long-lived cron callbacks).
	 *
	 * Full Access makes that command ask the risk question and wait for the
	 * answer. Awaiting it here would hold the HTTP request open until the user
	 * decides, so this resolves as soon as the command either finishes or raises
	 * a dialog; the dialog is then in the snapshot, and `respondSelection` waits
	 * for the command to finish before it answers.
	 */
	async setPolicy(preset: StepPermissionPresetId): Promise<void> {
		if (!STEP_PERMISSION_PRESETS.some((candidate) => candidate.id === preset)) {
			throw new Error(`Unknown permission preset: ${preset}`);
		}
		if (this.pendingPolicy) throw new Error("Answer the open permission dialog first.");
		// A session whose settings name Full Access asks the risk question itself
		// at start. Asking for the same tier again would only stack a second copy
		// of that dialog; its answer already decides the tier.
		if (preset === "full-access" && this.selections.pendingRequests().some(isFullAccessRiskRequest)) return;
		let raised = false;
		const asked = new Promise<void>((resolve) => {
			this.selectionRaised = () => {
				raised = true;
				resolve();
			};
		});
		const applied = this.session.prompt(`/permissions ${preset}`, { source: "rpc" });
		// Before a dialog opens, a failure rejects the race below and becomes this
		// request's error. After one opens, nobody awaits the command any more, so
		// its failure is reported on the stream instead of being lost.
		const tracked: Promise<void> = applied
			.then(
				() => undefined,
				(caught: unknown) => {
					if (raised) this.publishError(caught instanceof Error ? caught.message : String(caught));
				},
			)
			.finally(() => {
				if (this.pendingPolicy === tracked) this.pendingPolicy = undefined;
			});
		this.pendingPolicy = tracked;
		try {
			await Promise.race([applied, asked]);
		} finally {
			this.selectionRaised = undefined;
		}
	}

	/**
	 * Answer a kernel selector. Returns false for an unknown id or an option
	 * that was not offered. Resolves after the command that asked has applied
	 * the answer, so the caller's next snapshot already shows the result.
	 */
	async respondSelection(id: string, value: string | undefined): Promise<boolean> {
		if (!this.selections.respond(id, value)) return false;
		if (this.pendingPolicy) {
			// Never rejects: setPolicy reports a late failure on the stream.
			await this.pendingPolicy;
		} else {
			// A dialog raised outside `/permissions` (the Full Access gate at session
			// start) applies its answer in a promise continuation; let it run.
			await new Promise((resolve) => setImmediate(resolve));
		}
		return true;
	}

	/**
	 * Keep a `/btw` answer for the rail and announce it.
	 *
	 * The terminal keeps the same history in process memory; doing the same here
	 * means a side question is never written to the session file and never enters
	 * the model's context, while a reloaded page still shows what it answered.
	 */
	recordSideAnswer(answer: SideAnswer): void {
		const entry: WebSideAnswer = {
			id: randomUUID(),
			question: answer.question,
			text: answer.text,
			...(answer.model ? { model: answer.model } : {}),
			...(answer.unavailable ? { unavailable: true } : {}),
			createdAt: Date.now(),
		};
		this.sideAnswers = [...this.sideAnswers, entry].slice(-SIDE_ANSWER_LIMIT);
		this.emit({ type: "side-answer", answer: entry });
	}

	/** Drop this session's side answers (the rail panel's Clear action). */
	clearSideAnswers(): void {
		this.sideAnswers = [];
	}

	/**
	 * Answer a kernel text prompt (`ui.input`). `undefined` dismisses it and an
	 * empty string is a submitted empty answer, which is how the kernel tells
	 * "the user cancelled" from "the user typed nothing".
	 */
	respondTextInput(id: string, value: string | undefined): boolean {
		return this.textInputs.respond(id, value);
	}

	/**
	 * Prepare this conversation's report and describe it for the consent dialog.
	 *
	 * The kernel decides what a report carries; this only shows the user what was
	 * prepared and keeps it until the submission, so the dialog never promises
	 * something the payload does not contain.
	 */
	async prepareFeedback(): Promise<WebFeedbackDraft> {
		// Refuse before preparing anything: building an archive for a report that
		// cannot be delivered would read the session file for nothing.
		this.assertFeedbackEnabled();
		return this.feedbackDrafts.keep(await this.prepareFeedbackEvidence());
	}

	/**
	 * Submit feedback about this conversation.
	 *
	 * The kernel accepts five coarse categories and rejects anything else, while
	 * the UI offers finer topics. The topic is therefore folded into the comment
	 * and the kernel category is derived from the sentiment plus the topic, so no
	 * detail is lost on the way through.
	 *
	 * `token` names the evidence the dialog showed the user. Without one (an
	 * older client, a scripted caller) the evidence is prepared here instead.
	 */
	async submitFeedback(input: { sentiment: "up" | "down"; topic?: string; comment: string; token?: string }): Promise<{
		readonly ok: boolean;
		readonly message: string;
		readonly feedbackId?: string;
	}> {
		const endpoint = resolveFeedbackEndpoint();
		// An opt-out is a decision about sending anything at all, not just about
		// the dialog: refuse here too, so a caller that skipped the preview cannot
		// file a report the user disabled.
		const disabled = this.feedbackDisabledReason();
		if (disabled) return { ok: false, message: disabled };
		const category = feedbackCategoryFor(input.sentiment, input.topic);
		// The topic table is a copy of a kernel contract; fail loudly if it drifts
		// rather than letting the kernel reject the submission downstream.
		const normalized = normalizeFeedbackCategory(category);
		if (!normalized) {
			return { ok: false, message: `Unknown feedback category: ${category}` };
		}
		const topic = input.topic?.trim();
		const comment = topic ? `[${topic}] ${input.comment.trim()}` : input.comment.trim();
		const bundleEndpoint = resolveFeedbackEndpoint(process.env, true);
		// Send exactly what the dialog showed. A token that no longer names
		// prepared evidence (expired, consumed, or cleared by a rebind) must not
		// silently send freshly prepared evidence the user never reviewed.
		const prepared = input.token ? this.feedbackDrafts.take(input.token) : undefined;
		if (input.token && !prepared) {
			return {
				ok: false,
				message: "The report details expired before sending. Reopen the dialog to review them again.",
			};
		}
		const evidence = prepared ?? (await this.prepareFeedbackEvidence());
		const bundle = evidence.bundle;
		const result = await submitKernelFeedback({
			category: normalized,
			comment,
			...(evidence.summary ? { sessionSummary: evidence.summary } : {}),
			...(evidence.diagnostics ? { diagnostics: evidence.diagnostics.diagnostics } : {}),
			...(bundle ? { sessionBundle: bundle } : {}),
			storageRootDir: resolveStepStorageRoot(),
			sessionId: bundle?.status === "ready" ? bundle.bundle.sessionId : this.id,
			endpoint,
			bundleEndpoint,
			username: readFeedbackUsername(),
			surface: this.feedbackSurface(),
			env: process.env,
		});
		if (result.status === "invalid") return { ok: false, message: result.error };
		if (result.status === "cancelled") return { ok: false, message: "Feedback submission was cancelled." };
		// A report that is queued for retry was not delivered. Saying "Submitted"
		// here would tell the user a report exists upstream when it is still local.
		if (result.status === "pending") {
			const outcome = result.outcome;
			return {
				ok: false,
				message:
					outcome.status === "pending"
						? formatFeedbackPendingDetails(outcome)
						: "The report was not delivered to the feedback endpoint.",
			};
		}
		// A skipped archive is not a failed report, but the user who was shown a
		// file list must learn which part of it never left the machine. The same
		// holds for an archive whose upload failed after the body was accepted: the
		// kernel keeps it beside the pending body for `step feedback --retry`.
		const bundleNote =
			bundle?.status === "skipped"
				? ` ${formatFeedbackBundleSkipMessage(bundle)}`
				: result.outcome.status === "delivered" && result.outcome.bundle?.status === "pending"
					? ` ${formatFeedbackBundleFailureDetails(result.outcome.bundle)}`
					: "";
		return {
			ok: true,
			message: `Submitted. Feedback ID: ${result.submission.feedbackId}${bundleNote}`,
			feedbackId: result.submission.feedbackId,
		};
	}

	/** The report's own evidence: this session's file, its project, and the host's live facts. */
	private async prepareFeedbackEvidence(): Promise<FeedbackEvidence> {
		const sessionFile = this.sessionFile();
		const usage = this.session.getContextUsage();
		return await prepareKernelFeedbackEvidence({
			storageRootDir: resolveStepStorageRoot(),
			// Name the session file rather than the id: a report must describe this
			// conversation, never the newest file of a neighbouring project.
			...(sessionFile ? { sessionFile } : { sessionId: this.id }),
			cwd: this.cwd,
			env: process.env,
			runtime: {
				...(this.livePermission ? { permissionPreset: this.livePermission } : {}),
				...(usage ? { contextUsed: usage.tokens, contextWindow: usage.contextWindow } : {}),
				toolCount: this.session.getActiveToolNames().length,
				skillCount: this.skills().length,
				mcpServerNames: mcpStatuses(this.session.sessionManager).map((status) => status.name),
			},
		});
	}

	/** Why this host will not file a report, or undefined when it will. */
	private feedbackDisabledReason(): string | undefined {
		const settings = resolveFeedbackSettings({
			env: process.env,
			settings: (this.session.settingsManager as StepSettingsManager).getStepSettings(),
		});
		if (settings.enabled) return undefined;
		return settings.reason === "env-opt-out"
			? "Feedback is disabled by environment settings."
			: "Feedback is disabled in Step settings.";
	}

	private assertFeedbackEnabled(): void {
		const disabled = this.feedbackDisabledReason();
		if (disabled) throw new Error(disabled);
	}

	/** Which product filed the report; Desktop runs this same host under Electron. */
	private feedbackSurface(): "web" | "desktop" {
		return process.versions.electron ? "desktop" : "web";
	}

	private describeFeedbackPreview(evidence: FeedbackEvidence): WebFeedbackPreview {
		return describeFeedbackEvidence({
			evidence,
			surface: this.feedbackSurface(),
			version: STEPCODE_VERSION.value,
			channel: readStepBuildIdentity().channel,
		});
	}

	/**
	 * Branch this session at `entryId`, or retry the last turn when omitted.
	 *
	 * The kernel always creates a new session id and file. `this.id` therefore
	 * moves with the rebind (`bindSession`), and the returned id is the new one:
	 * returning the old id made the client navigate to a session that does not
	 * exist. `adopt` registers the new id in the store so `GET` and the inspector
	 * reach the session that was just bound.
	 */
	async fork(entryId?: string): Promise<{ cancelled: boolean; sessionId: string }> {
		// A fork swaps the session under the page. Refusing a concurrent one keeps
		// a double click from creating two branches and binding the wrong one.
		if (this.forking) throw new Error("A fork is already in progress");
		if (this.status === "running" || this.status === "waiting" || this.session.isCompacting)
			throw new Error("Stop the running turn before forking");
		this.forking = true;
		const previousId = this.id;
		try {
			const targetEntryId = entryId ?? lastUserEntryId(this.session);
			if (!targetEntryId) return { cancelled: true, sessionId: previousId };
			const childTitle = forkTitleOf(this.forkTitle());
			// An entry keeps that turn in the new branch ("at"); the implicit last
			// user message means "retry this turn", so the branch ends before it.
			const result = await this.runtime.fork(targetEntryId, {
				position: entryId ? "at" : "before",
			});
			if (result.cancelled) return { cancelled: true, sessionId: previousId };
			const childId = this.session.sessionManager.getSessionId();
			try {
				// Named after the branch exists, so the write lands in the child file.
				// Derived from the parent's current title, so forking a fork appends
				// again: `xxx` -> `xxx_fork` -> `xxx_fork_fork`.
				this.session.setSessionName(childTitle);
			} catch (error) {
				// The branch is usable; a title that did not persist must not be
				// reported as a failed fork, but it must not be silent either.
				this.publishError(
					`Forked session ${childId.slice(0, 8)} but could not name it: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
			// A branch is a new session file: the parent's archive flag is not its own.
			this.archived = false;
			this.adopt?.(previousId, childId, this);
			return { cancelled: false, sessionId: childId };
		} finally {
			this.forking = false;
		}
	}

	/** The parent title a fork extends: the name, else the first user message, else the id. */
	private forkTitle(): string {
		const named = this.session.sessionName?.trim();
		if (named) return named;
		const firstUser = this.session.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "user");
		const first =
			firstUser?.type === "message" && firstUser.message.role === "user"
				? userMessageText(firstUser.message.content)
				: "";
		const trimmed = first.replace(/\s+/gu, " ").trim();
		return trimmed || `Session ${this.id.slice(0, 8)}`;
	}

	async decideApproval(id: string, verdict: "approve" | "approve_for_session" | "deny"): Promise<boolean> {
		const decided = this.broker.decide(id, verdict);
		if (decided) this.setStatus("running", false);
		return decided;
	}

	/**
	 * Stop the running turn. Queued messages stay queued; steering messages the
	 * kernel had not delivered yet move back to the front of the queue with their
	 * images, so stopping never drops what the user sent.
	 */
	async interrupt(): Promise<void> {
		this.clarifications.clear();
		this.holdQueue = true;
		if (this.startingPrompt) this.startingPrompt.cancelled = true;
		await this.session.abort();
		// Closed while the abort was settling: the queue and status belong to a
		// session nobody is reading any more.
		if (this.closing) return;
		const pending = this.session.clearQueue();
		const steering = this.steeringImages.match(pending.steering);
		this.steeringImages.clear();
		this.queue.prepend([
			...steering.map(({ text, images }) => ({ text, attachments: images })),
			...pending.followUp.map((text) => ({ text, attachments: [] })),
		]);
		this.setStatus("idle");
	}

	/**
	 * Wait, bounded by `deadline`, for an accepted prompt to reach its run.
	 *
	 * `AgentSession.abort()` only cancels a run that has started: the prompt's
	 * pre-run work (auth, compaction check, `before_agent_start` hooks such as MCP
	 * reconciliation) happens first and leaves nothing to abort. Stopping during
	 * that window used to dispose the session with the prompt still in memory.
	 * Waiting for the run — not the whole turn — means the abort then lands on a
	 * real controller; if the pre-run work outlasts the deadline there is nothing
	 * left to wait for.
	 */
	private async awaitRunStart(deadline: number): Promise<void> {
		while (this.pendingPrompts > 0 && !this.session.isStreaming) {
			if (Date.now() >= deadline) return;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}

	/**
	 * `interrupt`, but the host stops waiting after `graceMs`.
	 *
	 * A turn that settles in time leaves its partial reply on disk. One that
	 * does not is abandoned so shutdown can finish; the session is closed right
	 * after, and a stream that ignored the abort has nothing left to write to.
	 */
	async stopTurnWithin(graceMs: number): Promise<void> {
		if (!Number.isFinite(graceMs)) {
			await this.awaitRunStart(Number.POSITIVE_INFINITY);
			await this.interrupt();
			return;
		}
		const deadline = Date.now() + graceMs;
		await this.awaitRunStart(deadline);
		const remaining = Math.max(0, deadline - Date.now());
		let timer: NodeJS.Timeout | undefined;
		const expiry = new Promise<"timeout">((resolveTimeout) => {
			timer = setTimeout(() => resolveTimeout("timeout"), remaining);
			timer.unref();
		});
		try {
			const outcome = await Promise.race([this.interrupt().then(() => "stopped" as const), expiry]);
			if (outcome === "timeout") {
				console.error(
					`Stopped waiting for a running turn after ${String(graceMs)} ms; closing the session anyway.`,
				);
			}
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	async setModel(provider: string, modelId: string): Promise<void> {
		const model = this.modelRuntime.getModel(provider, modelId);
		if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
		await this.session.setModel(model, { persist: true });
	}

	/**
	 * Re-read `models.json` and `auth.json` so a provider added in settings
	 * reaches this open session's picker too, not just sessions started after it.
	 *
	 * Same sequence as a draft's catalog build (`draftModels`): the cache-only
	 * pass reloads the declarations, then the Step catalog refresh restores what
	 * the rebuild reset to the models.json baseline. Models a running turn is
	 * already using are unaffected — a request resolves its model when it starts.
	 */
	async refreshModels(): Promise<void> {
		await this.modelRuntime.refresh({ allowNetwork: false }).catch(() => {});
		await refreshStepModelCatalog(this.modelRuntime);
	}

	/**
	 * Set the reasoning effort for the current model. The kernel clamps an
	 * unsupported level internally, so the caller only has to reject values that
	 * are not thinking levels at all.
	 */
	setThinkingLevel(level: string): void {
		if (!THINKING_LEVEL_OPTIONS.includes(level as (typeof THINKING_LEVEL_OPTIONS)[number])) {
			throw new Error(`Unknown thinking level: ${level}`);
		}
		this.session.setThinkingLevel(level as (typeof THINKING_LEVEL_OPTIONS)[number], { persist: true });
	}

	/**
	 * Toggle one of the composer's session modes.
	 *
	 * Each mode is a slash command the owning extension registers, so this only
	 * routes the right one. Goal is the exception: enabling it needs the goal
	 * text, because `/goal` with no argument means "show status".
	 *
	 * `streamingBehavior` is required: a slash command is still a prompt, and a
	 * session that is mid-turn rejects a bare one instead of queueing it.
	 */
	async setMode(mode: WebMode, enabled: boolean, goal?: string): Promise<void> {
		const prompt =
			mode === "plan"
				? "/plan"
				: mode === "ultraloop"
					? enabled
						? "/ultraloop on"
						: "/ultraloop off"
					: enabled
						? `/goal ${(goal ?? "").trim()}`
						: "/goal clear";
		// Starting a goal is user input; the other toggles carry no text to title.
		await this.promptTracked(() => {
			if (mode === "goal" && enabled) this.maybeGenerateSessionTitle(prompt);
			return this.session.prompt(prompt, { source: "rpc", streamingBehavior: "followUp" });
		});
	}

	/**
	 * Apply one goal-strip control from the client.
	 *
	 * These run the same `/goal` subcommands the CLI's TUI issues, so pausing,
	 * rewording, and clearing have exactly one implementation. They are slash
	 * commands, not agent turns, so they can be sent while a turn runs.
	 */
	async controlGoal(action: WebGoalAction, objective?: string): Promise<void> {
		const text = objective?.trim();
		if ((action === "edit" || action === "start") && !text) {
			throw new Error("A goal objective is required");
		}
		const prompt =
			action === "start"
				? `/goal ${text}`
				: action === "edit"
					? `/goal edit ${text}`
					: action === "pause"
						? "/goal pause"
						: action === "resume"
							? "/goal resume"
							: "/goal clear";
		await this.promptTracked(() => {
			if (action === "start") this.maybeGenerateSessionTitle(prompt);
			return this.session.prompt(prompt, { source: "rpc", streamingBehavior: "followUp" });
		});
	}

	snapshot(): Record<string, unknown> {
		const manager = this.session.sessionManager;
		const branch = manager.getBranch();
		return {
			id: this.id,
			cwd: this.cwd,
			name: this.session.sessionName,
			status: this.status,
			unread: this.unread,
			revision: this.revision,
			sessionFile: manager.getSessionFile(),
			archived: this.archived,
			revertedTurns: revertedTurnIds(branch),
			lastRunAborted: this.lastRunAborted,
			// The newest turn was cut off (a stopped run, or a host that exited
			// mid-stream). Entries carry it, so a page opened after a restart says
			// the same thing the live page did. A turn still in flight is not
			// interrupted: its reply simply has not arrived yet.
			interruptedTurn: hasInterruptedTurn(branch, this.isBusy()),
			compacting: this.session.isCompacting,
			entries: projectEntries(branch),
			subagentLanes: [...this.subagentLanes.values()],
			pendingApprovals: this.broker.pendingRequests(),
			pendingClarifications: this.clarifications.pendingRequests(),
			pendingSelections: this.selections.pendingRequests(),
			pendingTextInputs: this.textInputs.pendingRequests(),
			sideAnswers: this.sideAnswers,
			queuedMessages: this.queue.views(),
			steeringMessages: this.steeringViews(),
			retry: this.retry.view(),
			model: this.session.model ? { provider: this.session.model.provider, id: this.session.model.id } : undefined,
			permissionPreset:
				this.livePermission ??
				(this.session.settingsManager as StepSettingsManager).getStepPermissionPreset() ??
				"approve-for-me",
			policies: webPermissionPresets(),
			thinkingLevel: this.session.thinkingLevel,
			availableThinkingLevels: this.session.getAvailableThinkingLevels(),
			models: projectedModels(this.modelRuntime),
			// Goal and plan mode are host-rendered state, not transcript text: the
			// client draws a goal strip and a plan review card from these.
			goal: projectGoal(getStepGoal(manager.getBranch(), manager.getSessionId())),
			planMode: projectPlanMode(getStepPlanState(manager.getBranch())),
		};
	}

	sessionFile(): string | undefined {
		return this.session.sessionManager.getSessionFile();
	}

	inspector(): Record<string, unknown> {
		const stats = this.session.getSessionStats();
		return {
			sessionId: this.id,
			...projectInspectorTasks(this.session.sessionManager.getBranch()),
			stats: { tokens: stats.tokens, cost: stats.cost, contextUsage: stats.contextUsage },
			skillCount: this.skills().length,
			mcpScope: "process",
			mcp: mcpStatuses(this.session.sessionManager).map(({ name, status }) => ({ name, status })),
		};
	}

	/** Skills of this session's resource loader (plugin skills included), unless skill commands are off. */
	skills(): WebSkill[] {
		if (!this.session.settingsManager.getEnableSkillCommands()) return [];
		return webSkills(this.session.resourceLoader.getSkills().skills);
	}

	/**
	 * Prompt commands this session expands (plugin commands included). A
	 * template named like a registered extension command never expands — the
	 * command runs first — so it is not offered.
	 */
	commands(): WebPromptCommand[] {
		const extensionCommands = new Set(
			this.session.extensionRunner.getRegisteredCommands().map((command) => command.invocationName),
		);
		return webPromptCommands(
			this.session.promptTemplates,
			(name) => extensionCommands.has(name) || isReservedCommandName(name),
		);
	}

	/**
	 * Resources for this session's `step.usage_provenance` entries.
	 *
	 * Recording asks on `session_start`, which can run before `bindSession` has
	 * exposed the session; an early ask records no skills rather than failing the
	 * session, and `before_agent_start` collects them once the session is bound.
	 * The full loader list is used, not `skills()`: provenance describes the
	 * resources a turn could activate, independent of the `/skill:` UI toggle.
	 */
	private usageResources(): WebUsageResources {
		const skills = this.session?.resourceLoader.getSkills().skills ?? [];
		return {
			// The Web host has no agent list of its own: no `/usage` status view.
			agents: [],
			skills: skills.map((skill) => ({ name: skill.name, filePath: skill.filePath })),
		};
	}

	setArchived(archived: boolean): void {
		this.archived = archived;
	}

	/**
	 * Undo the file changes of the turn that starts at user entry `turnId`.
	 * Refused while a turn runs: the agent could be writing the same files.
	 *
	 * The model is told through a custom message (in its context, not a new
	 * turn): otherwise it still believes its edits are on disk. The same entry
	 * marks the turn as reverted, so the state follows the session branch.
	 */
	/** `path` as the turn `turnId` left it, for a rendered preview of that turn's delivery. */
	fileAtTurn(turnId: string, path: string): Promise<FileAtTurn> {
		return fileAtTurnEnd(this.session.sessionManager.getBranch(), turnId, path, this.cwd);
	}

	async revertTurn(turnId: string): Promise<{ paths: string[]; skipped: readonly SkippedChange[] }> {
		if (this.status === "running" || this.status === "waiting")
			throw new TurnRevertError("busy", "Stop the running turn first");
		const branch = this.session.sessionManager.getBranch();
		return this.reverter.revert(turnId, branch, this.cwd, (turn, changes, paths) =>
			this.session.sendCustomMessage(
				{
					customType: TURN_REVERT_TYPE,
					content: turnRevertNotice(branch, turn, changes),
					display: false,
					details: { turnId: turn, paths },
				},
				{ triggerTurn: false },
			),
		);
	}

	/**
	 * Stop accepting new work, without closing yet.
	 *
	 * Shutdown marks every session before it stops the running turns, so a queued
	 * dispatch or a request racing the shutdown cannot start one more run in the
	 * gap between the busy scan and `close`.
	 */
	beginClosing(): void {
		this.closing = true;
	}

	async close(): Promise<void> {
		// Refuse new work first: a queued dispatch or an in-flight request must not
		// start a turn whose reply the disposed session could never persist.
		this.closing = true;
		if (this.startingPrompt) this.startingPrompt.cancelled = true;
		this.clarifications.clear();
		this.selections.clear();
		this.textInputs.clear();
		// A prepared archive is up to 8 MiB; a closed session must not keep it.
		this.feedbackDrafts.clear();
		this.broker.clear();
		this.unsubscribeSession?.();
		await this.runtime.dispose();
		this.unsubscribeRuntimeSessionChange?.();
		this.releaseWriterLease?.();
		this.releaseWriterLease = undefined;
		this.writerLeasePath = undefined;
		this.listeners.clear();
		const closed = [...this.closeListeners];
		this.closeListeners.clear();
		for (const listener of closed) listener();
	}
}

interface WebSessionMetadata {
	archived?: boolean;
}

class WebSessionMetadataStore {
	private readonly path: string;
	private readonly values = new Map<string, WebSessionMetadata>();
	private loaded = false;

	constructor(agentDir: string) {
		this.path = join(agentDir, "web-sessions.json");
	}

	async load(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		try {
			const parsed = JSON.parse(await readFile(this.path, "utf8")) as Record<string, WebSessionMetadata>;
			for (const [id, value] of Object.entries(parsed)) {
				if (value && typeof value === "object") this.values.set(id, value);
			}
		} catch {
			// Missing or malformed Web metadata must not block the canonical v3 session store.
		}
	}

	isArchived(id: string): boolean {
		return this.values.get(id)?.archived === true;
	}

	async setArchived(id: string, archived: boolean): Promise<void> {
		await this.load();
		this.values.set(id, { archived });
		const serialized = JSON.stringify(Object.fromEntries(this.values), null, 2);
		await mkdir(dirname(this.path), { recursive: true });
		const temporary = `${this.path}.${process.pid}.tmp`;
		await writeFile(temporary, `${serialized}\n`, "utf8");
		await rename(temporary, this.path);
	}

	async remove(id: string): Promise<void> {
		await this.load();
		this.values.delete(id);
		const serialized = JSON.stringify(Object.fromEntries(this.values), null, 2);
		await mkdir(dirname(this.path), { recursive: true });
		const temporary = `${this.path}.${process.pid}.tmp`;
		await writeFile(temporary, `${serialized}\n`, "utf8");
		await rename(temporary, this.path);
	}
}

/** Where session managers report their file writes (the host's session index). */
export type SessionIndexSink = Pick<SessionIndex, "notifyPersisted">;

/** Live state of a session open in the host; absent from a listing for sessions that are not open. */
export interface WebSessionLiveStatus {
	readonly id: string;
	readonly status: WebSessionStatus;
	readonly unread: boolean;
}

export type WebSessionInfo = Omit<SessionInfo, "allMessagesText"> & {
	archived: boolean;
	cwdAvailable: boolean;
	status?: WebSessionStatus;
	unread?: boolean;
};

/**
 * Forget every idle session in `sessions` and close it.
 *
 * Removal is synchronous, before any close settles, so a request that arrives
 * right after a sign-in already reopens the session instead of getting the old
 * object. Busy sessions are kept: closing would cut off a turn. Returns the
 * released sessions and the settled closes.
 */
export function releaseIdleSessions<T extends Pick<WebSession, "isBusy" | "close">>(
	sessions: Map<string, T>,
): { released: Array<[string, T]>; closed: Promise<PromiseSettledResult<void>[]> } {
	const released = [...sessions].filter(([, session]) => !session.isBusy());
	for (const [id] of released) sessions.delete(id);
	return { released, closed: Promise.allSettled(released.map(([, session]) => session.close())) };
}

export class WebSessionStore {
	private readonly index?: SessionIndexSink;

	constructor(options: { index?: SessionIndexSink } = {}) {
		this.index = options.index;
	}

	private readonly sessions = new Map<string, WebSession>();
	private readonly openings = new Map<string, Promise<WebSession>>();
	private readonly metadata = new WebSessionMetadataStore(resolveStepAgentDir());
	/**
	 * Sessions released by `reloadCredentials` before their first message: no
	 * file exists to reopen them from, so they are recreated with the same id.
	 */
	private readonly unsaved = new Map<string, string>();

	async create(cwd: string): Promise<WebSession> {
		await this.metadata.load();
		const session = await WebSession.create({ cwd, index: this.index });
		session.adopt = (previousId, id, adopted) => this.adopt(previousId, id, adopted);
		this.sessions.set(session.id, session);
		return session;
	}

	/**
	 * Re-key a session after a fork: it now advertises the child id, so the old
	 * key must stop resolving to it (a `GET /sessions/{old}` that answered with
	 * the child would be a lie) and the new id must resolve immediately.
	 */
	private adopt(previousId: string, id: string, session: WebSession): void {
		const existing = this.sessions.get(id);
		// A fresh branch id is unique; anything else would mean two live objects
		// claim one session, which must not be resolved by picking one. Checked
		// before the old key is dropped, so a refusal leaves the map consistent.
		if (existing && existing !== session) throw new Error(`Session id already open: ${id}`);
		if (this.sessions.get(previousId) === session) this.sessions.delete(previousId);
		this.sessions.set(id, session);
	}

	/**
	 * The model panel of an unsaved draft in `cwd`: the catalog and the model a
	 * session created there would start on. Built on a fresh runtime per call,
	 * like a session, so a sign-in or a config.toml edit shows up on the next
	 * draft without a host restart.
	 */
	async draftModels(cwd: string): Promise<WebDraftSource> {
		const authPath = getStepAuthPath();
		syncStepLoginProfileEndpoint(authPath);
		const modelRuntime = await ModelRuntime.create({
			authPath,
			modelsPath: join(resolveStepConfigRoot(), "models.json"),
		});
		modelRuntime.registerProvider(STEP_PROVIDER_ID, createStepProviderConfig());
		// Let the cache-only refresh that registration schedules settle first;
		// finishing after the network refresh, it would reset the catalog.
		await modelRuntime.refresh({ allowNetwork: false }).catch(() => {});
		await refreshStepModelCatalog(modelRuntime);
		const settings = createStepSettingsManager(cwd, resolveStepAgentDir(), {
			configDirName: resolveStepConfigDir(),
		});
		return {
			...(await predictDraftModel(modelRuntime, settings, readGlobalStepDefaults())),
			permissionPreset: settings.getStepPermissionPreset() ?? "approve-for-me",
			policies: webPermissionPresets(),
			fullAccessAcknowledged: settings.getStepSettings().fullAccessAcknowledged === true,
		};
	}

	async getOrOpen(id: string): Promise<WebSession> {
		await this.metadata.load();
		const session = this.sessions.get(id);
		if (session) return session;
		const opening = this.openings.get(id);
		if (opening) return opening;
		const pending = (async () => {
			const info = (await this.list()).find((candidate) => candidate.id === id);
			const unsavedCwd = this.unsaved.get(id);
			if (!info && unsavedCwd !== undefined) {
				this.unsaved.delete(id);
				const recreated = await WebSession.create({ cwd: unsavedCwd, sessionId: id, index: this.index });
				recreated.adopt = (previousId, nextId, adopted) => this.adopt(previousId, nextId, adopted);
				this.sessions.set(recreated.id, recreated);
				return recreated;
			}
			if (!info) throw new Error(`Session not found: ${id}`);
			const opened = await WebSession.create({
				cwd: info.cwdAvailable ? info.cwd : defaultWorkspace(),
				sessionPath: info.path,
				sessionId: info.id,
				index: this.index,
			});
			opened.adopt = (previousId, nextId, adopted) => this.adopt(previousId, nextId, adopted);
			opened.setArchived(this.metadata.isArchived(opened.id));
			this.sessions.set(opened.id, opened);
			return opened;
		})();
		this.openings.set(id, pending);
		try {
			return await pending;
		} finally {
			this.openings.delete(id);
		}
	}

	/**
	 * Status of every session open in this host. A session that is not open has
	 * no run in progress and nothing unread, so the page shows it as settled.
	 */
	statuses(): WebSessionLiveStatus[] {
		return [...this.sessions].map(([id, session]) => ({ id, ...session.liveStatus() }));
	}

	async list(): Promise<Array<WebSessionInfo>> {
		await this.metadata.load();
		const sessions = await listAllStepSessions({ agentDir: resolveStepAgentDir(), recursive: true });
		return Promise.all(
			// Child-agent sessions share the parent's folder but belong to its tool calls, as in the CLI's resume picker.
			sessions
				.filter((session) => !isChildAgentSession(session))
				.map(async (session) => {
					let cwdAvailable = false;
					// The folder name a session row carries is the key the sidebar groups
					// by, so it has to be spelled the way the workspace registry stores it.
					// Otherwise removing a workspace under one name leaves its sessions
					// grouped under another and the project stays listed.
					let cwd = session.cwd;
					if (cwd) {
						try {
							cwd = await realpath(cwd);
							cwdAvailable = (await stat(cwd)).isDirectory();
						} catch {
							// A session with a removed cwd remains readable and appears under
							// Recent; the recorded spelling is all that is left of the folder.
							cwdAvailable = false;
						}
					}
					// Full message text is for searching only; the session index serves search now.
					const { allMessagesText: _allMessagesText, ...summary } = session;
					const live = this.sessions.get(session.id)?.liveStatus();
					return {
						...summary,
						...(cwd ? { cwd } : {}),
						archived: this.metadata.isArchived(session.id),
						cwdAvailable,
						...live,
					};
				}),
		);
	}

	/**
	 * Skills and prompt commands for a workspace without a session yet (a
	 * draft): what a new session in that folder would load. The folder's
	 * resources are resolved as a session would (settings, user and project
	 * skill and prompt folders, packages) without starting anything, and
	 * installed plugins' skills and commands are added from the same discovery
	 * the plugin extension answers `resources_discover` with, so a plugin
	 * installed a moment ago is offered before the draft's first send.
	 *
	 * An open session in the same folder is deliberately not reused: its
	 * resources are fixed when it starts, so after an install it would describe
	 * the old set.
	 */
	async slashResourcesFor(cwd: string): Promise<{ skills: WebSkill[]; commands: WebPromptCommand[] }> {
		const agentDir = resolveStepAgentDir();
		const configDirName = resolveStepConfigDir();
		const settingsManager = createStepSettingsManager(cwd, agentDir, { configDirName });
		const loader = new DefaultResourceLoader({ cwd, agentDir, configDirName, settingsManager, noExtensions: true });
		await loader.reload();
		const plugins = await discoverStepPluginResourcePaths({
			userDir: defaultStepPluginsDir(process.env),
			projectDir: defaultStepPluginsDir(process.env, { cwd, project: true }),
			projectTrusted: settingsManager.isProjectTrusted(),
		});
		const metadata = { source: "extension:step-plugins", scope: "temporary", origin: "top-level" } as const;
		if (plugins.skillPaths.length > 0 || plugins.promptPaths.length > 0) {
			loader.extendResources({
				skillPaths: plugins.skillPaths.map((path) => ({ path, metadata })),
				promptPaths: plugins.promptPaths.map((path) => ({ path, metadata })),
			});
		}
		return {
			skills: settingsManager.getEnableSkillCommands() ? webSkills(loader.getSkills().skills) : [],
			commands: webPromptCommands(loader.getPrompts().prompts, isReservedCommandName),
		};
	}

	async archive(id: string, archived: boolean): Promise<WebSession> {
		const session = await this.getOrOpen(id);
		await this.metadata.setArchived(id, archived);
		session.setArchived(archived);
		return session;
	}

	async delete(id: string): Promise<void> {
		const session = await this.getOrOpen(id);
		const sessionFile = session.sessionFile();
		await session.close();
		this.sessions.delete(id);
		await this.metadata.remove(id);
		if (sessionFile) {
			try {
				await unlink(sessionFile);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
	}

	/**
	 * Rebuild open sessions after a sign-in.
	 *
	 * Each session fixes its model catalog and provider endpoint when it is
	 * created, so one opened before the credential existed stays on the
	 * `unknown` model ("No API key found for the selected model") even after
	 * `auth.json` is written. Dropping it makes the next request reopen it from
	 * its file with the new credential; its event streams end, and the page's
	 * EventSource reconnects to the rebuilt session.
	 */
	async reloadCredentials(): Promise<void> {
		const { released, closed } = releaseIdleSessions(this.sessions);
		for (const [id, session] of released) {
			const file = session.sessionFile();
			if (!file || !existsSync(file)) this.unsaved.set(id, session.cwd);
		}
		for (const result of await closed) {
			if (result.status === "rejected") console.error("Could not close a session after sign-in:", result.reason);
		}
	}

	async close(): Promise<void> {
		await Promise.allSettled(this.openings.values());
		await Promise.all([...this.sessions.values()].map((session) => session.close()));
		this.openings.clear();
		this.sessions.clear();
	}

	/**
	 * Stop every running turn the way the Stop button does, then close all
	 * sessions. Used by a Step sign-out and by host shutdown.
	 *
	 * Stopping first is what keeps the transcript complete: the kernel writes an
	 * assistant message on `message_end`, and disposal mid-stream never produces
	 * one, so a bare `close()` drops the reply the page had already been shown
	 * (thinking included). An interrupted turn instead records an `aborted`
	 * message carrying everything that streamed.
	 *
	 * `graceMs` bounds each stop: a provider that stops answering must not hold
	 * process exit past the desktop's SIGKILL window, and an abandoned stream is
	 * still better than a host that never exits. Unbounded without it, which is
	 * what a sign-out wants.
	 */
	async interruptAndClose(options: { graceMs?: number; reason?: string } = {}): Promise<void> {
		const reason = options.reason ?? "signing out";
		await Promise.allSettled(this.openings.values());
		// Refuse new work before the busy scan, so nothing can start a turn in the
		// gap between looking and closing.
		for (const session of this.sessions.values()) session.beginClosing();
		const busy = [...this.sessions.values()].filter((session) => session.isBusy());
		const stops = busy.map((session) => session.stopTurnWithin(options.graceMs ?? Number.POSITIVE_INFINITY));
		for (const result of await Promise.allSettled(stops)) {
			if (result.status === "rejected") console.error(`Could not stop a turn before ${reason}:`, result.reason);
		}
		await this.close();
	}
}

/** The first-use workspace, when the host prepared one in place of Desktop's home-folder fallback. */
let launchWorkspaceOverride: string | undefined;

/**
 * Make `path` the launch folder. Called once at startup with the first-use
 * workspace (see `WorkspaceRegistry.initializeDefault`), which only exists when
 * Desktop had no folder of its own to launch in.
 */
export function setLaunchWorkspace(path: string): void {
	launchWorkspaceOverride = path;
}

export function defaultWorkspace(): string {
	return launchWorkspaceOverride ?? (process.env.STEPCODE_WEB_CWD?.trim() || process.cwd());
}
