import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
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
	createStepPlanExtension,
	createStepProviderConfig,
	createStepSessionManager,
	createStepSessionManagerFactory,
	createStepSettingsManager,
	createUltraloopOptInExtension,
	DEFAULT_THINKING_LEVEL,
	DefaultResourceLoader,
	type ExtensionUIContext,
	FULL_ACCESS_RISK_OPTIONS,
	findInitialModel,
	getStepAuthPath,
	getStepMcpStatuses,
	getSupportedThinkingLevels,
	type InlineExtension,
	isChildAgentSession,
	listAllStepSessions,
	ModelRuntime,
	NOOP_OBSERVABILITY_PROVIDER,
	normalizeFeedbackCategory,
	openStepSession,
	readFeedbackUsername,
	readGlobalStepDefaults,
	resolveFeedbackEndpoint,
	resolveStepAgentDir,
	resolveStepConfigDir,
	resolveStepConfigRoot,
	resolveStepStorageRoot,
	type SessionEntry,
	type SessionIndex,
	type SessionInfo,
	STEP_DEFAULT_MODEL,
	STEP_PERMISSION_PRESETS,
	STEP_PROVIDER_ID,
	type StepGlobalDefaults,
	type StepMcpStatus,
	type StepPermissionPresetId,
	type StepSettingsManager,
	submitFeedback as submitKernelFeedback,
	syncStepLoginProfileEndpoint,
	THINKING_LEVEL_OPTIONS,
	withSessionIndex,
} from "@step-harness/coding-agent";
import { ApprovalBroker, type ApprovalRequest } from "./approval.ts";
import { type WebAttachment, withTextAttachments } from "./attachments.ts";
import { ClarificationBroker, type ClarificationEvent } from "./clarification.ts";
import { feedbackCategoryFor } from "./feedback.ts";
import { projectInspectorTasks } from "./inspector.ts";
import {
	MessageQueue,
	type QueuedFile,
	type QueuedMessage,
	type QueuedMessageView,
	SteeringImages,
	type SteeringMessageView,
} from "./message-queue.ts";
import { RetryTracker } from "./retry-state.ts";
import { SelectionBroker, type SelectionEvent, type SelectionRequest, selectionSelect } from "./selection.ts";
import { type WebSkill, webSkills } from "./skills.ts";
import { resolveSubagentCliPath } from "./subagent-cli.ts";
import { projectSubagentNotification } from "./subagent-notification.ts";
import { savedThinkingTimings, THINKING_TIMING_TYPE, ThinkingClock, type ThinkingTimings } from "./thinking-timing.ts";
import {
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

export type WebEvent =
	| ClarificationEvent
	| SelectionEvent
	| { type: "agent"; event: AgentSessionEvent; thinkingTimings?: ThinkingTimings }
	| { type: "approval_required"; approval: ApprovalRequest }
	| { type: "status"; status: WebSessionStatus; unread: boolean }
	| ({ type: "queue" } & WebQueueState)
	| { type: "error"; message: string };

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
 * MCP servers of the host process. The kernel keeps one status list, written
 * by the session that started last; the Web host renders no `/mcp` notify text.
 */
export function mcpStatuses(): StepMcpStatus[] {
	return getStepMcpStatuses();
}

/** The session modes the composer can toggle. Each is independent of the others. */
export type WebMode = "goal" | "plan" | "ultraloop";

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
): ExtensionUIContext {
	const unsupported = async <T>(fallback: T): Promise<T> => fallback;
	return {
		clarify: (questions, signal) => clarifications.ask(questions, signal),
		select: selectionSelect(selections),
		confirm: (title, message, options) =>
			broker.confirm(title.replace(/^Approve |^Dangerous /u, ""), message, options?.signal),
		input: async () => undefined,
		notify: () => {},
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
			return undefined as never;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "Theme switching is not available on Web" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

function makeExtensions(
	settingsManager: StepSettingsManager,
	broker: ApprovalBroker,
	onPermissionChange: (preset: StepPermissionPresetId) => void,
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
			pi.on("tool_call", (event) => {
				broker.captureToolCall(event.toolCallId, event.toolName, event.input);
			});
			pi.on("session_start", (_event, context) => {
				context.ui.notify("StepCode Web session ready");
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
		}),
		createStepCapabilitiesExtensionInline({ telemetry, cliPath: resolveSubagentCliPath() }),
		createStepCronExtension({ telemetry }),
		createStepGoalExtension({ telemetry }),
		createStepPlanExtension({ telemetry }),
		// Ultracode/Ultraloop takes no telemetry option of its own.
		createUltraloopOptInExtension(),
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
export function projectModel(model: CatalogModel) {
	return {
		provider: model.provider,
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
	const models = available.map(projectModel);
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

/** Same provider and model id, which is all a resolved model needs to match. */
function modelsMatch(left: { provider: string; id: string }, right: { provider: string; id: string }): boolean {
	return left.provider === right.provider && left.id === right.id;
}

export function projectEntry(entry: SessionEntry): Record<string, unknown> {
	// Only assistant turns carry usage; other message kinds have none to report.
	const usage =
		entry.type === "message" && entry.message.role === "assistant" && !entry.imported
			? entry.message.usage
			: undefined;
	const notification =
		entry.type === "custom_message" ? projectSubagentNotification(entry.customType, entry.details) : undefined;
	return {
		id: entry.id,
		type: entry.type,
		timestamp: entry.timestamp,
		...(entry.imported ? { imported: entry.imported } : {}),
		...(entry.type === "message" ? { message: entry.message } : {}),
		...(usage ? { usage } : {}),
		...(entry.type === "custom_message" ? { content: entry.content, customType: entry.customType } : {}),
		...(notification ? { details: notification } : {}),
		...(entry.type === "compaction" ? { summary: entry.summary } : {}),
		...(entry.type === "branch_summary" ? { summary: entry.summary } : {}),
	};
}

/** Timing is host presentation metadata, not a field added to provider messages. */
export function projectEntries(entries: readonly SessionEntry[]): Record<string, unknown>[] {
	const timings = savedThinkingTimings(entries);
	return entries.map((entry) => {
		const thinkingTimings =
			entry.type === "message" && entry.message.role === "assistant"
				? timings.get(entry.message.timestamp)
				: undefined;
		return { ...projectEntry(entry), ...(thinkingTimings ? { thinkingTimings } : {}) };
	});
}

export class WebSession {
	readonly broker: ApprovalBroker;
	readonly clarifications: ClarificationBroker;
	readonly selections: SelectionBroker;
	private readonly listeners = new Set<(event: WebEvent) => void>();
	private runtime!: AgentSessionRuntime;
	private session!: AgentSession;
	private status: WebSessionStatus = "idle";
	private readonly closeListeners = new Set<() => void>();
	private unread = false;
	private unsubscribeSession?: () => void;
	private unsubscribeRuntimeSessionChange?: () => void;
	private releaseWriterLease?: () => void;
	/** Receives this session's file writes, including those of forks and /new. */
	private index?: SessionIndexSink;
	private writerLeasePath?: string;
	private archived = false;
	private readonly reverter = new TurnReverter();
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
	/** The kernel's retry of a failed model request, while one is scheduled or running. */
	private readonly retry = new RetryTracker();

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
					!this.clarifications.pendingRequests().length &&
					!this.broker.pendingRequests().length
				) {
					this.setStatus(this.statusBeforeSelection ?? "idle", false);
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
					extensionFactories: makeExtensions(settingsManager, this.broker, (preset) => {
						this.livePermission = preset;
					}),
				},
			});
			// Resolve the model against a populated catalog. `models.json` is only an
			// offline baseline and Step ships none, so an unrefreshed runtime offers
			// zero models and the session is left on the `unknown` placeholder.
			await refreshStepModelCatalog(this.modelRuntime);
			const created = await createAgentSessionFromServices({
				services,
				sessionManager: options.sessionManager,
				sessionStartEvent: options.sessionStartEvent,
				// Same defaults the CLI injects into argv (`withStepDefaults`): the
				// persisted provider/model from config.toml, with the product
				// provider and model as the fallback. The settings manager already
				// carries the persisted thinking level, so it is not repeated here.
				defaultProvider: defaults.provider,
				...(defaults.modelId ? { defaultModelId: defaults.modelId } : {}),
				systemPromptProduct: {
					name: "StepCode",
					role: "a local coding agent",
					introduction: "You are StepCode Web. Work in the selected workspace and explain what you do.",
					includeDocumentation: false,
				},
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
		this.livePermission = undefined;
		// Keep the advertised id in step with the session actually bound, so a
		// fork or /new does not leave the UI pointing at the previous session.
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
				this.setStatus("running");
				this.holdQueue = false;
				this.lastRunFailed = false;
			}
			if (event.type === "agent_settled") this.setStatus("completed", true);
			if (event.type === "agent_end") {
				const stops = event.messages.flatMap((message) =>
					message.role === "assistant" ? [message.stopReason] : [],
				);
				// A failure the kernel is about to retry is not the run's outcome: the
				// session keeps running through the backoff (`auto_retry_start` follows).
				if (stops.includes("error") && !event.willRetry) this.setStatus("failed", true);
				this.lastRunFailed = stops.includes("error") || stops.includes("aborted");
			}
			this.retry.apply(event);
			if (event.type === "auto_retry_start" && this.status !== "running") this.setStatus("running", false);
			if (event.type === "queue_update") this.emit({ type: "queue", ...this.queueState() });
			this.emit({ type: "agent", event, ...(thinkingTimings ? { thinkingTimings } : {}) });
			if (event.type === "agent_settled") {
				const hold = this.holdQueue || this.lastRunFailed;
				this.holdQueue = false;
				// Deferred: the kernel finishes settling after its listeners return,
				// and an extension may have started a follow-up run in the meantime.
				if (!hold) setImmediate(() => this.dispatchQueued());
			}
		});
		void session.bindExtensions({
			mode: "rpc",
			uiContext: webUiContext(this.broker, this.clarifications, this.selections),
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
	}

	private setStatus(status: WebSessionStatus, unread = this.unread): void {
		this.status = status;
		this.unread = unread;
		this.emit({ type: "status", status, unread });
	}

	private emit(event: WebEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	publishError(message: string): void {
		this.emit({ type: "error", message });
		this.setStatus("failed", true);
	}

	subscribe(listener: (event: WebEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Called once when the session is closed; an SSE stream ends so the page reconnects. */
	onClose(listener: () => void): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	/** A turn is running or waiting on the user; closing now would cut it off. */
	isBusy(): boolean {
		return this.status === "running" || this.status === "waiting";
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
		this.unread = false;
		const images = imagesOf(attachments);
		await this.session.prompt(withTextAttachments(text, attachments), {
			source: "rpc",
			...(images.length ? { images } : {}),
			...(followUp ? { streamingBehavior: "followUp" as const } : {}),
		});
	}

	/** Hand `text` to the running turn, read before its next model call; refused for extension commands. */
	async steer(text: string, attachments: readonly WebAttachment[] = []): Promise<void> {
		const images = imagesOf(attachments);
		await this.session.steer(withTextAttachments(text, attachments), images.length ? images : undefined);
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

	/** Whether a message sent now has to wait: a run is active or the session waits on the user. */
	private mustQueue(): boolean {
		return this.session.isStreaming || this.status === "waiting" || this.isReverting();
	}

	/**
	 * Accept a message sent while a turn runs. It waits in the queue, editable,
	 * until the run settles. When nothing runs (the turn ended while the request
	 * was in flight) and nothing is queued before it, it starts at once.
	 */
	enqueue(input: { text: string; attachments: readonly WebAttachment[]; files: readonly QueuedFile[] }): void {
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
	 * Submit feedback about this conversation.
	 *
	 * The kernel accepts five coarse categories and rejects anything else, while
	 * the UI offers finer topics. The topic is therefore folded into the comment
	 * and the kernel category is derived from the sentiment plus the topic, so no
	 * detail is lost on the way through.
	 */
	async submitFeedback(input: { sentiment: "up" | "down"; topic?: string; comment: string }): Promise<{
		readonly ok: boolean;
		readonly message: string;
		readonly feedbackId?: string;
	}> {
		const endpoint = resolveFeedbackEndpoint();
		if (!endpoint) {
			return { ok: false, message: "Feedback is not configured for this build." };
		}
		const category = feedbackCategoryFor(input.sentiment, input.topic);
		// The topic table is a copy of a kernel contract; fail loudly if it drifts
		// rather than letting the kernel reject the submission downstream.
		const normalized = normalizeFeedbackCategory(category);
		if (!normalized) {
			return { ok: false, message: `Unknown feedback category: ${category}` };
		}
		const topic = input.topic?.trim();
		const comment = topic ? `[${topic}] ${input.comment.trim()}` : input.comment.trim();
		const result = await submitKernelFeedback({
			category: normalized,
			comment,
			sessionId: this.id,
			storageRootDir: resolveStepStorageRoot(),
			endpoint,
			username: readFeedbackUsername(),
			surface: "cli",
			env: process.env,
		});
		if (result.status === "invalid") return { ok: false, message: result.error };
		if (result.status === "cancelled") return { ok: false, message: "Feedback submission was cancelled." };
		return {
			ok: true,
			message: `Submitted. Feedback ID: ${result.submission.feedbackId}`,
			feedbackId: result.submission.feedbackId,
		};
	}

	/**
	 * Fork the conversation at an entry, or from the current turn when omitted.
	 * Returns the session id now bound, which differs after a successful fork.
	 */
	async fork(entryId?: string): Promise<{ cancelled: boolean; sessionId: string }> {
		if (entryId) {
			// Forking at a named turn keeps that turn in the new branch; the default
			// "before" position only accepts a user message.
			const result = await this.runtime.fork(entryId, { position: "at" });
			return { cancelled: result.cancelled, sessionId: this.id };
		}
		// No target: fork from the last thing the user said.
		const branch = this.session.sessionManager.getBranch();
		const lastUserEntry = [...branch]
			.reverse()
			.find((entry) => entry.type === "message" && entry.message.role === "user");
		const result = lastUserEntry ? await this.runtime.fork(lastUserEntry.id) : { cancelled: true };
		return { cancelled: result.cancelled, sessionId: this.id };
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
		await this.session.abort();
		const pending = this.session.clearQueue();
		const steering = this.steeringImages.match(pending.steering);
		this.steeringImages.clear();
		this.queue.prepend([
			...steering.map(({ text, images }) => ({ text, attachments: images })),
			...pending.followUp.map((text) => ({ text, attachments: [] })),
		]);
		this.setStatus("idle");
	}

	async setModel(provider: string, modelId: string): Promise<void> {
		const model = this.modelRuntime.getModel(provider, modelId);
		if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
		await this.session.setModel(model, { persist: true });
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
		await this.session.prompt(prompt, { source: "rpc", streamingBehavior: "followUp" });
	}

	snapshot(): Record<string, unknown> {
		const manager = this.session.sessionManager;
		return {
			id: this.id,
			cwd: this.cwd,
			name: this.session.sessionName,
			status: this.status,
			unread: this.unread,
			sessionFile: manager.getSessionFile(),
			archived: this.archived,
			revertedTurns: revertedTurnIds(manager.getBranch()),
			entries: projectEntries(manager.getBranch()),
			pendingApprovals: this.broker.pendingRequests(),
			pendingClarifications: this.clarifications.pendingRequests(),
			pendingSelections: this.selections.pendingRequests(),
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
			models: this.modelRuntime.getAvailableSnapshot().map(projectModel),
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
			mcp: mcpStatuses().map(({ name, status }) => ({ name, status })),
		};
	}

	/** Skills of this session's resource loader (plugin skills included), unless skill commands are off. */
	skills(): WebSkill[] {
		if (!this.session.settingsManager.getEnableSkillCommands()) return [];
		return webSkills(this.session.resourceLoader.getSkills().skills);
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

	async close(): Promise<void> {
		this.clarifications.clear();
		this.selections.clear();
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

export type WebSessionInfo = Omit<SessionInfo, "allMessagesText"> & { archived: boolean; cwdAvailable: boolean };

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
		this.sessions.set(session.id, session);
		return session;
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

	async list(): Promise<Array<WebSessionInfo>> {
		await this.metadata.load();
		const sessions = await listAllStepSessions({ agentDir: resolveStepAgentDir(), recursive: true });
		return Promise.all(
			// Child-agent sessions share the parent's folder but belong to its tool calls, as in the CLI's resume picker.
			sessions
				.filter((session) => !isChildAgentSession(session))
				.map(async (session) => {
					let cwdAvailable = false;
					try {
						cwdAvailable = session.cwd ? (await stat(session.cwd)).isDirectory() : false;
					} catch {
						// A session with a removed cwd remains readable and appears under Recent.
					}
					// Full message text is for searching only; the session index serves search now.
					const { allMessagesText: _allMessagesText, ...summary } = session;
					return { ...summary, archived: this.metadata.isArchived(session.id), cwdAvailable };
				}),
		);
	}

	/**
	 * Skills for a workspace without a session yet (a draft). An open session in
	 * the same folder answers exactly (plugin skills included). Otherwise the
	 * folder's resources are resolved as a session would (settings, user and
	 * project skill folders, packages) without extensions and without starting
	 * anything; only plugin skills, added by an extension, are missing.
	 */
	async skillsFor(cwd: string): Promise<WebSkill[]> {
		const open = [...this.sessions.values()].find((session) => session.cwd === cwd);
		if (open) return open.skills();
		const agentDir = resolveStepAgentDir();
		const configDirName = resolveStepConfigDir();
		const settingsManager = createStepSettingsManager(cwd, agentDir, { configDirName });
		if (!settingsManager.getEnableSkillCommands()) return [];
		const loader = new DefaultResourceLoader({ cwd, agentDir, configDirName, settingsManager, noExtensions: true });
		await loader.reload();
		return webSkills(loader.getSkills().skills);
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
}

export function defaultWorkspace(): string {
	return process.env.STEPCODE_WEB_CWD?.trim() || process.cwd();
}
