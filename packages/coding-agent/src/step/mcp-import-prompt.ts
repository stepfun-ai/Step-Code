/**
 * Hosts the MCP import screen at startup and applies whatever the user picked.
 *
 * The prompt is one-time per source: once a source has been shown it is marked
 * reviewed whether or not anything was imported, because the question ("do you
 * want these?") is what was answered — re-asking every launch would be a bug,
 * not a safety net.
 */

import { detectTerminalBackgroundFromEnv, initTheme, resolveThemeSetting, theme } from "../theme/theme.ts";
import { createStandaloneStepHost, type StepLoginHost } from "./login-flow.ts";
import {
	type ApplyStepMcpImportResult,
	applyStepMcpImport,
	planStepMcpImport,
	STEP_MCP_IMPORT_SOURCES,
	type StepMcpImportPlan,
	type StepMcpImportSource,
} from "./mcp-import.ts";
import {
	hasReviewedStepMcpImportSource,
	markStepMcpImportSourcesReviewed,
	readStepMcpImportState,
} from "./mcp-import-store.ts";
import { StepMcpImportView } from "./mcp-import-view.ts";

export interface StepMcpImportPromptOutcome {
	readonly kind: "skipped" | "cancelled" | "imported";
	readonly result?: ApplyStepMcpImportResult;
	/** Set when the prompt was never shown, so the caller can explain silence. */
	readonly reason?: string;
}

/**
 * Debug switch: show the screen on every launch instead of once per source.
 *
 * It also suppresses the reviewed-source write, so a debug run leaves
 * `~/.stepcode/mcp-import.json` untouched and the shipped behaviour — ask once —
 * returns the moment the variable is unset.
 */
export const STEP_MCP_IMPORT_ALWAYS_ENV = "STEP_MCP_IMPORT_ALWAYS";

const FALSE_ENV_VALUES = new Set(["0", "false", "off", "no"]);

export function isStepMcpImportAlways(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env[STEP_MCP_IMPORT_ALWAYS_ENV]?.trim().toLowerCase();
	return value !== undefined && value !== "" && !FALSE_ENV_VALUES.has(value);
}

export interface RunStepMcpImportPromptOptions {
	readonly env?: NodeJS.ProcessEnv;
	readonly homeDir?: string;
	readonly createHost?: () => StepLoginHost;
	readonly themeName?: string;
}

/**
 * Returns the sources that still owe the user a prompt, and a plan restricted to
 * them. Sources already reviewed are dropped so a second launch stays quiet.
 */
export function planPendingStepMcpImport(options: RunStepMcpImportPromptOptions = {}): {
	readonly plan: StepMcpImportPlan;
	readonly pending: readonly StepMcpImportSource[];
} {
	const env = options.env ?? process.env;
	const state = readStepMcpImportState(env);
	const always = isStepMcpImportAlways(env);
	const pending = STEP_MCP_IMPORT_SOURCES.filter((source) => always || !hasReviewedStepMcpImportSource(state, source));
	// Planned over the pending sources only, so a source that is no longer being
	// offered cannot claim a name away from one that is.
	return {
		pending,
		plan: planStepMcpImport({ env, sources: pending, ...(options.homeDir ? { homeDir: options.homeDir } : {}) }),
	};
}

export async function runStepMcpImportPrompt(
	options: RunStepMcpImportPromptOptions = {},
): Promise<StepMcpImportPromptOutcome> {
	const env = options.env ?? process.env;
	const { plan, pending } = planPendingStepMcpImport(options);
	if (pending.length === 0) return { kind: "skipped", reason: "every source has already been reviewed" };
	// Nothing recognisable means nothing to decide. Mark the sources reviewed so a
	// user with no other agent installed never sees this screen at all.
	if (plan.candidates.length === 0) {
		if (!isStepMcpImportAlways(env)) markStepMcpImportSourcesReviewed(pending, env);
		return { kind: "skipped", reason: "no MCP servers were found in the other agent configs" };
	}

	const host = options.createHost?.() ?? createStandaloneStepHost();
	// This runs before main() initializes the product theme; only initialize when
	// this is the first renderer in the process.
	try {
		theme.fg("text", "");
	} catch {
		const terminalTheme = detectTerminalBackgroundFromEnv({ env }).theme;
		initTheme(resolveThemeSetting(options.themeName ?? "dark", terminalTheme) ?? "dark", false);
	}

	let settle: ((selection: string[] | null) => void) | undefined;
	const answered = new Promise<string[] | null>((resolve) => {
		settle = resolve;
	});
	const view = new StepMcpImportView(plan.candidates, plan.sources, {
		onConfirm: (targetNames) => settle?.(targetNames),
		onCancel: () => settle?.(null),
		requestRender: () => host.requestRender(),
	});

	host.addChild(view);
	host.setFocus(view);
	let selection: string[] | null;
	try {
		await host.start();
		selection = await answered;
	} finally {
		await host.stop();
		host.clearScreen?.();
	}

	// Mark reviewed before writing: if the write then fails, the user is told and
	// can retry deliberately, which beats re-prompting on every launch.
	if (!isStepMcpImportAlways(env)) markStepMcpImportSourcesReviewed(pending, env);
	if (selection === null) return { kind: "cancelled" };
	const result = applyStepMcpImport(plan, selection, env);
	return { kind: "imported", result };
}

/**
 * One line describing what the prompt did, or `undefined` when it did nothing
 * the user needs told.
 *
 * Silence is the right answer for a skipped or cancelled prompt: the user
 * either never saw the screen or answered "no", and repeating that back is
 * noise. A write, a partial write, or a failed write all changed something and
 * are reported.
 */
export function describeStepMcpImportOutcome(outcome: StepMcpImportPromptOutcome): string | undefined {
	const result = outcome.result;
	if (outcome.kind !== "imported" || !result) return undefined;
	const parts: string[] = [];
	if (result.imported.length > 0) {
		const target = result.configPath ?? "config.toml";
		const count = result.imported.length === 1 ? "1 MCP server" : `${result.imported.length} MCP servers`;
		// No restart advice: the prompt runs before init(), so session_start — and
		// with it MCP discovery — has not happened yet and picks these up.
		parts.push(`Imported ${count} into ${target}`, `  ${result.imported.join(", ")}`);
	}
	for (const entry of result.skipped) {
		parts.push(`Skipped ${entry.name}: ${entry.reason}`);
	}
	return parts.length > 0 ? parts.join("\n") : undefined;
}
