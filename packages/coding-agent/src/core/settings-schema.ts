/**
 * Authoritative definition of the settings stored in `config.toml`.
 *
 * Each settings table is declared once here as a TypeBox schema. The TypeScript
 * types the settings manager uses are derived from those schemas with
 * `Static<...>`, and the editor contract (`schema/config.schema.json`) is
 * generated from the same objects, so the two cannot drift: a key that exists
 * in one exists in the other.
 *
 * The schema describes what a configuration file may contain. It does not
 * replace the read-time validation in the settings manager, which keeps its
 * fallback behavior (report a bad value once, then use the default).
 */

import type { ThinkingLevel } from "@step-harness/agent-core";
import type { ScrollViewScrollbar } from "@step-harness/pi-tui";
import type { Transport } from "@step-harness/providers";
import { type Static, Type } from "typebox";
import { type AutoClmSettings, DEFAULT_AUTO_CLM_SETTINGS } from "./compaction/live-context/auto-options.ts";
import type { ContextProjectionMode } from "./compaction/projection.ts";
import type { CompactionTriggerPolicy } from "./compaction/trigger-policy.ts";
import {
	DEFAULT_COMPACTION_TRIGGER_RATIO,
	MAX_COMPACTION_TRIGGER_RATIO,
	MIN_COMPACTION_TRIGGER_RATIO,
} from "./compaction/trigger-policy.ts";

const ThinkingLevelSchema = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
]);

/**
 * A timeout the HTTP dispatcher accepts: milliseconds, `"disabled"`, or a
 * numeric string. `parseHttpIdleTimeoutMs` treats all three as valid and
 * normalizes them, so the schema must not reject the string forms.
 */
/**
 * A timeout: milliseconds, `"disabled"` for 0, or a numeric string.
 *
 * `parseHttpIdleTimeoutMs` accepts all three and normalizes them, so the schema
 * must not reject the string forms.
 */
function timeoutSetting(defaultDescription: string) {
	return Type.Optional(
		Type.Union([Type.Number({ minimum: 0 }), Type.Literal("disabled"), Type.String({ pattern: "^\\s*\\d+\\s*$" })], {
			// Written out rather than imported: `http-dispatcher.ts` imports
			// undici, and loading the HTTP stack to print one number would make
			// `step config schema` pay for a dependency it never uses.
			description: `Milliseconds, a numeric string, or "disabled" for 0 (${defaultDescription}).`,
		}),
	);
}

/**
 * Bounds mirror `resolveAutoClmSettings`, which clamps every field. Expressing
 * them here keeps the editor warning about a value the runtime would silently
 * replace with its default.
 */
function bounded(value: number, min: number, max: number, description: string) {
	return Type.Optional(
		Type.Integer({
			minimum: min,
			maximum: max,
			description: `${description} (default ${value}, ${min}-${max}).`,
		}),
	);
}

const AutoClmSettingsSchema = Type.Object(
	{
		enabled: Type.Optional(
			Type.Boolean({
				description: `Enable CLM maintenance requests (default ${DEFAULT_AUTO_CLM_SETTINGS.enabled}).`,
			}),
		),
		softThresholdRatio: Type.Optional(
			Type.Number({
				minimum: 0.3,
				maximum: 0.85,
				description: "Trigger CLM earlier than the native threshold (0.3-0.85). Omit for the native threshold.",
			}),
		),
		minContextTokens: bounded(
			DEFAULT_AUTO_CLM_SETTINGS.minContextTokens,
			1024,
			1_000_000,
			"Smallest context that may trigger CLM",
		),
		cooldownTurns: bounded(DEFAULT_AUTO_CLM_SETTINGS.cooldownTurns, 1, 100, "Turns between CLM requests"),
		maxRequests: bounded(DEFAULT_AUTO_CLM_SETTINGS.maxRequests, 1, 3, "CLM requests per turn"),
		timeoutMs: bounded(DEFAULT_AUTO_CLM_SETTINGS.timeoutMs, 100, 300_000, "CLM request timeout in milliseconds"),
		maxOutputTokens: bounded(
			DEFAULT_AUTO_CLM_SETTINGS.maxOutputTokens,
			512,
			32_768,
			"CLM summary output token limit",
		),
		minSavingsTokens: bounded(
			DEFAULT_AUTO_CLM_SETTINGS.minSavingsTokens,
			1,
			1_000_000,
			"Smallest saving that justifies a CLM request",
		),
		minSavingsRatio: Type.Optional(
			Type.Number({
				minimum: 0.01,
				maximum: 0.5,
				description: "Smallest saving ratio that justifies a CLM request (0.01-0.5).",
			}),
		),
		coldMaxPrefillTokens: bounded(
			DEFAULT_AUTO_CLM_SETTINGS.coldMaxPrefillTokens,
			0,
			100_000_000,
			"Largest uncached CLM prefill in tokens; 0 removes the bound",
		),
	},
	{ additionalProperties: false, description: 'Host-scheduled maintenance inside `contextProjection = "clm-v1"`.' },
);

const CompactionSettingsSchema = Type.Object(
	{
		enabled: Type.Optional(Type.Boolean({ description: "Enable automatic compaction (default true)." })),
		reserveTokens: Type.Optional(
			Type.Integer({
				minimum: 1,
				description:
					"Headroom kept free for the next response (default 16384). Under the v2 policy an explicit value only caps the trigger earlier; anything but a positive integer is ignored.",
			}),
		),
		keepRecentTokens: Type.Optional(
			Type.Number({ minimum: 0, description: "Recent tokens kept verbatim by the summary (default 20000)." }),
		),
		triggerPolicy: Type.Optional(
			Type.Union([Type.Literal("v2"), Type.Literal("legacy")], {
				description: "`v2` (default) checks once before each request; `legacy` keeps the previous checkpoints.",
			}),
		),
		triggerRatio: Type.Optional(
			Type.Number({
				minimum: MIN_COMPACTION_TRIGGER_RATIO,
				maximum: MAX_COMPACTION_TRIGGER_RATIO,
				description: `Fraction of the context window that triggers compaction (default ${DEFAULT_COMPACTION_TRIGGER_RATIO}).`,
			}),
		),
		modelTriggerRatios: Type.Optional(
			Type.Record(
				Type.String(),
				Type.Number({ minimum: MIN_COMPACTION_TRIGGER_RATIO, maximum: MAX_COMPACTION_TRIGGER_RATIO }),
				{
					description: `Per-model trigger ratios keyed by \`provider/id\` (${MIN_COMPACTION_TRIGGER_RATIO}-${MAX_COMPACTION_TRIGGER_RATIO}). A value outside the range is dropped and the global ratio applies.`,
				},
			),
		),
		tokenLimit: Type.Optional(
			Type.Integer({
				minimum: 1,
				description:
					"Absolute token ceiling; only makes compaction trigger earlier. Must be a positive integer, or it is ignored.",
			}),
		),
		contextProjection: Type.Optional(
			Type.Union([Type.Literal("off"), Type.Literal("lightweight-v1"), Type.Literal("clm-v1")], {
				description: "Context projection mode: `off` (default, native compaction), `lightweight-v1`, or `clm-v1`.",
			}),
		),
		autoClm: Type.Optional(AutoClmSettingsSchema),
	},
	{ additionalProperties: false, description: "Automatic context compaction." },
);

const BranchSummarySettingsSchema = Type.Object(
	{
		reserveTokens: Type.Optional(
			Type.Number({ minimum: 0, description: "Tokens reserved for the prompt and the summary (default 16384)." }),
		),
		skipPrompt: Type.Optional(
			Type.Boolean({
				description: 'Skip the "Summarize branch?" prompt and default to no summary (default false).',
			}),
		),
	},
	{ additionalProperties: false, description: "Summaries written when navigating away from a branch." },
);

const ProviderRetrySettingsSchema = Type.Object(
	{
		timeoutMs: Type.Optional(Type.Number({ minimum: 0, description: "Provider request timeout in milliseconds." })),
		maxRetries: Type.Optional(Type.Number({ minimum: 0, description: "Provider retry attempts." })),
		maxRetryDelayMs: Type.Optional(
			Type.Number({ minimum: 0, description: "Longest server-requested delay before failing (default 60000)." }),
		),
		streamIdleTimeoutMs: Type.Optional(
			Type.Number({
				minimum: 0,
				description: "Longest wait for the next provider event (default 300000); 0 disables it.",
			}),
		),
	},
	{ additionalProperties: false, description: "Transport-level retry and timeout limits." },
);

export const RetrySettingsSchema = Type.Object(
	{
		enabled: Type.Optional(Type.Boolean({ description: "Retry failed requests (default true)." })),
		maxRetries: Type.Optional(Type.Number({ minimum: 0, description: "Transient retry attempts (default 3)." })),
		rateLimitMaxRetries: Type.Optional(
			Type.Integer({
				minimum: 0,
				maximum: 20,
				description: "Rate-limit retry attempts, tracked separately (default 3, 0-20).",
			}),
		),
		baseDelayMs: Type.Optional(
			Type.Number({ minimum: 0, description: "Exponential backoff base in milliseconds (default 2000)." }),
		),
		provider: Type.Optional(ProviderRetrySettingsSchema),
	},
	{ additionalProperties: false, description: "Retry and backoff behavior." },
);

const TerminalSettingsSchema = Type.Object(
	{
		showImages: Type.Optional(
			Type.Boolean({ description: "Render inline images when the terminal supports them (default true)." }),
		),
		imageWidthCells: Type.Optional(
			Type.Number({ minimum: 1, description: "Preferred inline image width in terminal cells (default 60)." }),
		),
		clearOnShrink: Type.Optional(
			Type.Boolean({ description: "Clear empty rows when content shrinks (default false)." }),
		),
		showTerminalProgress: Type.Optional(
			Type.Boolean({ description: "Emit OSC 9;4 progress indicators (default: auto, on in Otty and Ghostty)." }),
		),
		hyperlinks: Type.Optional(
			Type.Union([Type.Boolean(), Type.Literal("auto")], {
				description: 'Emit OSC 8 hyperlinks: `"auto"` (default) decides per terminal.',
			}),
		),
		images: Type.Optional(
			Type.Union([Type.Literal("kitty"), Type.Literal("iterm2"), Type.Literal("auto"), Type.Literal(false)], {
				description: 'Inline image protocol: `"kitty"`, `"iterm2"`, `"auto"` (default), or `false`.',
			}),
		),
		trueColor: Type.Optional(
			Type.Union([Type.Boolean(), Type.Literal("auto")], {
				description: 'Use 24-bit color: `"auto"` (default) decides per terminal.',
			}),
		),
	},
	{ additionalProperties: false, description: "Terminal capability overrides; detection is the default." },
);

const ImageSettingsSchema = Type.Object(
	{
		autoResize: Type.Optional(
			Type.Boolean({
				description:
					"Resize images to at most 2000x2000 for model compatibility (default true). Applies to @file attachments, read, and tool-returned images.",
			}),
		),
		blockImages: Type.Optional(Type.Boolean({ description: "Never send images to providers (default false)." })),
	},
	{ additionalProperties: false, description: "Image handling before a request is sent." },
);

const ThinkingBudgetsSettingsSchema = Type.Object(
	{
		minimal: Type.Optional(
			Type.Number({ minimum: 0, description: "Token budget for the `minimal` thinking level." }),
		),
		low: Type.Optional(Type.Number({ minimum: 0, description: "Token budget for the `low` thinking level." })),
		medium: Type.Optional(Type.Number({ minimum: 0, description: "Token budget for the `medium` thinking level." })),
		high: Type.Optional(Type.Number({ minimum: 0, description: "Token budget for the `high` thinking level." })),
	},
	{ additionalProperties: false, description: "Custom token budgets per thinking level." },
);

const MarkdownSettingsSchema = Type.Object(
	{
		codeBlockIndent: Type.Optional(
			Type.String({ description: 'Indent applied to rendered code blocks (default "  ").' }),
		),
		mermaid: Type.Optional(
			Type.Union([Type.Literal("off"), Type.Literal("final"), Type.Literal("streaming")], {
				description: 'Mermaid rendering: `"off"`, `"final"`, or `"streaming"` (default).',
			}),
		),
	},
	{ additionalProperties: false, description: "Markdown rendering options." },
);

const WarningSettingsSchema = Type.Object(
	{
		anthropicExtraUsage: Type.Optional(
			Type.Boolean({ description: "Warn before an Anthropic request uses extra usage credits (default true)." }),
		),
	},
	{ additionalProperties: false, description: "Startup and in-session warnings." },
);

const PackageSourceSchema = Type.Union([
	Type.String(),
	Type.Object(
		{
			source: Type.String({ minLength: 1, description: "npm or git package source." }),
			autoload: Type.Optional(
				Type.Boolean({ description: "Start empty and only apply the explicit resource patterns below." }),
			),
			extensions: Type.Optional(Type.Array(Type.String(), { description: "Extension paths or patterns to load." })),
			skills: Type.Optional(Type.Array(Type.String(), { description: "Skill paths or patterns to load." })),
			prompts: Type.Optional(
				Type.Array(Type.String(), { description: "Prompt template paths or patterns to load." }),
			),
			themes: Type.Optional(Type.Array(Type.String(), { description: "Theme paths or patterns to load." })),
		},
		{ additionalProperties: false, description: "A package source with resource filtering." },
	),
]);

const RecentModelSchema = Type.Object(
	{
		provider: Type.String({ minLength: 1 }),
		id: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false, description: "A recently selected model." },
);

/**
 * The settings tables shared with the agent runtime. `config.toml` adds the
 * product-owned keys on top of this; see `src/step/config-schema.ts`.
 */
export const SettingsSchema = Type.Object(
	{
		lastChangelogVersion: Type.Optional(
			Type.String({ description: "Last changelog version shown after an update. Written by the product." }),
		),
		defaultProvider: Type.Optional(
			Type.String({ description: "Startup provider; saved by pressing Enter in `/model`." }),
		),
		defaultModel: Type.Optional(
			Type.String({ description: "Startup model id; saved by pressing Enter in `/model`." }),
		),
		recentModels: Type.Optional(
			Type.Array(RecentModelSchema, { description: "Recently selected models, newest first (global only)." }),
		),
		defaultThinkingLevel: Type.Optional(
			Type.Union(
				[
					Type.Literal("off"),
					Type.Literal("minimal"),
					Type.Literal("low"),
					Type.Literal("medium"),
					Type.Literal("high"),
					Type.Literal("xhigh"),
					Type.Literal("max"),
				],
				{ description: "Startup thinking level; saved by pressing Enter in `/effort`." },
			),
		),
		modelThinkingLevels: Type.Optional(
			Type.Record(Type.String(), ThinkingLevelSchema, {
				description: "Per-model startup thinking levels keyed by `provider/modelId`.",
			}),
		),
		transport: Type.Optional(
			Type.Union(
				[Type.Literal("sse"), Type.Literal("websocket"), Type.Literal("websocket-cached"), Type.Literal("auto")],
				{
					description:
						'Preferred transport for providers that support several: "sse", "websocket", "websocket-cached", or "auto" (default).',
				},
			),
		),
		steeringMode: Type.Optional(
			Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")], {
				description: "How a message typed while the model is working is delivered (default one-at-a-time).",
			}),
		),
		followUpMode: Type.Optional(
			Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")], {
				description: "How queued follow-up messages are delivered (default one-at-a-time).",
			}),
		),
		theme: Type.Optional(
			Type.String({
				description:
					'Theme name: "dark", "light", "step-blue" (default), "step-violet", "step-violet-light", or a custom theme.',
			}),
		),
		compaction: Type.Optional(CompactionSettingsSchema),
		branchSummary: Type.Optional(BranchSummarySettingsSchema),
		retry: Type.Optional(RetrySettingsSchema),
		hideThinkingBlock: Type.Optional(Type.Boolean({ description: "Hide thinking blocks in output." })),
		statusTips: Type.Optional(
			Type.Boolean({ description: "Show one tip per turn under the status row (default true)." }),
		),
		showCacheMissNotices: Type.Optional(
			Type.Boolean({ description: "Show prompt-cache miss and compaction cost notices (default false)." }),
		),
		externalEditor: Type.Optional(
			Type.String({ description: "Command for Ctrl+G; takes precedence over `VISUAL` and `EDITOR`." }),
		),
		shellPath: Type.Optional(Type.String({ description: "Shell used for tool commands; supports a leading `~`." })),
		quietStartup: Type.Optional(Type.Boolean({ description: "Hide the startup header (default false)." })),
		defaultProjectTrust: Type.Optional(
			Type.Union([Type.Literal("ask"), Type.Literal("always"), Type.Literal("never")], {
				description: 'Fallback project trust behavior for non-interactive runs (default "ask", global only).',
			}),
		),
		shellCommandPrefix: Type.Optional(
			Type.String({ description: "Text prepended to every shell command, for example alias setup." }),
		),
		npmCommand: Type.Optional(
			Type.Array(Type.String(), { description: 'argv for package lookups, for example ["mise", "exec", "npm"].' }),
		),
		collapseChangelog: Type.Optional(
			Type.Boolean({ description: "Show condensed changelog entries (default false)." }),
		),
		enableAnalytics: Type.Optional(Type.Boolean({ description: "Opt-in analytics sharing (default false)." })),
		trackingId: Type.Optional(
			Type.String({ description: "Analytics identifier, generated when analytics is enabled." }),
		),
		packages: Type.Optional(Type.Array(PackageSourceSchema, { description: "npm or git package sources." })),
		extensions: Type.Optional(Type.Array(Type.String(), { description: "Local extension files or directories." })),
		skills: Type.Optional(Type.Array(Type.String(), { description: "Local skill files or directories." })),
		prompts: Type.Optional(Type.Array(Type.String(), { description: "Local prompt template files or directories." })),
		themes: Type.Optional(Type.Array(Type.String(), { description: "Local theme files or directories." })),
		enableSkillCommands: Type.Optional(
			Type.Boolean({ description: "Register skills as `/skill:name` commands (default true)." }),
		),
		terminal: Type.Optional(TerminalSettingsSchema),
		images: Type.Optional(ImageSettingsSchema),
		enabledModels: Type.Optional(
			Type.Array(Type.String(), { description: "Model patterns available to Ctrl+P cycling." }),
		),
		defaultTools: Type.Optional(Type.Array(Type.String(), { description: "Initial built-in tool selection." })),
		doubleEscapeAction: Type.Optional(
			Type.Union([Type.Literal("fork"), Type.Literal("tree"), Type.Literal("none")], {
				description: 'Action for double-escape with an empty editor (default "tree").',
			}),
		),
		treeFilterMode: Type.Optional(
			Type.Union(
				[
					Type.Literal("default"),
					Type.Literal("no-tools"),
					Type.Literal("user-only"),
					Type.Literal("labeled-only"),
					Type.Literal("all"),
				],
				{ description: 'Default filter when opening `/tree` (default "default").' },
			),
		),
		thinkingBudgets: Type.Optional(ThinkingBudgetsSettingsSchema),
		editorPaddingX: Type.Optional(
			Type.Number({
				minimum: 0,
				maximum: 3,
				description: "Horizontal padding for the input editor (default 0, 0-3). `/settings` clamps to this range.",
			}),
		),
		outputPad: Type.Optional(
			Type.Union([Type.Literal(0), Type.Literal(1)], { description: "Horizontal output padding (default 1)." }),
		),
		autocompleteMaxVisible: Type.Optional(
			Type.Number({
				minimum: 3,
				maximum: 20,
				description: "Visible rows in the autocomplete dropdown (default 5, 3-20).",
			}),
		),
		showHardwareCursor: Type.Optional(
			Type.Boolean({ description: "Show the terminal cursor while still positioning it for IME." }),
		),
		markdown: Type.Optional(MarkdownSettingsSchema),
		warnings: Type.Optional(WarningSettingsSchema),
		sessionDir: Type.Optional(Type.String({ description: "Session storage directory." })),
		httpProxy: Type.Optional(
			Type.String({ description: "Proxy URL applied as `HTTP_PROXY` and `HTTPS_PROXY` for managed HTTP clients." }),
		),
		httpIdleTimeoutMs: timeoutSetting("default 300000"),
		// No default: an unset value is passed to the provider, which uses its own.
		websocketConnectTimeoutMs: timeoutSetting("unset leaves it to the provider"),
		tuiMode: Type.Optional(
			Type.Union([Type.Literal("regular"), Type.Literal("fullscreen")], {
				description: 'Interactive renderer mode (default "regular").',
			}),
		),
		fullscreenExitOutput: Type.Optional(
			Type.Union([Type.Literal("transcript"), Type.Literal("resume-hint")], {
				description: 'What fullscreen mode prints on exit (default "transcript").',
			}),
		),
		fullscreenScrollbar: Type.Optional(
			Type.Union([Type.Literal("hidden"), Type.Literal("auto"), Type.Literal("always")], {
				description: 'Fullscreen scrollbar visibility (default "auto").',
			}),
		),
		fullscreenCopyOnSelect: Type.Optional(
			Type.Boolean({
				description: "Copy the selection when the mouse is released in fullscreen mode (default true).",
			}),
		),
	},
	{ additionalProperties: false, description: "Settings stored in `config.toml`." },
);

export type CompactionSettings = Static<typeof CompactionSettingsSchema>;
export type BranchSummarySettings = Static<typeof BranchSummarySettingsSchema>;
export type ProviderRetrySettings = Static<typeof ProviderRetrySettingsSchema>;
export type RetrySettings = Static<typeof RetrySettingsSchema>;
export type TerminalSettings = Static<typeof TerminalSettingsSchema>;
export type ImageSettings = Static<typeof ImageSettingsSchema>;
export type ThinkingBudgetsSettings = Static<typeof ThinkingBudgetsSettingsSchema>;
export type MarkdownSettings = Static<typeof MarkdownSettingsSchema>;
export type WarningSettings = Static<typeof WarningSettingsSchema>;
export type AutoClmSettingsInput = Static<typeof AutoClmSettingsSchema>;
export type PackageSource = Static<typeof PackageSourceSchema>;

export type MermaidRenderingMode = NonNullable<Static<typeof MarkdownSettingsSchema>["mermaid"]>;
export type DefaultProjectTrust = NonNullable<Static<typeof SettingsSchema>["defaultProjectTrust"]>;
export type TransportSetting = NonNullable<Static<typeof SettingsSchema>["transport"]>;
export type TuiMode = NonNullable<Static<typeof SettingsSchema>["tuiMode"]>;
export type FullscreenExitOutput = NonNullable<Static<typeof SettingsSchema>["fullscreenExitOutput"]>;
export type Settings = Static<typeof SettingsSchema>;

/**
 * Compile-time equality between a schema-derived type and the type its
 * consumers import.
 *
 * Both directions matter. A schema that gains a member the runtime does not
 * accept lets a value through that the runtime then ignores; a schema that loses
 * one rejects a value the runtime would honor. Either way the editor and the
 * runtime disagree about the same file, so the build fails here rather than at
 * the user.
 */
// `never` here would be the bug: `Expect<never>` satisfies `T extends true`, so a
// diverged type would pass silently. `false` is the only value the constraint
// rejects.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Expect<T extends true> = T;

export interface SettingsSchemaContract {
	transport: Expect<Exact<TransportSetting, Transport>>;
	thinkingLevel: Expect<Exact<NonNullable<Static<typeof SettingsSchema>["defaultThinkingLevel"]>, ThinkingLevel>>;
	triggerPolicy: Expect<
		Exact<NonNullable<NonNullable<Static<typeof CompactionSettingsSchema>>["triggerPolicy"]>, CompactionTriggerPolicy>
	>;
	contextProjection: Expect<
		Exact<
			NonNullable<NonNullable<Static<typeof CompactionSettingsSchema>>["contextProjection"]>,
			ContextProjectionMode
		>
	>;
	fullscreenScrollbar: Expect<
		Exact<NonNullable<NonNullable<Static<typeof SettingsSchema>>["fullscreenScrollbar"]>, ScrollViewScrollbar>
	>;
	// The schema's table is a `Partial<>` of the runtime type: every field is
	// optional in a config file and required once resolved.
	autoClm: Expect<Exact<AutoClmSettingsInput, Partial<AutoClmSettings>>>;
}
