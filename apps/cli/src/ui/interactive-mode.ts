/**
 * Interactive mode for the coding agent.
 * Handles TUI rendering and user interaction, delegating business logic to AgentSession.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage, ThinkingLevel } from "@step-harness/agent-core";
import type {
	AutocompleteProviderFactory,
	EditorFactory,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionNotifyOptions,
	ExtensionRunner,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	FullscreenExitOutput,
	InteractiveModeOptions,
	InteractiveStartupContext,
	MarkdownTransformer,
	ProjectTrustContext,
	ResourceDiagnostic,
	SourceInfo,
	TruncationResult,
	TuiMode,
	WorkingIndicatorOptions,
} from "@step-harness/coding-agent";
import {
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntimeHost,
	APP_NAME,
	APP_TITLE,
	type AppKeybinding,
	BUILTIN_SLASH_COMMANDS,
	CACHE_TTL_MS,
	type CacheMiss,
	CONFIG_DIR_NAME,
	CredentialSynchronizationError,
	CustomEditor,
	collectCacheMisses,
	computeCacheWaste,
	configureHttpDispatcher,
	copyToClipboard,
	DEFAULT_THINKING_LEVEL,
	DefaultPackageManager,
	DynamicBorder,
	defaultModelPerProvider,
	detectCacheMiss,
	ensureTool,
	FooterDataProvider,
	findExactModelReferenceMatch,
	formatHttpIdleTimeoutMs,
	formatKeyText,
	formatMissingSessionCwdPrompt,
	getAgentDir,
	getAvailableThemes,
	getAvailableThemesWithPaths,
	getChangelogPath,
	getCwdRelativePath,
	getEditorTheme,
	getMarkdownTheme,
	getNewEntries,
	getThemeByName,
	getUsageCostBreakdown,
	hasTrustRequiringProjectResources,
	InteractiveThemeController,
	IS_STEP_ENTRYPOINT,
	KeybindingsManager,
	keyDisplayText,
	keyHint,
	keyText,
	killTrackedDetachedChildren,
	listAllStepSessions,
	listStepSessions,
	loadAllHighlightLanguages,
	MissingSessionCwdError,
	normalizeChangelogLinks,
	onThemeChange,
	openBrowser,
	openStepSession,
	ProjectTrustStore,
	parseChangelog,
	parseGitUrl,
	parseSkillBlock,
	type ReadonlyFooterDataProvider,
	rawKeyHint,
	readStepLoginCredential,
	readStepLoginProfile,
	resolveModelScopeFromModels,
	resolveStepLoginProfiles,
	type SessionEntry,
	SessionImportFileNotFoundError,
	SessionManager,
	STEP_PROVIDER_ID,
	type StepLoginHost,
	sessionEntryToContextMessages,
	setRegisteredThemes,
	setThemeStorageDir,
	stopThemeWatcher,
	THINKING_LEVEL_OPTIONS,
	Theme,
	type ThemeColor,
	type ToolStatus,
	theme,
	VERSION,
} from "@step-harness/coding-agent";
import type {
	AutocompleteItem,
	AutocompleteProvider,
	EditorComponent,
	Focusable,
	Keybinding,
	KeyId,
	MarkdownTheme,
	OverlayHandle,
	OverlayOptions,
	SlashCommand,
	Terminal,
	TuiMainScreenRenderState,
} from "@step-harness/pi-tui";
import * as TuiLayouts from "@step-harness/pi-tui";
import {
	Box,
	CombinedAutocompleteProvider,
	type Component,
	Container,
	fuzzyFilter,
	getCapabilities,
	Markdown,
	matchesKey,
	ProcessTerminal,
	Spacer,
	setCapabilityOverrides,
	setKeybindings,
	Text,
	TruncatedText,
	type TUI,
	TuiAltScreen,
	TuiMainScreen,
	visibleWidth,
} from "@step-harness/pi-tui";
import type { AuthEvent, AuthPrompt, ImageContent } from "@step-harness/providers";
import type { AssistantMessage, Message, Model, Usage } from "@step-harness/providers/compat";
import chalk from "chalk";
import { spawn } from "child_process";
import { editInExternalEditor } from "./external-editor.ts";
import { refreshModelCatalogs } from "./model-catalog-refresh.ts";
import { getModelSearchText } from "./model-search.ts";
import { createApprovalProvider } from "./runtime/approval.ts";
import { wireInteractiveRuntime, wireStartupInput } from "./runtime/index.ts";
import {
	clipboardPaste,
	handleStartupSubmit,
	isExtensionCommand,
	rightClickPaste,
	wireKeyHandlers,
	wireSubmitHandler,
} from "./runtime/input-dispatch.ts";
import { handleCtrlC, handleCtrlD } from "./runtime/interrupt.ts";
import { PastedImageRegistry, resolvePastedImages } from "./runtime/pasted-images.ts";
import { createRedraw, type Redraw } from "./runtime/redraw.ts";
import { handleSessionEvent, subscribeToAgent } from "./runtime/session-events.ts";
import { FooterComponent, formatTokens } from "./view/chrome/footer.ts";
import {
	BranchSummaryStatusIndicator,
	IdleStatus,
	STEP_WORKING_INDICATOR_INTERVAL_MS,
	type StatusIndicator,
	TurnDoneIndicator,
	WorkingOutputTracker,
	WorkingStatusIndicator,
} from "./view/chrome/status-indicator.ts";
import type { StatusTipRotator } from "./view/chrome/status-tips.ts";
import { StepWelcomeComponent } from "./view/chrome/step-welcome.ts";
import { paintStepWordmarkBorder } from "./view/chrome/step-wordmark.ts";
import { ExtensionEditorComponent } from "./view/dialogs/extension-editor.ts";
import { ExtensionInputComponent } from "./view/dialogs/extension-input.ts";
import { ExtensionSelectorComponent } from "./view/dialogs/extension-selector.ts";
import { LoginDialogComponent } from "./view/dialogs/login-dialog.ts";
import { ModelSelectorComponent } from "./view/dialogs/model-selector.ts";
import {
	type AuthSelectorProvider,
	formatAuthSelectorProviderType,
	OAuthSelectorComponent,
} from "./view/dialogs/oauth-selector.ts";
import { ScopedModelsSelectorComponent } from "./view/dialogs/scoped-models-selector.ts";
import { SessionSelectorComponent } from "./view/dialogs/session-selector.ts";
import { SettingsSelectorComponent } from "./view/dialogs/settings-selector.ts";
import { StepSelectorFrame } from "./view/dialogs/step-dialog.ts";
import { ThinkingSelectorComponent } from "./view/dialogs/thinking-selector.ts";
import { TreeSelectorComponent } from "./view/dialogs/tree-selector.ts";
import { TrustSelectorComponent } from "./view/dialogs/trust-selector.ts";
import { UserMessageSelectorComponent } from "./view/dialogs/user-message-selector.ts";
import { CustomEntryComponent } from "./view/editor/custom-entry.ts";
import { STEP_EDITOR_PLACEHOLDER, StepEditor } from "./view/editor/step-editor.ts";
import { AssistantMessageComponent } from "./view/transcript/assistant-message.ts";
import { BashExecutionComponent } from "./view/transcript/bash-execution.ts";
import { BranchSummaryMessageComponent } from "./view/transcript/branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "./view/transcript/compaction-summary-message.ts";
import { CustomMessageComponent } from "./view/transcript/custom-message.ts";
import { createMermaidMarkdownTransformer } from "./view/transcript/mermaid.ts";
import { SkillInvocationMessageComponent } from "./view/transcript/skill-invocation-message.ts";
import { StepAssistantMessageComponent, StepUserMessageComponent } from "./view/transcript/step-message.ts";
import { StepQueuedMessagesComponent } from "./view/transcript/step-queued-messages.ts";
import type { StepToolSpinnerClock } from "./view/transcript/step-spinner.ts";
import { ToolExecutionComponent } from "./view/transcript/tool-execution.ts";
import { UserMessageComponent } from "./view/transcript/user-message.ts";

/** Interface for components that can be expanded/collapsed */
interface Expandable {
	setExpanded(expanded: boolean): void;
}

/**
 * Step's presentation trades the Ctrl+L model selector for a full screen
 * repaint, giving users a manual recovery path when a terminal garbles after
 * scrolling or resize (feedback issue-9ad367d596a230a9). The selector stays
 * reachable through /model and Ctrl+P model cycling. An explicit user binding
 * for either action always wins over this remap.
 */
/** Exported for the acceptance test suite (tui-acceptance-interactions.test.ts). */
// 结构重构（代码结构方案步骤 4）时迁往 ui/runtime/input-dispatch.ts —— 键位语义属于交互编排。
export function applyStepKeybindingRemap(keybindings: KeybindingsManager): void {
	const userBindings = keybindings.getUserBindings();
	if (userBindings["app.redraw"] !== undefined || userBindings["app.model.select"] !== undefined) return;
	keybindings.setUserBindings({ ...userBindings, "app.redraw": "ctrl+l", "app.model.select": [] });
}

/**
 * Commands pinned to the top of Step's "/" completion list. Users reach for
 * model/effort/mode switches most often, so they lead the list instead of
 * following builtin registration order (feedback issue-c6b8e3bb543482b7).
 */
const STEP_SLASH_COMMAND_PRIORITY: readonly string[] = ["model", "permissions", "effort", "thinking", "plan"];

/** Exported for the acceptance test suite (tui-acceptance-interactions.test.ts). */
// 结构重构（代码结构方案步骤 4）时迁往 ui/runtime/input-dispatch.ts —— 斜杠命令分派属于交互编排。
export function orderStepSlashCommands<T extends { name: string }>(commands: readonly T[]): T[] {
	const priority = new Map(STEP_SLASH_COMMAND_PRIORITY.map((name, index) => [name, index]));
	return [...commands].sort(
		(a, b) => (priority.get(a.name) ?? priority.size) - (priority.get(b.name) ?? priority.size),
	);
}

function isExpandable(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}

class ExpandableText extends Text implements Expandable {
	private readonly getCollapsedText: () => string;
	private readonly getExpandedText: () => string;

	constructor(
		getCollapsedText: () => string,
		getExpandedText: () => string,
		expanded = false,
		paddingX = 0,
		paddingY = 0,
	) {
		super(expanded ? getExpandedText() : getCollapsedText(), paddingX, paddingY);
		this.getCollapsedText = getCollapsedText;
		this.getExpandedText = getExpandedText;
	}

	setExpanded(expanded: boolean): void {
		this.setText(expanded ? this.getExpandedText() : this.getCollapsedText());
	}
}

type CompactionQueuedMessage = {
	text: string;
	mode: "steer" | "followUp";
	images?: ImageContent[];
};

type CompactionCostNotice = {
	type: "compaction_cost";
	kind: "compaction" | "branch_summary";
	usage: Usage;
};

type RenderSessionItem = AgentMessage | Extract<SessionEntry, { type: "custom" }> | CompactionCostNotice;

function isCustomSessionEntry(item: RenderSessionItem): item is Extract<SessionEntry, { type: "custom" }> {
	return "type" in item && item.type === "custom";
}

function isCompactionCostNotice(item: RenderSessionItem): item is CompactionCostNotice {
	return "type" in item && item.type === "compaction_cost";
}

const DEAD_TERMINAL_ERROR_CODES = new Set(["EIO", "EPIPE", "ENOTCONN"]);

function isDeadTerminalError(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("code" in error)) {
		return false;
	}
	const code = (error as NodeJS.ErrnoException).code;
	return code !== undefined && DEAD_TERMINAL_ERROR_CODES.has(code);
}

const ANTHROPIC_SUBSCRIPTION_AUTH_WARNING =
	"Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits. Manage extra usage at https://claude.ai/settings/usage. Disable this warning in /settings.";

function isAnthropicSubscriptionAuthKey(apiKey: string | undefined): boolean {
	return typeof apiKey === "string" && apiKey.startsWith("sk-ant-oat");
}

function isUnknownModel(model: Model<any> | undefined): boolean {
	return !!model && model.provider === "unknown" && model.id === "unknown" && model.api === "unknown";
}

function quoteIfNeeded(value: string): string {
	if (value.length > 0 && !/[^a-zA-Z0-9_\-./~:@]/.test(value)) {
		return value;
	}
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function formatResumeCommand(sessionManager: SessionManager): string | undefined {
	if (!process.stdout.isTTY) return undefined;
	if (!sessionManager.isPersisted()) return undefined;

	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile || !fs.existsSync(sessionFile)) return undefined;

	const args = [APP_NAME];
	// Step ships a `resume <id>` subcommand; pi has only the `--session` flag.
	// Print the spelling the product the user launched actually accepts, and keep
	// the id directly after `resume` because the Step compat layer reads the
	// first positional argument as the session id.
	const useStepResume = IS_STEP_ENTRYPOINT;
	if (useStepResume) args.push("resume", sessionManager.getSessionId());
	if (!sessionManager.usesDefaultSessionDir()) {
		args.push("--session-dir", quoteIfNeeded(sessionManager.getSessionDir()));
	}
	if (!useStepResume) args.push("--session", sessionManager.getSessionId());
	return args.join(" ");
}

function hasDefaultModelProvider(providerId: string): providerId is keyof typeof defaultModelPerProvider {
	return providerId in defaultModelPerProvider;
}

function llamaCppPostLoginGuidance(actionLabel: string, loadedModelCount: number): string {
	return loadedModelCount === 0
		? `${actionLabel}. No llama.cpp models are loaded. Use /llama to load a model, then /model to select it.`
		: `${actionLabel}. Use /model to select a loaded llama.cpp model, or /llama to manage models.`;
}

function readCredentialUid(credential: unknown): string | undefined {
	if (!credential || typeof credential !== "object" || Array.isArray(credential)) return undefined;
	const uid = (credential as Record<string, unknown>).uid;
	return typeof uid === "string" && uid.trim() ? uid.trim() : undefined;
}

type LoginProviderCompletionOption = {
	id: string;
	name: string;
	authTypes: AuthSelectorProvider["authType"][];
};

const AUTH_TYPE_ORDER = { oauth: 0, api_key: 1 } satisfies Record<AuthSelectorProvider["authType"], number>;

function createFuzzyAutocompleteItems<T>(
	items: T[],
	prefix: string,
	getSearchText: (item: T) => string,
	toAutocompleteItem: (item: T) => AutocompleteItem,
): AutocompleteItem[] | null {
	const filtered = fuzzyFilter(items, prefix, getSearchText);
	if (filtered.length === 0) return null;
	return filtered.map(toAutocompleteItem);
}

function getLoginProviderCompletionOptions(
	providerOptions: readonly AuthSelectorProvider[],
): LoginProviderCompletionOption[] {
	const byId = new Map<string, LoginProviderCompletionOption>();
	for (const provider of providerOptions) {
		const existing = byId.get(provider.id);
		if (existing) {
			if (!existing.authTypes.includes(provider.authType)) {
				existing.authTypes.push(provider.authType);
				existing.authTypes.sort((a, b) => AUTH_TYPE_ORDER[a] - AUTH_TYPE_ORDER[b]);
			}
			continue;
		}
		byId.set(provider.id, {
			id: provider.id,
			name: provider.name,
			authTypes: [provider.authType],
		});
	}
	return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function getLoginProviderSearchText(provider: LoginProviderCompletionOption): string {
	const authTypes = provider.authTypes
		.map((authType) => `${authType} ${formatAuthSelectorProviderType(authType)}`)
		.join(" ");
	return `${provider.id} ${provider.name} ${authTypes}`;
}

function formatLoginProviderCompletionDescription(provider: LoginProviderCompletionOption): string {
	const authTypes = provider.authTypes.map(formatAuthSelectorProviderType).join("/");
	return provider.name === provider.id ? authTypes : `${provider.name} · ${authTypes}`;
}

// InteractiveModeOptions / InteractiveStartupContext: single source of truth lives in
// @step-harness/coding-agent (interactive-contract.ts). Imported at top, re-exported
// here so the ui barrel and InteractiveMode construction share ONE definition (no drift).
export type { InteractiveModeOptions, InteractiveStartupContext };

interface InteractiveTuiOptions {
	tuiMode: TuiMode;
	showHardwareCursor: boolean;
	logDirectory: string;
	terminal?: Terminal;
	onRightClickPaste?: () => void;
	fullscreenCopyOnSelect?: boolean;
}

/** Composition root for selecting the interactive terminal renderer. */
export function createInteractiveTui(options: InteractiveTuiOptions): TuiMainScreen | TuiAltScreen {
	const terminal = options.terminal ?? new ProcessTerminal();
	if (options.tuiMode === "fullscreen") {
		const styleSearchMatch = (text: string) => theme.bg("searchMatchBg", theme.fg("searchMatchText", text));
		return new TuiAltScreen(terminal, options.showHardwareCursor, options.logDirectory, {
			searchMatchStyle: (text) => theme.underline(styleSearchMatch(text)),
			searchCurrentMatchStyle: (text) => theme.bold(theme.inverse(styleSearchMatch(text))),
			openUrl: openBrowser,
			onRightClickPaste: options.onRightClickPaste,
			copyOnSelect: options.fullscreenCopyOnSelect,
			copySelection: async (text) => {
				try {
					await copyToClipboard(text);
					return true;
				} catch {
					return false;
				}
			},
		});
	}
	return new TuiMainScreen(terminal, options.showHardwareCursor, options.logDirectory);
}

/** Stable reference for components while InteractiveMode replaces the active renderer. */
export function createInteractiveTuiReference(getTui: () => TUI): TUI {
	return new Proxy({} as TUI, {
		get: (_target, property) => {
			const tui = getTui();
			const value = Reflect.get(tui, property, tui);
			if (typeof value !== "function") return value;
			let methodTui = tui;
			let method = value;
			return (...args: unknown[]) => {
				const currentTui = getTui();
				if (currentTui !== methodTui) {
					const currentMethod = Reflect.get(currentTui, property, currentTui);
					if (typeof currentMethod !== "function") {
						throw new TypeError(`TUI property ${String(property)} is not callable`);
					}
					methodTui = currentTui;
					method = currentMethod;
				}
				return Reflect.apply(method, methodTui, args);
			};
		},
		set: (_target, property, value) => {
			const tui = getTui();
			return Reflect.set(tui, property, value, tui);
		},
		has: (_target, property) => Reflect.has(getTui(), property),
		getPrototypeOf: () => Reflect.getPrototypeOf(getTui()),
	});
}

export class InteractiveMode {
	private runtimeHost: AgentSessionRuntimeHost;
	renderer: TuiMainScreen | TuiAltScreen;
	ui: TUI;
	private mainScreenRenderState: TuiMainScreenRenderState | undefined;
	private loadedResourcesContainer: Container;
	chatContainer: Container;
	private documentContainer: Container;
	stepWelcome: StepWelcomeComponent | undefined;
	stepSpinner: StepToolSpinnerClock | undefined;
	private _redraw: Redraw | undefined;
	// `redraw` is the interactive render funnel — a thin facade over `this.ui`
	// (see runtime/redraw.ts). The constructor builds it eagerly so it also owns
	// the animation clock (`redraw.spinner`), but it is derived lazily from
	// `this.ui` here so a mode that structurally satisfies RuntimeContext without
	// running the constructor (e.g. the approval regression harness) still gets a
	// working funnel instead of throwing on `this.redraw`.
	get redraw(): Redraw {
		if (this._redraw === undefined) {
			this._redraw = createRedraw(this.ui);
		}
		return this._redraw;
	}
	private transcriptScrollView: TuiLayouts.ScrollView | undefined;
	private fullscreenLayoutRoot: Component | undefined;
	private pendingMessagesContainer: Container;
	private stepQueuedMessages: StepQueuedMessagesComponent | undefined;
	private statusContainer: Container;
	defaultEditor: CustomEditor;
	editor: EditorComponent;
	private editorComponentFactory: EditorFactory | undefined;
	private autocompleteProvider: AutocompleteProvider | undefined;
	private autocompleteProviderWrappers: AutocompleteProviderFactory[] = [];
	private fdPath: string | undefined;
	private editorContainer: Container;
	private activeSelectorToken?: object;
	private activeSelectorDispose?: () => void;
	footer: FooterComponent;
	private footerContainer: Container;
	private footerDataProvider: FooterDataProvider;
	// Stored so the same manager can be injected into custom editors, selectors, and extension UI.
	private keybindings: KeybindingsManager;
	private version: string;
	isInitialized = false;
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[] = [];
	readonly pastedImages = new PastedImageRegistry();
	activeStatusIndicator: StatusIndicator | undefined = undefined;
	private readonly idleStatus = new IdleStatus();
	private workingMessage: string | undefined = undefined;
	workingVisible = true;
	waitingForApproval = false;
	private workingIndicatorOptions: WorkingIndicatorOptions | undefined = undefined;
	readonly workingOutputTracker = new WorkingOutputTracker();
	// Set when the last assistant message ended aborted/error; the turn-done
	// marker is suppressed for such turns. Mutated by the session-events runtime
	// (agent_start/message_end) and read at agent_end through RuntimeContext.
	turnEndedAbnormally = false;
	// One tip per turn under the working row (CC spinner-tip position). Pool is
	// built lazily: field initializers run before the constructor applies custom
	// keybindings, and tips render key names via keyText(). The rotator is
	// advanced by the session-events runtime at turn_start; currentStatusTip is
	// read back here by showWorkingStatusIndicator().
	statusTipRotator: StatusTipRotator | undefined = undefined;
	currentStatusTip: string | undefined = undefined;
	private readonly defaultWorkingMessage = "Working...";
	private readonly defaultHiddenThinkingLabel = "Thinking...";
	hiddenThinkingLabel = this.defaultHiddenThinkingLabel;

	lastSigintTime = 0;
	lastEscapeTime = 0;
	private changelogMarkdown: string | undefined = undefined;
	private startupNoticesShown = false;
	private anthropicSubscriptionWarningShown = false;

	// Status line tracking (for mutating immediately-sequential status updates)
	private lastStatusSpacer: Spacer | undefined = undefined;
	private lastStatusText: Text | undefined = undefined;
	// Alignment of the currently-tracked status row, so showStatus never merges a
	// message onto a tracked Text of a different alignment (e.g. the centered
	// clipboard-image hint onto a left-aligned status).
	private managedToolStatusStarted = false;

	// Streaming message tracking
	streamingComponent: AssistantMessageComponent | undefined = undefined;
	streamingMessage: AssistantMessage | undefined = undefined;

	// Tool execution tracking: toolCallId -> component
	pendingTools = new Map<string, ToolExecutionComponent>();

	// Tool output expansion state
	toolOutputExpanded = false;

	// Thinking block visibility state
	hideThinkingBlock = false;
	outputPad = 1;
	private readonly mermaidMarkdownTransformer: MarkdownTransformer = createMermaidMarkdownTransformer({
		getMode: () => this.settingsManager.getMermaidRenderingMode(),
		theme,
	});

	// Skill commands: command name -> skill file path
	private skillCommands = new Map<string, string>();

	/**
	 * Every slash command name the user can invoke, rebuilt with the autocomplete
	 * provider. Used to reject unregistered `/x` input instead of forwarding it to
	 * the model as a prompt. Commands handled by the hardcoded chain in
	 * setupEditorSubmitHandler return before the check, so hidden ones such as
	 * /debug do not need to appear here.
	 */
	private knownSlashCommandNames = new Set<string>();

	// Agent subscription unsubscribe function
	unsubscribe?: () => void;
	private signalCleanupHandlers: Array<() => void> = [];

	// Track if editor is in bash mode (text starts with !) and whether the
	// !! variant excludes the command output from the model's context
	isBashMode = false;
	isBashExcluded = false;

	// Track current bash execution component
	private bashComponent: BashExecutionComponent | undefined = undefined;

	// Track pending bash components (shown in pending area, moved to chat on submit)
	private pendingBashComponents: BashExecutionComponent[] = [];

	// Auto-compaction state
	autoCompactionEscapeHandler?: () => void;

	// Auto-retry state
	retryEscapeHandler?: () => void;

	// Messages queued while compaction is running
	private compactionQueuedMessages: CompactionQueuedMessage[] = [];

	// Shutdown state
	private shutdownRequested = false;

	// Extension UI state
	private extensionDialogsBlocked = false;
	private extensionSelector: ExtensionSelectorComponent | undefined = undefined;
	private cancelExtensionSelector: (() => void) | undefined = undefined;
	private extensionInput: ExtensionInputComponent | undefined = undefined;
	private cancelExtensionInput: (() => void) | undefined = undefined;
	private extensionEditor: ExtensionEditorComponent | undefined = undefined;
	private extensionTerminalInputSubscriptions = new Set<{
		handler: (data: string) => { consume?: boolean; data?: string } | undefined;
		unsubscribe: () => void;
	}>();

	// Clipboard-image hint: when the terminal regains focus (e.g. after a
	// screenshot) and the clipboard holds an image, hint the paste key once.

	// Extension widgets (components rendered above/below the editor)
	private extensionWidgetsAbove = new Map<string, Component & { dispose?(): void }>();
	private extensionWidgetsBelow = new Map<string, Component & { dispose?(): void }>();
	private widgetContainerAbove!: Container;
	private widgetContainerBelow!: Container;

	// Custom footer from extension (undefined = use built-in footer)
	private customFooter: (Component & { dispose?(): void }) | undefined = undefined;

	// Header container that holds the built-in or custom header
	private headerContainer: Container;

	// Built-in header (logo + keybinding hints + changelog)
	private builtInHeader: Component | undefined = undefined;

	// Custom header from extension (undefined = use built-in header)
	private customHeader: (Component & { dispose?(): void }) | undefined = undefined;

	options: InteractiveModeOptions;
	private readonly onRightClickPaste = (): void => {
		void this.handleRightClickPaste();
	};
	private autoTrustOnReloadCwd: string | undefined;
	private themeController: InteractiveThemeController;

	// Convenience accessors
	get session(): AgentSession {
		return this.runtimeHost.session;
	}
	private get agent() {
		return this.session.agent;
	}
	get sessionManager() {
		return this.session.sessionManager;
	}
	get settingsManager() {
		return this.session.settingsManager;
	}
	private get agentDir(): string {
		// A few embedders and renderer-only tests construct the prototype with a
		// minimal runtime host. Keep the native Pi fallback for those callers while
		// the Step composition root still supplies its isolated agent directory.
		return this.runtimeHost?.services?.agentDir ?? getAgentDir();
	}
	private get configDirName(): string {
		return this.runtimeHost?.services?.configDirName ?? this.options?.configDirName ?? CONFIG_DIR_NAME;
	}
	get presentation(): "native" | "step" {
		return this.options?.tuiStyle === "step" ? "step" : "native";
	}
	private get stepSessionRoot(): string {
		return this.options.sessionRoot ?? path.join(this.agentDir, "sessions");
	}

	constructor(runtimeHost: AgentSessionRuntimeHost, options: InteractiveModeOptions = {}) {
		this.runtimeHost = runtimeHost;
		setThemeStorageDir(this.runtimeHost.services.agentDir);
		setCapabilityOverrides(this.settingsManager.getTerminalCapabilityOverrides());
		const tuiMode = options.tuiMode ?? this.settingsManager.getTuiMode();
		this.options = { ...options, tuiMode };
		this.autoTrustOnReloadCwd = options.autoTrustOnReloadCwd;
		this.runtimeHost.setBeforeSessionInvalidate(() => {
			this.resetExtensionUI();
		});
		this.runtimeHost.setRebindSession(async () => {
			await this.rebindCurrentSession({ renderBeforeBind: true });
			await this.themeController.applyFromSettings();
		});
		this.version = VERSION;
		this.renderer = createInteractiveTui({
			tuiMode,
			showHardwareCursor: this.settingsManager.getShowHardwareCursor(),
			logDirectory: this.agentDir,
			onRightClickPaste: this.onRightClickPaste,
			fullscreenCopyOnSelect: this.settingsManager.getFullscreenCopyOnSelect(),
		});
		this.ui = createInteractiveTuiReference(() => this.renderer);
		this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
		this._redraw = createRedraw(this.ui, { withSpinner: options.tuiStyle === "step" });
		this.stepSpinner = this.redraw.spinner;
		this.headerContainer = new Container();
		this.loadedResourcesContainer = new Container();
		this.chatContainer = new Container();
		this.documentContainer = new Container();
		this.documentContainer.addChild(this.headerContainer);
		if (options.tuiStyle === "step") {
			this.stepWelcome = new StepWelcomeComponent(
				() => ({
					version: this.version,
					model: this.session.model?.id,
					thinkingLevel: this.session.model?.reasoning ? this.session.thinkingLevel : undefined,
					workspaceRoot: this.sessionManager.getCwd(),
					sessionId: this.sessionManager.getSessionId(),
				}),
				{
					requestRender: () => this.redraw.requestRender(),
					requestForceRender: () => this.redraw.forceRender(),
				},
			);
			this.stepWelcome.setFirstMessageHint(!this.hasConversationMessages(this.sessionManager.buildContextEntries()));
			this.documentContainer.addChild(this.stepWelcome);
		}
		this.documentContainer.addChild(this.loadedResourcesContainer);
		this.documentContainer.addChild(this.chatContainer);
		this.pendingMessagesContainer = new Container();
		if (options.tuiStyle === "step") {
			this.stepQueuedMessages = new StepQueuedMessagesComponent();
			this.pendingMessagesContainer.addChild(this.stepQueuedMessages);
		}
		this.statusContainer = new Container();
		this.widgetContainerAbove = new Container();
		this.widgetContainerBelow = new Container();
		this.keybindings = KeybindingsManager.create(this.agentDir);
		if (options.tuiStyle === "step") applyStepKeybindingRemap(this.keybindings);
		setKeybindings(this.keybindings);
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		const editorOptions = {
			paddingX: editorPaddingX,
			autocompleteMaxVisible,
		};
		this.defaultEditor =
			options.tuiStyle === "step"
				? new StepEditor(this.ui, getEditorTheme(), this.keybindings, {
						...editorOptions,
						placeholder: STEP_EDITOR_PLACEHOLDER,
					})
				: new CustomEditor(this.ui, getEditorTheme(), this.keybindings, editorOptions);
		this.editor = this.defaultEditor;
		this.editorContainer = new Container();
		this.editorContainer.addChild(this.editor as Component);
		this.footerDataProvider = new FooterDataProvider(this.sessionManager.getCwd());
		this.footer = new FooterComponent(this.session, this.footerDataProvider, {
			presentation: options.tuiStyle === "step" ? "step" : "native",
			// Same condition that redirects the binding in setupKeyHandlers, so the
			// footer never advertises a cycle this session does not have.
			permissionCycleKey: () =>
				options.tuiStyle === "step" && this.session.extensionRunner.getCommand("permissions")
					? keyText("app.thinking.cycle")
					: undefined,
		});
		this.footer.setAutoCompactEnabled(this.session.autoCompactionEnabled);
		this.footerContainer = new Container();
		this.footerContainer.addChild(this.footer);

		// Load hide thinking block setting
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
		this.outputPad = this.settingsManager.getOutputPad();

		// Register themes from resource loader and initialize
		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		this.themeController = new InteractiveThemeController(this.ui, {
			getSettingsManager: () => this.settingsManager,
			showError: (message) => this.showError(message),
			onChanged: () => this.updateEditorBorderColor(),
			initialThemeSetting: options.initialThemeSetting,
			defaultTheme: options.defaultTheme,
		});
	}

	private getAutocompleteSourceTag(sourceInfo?: SourceInfo): string | undefined {
		if (!sourceInfo) {
			return undefined;
		}

		const scopePrefix = sourceInfo.scope === "user" ? "u" : sourceInfo.scope === "project" ? "p" : "t";
		const source = sourceInfo.source.trim();

		if (source === "auto" || source === "local" || source === "cli") {
			return scopePrefix;
		}

		if (source.startsWith("npm:")) {
			return `${scopePrefix}:${source}`;
		}

		const gitSource = parseGitUrl(source);
		if (gitSource) {
			const ref = gitSource.ref ? `@${gitSource.ref}` : "";
			return `${scopePrefix}:git:${gitSource.host}/${gitSource.path}${ref}`;
		}

		return scopePrefix;
	}

	private prefixAutocompleteDescription(description: string | undefined, sourceInfo?: SourceInfo): string | undefined {
		const sourceTag = this.getAutocompleteSourceTag(sourceInfo);
		if (!sourceTag) {
			return description;
		}
		return description ? `[${sourceTag}] ${description}` : `[${sourceTag}]`;
	}

	private getBuiltInCommandConflictDiagnostics(extensionRunner: ExtensionRunner): ResourceDiagnostic[] {
		const builtinNames = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));
		return extensionRunner
			.getRegisteredCommands()
			.filter((command) => builtinNames.has(command.name))
			.map((command) => ({
				type: "warning" as const,
				message:
					command.invocationName === command.name
						? `Extension command '/${command.name}' conflicts with built-in interactive command. Skipping in autocomplete.`
						: `Extension command '/${command.name}' conflicts with built-in interactive command. Available as '/${command.invocationName}'.`,
				path: command.sourceInfo.path,
			}));
	}

	private createBaseAutocompleteProvider(): AutocompleteProvider {
		// Define commands for autocomplete
		const slashCommands: SlashCommand[] = BUILTIN_SLASH_COMMANDS.map((command) => ({
			name: command.name,
			description: command.description,
			...(command.argumentHint && { argumentHint: command.argumentHint }),
		}));

		const modelCommand = slashCommands.find((command) => command.name === "model");
		if (modelCommand) {
			modelCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
				const models =
					this.session.scopedModels.length > 0
						? this.session.scopedModels.map((s) => s.model)
						: this.session.modelRuntime.getAvailableSnapshot();

				if (models.length === 0) return null;

				// Create items with provider/id format
				const items = models.map((m) => ({
					id: m.id,
					provider: m.provider,
					name: m.name,
					label: `${m.provider}/${m.id}`,
				}));

				return createFuzzyAutocompleteItems(items, prefix, getModelSearchText, (item) => ({
					value: item.label,
					label: item.id,
					description: item.provider,
				}));
			};
		}

		const thinkingCommands = slashCommands.filter(
			(command) => command.name === "thinking" || command.name === "effort",
		);
		for (const thinkingCommand of thinkingCommands) {
			thinkingCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
				return createFuzzyAutocompleteItems(
					this.session.getAvailableThinkingLevels(),
					prefix,
					(level) => level,
					(level) => ({
						value: level,
						label: level,
					}),
				);
			};
		}

		const loginCommand = slashCommands.find((command) => command.name === "login");
		if (loginCommand) {
			loginCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
				const providers = getLoginProviderCompletionOptions(this.getLoginProviderOptions());
				return createFuzzyAutocompleteItems(providers, prefix, getLoginProviderSearchText, (provider) => ({
					value: provider.id,
					label: provider.id,
					description: formatLoginProviderCompletionDescription(provider),
				}));
			};
		}

		// Convert prompt templates to SlashCommand format for autocomplete
		const templateCommands: SlashCommand[] = this.session.promptTemplates.map((cmd) => ({
			name: cmd.name,
			description: this.prefixAutocompleteDescription(cmd.description, cmd.sourceInfo),
			...(cmd.argumentHint && { argumentHint: cmd.argumentHint }),
		}));

		// Convert extension commands to SlashCommand format
		const builtinCommandNames = new Set(slashCommands.map((c) => c.name));
		const extensionCommands: SlashCommand[] = this.session.extensionRunner
			.getRegisteredCommands()
			.filter((cmd) => !builtinCommandNames.has(cmd.name))
			.map((cmd) => ({
				name: cmd.invocationName,
				description: this.prefixAutocompleteDescription(cmd.description, cmd.sourceInfo),
				getArgumentCompletions: cmd.getArgumentCompletions,
			}));

		// Build skill commands from session.skills (if enabled)
		this.skillCommands.clear();
		const skillCommandList: SlashCommand[] = [];
		if (this.settingsManager.getEnableSkillCommands()) {
			for (const skill of this.session.resourceLoader.getSkills().skills) {
				const commandName = `skill:${skill.name}`;
				this.skillCommands.set(commandName, skill.filePath);
				skillCommandList.push({
					name: commandName,
					description: this.prefixAutocompleteDescription(skill.description, skill.sourceInfo),
				});
			}
		}

		const combinedCommands = [...slashCommands, ...templateCommands, ...extensionCommands, ...skillCommandList];
		this.knownSlashCommandNames = new Set(combinedCommands.map((command) => command.name));
		return new CombinedAutocompleteProvider(
			this.presentation === "step" ? orderStepSlashCommands(combinedCommands) : combinedCommands,
			this.sessionManager.getCwd(),
			this.fdPath,
		);
	}

	private setupAutocompleteProvider(): void {
		let provider = this.createBaseAutocompleteProvider();
		const triggerCharacters: string[] = [];
		for (const wrapProvider of this.autocompleteProviderWrappers) {
			provider = wrapProvider(provider);
			triggerCharacters.push(...(provider.triggerCharacters ?? []));
		}
		if (triggerCharacters.length > 0) {
			provider.triggerCharacters = [...new Set(triggerCharacters)];
		}

		this.autocompleteProvider = provider;
		this.defaultEditor.setAutocompleteProvider(provider);
		if (this.editor !== this.defaultEditor) {
			this.editor.setAutocompleteProvider?.(provider);
		}
	}

	private showStartupNoticesIfNeeded(): void {
		if (this.startupNoticesShown) {
			return;
		}
		this.startupNoticesShown = true;

		if (!this.changelogMarkdown) {
			return;
		}

		if (this.chatContainer.children.length > 0) {
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(new DynamicBorder());
		if (this.settingsManager.getCollapseChangelog()) {
			const versionMatch = this.changelogMarkdown.match(/##\s+\[?(\d+\.\d+\.\d+)\]?/);
			const latestVersion = versionMatch ? versionMatch[1] : this.version;
			const condensedText = `Updated to v${latestVersion}.`;
			this.chatContainer.addChild(new Text(condensedText, 1, 0));
		} else {
			this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Markdown(this.changelogMarkdown.trim(), 1, 0, this.getMarkdownThemeWithSettings()),
			);
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(new DynamicBorder());
	}

	private mountInteractiveTui(tui: TuiMainScreen | TuiAltScreen, components: readonly Component[]): void {
		for (const component of components) tui.addChild(component);
		if (TuiLayouts.isViewportTUI(tui)) {
			if (!this.fullscreenLayoutRoot) throw new Error("Fullscreen layout is not initialized");
			tui.setLayoutRoot(this.fullscreenLayoutRoot);
		}
	}

	private stopInteractiveTui(fullscreenExitOutput: FullscreenExitOutput): void {
		if (this.renderer.mode === "fullscreen" && fullscreenExitOutput === "transcript") {
			while (this.renderer.hasOverlayEntries) this.renderer.hideOverlay();
			this.switchTuiMode("regular", false, false);
			this.renderer.renderNow();
		}
		this.ui.stop({ preserveScreen: this.renderer.mode === "fullscreen" });
	}

	private switchTuiMode(mode: TuiMode, restoreProgress = true, startRenderer = true): boolean {
		const previousUi = this.renderer;
		if (mode === previousUi.mode) return true;
		if (previousUi.hasOverlayEntries) return false;

		const components = [...previousUi.children];
		const focus = previousUi.getFocusedComponent();
		const terminal = previousUi.terminal;
		const showHardwareCursor = previousUi.getShowHardwareCursor();
		const clearOnShrink = previousUi.getClearOnShrink();
		const onDebug = previousUi.onDebug;
		if (previousUi instanceof TuiMainScreen) {
			this.mainScreenRenderState = previousUi.captureRenderState();
		}

		previousUi.stop({ preserveScreen: true });
		previousUi.setFocus(null);
		previousUi.clear();
		if (TuiLayouts.isViewportTUI(previousUi)) previousUi.setLayoutRoot(undefined);

		const nextUi = createInteractiveTui({
			tuiMode: mode,
			showHardwareCursor,
			logDirectory: this.agentDir,
			terminal,
			onRightClickPaste: this.onRightClickPaste,
			fullscreenCopyOnSelect: this.settingsManager.getFullscreenCopyOnSelect(),
		});
		nextUi.setClearOnShrink(clearOnShrink);
		nextUi.onDebug = onDebug;
		if (nextUi instanceof TuiMainScreen && this.mainScreenRenderState) {
			nextUi.restoreRenderState(this.mainScreenRenderState);
		}
		this.renderer = nextUi;
		this.options.tuiMode = mode;
		this.mountInteractiveTui(nextUi, components);
		// TuiAltScreen invalidates its mounted tree from beforeTerminalStart when
		// iTerm2 image capabilities are active. Avoid a second invalidation in that
		// path while keeping the explicit remount invalidation for regular terminals
		// (and for renderer handoffs that are intentionally not started yet).
		const startInvalidatesTree =
			startRenderer && nextUi instanceof TuiAltScreen && getCapabilities().images === "iterm2";
		if (!startInvalidatesTree) nextUi.invalidate();
		nextUi.setFocus(focus);
		if (!startRenderer) return true;
		nextUi.start();
		this.themeController.rebindTui();
		this.rebindExtensionTerminalInputListeners();
		if (
			restoreProgress &&
			this.settingsManager.getShowTerminalProgress() &&
			(this.session.isStreaming || this.session.isCompacting)
		) {
			terminal.setProgress(true);
		}
		return true;
	}

	async init(): Promise<void> {
		if (this.isInitialized) return;

		this.registerSignalHandlers();

		// Product entrypoints can opt out of the upstream package changelog while
		// retaining the native interactive mode.
		this.changelogMarkdown = this.options.showChangelog === false ? undefined : this.getChangelogForDisplay();

		if (this.session.scopedModels.length > 0 && (this.options.verbose || !this.settingsManager.getQuietStartup())) {
			const modelList = this.session.scopedModels
				.map((sm) => {
					const thinkingStr = sm.thinkingLevel ? `:${sm.thinkingLevel}` : "";
					return `${sm.model.id}${thinkingStr}`;
				})
				.join(", ");
			const cycleKeys = this.keybindings.getKeys("app.model.cycleForward");
			const cycleHint =
				cycleKeys.length > 0
					? theme.fg("muted", ` (${formatKeyText(cycleKeys.join("/"), { capitalize: true })} to cycle)`)
					: "";
			console.log(theme.fg("dim", `Model scope: ${modelList}${cycleHint}`));
		}

		// Keep one component tree and remount it when changing renderers.
		this.renderWidgets(); // Initialize with default spacer
		this.transcriptScrollView = new TuiLayouts.ScrollView(this.documentContainer, {
			follow: "end",
			primary: true,
			overscroll: "chain",
			scrollbar: this.settingsManager.getFullscreenScrollbar(),
			scrollbarStyle: (text) => theme.bg("scrollbarThumb", text),
		});
		const dock = new TuiLayouts.VStack([
			{ component: this.pendingMessagesContainer, shrink: 1, minSize: 0 },
			{ component: this.statusContainer, shrink: 1, minSize: 0 },
			{ component: this.widgetContainerAbove, shrink: 1, minSize: 0 },
			{ component: this.editorContainer, shrink: 1, minSize: 3 },
			{ component: this.widgetContainerBelow, shrink: 1, minSize: 0 },
			{ component: this.footerContainer, shrink: 1, minSize: 1 },
		]);
		this.fullscreenLayoutRoot = new TuiLayouts.VStack([
			{
				component: this.transcriptScrollView,
				basis: 0,
				grow: 1,
				shrink: 1,
				minSize: 1,
			},
			{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
		]);
		this.mountInteractiveTui(this.renderer, [
			this.documentContainer,
			this.pendingMessagesContainer,
			this.statusContainer,
			this.widgetContainerAbove,
			this.editorContainer,
			this.widgetContainerBelow,
			this.footerContainer,
		]);
		// Accept text while startup completes, but only enable interrupt, exit, and submission feedback.
		wireStartupInput(this);
		this.ui.setFocus(this.editor);

		// Start the UI before initializing extensions so session_start handlers can use interactive dialogs
		this.ui.start();
		this.isInitialized = true;
		// A resumed transcript scrolls the welcome block out of the viewport, and
		// pi answers a change above the viewport by clearing the screen and
		// scrollback and replaying the whole buffer - once per animation frame.
		// Play the intro only while the block is what the user is looking at.
		if (
			this.options.tuiStyle === "step" &&
			process.stdout.isTTY === true &&
			this.runtimeHost !== undefined &&
			!this.hasConversationMessages(this.sessionManager.buildContextEntries())
		) {
			this.stepWelcome?.playLogoIntro();
		}

		await this.themeController.applyFromSettings();

		// Step presents identity and session facts in its persistent welcome block;
		// the upstream Pi instructional header would duplicate that surface.
		if (this.options.tuiStyle === "step") {
			this.builtInHeader = new Text("", 0, 0);
			this.headerContainer.addChild(this.builtInHeader);
		} else if (this.options.verbose || !this.settingsManager.getQuietStartup()) {
			const logo = theme.bold(theme.fg("accent", APP_NAME)) + theme.fg("dim", ` v${this.version}`);

			// Build startup instructions using keybinding hint helpers
			const hint = (keybinding: AppKeybinding, description: string) => keyHint(keybinding, description);

			const expandedInstructions = [
				hint("app.interrupt", "to interrupt"),
				hint("app.clear", "to clear"),
				rawKeyHint(`${keyText("app.clear")} twice`, "to exit"),
				hint("app.exit", "to exit (empty)"),
				hint("app.suspend", "to suspend"),
				keyHint("tui.editor.deleteToLineEnd", "to delete to end"),
				hint("app.thinking.cycle", "to cycle thinking level"),
				rawKeyHint(`${keyText("app.model.cycleForward")}/${keyText("app.model.cycleBackward")}`, "to cycle models"),
				hint("app.model.select", "to select model"),
				hint("app.tools.expand", "to expand tools"),
				hint("app.thinking.toggle", "to expand thinking"),
				hint("app.editor.external", "for external editor"),
				rawKeyHint("/", "for commands"),
				rawKeyHint("!", "to run bash"),
				rawKeyHint("!!", "to run bash (no context)"),
				hint("app.message.followUp", "to queue follow-up"),
				hint("app.message.dequeue", "to edit all queued messages"),
				hint("app.clipboard.pasteImage", "to paste image (with text fallback)"),
				rawKeyHint("drop files", "to attach"),
			].join("\n");
			const compactInstructions = [
				hint("app.interrupt", "interrupt"),
				rawKeyHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "clear/exit"),
				rawKeyHint("/", "commands"),
				rawKeyHint("!", "bash"),
				hint("app.tools.expand", "more"),
			].join(theme.fg("muted", " · "));
			const compactOnboarding = theme.fg(
				"dim",
				`Press ${keyText("app.tools.expand")} to show full startup help and loaded resources.`,
			);
			const onboarding = theme.fg(
				"dim",
				`${APP_NAME} can explain its own features and look up its docs. Ask it how to use or extend ${APP_NAME}.`,
			);
			this.builtInHeader = new ExpandableText(
				() => `${logo}\n${compactInstructions}\n${compactOnboarding}\n\n${onboarding}`,
				() => `${logo}\n${expandedInstructions}\n\n${onboarding}`,
				this.getStartupExpansionState(),
				1,
				0,
			);

			// Setup UI layout
			this.headerContainer.addChild(new Spacer(1));
			this.headerContainer.addChild(this.builtInHeader);
			this.headerContainer.addChild(new Spacer(1));
		} else {
			// Minimal header when silenced
			this.builtInHeader = new Text("", 0, 0);
			this.headerContainer.addChild(this.builtInHeader);
		}
		this.redraw.requestRender();

		if (!this.options.skipManagedTools) {
			// Ensure fd and rg are available after mounting the TUI (downloads if
			// missing, adds to PATH via getBinDir) so slow downloads do not make
			// startup appear frozen. Both are needed by the normal REPL for
			// autocomplete and grep/bash commands.
			const [fdPath] = await Promise.all([
				ensureTool("fd", (status) => this.showManagedToolStatus(status), { agentDir: this.agentDir }),
				ensureTool("rg", (status) => this.showManagedToolStatus(status), { agentDir: this.agentDir }),
			]);
			this.fdPath = fdPath;
		}

		// Enable the remaining input handlers only after managed-tool setup completes.
		wireInteractiveRuntime(this);
		this.redraw.requestRender();

		// Paint the committed startup frame before binding extensions. Extension
		// startup (MCP discovery, connections, tool registration) is unbounded in
		// time, and the loaded-resources container is mounted above the chat
		// container, so resources still appear above messages regardless of which
		// is populated first. renderCurrentSessionState renders initial messages.
		await this.rebindCurrentSession({ renderBeforeBind: true });

		// Set up theme file watcher
		onThemeChange(() => {
			this.ui.invalidate();
			this.updateEditorBorderColor();
			this.redraw.requestRender();
		});

		// Set up git branch watcher (uses provider instead of footer)
		this.footerDataProvider.onBranchChange(() => {
			this.redraw.requestRender();
		});

		// Initialize available provider count for footer display
		await this.updateAvailableProviderCount();

		// Flush the completed startup state before loading the remaining syntax grammars.
		this.redraw.renderNow();
		void loadAllHighlightLanguages().then(() => {
			if (!this.isInitialized) return;
			this.ui.invalidate();
			this.redraw.requestRender();
		});
	}

	/**
	 * Update terminal title with session name and cwd.
	 */
	updateTerminalTitle(): void {
		const cwdBasename = path.basename(this.sessionManager.getCwd());
		const sessionName = this.sessionManager.getSessionName();
		if (sessionName) {
			this.ui.terminal.setTitle(`${APP_TITLE} - ${sessionName} - ${cwdBasename}`);
		} else {
			this.ui.terminal.setTitle(`${APP_TITLE} - ${cwdBasename}`);
		}
	}

	/**
	 * Run the interactive mode. This is the main entry point.
	 * Initializes the UI, shows warnings, processes initial messages, and starts the interactive loop.
	 */
	async run(): Promise<void> {
		// Only a bare `step` gets the offer: a launch that already carries a prompt,
		// a resumed session, or an auth-only command is here to do something else,
		// not to answer a setup question.
		let mcpImportNotice: string | undefined;
		let mcpImportError: string | undefined;
		if (
			this.options.stepMcpImport &&
			!this.options.exitAfterStartupLogin &&
			!this.options.initialMessage &&
			!this.options.initialMessages?.length &&
			this.session.state.messages.length === 0
		) {
			try {
				mcpImportNotice = await this.options.stepMcpImport();
			} catch (error: unknown) {
				// An offer to import is never worth failing a launch over. Hold the
				// message: there is no chat surface to show it on until init() runs.
				mcpImportError = `Could not offer MCP import: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
		// Optional for the same reason as maybeRunStartupLogin below: the
		// prototype-based render tests drive run() with only the native mode surface.
		const themePromptError =
			typeof this.maybeRunStepThemePrompt === "function" ? await this.maybeRunStepThemePrompt() : undefined;
		await this.init();
		if (this.options.onStartup) {
			const continueStartup = await this.options.onStartup({
				ui: this.createExtensionUIContext(),
				stop: () => this.stop(),
				dispose: () => this.runtimeHost.dispose(),
			});
			if (continueStartup === false) return;
		}
		// Keep the lifecycle hook optional for lightweight embedders and the
		// prototype-based render tests that provide only the native mode surface.
		try {
			if (typeof this.maybeRunStartupLogin === "function") {
				await this.maybeRunStartupLogin();
			}
		} catch (error) {
			// Auth-only product commands must not leave the alternate screen or
			// runtime timers alive when OAuth is cancelled or fails. Normal REPL
			// login keeps its existing in-place error presentation.
			if (this.options.exitAfterStartupLogin) {
				this.stop();
				try {
					await this.runtimeHost.dispose();
				} catch {
					// Preserve the authentication error as the command result.
				}
				stopThemeWatcher();
			}
			throw error;
		}
		if (this.options.exitAfterStartupLogin) {
			// `step login` reuses the native dialog but is a command, not a REPL.
			// Stop the renderer and dispose the runtime without calling process.exit;
			// the product entrypoint still needs to flush telemetry in its finally.
			this.stop();
			await this.runtimeHost.dispose();
			stopThemeWatcher();
			return;
		}

		if (mcpImportNotice) this.showNotice(mcpImportNotice);
		if (mcpImportError) this.showWarning(mcpImportError);
		if (themePromptError) this.showWarning(themePromptError);

		if (!this.options.disableBackgroundServices) {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 15_000);
			void refreshModelCatalogs(this.session.modelRuntime, controller.signal)
				.then(() => this.updateAvailableProviderCount())
				.catch(() => {})
				.finally(() => clearTimeout(timeout));
		}

		// Start package update check asynchronously
		this.checkForPackageUpdates()
			.then((updates) => {
				if (updates.length > 0) {
					this.showPackageUpdateNotification(updates);
				}
			})
			.finally(() => {
				// On Windows, npm can overwrite the shared console title while checking
				// extension package versions. Restore Pi's title after the startup check.
				if (process.platform === "win32" && this.isInitialized) {
					this.updateTerminalTitle();
				}
			});

		// Check tmux keyboard setup asynchronously
		this.checkTmuxKeyboardSetup().then((warning) => {
			if (warning) {
				this.showWarning(warning);
			}
		});

		// Show startup warnings
		const {
			migratedProviders,
			startupDiagnostics,
			modelFallbackMessage,
			initialMessage,
			initialImages,
			initialMessages,
		} = this.options;

		for (const diagnostic of startupDiagnostics ?? []) {
			if (diagnostic.type === "error") {
				this.showError(diagnostic.message);
			} else if (diagnostic.type === "warning") {
				this.showWarning(diagnostic.message);
			} else {
				this.showStatus(diagnostic.message);
			}
		}

		if (migratedProviders && migratedProviders.length > 0) {
			this.showWarning(`Migrated credentials to auth.json: ${migratedProviders.join(", ")}`);
		}

		const modelsJsonError = this.session.modelRuntime.getError();
		if (modelsJsonError) {
			this.showError(`models.json error: ${modelsJsonError}`);
		}

		if (modelFallbackMessage) {
			this.showWarning(modelFallbackMessage);
		}

		void this.maybeWarnAboutAnthropicSubscriptionAuth();

		// Process initial messages
		if (initialMessage) {
			try {
				await this.session.prompt(initialMessage, { images: initialImages });
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			}
		}

		if (initialMessages) {
			for (const message of initialMessages) {
				try {
					await this.session.prompt(message);
				} catch (error: unknown) {
					const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
					this.showError(errorMessage);
				}
			}
		}

		// Main interactive loop
		while (true) {
			const userInput = await this.getUserInput();
			try {
				// Turn [Image #N] placeholders into attachments (and reset the registry
				// for the next message); see resolvePastedImages.
				const { text, images } = await resolvePastedImages(this.pastedImages, userInput, {
					autoResizeImages: this.settingsManager.getImageAutoResize(),
				});
				await this.session.prompt(text, { images: images.length ? images : undefined });
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			}
		}
	}

	private async checkForPackageUpdates(): Promise<string[]> {
		if (this.options.disableBackgroundServices) {
			return [];
		}

		try {
			const packageManager = new DefaultPackageManager({
				cwd: this.sessionManager.getCwd(),
				agentDir: this.agentDir,
				configDirName: this.configDirName,
				settingsManager: this.settingsManager,
			});
			const updates = await packageManager.checkForAvailableUpdates();
			return updates.map((update) => update.displayName);
		} catch (_error: unknown) {
			return [];
		}
	}

	private async checkTmuxKeyboardSetup(): Promise<string | undefined> {
		if (!process.env.TMUX) return undefined;

		const runTmuxShow = (option: string): Promise<string | undefined> => {
			return new Promise((resolve) => {
				const proc = spawn("tmux", ["show", "-gv", option], {
					stdio: ["ignore", "pipe", "ignore"],
				});
				let stdout = "";
				const timer = setTimeout(() => {
					proc.kill();
					resolve(undefined);
				}, 2000);

				proc.stdout?.on("data", (data) => {
					stdout += data.toString();
				});
				proc.on("error", () => {
					clearTimeout(timer);
					resolve(undefined);
				});
				proc.on("close", (code) => {
					clearTimeout(timer);
					resolve(code === 0 ? stdout.trim() : undefined);
				});
			});
		};

		const [extendedKeys, extendedKeysFormat] = await Promise.all([
			runTmuxShow("extended-keys"),
			runTmuxShow("extended-keys-format"),
		]);

		// If we couldn't query tmux (timeout, sandbox, etc.), don't warn
		if (extendedKeys === undefined) return undefined;

		if (extendedKeys !== "on" && extendedKeys !== "always") {
			return `tmux extended-keys is off. Modified Enter keys may not work. Add \`set -g extended-keys on\` to ~/.tmux.conf and restart tmux.`;
		}

		if (extendedKeysFormat === "xterm") {
			return `tmux extended-keys-format is xterm. ${APP_NAME} works best with csi-u. Add \`set -g extended-keys-format csi-u\` to ~/.tmux.conf and restart tmux.`;
		}

		return undefined;
	}

	/**
	 * Get changelog entries to display on startup.
	 * Only shows new entries since last seen version, skips for resumed sessions.
	 */
	private getChangelogForDisplay(): string | undefined {
		// Skip changelog for resumed/continued sessions (already have messages)
		if (this.session.state.messages.length > 0) {
			return undefined;
		}

		const lastVersion = this.settingsManager.getLastChangelogVersion();
		const changelogPath = getChangelogPath();
		const entries = parseChangelog(changelogPath);

		if (!lastVersion) {
			// Fresh install - record the version, don't show changelog
			this.settingsManager.setLastChangelogVersion(VERSION);
			return undefined;
		}

		const newEntries = getNewEntries(entries, lastVersion);
		if (newEntries.length > 0) {
			this.settingsManager.setLastChangelogVersion(VERSION);
			return newEntries.map((e) => normalizeChangelogLinks(e.content, e)).join("\n\n");
		}

		return undefined;
	}

	getMarkdownThemeWithSettings(): MarkdownTheme {
		return {
			...getMarkdownTheme(),
			codeBlockIndent: this.settingsManager.getCodeBlockIndent(),
		};
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	private formatDisplayPath(p: string): string {
		const home = os.homedir();
		let result = p;

		// Replace home directory with ~
		if (result.startsWith(home)) {
			result = `~${result.slice(home.length)}`;
		}

		return result;
	}

	private formatExtensionDisplayPath(path: string): string {
		let result = this.formatDisplayPath(path);
		result = result.replace(/\/index\.ts$/, "").replace(/\/index\.js$/, "");
		return result;
	}

	private formatContextPath(p: string): string {
		const cwd = path.resolve(this.sessionManager.getCwd());
		const absolutePath = path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
		const relativePath = getCwdRelativePath(absolutePath, cwd);
		if (relativePath !== undefined) {
			return relativePath;
		}

		return this.formatDisplayPath(absolutePath);
	}

	private getStartupExpansionState(): boolean {
		return this.options.verbose || this.toolOutputExpanded;
	}

	/**
	 * Get a short path relative to the package root for display.
	 */
	private getShortPath(fullPath: string, sourceInfo?: SourceInfo): string {
		const normalizedFullPath = fullPath.replace(/\\/g, "/");
		const baseDir = sourceInfo?.baseDir;
		if (baseDir && this.isPackageSource(sourceInfo)) {
			const normalizedBaseDir = baseDir.replace(/\\/g, "/");
			const npmRootMatch = normalizedBaseDir.match(/^(.*\/node_modules)\/(@?[^/]+(?:\/[^/]+)?)$/);
			// If fullPath is under the same node_modules root as baseDir, preserve that relative topology.
			if (npmRootMatch?.[1] && normalizedFullPath.startsWith(`${npmRootMatch[1]}/`)) {
				return path.posix.relative(normalizedBaseDir, normalizedFullPath);
			}

			const relativePath = path.relative(path.resolve(baseDir), path.resolve(fullPath));
			if (
				relativePath &&
				relativePath !== "." &&
				!relativePath.startsWith("..") &&
				!relativePath.startsWith(`..${path.sep}`) &&
				!path.isAbsolute(relativePath)
			) {
				return relativePath.replace(/\\/g, "/");
			}
		}

		const source = sourceInfo?.source ?? "";
		const npmMatch = normalizedFullPath.match(/node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/);
		if (npmMatch && source.startsWith("npm:")) {
			return npmMatch[2];
		}

		const gitMatch = normalizedFullPath.match(/git\/[^/]+\/[^/]+\/(.*)/);
		if (gitMatch && source.startsWith("git:")) {
			return gitMatch[1];
		}

		return this.formatDisplayPath(fullPath);
	}

	private getCompactPathLabel(resourcePath: string, sourceInfo?: SourceInfo): string {
		const shortPath = this.getShortPath(resourcePath, sourceInfo);
		const normalizedPath = shortPath.replace(/\\/g, "/");
		const segments = normalizedPath.split("/").filter((segment) => segment.length > 0 && segment !== "~");
		if (segments.length > 0) {
			return segments[segments.length - 1]!;
		}
		return shortPath;
	}

	private getCompactPackageSourceLabel(sourceInfo?: SourceInfo): string {
		const source = sourceInfo?.source ?? "";
		if (source.startsWith("npm:")) {
			return source.slice("npm:".length) || source;
		}

		const gitSource = parseGitUrl(source);
		if (gitSource) {
			return gitSource.path || source;
		}

		return source;
	}

	private getCompactExtensionLabel(resourcePath: string, sourceInfo?: SourceInfo): string {
		if (!this.isPackageSource(sourceInfo)) {
			return this.getCompactPathLabel(resourcePath, sourceInfo);
		}

		const sourceLabel = this.getCompactPackageSourceLabel(sourceInfo);
		if (!sourceLabel) {
			return this.getCompactPathLabel(resourcePath, sourceInfo);
		}

		const shortPath = this.getShortPath(resourcePath, sourceInfo).replace(/\\/g, "/");
		const packagePath = shortPath.startsWith("extensions/") ? shortPath.slice("extensions/".length) : shortPath;
		const parsedPath = path.posix.parse(packagePath);

		if (parsedPath.name === "index") {
			return !parsedPath.dir || parsedPath.dir === "." ? sourceLabel : `${sourceLabel}:${parsedPath.dir}`;
		}

		return `${sourceLabel}:${packagePath}`;
	}

	private getCompactDisplayPathSegments(resourcePath: string): string[] {
		return this.formatDisplayPath(resourcePath)
			.replace(/\\/g, "/")
			.split("/")
			.filter((segment) => segment.length > 0 && segment !== "~");
	}

	private getCompactNonPackageExtensionLabel(
		resourcePath: string,
		index: number,
		allPaths: Array<{ path: string; segments: string[] }>,
	): string {
		const segments = allPaths[index]?.segments;
		if (!segments || segments.length === 0) {
			return this.getCompactPathLabel(resourcePath);
		}

		for (let segmentCount = 1; segmentCount <= segments.length; segmentCount += 1) {
			const candidate = segments.slice(-segmentCount).join("/");
			const isUnique = allPaths.every((item, itemIndex) => {
				if (itemIndex === index) {
					return true;
				}
				return item.segments.slice(-segmentCount).join("/") !== candidate;
			});

			if (isUnique) {
				return candidate;
			}
		}

		return segments.join("/");
	}

	private getCompactExtensionLabels(extensions: Array<{ path: string; sourceInfo?: SourceInfo }>): string[] {
		const nonPackageExtensions = extensions
			.map((extension) => {
				const segments = this.getCompactDisplayPathSegments(extension.path);
				const lastSegment = segments[segments.length - 1];
				if (segments.length > 1 && (lastSegment === "index.ts" || lastSegment === "index.js")) {
					segments.pop();
				}
				return {
					path: extension.path,
					sourceInfo: extension.sourceInfo,
					segments,
				};
			})
			.filter((extension) => !this.isPackageSource(extension.sourceInfo));

		return extensions.map((extension) => {
			if (this.isPackageSource(extension.sourceInfo)) {
				return this.getCompactExtensionLabel(extension.path, extension.sourceInfo);
			}

			const nonPackageIndex = nonPackageExtensions.findIndex((item) => item.path === extension.path);
			if (nonPackageIndex === -1) {
				return this.getCompactPathLabel(extension.path, extension.sourceInfo);
			}

			return this.getCompactNonPackageExtensionLabel(extension.path, nonPackageIndex, nonPackageExtensions);
		});
	}

	private getDisplaySourceInfo(sourceInfo?: SourceInfo): {
		label: string;
		scopeLabel?: string;
		color: "accent" | "muted";
	} {
		const source = sourceInfo?.source ?? "local";
		const scope = sourceInfo?.scope ?? "project";
		if (source === "local") {
			if (scope === "user") {
				return { label: "user", color: "muted" };
			}
			if (scope === "project") {
				return { label: "project", color: "muted" };
			}
			if (scope === "temporary") {
				return { label: "path", scopeLabel: "temp", color: "muted" };
			}
			return { label: "path", color: "muted" };
		}

		if (source === "cli") {
			return {
				label: "path",
				scopeLabel: scope === "temporary" ? "temp" : undefined,
				color: "muted",
			};
		}

		const scopeLabel =
			scope === "user" ? "user" : scope === "project" ? "project" : scope === "temporary" ? "temp" : undefined;
		return { label: source, scopeLabel, color: "accent" };
	}

	private getScopeGroup(sourceInfo?: SourceInfo): "user" | "project" | "path" {
		const source = sourceInfo?.source ?? "local";
		const scope = sourceInfo?.scope ?? "project";
		if (source === "cli" || scope === "temporary") return "path";
		if (scope === "user") return "user";
		if (scope === "project") return "project";
		return "path";
	}

	private isPackageSource(sourceInfo?: SourceInfo): boolean {
		const source = sourceInfo?.source ?? "";
		return source.startsWith("npm:") || source.startsWith("git:");
	}

	private buildScopeGroups(items: Array<{ path: string; sourceInfo?: SourceInfo }>): Array<{
		scope: "user" | "project" | "path";
		paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
		packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
	}> {
		const groups: Record<
			"user" | "project" | "path",
			{
				scope: "user" | "project" | "path";
				paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
				packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
			}
		> = {
			user: { scope: "user", paths: [], packages: new Map() },
			project: { scope: "project", paths: [], packages: new Map() },
			path: { scope: "path", paths: [], packages: new Map() },
		};

		for (const item of items) {
			const groupKey = this.getScopeGroup(item.sourceInfo);
			const group = groups[groupKey];
			const source = item.sourceInfo?.source ?? "local";

			if (this.isPackageSource(item.sourceInfo)) {
				const list = group.packages.get(source) ?? [];
				list.push(item);
				group.packages.set(source, list);
			} else {
				group.paths.push(item);
			}
		}

		return [groups.project, groups.user, groups.path].filter(
			(group) => group.paths.length > 0 || group.packages.size > 0,
		);
	}

	private formatScopeGroups(
		groups: Array<{
			scope: "user" | "project" | "path";
			paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
			packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
		}>,
		options: {
			formatPath: (item: { path: string; sourceInfo?: SourceInfo }) => string;
			formatPackagePath: (item: { path: string; sourceInfo?: SourceInfo }, source: string) => string;
		},
	): string {
		const lines: string[] = [];

		for (const group of groups) {
			lines.push(`  ${theme.fg("accent", group.scope)}`);

			const sortedPaths = [...group.paths].sort((a, b) => a.path.localeCompare(b.path));
			for (const item of sortedPaths) {
				lines.push(theme.fg("dim", `    ${options.formatPath(item)}`));
			}

			const sortedPackages = Array.from(group.packages.entries()).sort(([a], [b]) => a.localeCompare(b));
			for (const [source, items] of sortedPackages) {
				lines.push(`    ${theme.fg("mdLink", source)}`);
				const sortedPackagePaths = [...items].sort((a, b) => a.path.localeCompare(b.path));
				for (const item of sortedPackagePaths) {
					lines.push(theme.fg("dim", `      ${options.formatPackagePath(item, source)}`));
				}
			}
		}

		return lines.join("\n");
	}

	private findSourceInfoForPath(p: string, sourceInfos: Map<string, SourceInfo>): SourceInfo | undefined {
		const exact = sourceInfos.get(p);
		if (exact) return exact;

		let current = p;
		while (current.includes("/")) {
			current = current.substring(0, current.lastIndexOf("/"));
			const parent = sourceInfos.get(current);
			if (parent) return parent;
		}

		return undefined;
	}

	private formatPathWithSource(p: string, sourceInfo?: SourceInfo): string {
		if (sourceInfo) {
			const shortPath = this.getShortPath(p, sourceInfo);
			const { label, scopeLabel } = this.getDisplaySourceInfo(sourceInfo);
			const labelText = scopeLabel ? `${label} (${scopeLabel})` : label;
			return `${labelText} ${shortPath}`;
		}
		return this.formatDisplayPath(p);
	}

	private formatDiagnostics(diagnostics: readonly ResourceDiagnostic[], sourceInfos: Map<string, SourceInfo>): string {
		const lines: string[] = [];

		// Group collision diagnostics by name
		const collisions = new Map<string, ResourceDiagnostic[]>();
		const otherDiagnostics: ResourceDiagnostic[] = [];

		for (const d of diagnostics) {
			if (d.type === "collision" && d.collision) {
				const list = collisions.get(d.collision.name) ?? [];
				list.push(d);
				collisions.set(d.collision.name, list);
			} else {
				otherDiagnostics.push(d);
			}
		}

		// Format collision diagnostics grouped by name
		for (const [name, collisionList] of collisions) {
			const first = collisionList[0]?.collision;
			if (!first) continue;
			lines.push(theme.fg("warning", `  "${name}" collision:`));
			lines.push(
				theme.fg(
					"dim",
					`    ${theme.fg("success", "✓")} ${this.formatPathWithSource(first.winnerPath, this.findSourceInfoForPath(first.winnerPath, sourceInfos))}`,
				),
			);
			for (const d of collisionList) {
				if (d.collision) {
					lines.push(
						theme.fg(
							"dim",
							`    ${theme.fg("warning", "✗")} ${this.formatPathWithSource(d.collision.loserPath, this.findSourceInfoForPath(d.collision.loserPath, sourceInfos))} (skipped)`,
						),
					);
				}
			}
		}

		for (const d of otherDiagnostics) {
			if (d.path) {
				const formattedPath = this.formatPathWithSource(d.path, this.findSourceInfoForPath(d.path, sourceInfos));
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${formattedPath}`));
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `    ${d.message}`));
			} else {
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${d.message}`));
			}
		}

		return lines.join("\n");
	}

	private showLoadedResources(options?: {
		extensions?: Array<{ path: string; sourceInfo?: SourceInfo }>;
		force?: boolean;
		showDiagnosticsWhenQuiet?: boolean;
	}): void {
		// Resource rendering is idempotent; chat clears no longer clear this separate container.
		this.loadedResourcesContainer.clear();

		// Pi's resource sections are useful for the upstream product, but Step's
		// welcome block is intentionally the only persistent startup identity
		// surface. Keep the diagnostic pass below available in Step mode so broken
		// extensions/skills are still visible without leaking the normal inventory.
		const showListing =
			this.options.tuiStyle !== "step" &&
			(options?.force || this.options.verbose || !this.settingsManager.getQuietStartup());
		const showDiagnostics = showListing || options?.showDiagnosticsWhenQuiet === true;
		if (!showListing && !showDiagnostics) {
			return;
		}

		const sectionHeader = (name: string, color: ThemeColor = "mdHeading") => theme.fg(color, `[${name}]`);
		const formatCompactList = (items: string[], options?: { sort?: boolean }): string => {
			const labels = items.map((item) => item.trim()).filter((item) => item.length > 0);
			if (options?.sort !== false) {
				labels.sort((a, b) => a.localeCompare(b));
			}
			return theme.fg("dim", `  ${labels.join(", ")}`);
		};
		const addLoadedSection = (
			name: string,
			collapsedBody: string,
			expandedBody = collapsedBody,
			color: ThemeColor = "mdHeading",
		): void => {
			const section = new ExpandableText(
				() => `${sectionHeader(name, color)}\n${collapsedBody}`,
				() => `${sectionHeader(name, color)}\n${expandedBody}`,
				this.getStartupExpansionState(),
				0,
				0,
			);
			this.loadedResourcesContainer.addChild(section);
			this.loadedResourcesContainer.addChild(new Spacer(1));
		};

		const skillsResult = this.session.resourceLoader.getSkills();
		const promptsResult = this.session.resourceLoader.getPrompts();
		const themesResult = this.session.resourceLoader.getThemes();
		const extensions =
			options?.extensions ??
			this.session.resourceLoader
				.getExtensions()
				.extensions.filter((extension) => !extension.hidden)
				.map((extension) => ({
					path: extension.path,
					sourceInfo: extension.sourceInfo,
				}));
		const sourceInfos = new Map<string, SourceInfo>();
		for (const extension of extensions) {
			if (extension.sourceInfo) {
				sourceInfos.set(extension.path, extension.sourceInfo);
			}
		}
		for (const skill of skillsResult.skills) {
			if (skill.sourceInfo) {
				sourceInfos.set(skill.filePath, skill.sourceInfo);
			}
		}
		for (const prompt of promptsResult.prompts) {
			if (prompt.sourceInfo) {
				sourceInfos.set(prompt.filePath, prompt.sourceInfo);
			}
		}
		for (const loadedTheme of themesResult.themes) {
			if (loadedTheme.sourcePath && loadedTheme.sourceInfo) {
				sourceInfos.set(loadedTheme.sourcePath, loadedTheme.sourceInfo);
			}
		}

		if (showListing) {
			const systemPromptSource = this.session.resourceLoader.getSystemPromptSource();
			const contextFiles = [
				...(systemPromptSource ? [systemPromptSource] : []),
				...this.session.resourceLoader.getAppendSystemPromptSources(),
				...this.session.resourceLoader.getAgentsFiles().agentsFiles,
			];
			if (contextFiles.length > 0) {
				this.loadedResourcesContainer.addChild(new Spacer(1));
				const contextList = contextFiles
					.map((f) => theme.fg("dim", `  ${this.formatDisplayPath(f.path)}`))
					.join("\n");
				const contextCompactList = formatCompactList(
					contextFiles.map((contextFile) => this.formatContextPath(contextFile.path)),
					{ sort: false },
				);
				addLoadedSection("Context", contextCompactList, contextList);
			}

			const skills = skillsResult.skills;
			if (skills.length > 0) {
				const groups = this.buildScopeGroups(
					skills.map((skill) => ({
						path: skill.filePath,
						sourceInfo: skill.sourceInfo,
					})),
				);
				const skillList = this.formatScopeGroups(groups, {
					formatPath: (item) => this.formatDisplayPath(item.path),
					formatPackagePath: (item) => this.getShortPath(item.path, item.sourceInfo),
				});
				const skillCompactList = formatCompactList(skills.map((skill) => skill.name));
				addLoadedSection("Skills", skillCompactList, skillList);
			}

			const templates = this.session.promptTemplates;
			if (templates.length > 0) {
				const groups = this.buildScopeGroups(
					templates.map((template) => ({
						path: template.filePath,
						sourceInfo: template.sourceInfo,
					})),
				);
				const templateByPath = new Map(templates.map((t) => [t.filePath, t]));
				const templateList = this.formatScopeGroups(groups, {
					formatPath: (item) => {
						const template = templateByPath.get(item.path);
						return template ? `/${template.name}` : this.formatDisplayPath(item.path);
					},
					formatPackagePath: (item) => {
						const template = templateByPath.get(item.path);
						return template ? `/${template.name}` : this.formatDisplayPath(item.path);
					},
				});
				const promptCompactList = formatCompactList(templates.map((template) => `/${template.name}`));
				addLoadedSection("Prompts", promptCompactList, templateList);
			}

			if (extensions.length > 0) {
				const groups = this.buildScopeGroups(extensions);
				const extList = this.formatScopeGroups(groups, {
					formatPath: (item) => this.formatExtensionDisplayPath(item.path),
					formatPackagePath: (item) =>
						this.formatExtensionDisplayPath(this.getShortPath(item.path, item.sourceInfo)),
				});
				const extensionCompactList = formatCompactList(this.getCompactExtensionLabels(extensions));
				addLoadedSection("Extensions", extensionCompactList, extList, "mdHeading");
			}

			// Show loaded themes (excluding built-in)
			const loadedThemes = themesResult.themes;
			const customThemes = loadedThemes.filter((t) => t.sourcePath);
			if (customThemes.length > 0) {
				const groups = this.buildScopeGroups(
					customThemes.map((loadedTheme) => ({
						path: loadedTheme.sourcePath!,
						sourceInfo: loadedTheme.sourceInfo,
					})),
				);
				const themeList = this.formatScopeGroups(groups, {
					formatPath: (item) => this.formatDisplayPath(item.path),
					formatPackagePath: (item) => this.getShortPath(item.path, item.sourceInfo),
				});
				const themeCompactList = formatCompactList(
					customThemes.map(
						(loadedTheme) =>
							loadedTheme.name ?? this.getCompactPathLabel(loadedTheme.sourcePath!, loadedTheme.sourceInfo),
					),
				);
				addLoadedSection("Themes", themeCompactList, themeList);
			}
		}

		if (showDiagnostics) {
			const skillDiagnostics = skillsResult.diagnostics;
			if (skillDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(skillDiagnostics, sourceInfos);
				this.loadedResourcesContainer.addChild(
					new Text(`${theme.fg("warning", "[Skill conflicts]")}\n${warningLines}`, 0, 0),
				);
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}

			const promptDiagnostics = promptsResult.diagnostics;
			if (promptDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(promptDiagnostics, sourceInfos);
				this.loadedResourcesContainer.addChild(
					new Text(`${theme.fg("warning", "[Prompt conflicts]")}\n${warningLines}`, 0, 0),
				);
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}

			const extensionDiagnostics: ResourceDiagnostic[] = [];
			const extensionErrors = this.session.resourceLoader.getExtensions().errors;
			if (extensionErrors.length > 0) {
				for (const error of extensionErrors) {
					extensionDiagnostics.push({
						type: "error",
						message: error.error,
						path: error.path,
					});
				}
			}

			const commandDiagnostics = this.session.extensionRunner.getCommandDiagnostics();
			extensionDiagnostics.push(...commandDiagnostics);
			extensionDiagnostics.push(...this.getBuiltInCommandConflictDiagnostics(this.session.extensionRunner));

			const shortcutDiagnostics = this.session.extensionRunner.getShortcutDiagnostics();
			extensionDiagnostics.push(...shortcutDiagnostics);

			if (extensionDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(extensionDiagnostics, sourceInfos);
				this.loadedResourcesContainer.addChild(
					new Text(`${theme.fg("warning", "[Extension issues]")}\n${warningLines}`, 0, 0),
				);
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}

			const themeDiagnostics = themesResult.diagnostics;
			if (themeDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(themeDiagnostics, sourceInfos);
				this.loadedResourcesContainer.addChild(
					new Text(`${theme.fg("warning", "[Theme conflicts]")}\n${warningLines}`, 0, 0),
				);
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}
		}
	}

	/**
	 * Initialize the extension system with TUI-based UI context.
	 */
	private async bindCurrentSessionExtensions(): Promise<void> {
		const uiContext = this.createExtensionUIContext();
		await this.session.bindExtensions({
			uiContext,
			mode: "tui",
			abortHandler: () => {
				this.restoreQueuedMessagesToEditor({ abort: true });
			},
			commandContextActions: {
				waitForIdle: () => this.session.waitForIdle(),
				newSession: async (options) => {
					this.clearStatusIndicator();
					try {
						return await this.runtimeHost.newSession(options);
					} catch (error: unknown) {
						return this.handleFatalRuntimeError("Failed to create session", error);
					}
				},
				fork: async (entryId, options) => {
					try {
						const result = await this.runtimeHost.fork(entryId, options);
						if (!result.cancelled) {
							this.editor.setText(result.selectedText ?? "");
							this.showStatus("Forked to new session");
						}
						return { cancelled: result.cancelled };
					} catch (error: unknown) {
						return this.handleFatalRuntimeError("Failed to fork session", error);
					}
				},
				navigateTree: async (targetId, options) => {
					const result = await this.session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					if (result.cancelled) {
						return { cancelled: true };
					}

					this.chatContainer.clear();
					this.renderInitialMessages();
					if (result.editorText && !this.editor.getText().trim()) {
						this.editor.setText(result.editorText);
					}
					this.showStatus("Navigated to selected point");
					void this.flushCompactionQueue({ willRetry: false });
					return { cancelled: false };
				},
				switchSession: async (sessionPath, options) => {
					return this.handleResumeSession(sessionPath, options);
				},
				reload: async () => {
					await this.handleReloadCommand();
				},
			},
			shutdownHandler: () => {
				this.shutdownRequested = true;
				if (this.session.isIdle) {
					void this.shutdown();
				}
			},
			onError: (error) => {
				this.showExtensionError(error.extensionPath, error.error, error.stack);
			},
		});

		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		this.setupAutocompleteProvider();

		const extensionRunner = this.session.extensionRunner;
		this.setupExtensionShortcuts(extensionRunner);
		this.showLoadedResources({ force: false, showDiagnosticsWhenQuiet: true });
		this.showStartupNoticesIfNeeded();
	}

	private applyFullscreenScrollbarSetting(): void {
		this.transcriptScrollView?.setScrollbar(this.settingsManager.getFullscreenScrollbar());
	}

	private applyRuntimeSettings(): void {
		setCapabilityOverrides(this.settingsManager.getTerminalCapabilityOverrides());
		configureHttpDispatcher(this.settingsManager.getHttpIdleTimeoutMs());
		this.applyFullscreenScrollbarSetting();
		if (this.renderer instanceof TuiAltScreen) {
			this.renderer.setCopyOnSelect(this.settingsManager.getFullscreenCopyOnSelect());
		}
		this.footer.setSession(this.session);
		this.footer.setAutoCompactEnabled(this.session.autoCompactionEnabled);
		this.footerDataProvider.setCwd(this.sessionManager.getCwd());
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
		this.outputPad = this.settingsManager.getOutputPad();
		this.ui.setShowHardwareCursor(this.settingsManager.getShowHardwareCursor());
		const clearOnShrink = this.settingsManager.getClearOnShrink();
		this.ui.setClearOnShrink(clearOnShrink);
		if (!clearOnShrink && !this.activeStatusIndicator) {
			this.statusContainer.clear();
		}
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor.setPaddingX(editorPaddingX);
		this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
		if (this.editor !== this.defaultEditor) {
			this.editor.setPaddingX?.(editorPaddingX);
			this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
		}
	}

	private async rebindCurrentSession(options: { renderBeforeBind?: boolean } = {}): Promise<void> {
		const session = this.session;

		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.applyRuntimeSettings();

		if (options.renderBeforeBind) {
			this.renderCurrentSessionState();
			this.subscribeToAgent();
			// Commit the frame here rather than relying on a queued render to flush
			// during an await. Binding extensions is unbounded in time, so this is
			// the guarantee that the header and the editor are visible first.
			this.redraw.renderNow();
		}

		await this.bindCurrentSessionExtensions();

		if (this.session !== session) {
			return;
		}

		if (!options.renderBeforeBind) {
			this.subscribeToAgent();
		}

		await this.updateAvailableProviderCount();
		this.updateEditorBorderColor();
		this.updateTerminalTitle();
	}

	private async handleFatalRuntimeError(prefix: string, error: unknown): Promise<never> {
		const message = error instanceof Error ? error.message : String(error);
		this.showError(`${prefix}: ${message}`);
		stopThemeWatcher();
		this.stop("transcript");
		process.exit(1);
	}

	private renderCurrentSessionState(): void {
		this.loadedResourcesContainer.clear();
		this.chatContainer.clear();
		this.pendingMessagesContainer.clear();
		this.compactionQueuedMessages = [];
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		this.pendingTools.clear();
		this.stepSpinner?.clear();
		this.renderInitialMessages();
	}

	/**
	 * Get a registered tool definition by name (for custom rendering).
	 */
	getRegisteredToolDefinition(toolName: string) {
		return this.session.getToolDefinition(toolName);
	}

	/** Construct the native message component with the selected product skin. */
	createAssistantMessageComponent(
		message?: AssistantMessage,
		hideThinkingBlock = this.hideThinkingBlock,
		markdownTheme: MarkdownTheme = this.getMarkdownThemeWithSettings(),
		hiddenThinkingLabel = this.hiddenThinkingLabel,
		outputPad = this.outputPad,
		markdownTransformers: readonly MarkdownTransformer[] = this.getMarkdownTransformers(),
	): AssistantMessageComponent {
		if (this.options.tuiStyle === "step") {
			return new StepAssistantMessageComponent(
				message,
				hideThinkingBlock,
				markdownTheme,
				hiddenThinkingLabel,
				outputPad,
				markdownTransformers,
			);
		}
		return new AssistantMessageComponent(
			message,
			hideThinkingBlock,
			markdownTheme,
			hiddenThinkingLabel,
			outputPad,
			markdownTransformers,
		);
	}

	/** Construct the native user message component with the selected product skin. */
	private createUserMessageComponent(
		text: string,
		markdownTheme: MarkdownTheme = this.getMarkdownThemeWithSettings(),
		outputPad = this.outputPad,
		markdownTransformers: readonly MarkdownTransformer[] = this.getMarkdownTransformers(),
	): UserMessageComponent {
		if (this.options.tuiStyle === "step") {
			return new StepUserMessageComponent(text, markdownTheme, outputPad, markdownTransformers);
		}
		return new UserMessageComponent(text, markdownTheme, outputPad, markdownTransformers);
	}

	getMarkdownTransformers(): MarkdownTransformer[] {
		return [this.mermaidMarkdownTransformer, ...this.session.extensionRunner.getMarkdownTransformers()];
	}

	/**
	 * Set up keyboard shortcuts registered by extensions.
	 */
	private setupExtensionShortcuts(extensionRunner: ExtensionRunner): void {
		const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
		if (shortcuts.size === 0) return;

		// Create a context for shortcut handlers
		const createContext = (): ExtensionContext => ({
			ui: this.createExtensionUIContext(),
			mode: "tui",
			hasUI: true,
			cwd: this.sessionManager.getCwd(),
			sessionManager: this.sessionManager,
			modelRegistry: extensionRunner.getModelRegistry(),
			model: this.session.model,
			scopedModels: this.session.scopedModels,
			thinkingLevel: this.session.thinkingLevel,
			isIdle: () => this.session.isIdle,
			isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
			signal: this.session.agent.signal,
			abort: () => {
				this.restoreQueuedMessagesToEditor({ abort: true });
			},
			hasPendingMessages: () => this.session.pendingMessageCount > 0,
			shutdown: () => {
				this.shutdownRequested = true;
			},
			getContextUsage: () => this.session.getContextUsage(),
			compact: (options) => {
				void (async () => {
					try {
						const result = await this.session.compact(options?.customInstructions);
						options?.onComplete?.(result);
					} catch (error) {
						const err = error instanceof Error ? error : new Error(String(error));
						options?.onError?.(err);
					}
				})();
			},
			getSystemPrompt: () => this.session.systemPrompt,
		});

		// Set up the extension shortcut handler on the default editor
		this.defaultEditor.onExtensionShortcut = (data: string) => {
			for (const [shortcutStr, shortcut] of shortcuts) {
				// Cast to KeyId - extension shortcuts use the same format
				if (matchesKey(data, shortcutStr as KeyId)) {
					// Run handler async, don't block input
					Promise.resolve(shortcut.handler(createContext())).catch((err) => {
						this.showError(`Shortcut handler error: ${err instanceof Error ? err.message : String(err)}`);
					});
					return true;
				}
			}
			return false;
		};
	}

	/**
	 * Set extension status text in the footer.
	 */
	private setExtensionStatus(key: string, text: string | undefined): void {
		this.footerDataProvider.setExtensionStatus(key, text);
		this.redraw.requestRender();
	}

	showStatusIndicator(indicator: StatusIndicator): void {
		this.activeStatusIndicator?.dispose();
		this.activeStatusIndicator = indicator;
		this.statusContainer.clear();
		this.statusContainer.addChild(indicator);
	}

	clearStatusIndicator(kind?: StatusIndicator["kind"]): void {
		if (kind && this.activeStatusIndicator?.kind !== kind) {
			return;
		}
		const hadActiveStatusIndicator = this.activeStatusIndicator !== undefined;
		this.activeStatusIndicator?.dispose();
		this.activeStatusIndicator = undefined;
		this.statusContainer.clear();
		if (hadActiveStatusIndicator && this.options.tuiMode === "regular" && this.ui.getClearOnShrink()) {
			this.statusContainer.addChild(this.idleStatus);
		}
	}

	/** Turn-done marker replacing the working row after agent_end (duration + clock). */
	showTurnDoneIndicator(durationSeconds: number): void {
		// Defensive: dispose any lingering indicator (retry/compaction) so its
		// timers cannot outlive the marker replacing it.
		this.activeStatusIndicator?.dispose();
		this.activeStatusIndicator = undefined;
		this.statusContainer.clear();
		this.statusContainer.addChild(new TurnDoneIndicator(durationSeconds));
	}

	showWorkingStatusIndicator(): void {
		const indicator = new WorkingStatusIndicator(
			this.ui,
			this.workingMessage ?? this.defaultWorkingMessage,
			this.workingIndicatorOptions ??
				(this.presentation === "step" ? { intervalMs: STEP_WORKING_INDICATOR_INTERVAL_MS } : undefined),
			this.presentation,
			this.presentation === "step" ? this.workingOutputTracker : undefined,
			// The working verb follows the actually-running tool; the mood
			// rotation only fills the gaps between tools.
			this.presentation === "step" ? () => this.stepSpinner?.currentToolName() : undefined,
		);
		indicator.setStatusTip(this.currentStatusTip);
		indicator.setWaitingForApproval(this.waitingForApproval);
		this.showStatusIndicator(indicator);
	}

	private setWaitingForApproval(waiting: boolean): void {
		if (this.waitingForApproval === waiting) return;
		this.waitingForApproval = waiting;
		this.stepSpinner?.setPaused(waiting);
		if (this.activeStatusIndicator instanceof WorkingStatusIndicator) {
			this.activeStatusIndicator.setWaitingForApproval(waiting);
		}
		this.ui.requestRender();
	}

	/**
	 * Empty the footer row and return the call that puts it back.
	 *
	 * The footer keeps reporting model, cwd, and context budget, which under a
	 * dialog that owns the whole decision reads as if the session were still
	 * taking input. Restoring goes through the same path that installs a custom
	 * footer, so an extension's footer survives the round trip.
	 */
	private hideFooterRow(): () => void {
		this.footerContainer.clear();
		this.redraw.requestRender();
		let restored = false;
		return () => {
			if (restored) return;
			restored = true;
			this.footerContainer.clear();
			this.footerContainer.addChild(this.customFooter ?? this.footer);
			this.redraw.requestRender();
		};
	}

	private setWorkingVisible(visible: boolean): void {
		this.workingVisible = visible;
		if (!visible) {
			this.clearStatusIndicator("working");
			this.redraw.requestRender();
			return;
		}
		if (this.session.isStreaming && this.activeStatusIndicator?.kind !== "working") {
			this.showWorkingStatusIndicator();
		}
		this.redraw.requestRender();
	}

	private setWorkingIndicator(options?: WorkingIndicatorOptions): void {
		this.workingIndicatorOptions = options;
		if (this.activeStatusIndicator?.kind === "working") {
			this.activeStatusIndicator.setIndicator(options);
		}
		this.redraw.requestRender();
	}

	private setHiddenThinkingLabel(label?: string): void {
		this.hiddenThinkingLabel = label ?? this.defaultHiddenThinkingLabel;
		for (const child of this.chatContainer.children) {
			if (child instanceof AssistantMessageComponent) {
				child.setHiddenThinkingLabel(this.hiddenThinkingLabel);
			}
		}
		if (this.streamingComponent) {
			this.streamingComponent.setHiddenThinkingLabel(this.hiddenThinkingLabel);
		}
		this.redraw.requestRender();
	}

	/**
	 * Set an extension widget (string array or custom component).
	 */
	private setExtensionWidget(
		key: string,
		content: string[] | ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined,
		options?: ExtensionWidgetOptions,
	): void {
		const placement = options?.placement ?? "aboveEditor";
		const removeExisting = (map: Map<string, Component & { dispose?(): void }>) => {
			const existing = map.get(key);
			if (existing?.dispose) existing.dispose();
			map.delete(key);
		};

		removeExisting(this.extensionWidgetsAbove);
		removeExisting(this.extensionWidgetsBelow);

		if (content === undefined) {
			this.renderWidgets();
			return;
		}

		let component: Component & { dispose?(): void };

		if (Array.isArray(content)) {
			// Wrap string array in a Container with Text components
			const container = new Container();
			for (const line of content.slice(0, InteractiveMode.MAX_WIDGET_LINES)) {
				container.addChild(new Text(line, 1, 0));
			}
			if (content.length > InteractiveMode.MAX_WIDGET_LINES) {
				container.addChild(new Text(theme.fg("muted", "... (widget truncated)"), 1, 0));
			}
			component = container;
		} else {
			// Factory function - create component
			component = content(this.ui, theme);
		}

		const targetMap = placement === "belowEditor" ? this.extensionWidgetsBelow : this.extensionWidgetsAbove;
		targetMap.set(key, component);
		this.renderWidgets();
	}

	private clearExtensionWidgets(): void {
		for (const widget of this.extensionWidgetsAbove.values()) {
			widget.dispose?.();
		}
		for (const widget of this.extensionWidgetsBelow.values()) {
			widget.dispose?.();
		}
		this.extensionWidgetsAbove.clear();
		this.extensionWidgetsBelow.clear();
		this.renderWidgets();
	}

	/** Refocusing an editor during cleanup must not create an ownerless dialog. */
	private withExtensionDialogsBlocked(action: () => void): void {
		const wasBlocked = this.extensionDialogsBlocked;
		this.extensionDialogsBlocked = true;
		try {
			action();
		} finally {
			this.extensionDialogsBlocked = wasBlocked;
		}
	}

	private resetExtensionUI(): void {
		this.withExtensionDialogsBlocked(() => {
			this.hideExtensionSelector();
			this.hideExtensionInput();
			if (this.extensionEditor) {
				this.hideExtensionEditor();
			}
			this.ui.hideOverlay();
			this.clearExtensionTerminalInputListeners();
			this.setExtensionFooter(undefined);
			this.setExtensionHeader(undefined);
			this.clearExtensionWidgets();
			this.footerDataProvider.clearExtensionStatuses();
			this.footer.invalidate();
			this.autocompleteProviderWrappers = [];
			this.setCustomEditorComponent(undefined);
			this.setupAutocompleteProvider();
			this.defaultEditor.onExtensionShortcut = undefined;
			this.updateTerminalTitle();
			this.workingMessage = undefined;
			this.workingVisible = true;
			this.setWorkingIndicator();
			if (this.activeStatusIndicator?.kind === "working") {
				this.activeStatusIndicator.setMessage(
					`${this.defaultWorkingMessage} (${keyText("app.interrupt")} to interrupt)`,
				);
			}
			this.setHiddenThinkingLabel();
		});
	}

	// Maximum total widget lines to prevent viewport overflow
	private static readonly MAX_WIDGET_LINES = 10;

	/**
	 * Render all extension widgets to the widget container.
	 */
	private renderWidgets(): void {
		if (!this.widgetContainerAbove || !this.widgetContainerBelow) return;
		this.renderWidgetContainer(this.widgetContainerAbove, this.extensionWidgetsAbove, true, true);
		this.renderWidgetContainer(this.widgetContainerBelow, this.extensionWidgetsBelow, false, false);
		this.redraw.requestRender();
	}

	private renderWidgetContainer(
		container: Container,
		widgets: Map<string, Component & { dispose?(): void }>,
		spacerWhenEmpty: boolean,
		leadingSpacer: boolean,
	): void {
		container.clear();

		if (widgets.size === 0) {
			if (spacerWhenEmpty) {
				container.addChild(new Spacer(1));
			}
			return;
		}

		if (leadingSpacer) {
			container.addChild(new Spacer(1));
		}
		for (const component of widgets.values()) {
			container.addChild(component);
		}
	}

	/**
	 * Set a custom footer component, or restore the built-in footer.
	 */
	private setExtensionFooter(
		factory:
			| ((tui: TUI, thm: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void })
			| undefined,
	): void {
		// Dispose existing custom footer
		if (this.customFooter?.dispose) {
			this.customFooter.dispose();
		}

		this.footerContainer.clear();
		if (factory) {
			// Create and add custom footer, passing the data provider
			this.customFooter = factory(this.ui, theme, this.footerDataProvider);
			this.footerContainer.addChild(this.customFooter);
		} else {
			// Restore built-in footer
			this.customFooter = undefined;
			this.footerContainer.addChild(this.footer);
		}

		this.redraw.requestRender();
	}

	/**
	 * Set a custom header component, or restore the built-in header.
	 */
	private setExtensionHeader(factory: ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined): void {
		// Header may not be initialized yet if called during early initialization
		if (!this.builtInHeader) {
			return;
		}

		// Dispose existing custom header
		if (this.customHeader?.dispose) {
			this.customHeader.dispose();
		}

		// Find the index of the current header in the header container
		const currentHeader = this.customHeader || this.builtInHeader;
		const index = this.headerContainer.children.indexOf(currentHeader);

		if (factory) {
			// Create and add custom header
			this.customHeader = factory(this.ui, theme);
			if (isExpandable(this.customHeader)) {
				this.customHeader.setExpanded(this.toolOutputExpanded);
			}
			if (index !== -1) {
				this.headerContainer.children[index] = this.customHeader;
			} else {
				// If not found (e.g. builtInHeader was never added), add at the top
				this.headerContainer.children.unshift(this.customHeader);
			}
		} else {
			// Restore built-in header
			this.customHeader = undefined;
			if (isExpandable(this.builtInHeader)) {
				this.builtInHeader.setExpanded(this.toolOutputExpanded);
			}
			if (index !== -1) {
				this.headerContainer.children[index] = this.builtInHeader;
			}
		}

		this.redraw.requestRender();
	}

	private addExtensionTerminalInputListener(
		handler: (data: string) => { consume?: boolean; data?: string } | undefined,
	): () => void {
		const subscription = {
			handler,
			unsubscribe: this.ui.addInputListener(handler),
		};
		this.extensionTerminalInputSubscriptions.add(subscription);
		return () => {
			subscription.unsubscribe();
			this.extensionTerminalInputSubscriptions.delete(subscription);
		};
	}

	private rebindExtensionTerminalInputListeners(): void {
		for (const subscription of this.extensionTerminalInputSubscriptions) {
			subscription.unsubscribe();
			subscription.unsubscribe = this.ui.addInputListener(subscription.handler);
		}
	}

	private clearExtensionTerminalInputListeners(): void {
		for (const subscription of this.extensionTerminalInputSubscriptions) subscription.unsubscribe();
		this.extensionTerminalInputSubscriptions.clear();
	}

	/**
	 * Create the ExtensionUIContext for extensions.
	 */
	private createProjectTrustContext(cwd: string): ProjectTrustContext {
		const ui = this.createExtensionUIContext();
		return {
			cwd,
			mode: "tui",
			hasUI: true,
			ui: {
				select: ui.select,
				confirm: ui.confirm,
				input: ui.input,
				notify: ui.notify,
			},
		};
	}

	private createExtensionUIContext(): ExtensionUIContext {
		return {
			select: (title, options, opts) => this.showExtensionSelector(title, options, opts),
			confirm: createApprovalProvider(this).confirm,
			input: (title, placeholder, opts) => this.showExtensionInput(title, placeholder, opts),
			notify: (message, type, options) => this.showExtensionNotify(message, type, options),
			onTerminalInput: (handler) => this.addExtensionTerminalInputListener(handler),
			setStatus: (key, text) => this.setExtensionStatus(key, text),
			setWorkingMessage: (message) => {
				this.workingMessage = message;
				if (this.activeStatusIndicator?.kind === "working") {
					this.activeStatusIndicator.setMessage(message ?? this.defaultWorkingMessage);
				}
			},
			setWorkingVisible: (visible) => this.setWorkingVisible(visible),
			setWorkingIndicator: (options) => this.setWorkingIndicator(options),
			setHiddenThinkingLabel: (label) => this.setHiddenThinkingLabel(label),
			setWidget: (key, content, options) => this.setExtensionWidget(key, content, options),
			setFooter: (factory) => this.setExtensionFooter(factory),
			setHeader: (factory) => this.setExtensionHeader(factory),
			setTitle: (title) => this.ui.terminal.setTitle(title),
			custom: (factory, options) => this.showExtensionCustom(factory, options),
			pasteToEditor: (text) => this.editor.handleInput(`\x1b[200~${text}\x1b[201~`),
			setEditorText: (text) => this.editor.setText(text),
			getEditorText: () => this.editor.getExpandedText?.() ?? this.editor.getText(),
			editor: (title, prefill) => this.showExtensionEditor(title, prefill),
			addAutocompleteProvider: (factory) => {
				this.autocompleteProviderWrappers.push(factory);
				this.setupAutocompleteProvider();
			},
			setEditorComponent: (factory) => this.setCustomEditorComponent(factory),
			getEditorComponent: () => this.editorComponentFactory,
			get theme() {
				return theme;
			},
			getAllThemes: () => getAvailableThemesWithPaths(),
			getTheme: (name) => getThemeByName(name),
			setTheme: (themeOrName) => {
				if (themeOrName instanceof Theme) {
					return this.themeController.setThemeInstance(themeOrName);
				}
				const result = this.themeController.setThemeName(themeOrName);
				if (result.success) {
					if (this.settingsManager.getTheme() !== themeOrName) {
						this.settingsManager.setTheme(themeOrName);
					}
				}
				return result;
			},
			getToolsExpanded: () => this.toolOutputExpanded,
			setToolsExpanded: (expanded) => this.setToolsExpanded(expanded),
		};
	}

	/**
	 * Show a selector for extensions.
	 */
	private showExtensionSelector(
		title: string,
		options: string[],
		opts?: ExtensionUIDialogOptions,
		waitingForApproval = false,
	): Promise<string | undefined> {
		return new Promise((resolve, reject) => {
			if (this.extensionDialogsBlocked || opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			this.withExtensionDialogsBlocked(() => {
				this.hideExtensionSelector();
				this.hideExtensionInput();
			});
			let settled = false;
			let selector: ExtensionSelectorComponent | undefined;
			let unmount: (() => void) | undefined;
			const finish = (complete: () => void) => {
				if (settled) return;
				settled = true;
				opts?.signal?.removeEventListener("abort", onAbort);
				try {
					if (this.extensionSelector === selector) {
						this.cancelExtensionSelector = undefined;
						this.extensionSelector = undefined;
						// Release this dialog's pause before restoring focus, which can
						// synchronously open a new confirmation in a custom editor.
						if (waitingForApproval) this.setWaitingForApproval(false);
					}
					selector?.dispose();
					unmount?.();
				} catch (error) {
					reject(error);
				} finally {
					complete();
				}
			};
			const onAbort = () => finish(() => resolve(undefined));
			this.cancelExtensionSelector = onAbort;
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			try {
				selector = new ExtensionSelectorComponent(
					title,
					options,
					(option) => finish(() => resolve(option)),
					onAbort,
					{
						tui: this.ui,
						timeout: opts?.timeout,
						onToggleToolsExpanded: () => this.toggleToolOutputExpansion(),
						presentation: this.presentation,
					},
				);
				this.extensionSelector = selector;
				if (waitingForApproval) this.setWaitingForApproval(true);
				unmount = this.mountExtensionDialog(selector, opts);
				// A signal can abort inside the mount's widget/render callbacks.
				if (settled) unmount();
				else if (opts?.signal?.aborted) onAbort();
			} catch (error) {
				finish(() => reject(error));
			}
		});
	}

	/** Dismissal is cancellation, not just unmounting: callers must be released. */
	private hideExtensionSelector(): void {
		this.cancelExtensionSelector?.();
	}

	/**
	 * Show a confirmation dialog for extensions.
	 */
	async showExtensionConfirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean> {
		const result = await this.showExtensionSelector(`${title}\n${message}`, ["Yes", "No"], opts, true);
		return result === "Yes";
	}

	private async promptForMissingSessionCwd(error: MissingSessionCwdError): Promise<string | undefined> {
		const confirmed = await this.showExtensionConfirm(
			"Session cwd not found",
			formatMissingSessionCwdPrompt(error.issue),
		);
		return confirmed ? error.issue.fallbackCwd : undefined;
	}

	/**
	 * Show a text input for extensions.
	 */
	private showExtensionInput(
		title: string,
		placeholder?: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve, reject) => {
			if (this.extensionDialogsBlocked || opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			this.withExtensionDialogsBlocked(() => {
				this.hideExtensionSelector();
				this.hideExtensionInput();
			});
			let settled = false;
			let input: ExtensionInputComponent | undefined;
			let unmount: (() => void) | undefined;
			const finish = (complete: () => void) => {
				if (settled) return;
				settled = true;
				opts?.signal?.removeEventListener("abort", onAbort);
				if (this.extensionInput === input) {
					this.cancelExtensionInput = undefined;
					this.extensionInput = undefined;
				}
				try {
					input?.dispose();
					unmount?.();
					complete();
				} catch (error) {
					reject(error);
				}
			};
			const onAbort = () => finish(() => resolve(undefined));
			this.cancelExtensionInput = onAbort;
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			try {
				input = new ExtensionInputComponent(title, placeholder, (value) => finish(() => resolve(value)), onAbort, {
					tui: this.ui,
					timeout: opts?.timeout,
					presentation: this.presentation,
				});
				this.extensionInput = input;
				unmount = this.mountExtensionDialog(input, opts);
				if (settled) unmount();
				else if (opts?.signal?.aborted) onAbort();
			} catch (error) {
				finish(() => reject(error));
			}
		});
	}

	private hideExtensionInput(): void {
		this.cancelExtensionInput?.();
	}

	/**
	 * Show a transient extension dialog and return the call that takes it back down.
	 *
	 * The inline form swaps the dialog in for the editor, which is what pushes the transcript
	 * up by the dialog's extra rows and leaves a gap at the bottom once the dialog closes. The
	 * overlay form composites the dialog onto the rows the editor and the transcript already
	 * occupy, so the rendered document keeps its length and nothing moves. The bottom margin
	 * holds the overlay off the rows the dock draws under the editor, so the dialog lands on
	 * the same rows it would have taken inline and the footer stays visible.
	 * Belongs to approval/dialog-mounting when interactive-mode.ts is split
	 * (structure plan step 4).
	 */
	private mountExtensionDialog(component: Component, opts?: ExtensionUIDialogOptions): () => void {
		if (opts?.overlay) {
			const width = this.ui.terminal.columns;
			const rowsBelowEditor =
				this.widgetContainerBelow.render(width).length + this.footerContainer.render(width).length;
			const handle = this.ui.showOverlay(component, {
				anchor: "bottom-center",
				width: "100%",
				maxHeight: "100%",
				margin: { bottom: rowsBelowEditor },
			});
			return () => handle.hide();
		}

		this.disposeActiveSelector();
		this.editorContainer.clear();
		this.editorContainer.addChild(component);
		this.ui.setFocus(component);
		this.redraw.requestRender();
		return () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			this.redraw.requestRender();
		};
	}

	/**
	 * Show a multi-line editor for extensions (with Ctrl+G support).
	 */
	private showExtensionEditor(title: string, prefill?: string): Promise<string | undefined> {
		return new Promise((resolve) => {
			this.extensionEditor = new ExtensionEditorComponent(
				this.ui,
				this.keybindings,
				title,
				prefill,
				(value) => {
					this.hideExtensionEditor();
					resolve(value);
				},
				() => {
					this.hideExtensionEditor();
					resolve(undefined);
				},
				undefined,
				this.settingsManager.getExternalEditorCommand(),
				this.presentation,
			);

			this.disposeActiveSelector();
			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionEditor);
			this.ui.setFocus(this.extensionEditor);
			this.redraw.requestRender();
		});
	}

	/**
	 * Hide the extension editor.
	 */
	private hideExtensionEditor(): void {
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionEditor = undefined;
		this.ui.setFocus(this.editor);
		this.redraw.requestRender();
	}

	/**
	 * Set a custom editor component from an extension.
	 * Pass undefined to restore the default editor.
	 */
	private setCustomEditorComponent(factory: EditorFactory | undefined): void {
		this.editorComponentFactory = factory;

		// Save text from current editor before switching
		const currentText = this.editor.getText();

		this.disposeActiveSelector();
		this.editorContainer.clear();

		if (factory) {
			// Create the custom editor with tui, theme, and keybindings
			const newEditor = factory(this.ui, getEditorTheme(), this.keybindings);

			// Wire up callbacks from the default editor
			newEditor.onSubmit = this.defaultEditor.onSubmit;
			newEditor.onChange = this.defaultEditor.onChange;

			// Copy text from previous editor
			newEditor.setText(currentText);

			// Copy appearance settings if supported
			if (newEditor.borderColor !== undefined) {
				newEditor.borderColor = this.defaultEditor.borderColor;
			}
			if (newEditor.setPaddingX !== undefined) {
				newEditor.setPaddingX(this.defaultEditor.getPaddingX());
			}
			if (newEditor.setAutocompleteMaxVisible !== undefined) {
				newEditor.setAutocompleteMaxVisible(this.defaultEditor.getAutocompleteMaxVisible());
			}

			// Set autocomplete if supported
			if (newEditor.setAutocompleteProvider && this.autocompleteProvider) {
				newEditor.setAutocompleteProvider(this.autocompleteProvider);
			}

			// If extending CustomEditor, copy app-level handlers
			// Use duck typing since instanceof fails across jiti module boundaries
			const customEditor = newEditor as unknown as Record<string, unknown>;
			if ("actionHandlers" in customEditor && customEditor.actionHandlers instanceof Map) {
				if (!customEditor.onEscape) {
					customEditor.onEscape = () => this.defaultEditor.onEscape?.();
				}
				if (!customEditor.onCtrlD) {
					customEditor.onCtrlD = () => this.defaultEditor.onCtrlD?.();
				}
				if (!customEditor.onPasteImage) {
					customEditor.onPasteImage = () => this.defaultEditor.onPasteImage?.();
				}
				if (!customEditor.onEmptyPaste) {
					customEditor.onEmptyPaste = () => this.defaultEditor.onEmptyPaste?.();
				}
				if (!customEditor.onPasteImagePath) {
					customEditor.onPasteImagePath = (content: string) =>
						this.defaultEditor.onPasteImagePath?.(content) ?? false;
				}
				if (!customEditor.canDequeue) {
					customEditor.canDequeue = () => this.defaultEditor.canDequeue?.() ?? false;
				}
				if (!customEditor.onExtensionShortcut) {
					customEditor.onExtensionShortcut = (data: string) => this.defaultEditor.onExtensionShortcut?.(data);
				}
				// Copy action handlers (clear, suspend, model switching, etc.)
				for (const [action, handler] of this.defaultEditor.actionHandlers) {
					(customEditor.actionHandlers as Map<string, () => void>).set(action, handler);
				}
			}

			this.editor = newEditor;
		} else {
			// Restore default editor with text from custom editor
			this.defaultEditor.setText(currentText);
			this.editor = this.defaultEditor;
		}

		this.editorContainer.addChild(this.editor as Component);
		this.ui.setFocus(this.editor as Component);
		this.redraw.requestRender();
	}

	/**
	 * Show a notification for extensions.
	 */
	private showExtensionNotify(
		message: string,
		type?: "info" | "warning" | "error",
		options?: ExtensionNotifyOptions,
	): void {
		if (type === "error") {
			this.showError(message);
		} else if (type === "warning") {
			this.showWarning(message);
		} else if (options?.echoesInput) {
			this.showInputEcho(message);
		} else {
			this.showStatus(message);
		}
	}

	/** Show a custom component with keyboard focus. Overlay mode renders on top of existing content. */
	private async showExtensionCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			onHandle?: (handle: OverlayHandle) => void;
			hideFooter?: boolean;
			waitingForApproval?: boolean;
		},
	): Promise<T> {
		const savedText = this.editor.getText();
		const isOverlay = options?.overlay ?? false;
		// An inline dialog replaces the editor, so a dialog that blocks on a decision
		// holds the working animations the same way an approval selector does.
		const holdsApproval = !isOverlay && options?.waitingForApproval === true;
		let restoreFooter: (() => void) | undefined;

		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.editor.setText(savedText);
			this.ui.setFocus(this.editor);
			restoreFooter?.();
			restoreFooter = undefined;
			if (holdsApproval) this.setWaitingForApproval(false);
			this.redraw.requestRender();
		};

		return new Promise((resolve, reject) => {
			let component: Component & { dispose?(): void };
			let closed = false;

			const close = (result: T) => {
				if (closed) return;
				closed = true;
				if (isOverlay) this.ui.hideOverlay();
				else restoreEditor();
				// Note: both branches above already call requestRender
				resolve(result);
				try {
					component?.dispose?.();
				} catch {
					/* ignore dispose errors */
				}
			};

			Promise.resolve(factory(this.ui, theme, this.keybindings, close))
				.then((c) => {
					if (closed) return;
					component = c;
					if (isOverlay) {
						// Resolve overlay options - can be static or dynamic function
						const resolveOptions = (): OverlayOptions | undefined => {
							if (options?.overlayOptions) {
								const opts =
									typeof options.overlayOptions === "function"
										? options.overlayOptions()
										: options.overlayOptions;
								return opts;
							}
							// Fallback: use component's width property if available
							const w = (component as { width?: number }).width;
							return w ? { width: w } : undefined;
						};
						const handle = this.ui.showOverlay(component, resolveOptions());
						// Expose handle to caller for visibility control
						options?.onHandle?.(handle);
					} else {
						this.disposeActiveSelector();
						if (holdsApproval) this.setWaitingForApproval(true);
						if (options?.hideFooter) restoreFooter = this.hideFooterRow();
						this.editorContainer.clear();
						this.editorContainer.addChild(component);
						this.ui.setFocus(component);
						this.redraw.requestRender();
					}
				})
				.catch((err) => {
					if (closed) return;
					if (!isOverlay) restoreEditor();
					reject(err);
				});
		});
	}

	/**
	 * Show an extension error in the UI.
	 */
	private showExtensionError(extensionPath: string, error: string, stack?: string): void {
		const errorMsg = `Extension "${extensionPath}" error: ${error}`;
		const errorText = new Text(theme.fg("error", errorMsg), 1, 0);
		this.chatContainer.addChild(errorText);
		if (stack) {
			// Show stack trace in dim color, indented
			const stackLines = stack
				.split("\n")
				.slice(1) // Skip first line (duplicates error message)
				.map((line) => theme.fg("dim", `  ${line.trim()}`))
				.join("\n");
			if (stackLines) {
				this.chatContainer.addChild(new Text(stackLines, 1, 0));
			}
		}
		this.redraw.requestRender();
	}

	// =========================================================================
	// Key Handlers
	// =========================================================================

	private async handleRightClickPaste(): Promise<void> {
		return rightClickPaste(this);
	}

	async handleClipboardPaste(imageOnly?: boolean): Promise<void> {
		return clipboardPaste(this, { imageOnly });
	}

	addCommandInputToChat(text: string): void {
		if (this.chatContainer.children.length > 0) this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			this.createUserMessageComponent(
				text,
				this.getMarkdownThemeWithSettings(),
				this.outputPad,
				this.getMarkdownTransformers(),
			),
		);
		this.redraw.requestRender();
	}

	private subscribeToAgent(): void {
		subscribeToAgent(this);
	}

	/**
	 * Thin delegators kept on the class so the composition root's runtime wiring can also
	 * be reached through the prototype (used by the white-box interaction tests). Production
	 * wiring goes through runtime/index.ts (wireStartupInput/wireInteractiveRuntime); these
	 * forward to the same moved free functions.
	 */
	setupKeyHandlers(): void {
		wireKeyHandlers(this);
	}

	setupEditorSubmitHandler(): void {
		wireSubmitHandler(this);
	}

	handleStartupSubmit(text: string): void {
		handleStartupSubmit(this, text);
	}

	async handleEvent(event: AgentSessionEvent): Promise<void> {
		await handleSessionEvent(this, event);
	}

	/** Extract text content from a user message */
	private getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const textBlocks =
			typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content.filter((c: { type: string }) => c.type === "text");
		return textBlocks.map((c) => (c as { text: string }).text).join("");
	}

	/** Show a managed-tool status update in the chat. */
	private showManagedToolStatus(status: ToolStatus): void {
		// A missing search tool (rg/fd) is non-fatal: grep/find fall back to git and
		// POSIX utilities. Never surface download failures, offline, or unsupported-
		// platform notices as warnings — the fallback is silent and a red warning on
		// every launch is just noise the user cannot act on.
		if (status.type === "warning") return;
		if (!this.managedToolStatusStarted) {
			this.chatContainer.addChild(new Spacer(1));
			this.managedToolStatusStarted = true;
		}
		const message = status.message;
		this.chatContainer.addChild(new Text(theme.fg("dim", message), 1, 0));
		this.lastStatusSpacer = undefined;
		this.lastStatusText = undefined;
		this.redraw.requestRender();
	}

	/**
	 * Show a status message in the chat.
	 *
	 * If multiple status messages are emitted back-to-back (without anything else being added to the chat),
	 * we update the previous status line instead of appending new ones to avoid log spam.
	 */
	/**
	 * Add a transcript row that carries content the user just typed.
	 *
	 * A dim status line reads as something the agent said. This is the same
	 * background bar UserMessageComponent paints, so a confirmation that quotes
	 * the user's input is recognizable as their input at a glance.
	 */
	private showInputEcho(message: string): void {
		const box = new Box(1, 0, (content: string) => theme.bg("userMessageBg", content));
		box.addChild(new Text(theme.fg("userMessageText", message), 0, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(box);
		// Nothing may merge into this row the way consecutive statuses merge.
		this.lastStatusSpacer = undefined;
		this.lastStatusText = undefined;
		this.redraw.requestRender();
	}

	showStatus(message: string): void {
		const children = this.chatContainer.children;
		const last = children.length > 0 ? children[children.length - 1] : undefined;
		const secondLast = children.length > 1 ? children[children.length - 2] : undefined;

		if (last && secondLast && last === this.lastStatusText && secondLast === this.lastStatusSpacer) {
			this.lastStatusText.setText(theme.fg("dim", message));
			this.redraw.requestRender();
			return;
		}

		const spacer = new Spacer(1);
		const text = new Text(theme.fg("dim", message), 1, 0);
		this.chatContainer.addChild(spacer);
		this.chatContainer.addChild(text);
		this.lastStatusSpacer = spacer;
		this.lastStatusText = text;
		this.redraw.requestRender();
	}

	addCustomEntryToChat(entry: Extract<SessionEntry, { type: "custom" }>): void {
		const renderer = this.session.extensionRunner.getEntryRenderer(entry.customType);
		if (!renderer) {
			return;
		}
		const component = new CustomEntryComponent(entry, renderer);
		component.setExpanded(this.toolOutputExpanded);
		if (!component.hasContent()) {
			return;
		}

		if (this.streamingComponent) {
			const streamingIndex = this.chatContainer.children.indexOf(this.streamingComponent);
			if (streamingIndex >= 0) {
				this.chatContainer.children.splice(streamingIndex, 0, component);
				return;
			}
		}

		this.chatContainer.addChild(component);
	}

	addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void {
		// The welcome block remains pinned above the transcript, but its
		// first-session hint ends as soon as a live message is projected.
		this.stepWelcome?.setFirstMessageHint(false);
		switch (message.role) {
			case "bashExecution": {
				const component = new BashExecutionComponent(
					message.command,
					this.ui,
					message.excludeFromContext,
					this.presentation,
				);
				if (message.output) {
					component.appendOutput(message.output);
				}
				component.setComplete(
					message.exitCode,
					message.cancelled,
					message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
					message.fullOutputPath,
				);
				this.chatContainer.addChild(component);
				break;
			}
			case "custom": {
				if (message.display) {
					const renderer = this.session.extensionRunner.getMessageRenderer(message.customType);
					const component = new CustomMessageComponent(
						message,
						renderer,
						this.getMarkdownThemeWithSettings(),
						this.outputPad,
					);
					component.setExpanded(this.toolOutputExpanded);
					this.chatContainer.addChild(component);
				}
				break;
			}
			case "compactionSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new CompactionSummaryMessageComponent(message, this.getMarkdownThemeWithSettings(), {
					presentation: this.options.tuiStyle === "step" ? "step" : "native",
				});
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "branchSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new BranchSummaryMessageComponent(message, this.getMarkdownThemeWithSettings(), {
					presentation: this.options.tuiStyle === "step" ? "step" : "native",
				});
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "user": {
				const textContent = this.getUserMessageText(message);
				if (textContent) {
					if (this.chatContainer.children.length > 0) {
						this.chatContainer.addChild(new Spacer(1));
					}
					const skillBlock = parseSkillBlock(textContent);
					if (skillBlock) {
						// Render skill block (collapsible)
						const component = new SkillInvocationMessageComponent(
							skillBlock,
							this.getMarkdownThemeWithSettings(),
						);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);
						// Render user message separately if present
						if (skillBlock.userMessage) {
							this.chatContainer.addChild(new Spacer(1));
							const userComponent = this.createUserMessageComponent(
								skillBlock.userMessage,
								this.getMarkdownThemeWithSettings(),
								this.outputPad,
								this.getMarkdownTransformers(),
							);
							this.chatContainer.addChild(userComponent);
						}
					} else {
						const userComponent = this.createUserMessageComponent(
							textContent,
							this.getMarkdownThemeWithSettings(),
							this.outputPad,
							this.getMarkdownTransformers(),
						);
						this.chatContainer.addChild(userComponent);
					}
					if (options?.populateHistory) {
						this.editor.addToHistory?.(textContent);
					}
				}
				break;
			}
			case "assistant": {
				const assistantComponent = this.createAssistantMessageComponent(
					message,
					this.hideThinkingBlock,
					this.getMarkdownThemeWithSettings(),
					this.hiddenThinkingLabel,
					this.outputPad,
					this.getMarkdownTransformers(),
				);
				this.chatContainer.addChild(assistantComponent);
				break;
			}
			case "toolResult": {
				// Tool results are rendered inline with tool calls, handled separately
				break;
			}
			default: {
				const _exhaustive: never = message;
			}
		}
	}

	private renderSessionItems(
		items: readonly RenderSessionItem[],
		options: { updateFooter?: boolean; populateHistory?: boolean } = {},
	): void {
		this.pendingTools.clear();
		const renderedPendingTools = new Map<string, ToolExecutionComponent>();
		// Cache-miss notices are not persisted; re-derive them from the full entry
		// list and re-inject them after the assistant messages that paid for them.
		const cacheMisses = this.settingsManager.getShowCacheMissNotices()
			? collectCacheMisses(this.sessionManager.getEntries(), this.session.modelRuntime)
			: new Map<AssistantMessage, CacheMiss>();

		if (options.updateFooter) {
			this.footer.invalidate();
			this.updateEditorBorderColor();
		}

		for (const item of items) {
			if (isCustomSessionEntry(item)) {
				this.addCustomEntryToChat(item);
				continue;
			}
			if (isCompactionCostNotice(item)) {
				this.addCompactionCostNotice(item);
				continue;
			}

			const message = item;
			// Assistant messages need special handling for tool calls
			if (message.role === "assistant") {
				this.addMessageToChat(message);
				// Render tool call components
				for (const content of message.content) {
					if (content.type === "toolCall") {
						const component = new ToolExecutionComponent(
							content.name,
							content.id,
							content.arguments,
							{
								showImages: this.settingsManager.getShowImages(),
								imageWidthCells: this.settingsManager.getImageWidthCells(),
								presentation: this.options?.tuiStyle === "step" ? "step" : "native",
								spinner: this.stepSpinner,
							},
							this.getRegisteredToolDefinition(content.name),
							this.ui,
							this.sessionManager.getCwd(),
						);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);

						if (message.stopReason === "aborted" || message.stopReason === "error") {
							let errorMessage: string;
							if (message.stopReason === "aborted") {
								const retryAttempt = this.session.retryAttempt;
								errorMessage =
									retryAttempt > 0
										? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
										: "Operation aborted";
							} else {
								errorMessage = message.errorMessage || "Error";
							}
							component.updateResult({
								content: [{ type: "text", text: errorMessage }],
								isError: true,
							});
						} else {
							renderedPendingTools.set(content.id, component);
						}
					}
				}
				if (message.stopReason !== "aborted" && message.stopReason !== "error") {
					const miss = cacheMisses.get(message);
					if (miss) this.addCacheMissNotice(miss);
				}
			} else if (message.role === "toolResult") {
				// Match tool results to pending tool components
				const component = renderedPendingTools.get(message.toolCallId);
				if (component) {
					component.updateResult(message);
					renderedPendingTools.delete(message.toolCallId);
				}
			} else {
				// All other messages use standard rendering
				this.addMessageToChat(message, options);
			}
		}

		for (const [toolCallId, component] of renderedPendingTools) {
			this.pendingTools.set(toolCallId, component);
			this.stepSpinner?.start(toolCallId);
		}
		this.redraw.requestRender();
	}

	/**
	 * Render session entries to chat. Used for initial load and rebuild after compaction.
	 * @param entries Compaction-aware session entries to render
	 * @param options.updateFooter Update footer state
	 * @param options.populateHistory Add user messages to editor history
	 */
	renderSessionEntries(
		entries: SessionEntry[],
		options: { updateFooter?: boolean; populateHistory?: boolean } = {},
	): void {
		const items = entries.flatMap((entry): RenderSessionItem[] => {
			if (entry.type === "custom") {
				return [entry];
			}
			const messages = sessionEntryToContextMessages(entry);
			if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage && messages.length > 0) {
				return [...messages, { type: "compaction_cost", kind: entry.type, usage: entry.usage }];
			}
			return messages;
		});
		this.renderSessionItems(items, options);
	}

	/**
	 * Render billing usage for a compaction or branch summary. The notice is derived
	 * from persisted summary usage and is not stored as a separate session entry.
	 */
	addCompactionCostNotice(notice: CompactionCostNotice): void {
		if (!this.settingsManager.getShowCacheMissNotices()) return;

		const { usage } = notice;
		const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		const cost = usage.cost.total >= 0.01 ? ` (~$${usage.cost.total.toFixed(2)})` : "";
		const label = notice.kind === "compaction" ? "Compaction" : "Branch summary";
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new Text(theme.fg("warning", `${label}: ${formatTokens(tokens)} tokens billed${cost}`), 1, 0),
		);
	}

	/**
	 * Session metadata entries are persisted alongside the transcript, but they
	 * do not mean that the user has started a conversation. Use the same
	 * projection Pi uses for context so model/thinking changes, labels, and
	 * session info do not hide Step's first-message hint.
	 */
	private hasConversationMessages(entries: readonly SessionEntry[]): boolean {
		return entries.some((entry) => sessionEntryToContextMessages(entry).length > 0);
	}

	/**
	 * Show a transcript notice when a completed assistant message paid for a
	 * significant cache miss. Only states observable facts: the miss itself,
	 * a model switch, or an idle gap past the cache TTL.
	 */
	maybeShowCacheMissNotice(message: AssistantMessage): void {
		if (!this.settingsManager.getShowCacheMissNotices()) return;

		// Entries don't contain `message` yet: message_end fires before persistence.
		const miss = detectCacheMiss(this.sessionManager.getEntries(), message, this.session.modelRuntime);
		if (miss) this.addCacheMissNotice(miss);
	}

	private addCacheMissNotice(miss: CacheMiss): void {
		if (miss.missedTokens < 20_000 && miss.missedCost < 0.1) return;

		const cost = miss.missedCost >= 0.01 ? ` (~$${miss.missedCost.toFixed(2)})` : "";
		const reBilled = `${formatTokens(miss.missedTokens)} tokens re-billed${cost}`;
		let label = "Cache miss";
		if (miss.modelChanged) {
			label = "Cache miss after model switch";
		} else if (miss.idleMs >= CACHE_TTL_MS) {
			label = `Cache miss after ${Math.round(miss.idleMs / 60_000)}m idle`;
		}
		const text = theme.fg("warning", `${label}: ${reBilled}`);
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(text, 1, 0));
	}

	renderInitialMessages(): void {
		const entries = this.sessionManager.buildContextEntries();
		this.stepWelcome?.setFirstMessageHint(!this.hasConversationMessages(entries));
		this.renderSessionEntries(entries, {
			updateFooter: true,
			populateHistory: true,
		});
		this.renderProjectTrustWarningIfNeeded();

		// Show compaction info if session was compacted
		const allEntries = this.sessionManager.getEntries();
		const compactionCount = allEntries.filter((e) => e.type === "compaction").length;
		if (compactionCount > 0) {
			const times = compactionCount === 1 ? "1 time" : `${compactionCount} times`;
			this.showStatus(`Session compacted ${times}`);
		}
	}

	private renderProjectTrustWarningIfNeeded(): void {
		if (
			this.settingsManager.isProjectTrusted() ||
			!hasTrustRequiringProjectResources(this.sessionManager.getCwd(), this.configDirName)
		) {
			return;
		}

		if (this.chatContainer.children.length > 0) {
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(
			new Text(
				theme.fg(
					"warning",
					`This project is not trusted. Project ${this.configDirName} resources and packages are ignored. Use /trust to save a trust decision, then restart ${APP_NAME}.`,
				),
				1,
				0,
			),
		);
	}

	/** Latest goal status for the tip pool (RuntimeContext member). */
	readGoalTipState(): "active" | "paused" | "none" {
		const entries = this.sessionManager.getBranch();
		for (let i = entries.length - 1; i >= 0; i -= 1) {
			const entry = entries[i];
			if (entry.type !== "custom" || entry.customType !== "step-goal") continue;
			const data = entry.data as { status?: string; cleared?: boolean } | undefined;
			if (data?.cleared === true) return "none";
			return data?.status === "active" || data?.status === "paused" ? data.status : "none";
		}
		return "none";
	}

	async getUserInput(): Promise<string> {
		const queuedInput = this.pendingUserInputs.shift();
		if (queuedInput !== undefined) {
			return queuedInput;
		}

		return new Promise((resolve) => {
			this.onInputCallback = (text: string) => {
				this.onInputCallback = undefined;
				resolve(text);
			};
		});
	}

	private rebuildChatFromMessages(): void {
		this.chatContainer.clear();
		const entries = this.sessionManager.buildContextEntries();
		this.stepWelcome?.setFirstMessageHint(!this.hasConversationMessages(entries));
		this.renderSessionEntries(entries);
	}

	// =========================================================================
	// Key handlers
	// =========================================================================

	handleCtrlC(): void {
		handleCtrlC(this);
	}

	handleCtrlD(): void {
		handleCtrlD(this);
	}

	/**
	 * Gracefully shutdown the agent.
	 * Stops the TUI before emitting shutdown events so extension UI cleanup cannot
	 * repaint the final frame while the process is exiting.
	 */
	private isShuttingDown = false;

	async shutdown(options?: { fromSignal?: boolean }): Promise<void> {
		if (this.isShuttingDown) return;
		this.isShuttingDown = true;

		// Turn off focus reporting we enabled for the clipboard-image hint, so the
		// terminal does not keep sending \x1b[I / \x1b[O to the parent shell.
		// Keep signal handlers registered until terminal cleanup has completed.
		// `signal-exit` checks the listener list during the same SIGTERM/SIGHUP
		// dispatch and re-sends the signal if only its own listeners remain.

		if (options?.fromSignal) {
			// Signal-triggered shutdown (SIGTERM/SIGHUP). Emit extension cleanup
			// (session_shutdown) BEFORE touching the terminal. Extension teardown
			// such as removing sockets does not write to the tty, so it must not be
			// skipped if a later terminal-restore write fails on a dead or stalled
			// terminal. If the terminal is gone, the restore writes below emit EIO,
			// which the stdout/stderr error handler turns into emergencyTerminalExit;
			// the render loop is already idle, so this cannot hot-spin (see #4144).
			await this.runtimeHost.dispose();
			this.themeController.disableAutoSync();
			await this.ui.terminal.drainInput(1000);
			this.stepWelcome?.dispose();
			this.stepSpinner?.dispose();
			this.stop();
			process.exit(0);
		}

		// Interactive quit (Ctrl+D, Ctrl+C, /quit, extension shutdown()). Stop the
		// TUI before emitting shutdown events so extension UI cleanup cannot repaint
		// the final frame while the process is exiting.
		// Drain any in-flight Kitty key release events before stopping.
		// This prevents escape sequences from leaking to the parent shell over slow SSH.
		this.themeController.disableAutoSync();
		await this.ui.terminal.drainInput(1000);

		this.stepWelcome?.dispose();
		this.stepSpinner?.dispose();
		this.stop();
		await this.runtimeHost.dispose();

		const resumeCommand = formatResumeCommand(this.sessionManager);
		if (resumeCommand) {
			process.stdout.write(`${chalk.dim("To resume this session:")} ${resumeCommand}\n`);
		}

		process.exit(0);
	}

	private emergencyTerminalExit(): never {
		this.isShuttingDown = true;
		this.unregisterSignalHandlers();
		killTrackedDetachedChildren();
		// The terminal is gone. Do not run normal shutdown because TUI and
		// extension cleanup can write restore sequences and re-trigger EIO.
		process.exit(129);
	}

	/**
	 * Last-resort handler for uncaught exceptions. The TUI puts stdin into raw
	 * mode and hides the cursor; without this handler, an uncaught throw from
	 * anywhere (e.g. an extension's async `ChildProcess.on("exit")` callback)
	 * tears down the process while leaving the terminal in raw mode with no
	 * cursor, requiring `stty sane && reset` to recover.
	 *
	 * Unlike emergencyTerminalExit, the terminal is still alive here, so we
	 * call ui.stop() to restore cooked mode, the cursor, and disable bracketed
	 * paste / Kitty / modifyOtherKeys sequences.
	 */
	private uncaughtCrash(error: Error): never {
		if (this.isShuttingDown) {
			process.exit(1);
		}
		this.isShuttingDown = true;
		try {
			this.unregisterSignalHandlers();
		} catch {}
		try {
			killTrackedDetachedChildren();
		} catch {}
		try {
			// isShuttingDown is set above, so shutdown()'s teardown never runs here;
			// restore focus reporting ourselves or the escapes leak to the shell.
		} catch {}
		try {
			this.ui.stop();
		} catch {}
		console.error(`${APP_NAME} exiting due to uncaughtException:`);
		console.error(error);
		process.exit(1);
	}

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 */
	async checkShutdownRequested(): Promise<void> {
		if (!this.shutdownRequested) return;
		await this.shutdown();
	}

	private registerSignalHandlers(): void {
		this.unregisterSignalHandlers();

		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				// SIGHUP no longer hard-exits: graceful shutdown emits session_shutdown
				// first, then attempts terminal restore. A genuinely dead terminal
				// surfaces as an EIO on the restore writes, which the stdout/stderr
				// error handler converts into emergencyTerminalExit (see #4144, #5080).
				killTrackedDetachedChildren();
				void this.shutdown({ fromSignal: true });
			};
			process.prependListener(signal, handler);
			this.signalCleanupHandlers.push(() => process.off(signal, handler));
		}

		const terminalErrorHandler = (error: Error) => {
			if (isDeadTerminalError(error)) {
				this.emergencyTerminalExit();
			}
			throw error;
		};
		process.stdout.on("error", terminalErrorHandler);
		process.stderr.on("error", terminalErrorHandler);
		this.signalCleanupHandlers.push(() => process.stdout.off("error", terminalErrorHandler));
		this.signalCleanupHandlers.push(() => process.stderr.off("error", terminalErrorHandler));

		// Restore the terminal before the process dies on any uncaught throw.
		// Without this, an unhandled exception from extension code (or anywhere
		// in pi) leaves the terminal in raw mode with no cursor.
		const uncaughtExceptionHandler = (error: Error) => this.uncaughtCrash(error);
		process.prependListener("uncaughtException", uncaughtExceptionHandler);
		this.signalCleanupHandlers.push(() => process.off("uncaughtException", uncaughtExceptionHandler));
	}

	private unregisterSignalHandlers(): void {
		for (const cleanup of this.signalCleanupHandlers) {
			cleanup();
		}
		this.signalCleanupHandlers = [];
	}

	handleCtrlZ(): void {
		if (process.platform === "win32") {
			this.showStatus("Suspend to background is not supported on Windows");
			return;
		}

		// Keep the event loop alive while suspended. Without this, stopping the TUI
		// can leave Node with no ref'ed handles, causing the process to exit on fg
		// before the SIGCONT handler gets a chance to restore the terminal.
		const suspendKeepAlive = setInterval(() => {}, 2 ** 30);

		// Ignore SIGINT while suspended so Ctrl+C in the terminal does not
		// kill the backgrounded process. The handler is removed on resume.
		const ignoreSigint = () => {};
		process.on("SIGINT", ignoreSigint);

		// Set up handler to restore TUI when resumed
		process.once("SIGCONT", () => {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			this.ui.start();
			this.redraw.forceRender();
		});

		try {
			if (this.defaultEditor instanceof StepEditor) this.defaultEditor.dispose();
			this.ui.stop();

			// Send SIGTSTP to process group (pid=0 means all processes in group)
			process.kill(0, "SIGTSTP");
		} catch (error) {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			throw error;
		}
	}

	async handleFollowUp(): Promise<void> {
		const text = (this.editor.getExpandedText?.() ?? this.editor.getText()).trim();
		if (!text) return;

		// Queue input during compaction (extension commands execute immediately)
		if (this.session.isCompacting) {
			if (this.isExtensionCommand(text)) {
				this.editor.addToHistory?.(text);
				this.editor.setText("");
				await this.session.prompt(text);
			} else {
				const { text: message, images } = await resolvePastedImages(this.pastedImages, text, {
					autoResizeImages: this.settingsManager.getImageAutoResize(),
				});
				this.queueCompactionMessage(message, "followUp", images.length ? images : undefined);
			}
			return;
		}

		// Alt+Enter queues a follow-up message (waits until agent finishes)
		// This handles extension commands (execute immediately), prompt template expansion, and queueing
		if (this.session.isStreaming) {
			this.editor.addToHistory?.(text);
			this.editor.setText("");
			const { text: message, images } = await resolvePastedImages(this.pastedImages, text, {
				autoResizeImages: this.settingsManager.getImageAutoResize(),
			});
			await this.session.prompt(message, {
				streamingBehavior: "followUp",
				images: images.length ? images : undefined,
			});
			this.updatePendingMessagesDisplay();
			this.redraw.requestRender();
		}
		// If not streaming, Alt+Enter acts like regular Enter (trigger onSubmit)
		else if (this.editor.onSubmit) {
			this.editor.setText("");
			this.editor.onSubmit(text);
		}
	}

	handleDequeue(): void {
		const restored = this.restoreQueuedMessagesToEditor();
		if (restored === 0) {
			this.showStatus("No queued messages to restore");
		} else {
			this.showStatus(`Restored ${restored} queued message${restored > 1 ? "s" : ""} to editor`);
		}
	}

	updateEditorBorderColor(): void {
		// The footer's permission segment tracks bash mode regardless of style.
		// Guarded: partial setups (tests) may call this before the footer exists.
		this.footer?.setBashMode(this.isBashMode);
		if (this.options.tuiStyle === "step" && this.editor === this.defaultEditor) {
			// Step's composer keeps a fixed brand frame for thinking/model state,
			// but bash mode is visible before submitting: `!` switches the frame
			// to the error tone and `!!` (excluded from context) dims it.
			const colorKey = this.isBashExcluded ? "dim" : this.isBashMode ? "error" : undefined;
			this.editor.borderColor = colorKey ? (str: string) => theme.fg(colorKey, str) : paintStepWordmarkBorder;
			this.redraw.requestRender();
			return;
		}
		if (this.isBashMode) {
			this.editor.borderColor = theme.getBashModeBorderColor();
		} else {
			const level = this.session.thinkingLevel || "off";
			this.editor.borderColor = theme.getThinkingBorderColor(level);
		}
		this.redraw.requestRender();
	}

	cycleThinkingLevel(): void {
		const newLevel = this.session.cycleThinkingLevel();
		if (newLevel === undefined) {
			this.showStatus("Current model does not support thinking");
		} else {
			this.footer.invalidate();
			this.updateEditorBorderColor();
			this.showStatus(`Thinking level: ${newLevel}`);
		}
	}

	async cycleModel(direction: "forward" | "backward"): Promise<void> {
		try {
			const result = await this.session.cycleModel(direction);
			if (result === undefined) {
				const msg = this.session.scopedModels.length > 0 ? "Only one model in scope" : "Only one model available";
				this.showStatus(msg);
			} else {
				this.footer.invalidate();
				this.updateEditorBorderColor();
				const thinkingStr =
					result.model.reasoning && result.thinkingLevel !== "off" ? ` (thinking: ${result.thinkingLevel})` : "";
				this.showStatus(`Switched to ${result.model.name || result.model.id}${thinkingStr}`);
				void this.maybeWarnAboutAnthropicSubscriptionAuth(result.model);
			}
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	toggleToolOutputExpansion(): void {
		this.setToolsExpanded(!this.toolOutputExpanded);
	}

	private setToolsExpanded(expanded: boolean): void {
		if (expanded === this.toolOutputExpanded) return;

		this.toolOutputExpanded = expanded;
		const activeHeader = this.customHeader ?? this.builtInHeader;
		if (isExpandable(activeHeader)) {
			activeHeader.setExpanded(expanded);
		}
		for (const container of [this.loadedResourcesContainer, this.chatContainer]) {
			for (const child of container.children) {
				if (isExpandable(child)) {
					child.setExpanded(expanded);
				}
			}
		}
		for (const widget of [...this.extensionWidgetsAbove.values(), ...this.extensionWidgetsBelow.values()]) {
			if (isExpandable(widget)) {
				widget.setExpanded(expanded);
			}
		}
		this.showStatus(`Tool output: ${expanded ? "expanded" : "collapsed"}`);
	}

	/** Update rendered assistant messages without rebuilding live tool components. */
	private updateThinkingBlockVisibility(): void {
		for (const child of this.chatContainer.children) {
			if (child instanceof AssistantMessageComponent) {
				child.setHideThinkingBlock(this.hideThinkingBlock);
			}
		}
		this.redraw.requestRender();
	}

	toggleThinkingBlockVisibility(): void {
		this.hideThinkingBlock = !this.hideThinkingBlock;
		this.settingsManager.setHideThinkingBlock(this.hideThinkingBlock);
		this.updateThinkingBlockVisibility();
		this.showStatus(`Thinking blocks: ${this.hideThinkingBlock ? "hidden" : "visible"}`);
	}

	async handleOpenExternalEditor(): Promise<void> {
		const editorCmd = this.settingsManager.getExternalEditorCommand();
		const content = this.editor.getExpandedText?.() ?? this.editor.getText();
		if (this.defaultEditor instanceof StepEditor) this.defaultEditor.dispose();
		this.ui.stop();
		try {
			const result = await editInExternalEditor({
				command: editorCmd,
				content,
			});
			if (result.status === "complete") {
				this.editor.setText(result.content);
			}
		} finally {
			this.ui.start();
			this.redraw.forceRender();
		}
	}

	// =========================================================================
	// UI helpers
	// =========================================================================

	clearEditor(): void {
		this.editor.setText("");
		this.redraw.requestRender();
	}

	showError(errorMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("error", `Error: ${errorMessage}`), this.outputPad, 0));
		this.redraw.requestRender();
	}

	showWarning(warningMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("warning", `Warning: ${warningMessage}`), 1, 0));
		this.redraw.requestRender();
	}

	/**
	 * A thing that succeeded and is worth a line in the transcript.
	 *
	 * Distinct from `showWarning` on purpose: routing a successful result through
	 * the yellow "Warning:" channel tells the user something went wrong when
	 * nothing did. Continuation lines are indented under the check so a
	 * multi-line summary reads as one block.
	 */
	showNotice(message: string): void {
		const [first = "", ...rest] = message.split("\n");
		const body = [`${theme.fg("success", "✓")} ${first}`, ...rest.map((line) => `  ${line}`)].join("\n");
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(body, 1, 0));
		this.redraw.requestRender();
	}

	showPackageUpdateNotification(packages: string[]): void {
		const action = theme.fg("accent", `${APP_NAME} update --extensions`);
		const updateInstruction = theme.fg("muted", "Package updates are available. Run ") + action;
		const packageLines = packages.map((pkg) => `- ${pkg}`).join("\n");

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.chatContainer.addChild(
			new Text(
				`${theme.bold(theme.fg("warning", "Package Updates Available"))}\n${updateInstruction}\n${theme.fg("muted", "Packages:")}\n${packageLines}`,
				1,
				0,
			),
		);
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.redraw.requestRender();
	}

	/**
	 * Get all queued messages (read-only).
	 * Combines session queue and compaction queue.
	 */
	getAllQueuedMessages(): { steering: string[]; followUp: string[] } {
		return {
			steering: [
				...this.session.getSteeringMessages(),
				...this.compactionQueuedMessages.filter((msg) => msg.mode === "steer").map((msg) => msg.text),
			],
			followUp: [
				...this.session.getFollowUpMessages(),
				...this.compactionQueuedMessages.filter((msg) => msg.mode === "followUp").map((msg) => msg.text),
			],
		};
	}

	/**
	 * Clear all queued messages and return their contents.
	 * Clears both session queue and compaction queue.
	 */
	private clearAllQueues(): { steering: string[]; followUp: string[] } {
		const { steering, followUp } = this.session.clearQueue();
		const compactionSteering = this.compactionQueuedMessages
			.filter((msg) => msg.mode === "steer")
			.map((msg) => msg.text);
		const compactionFollowUp = this.compactionQueuedMessages
			.filter((msg) => msg.mode === "followUp")
			.map((msg) => msg.text);
		this.compactionQueuedMessages = [];
		return {
			steering: [...steering, ...compactionSteering],
			followUp: [...followUp, ...compactionFollowUp],
		};
	}

	updatePendingMessagesDisplay(): void {
		this.pendingMessagesContainer.clear();
		const { steering: steeringMessages, followUp: followUpMessages } = this.getAllQueuedMessages();
		if (this.options.tuiStyle === "step") {
			this.stepQueuedMessages?.setMessages({
				steering: steeringMessages,
				followUp: followUpMessages,
			});
			if (this.stepQueuedMessages) this.pendingMessagesContainer.addChild(this.stepQueuedMessages);
			return;
		}
		if (steeringMessages.length > 0 || followUpMessages.length > 0) {
			this.pendingMessagesContainer.addChild(new Spacer(1));
			for (const message of steeringMessages) {
				const text = theme.fg("dim", `Steering: ${message}`);
				this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			for (const message of followUpMessages) {
				const text = theme.fg("dim", `Follow-up: ${message}`);
				this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			const dequeueHint = this.getAppKeyDisplay("app.message.dequeue");
			const hintText = theme.fg("dim", `↳ ${dequeueHint} to edit all queued messages`);
			this.pendingMessagesContainer.addChild(new TruncatedText(hintText, 1, 0));
		}
	}

	restoreQueuedMessagesToEditor(options?: { abort?: boolean; currentText?: string }): number {
		const { steering, followUp } = this.clearAllQueues();
		const allQueued = [...steering, ...followUp];
		if (allQueued.length === 0) {
			this.updatePendingMessagesDisplay();
			if (options?.abort) {
				this.agent.abort();
			}
			return 0;
		}
		const queuedText = allQueued.join("\n");
		const currentText = options?.currentText ?? this.editor.getExpandedText?.() ?? this.editor.getText();
		const combinedText = [queuedText, currentText].filter((t) => t.trim()).join("\n");
		this.editor.setText(combinedText);
		this.updatePendingMessagesDisplay();
		if (options?.abort) {
			this.agent.abort();
		}
		return allQueued.length;
	}

	queueCompactionMessage(text: string, mode: "steer" | "followUp", images?: ImageContent[]): void {
		this.compactionQueuedMessages.push({ text, mode, images });
		this.editor.addToHistory?.(text);
		this.editor.setText("");
		this.updatePendingMessagesDisplay();
		this.showStatus("Queued message for after compaction");
	}

	/**
	 * Return the command name when `text` looks like a slash command that is not
	 * registered anywhere, otherwise undefined.
	 *
	 * Only single-line, command-shaped input qualifies, so a pasted absolute path
	 * such as `/tmp/report.md`, or a multi-line message that happens to start with
	 * `/`, is still submitted as an ordinary prompt. An empty command set means
	 * the autocomplete provider has not been built yet; stay out of the way rather
	 * than reject every command.
	 */
	getUnknownSlashCommandName(text: string): string | undefined {
		if (!text.startsWith("/") || /[\n\r]/u.test(text)) return undefined;
		if (this.knownSlashCommandNames.size === 0) return undefined;
		const name = text.slice(1).split(" ")[0];
		if (!name || !/^[A-Za-z0-9][\w.:-]*$/u.test(name)) return undefined;
		if (this.knownSlashCommandNames.has(name)) return undefined;
		if (this.session.extensionRunner.getCommand(name)) return undefined;
		return name;
	}

	isExtensionCommand(text: string): boolean {
		return isExtensionCommand(this.session.extensionRunner, text);
	}

	async flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		if (this.compactionQueuedMessages.length === 0) {
			return;
		}

		const queuedMessages = [...this.compactionQueuedMessages];
		this.compactionQueuedMessages = [];
		this.updatePendingMessagesDisplay();

		const restoreQueue = (error: unknown) => {
			this.session.clearQueue();
			this.compactionQueuedMessages = queuedMessages;
			this.updatePendingMessagesDisplay();
			this.showError(
				`Failed to send queued message${queuedMessages.length > 1 ? "s" : ""}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		};

		try {
			if (options?.willRetry) {
				// When retry is pending, queue messages for the retry turn
				for (const message of queuedMessages) {
					if (this.isExtensionCommand(message.text)) {
						await this.session.prompt(message.text);
					} else if (message.mode === "followUp") {
						await this.session.followUp(message.text, message.images);
					} else {
						await this.session.steer(message.text, message.images);
					}
				}
				this.updatePendingMessagesDisplay();
				return;
			}

			// Find first non-extension-command message to use as prompt
			const firstPromptIndex = queuedMessages.findIndex((message) => !this.isExtensionCommand(message.text));
			if (firstPromptIndex === -1) {
				// All extension commands - execute them all
				for (const message of queuedMessages) {
					await this.session.prompt(message.text);
				}
				return;
			}

			// Execute any extension commands before the first prompt
			const preCommands = queuedMessages.slice(0, firstPromptIndex);
			const firstPrompt = queuedMessages[firstPromptIndex];
			const rest = queuedMessages.slice(firstPromptIndex + 1);

			for (const message of preCommands) {
				await this.session.prompt(message.text);
			}

			// Start a prompt when idle, or queue it into a run still finishing compaction.
			const promptPromise = this.session
				.prompt(firstPrompt.text, {
					streamingBehavior: firstPrompt.mode,
					images: firstPrompt.images?.length ? firstPrompt.images : undefined,
				})
				.catch((error) => {
					restoreQueue(error);
				});

			// Queue remaining messages
			for (const message of rest) {
				if (this.isExtensionCommand(message.text)) {
					await this.session.prompt(message.text);
				} else if (message.mode === "followUp") {
					await this.session.followUp(message.text, message.images);
				} else {
					await this.session.steer(message.text, message.images);
				}
			}
			this.updatePendingMessagesDisplay();
			void promptPromise;
		} catch (error) {
			restoreQueue(error);
		}
	}

	/** Move pending bash components from pending area to chat */
	flushPendingBashComponents(): void {
		for (const component of this.pendingBashComponents) {
			this.pendingMessagesContainer.removeChild(component);
			this.chatContainer.addChild(component);
		}
		this.pendingBashComponents = [];
	}

	// =========================================================================
	// Selectors
	// =========================================================================

	private disposeActiveSelector(): void {
		const dispose = this.activeSelectorDispose;
		this.activeSelectorToken = undefined;
		this.activeSelectorDispose = undefined;
		dispose?.();
	}

	/**
	 * Shows a selector component in place of the editor.
	 * @param create Factory that receives a `done` callback and returns the component and focus target
	 */
	private showSelector(
		create: (done: () => void) => {
			component: Component;
			focus: Component;
			dispose?: () => void;
		},
	): void {
		const token = {};
		let dispose: (() => void) | undefined;
		const done = () => {
			dispose?.();
			if (this.activeSelectorToken !== token) return;
			this.activeSelectorToken = undefined;
			this.activeSelectorDispose = undefined;
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
		};
		const created = create(done);
		dispose = created.dispose;
		this.disposeActiveSelector();
		this.activeSelectorToken = token;
		this.activeSelectorDispose = dispose;
		this.editorContainer.clear();
		// Keep the selector itself as the focus target so Pi's native input and
		// selection state machine receives every key. The frame only transforms
		// rendered rows for the Step presentation and is intentionally absent in
		// native mode.
		const mountedComponent =
			this.presentation === "step" ? new StepSelectorFrame(created.component) : created.component;
		this.editorContainer.addChild(mountedComponent);
		this.ui.setFocus(created.focus);
		this.redraw.requestRender();
	}

	showSettingsSelector(): void {
		this.showSelector((done) => {
			let selector: SettingsSelectorComponent | undefined;
			const defaultProvider = this.settingsManager.getDefaultProvider();
			const defaultModelId = this.settingsManager.getDefaultModel();
			const defaultModel = defaultProvider && defaultModelId ? `${defaultProvider}/${defaultModelId}` : "not set";
			selector = new SettingsSelectorComponent(
				{
					autoCompact: this.session.autoCompactionEnabled,
					defaultModel,
					currentModel: this.session.model,
					availableDefaultModels: this.session.modelRuntime.getAvailableSnapshot(),
					showImages: this.settingsManager.getShowImages(),
					imageWidthCells: this.settingsManager.getImageWidthCells(),
					autoResizeImages: this.settingsManager.getImageAutoResize(),
					blockImages: this.settingsManager.getBlockImages(),
					enableSkillCommands: this.settingsManager.getEnableSkillCommands(),
					steeringMode: this.session.steeringMode,
					followUpMode: this.session.followUpMode,
					transport: this.settingsManager.getTransport(),
					httpIdleTimeoutMs: this.settingsManager.getHttpIdleTimeoutMs(),
					thinkingLevel: this.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL,
					availableThinkingLevels: [...THINKING_LEVEL_OPTIONS],
					modelThinkingLevels: this.settingsManager.getAllModelThinkingLevels(),
					currentTheme: this.themeController.getThemeSelection() || "dark",
					terminalTheme: this.themeController.getTerminalTheme(),
					availableThemes: getAvailableThemes(),
					hideThinkingBlock: this.hideThinkingBlock,
					mermaidRenderingMode: this.settingsManager.getMermaidRenderingMode(),
					collapseChangelog: this.settingsManager.getCollapseChangelog(),
					doubleEscapeAction: this.settingsManager.getDoubleEscapeAction(),
					treeFilterMode: this.settingsManager.getTreeFilterMode(),
					showHardwareCursor: this.settingsManager.getShowHardwareCursor(),
					showCacheMissNotices: this.settingsManager.getShowCacheMissNotices(),
					defaultProjectTrust: this.settingsManager.getDefaultProjectTrust(),
					editorPaddingX: this.settingsManager.getEditorPaddingX(),
					outputPad: this.settingsManager.getOutputPad(),
					autocompleteMaxVisible: this.settingsManager.getAutocompleteMaxVisible(),
					quietStartup: this.settingsManager.getQuietStartup(),
					clearOnShrink: this.settingsManager.getClearOnShrink(),
					showTerminalProgress: this.settingsManager.getShowTerminalProgress(),
					statusTips: this.settingsManager.getStatusTips(),
					tuiMode: this.ui.mode,
					fullscreenExitOutput: this.settingsManager.getFullscreenExitOutput(),
					fullscreenScrollbar: this.settingsManager.getFullscreenScrollbar(),
					fullscreenCopyOnSelect: this.settingsManager.getFullscreenCopyOnSelect(),
				},
				{
					onAutoCompactChange: (enabled) => {
						this.session.setAutoCompactionEnabled(enabled);
						this.footer.setAutoCompactEnabled(enabled);
					},
					onShowImagesChange: (enabled) => {
						this.settingsManager.setShowImages(enabled);
						for (const child of this.chatContainer.children) {
							if (child instanceof ToolExecutionComponent) {
								child.setShowImages(enabled);
							}
						}
					},
					onImageWidthCellsChange: (width) => {
						this.settingsManager.setImageWidthCells(width);
						for (const child of this.chatContainer.children) {
							if (child instanceof ToolExecutionComponent) {
								child.setImageWidthCells(width);
							}
						}
					},
					onAutoResizeImagesChange: (enabled) => {
						this.settingsManager.setImageAutoResize(enabled);
					},
					onBlockImagesChange: (blocked) => {
						this.settingsManager.setBlockImages(blocked);
					},
					onEnableSkillCommandsChange: (enabled) => {
						this.settingsManager.setEnableSkillCommands(enabled);
						this.setupAutocompleteProvider();
					},
					onSteeringModeChange: (mode) => {
						this.session.setSteeringMode(mode);
					},
					onFollowUpModeChange: (mode) => {
						this.session.setFollowUpMode(mode);
					},
					onTransportChange: (transport) => {
						this.settingsManager.setTransport(transport);
						this.session.agent.transport = transport;
					},
					onHttpIdleTimeoutMsChange: (timeoutMs) => {
						this.settingsManager.setHttpIdleTimeoutMs(timeoutMs);
						configureHttpDispatcher(timeoutMs);
						this.showStatus(`HTTP idle timeout: ${formatHttpIdleTimeoutMs(timeoutMs)}`);
					},
					onModelThinkingLevelChange: (provider, modelId, level) => {
						this.settingsManager.setModelThinkingLevel(provider, modelId, level);
						// If the override is for the current model, apply it to the session too
						const current = this.session.model;
						if (current && current.provider === provider && current.id === modelId) {
							this.session.setThinkingLevel(level);
							this.footer.invalidate();
							this.updateEditorBorderColor();
						}
					},
					onModelThinkingLevelRemove: (provider, modelId) => {
						this.settingsManager.removeModelThinkingLevel(provider, modelId);
						// If the override was for the current model, revert to global default
						const current = this.session.model;
						if (current && current.provider === provider && current.id === modelId) {
							const globalDefault = this.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
							this.session.setThinkingLevel(globalDefault);
							this.footer.invalidate();
							this.updateEditorBorderColor();
						}
					},
					onThemeChange: (themeSetting) => {
						this.settingsManager.setTheme(themeSetting);
						void this.themeController.setThemeSetting(themeSetting);
					},
					onThemePreview: (themeName) => this.themeController.preview(themeName),
					onHideThinkingBlockChange: (hidden) => {
						this.hideThinkingBlock = hidden;
						this.settingsManager.setHideThinkingBlock(hidden);
						this.updateThinkingBlockVisibility();
					},
					onMermaidRenderingModeChange: (mode) => {
						this.settingsManager.setMermaidRenderingMode(mode);
						this.chatContainer.invalidate();
						this.redraw.requestRender();
					},
					onShowCacheMissNoticesChange: (shown) => {
						this.settingsManager.setShowCacheMissNotices(shown);
						this.rebuildChatFromMessages();
					},
					onCollapseChangelogChange: (collapsed) => {
						this.settingsManager.setCollapseChangelog(collapsed);
					},
					onQuietStartupChange: (enabled) => {
						this.settingsManager.setQuietStartup(enabled);
					},
					onDefaultProjectTrustChange: (defaultProjectTrust) => {
						this.settingsManager.setDefaultProjectTrust(defaultProjectTrust);
					},
					onDoubleEscapeActionChange: (action) => {
						this.settingsManager.setDoubleEscapeAction(action);
					},
					onTreeFilterModeChange: (mode) => {
						this.settingsManager.setTreeFilterMode(mode);
					},
					onShowHardwareCursorChange: (enabled) => {
						this.settingsManager.setShowHardwareCursor(enabled);
						this.ui.setShowHardwareCursor(enabled);
					},
					onEditorPaddingXChange: (padding) => {
						this.settingsManager.setEditorPaddingX(padding);
						this.defaultEditor.setPaddingX(padding);
						if (this.editor !== this.defaultEditor && this.editor.setPaddingX !== undefined) {
							this.editor.setPaddingX(padding);
						}
					},
					onOutputPadChange: (padding) => {
						this.settingsManager.setOutputPad(padding);
						this.outputPad = padding;
						if (this.streamingComponent || this.session.isStreaming) {
							for (const child of this.chatContainer.children) {
								if (
									child instanceof AssistantMessageComponent ||
									child instanceof CustomMessageComponent ||
									child instanceof UserMessageComponent
								) {
									child.setOutputPad(padding);
								}
							}
							if (this.streamingComponent) {
								this.streamingComponent.setOutputPad(padding);
							}
							this.redraw.requestRender();
							return;
						}
						this.rebuildChatFromMessages();
					},
					onAutocompleteMaxVisibleChange: (maxVisible) => {
						this.settingsManager.setAutocompleteMaxVisible(maxVisible);
						this.defaultEditor.setAutocompleteMaxVisible(maxVisible);
						if (this.editor !== this.defaultEditor && this.editor.setAutocompleteMaxVisible !== undefined) {
							this.editor.setAutocompleteMaxVisible(maxVisible);
						}
					},
					onClearOnShrinkChange: (enabled) => {
						this.settingsManager.setClearOnShrink(enabled);
						this.ui.setClearOnShrink(enabled);
						if (!enabled && !this.activeStatusIndicator) {
							this.statusContainer.clear();
						}
					},
					onShowTerminalProgressChange: (enabled) => {
						this.settingsManager.setShowTerminalProgress(enabled);
					},
					onStatusTipsChange: (enabled) => {
						this.settingsManager.setStatusTips(enabled);
						// Applies next turn: the tip is picked in turn_start.
					},
					onTuiModeChange: (mode) => {
						if (!this.switchTuiMode(mode)) {
							selector?.getSettingsList().updateValue("tui-mode", this.ui.mode);
							this.showStatus("Close active overlays before changing TUI mode");
							return;
						}
						this.settingsManager.setTuiMode(mode);
						if (!this.activeStatusIndicator) this.statusContainer.clear();
						this.showStatus(`TUI mode: ${mode}`);
					},
					onFullscreenExitOutputChange: (output) => {
						this.settingsManager.setFullscreenExitOutput(output);
					},
					onFullscreenScrollbarChange: (mode) => {
						this.settingsManager.setFullscreenScrollbar(mode);
						this.applyFullscreenScrollbarSetting();
					},
					onFullscreenCopyOnSelectChange: (enabled) => {
						this.settingsManager.setFullscreenCopyOnSelect(enabled);
						if (this.renderer instanceof TuiAltScreen) this.renderer.setCopyOnSelect(enabled);
					},
					onCancel: () => {
						done();
						this.redraw.requestRender();
					},
				},
			);
			return { component: selector, focus: selector.getSettingsList() };
		});
	}

	handleThinkingCommand(searchTerm?: string): void {
		const availableLevels = this.session.getAvailableThinkingLevels();
		if (!searchTerm) {
			this.showThinkingSelector();
			return;
		}

		const normalized = searchTerm.trim().toLowerCase();
		const level = availableLevels.find((candidate) => candidate.toLowerCase() === normalized);
		if (!level) {
			this.showError(`Unknown thinking level "${searchTerm}". Available levels: ${availableLevels.join(", ")}.`);
			return;
		}

		this.selectThinkingLevel(level, false);
	}

	private selectThinkingLevel(level: ThinkingLevel, persist: boolean): void {
		try {
			this.session.setThinkingLevel(level, { persist });
			this.footer.invalidate();
			this.updateEditorBorderColor();
			this.showStatus(persist ? `Default thinking level: ${level}` : `Thinking level: ${level}`);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private showThinkingSelector(): void {
		this.showSelector((done) => {
			const selectLevel = (level: ThinkingLevel, persist: boolean) => {
				this.selectThinkingLevel(level, persist);
				done();
			};
			const availableLevels = this.session.getAvailableThinkingLevels();
			const globalDefault = this.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
			// Step models default to their highest supported effort, so mark that as
			// the default rather than the global level (which may not be selectable).
			const defaultMarker =
				this.session.model?.provider === STEP_PROVIDER_ID
					? (availableLevels[availableLevels.length - 1] ?? globalDefault)
					: globalDefault;
			const selector = new ThinkingSelectorComponent(
				this.session.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
				availableLevels,
				(level) => selectLevel(level, false),
				() => {
					done();
					this.redraw.requestRender();
				},
				(level) => selectLevel(level, true),
				defaultMarker,
			);
			return { component: selector, focus: selector };
		});
	}

	async handleModelCommand(searchTerm?: string): Promise<void> {
		if (!searchTerm) {
			this.showModelSelector();
			return;
		}

		const model = await this.findExactModelMatch(searchTerm);
		if (model) {
			try {
				await this.session.setModel(model, { persist: false });
				this.footer.invalidate();
				this.updateEditorBorderColor();
				this.showStatus(`Model: ${model.id}`);
				void this.maybeWarnAboutAnthropicSubscriptionAuth(model);
			} catch (error) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
			return;
		}

		this.showModelSelector(searchTerm);
	}

	private async findExactModelMatch(searchTerm: string): Promise<Model<any> | undefined> {
		const cachedModels =
			this.session.scopedModels.length > 0
				? this.session.scopedModels.map((scoped) => scoped.model)
				: [...this.session.modelRuntime.getAvailableSnapshot()];
		const cachedMatch = findExactModelReferenceMatch(searchTerm, cachedModels);
		if (cachedMatch || this.session.scopedModels.length > 0) return cachedMatch;

		this.showStatus("Refreshing model catalogs…");
		const controller = new AbortController();
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, 15_000);
		try {
			const result = await refreshModelCatalogs(this.session.modelRuntime, controller.signal);
			if (result.aborted && timedOut) {
				this.showWarning("Model refresh timed out; searching cached models.");
			} else if (result.errors.size > 0) {
				this.showWarning(`Could not refresh ${[...result.errors.keys()].join(", ")}; searching cached models.`);
			}
		} catch (error) {
			this.showWarning(
				timedOut
					? "Model refresh timed out; searching cached models."
					: `Could not refresh model catalogs: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			clearTimeout(timeout);
		}
		return findExactModelReferenceMatch(searchTerm, [...this.session.modelRuntime.getAvailableSnapshot()]);
	}

	/** Update the footer's available provider count from the current snapshot without refreshing catalogs. */
	private updateAvailableProviderCount(): void {
		const models =
			this.session.scopedModels.length > 0
				? this.session.scopedModels.map((scoped) => scoped.model)
				: this.session.modelRuntime.getAvailableSnapshot();
		const uniqueProviders = new Set(models.map((model) => model.provider));
		this.footerDataProvider.setAvailableProviderCount(uniqueProviders.size);
	}

	private async maybeWarnAboutAnthropicSubscriptionAuth(
		model: Model<any> | undefined = this.session.model,
	): Promise<void> {
		if (this.settingsManager.getWarnings().anthropicExtraUsage === false) {
			return;
		}
		if (this.anthropicSubscriptionWarningShown) {
			return;
		}
		if (!model || model.provider !== "anthropic") {
			return;
		}

		try {
			if ((await this.session.modelRuntime.checkAuth("anthropic"))?.type === "oauth") {
				this.anthropicSubscriptionWarningShown = true;
				this.showWarning(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING);
				return;
			}
			const apiKey = (await this.session.modelRuntime.getAuth(model.provider))?.auth.apiKey;
			if (!isAnthropicSubscriptionAuthKey(apiKey)) {
				return;
			}
			this.anthropicSubscriptionWarningShown = true;
			this.showWarning(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING);
		} catch {
			// Ignore auth lookup failures for warning-only checks.
		}
	}

	private maybeSaveImplicitProjectTrustAfterReload(): boolean {
		const cwd = this.sessionManager.getCwd();
		if (this.autoTrustOnReloadCwd !== cwd) {
			return false;
		}
		if (!this.settingsManager.isProjectTrusted() || !hasTrustRequiringProjectResources(cwd, this.configDirName)) {
			return false;
		}

		const trustStore = new ProjectTrustStore(this.runtimeHost.services.agentDir);
		try {
			if (trustStore.get(cwd) !== null) {
				this.autoTrustOnReloadCwd = undefined;
				return false;
			}
			trustStore.set(cwd, true);
			this.autoTrustOnReloadCwd = undefined;
			return true;
		} catch (error) {
			this.showWarning(
				`Could not save project trust after reload: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
	}

	showTrustSelector(): void {
		const cwd = this.sessionManager.getCwd();
		const trustStore = new ProjectTrustStore(this.runtimeHost.services.agentDir);
		const savedDecision = trustStore.getEntry(cwd);
		this.showSelector((done) => {
			const selector = new TrustSelectorComponent({
				cwd,
				savedDecision,
				projectTrusted: this.settingsManager.isProjectTrusted(),
				onSelect: (selection) => {
					trustStore.setMany(selection.updates);
					done();
					this.showStatus(
						`Saved trust decision: ${selection.trusted ? "trusted" : "untrusted"}. Restart ${APP_NAME} for this to take effect.`,
					);
				},
				onCancel: () => {
					done();
					this.redraw.requestRender();
				},
			});
			return { component: selector, focus: selector };
		});
	}

	showModelSelector(initialSearchInput?: string): void {
		this.showSelector((done) => {
			const selectModel = async (model: Model<any>, persist: boolean) => {
				try {
					await this.session.setModel(model, { persist });
					this.updateAvailableProviderCount();
					this.footer.invalidate();
					this.updateEditorBorderColor();
					done();
					this.showStatus(persist ? `Default model: ${model.provider}/${model.id}` : `Model: ${model.id}`);
					void this.maybeWarnAboutAnthropicSubscriptionAuth(model);
				} catch (error) {
					done();
					this.showError(error instanceof Error ? error.message : String(error));
				}
			};
			const defaultProvider = this.settingsManager.getDefaultProvider();
			const defaultModel = this.settingsManager.getDefaultModel();
			const selector = new ModelSelectorComponent(
				this.ui,
				this.session.model,
				this.session.modelRuntime,
				this.session.scopedModels,
				(model) => selectModel(model, false),
				() => {
					done();
					this.redraw.requestRender();
				},
				initialSearchInput,
				(model) => selectModel(model, true),
				defaultProvider && defaultModel ? { provider: defaultProvider, id: defaultModel } : undefined,
			);
			return {
				component: selector,
				focus: selector,
				dispose: () => selector.dispose(),
			};
		});
	}

	showModelsSelector(): void {
		let availableModels = [...this.session.modelRuntime.getAvailableSnapshot()];
		let availableModelIds = new Set(availableModels.map((model) => `${model.provider}/${model.id}`));
		const configuredPatterns = this.settingsManager.getEnabledModels();
		const sessionScopedModels = this.session.scopedModels;
		const configuredEnabledIds = (models: readonly Model<any>[]): string[] | null => {
			if (!configuredPatterns?.length) return null;
			const resolved = resolveModelScopeFromModels(configuredPatterns, models);
			const ids = resolved.scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`);
			for (const diagnostic of resolved.diagnostics) {
				if (diagnostic.code === "no-match" && !ids.includes(diagnostic.pattern)) ids.push(diagnostic.pattern);
			}
			return ids;
		};

		let currentEnabledIds =
			sessionScopedModels.length > 0
				? sessionScopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`)
				: configuredEnabledIds(availableModels);
		let selectionChanged = false;

		const updateSessionModels = (enabledIds: string[] | null): void => {
			currentEnabledIds = enabledIds === null ? null : [...enabledIds];
			const hasEnabledAvailableModel = enabledIds?.some((id) => availableModelIds.has(id)) ?? false;
			const allAvailableModelsEnabled =
				enabledIds !== null && [...availableModelIds].every((id) => enabledIds.includes(id));
			if (enabledIds && hasEnabledAvailableModel && !allAvailableModelsEnabled) {
				const newScopedModels = resolveModelScopeFromModels(enabledIds, availableModels).scopedModels;
				this.session.setScopedModels(
					newScopedModels.map((scoped) => ({
						model: scoped.model,
						thinkingLevel: scoped.thinkingLevel,
					})),
				);
			} else {
				this.session.setScopedModels([]);
			}
			this.updateAvailableProviderCount();
			this.redraw.requestRender();
		};

		this.showSelector((done) => {
			let disposed = false;
			let timedOut = false;
			const controller = new AbortController();
			const timeout = setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, 15_000);
			const selector = new ScopedModelsSelectorComponent(
				{
					allModels: availableModels,
					enabledModelIds: currentEnabledIds,
					refreshStatus: "Refreshing model catalogs…",
				},
				{
					onChange: (enabledIds) => {
						selectionChanged = true;
						updateSessionModels(enabledIds);
					},
					onPersist: (enabledIds) => {
						const allEnabled =
							enabledIds !== null &&
							enabledIds.length === availableModels.length &&
							enabledIds.every((id) => availableModelIds.has(id));
						const newPatterns = enabledIds === null || allEnabled ? undefined : enabledIds;
						this.settingsManager.setEnabledModels(newPatterns ? [...newPatterns] : undefined);
						this.showStatus("Model selection saved to settings");
					},
					onCancel: () => {
						done();
						this.redraw.requestRender();
					},
				},
			);
			void refreshModelCatalogs(this.session.modelRuntime, controller.signal)
				.then((result) => {
					if (disposed) return;
					availableModels = [...this.session.modelRuntime.getAvailableSnapshot()];
					availableModelIds = new Set(availableModels.map((model) => `${model.provider}/${model.id}`));
					if (!selectionChanged && sessionScopedModels.length === 0) {
						currentEnabledIds = configuredEnabledIds(availableModels);
						selector.updateModels(availableModels, currentEnabledIds);
					} else {
						selector.updateModels(availableModels);
					}
					if (currentEnabledIds !== null) updateSessionModels(currentEnabledIds);
					if (result.aborted && timedOut) {
						selector.setRefreshStatus("Model refresh timed out; showing cached models.", "warning");
					} else if (result.errors.size > 0) {
						selector.setRefreshStatus(
							`Could not refresh ${[...result.errors.keys()].join(", ")}; showing cached models.`,
							"warning",
						);
					} else {
						selector.setRefreshStatus("Model catalogs refreshed.", "success");
					}
					this.redraw.requestRender();
				})
				.catch((error: unknown) => {
					if (disposed) return;
					selector.setRefreshStatus(
						timedOut
							? "Model refresh timed out; showing cached models."
							: `Could not refresh model catalogs: ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
					this.redraw.requestRender();
				})
				.finally(() => clearTimeout(timeout));
			return {
				component: selector,
				focus: selector,
				dispose: () => {
					disposed = true;
					clearTimeout(timeout);
					controller.abort();
				},
			};
		});
	}

	showUserMessageSelector(): void {
		const userMessages = this.session.getUserMessagesForForking();

		if (userMessages.length === 0) {
			this.showStatus("No messages to fork from");
			return;
		}

		const initialSelectedId = userMessages[userMessages.length - 1]?.entryId;

		this.showSelector((done) => {
			const selector = new UserMessageSelectorComponent(
				userMessages.map((m) => ({ id: m.entryId, text: m.text })),
				async (entryId) => {
					done();
					try {
						const result = await this.runtimeHost.fork(entryId);
						if (result.cancelled) {
							this.redraw.requestRender();
							return;
						}

						this.editor.setText(result.selectedText ?? "");
						this.showStatus("Forked to new session");
					} catch (error: unknown) {
						this.showError(error instanceof Error ? error.message : String(error));
					}
				},
				() => {
					done();
					this.redraw.requestRender();
				},
				initialSelectedId,
			);
			return { component: selector, focus: selector.getMessageList() };
		});
	}

	async handleCloneCommand(): Promise<void> {
		const leafId = this.sessionManager.getLeafId();
		if (!leafId) {
			this.showStatus("Nothing to clone yet");
			return;
		}

		try {
			const result = await this.runtimeHost.fork(leafId, { position: "at" });
			if (result.cancelled) {
				this.redraw.requestRender();
				return;
			}

			this.editor.setText("");
			this.showStatus("Cloned to new session");
		} catch (error: unknown) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	showTreeSelector(initialSelectedId?: string): void {
		const tree = this.sessionManager.getTree();
		const realLeafId = this.sessionManager.getLeafId();
		const initialFilterMode = this.settingsManager.getTreeFilterMode();

		if (tree.length === 0) {
			this.showStatus("No entries in session");
			return;
		}

		this.showSelector((done) => {
			const selector = new TreeSelectorComponent(
				tree,
				realLeafId,
				this.ui.terminal.rows,
				async (entryId) => {
					// Selecting the current leaf is a no-op (already there)
					if (entryId === this.sessionManager.getLeafId()) {
						done();
						this.showStatus("Already at this point");
						return;
					}

					// Ask about summarization
					done(); // Close selector first

					// Loop until user makes a complete choice or cancels to tree
					let wantsSummary = false;
					let customInstructions: string | undefined;

					// Check if we should skip the prompt (user preference to always default to no summary)
					if (!this.settingsManager.getBranchSummarySkipPrompt()) {
						while (true) {
							const summaryChoice = await this.showExtensionSelector("Summarize branch?", [
								"No summary",
								"Summarize",
								"Summarize with custom prompt",
							]);

							if (summaryChoice === undefined) {
								// User pressed escape - re-show tree selector with same selection
								this.showTreeSelector(entryId);
								return;
							}

							wantsSummary = summaryChoice !== "No summary";

							if (summaryChoice === "Summarize with custom prompt") {
								customInstructions = await this.showExtensionEditor("Custom summarization instructions");
								if (customInstructions === undefined) {
									// User cancelled - loop back to summary selector
									continue;
								}
							}

							// User made a complete choice
							break;
						}
					}

					// The user committed to navigating: stop the active response first.
					if (this.session.isStreaming) {
						this.restoreQueuedMessagesToEditor();
						await this.session.abort();
					}

					// Set up escape handler and status indicator if summarizing
					let showingSummaryIndicator = false;
					const originalOnEscape = this.defaultEditor.onEscape;

					if (wantsSummary) {
						this.defaultEditor.onEscape = () => {
							this.session.abortBranchSummary();
						};
						this.chatContainer.addChild(new Spacer(1));
						this.showStatusIndicator(new BranchSummaryStatusIndicator(this.ui, this.presentation));
						showingSummaryIndicator = true;
						this.redraw.requestRender();
					}

					try {
						const result = await this.session.navigateTree(entryId, {
							summarize: wantsSummary,
							customInstructions,
						});

						if (result.aborted) {
							// Summarization aborted - re-show tree selector with same selection
							this.showStatus("Branch summarization cancelled");
							this.showTreeSelector(entryId);
							return;
						}
						if (result.cancelled) {
							this.showStatus("Navigation cancelled");
							return;
						}

						// Update UI
						this.chatContainer.clear();
						this.renderInitialMessages();
						if (result.editorText && !this.editor.getText().trim()) {
							this.editor.setText(result.editorText);
						}
						this.showStatus("Navigated to selected point");
						void this.flushCompactionQueue({ willRetry: false });
					} catch (error) {
						this.showError(error instanceof Error ? error.message : String(error));
					} finally {
						if (showingSummaryIndicator) {
							this.clearStatusIndicator("branchSummary");
						}
						this.defaultEditor.onEscape = originalOnEscape;
					}
				},
				() => {
					done();
					this.redraw.requestRender();
				},
				(entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
					this.redraw.requestRender();
				},
				initialSelectedId,
				initialFilterMode,
			);
			selector.onCopy = async (text) => {
				if (!text) {
					this.showError("Selected entry has no text to copy");
					return;
				}
				try {
					await copyToClipboard(text);
					this.showStatus("Copied selected message to clipboard");
				} catch (error) {
					this.showError(error instanceof Error ? error.message : String(error));
				}
			};
			return { component: selector, focus: selector };
		});
	}

	showSessionSelector(): void {
		this.showSelector((done) => {
			const selector = new SessionSelectorComponent(
				(onProgress) =>
					this.presentation === "step"
						? this.sessionManager.isPersisted()
							? listStepSessions(this.sessionManager.getCwd(), {
									sessionDir: this.sessionManager.getSessionDir(),
									agentDir: this.agentDir,
									onProgress,
								})
							: Promise.resolve([])
						: SessionManager.list(this.sessionManager.getCwd(), this.sessionManager.getSessionDir(), onProgress),
				(onProgress) =>
					this.presentation === "step"
						? this.sessionManager.isPersisted()
							? listAllStepSessions({ sessionDir: this.stepSessionRoot, agentDir: this.agentDir, onProgress })
							: Promise.resolve([])
						: this.sessionManager.usesDefaultSessionDir()
							? SessionManager.listAll(onProgress)
							: SessionManager.listAll(this.sessionManager.getSessionDir(), onProgress),
				async (sessionPath) => {
					done();
					await this.handleResumeSession(sessionPath);
				},
				() => {
					done();
					this.redraw.requestRender();
				},
				() => {
					void this.shutdown();
				},
				() => this.redraw.requestRender(),
				{
					renameSession: async (sessionFilePath: string, nextName: string | undefined) => {
						const next = (nextName ?? "").trim();
						if (!next) return;
						const mgr =
							this.presentation === "step"
								? openStepSession(sessionFilePath, {
										agentDir: this.agentDir,
										sessionDir: this.sessionManager.getSessionDir(),
									})
								: SessionManager.open(sessionFilePath);
						mgr.appendSessionInfo(next);
					},
					showRenameHint: true,
					keybindings: this.keybindings,
				},

				this.sessionManager.getSessionFile(),
			);
			return { component: selector, focus: selector };
		});
	}

	private async handleResumeSession(
		sessionPath: string,
		options?: Parameters<ExtensionCommandContext["switchSession"]>[1],
	): Promise<{ cancelled: boolean }> {
		this.clearStatusIndicator();
		try {
			const result = await this.runtimeHost.switchSession(sessionPath, {
				withSession: options?.withSession,
				projectTrustContextFactory: (cwd) => this.createProjectTrustContext(cwd),
			});
			if (result.cancelled) {
				return result;
			}
			this.showStatus("Resumed session");
			return result;
		} catch (error: unknown) {
			if (error instanceof MissingSessionCwdError) {
				const selectedCwd = await this.promptForMissingSessionCwd(error);
				if (!selectedCwd) {
					this.showStatus("Resume cancelled");
					return { cancelled: true };
				}
				const result = await this.runtimeHost.switchSession(sessionPath, {
					cwdOverride: selectedCwd,
					withSession: options?.withSession,
					projectTrustContextFactory: (cwd) => this.createProjectTrustContext(cwd),
				});
				if (result.cancelled) {
					return result;
				}
				this.showStatus("Resumed session in current cwd");
				return result;
			}
			return this.handleFatalRuntimeError("Failed to resume session", error);
		}
	}

	private getLoginProviderOptions(authType?: "oauth" | "api_key"): AuthSelectorProvider[] {
		const options: AuthSelectorProvider[] = [];
		const allowedAuthProviders = this.options?.allowedAuthProviders;
		const allowed = allowedAuthProviders
			? new Set(allowedAuthProviders.map((provider) => provider.trim().toLowerCase()))
			: undefined;
		for (const provider of this.session.modelRuntime.getProviders()) {
			if (allowed && !allowed.has(provider.id.toLowerCase())) continue;
			const authStatus = this.session.modelRuntime.getProviderAuthStatus(provider.id);
			const status = authStatus.configured
				? {
						type: this.session.modelRuntime.isUsingOAuth(provider.id) ? ("oauth" as const) : ("api_key" as const),
						source: authStatus.label ?? authStatus.source,
					}
				: undefined;
			if ((!authType || authType === "oauth") && provider.auth.oauth) {
				options.push({
					id: provider.id,
					name: provider.name,
					authType: "oauth",
					method: provider.auth.oauth,
					status,
				});
			}
			if ((!authType || authType === "api_key") && provider.auth.apiKey) {
				options.push({
					id: provider.id,
					name: provider.name,
					authType: "api_key",
					method: provider.auth.apiKey,
					status,
				});
			}
		}
		return options.sort((a, b) => a.name.localeCompare(b.name));
	}

	private async getLogoutProviderOptions(): Promise<AuthSelectorProvider[]> {
		const allowedAuthProviders = this.options?.allowedAuthProviders;
		const allowed = allowedAuthProviders
			? new Set(allowedAuthProviders.map((provider) => provider.trim().toLowerCase()))
			: undefined;
		const credentials = await this.session.modelRuntime.listCredentials({
			signal: AbortSignal.timeout(15_000),
		});
		return credentials
			.filter(({ providerId }) => !allowed || allowed.has(providerId.toLowerCase()))
			.map(({ providerId, type }) => ({
				id: providerId,
				name: this.session.modelRuntime.getProvider(providerId)?.name ?? providerId,
				authType: type,
				status: { type, source: "stored credential" },
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	private findLoginProviderOptions(providerRef: string): AuthSelectorProvider[] {
		const normalizedProviderRef = providerRef.trim().toLowerCase();
		if (!normalizedProviderRef) {
			return [];
		}

		return this.getLoginProviderOptions().filter(
			(provider) =>
				provider.id.toLowerCase() === normalizedProviderRef ||
				provider.name.toLowerCase() === normalizedProviderRef,
		);
	}

	/**
	 * Ask once, on the first interactive launch, which theme reads best here.
	 *
	 * Runs before `init()`, so the picker owns a screen of its own instead of
	 * appearing over a logo and an input box that were painted a frame earlier.
	 * The chosen setting is written through the settings manager while it is
	 * still the only reader: `init()` builds the theme controller from those
	 * settings a moment later, so the session opens in the theme just chosen.
	 *
	 * The gate is the absence of a persisted theme, and nothing else: the screen
	 * always answers with a setting — the default when it is dismissed — so the
	 * written `theme` is the whole record that the question was put. A user who
	 * has a theme, from this screen, `/settings`, or by hand, has answered it;
	 * deleting that line asks again. Launches that carry work (an initial prompt,
	 * a resumed session) are left alone: a setup screen in front of a task the
	 * user already asked for is an interruption, not onboarding.
	 *
	 * Returns a message to show once there is a chat surface to show it on.
	 */
	private async maybeRunStepThemePrompt(): Promise<string | undefined> {
		if (!this.options.stepThemePrompt) return undefined;
		if (this.options.exitAfterStartupLogin) return undefined;
		if (this.settingsManager.getThemeSetting() !== undefined) return undefined;
		if (this.options.initialMessage || this.options.initialMessages?.length) return undefined;
		if (this.session.state.messages.length > 0) return undefined;

		try {
			const selection = await this.options.stepThemePrompt();
			if (!selection) return undefined;
			this.settingsManager.setTheme(selection);
			await this.settingsManager.flush();
		} catch (error: unknown) {
			// A theme question is never worth failing a launch over.
			return `Could not offer the theme picker: ${error instanceof Error ? error.message : String(error)}`;
		}
		return undefined;
	}

	/**
	 * Give product entrypoints an opt-in first-run auth prompt while keeping the
	 * actual selector, OAuth dialog, persistence, and model synchronization in
	 * Pi's existing login path.
	 */
	private async maybeRunStartupLogin(): Promise<void> {
		const providerId = this.options.startupLoginProvider?.trim();
		if (!providerId || this.session.state.messages.length > 0) return;
		if (this.session.model?.provider !== providerId) return;
		if (!this.options.forceStartupLogin && this.session.modelRuntime.getProviderAuthStatus(providerId).configured)
			return;

		// Step's startup contract is subscription-first. Select its OAuth method
		// directly when available; the regular /login command remains unchanged
		// and still offers the full auth-type selector for manual use.
		const oauthProvider = this.getLoginProviderOptions("oauth").find(
			(provider) => provider.id.toLowerCase() === providerId.toLowerCase(),
		);
		if (oauthProvider) {
			await this.startProviderLogin(oauthProvider);
			return;
		}
		await this.handleLoginCommand(providerId);
	}

	async handleLoginCommand(providerRef?: string): Promise<void> {
		if ((!providerRef || providerRef.toLowerCase() === "step") && this.options.stepLogin) {
			const activeSession = this.runtimeHost?.session;
			if (activeSession?.isStreaming || activeSession?.isCompacting) {
				this.showWarning("Wait for the active turn to finish before signing in");
				return;
			}
			if (this.options.authPath && readStepLoginCredential(this.options.authPath)) {
				const profileId = readStepLoginProfile(this.options.authPath);
				const profileTitle = resolveStepLoginProfiles().find((profile) => profile.id === profileId)?.title;
				this.showStatus(
					`Already signed in with ${profileTitle ?? "the stored profile"}. Run \`/logout\` before signing in again.`,
				);
				return;
			}
			try {
				const outcome = await this.options.stepLogin(this.createStepLoginHost());
				if (outcome.kind === "completed") {
					await this.handleReloadCommand();
				} else {
					this.showStatus("Sign-in cancelled. No credential was written.");
				}
			} catch (error: unknown) {
				this.showError(`Failed to login to Step: ${error instanceof Error ? error.message : String(error)}`);
			}
			return;
		}
		if (!providerRef) {
			this.showLoginAuthTypeSelector();
			return;
		}

		const providerOptions = this.findLoginProviderOptions(providerRef);
		if (providerOptions.length === 1) {
			await this.startProviderLogin(providerOptions[0]!);
			return;
		}

		if (providerOptions.length > 1) {
			const providerIds = new Set(providerOptions.map((provider) => provider.id));
			if (providerIds.size === 1) {
				this.showLoginAuthTypeSelector(providerOptions);
				return;
			}
		}

		this.showLoginProviderSelector(undefined, providerRef);
	}

	private createStepLoginHost(): StepLoginHost {
		let mounted: Component | undefined;
		let overlay: OverlayHandle | undefined;
		return {
			addChild: (child) => {
				if (overlay) {
					throw new Error("The Step login view is already mounted");
				}
				mounted = child as Component;
				const fullViewport: Component & Focusable = {
					get focused(): boolean {
						return mounted !== undefined && "focused" in mounted
							? (mounted as Component & Focusable).focused
							: false;
					},
					set focused(value: boolean) {
						if (mounted !== undefined && "focused" in mounted) {
							(mounted as Component & Focusable).focused = value;
						}
					},
					render: (width) => {
						const lines = mounted?.render(width) ?? [];
						const rows = Math.max(this.ui.terminal.rows, lines.length);
						return [
							...lines,
							...Array.from({ length: rows - lines.length }, () => " ".repeat(Math.max(0, width))),
						];
					},
					handleInput: (data) => mounted?.handleInput?.(data),
					invalidate: () => mounted?.invalidate(),
				};
				overlay = this.ui.showOverlay(fullViewport, {
					anchor: "top-left",
					width: "100%",
					maxHeight: "100%",
				});
			},
			setFocus: (child) => {
				if (child === mounted) {
					overlay?.focus();
					return;
				}
				this.ui.setFocus(child as Component);
			},
			requestRender: () => this.redraw.requestRender(),
			start: () => undefined,
			stop: () => {
				overlay?.hide();
				overlay = undefined;
				if (mounted) {
					mounted = undefined;
					this.ui.setFocus(this.editor);
					this.redraw.requestRender();
				}
			},
		};
	}

	async handleStepLogoutCommand(): Promise<void> {
		if (this.session.isStreaming || this.session.isCompacting) {
			this.showWarning("Wait for the active turn to finish before signing out");
			return;
		}
		try {
			const report = await this.options.stepLogout?.();
			if (!report) return;
			this.showStatus(report.removed ? "Signed out of Step." : "No stored Step credential.");
			if (report.remainingSource) {
				this.showWarning(`An API key is still active from ${report.remainingSource}.`);
			}
			await this.shutdown();
		} catch (error: unknown) {
			this.showError(`Failed to logout from Step: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async startProviderLogin(providerOption: AuthSelectorProvider): Promise<void> {
		if (providerOption.authType === "oauth") {
			await this.showLoginDialog(providerOption.id, providerOption.name);
		} else if (providerOption.method?.login) {
			await this.showApiKeyLoginDialog(providerOption.id, providerOption.name);
		} else {
			this.showAmbientAuthDialog(providerOption);
		}
	}

	private showLoginAuthTypeSelector(providerOptions?: AuthSelectorProvider[]): void {
		const oauthProvider = providerOptions?.find((provider) => provider.authType === "oauth");
		const oauthLoginLabel =
			oauthProvider?.method && "loginLabel" in oauthProvider.method ? oauthProvider.method.loginLabel : undefined;
		const subscriptionLabel = oauthLoginLabel ?? "Sign in with an account";
		const apiKeyLabel = "Sign in with an API key";
		const availableAuthTypes = providerOptions
			? new Set(providerOptions.map((provider) => provider.authType))
			: new Set<AuthSelectorProvider["authType"]>(["oauth", "api_key"]);
		const options: string[] = [];
		if (availableAuthTypes.has("oauth")) {
			options.push(subscriptionLabel);
		}
		if (availableAuthTypes.has("api_key")) {
			options.push(apiKeyLabel);
		}

		if (options.length === 0) {
			this.showStatus("No login methods available.");
			return;
		}

		if (providerOptions && options.length === 1) {
			const providerOption = providerOptions[0];
			if (providerOption) {
				void this.startProviderLogin(providerOption);
			}
			return;
		}

		const title = providerOptions?.[0]
			? `Select authentication method for ${providerOptions[0].name}:`
			: "Select authentication method:";
		this.showSelector((done) => {
			const selector = new ExtensionSelectorComponent(
				title,
				options,
				(option) => {
					done();
					const authType = option === subscriptionLabel ? "oauth" : "api_key";
					if (providerOptions) {
						const providerOption = providerOptions.find((provider) => provider.authType === authType);
						if (providerOption) {
							void this.startProviderLogin(providerOption);
						}
						return;
					}
					this.showLoginProviderSelector(authType);
				},
				() => {
					done();
					this.redraw.requestRender();
				},
				{ presentation: this.options.tuiStyle === "step" ? "step" : "native" },
			);
			return { component: selector, focus: selector };
		});
	}

	private showLoginProviderSelector(authType?: AuthSelectorProvider["authType"], initialSearchInput?: string): void {
		const providerOptions = this.getLoginProviderOptions(authType);
		if (providerOptions.length === 0) {
			const message =
				authType === "oauth"
					? "No subscription providers available."
					: authType === "api_key"
						? "No API key providers available."
						: "No login providers available.";
			this.showStatus(message);
			return;
		}

		this.showSelector((done) => {
			const selector = new OAuthSelectorComponent(
				"login",
				providerOptions,
				async (providerId, selectedAuthType) => {
					done();

					const providerOption = providerOptions.find(
						(provider) => provider.id === providerId && provider.authType === selectedAuthType,
					);
					if (!providerOption) {
						return;
					}

					await this.startProviderLogin(providerOption);
				},
				() => {
					done();
					if (authType) {
						this.showLoginAuthTypeSelector();
					} else {
						this.redraw.requestRender();
					}
				},
				initialSearchInput,
				{ presentation: this.options.tuiStyle === "step" ? "step" : "native" },
			);
			return { component: selector, focus: selector };
		});
	}

	async showOAuthSelector(mode: "login" | "logout"): Promise<void> {
		if (mode === "login") {
			this.showLoginAuthTypeSelector();
			return;
		}

		let providerOptions: AuthSelectorProvider[];
		try {
			providerOptions = await this.getLogoutProviderOptions();
		} catch (error) {
			this.showError(`Could not read stored credentials: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		if (providerOptions.length === 0) {
			this.showStatus(
				"No stored credentials to remove. /logout only removes credentials saved by /login; environment variables and models.json config are unchanged.",
			);
			return;
		}

		this.showSelector((done) => {
			const selector = new OAuthSelectorComponent(
				mode,
				providerOptions,
				async (providerId: string) => {
					done();

					const providerOption = providerOptions.find((provider) => provider.id === providerId);
					if (!providerOption) {
						return;
					}

					try {
						await this.session.modelRuntime.logout(providerOption.id, {
							signal: AbortSignal.timeout(15_000),
						});
						await this.updateAvailableProviderCount();
						const message =
							providerOption.authType === "oauth"
								? `Logged out of ${providerOption.name}`
								: `Removed stored API key for ${providerOption.name}. Environment variables and models.json config are unchanged.`;
						this.showStatus(message);
					} catch (error: unknown) {
						const message = error instanceof Error ? error.message : String(error);
						this.showError(
							error instanceof CredentialSynchronizationError
								? `Credentials removed for ${providerOption.name}, but local model state could not be synchronized: ${message}`
								: `Logout failed: ${message}`,
						);
					}
				},
				() => {
					done();
					this.redraw.requestRender();
				},
				undefined,
				{ presentation: this.options.tuiStyle === "step" ? "step" : "native" },
			);
			return { component: selector, focus: selector };
		});
	}

	private async completeProviderAuthentication(
		providerId: string,
		providerName: string,
		authType: "oauth" | "api_key",
		previousModel: Model<any> | undefined,
	): Promise<void> {
		const actionLabel = authType === "oauth" ? `Logged in to ${providerName}` : `Saved API key for ${providerName}`;

		let selectedModel: Model<any> | undefined;
		let selectionError: string | undefined;
		const productDefaultModelId = this.options?.defaultModelForProvider?.(providerId);
		const authPath =
			this.options?.authPath ??
			(this.runtimeHost?.services?.agentDir
				? path.join(this.runtimeHost.services.agentDir, "auth.json")
				: "auth.json");
		// A product login may be the first usable credential while the current
		// session still points at a migrated provider.  Select and persist the
		// product model in that case; Pi's existing providers retain their old
		// "only when unknown" behavior.
		if (isUnknownModel(previousModel) || productDefaultModelId !== undefined) {
			const availableModels = this.session.modelRuntime.getAvailableSnapshot();
			const providerModels = availableModels.filter((model) => model.provider === providerId);
			// Matches LLAMA_PROVIDER_ID from extensions/llama/provider.ts; kept inline to avoid coupling interactive mode to the built-in extension.
			if (providerId === "llama.cpp") {
				selectionError = llamaCppPostLoginGuidance(actionLabel, providerModels.length);
			} else if (productDefaultModelId === undefined && !hasDefaultModelProvider(providerId)) {
				selectionError = `${actionLabel}, but no default model is configured for provider "${providerId}". Use /model to select a model.`;
			} else if (providerModels.length === 0) {
				selectionError = `${actionLabel}, but no models are available for that provider. Use /model to select a model.`;
			} else {
				const defaultModelId =
					productDefaultModelId ??
					(hasDefaultModelProvider(providerId) ? defaultModelPerProvider[providerId] : undefined);
				selectedModel = providerModels.find((model) => model.id === defaultModelId);
				if (!selectedModel) {
					selectionError = `${actionLabel}, but its default model "${defaultModelId}" is not available. Use /model to select a model.`;
				} else {
					try {
						await this.session.setModel(selectedModel, { persist: true });
					} catch (error: unknown) {
						selectedModel = undefined;
						const errorMessage = error instanceof Error ? error.message : String(error);
						selectionError = `${actionLabel}, but selecting its default model failed: ${errorMessage}. Use /model to select a model.`;
					}
				}
			}
		}

		await this.updateAvailableProviderCount();
		this.footer.invalidate();
		this.updateEditorBorderColor();
		if (selectedModel) {
			this.showStatus(`${actionLabel}. Selected ${selectedModel.id}. Credentials saved to ${authPath}`);
			void this.maybeWarnAboutAnthropicSubscriptionAuth(selectedModel);
		} else {
			this.showStatus(`${actionLabel}. Credentials saved to ${authPath}`);
			if (selectionError) {
				this.showError(selectionError);
			} else {
				void this.maybeWarnAboutAnthropicSubscriptionAuth();
			}
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 15_000);
		void this.session.modelRuntime
			.refresh({ providers: [providerId], signal: controller.signal })
			.then((result) => {
				if (result.aborted) {
					this.showWarning(`${actionLabel}, but its model catalog refresh timed out; using cached models.`);
				} else if (result.errors.size > 0) {
					this.showWarning(`${actionLabel}, but its model catalog could not be refreshed; using cached models.`);
				}
				this.updateAvailableProviderCount();
				this.footer.invalidate();
				this.redraw.requestRender();
			})
			.catch((error: unknown) => {
				this.showWarning(
					`${actionLabel}, but its model catalog could not be refreshed: ${error instanceof Error ? error.message : String(error)}`,
				);
			})
			.finally(() => clearTimeout(timeout));
	}

	private showAmbientAuthDialog(providerOption: AuthSelectorProvider): void {
		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			this.redraw.requestRender();
		};

		const dialog = new LoginDialogComponent(
			this.ui,
			providerOption.id,
			() => restoreEditor(),
			providerOption.name,
			`${providerOption.name} setup`,
			this.options.tuiStyle === "step" ? "step" : "native",
		);
		dialog.showInfo(
			`${providerOption.method?.name ?? "Authentication"} is configured outside ${APP_NAME}.`,
			[],
			true,
		);

		this.editorContainer.clear();
		this.editorContainer.addChild(dialog);
		this.ui.setFocus(dialog);
		this.redraw.requestRender();
	}

	private async showApiKeyLoginDialog(providerId: string, providerName: string): Promise<void> {
		const previousModel = this.session.model;

		const dialog = new LoginDialogComponent(
			this.ui,
			providerId,
			(_success, _message) => {
				// Completion handled below
			},
			providerName,
			undefined,
			this.options.tuiStyle === "step" ? "step" : "native",
		);

		this.editorContainer.clear();
		this.editorContainer.addChild(dialog);
		this.ui.setFocus(dialog);
		this.redraw.requestRender();

		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			this.redraw.requestRender();
		};

		try {
			await this.loginProvider(dialog, providerId, "api_key");
			restoreEditor();
			await this.completeProviderAuthentication(providerId, providerName, "api_key", previousModel);
		} catch (error: unknown) {
			restoreEditor();
			const errorMsg = error instanceof Error ? error.message : String(error);
			if (error instanceof CredentialSynchronizationError) {
				this.showError(
					`Saved API key for ${providerName}, but local model state could not be synchronized: ${errorMsg}`,
				);
			} else if (errorMsg !== "Login cancelled") {
				this.showError(`Failed to save API key for ${providerName}: ${errorMsg}`);
			}
		}
	}

	private showAuthSelect(
		dialog: LoginDialogComponent,
		prompt: Extract<AuthPrompt, { type: "select" }>,
	): Promise<string> {
		return new Promise((resolve, reject) => {
			const restoreDialog = () => {
				this.editorContainer.clear();
				this.editorContainer.addChild(dialog);
				this.ui.setFocus(dialog);
				this.redraw.requestRender();
			};
			const labels = prompt.options.map((option) => option.label);
			const selector = new ExtensionSelectorComponent(
				prompt.message,
				labels,
				(optionLabel) => {
					restoreDialog();
					const id = prompt.options.find((option) => option.label === optionLabel)?.id;
					if (id) resolve(id);
					else reject(new Error("Login cancelled"));
				},
				() => {
					restoreDialog();
					reject(new Error("Login cancelled"));
				},
				{ presentation: this.options.tuiStyle === "step" ? "step" : "native" },
			);
			this.editorContainer.clear();
			this.editorContainer.addChild(selector);
			this.ui.setFocus(selector);
			this.redraw.requestRender();
		});
	}

	private async showAuthPrompt(dialog: LoginDialogComponent, prompt: AuthPrompt): Promise<string> {
		let response: Promise<string>;
		if (prompt.type === "select") {
			response = this.showAuthSelect(dialog, prompt);
		} else if (prompt.type === "manual_code") {
			response = dialog.showManualInput(prompt.message);
		} else {
			response = dialog.showPrompt(prompt.message, prompt.placeholder, {
				secret: prompt.type === "secret",
			});
		}
		if (!prompt.signal) return response;
		if (prompt.signal.aborted) throw new Error("Login cancelled");
		const signal = prompt.signal;
		let onAbort: (() => void) | undefined;
		const aborted = new Promise<string>((_resolve, reject) => {
			onAbort = () => reject(new Error("Login cancelled"));
			signal.addEventListener("abort", onAbort, { once: true });
		});
		try {
			return await Promise.race([response, aborted]);
		} finally {
			if (onAbort) signal.removeEventListener("abort", onAbort);
		}
	}

	private notifyAuthDialog(dialog: LoginDialogComponent, event: AuthEvent): void {
		if (event.type === "auth_url") {
			dialog.showAuth(event.url, event.instructions);
		} else if (event.type === "device_code") {
			dialog.showDeviceCode(event);
			dialog.showWaiting("Waiting for authentication...");
		} else if (event.type === "info") {
			dialog.showInfo(event.message, event.links);
		} else {
			dialog.showProgress(event.message);
		}
	}

	private async loginProvider(
		dialog: LoginDialogComponent,
		providerId: string,
		method: "api_key" | "oauth",
	): Promise<void> {
		try {
			const credential = await this.session.modelRuntime.login(providerId, method, {
				signal: dialog.signal,
				prompt: (prompt) => this.showAuthPrompt(dialog, prompt),
				notify: (event) => this.notifyAuthDialog(dialog, event),
			});
			this.notifyCredentialAuthenticated(providerId, credential);
		} catch (error: unknown) {
			// CredentialSynchronizationError means persistence succeeded even though
			// Pi could not refresh its in-memory model snapshot. Keep telemetry's
			// account identity correct, then let the existing error UI handle it.
			if (error instanceof CredentialSynchronizationError) {
				this.notifyCredentialAuthenticated(providerId, error.credential);
			}
			throw error;
		}
	}

	private notifyCredentialAuthenticated(providerId: string, credential: unknown): void {
		try {
			const uid = readCredentialUid(credential);
			this.options.onCredentialAuthenticated?.({
				providerId,
				...(uid ? { uid } : undefined),
			});
		} catch {
			// Product observers are diagnostic-only and must not alter login success.
		}
	}

	private async showLoginDialog(providerId: string, providerName: string): Promise<void> {
		const previousModel = this.session.model;
		const dialog = new LoginDialogComponent(
			this.ui,
			providerId,
			(_success, _message) => {},
			providerName,
			undefined,
			this.options.tuiStyle === "step" ? "step" : "native",
		);
		this.editorContainer.clear();
		this.editorContainer.addChild(dialog);
		this.ui.setFocus(dialog);
		this.redraw.requestRender();

		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			this.redraw.requestRender();
		};

		try {
			await this.loginProvider(dialog, providerId, "oauth");
			restoreEditor();
			await this.completeProviderAuthentication(providerId, providerName, "oauth", previousModel);
		} catch (error: unknown) {
			restoreEditor();
			const errorMsg = error instanceof Error ? error.message : String(error);
			if (error instanceof CredentialSynchronizationError) {
				this.showError(
					`Logged in to ${providerName}, but local model state could not be synchronized: ${errorMsg}`,
				);
			} else if (errorMsg !== "Login cancelled") {
				this.showError(`Failed to login to ${providerName}: ${errorMsg}`);
			}
			// `/login` is an interactive command and intentionally reports errors
			// in-place. `step login` is a one-shot command, however; propagate the
			// failure so the launcher can clean up and return a non-zero status.
			if (this.options.exitAfterStartupLogin) {
				throw error;
			}
		}
	}

	// =========================================================================
	// Command handlers
	// =========================================================================

	async handleReloadCommand(): Promise<void> {
		if (this.session.isStreaming) {
			this.showWarning("Wait for the current response to finish before reloading.");
			return;
		}
		if (this.session.isCompacting) {
			this.showWarning("Wait for compaction to finish before reloading.");
			return;
		}

		this.resetExtensionUI();

		const reloadBox = new Container();
		const borderColor = (s: string) => theme.fg("border", s);
		reloadBox.addChild(new DynamicBorder(borderColor));
		reloadBox.addChild(new Spacer(1));
		reloadBox.addChild(
			new Text(
				theme.fg("muted", "Reloading keybindings, extensions, skills, prompts, themes, and context files..."),
				1,
				0,
			),
		);
		reloadBox.addChild(new Spacer(1));
		reloadBox.addChild(new DynamicBorder(borderColor));

		const previousEditor = this.editor;
		this.editorContainer.clear();
		this.editorContainer.addChild(reloadBox);
		this.ui.setFocus(reloadBox);
		this.redraw.forceRender();
		await new Promise((resolve) => process.nextTick(resolve));

		const dismissReloadBox = (editor: Component) => {
			this.editorContainer.clear();
			this.editorContainer.addChild(editor);
			this.ui.setFocus(editor);
			this.redraw.requestRender();
		};

		let chatRestoredBeforeSessionStart = false;
		let reloadBoxDismissed = false;
		const restoreChatBeforeSessionStart = () => {
			if (chatRestoredBeforeSessionStart) {
				return;
			}
			this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
			this.outputPad = this.settingsManager.getOutputPad();
			this.rebuildChatFromMessages();
			chatRestoredBeforeSessionStart = true;
		};

		try {
			await this.session.reload({
				beforeSessionStart: restoreChatBeforeSessionStart,
			});
			restoreChatBeforeSessionStart();
			this.keybindings.reload();
			const activeHeader = this.customHeader ?? this.builtInHeader;
			if (isExpandable(activeHeader)) {
				activeHeader.setExpanded(this.toolOutputExpanded);
			}
			setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
			this.applyRuntimeSettings();
			await this.themeController.applyFromSettings();
			this.setupAutocompleteProvider();
			const runner = this.session.extensionRunner;
			this.setupExtensionShortcuts(runner);
			this.showLoadedResources({
				force: false,
				showDiagnosticsWhenQuiet: true,
			});
			const savedImplicitProjectTrust = this.maybeSaveImplicitProjectTrustAfterReload();
			const modelsJsonError = this.session.modelRuntime.getError();
			if (modelsJsonError) {
				this.showError(`models.json error: ${modelsJsonError}`);
			}
			this.showStatus(
				savedImplicitProjectTrust
					? "Reloaded keybindings, extensions, skills, prompts, themes, and context files; saved project trust"
					: "Reloaded keybindings, extensions, skills, prompts, themes, and context files",
			);
			dismissReloadBox(this.editor as Component);
			reloadBoxDismissed = true;
		} catch (error) {
			if (!reloadBoxDismissed) {
				dismissReloadBox(previousEditor as Component);
			}
			this.showError(`Reload failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async handleExportCommand(text: string): Promise<void> {
		const outputPath = this.getPathCommandArgument(text, "/export");

		try {
			if (outputPath?.endsWith(".jsonl")) {
				const filePath = this.session.exportToJsonl(outputPath);
				this.showStatus(`Session exported to: ${filePath}`);
			} else {
				const filePath = await this.session.exportToHtml(outputPath, {
					themeName: theme.name,
				});
				this.showStatus(`Session exported to: ${filePath}`);
			}
		} catch (error: unknown) {
			this.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}

	private getPathCommandArgument(text: string, command: "/export" | "/import"): string | undefined {
		if (text === command) {
			return undefined;
		}
		if (!text.startsWith(`${command} `)) {
			return undefined;
		}

		const argsString = text.slice(command.length + 1).trimStart();
		if (!argsString) {
			return undefined;
		}

		const firstChar = argsString[0];
		if (firstChar === '"' || firstChar === "'") {
			const closingQuoteIndex = argsString.indexOf(firstChar, 1);
			if (closingQuoteIndex < 0) {
				return undefined;
			}
			return argsString.slice(1, closingQuoteIndex);
		}

		const firstWhitespaceIndex = argsString.search(/\s/);
		if (firstWhitespaceIndex < 0) {
			return argsString;
		}
		return argsString.slice(0, firstWhitespaceIndex);
	}

	async handleImportCommand(text: string): Promise<void> {
		const inputPath = this.getPathCommandArgument(text, "/import");
		if (!inputPath) {
			this.showError("Usage: /import <path.jsonl>");
			return;
		}

		const confirmed = await this.showExtensionConfirm("Import session", `Replace current session with ${inputPath}?`);
		if (!confirmed) {
			this.showStatus("Import cancelled");
			return;
		}

		try {
			this.clearStatusIndicator();
			const result = await this.runtimeHost.importFromJsonl(inputPath);
			if (result.cancelled) {
				this.showStatus("Import cancelled");
				return;
			}
			this.showStatus(`Session imported from: ${inputPath}`);
		} catch (error: unknown) {
			if (error instanceof MissingSessionCwdError) {
				const selectedCwd = await this.promptForMissingSessionCwd(error);
				if (!selectedCwd) {
					this.showStatus("Import cancelled");
					return;
				}
				const result = await this.runtimeHost.importFromJsonl(inputPath, selectedCwd);
				if (result.cancelled) {
					this.showStatus("Import cancelled");
					return;
				}
				this.showStatus(`Session imported from: ${inputPath}`);
				return;
			}
			if (error instanceof SessionImportFileNotFoundError) {
				this.showError(`Failed to import session: ${error.message}`);
				return;
			}
			await this.handleFatalRuntimeError("Failed to import session", error);
		}
	}

	async handleShareCommand(): Promise<void> {
		this.showError("Session sharing is not available in this build.");
	}

	async handleCopyCommand(options: { flashConfirmation?: boolean; preferSelection?: boolean } = {}): Promise<void> {
		if (
			options.preferSelection &&
			this.ui instanceof TuiAltScreen &&
			!this.ui.getCopyOnSelect() &&
			this.ui.hasActiveSelection()
		) {
			await this.ui.copyActiveSelectionToClipboard();
			return;
		}

		const text = this.session.getLastAssistantText();
		if (!text) {
			this.showError("No agent messages to copy yet.");
			return;
		}

		try {
			await copyToClipboard(text);
			if (options.flashConfirmation && this.ui instanceof TuiAltScreen) {
				this.ui.flash("Copied!");
			} else {
				this.showStatus("Copied last agent message to clipboard");
			}
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	handleNameCommand(text: string): void {
		const name = text.replace(/^\/name\s*/, "").trim();
		if (!name) {
			const currentName = this.sessionManager.getSessionName();
			if (currentName) {
				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(new Text(theme.fg("dim", `Session name: ${currentName}`), 1, 0));
			} else {
				this.showWarning("Usage: /name <name>");
			}
			this.redraw.requestRender();
			return;
		}

		this.session.setSessionName(name);
		const sessionName = this.sessionManager.getSessionName();
		if (sessionName !== name) {
			this.showWarning(`Session name was normalized from ${JSON.stringify(name)} to ${JSON.stringify(sessionName)}`);
		}
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("dim", `Session name set: ${sessionName ?? name}`), 1, 0));
		this.redraw.requestRender();
	}

	handleSessionCommand(): void {
		const stats = this.session.getSessionStats();
		const sessionName = this.sessionManager.getSessionName();
		const entries = this.sessionManager.getEntries();
		const cacheWaste = computeCacheWaste(entries, this.session.modelRuntime);

		// Cost/token totals per provider/model actually used (e.g. OpenRouter `auto`
		// resolves to a concrete responseModel). Usage without model attribution is
		// grouped separately so the breakdown reconciles with the session total.
		const usageBreakdown = getUsageCostBreakdown(entries);

		let info = `${theme.bold("Session Info")}\n\n`;
		if (sessionName) {
			info += `${theme.fg("dim", "Name:")} ${sessionName}\n`;
		}
		info += `${theme.fg("dim", "File:")} ${stats.sessionFile ?? "In-memory"}\n`;
		info += `${theme.fg("dim", "ID:")} ${stats.sessionId}\n\n`;
		info += `${theme.bold("Messages")}\n`;
		info += `${theme.fg("dim", "Total:")} ${stats.totalMessages}\n`;
		info += `${theme.fg("dim", "User:")} ${stats.userMessages}\n`;
		info += `${theme.fg("dim", "Assistant:")} ${stats.assistantMessages}\n`;
		info += `${theme.fg("dim", "Tools:")} ${stats.toolCalls} calls, ${stats.toolResults} results\n\n`;
		info += `${theme.bold("Tokens")}\n`;
		// "Input" is the full prompt volume. With cache activity, split it into
		// cached (served from cache) vs uncached (everything else) - the only
		// provider-independent split. Cache writes, where reported, are a detail
		// of the uncached portion.
		const { input, cacheRead, cacheWrite } = stats.tokens;
		const promptTokens = input + cacheRead + cacheWrite;
		info += `${theme.fg("dim", "Input:")} ${promptTokens.toLocaleString()}\n`;
		if (promptTokens > 0 && (cacheRead > 0 || cacheWrite > 0)) {
			const hitRate = theme.fg("dim", `(${((cacheRead / promptTokens) * 100).toFixed(1)}%)`);
			info += `  ${theme.fg("dim", "Cached:")} ${cacheRead.toLocaleString()} ${hitRate}\n`;
			const written =
				cacheWrite > 0 ? ` ${theme.fg("dim", `(${cacheWrite.toLocaleString()} written to cache)`)}` : "";
			info += `  ${theme.fg("dim", "Uncached:")} ${(input + cacheWrite).toLocaleString()}${written}\n`;
		}
		info += `${theme.fg("dim", "Output:")} ${stats.tokens.output.toLocaleString()}\n`;
		info += `${theme.fg("dim", "Total:")} ${stats.tokens.total.toLocaleString()}\n`;

		if (stats.cost > 0 || cacheWaste.missedTokens > 0) {
			info += `\n${theme.bold("Cost")}\n`;
			info += `${theme.fg("dim", "Total:")} $${stats.cost.toFixed(3)}`;
			if (usageBreakdown.length > 1) {
				for (const entry of usageBreakdown) {
					info += `\n  ${theme.fg("dim", `${entry.key}:`)} $${entry.cost.toFixed(3)} ${theme.fg("dim", `(${formatTokens(entry.tokens)} tokens)`)}`;
				}
			}
			if (cacheWaste.missedTokens > 0) {
				const missLabel = cacheWaste.missCount === 1 ? "1 miss" : `${cacheWaste.missCount} misses`;
				const detail = `${cacheWaste.missedTokens.toLocaleString()} tokens, ${missLabel}`;
				info +=
					cacheWaste.missedCost >= 0.0001
						? `\n${theme.fg("dim", "Cache Re-billed:")} $${cacheWaste.missedCost.toFixed(3)} ${theme.fg("dim", `(${detail})`)}`
						: `\n${theme.fg("dim", "Cache Re-billed:")} ${detail}`;
			}
		}

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(info, 1, 0));
		this.redraw.requestRender();
	}

	/**
	 * Get capitalized display string for an app keybinding action.
	 */
	private getAppKeyDisplay(action: AppKeybinding): string {
		return keyDisplayText(action);
	}

	/**
	 * Get capitalized display string for an editor keybinding action.
	 */
	private getEditorKeyDisplay(action: Keybinding): string {
		return keyDisplayText(action);
	}

	handleHotkeysCommand(): void {
		// Navigation keybindings
		const cursorUp = this.getEditorKeyDisplay("tui.editor.cursorUp");
		const cursorDown = this.getEditorKeyDisplay("tui.editor.cursorDown");
		const cursorLeft = this.getEditorKeyDisplay("tui.editor.cursorLeft");
		const cursorRight = this.getEditorKeyDisplay("tui.editor.cursorRight");
		const cursorWordLeft = this.getEditorKeyDisplay("tui.editor.cursorWordLeft");
		const cursorWordRight = this.getEditorKeyDisplay("tui.editor.cursorWordRight");
		const cursorLineStart = this.getEditorKeyDisplay("tui.editor.cursorLineStart");
		const cursorLineEnd = this.getEditorKeyDisplay("tui.editor.cursorLineEnd");
		const jumpForward = this.getEditorKeyDisplay("tui.editor.jumpForward");
		const jumpBackward = this.getEditorKeyDisplay("tui.editor.jumpBackward");
		const pageUp = this.getEditorKeyDisplay("tui.editor.pageUp");
		const pageDown = this.getEditorKeyDisplay("tui.editor.pageDown");

		// Editing keybindings
		const submit = this.getEditorKeyDisplay("tui.input.submit");
		const newLine = this.getEditorKeyDisplay("tui.input.newLine");
		const deleteWordBackward = this.getEditorKeyDisplay("tui.editor.deleteWordBackward");
		const deleteWordForward = this.getEditorKeyDisplay("tui.editor.deleteWordForward");
		const deleteToLineStart = this.getEditorKeyDisplay("tui.editor.deleteToLineStart");
		const deleteToLineEnd = this.getEditorKeyDisplay("tui.editor.deleteToLineEnd");
		const yank = this.getEditorKeyDisplay("tui.editor.yank");
		const yankPop = this.getEditorKeyDisplay("tui.editor.yankPop");
		const undo = this.getEditorKeyDisplay("tui.editor.undo");
		const tab = this.getEditorKeyDisplay("tui.input.tab");

		// App keybindings
		const interrupt = this.getAppKeyDisplay("app.interrupt");
		const clear = this.getAppKeyDisplay("app.clear");
		const exit = this.getAppKeyDisplay("app.exit");
		const suspend = this.getAppKeyDisplay("app.suspend");
		const cycleThinkingLevel = this.getAppKeyDisplay("app.thinking.cycle");
		const cycleModelForward = this.getAppKeyDisplay("app.model.cycleForward");
		const selectModel = this.getAppKeyDisplay("app.model.select");
		const expandTools = this.getAppKeyDisplay("app.tools.expand");
		const toggleThinking = this.getAppKeyDisplay("app.thinking.toggle");
		const externalEditor = this.getAppKeyDisplay("app.editor.external");
		const cycleModelBackward = this.getAppKeyDisplay("app.model.cycleBackward");
		const copyMessage = this.getAppKeyDisplay("app.message.copy");
		const followUp = this.getAppKeyDisplay("app.message.followUp");
		const dequeue = this.getAppKeyDisplay("app.message.dequeue");
		const pasteImage = this.getAppKeyDisplay("app.clipboard.pasteImage");
		const followUpRow = followUp ? `| \`${followUp}\` | Queue follow-up message |\n` : "";

		let hotkeys = `
**Navigation**
| Key | Action |
|-----|--------|
| \`${cursorUp}\` / \`${cursorDown}\` / \`${cursorLeft}\` / \`${cursorRight}\` | Move cursor / browse history |
| \`${cursorWordLeft}\` / \`${cursorWordRight}\` | Move by word |
| \`${cursorLineStart}\` | Start of line |
| \`${cursorLineEnd}\` | End of line |
| \`${jumpForward}\` | Jump forward to character |
| \`${jumpBackward}\` | Jump backward to character |
| \`${pageUp}\` / \`${pageDown}\` | Scroll by page |

**Editing**
| Key | Action |
|-----|--------|
| \`${submit}\` | Send message |
| \`${newLine}\` | New line${process.platform === "win32" ? " (Ctrl+Enter on Windows Terminal)" : ""} |
| \`${deleteWordBackward}\` | Delete word backwards |
| \`${deleteWordForward}\` | Delete word forwards |
| \`${deleteToLineStart}\` | Delete to start of line |
| \`${deleteToLineEnd}\` | Delete to end of line |
| \`${yank}\` | Paste the most-recently-deleted text |
| \`${yankPop}\` | Cycle through the deleted text after pasting |
| \`${undo}\` | Undo |

**Other**
| Key | Action |
|-----|--------|
| \`${tab}\` | Path completion / accept autocomplete |
| \`${interrupt}\` | Cancel autocomplete / abort streaming |
| \`${clear}\` | Clear editor (first) / exit (second) |
| \`${exit}\` | Exit (when editor is empty) |
| \`${suspend}\` | Suspend to background |
| \`${cycleThinkingLevel}\` | Cycle thinking level |
| \`${cycleModelForward}\` / \`${cycleModelBackward}\` | Cycle models |
| \`${selectModel}\` | Open model selector |
| \`${expandTools}\` | Toggle tool output expansion |
| \`${toggleThinking}\` | Toggle thinking block visibility |
| \`${externalEditor}\` | Edit message in external editor |
| \`${copyMessage}\` | Copy last assistant message |
${followUpRow}| \`${dequeue}\` | Restore queued messages |
| \`${pasteImage}\` | Paste image or text from clipboard |
| \`/\` | Slash commands |
| \`!\` | Run bash command |
| \`!!\` | Run bash command (excluded from context) |
`;

		// Add extension-registered shortcuts
		const extensionRunner = this.session.extensionRunner;
		const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
		if (shortcuts.size > 0) {
			hotkeys += `
**Extensions**
| Key | Action |
|-----|--------|
`;
			for (const [key, shortcut] of shortcuts) {
				const description = shortcut.description ?? shortcut.extensionPath;
				const keyDisplay = formatKeyText(key, { capitalize: true });
				hotkeys += `| \`${keyDisplay}\` | ${description} |\n`;
			}
		}

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder());
		this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "Keyboard Shortcuts")), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Markdown(hotkeys.trim(), 1, 1, this.getMarkdownThemeWithSettings()));
		this.chatContainer.addChild(new DynamicBorder());
		this.redraw.requestRender();
	}

	async handleClearCommand(): Promise<void> {
		this.clearStatusIndicator();
		try {
			const result = await this.runtimeHost.newSession();
			if (result.cancelled) {
				return;
			}
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(`${theme.fg("accent", "✓ New session started")}`, 1, 1));
			this.redraw.requestRender();
		} catch (error: unknown) {
			await this.handleFatalRuntimeError("Failed to create session", error);
		}
	}

	handleDebugCommand(): void {
		const width = this.ui.terminal.columns;
		const height = this.ui.terminal.rows;
		const allLines = this.ui.render(width);

		const debugLogPath = path.join(this.agentDir, `${APP_NAME}-debug.log`);
		const debugData = [
			`Debug output at ${new Date().toISOString()}`,
			`Terminal: ${width}x${height}`,
			`Total lines: ${allLines.length}`,
			"",
			"=== All rendered lines with visible widths ===",
			...allLines.map((line, idx) => {
				const vw = visibleWidth(line);
				const escaped = JSON.stringify(line);
				return `[${idx}] (w=${vw}) ${escaped}`;
			}),
			"",
			"=== Agent messages (JSONL) ===",
			...this.session.messages.map((msg) => JSON.stringify(msg)),
			"",
		].join("\n");

		fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
		fs.writeFileSync(debugLogPath, debugData);

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new Text(`${theme.fg("accent", "✓ Debug log written")}\n${theme.fg("muted", debugLogPath)}`, 1, 1),
		);
		this.redraw.requestRender();
	}

	async handleBashCommand(command: string, excludeFromContext = false): Promise<void> {
		const extensionRunner = this.session.extensionRunner;

		// Emit user_bash event to let extensions intercept
		const eventResult = await extensionRunner.emitUserBash({
			type: "user_bash",
			command,
			excludeFromContext,
			cwd: this.sessionManager.getCwd(),
		});

		// If extension returned a full result, use it directly
		if (eventResult?.result) {
			const result = eventResult.result;

			// Create UI component for display
			this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext, this.presentation);
			if (this.session.isStreaming) {
				this.pendingMessagesContainer.addChild(this.bashComponent);
				this.pendingBashComponents.push(this.bashComponent);
			} else {
				this.chatContainer.addChild(this.bashComponent);
			}

			// Show output and complete
			if (result.output) {
				this.bashComponent.appendOutput(result.output);
			}
			this.bashComponent.setComplete(
				result.exitCode,
				result.cancelled,
				result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
				result.fullOutputPath,
			);

			// Record the result in session
			this.session.recordBashResult(command, result, { excludeFromContext });
			this.bashComponent = undefined;
			this.redraw.requestRender();
			return;
		}

		// Normal execution path (possibly with custom operations)
		const isDeferred = this.session.isStreaming;
		this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext, this.presentation);

		if (isDeferred) {
			// Show in pending area when agent is streaming
			this.pendingMessagesContainer.addChild(this.bashComponent);
			this.pendingBashComponents.push(this.bashComponent);
		} else {
			// Show in chat immediately when agent is idle
			this.chatContainer.addChild(this.bashComponent);
		}
		this.redraw.requestRender();

		try {
			const result = await this.session.executeBash(
				command,
				(chunk) => {
					if (this.bashComponent) {
						this.bashComponent.appendOutput(chunk);
						this.redraw.requestRender();
					}
				},
				{ excludeFromContext, operations: eventResult?.operations },
			);

			if (this.bashComponent) {
				this.bashComponent.setComplete(
					result.exitCode,
					result.cancelled,
					result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
					result.fullOutputPath,
				);
			}
		} catch (error) {
			if (this.bashComponent) {
				this.bashComponent.setComplete(undefined, false);
			}
			this.showError(`Bash command failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}

		this.bashComponent = undefined;
		this.redraw.requestRender();
	}

	async handleCompactCommand(customInstructions?: string): Promise<void> {
		this.clearStatusIndicator();

		try {
			await this.session.compact(customInstructions);
		} catch {
			// Ignore, will be emitted as an event
		}
	}

	stop(fullscreenExitOutput = this.settingsManager.getFullscreenExitOutput()): void {
		this.withExtensionDialogsBlocked(() => {
			this.stepWelcome?.dispose();
			this.stepSpinner?.dispose();
			if (this.defaultEditor instanceof StepEditor) this.defaultEditor.dispose();
			this.clearStatusIndicator();
			this.hideExtensionSelector();
			this.hideExtensionInput();
			this.disposeActiveSelector();
			if (this.settingsManager.getShowTerminalProgress()) {
				this.ui.terminal.setProgress(false);
			}
			this.themeController.disableAutoSync();
			this.clearExtensionTerminalInputListeners();
			this.footer.dispose();
			this.footerDataProvider.dispose();
			if (this.unsubscribe) {
				this.unsubscribe();
			}
			if (this.isInitialized) {
				this.stopInteractiveTui(fullscreenExitOutput);
				this.isInitialized = false;
			}
			this.unregisterSignalHandlers();
		});
	}
}
