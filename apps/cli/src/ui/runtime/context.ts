/**
 * context.ts — the RuntimeContext seam for the interactive runtime (S4-1).
 *
 * The runtime slices (redraw, interrupt, input-dispatch, session-events, approval,
 * runInteractiveRuntime) are moved out of the InteractiveMode monolith as free functions
 * that receive this context object instead of `this`. InteractiveMode remains the living
 * state-holder (界面瞬时态 + session-continuity invariants live on it); the runtime reads
 * and writes them through this interface.
 *
 * Layer rule: this type lives in ui/runtime so the runtime never imports the ui host root
 * (interactive-mode.ts). InteractiveMode structurally satisfies RuntimeContext at the call
 * sites (`handleEscape(this)` etc.), which is why the members it exposes are public.
 *
 * The context is a *live view* of the host, not a value copy: reassigned scalars
 * (lastEscapeTime, isBashMode, and in later steps streamingComponent/streamingMessage) are
 * plain mutable members, so a write through the context mutates the one instance the
 * composition root owns — no getter/setter holder indirection and, critically, no value
 * copy that would desync continuity state.
 *
 * This interface grows per step; S4-2/S4-3 will re-type it toward ViewRenderer/UiState
 * without touching the call sites.
 */

import type { AgentMessage } from "@step-harness/agent-core";
import type {
	AgentSession,
	CustomEditor,
	ExtensionUIDialogOptions,
	InteractiveModeOptions,
	MarkdownTransformer,
	SessionEntry,
} from "@step-harness/coding-agent";
import type { Container, EditorComponent, MarkdownTheme, TUI, TuiAltScreen, TuiMainScreen } from "@step-harness/pi-tui";
import type { ImageContent } from "@step-harness/providers";
import type { AssistantMessage, Usage } from "@step-harness/providers/compat";
import type {
	AssistantMessageComponent,
	FooterComponent,
	StatusIndicator,
	StatusTipRotator,
	StepToolSpinnerClock,
	StepWelcomeComponent,
	ToolExecutionComponent,
	WorkingOutputTracker,
} from "../view/index.ts";
import type { PastedImageRegistry } from "./pasted-images.ts";

/** Which goal state the tip pool should teach for. */
export type GoalTipState = "active" | "paused" | "none";

import type { Redraw } from "./redraw.ts";

export interface RuntimeContext {
	// --- host queries (opaque, read-only handles) ---
	readonly session: AgentSession;
	readonly settingsManager: AgentSession["settingsManager"];
	readonly editor: EditorComponent;
	readonly defaultEditor: CustomEditor;
	readonly ui: TUI;
	readonly renderer: TuiMainScreen | TuiAltScreen;
	readonly stepWelcome: StepWelcomeComponent | undefined;
	readonly options: InteractiveModeOptions;
	readonly redraw: Redraw;

	// --- interrupt state (mutable; owned by the host, mutated in place) ---
	lastEscapeTime: number;
	lastSigintTime: number;
	isBashMode: boolean;
	isBashExcluded: boolean;
	autoCompactionEscapeHandler?: () => void;
	retryEscapeHandler?: () => void;

	// --- input pump (owned by the host / composition root) ---
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
	// Pasted-image placeholder registry: paste inserts `[Image #N]` and records the
	// file path here; a message resolves its placeholders to attachments on send.
	readonly pastedImages: PastedImageRegistry;

	// --- session-events surface (STEP 4): view handles + continuity state + host behaviors ---
	readonly footer: FooterComponent;
	readonly chatContainer: Container;
	readonly sessionManager: AgentSession["sessionManager"];
	readonly presentation: "native" | "step";
	readonly workingOutputTracker: WorkingOutputTracker;
	// Redesign turn-cadence state — mutated in place through the live ctx (ctx IS the host).
	// turnEndedAbnormally: agent_start resets it, message_end sets it on aborted/error,
	// agent_end reads it to suppress the turn-done marker.
	turnEndedAbnormally: boolean;
	// statusTipRotator: lazily built at turn_start; currentStatusTip is the per-turn tip
	// read back by the host's showWorkingStatusIndicator().
	statusTipRotator: StatusTipRotator | undefined;
	currentStatusTip: string | undefined;
	/** Latest persisted goal status for the state-aware tip pool. */
	readGoalTipState(): GoalTipState;
	readonly pendingTools: Map<string, ToolExecutionComponent>;
	readonly stepSpinner: StepToolSpinnerClock | undefined;
	readonly workingVisible: boolean;
	readonly activeStatusIndicator: StatusIndicator | undefined;
	readonly hideThinkingBlock: boolean;
	readonly hiddenThinkingLabel: string;
	readonly outputPad: number;
	readonly toolOutputExpanded: boolean;
	readonly isInitialized: boolean;
	unsubscribe?: () => void;
	// host-owned session-continuity invariants — reassigned scalars shared by reference (ctx IS the host)
	streamingComponent: AssistantMessageComponent | undefined;
	streamingMessage: AssistantMessage | undefined;

	init(): Promise<void>;
	addCustomEntryToChat(entry: Extract<SessionEntry, { type: "custom" }>): void;
	updateTerminalTitle(): void;
	addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void;
	createAssistantMessageComponent(
		message?: AssistantMessage,
		hideThinkingBlock?: boolean,
		markdownTheme?: MarkdownTheme,
		hiddenThinkingLabel?: string,
		outputPad?: number,
		markdownTransformers?: readonly MarkdownTransformer[],
	): AssistantMessageComponent;
	getMarkdownThemeWithSettings(): MarkdownTheme;
	getMarkdownTransformers(): MarkdownTransformer[];
	getRegisteredToolDefinition(toolName: string): ReturnType<AgentSession["getToolDefinition"]>;
	maybeShowCacheMissNotice(message: AssistantMessage): void;
	checkShutdownRequested(): Promise<void>;
	showStatusIndicator(indicator: StatusIndicator): void;
	showWorkingStatusIndicator(): void;
	showTurnDoneIndicator(durationSeconds: number): void;
	clearStatusIndicator(kind?: StatusIndicator["kind"]): void;
	showError(errorMessage: string): void;
	renderSessionEntries(entries: SessionEntry[], options?: { updateFooter?: boolean; populateHistory?: boolean }): void;
	addCompactionCostNotice(notice: {
		type: "compaction_cost";
		kind: "compaction" | "branch_summary";
		usage: Usage;
	}): void;
	flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void>;
	showExtensionConfirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>;

	// --- host behaviors the runtime invokes (stay on the host) ---
	restoreQueuedMessagesToEditor(options?: { abort?: boolean; currentText?: string }): number;
	updateEditorBorderColor(): void;
	showTreeSelector(initialSelectedId?: string): void;
	showUserMessageSelector(): void;
	clearEditor(): void;
	shutdown(options?: { fromSignal?: boolean }): Promise<void>;

	// --- injected host callbacks: key-action verbs + slash-command targets (S4-2 commands wiring deferred) ---
	cycleModel(direction: "forward" | "backward"): Promise<void>;
	cycleThinkingLevel(): void;
	flushPendingBashComponents(): void;
	getAllQueuedMessages(): { steering: string[]; followUp: string[] };
	handleBashCommand(command: string, excludeFromContext?: boolean): Promise<void>;
	handleClearCommand(): Promise<void>;
	handleClipboardPaste(imageOnly?: boolean): Promise<void>;
	handleCloneCommand(): Promise<void>;
	handleCompactCommand(customInstructions?: string): Promise<void>;
	handleCopyCommand(options?: { flashConfirmation?: boolean; preferSelection?: boolean }): Promise<void>;
	handleCtrlC(): void;
	handleCtrlD(): void;
	handleCtrlZ(): void;
	handleDebugCommand(): void;
	handleDequeue(): void;
	handleExportCommand(text: string): Promise<void>;
	handleFollowUp(): Promise<void>;
	handleHotkeysCommand(): void;
	handleImportCommand(text: string): Promise<void>;
	handleLoginCommand(providerRef?: string): Promise<void>;
	handleModelCommand(searchTerm?: string): Promise<void>;
	handleNameCommand(text: string): void;
	handleOpenExternalEditor(): Promise<void>;
	handleReloadCommand(): Promise<void>;
	handleSessionCommand(): void;
	handleShareCommand(): Promise<void>;
	handleStepLogoutCommand(): Promise<void>;
	handleThinkingCommand(searchTerm?: string): void;
	isExtensionCommand(text: string): boolean;
	queueCompactionMessage(text: string, mode: "steer" | "followUp", images?: ImageContent[]): void;
	showModelSelector(initialSearchInput?: string): void;
	addCommandInputToChat(text: string): void;
	getUnknownSlashCommandName(text: string): string | undefined;
	showModelsSelector(): void;
	showOAuthSelector(mode: "login" | "logout"): Promise<void>;
	showSessionSelector(): void;
	showSettingsSelector(): void;
	showStatus(message: string): void;
	showTrustSelector(): void;
	showWarning(warningMessage: string): void;
	toggleThinkingBlockVisibility(): void;
	toggleToolOutputExpansion(): void;
	updatePendingMessagesDisplay(): void;
}
