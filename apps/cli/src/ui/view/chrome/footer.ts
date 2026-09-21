import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentSession, ReadonlyFooterDataProvider } from "@step-harness/coding-agent";
import { addUsageToTotals, createUsageTotals, theme } from "@step-harness/coding-agent";
import { type Component, sliceByColumn, truncateToWidth, visibleWidth } from "@step-harness/pi-tui";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Rough token estimate for streamed text before usage arrives (~4 chars/token,
 * same heuristic the working row uses).
 */
export function estimateTokens(chars: number): number {
	return Math.round(chars / 4);
}

/**
 * Compact elapsed-time format shared by the working row, the turn-done marker
 * and the thinking summary so all three read the same scale ("90s" never shows
 * next to "1m 30s"). Lives in coding-agent so extension status texts (e.g. the
 * goal footer segment) format durations identically.
 */
export { formatElapsedTime } from "@step-harness/coding-agent";

/**
 * Format token counts for compact footer display.
 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

type FooterPresentation = "native" | "step";

/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private bashMode = false;
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;
	private readonly presentation: FooterPresentation;
	private readonly permissionCycleKey: () => string | undefined;

	constructor(
		session: AgentSession,
		footerData: ReadonlyFooterDataProvider,
		options: {
			presentation?: FooterPresentation;
			/**
			 * Key that cycles the permission preset, or undefined when the session
			 * has no such cycle. Supplied by the caller so the footer stays
			 * presentational and does not have to resolve keybindings itself.
			 */
			permissionCycleKey?: () => string | undefined;
		} = {},
	) {
		this.session = session;
		this.footerData = footerData;
		this.presentation = options.presentation ?? "native";
		this.permissionCycleKey = options.permissionCycleKey ?? (() => undefined);
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	/**
	 * While the composer holds a bash command (`!` prefix), the leading
	 * permission segment shows the shell state instead of the permission mode.
	 */
	setBashMode(active: boolean): void {
		this.bashMode = active;
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	render(width: number): string[] {
		if (this.presentation === "step") {
			return this.renderStepPresentation(width);
		}

		const state = this.session.state;

		// Calculate cumulative usage from ALL session entries (not just post-compaction messages)
		const { usageTotals, latestCacheHitRate } = this.computeUsageTotals();

		// Calculate context usage from session (handles compaction correctly).
		// After compaction, tokens are unknown until the next LLM response.
		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

		// Replace home directory with ~
		let pwd = formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);

		// Add git branch if available
		const branch = this.footerData.getGitBranch();
		if (branch) {
			pwd = `${pwd} (${branch})`;
		}

		// Add session name if set
		const sessionName = this.session.sessionManager.getSessionName();
		if (sessionName) {
			pwd = `${pwd} • ${sessionName}`;
		}

		// Build stats line
		const statsParts = [];
		if (usageTotals.input) statsParts.push(`↑${formatTokens(usageTotals.input)}`);
		if (usageTotals.output) statsParts.push(`↓${formatTokens(usageTotals.output)}`);
		if (usageTotals.cacheRead) statsParts.push(`R${formatTokens(usageTotals.cacheRead)}`);
		if (usageTotals.cacheWrite) statsParts.push(`W${formatTokens(usageTotals.cacheWrite)}`);
		if ((usageTotals.cacheRead > 0 || usageTotals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
			statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
		}

		// Kimi Coding is subscription-backed despite using API-key authentication.
		const usingSubscription = state.model
			? state.model.provider === "kimi-coding" || this.session.modelRuntime.isUsingSubscription(state.model.provider)
			: false;
		if (usageTotals.cost || usingSubscription) {
			const costStr = `$${usageTotals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;
			statsParts.push(costStr);
		}

		// Colorize context percentage based on usage
		let contextPercentStr: string;
		const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
		const contextPercentDisplay =
			contextPercent === "?"
				? `?/${formatTokens(contextWindow)}${autoIndicator}`
				: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
		if (contextPercentValue > 90) {
			contextPercentStr = theme.fg("error", contextPercentDisplay);
		} else if (contextPercentValue > 70) {
			contextPercentStr = theme.fg("warning", contextPercentDisplay);
		} else {
			contextPercentStr = contextPercentDisplay;
		}
		statsParts.push(contextPercentStr);

		let statsLeft = statsParts.join(" ");

		// Add model name on the right side, plus thinking level if model supports it
		const modelName = state.model?.id || "no-model";

		let statsLeftWidth = visibleWidth(statsLeft);

		// If statsLeft is too wide, truncate it
		if (statsLeftWidth > width) {
			statsLeft = truncateToWidth(statsLeft, width, "...");
			statsLeftWidth = visibleWidth(statsLeft);
		}

		// Calculate available space for padding (minimum 2 spaces between stats and model)
		const minPadding = 2;

		// Add thinking level indicator if model supports reasoning
		let rightSideWithoutProvider = modelName;
		if (state.model?.reasoning) {
			const thinkingLevel = state.thinkingLevel || "off";
			rightSideWithoutProvider =
				thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
		}

		// Prepend the provider in parentheses if there are multiple providers and there's enough room
		let rightSide = rightSideWithoutProvider;
		if (this.footerData.getAvailableProviderCount() > 1 && state.model) {
			rightSide = `(${state.model!.provider}) ${rightSideWithoutProvider}`;
			if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
				// Too wide, fall back
				rightSide = rightSideWithoutProvider;
			}
		}

		const rightSideWidth = visibleWidth(rightSide);
		const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

		let statsLine: string;
		if (totalNeeded <= width) {
			// Both fit - add padding to right-align model
			const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
			statsLine = statsLeft + padding + rightSide;
		} else {
			// Need to truncate right side
			const availableForRight = width - statsLeftWidth - minPadding;
			if (availableForRight > 0) {
				const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
				const truncatedRightWidth = visibleWidth(truncatedRight);
				const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
				statsLine = statsLeft + padding + truncatedRight;
			} else {
				// Not enough space for right side at all
				statsLine = statsLeft;
			}
		}

		// Apply dim to each part separately. statsLeft may contain color codes (for context %)
		// that end with a reset, which would clear an outer dim wrapper. So we dim the parts
		// before and after the colored section independently.
		const dimStatsLeft = theme.fg("dim", statsLeft);
		const remainder = statsLine.slice(statsLeft.length); // padding + rightSide
		const dimRemainder = theme.fg("dim", remainder);

		const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
		const lines = [pwdLine, dimStatsLeft + dimRemainder];

		// Add extension statuses on a single line, sorted by key alphabetically
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			const statusLine = sortedStatuses.join(" ");
			// Truncate to terminal width with dim ellipsis for consistency with footer style
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
		}

		return lines;
	}

	/**
	 * Cumulative usage across ALL session entries (assistant messages, tool
	 * results, compaction/branch summaries), plus the latest cache hit rate.
	 * Shared by the native and Step footer presentations.
	 */
	private computeUsageTotals(): { usageTotals: ReturnType<typeof createUsageTotals>; latestCacheHitRate?: number } {
		const usageTotals = createUsageTotals();
		let latestCacheHitRate: number | undefined;

		for (const entry of this.session.sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				addUsageToTotals(usageTotals, entry.message.usage);

				const latestPromptTokens =
					entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
				latestCacheHitRate =
					latestPromptTokens > 0 ? (entry.message.usage.cacheRead / latestPromptTokens) * 100 : undefined;
			} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
				addUsageToTotals(usageTotals, entry.message.usage);
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
		}

		return { usageTotals, latestCacheHitRate };
	}

	/**
	 * Step's footer is a compact, single-line operational readout. Keep this as
	 * a presentation branch so the Pi footer remains the default for the Pi
	 * entrypoint and all extension APIs continue to receive the same provider.
	 */
	private renderStepPresentation(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const state = this.session.state;
		const muted = (text: string) => theme.fg("muted", text);
		const accent = (text: string) => theme.fg("accent", text);
		const warning = (text: string) => theme.fg("warning", text);
		const error = (text: string) => theme.fg("error", text);

		const permissionStatus = this.footerData.getExtensionStatuses().get("step-permission");
		const statusPreset = permissionStatus?.match(/^Mode:\s*([^()]+?)(?:\s*\(auto-resume\))?$/u)?.[1]?.trim();
		// Extension statuses use human-readable labels (for example "Read Only"),
		// while embedded hosts may expose the corresponding id ("read-only" or
		// "readOnly"). Normalize the vocabulary before selecting the footer color.
		const normalizedStatusPreset = statusPreset?.toLowerCase().replace(/[\s_-]+/gu, "");
		const rawMode = String(
			(this.session as unknown as { approvalMode?: string }).approvalMode ??
				(this.session as unknown as { permissionMode?: string }).permissionMode ??
				"confirm",
		);
		const normalizedRawMode = rawMode
			.trim()
			.toLowerCase()
			.replace(/[\s_-]+/gu, "");
		const mode =
			normalizedStatusPreset === "autopilot"
				? { label: "Autopilot", paint: warning }
				: normalizedStatusPreset === "bypass"
					? { label: "Bypass", paint: warning }
					: normalizedRawMode === "auto" || normalizedRawMode === "bypasspermissions"
						? { label: "Bypass", paint: warning }
						: normalizedStatusPreset === "readonly" ||
								normalizedRawMode === "strict" ||
								normalizedRawMode === "readonly"
							? { label: "Read-only", paint: muted }
							: { label: "Ask", paint: accent };
		const displayMode = this.bashMode ? { label: "Shell", paint: (text: string) => theme.fg("error", text) } : mode;
		// The permission cycle was reachable but invisible: the footer named the
		// mode and nothing said how to change it. Feedback issue-b39a464025061aa5.
		const cycleHint = !this.bashMode && safeWidth >= 60 ? (this.permissionCycleKey() ?? "") : "";
		const segments: string[] = [
			displayMode.paint(`⏵ ${displayMode.label}`) + (cycleHint ? muted(` (${cycleHint})`) : ""),
		];

		const model = state.model?.id;
		if (safeWidth >= 60 && model) {
			segments.push(muted(model));
			if (state.model?.reasoning && state.thinkingLevel !== "off") {
				segments.push(muted(abbreviateStepThinkingLevel(state.thinkingLevel)));
			}
		}
		if (safeWidth >= 80) {
			const cwd = formatCwdForFooter(
				this.session.sessionManager.getCwd(),
				process.env.HOME || process.env.USERPROFILE,
			);
			if (cwd.length > 0) {
				const displayCwd =
					safeWidth >= 100
						? truncateStepMiddle(cwd, Math.max(12, Math.floor(safeWidth / 3)))
						: cwd.split(/[\\/]/u).pop() || cwd;
				segments.push(muted(displayCwd));
			}
		}

		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (safeWidth >= 100) {
			for (const [key, status] of [...extensionStatuses.entries()].sort(([a], [b]) => a.localeCompare(b))) {
				// Permission is already the leading segment; keeping its status here
				// duplicates the mode on wide terminals.
				if (key === "step-permission") continue;
				const cleaned = status
					.replace(/[\r\n\t]+/gu, " ")
					.replace(/ +/gu, " ")
					.trim();
				if (cleaned) segments.push(muted(cleaned));
			}
		}

		const left = segments.join(muted(" · "));
		const usage = this.session.getContextUsage();

		if (usage?.percent === null || usage?.percent === undefined) {
			return [truncateToWidth(left, safeWidth, "")];
		}

		const usedPercent = Math.max(0, Math.min(100, usage.percent));
		const contextLeftText = `${Math.round(100 - usedPercent)}% context left`;
		// Same thresholds as the native footer: >90% used turns error, >70% warning.
		const contextPaint = usedPercent > 90 ? error : usedPercent > 70 ? warning : muted;
		const right = contextPaint(contextLeftText);

		const leftWidth = visibleWidth(left);
		const contextWidth = visibleWidth(right);
		const gap = safeWidth - leftWidth - contextWidth;
		if (gap >= 2) {
			return [`${left}${" ".repeat(gap)}${right}`];
		}

		const available = Math.max(0, safeWidth - contextWidth - 1);
		const trimmed = truncateToWidth(left, available, "");
		const trimmedWidth = visibleWidth(trimmed);
		const trimmedGap = safeWidth - trimmedWidth - contextWidth;
		return trimmedGap >= 1
			? [`${trimmed}${" ".repeat(trimmedGap)}${right}`]
			: [truncateToWidth(right, safeWidth, "")];
	}
}

/** Middle-elide a path without splitting a wide grapheme or ANSI sequence. */
function truncateStepMiddle(value: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(value) <= maxWidth) return value;
	if (maxWidth === 1) return "…";

	const budget = maxWidth - 1;
	const headWidth = Math.ceil(budget / 2);
	const tailWidth = budget - headWidth;
	const totalWidth = visibleWidth(value);
	const head = sliceByColumn(value, 0, headWidth, true);
	const tail = tailWidth > 0 ? sliceByColumn(value, Math.max(0, totalWidth - tailWidth), tailWidth, true) : "";
	return `${head}…${tail}`;
}

/** Keep the compact Step footer readable in the 60-99 column bands. */
function abbreviateStepThinkingLevel(level: string): string {
	switch (level) {
		case "medium":
			return "med";
		case "xhigh":
			return "xhi";
		default:
			return level;
	}
}
