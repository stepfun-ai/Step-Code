/** Step-only slash command adapters built on Pi's public extension actions. */

import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "../core/extensions/types.ts";
import { getAvailableThemes } from "../modes/interactive/theme/theme.ts";
import { registerStepPluginCommand } from "./plugins.ts";
import { type StepTelemetryReporter, trackStepTelemetry } from "./telemetry.ts";

/**
 * Register Step's product command spellings that have a direct Pi action.
 *
 * The handlers intentionally stay at the public extension boundary. In
 * particular, they do not call InteractiveMode methods or maintain a second
 * session/theme state machine. Pi remains responsible for session replacement,
 * shutdown, selector presentation, persistence, and rendering.
 */
export function registerStepPiCommandAdapters(pi: ExtensionAPI, telemetry?: StepTelemetryReporter): void {
	registerStepPluginCommand(pi, { telemetry });

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
