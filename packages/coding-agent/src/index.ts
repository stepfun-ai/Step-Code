// Core session management

export { type Args, type Mode, parseArgs } from "./cli/args.ts";
// -----------------------------------------------------------------------------
// S4-0 barrel widening: symbols consumed by the interactive UI that moved to the
// product shell (@step-harness/cli). Adding named exports to the existing "."
// subpath is allowed by the entry-freeze gate (only subpath/bin KEYS are frozen).
// -----------------------------------------------------------------------------
export { getAuthCredential } from "./cli/auth-command.ts";
// BorderedLoader and CustomEditor stay resident in this package (consumed by
// coding-agent examples/extensions via the barrel); re-export them so external
// barrel consumers keep working after the interactive UI moved to the shell.
export { BorderedLoader } from "./components/bordered-loader.ts";
export { CustomEditor } from "./components/custom-editor.ts";
// Config paths
export {
	APP_NAME,
	APP_TITLE,
	CONFIG_DIR_NAME,
	ENV_AGENT_DIR,
	getAgentDir,
	getBundledInteractiveAssetPath,
	getDocsPath,
	getExamplesPath,
	getPackageDir,
	getReadmePath,
	getSettingsPath,
	IS_STEP_ENTRYPOINT,
	PACKAGE_NAME,
	VERSION,
} from "./config.ts";
export {
	AgentSession,
	type AgentSessionConfig,
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type ModelCycleResult,
	type ParsedSkillBlock,
	type PromptOptions,
	parseSkillBlock,
	type SessionStats,
} from "./core/agent-session.ts";
export { SessionImportFileNotFoundError } from "./core/agent-session-runtime.ts";
export { readStoredCredential } from "./core/auth-storage.ts";
export {
	CACHE_TTL_MS,
	type CacheMiss,
	collectCacheMisses,
	computeCacheWaste,
	detectCacheMiss,
} from "./core/cache-stats.ts";
// Compaction
export {
	type BranchPreparation,
	type BranchSummaryResult,
	type CollectEntriesResult,
	type CompactionResult,
	type CutPointResult,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateTokens,
	type FileOperations,
	findCutPoint,
	findTurnStartIndex,
	type GenerateBranchSummaryOptions,
	generateBranchSummary,
	generateSummary,
	generateSummaryWithUsage,
	getLastAssistantUsage,
	prepareBranchEntries,
	serializeConversation,
	shouldCompact,
} from "./core/compaction/index.ts";
export { DEFAULT_THINKING_LEVEL, THINKING_LEVEL_OPTIONS } from "./core/defaults.ts";
export {
	createEventBus,
	type EventBus,
	type EventBusController,
} from "./core/event-bus.ts";
// Extension system
export type {
	AgentEndEvent,
	AgentSettledEvent,
	AgentStartEvent,
	AgentToolResult,
	AgentToolUpdateCallback,
	AppKeybinding,
	AutocompleteProviderFactory,
	BashToolCallEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeProviderHeadersEvent,
	BeforeProviderRequestEvent,
	BeforeProviderRequestEventResult,
	BuildSystemPromptOptions,
	CompactOptions,
	ContextEvent,
	ContextUsage,
	CustomToolCallEvent,
	EditorFactory,
	EditToolCallEvent,
	EntryRenderer,
	EntryRenderOptions,
	ExecOptions,
	ExecResult,
	Extension,
	ExtensionActions,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionContextActions,
	ExtensionError,
	ExtensionEvent,
	ExtensionFactory,
	ExtensionFlag,
	ExtensionHandler,
	ExtensionNotifyOptions,
	ExtensionRuntime,
	ExtensionShortcut,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	FindToolCallEvent,
	GrepToolCallEvent,
	InlineExtension,
	InputEvent,
	InputEventResult,
	InputSource,
	LoadExtensionsResult,
	LsToolCallEvent,
	MarkdownTransformContext,
	MarkdownTransformer,
	MessageEndEvent,
	MessageRenderer,
	MessageRenderOptions,
	MessageStartEvent,
	MessageUpdateEvent,
	PowerShellToolCallEvent,
	ProjectTrustContext,
	ProjectTrustEvent,
	ProjectTrustEventDecision,
	ProjectTrustEventResult,
	ProjectTrustHandler,
	ProviderConfig,
	ProviderModelConfig,
	ReadToolCallEvent,
	RegisteredCommand,
	RegisteredTool,
	ResolvedCommand,
	SessionBeforeCompactEvent,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionBeforeTreeEvent,
	SessionCompactEvent,
	SessionInfoChangedEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	SessionTreeEvent,
	SlashCommandInfo,
	SlashCommandSource,
	SourceInfo,
	TerminalInputHandler,
	ToolCallEvent,
	ToolCallEventResult,
	ToolDefinition,
	ToolExecutionEndEvent,
	ToolExecutionMode,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	ToolInfo,
	ToolRenderResultOptions,
	ToolResultEvent,
	TurnEndEvent,
	TurnStartEvent,
	UIPromptEndEvent,
	UIPromptKind,
	UIPromptStartEvent,
	UserBashEvent,
	UserBashEventResult,
	WidgetPlacement,
	WorkingIndicatorOptions,
	WriteToolCallEvent,
} from "./core/extensions/index.ts";
export {
	createExtensionRuntime,
	defineTool,
	discoverAndLoadExtensions,
	ExtensionRunner,
	isBashToolResult,
	isEditToolResult,
	isFindToolResult,
	isGrepToolResult,
	isLsToolResult,
	isPowerShellToolResult,
	isReadToolResult,
	isToolCallEventType,
	isWriteToolResult,
	wrapRegisteredTool,
	wrapRegisteredTools,
} from "./core/extensions/index.ts";
export type { ToolRenderContext } from "./core/extensions/types.ts";
// Footer data provider (git branch + extension statuses - data not otherwise available to extensions)
export type { ReadonlyFooterDataProvider } from "./core/footer-data-provider.ts";
export { FooterDataProvider } from "./core/footer-data-provider.ts";
// -----------------------------------------------------------------------------
// Entry-composition surface (S3).
//
// The process entry, argv dispatch and mode selection now live in the
// @step-harness/cli app. These are the product-side pieces that the app's
// composition root imports to build MainOptions, resolve the run mode, and run
// its own dispatch switch. They stay in this product package (product
// behaviour, not shell), and are re-exported through the single "." export
// subpath (no new export subpath, so the entry-freeze gate stays green).
//
// restoreStdout / stopThemeWatcher operate on module-global state
// owned here (the stdout takeover installed by prepareMain,
// and the theme file watcher). The shell MUST call these exported functions
// rather than reimplement them, or it would act on empty/detached local state.
// -----------------------------------------------------------------------------
export { configureHttpDispatcher, formatHttpIdleTimeoutMs, HTTP_IDLE_TIMEOUT_CHOICES } from "./core/http-dispatcher.ts";
export { KeybindingsManager } from "./core/keybindings.ts";
export {
	type BranchSummaryMessage,
	type CompactionSummaryMessage,
	type CustomMessage,
	convertToLlm,
	createCompactionSummaryMessage,
} from "./core/messages.ts";
export { ModelRegistry } from "./core/model-registry.ts";
export {
	type ModelRequestCompleted,
	type ModelRequestObserver,
	type ModelRequestOutcome,
	type ModelRequestStarted,
	type ModelRequestUsage,
	type ObserveModelRequestFailureOptions,
	type ObserveModelRequestStreamOptions,
	observeModelRequestFailure,
	observeModelRequestStream,
} from "./core/model-request-observer.ts";
export {
	defaultModelPerProvider,
	findExactModelReferenceMatch,
	type ModelScopeDiagnostic,
	type ResolveCliModelResult,
	type ResolveModelScopeResult,
	resolveCliModel,
	resolveModelScopeFromModels,
	resolveModelScopeWithDiagnostics,
	type ScopedModel,
} from "./core/model-resolver.ts";
export {
	type CreateModelRuntimeOptions,
	CredentialSynchronizationError,
	type CredentialSynchronizationOperation,
	ModelRuntime,
	type ModelRuntimeAuthOverrides,
} from "./core/model-runtime.ts";
export { restoreStdout } from "./core/output-guard.ts";
export type {
	PackageManager,
	PathMetadata,
	ProgressCallback,
	ProgressEvent,
	ResolvedPaths,
	ResolvedResource,
} from "./core/package-manager.ts";
export { DefaultPackageManager } from "./core/package-manager.ts";
export type { AppMode } from "./core/project-trust.ts";
export type {
	ResourceCollision,
	ResourceDiagnostic,
	ResourceLoader,
} from "./core/resource-loader.ts";
export {
	DefaultResourceLoader,
	loadProjectContextFiles,
} from "./core/resource-loader.ts";
// SDK for programmatic usage
export {
	AgentSessionRuntime,
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionRuntimeHost,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	type CreateAgentSessionRuntimeFactory,
	type CreateAgentSessionRuntimeResult,
	type CreateAgentSessionServicesOptions,
	// Factory
	createAgentSession,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createBashTool,
	// Tool factories (for custom cwd)
	createCodingTools,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createPowerShellTool,
	createReadOnlyTools,
	createReadTool,
	createWriteTool,
	type PromptTemplate,
} from "./core/sdk.ts";
export { formatMissingSessionCwdPrompt, MissingSessionCwdError } from "./core/session-cwd.ts";
export { exportSessionToJsonl } from "./core/session-export.ts";
export type { SessionListProgress } from "./core/session-manager.ts";
export {
	type BranchSummaryEntry,
	buildContextEntries,
	buildSessionContext,
	type CompactionEntry,
	CURRENT_SESSION_VERSION,
	type CustomEntry,
	type CustomMessageEntry,
	type FileEntry,
	getLatestCompactionEntry,
	type ModelChangeEntry,
	migrateSessionEntries,
	type NewSessionOptions,
	parseSessionEntries,
	type SessionContext,
	type SessionEntry,
	type SessionEntryBase,
	type SessionHeader,
	type SessionInfo,
	type SessionInfoEntry,
	SessionManager,
	type SessionMessageEntry,
	type SessionTreeNode,
	sessionEntryToContextMessages,
	type ThinkingLevelChangeEntry,
} from "./core/session-manager.ts";
export {
	nativeSessionManagerFactory,
	type SessionManagerFactory,
} from "./core/session-manager-factory.ts";
export type { MermaidRenderingMode, WarningSettings } from "./core/settings-manager.ts";
export {
	type CompactionSettings,
	type DefaultProjectTrust,
	type FullscreenExitOutput,
	type ImageSettings,
	type PackageSource,
	type RetrySettings,
	SettingsManager,
	type SettingsManagerCreateOptions,
	type TuiMode,
} from "./core/settings-manager.ts";
// Skills
export {
	formatSkillsForPrompt,
	type LoadSkillsFromDirOptions,
	type LoadSkillsResult,
	loadSkills,
	loadSkillsFromDir,
	type Skill,
	type SkillFrontmatter,
} from "./core/skills.ts";
export { BUILTIN_SLASH_COMMANDS } from "./core/slash-commands.ts";
export { createSyntheticSourceInfo } from "./core/source-info.ts";
export {
	type EditDiffResult,
	generateDiffString,
	generateUnifiedPatch,
} from "./core/tools/edit-diff.ts";
// Tools
export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createAllToolDefinitions,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLocalBashOperations,
	createLocalPowerShellOperations,
	createLsToolDefinition,
	createPowerShellToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
	formatSize,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
	type PowerShellOperations,
	type PowerShellSpawnContext,
	type PowerShellSpawnHook,
	type PowerShellToolDetails,
	type PowerShellToolInput,
	type PowerShellToolOptions,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
	type ToolName,
	type ToolsOptions,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
	withFileMutationQueue,
} from "./core/tools/index.ts";
export { getTextOutput, renderToolPath, replaceTabs } from "./core/tools/render-utils.ts";
export {
	getProjectTrustOptions,
	hasTrustRequiringProjectResources,
	type ProjectTrustDecision,
	type ProjectTrustOption,
	ProjectTrustStore,
	type ProjectTrustStoreEntry,
	type ProjectTrustUpdate,
} from "./core/trust-manager.ts";
export { addUsageToTotals, createUsageTotals, getUsageCostBreakdown } from "./core/usage-totals.ts";
export {
	createStepExtension,
	createStepExtensionInline,
	type StepExtensionOptions,
	stepExtension,
	stepExtensionInline,
} from "./features/step.ts";
export { createStepCapabilitiesExtensionInline } from "./features/step-capabilities.ts";
export {
	type CronCreateResult,
	type CronDelivery,
	CronFileStore,
	type CronFileStoreOptions,
	type CronJob,
	createStepCronExtension,
	SimpleCronExpression,
	type StepCronExtensionOptions,
	StepCronRuntime,
	type StepCronRuntimeOptions,
	stepCronExtensionInline,
} from "./features/step-cron.ts";
export { createStepProviderConfig, STEP_PROVIDER_ID } from "./features/step-provider/index.ts";
export {
	CreateGoalParams,
	continuationPrompt,
	createStepGoalExtension,
	createStepScheduleExtension,
	GetGoalParams,
	type GoalContinuation,
	getStepGoalStatus,
	type StepGoalClearSnapshot,
	type StepGoalExtensionOptions,
	type StepGoalRecord,
	type StepGoalRestoreResult,
	StepGoalRuntime,
	type StepGoalRuntimeOptions,
	type StepGoalSnapshot,
	type StepGoalStatus,
	stepGoalExtensionInline,
	stepScheduleExtensionInline,
	UpdateGoalParams,
} from "./features/step-schedule.ts";
export {
	isChildAgentSessionId,
	SUBAGENT_SESSION_ID_PREFIX,
	WORKFLOW_SESSION_ID_PREFIX,
} from "./features/step-subagent.ts";
// Optional Step Workflow capability. The extension remains feature-gated at
// registration time, while the pure runtime contracts are useful to embedders
// and tests.
export * from "./features/workflow/index.ts";
// Main entry point
export {
	type MainOptions,
	type MainPreparation,
	main,
	prepareMain,
	resolveAppMode,
	toPrintOutputMode,
} from "./main.ts";
// Run modes for programmatic SDK usage
export {
	type JsonAgentSessionEvent,
	type ModelInfo,
	type PrintModeOptions,
	RpcClient,
	type RpcClientOptions,
	type RpcCommand,
	type RpcEventListener,
	type RpcExtensionUIRequest,
	type RpcExtensionUIResponse,
	type RpcResponse,
	type RpcSessionState,
	runPrintMode,
	runRpcMode,
} from "./modes/index.ts";
// Interactive UI contract. The interactive UI itself lives in the product shell
// (@step-harness/cli); this package only describes it so MainOptions and the
// injected startup selectors can be typed without a reverse dependency.
export type {
	ConfigSelectorOptions,
	InteractiveModeOptions,
	InteractiveStartupContext,
	ScopedResolvedPaths,
	SessionsLoader,
	StartupTuiPathOptions,
	StartupUiHooks,
} from "./modes/interactive-contract.ts";
// Render helpers used by extensions and by the moved interactive UI. Re-exported
// directly from ./render/* (which stays in this package) so external barrel
// consumers keep working after the UI components moved to the shell.
export { type RenderDiffOptions, renderDiff } from "./render/diff.ts";
export { DynamicBorder } from "./render/dynamic-border.ts";
export { formatKeyText, keyDisplayText, keyHint, keyText, rawKeyHint } from "./render/keybinding-hints.ts";
export { truncateToVisualLines, type VisualTruncateResult } from "./render/visual-truncate.ts";
export {
	getLegacyStepAuthPath,
	getStepAuthPath,
	logoutStepCredentials,
	migrateLegacyStepCredential,
} from "./step/auth.ts";
export {
	isStepConfigCommand,
	normalizeStepSessionSelectorArgs,
	parseStepUpdateCommand,
	runStepConfigCommand,
	translateStepCommandArgs,
} from "./step/command-compat.ts";
export {
	ensureStepConfigFile,
	ensureStepGlobalConfig,
	readGlobalStepConfig,
	readGlobalStepDefaults,
	readStepConfig,
	resolveStepConfigPath,
	STEP_CONFIG_FILE_NAME,
	type StepConfigDocument,
	type StepGlobalDefaults,
	type StepMcpServerConfig,
	updateGlobalMcpConfig,
	updateGlobalStepConfig,
} from "./step/config-toml.ts";
export {
	getStepDefaultTheme,
	isStepServicesDisabled,
	STEP_DEFAULT_MODEL,
	STEP_DEFAULT_PROVIDER,
	withStepDefaults,
} from "./step/defaults.ts";
export {
	readOrCreateStepDeviceId,
	readStepDeviceId,
	resolveStepDeviceIdPath,
	resolveStepStorageRoot,
	type StepDeviceIdResult,
} from "./step/device-id.ts";
export {
	applyStepEnvironment,
	getStepSessionDirOverride,
	LEGACY_RENAMED_CONFIG_DIR,
	resolveStepAgentDir,
	resolveStepConfigDir,
	resolveStepConfigRoot,
	resolveStepHomeDir,
	resolveStepSessionDir,
	STEPCODE_CONFIG_DIR,
	type StepEnvironmentOptions,
} from "./step/environment.ts";
export { runFeedbackCommand } from "./step/feedback/command.ts";
export { readFeedbackUsername } from "./step/feedback/context.ts";
export { STEP_INIT_PROMPT } from "./step/init-prompt.ts";
export { maybeUpdateStep, runStepUpdateCommand } from "./step/local-update.ts";
export {
	isStepInteractiveLoginStartup,
	needsStepLoginBeforeInteractive,
	readStepLoginCredential,
	readStepLoginProfile,
	runStepLogin,
	type StepLoginHost,
	type StepLoginOutcome,
	syncStepLoginProfileEndpoint,
} from "./step/login-flow.ts";
export {
	getStepLoginStatus,
	type StepCredentialValidity,
	type StepLoginMethod,
	type StepLoginStatus,
} from "./step/login-status.ts";
export { describeStepMcpImportOutcome, runStepMcpImportPrompt } from "./step/mcp-import-prompt.ts";
export { hasStoredMcpOAuthCredential, loginMcpServer, logoutMcpServer } from "./step/mcp-oauth.ts";
export { resolveStepLoginProfiles } from "./step/onboarding.ts";
export {
	AUTO_RESUME_PROMPT,
	decideStepToolCall,
	getStepPermissionPreset,
	isDangerousCommand,
	normalizeAutoResume,
	normalizeStepPermissionMode,
	publishStepPermissionStatus,
	resolveInitialStepPermissionPreset,
	resolveInitialStepPermissionState,
	STEP_PERMISSION_PRESETS,
	StepAutoResumeController,
	type StepAutoResumeControllerOptions,
	type StepNonInteractiveApproval,
	StepPermissionController,
	type StepPermissionControllerOptions,
	type StepPermissionMode,
	type StepPermissionPreset,
	type StepPermissionPresetId,
	type StepPermissionState,
	type StepToolDecision,
	type StepToolPermissionMode,
	stepPermissionStateForPreset,
} from "./step/permissions.ts";
export {
	type CreateStepAgentSessionOptions,
	type CreateStepAgentSessionServicesOptions,
	createStepAgentSession,
	createStepAgentSessionServices,
	type StepAgentSessionServices,
} from "./step/sdk.ts";
export {
	continueStepSession,
	createStepSessionManager,
	createStepSessionManagerFactory,
	forkStepSession,
	getStepDefaultSessionDir,
	isStepSessionManager,
	listAllStepSessions,
	listStepSessions,
	openStepSession,
	type StepOpenSessionOptions,
	StepSessionManager,
	type StepSessionManagerFacade,
	type StepSessionManagerOptions,
	type StepSessionManagerWrapOptions,
	type StepSessionPathOptions,
	type StepSessionQueryOptions,
	wrapStepSessionManager,
} from "./step/session.ts";
export {
	createStepSettingsManager,
	decorateStepSettingsManager,
	type StepSettings,
	type StepSettingsDecoratorOptions,
	type StepSettingsManager,
	type StepSettingsManagerCreateOptions,
	type StepSettingsPaths,
} from "./step/settings-manager.ts";
export {
	flushStderrDevLog,
	installProcessStderrDevLogCapture,
	setStderrDevLogStorageRootDirectory,
} from "./step/stderr-dev-log.ts";
export type {
	PiHarnessEvent,
	PiHarnessEventBridge,
	PiHarnessEventBridgeOptions,
	PiHarnessEventFrame,
	PiHarnessEventSource,
	PiHarnessInputCommand,
	PiHarnessInputOptions,
	ProtocolFrame,
	SdkStdioFrame,
	SdkStdioFrameKind,
	SdkStdioProtocolError,
	StepFrame,
	StepFrameKind,
	StepJsonValue,
	StepProtocolError,
} from "./step/stdio.ts";
export {
	createPiHarnessEventBridge,
	encodeFrame,
	encodeSdkStdioFrame,
	encodeStepStdioFrame,
	FrameDecoder,
	isSdkStdioFrame,
	isStepStdioFrame,
	SDK_STDIO_MAX_FRAME_BYTES,
	SDK_STDIO_PROTOCOL_NAME,
	SDK_STDIO_PROTOCOL_VERSION,
	SdkStdioFrameDecoder,
	SdkStdioProtocolViolation,
	STEP_LENGTH_PREFIX_BYTES,
	STEP_MAX_FRAME_BYTES,
	STEP_PROTOCOL_NAME,
	STEP_PROTOCOL_VERSION,
	StepStdioFrameDecoder,
	StepStdioProtocolViolation,
} from "./step/stdio.ts";
export { StepStdioHost, type StepStdioHostOptions } from "./step/stdio-host.ts";
export {
	applyStepCodeConfigDefaults,
	createStepCodeProviderInlineExtension,
	decorateStepCodeSettingsManager,
	hasConfiguredStepCodeCredential,
	loadStepCodeConfig,
	type StepCodeConfig,
} from "./step/stepcode-config.ts";
export { buildStepSystemPromptAppendix } from "./step/system-prompt.ts";
export {
	classifyStepEndpoint,
	type StepModelRequestEventName,
	type StepPermissionApprovalTelemetry,
	type StepPermissionDecisionTelemetry,
	type StepTelemetryContextPatch,
	type StepTelemetryEventName,
	type StepTelemetryPrimitive,
	type StepTelemetryProperties,
	type StepTelemetryReporter,
	trackStepTelemetry,
} from "./step/telemetry.ts";
export {
	NOOP_OBSERVABILITY_PROVIDER,
	type StepObservabilityConfig,
	type StepObservabilityProvider,
	type TraceHeaderPolicy,
} from "./step/telemetry-contract.ts";
export {
	isKnownStepTelemetryEvent,
	STEP_TELEMETRY_EVENT_NAMES,
	STEP_TELEMETRY_EVENT_PROPERTY_NAMES,
	type StepTelemetryEventPayloads,
	type StepTelemetryKnownEventName,
} from "./step/telemetry-events.ts";
export { buildStepThemeOptions, runStepThemePrompt, type StepThemeOption } from "./step/theme-prompt.ts";
export { createStepToolProfile } from "./step/tool-profile.ts";
export { resolveStepTraceHeaderBaseUrls } from "./step/trace-headers.ts";
export {
	resolveStepCodeVersion,
	STEPCODE_BUILD_VERSION_ENV,
	STEPCODE_VERSION,
	STEPCODE_VERSION_OVERRIDE_ENV,
	type StepCodeVersion,
} from "./step/version.ts";
// Step product facade. It delegates lifecycle and input handling to pi.
export {
	createStepCode,
	type StepCode,
	type StepCodeSession,
} from "./stepcode-runtime.ts";
// Theme utilities for custom tools and extensions
export {
	detectTerminalBackgroundFromEnv,
	detectTerminalThemeForAuto,
	getAvailableThemes,
	getAvailableThemesWithPaths,
	getEditorTheme,
	getLanguageFromPath,
	getMarkdownTheme,
	getSelectListTheme,
	getSettingsListTheme,
	getThemeByName,
	highlightCode,
	initTheme,
	loadThemeFromPath,
	onThemeChange,
	parseAutoThemeSetting,
	resolveThemeSetting,
	setRegisteredThemes,
	setTheme,
	setThemeStorageDir,
	stopThemeWatcher,
	type TerminalTheme,
	Theme,
	type ThemeColor,
	theme,
} from "./theme/theme.ts";
export { InteractiveThemeController } from "./theme/theme-controller.ts";
export { raceWithAbortSignal } from "./utils/abort.ts";
export { stripAnsi } from "./utils/ansi.ts";
export { getChangelogPath, getNewEntries, normalizeChangelogLinks, parseChangelog } from "./utils/changelog.ts";
// Clipboard utilities
export { copyToClipboard, readClipboardText } from "./utils/clipboard.ts";
export {
	cleanPastedPath,
	extensionForImageMimeType,
	isImageFilePath,
	isWindowsPath,
	readClipboardImage,
	readClipboardImagePath,
	wslPathToPosix,
} from "./utils/clipboard-image.ts";
export { parseFrontmatter, stripFrontmatter } from "./utils/frontmatter.ts";
export { parseGitUrl } from "./utils/git.ts";
export { convertToPng } from "./utils/image-convert.ts";
export { imageFileToContent } from "./utils/image-process.ts";
export {
	formatDimensionNote,
	type ResizedImage,
	resizeImage,
} from "./utils/image-resize.ts";
export { detectSupportedImageMimeTypeFromFile } from "./utils/mime.ts";
export { openBrowser } from "./utils/open-browser.ts";
export { canonicalizePath, getCwdRelativePath, isLocalPath, resolvePath } from "./utils/paths.ts";
export { getPiUserAgent } from "./utils/pi-user-agent.ts";
// Shell utilities
export { getPowerShellConfig, getShellConfig, killTrackedDetachedChildren } from "./utils/shell.ts";
export { loadAllHighlightLanguages } from "./utils/syntax-highlight.ts";
export { stripBom } from "./utils/text.ts";
export { formatElapsedTime } from "./utils/time.ts";
export { ensureTool, type ToolStatus } from "./utils/tools-manager.ts";
