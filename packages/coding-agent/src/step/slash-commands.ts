/** Step-only slash command adapters built on Pi's public extension actions. */

import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "../core/extensions/types.ts";
import { getAvailableThemes } from "../theme/theme.ts";
import { buildFeedbackSessionBundle } from "./feedback/bundle.ts";
import {
	type FeedbackSubmitResult,
	formatFeedbackBundleFailureDetails,
	formatFeedbackBundleSkipMessage,
	formatFeedbackPendingDetails,
	formatFeedbackSubmittedMessage,
	submitFeedback,
} from "./feedback/command.ts";
import { confirmFeedbackSubmission, neutralizeFeedbackConsentMetadata } from "./feedback/consent.ts";
import { readFeedbackDiagnostics } from "./feedback/diagnostics.ts";
import { resolveFeedbackEndpoint } from "./feedback/endpoints.ts";
import { resolveFeedbackSettings } from "./feedback/settings.ts";
import {
	FEEDBACK_CATEGORIES,
	FEEDBACK_CATEGORY_CLI_SPELLINGS,
	FEEDBACK_CATEGORY_PRESENTATION,
	type FeedbackIdentity,
} from "./feedback/types.ts";
import { normalizeFeedbackCategory } from "./feedback/validate.ts";
import { formatStepMcpStatuses } from "./mcp.ts";
import { registerStepPluginCommand } from "./plugins.ts";
import { resolveStepStorageRoot } from "./storage-root.ts";
import { type StepTelemetryReporter, trackStepTelemetry } from "./telemetry.ts";

/**
 * Register Step's product command spellings that have a direct Pi action.
 *
 * The handlers intentionally stay at the public extension boundary. In
 * particular, they do not call InteractiveMode methods or maintain a second
 * session/theme state machine. Pi remains responsible for session replacement,
 * shutdown, selector presentation, persistence, and rendering.
 */
export function registerStepPiCommandAdapters(
	pi: ExtensionAPI,
	telemetry?: StepTelemetryReporter,
	stepSettings?: () => { getStepSettings(): { feedbackEnabled?: boolean } } | undefined,
	feedbackIdentity?: () => FeedbackIdentity,
): void {
	registerStepPluginCommand(pi, { telemetry });
	registerTrackedCommand(
		pi,
		"mcp",
		{
			description: "Show configured MCP servers and loaded tools",
			handler: async (_args, ctx) => {
				ctx.ui.notify(formatStepMcpStatuses(), "info");
			},
		},
		telemetry,
	);

	registerTrackedCommand(
		pi,
		"clear",
		{
			description: "Start a fresh session (alias of /new)",
			handler: async (_args, ctx) => {
				// Do not touch `ctx` after the await: a successful replacement invalidates
				// the old command context. Native session_start handling owns the resulting
				// UI refresh and status projection.
				await ctx.newSession();
			},
		},
		telemetry,
	);

	registerTrackedCommand(
		pi,
		"exit",
		{
			description: "Exit the interactive shell",
			handler: async (_args, ctx) => {
				ctx.shutdown();
			},
		},
		telemetry,
	);

	registerTrackedCommand(
		pi,
		"theme",
		{
			description: "Pick or switch TUI themes",
			getArgumentCompletions: (prefix) => {
				const normalized = prefix.trim().toLowerCase();
				return getAvailableThemes()
					.filter((name) => name.toLowerCase().startsWith(normalized))
					.map((name) => ({ value: name, label: name }));
			},
			handler: async (args, ctx) => {
				await handleStepThemeCommand(args, ctx);
			},
		},
		telemetry,
	);

	registerTrackedCommand(
		pi,
		"status",
		{
			description: "Show current session and model status",
			handler: async (_args, ctx) => {
				ctx.ui.notify(formatStepStatus(ctx), "info");
			},
		},
		telemetry,
	);

	registerTrackedCommand(
		pi,
		"feedback",
		{
			description: "Send feedback about the current session",
			handler: async (args, ctx) => {
				await handleStepFeedbackCommand(args, ctx, telemetry, stepSettings, feedbackIdentity);
			},
		},
		telemetry,
	);
}

type RegisteredCommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;

function registerTrackedCommand(
	pi: ExtensionAPI,
	name: string,
	command: RegisteredCommandOptions,
	telemetry?: StepTelemetryReporter,
): void {
	pi.registerCommand(name, {
		...command,
		handler: async (args, ctx) => {
			recordSlashCommand(telemetry, name, true);
			await command.handler(args, ctx);
		},
	});
}

export function recordStepSlashCommand(
	telemetry: StepTelemetryReporter | undefined,
	commandLine: string,
	recognized: boolean,
): void {
	if (!telemetry) return;
	const token = commandLine.trim().split(/\s+/u)[0] ?? "";
	const command = token.startsWith("/") ? token : `/${token}`;
	trackStepTelemetry(telemetry, "slash_command_used", {
		command: command.slice(0, 128),
		recognized,
	});
}

function recordSlashCommand(telemetry: StepTelemetryReporter | undefined, name: string, recognized: boolean): void {
	recordStepSlashCommand(telemetry, `/${name}`, recognized);
}

async function handleStepFeedbackCommand(
	args: string,
	ctx: ExtensionCommandContext,
	telemetry?: StepTelemetryReporter,
	stepSettings?: () => { getStepSettings(): { feedbackEnabled?: boolean } } | undefined,
	feedbackIdentity?: () => FeedbackIdentity,
): Promise<void> {
	const feedbackSettings = resolveFeedbackSettings({
		env: process.env,
		settings: stepSettings?.()?.getStepSettings(),
	});
	if (!feedbackSettings.enabled) {
		ctx.ui.notify(
			feedbackSettings.reason === "env-opt-out"
				? "Feedback is disabled by environment settings."
				: "Feedback is disabled in Step settings.",
			"warning",
		);
		return;
	}
	if (!ctx.hasUI) {
		ctx.ui.notify("/feedback requires an interactive UI.", "warning");
		return;
	}
	const endpoint = resolveFeedbackEndpoint(process.env);
	if (!endpoint) {
		ctx.ui.notify("Feedback endpoint is not configured.", "warning");
		return;
	}
	const bundleEndpoint = resolveFeedbackEndpoint(process.env, true);
	const storageRootDir = resolveStepStorageRoot(process.env);
	const identity = feedbackIdentity?.() ?? {};
	const shortcutComment = args.trim();
	if (shortcutComment) {
		const result = await submitFeedback({
			comment: shortcutComment,
			storageRootDir,
			sessionId: ctx.sessionManager.getSessionId(),
			endpoint,
			...(bundleEndpoint ? { bundleEndpoint } : {}),
			telemetry,
			env: process.env,
			surface: "tui",
			...(identity.uid ? { uid: identity.uid } : {}),
			...(identity.username ? { username: identity.username } : {}),
		});
		notifyFeedbackResult(ctx, result);
		return;
	}

	// Every page of this flow renders as an overlay so the transcript holds still across the
	// whole wizard: the consent page below is one, and a page that grows the transcript instead
	// leaves the editor above the bottom row when it is cancelled.
	const selected = await ctx.ui.select(
		"Feedback category",
		FEEDBACK_CATEGORIES.map(
			(category) =>
				`${FEEDBACK_CATEGORY_CLI_SPELLINGS[category]}: ${FEEDBACK_CATEGORY_PRESENTATION[category].description}`,
		),
		{ overlay: true },
	);
	if (!selected) return;
	const category = normalizeFeedbackCategory(selected.split(":", 1)[0]?.trim() ?? "");
	if (!category) return;
	const rawComment = await ctx.ui.input("Feedback comment", "What happened?", { overlay: true });
	if (rawComment === undefined) return;
	const comment = rawComment.trim();
	const readAt = new Date();
	const diagnosticsCandidate = await readFeedbackDiagnostics({ storageRootDir, at: readAt });
	const bundleCandidate = bundleEndpoint
		? await buildFeedbackSessionBundle({
				storageRootDir,
				sessionFile: ctx.sessionManager.getSessionFile(),
				sessionId: ctx.sessionManager.getSessionId(),
				at: readAt,
			})
		: undefined;
	if (bundleCandidate?.status === "skipped") {
		ctx.ui.notify(
			formatFeedbackBundleSkipMessage(bundleCandidate),
			bundleCandidate.reason === "too-large" || bundleCandidate.reason === "unsafe" ? "warning" : "info",
		);
	}
	const availableFiles = [
		...(diagnosticsCandidate ? [diagnosticsCandidate.displayPath] : []),
		...(bundleCandidate?.status === "ready" ? bundleCandidate.bundle.files.map((file) => file.name) : []),
	].map(neutralizeFeedbackConsentMetadata);
	let includeAttachments = false;
	if (availableFiles.length > 0) {
		const uploadChoice = await ctx.ui.select(
			`UPLOAD LOGS?\n${availableFiles.join(", ")}`,
			["Yes · Include the listed files", "No · Send feedback without files"],
			{ overlay: true },
		);
		if (!uploadChoice) return;
		includeAttachments = uploadChoice === "Yes · Include the listed files";
	} else if (bundleCandidate?.status !== "skipped") {
		ctx.ui.notify("No logs or session files are currently available.", "info");
	}
	const diagnostics = includeAttachments ? diagnosticsCandidate?.diagnostics : undefined;
	const sessionBundle = includeAttachments && bundleCandidate?.status === "ready" ? bundleCandidate : undefined;
	const submissionSessionId =
		sessionBundle?.status === "ready" ? sessionBundle.bundle.sessionId : ctx.sessionManager.getSessionId();
	const result = await submitFeedback({
		category,
		comment,
		...(diagnostics ? { diagnostics } : {}),
		...(sessionBundle ? { sessionBundle } : {}),
		storageRootDir,
		sessionId: submissionSessionId,
		endpoint,
		...(bundleEndpoint ? { bundleEndpoint } : {}),
		telemetry,
		env: process.env,
		surface: "tui",
		...(identity.uid ? { uid: identity.uid } : {}),
		...(identity.username ? { username: identity.username } : {}),
		confirm: async (submission) =>
			await confirmFeedbackSubmission(ctx, {
				submission,
				...(diagnosticsCandidate ? { diagnosticsDisplayPath: diagnosticsCandidate.displayPath } : {}),
				...(sessionBundle ? { bundle: sessionBundle.bundle } : {}),
			}),
	});
	notifyFeedbackResult(ctx, result);
}

function notifyFeedbackResult(ctx: ExtensionCommandContext, result: FeedbackSubmitResult): void {
	if (result.status === "cancelled") return;
	if (result.status === "invalid") {
		ctx.ui.notify(result.error, "error");
		return;
	}
	if (result.outcome.status === "pending") {
		ctx.ui.notify(`Feedback submission failed: ${formatFeedbackPendingDetails(result.outcome)}`, "warning");
		return;
	}
	const bundle = result.outcome.bundle;
	ctx.ui.notify(
		`${formatFeedbackSubmittedMessage(result.submission.feedbackId)}${
			bundle?.status === "pending"
				? ` The session archive was not uploaded: ${formatFeedbackBundleFailureDetails(bundle)}`
				: ""
		}`,
		"info",
	);
}

async function handleStepThemeCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/theme requires an interactive UI.", "warning");
		return;
	}

	let requested = args.trim();
	if (!requested) {
		const themes = ctx.ui
			.getAllThemes()
			.map((entry) => entry.name)
			.filter((name) => name.trim().length > 0);
		if (themes.length === 0) {
			ctx.ui.notify("No themes are available.", "warning");
			return;
		}

		requested = (await ctx.ui.select("Theme", themes))?.trim() ?? "";
		if (!requested) return;
	}

	const result = ctx.ui.setTheme(requested);
	if (result.success) {
		ctx.ui.notify(`Theme: ${requested}`, "info");
		return;
	}
	ctx.ui.notify(result.error ? `Failed to set theme: ${result.error}` : `Unknown theme "${requested}".`, "warning");
}

/** Format a secret-free status snapshot from Pi's public command context. */
export function formatStepStatus(ctx: ExtensionCommandContext): string {
	const model = ctx.model;
	const modelLabel = model ? `${model.provider}/${model.id}` : "none";
	const thinkingLevel = ctx.thinkingLevel ?? (model?.reasoning ? "unknown" : "off");
	const usage = ctx.getContextUsage();
	const contextLabel = usage
		? `${usage.tokens === null ? "?" : usage.tokens.toLocaleString()}/${usage.contextWindow.toLocaleString()} tokens${
				usage.percent === null ? "" : ` (${usage.percent.toFixed(1)}%)`
			}`
		: "unavailable";

	return [
		`Session: ${ctx.sessionManager.getSessionId()}`,
		`Workspace: ${ctx.cwd}`,
		`State: ${ctx.isIdle() ? "idle" : "busy"}`,
		`Model: ${modelLabel}`,
		`Thinking: ${thinkingLevel}`,
		`Context: ${contextLabel}`,
	].join("\n");
}
