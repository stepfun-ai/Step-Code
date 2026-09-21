import { theme } from "@step-harness/coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@step-harness/pi-tui";
import { formatCwdForFooter } from "./footer.ts";
import {
	alignMarkWithBody,
	BIRD_ANIMATION_DURATION_MS,
	BIRD_COLUMNS,
	BIRD_FRAME_COUNT,
	BIRD_FRAME_DURATIONS_MS,
	createStepLogoTheme,
	paintStepBadge,
	renderBirdFrame,
	renderBirdFrameCells,
	renderBirdStatic,
	renderBirdStaticCells,
	renderStepMark,
	STEP_MARK_COLUMNS,
} from "./step-logo.ts";
import { paintStepWordmarkBorder, renderStepWordmarkCells, STEP_WORDMARK_COLUMNS } from "./step-wordmark.ts";

/** Live facts shown in the Step session welcome block. */
export interface StepWelcomeInfo {
	version?: string;
	model?: string;
	/** Current reasoning level; omitted when the model does not support reasoning. */
	thinkingLevel?: string;
	workspaceRoot: string;
	sessionId?: string;
}

const WELCOME_MARK = renderStepMark();
const WELCOME_MARK_GAP = 3;
/** Ride-in phase of the intro: the bird races in while the word trails behind. */
const STRIP_RIDE_MS = 1600;
/** Pedaling stops on arrival; a single wink follows in the static pose. */
const LOGO_INTRO_TOTAL_MS = STRIP_RIDE_MS;
const LOGO_WINK_MS = 180;

/** Transparent gap between the wordmark and the bird, in cells. */
const STRIP_GAP_CELLS = 5;

const STRIP_ROWS = 9;
/** Whole composition width: word + gap + bird, centered in the strip. */
function stripCompositionWidth(): number {
	return STEP_WORDMARK_COLUMNS + STRIP_GAP_CELLS + BIRD_COLUMNS;
}
/** Strip needs the composition plus a little margin to be worth it. */
const STRIP_MIN_INNER = stripCompositionWidth() + 4;

const easeOutCubic = (p: number): number => 1 - (1 - p) ** 3;
const WELCOME_MARK_MIN_TEXT_WIDTH = 32;
const FIRST_SESSION_HINT = "Your first message will start a new session.";
const WELCOME_TIPS = [
	{
		command: "/cron",
		description: "View and manage scheduled tasks.",
	},
	{
		command: "/goal",
		description: "Set a goal and keep working toward it across turns.",
	},
	{
		command: "ultracode",
		description: "Include this keyword in your prompt to enable parallel subagents.",
	},
] as const;

const graphemeSegmenter = new Intl.Segmenter(undefined, {
	granularity: "grapheme",
});

/**
 * The former Step renderer hard-wrapped facts by display columns (rather than
 * word-wrapping). Keep that behavior so long CJK paths and model ids land on
 * the same rows as the old TUI.
 */
function wrapMultiline(text: string, width: number): string[] {
	const budget = Math.max(1, Math.floor(width));
	const output: string[] = [];
	for (const rawLine of text.split(/\r\n|\r|\n/)) {
		if (rawLine.length === 0) {
			output.push("");
			continue;
		}
		let line = "";
		let lineWidth = 0;
		for (const { segment } of graphemeSegmenter.segment(rawLine)) {
			const segmentWidth = visibleWidth(segment);
			if (line.length > 0 && lineWidth + segmentWidth > budget) {
				output.push(line);
				line = "";
				lineWidth = 0;
			}
			// A single wide grapheme cannot fit in the budget. Keep it as a
			// truncated cell rather than looping forever or dropping the value.
			if (segmentWidth > budget) {
				output.push(truncateToWidth(segment, budget, ""));
				continue;
			}
			line += segment;
			lineWidth += segmentWidth;
		}
		output.push(line);
	}
	return output.length > 0 ? output : [""];
}

function canRenderBird(): boolean {
	// The legacy renderer used the bird on both truecolor and 256-color
	// terminals. When attached to a real TTY, honor Node's color-depth report so
	// `NO_COLOR`/`TERM=dumb` still select the monochrome mark. Captured output has
	// no stream capability report, and the initialized Pi theme defaults to a
	// color-capable mode, which keeps tests and embedders deterministic.
	const stream = process.stdout as NodeJS.WriteStream;
	if (typeof stream.getColorDepth === "function") {
		return stream.getColorDepth() >= 8;
	}
	return true;
}

/**
 * Step's compact identity block. It owns presentation state only; session facts
 * are read through the supplied getter and never copied into a second authority.
 */
export class StepWelcomeComponent implements Component {
	private readonly getInfo: () => StepWelcomeInfo;
	private readonly requestRenderCallback: () => void;
	private readonly requestForceRenderCallback: (() => void) | undefined;
	private visible = true;
	private showFirstMessageHint = false;
	private logoFrame: number | null = null;
	private logoWinking = false;
	private logoIntroPlayed = false;
	private disposed = false;
	/** Ride-in start timestamp; null once the strip is settled. */
	private introStartedAt: number | null = null;
	private logoTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		getInfo: () => StepWelcomeInfo,
		options:
			| (() => void)
			| {
					requestRender?: () => void;
					/** Full-repaint channel for the intro: the strip's dense per-cell styling corrupts incremental diff repaints, so intro frames repaint whole. */
					requestForceRender?: () => void;
			  } = {},
	) {
		this.getInfo = getInfo;
		this.requestRenderCallback = typeof options === "function" ? options : (options.requestRender ?? (() => {}));
		this.requestForceRenderCallback =
			typeof options === "function" ? undefined : (options.requestForceRender ?? options.requestRender);
	}

	setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		this.visible = visible;
		this.requestRenderCallback();
	}

	setFirstMessageHint(show: boolean): void {
		if (this.showFirstMessageHint === show) return;
		this.showFirstMessageHint = show;
		this.requestRenderCallback();
	}

	/** Selects an animation frame, or `null` for the settled logo. */
	setLogoFrame(frame: number | null, wink = false): void {
		if (this.logoFrame === frame && this.logoWinking === wink) return;
		this.logoFrame = frame;
		this.logoWinking = wink;
		// Intro frames repaint whole: the strip's per-cell styling (hundreds of
		// SGR switches per row) trips the incremental diff renderer, leaving a
		// corrupted mix of stale ride frames on screen.
		(this.requestForceRenderCallback ?? this.requestRenderCallback)();
	}

	/**
	 * Plays the one-shot riding-bird intro: the pedal cycle loops until
	 * LOGO_INTRO_TOTAL_MS (1600ms) elapses, then winks once for 180ms in
	 * the static pose. Callers should call `dispose()` when the interactive
	 * mode is torn down.
	 */
	playLogoIntro(): void {
		if (this.disposed || this.logoIntroPlayed || BIRD_FRAME_COUNT === 0) return;
		this.logoIntroPlayed = true;
		this.introStartedAt = Date.now();
		const endsAt = Date.now() + LOGO_INTRO_TOTAL_MS;
		let frame = 0;
		this.setLogoFrame(frame);
		const advance = (): void => {
			frame = (frame + 1) % BIRD_FRAME_COUNT;
			if (Date.now() >= endsAt) {
				this.introStartedAt = null;
				this.logoTimer = setTimeout(() => {
					this.logoTimer = null;
					this.setLogoFrame(null);
				}, LOGO_WINK_MS);
				this.setLogoFrame(null, true);
				return;
			}
			this.setLogoFrame(frame);
			this.logoTimer = setTimeout(advance, Math.min(BIRD_FRAME_DURATIONS_MS[frame] ?? 80, endsAt - Date.now()));
		};
		this.logoTimer = setTimeout(advance, BIRD_FRAME_DURATIONS_MS[0] ?? 80);
	}

	/** Ends an in-flight intro early, settling on the static logo. */
	stopLogoIntro(): void {
		if (this.logoTimer === null) return;
		clearTimeout(this.logoTimer);
		this.logoTimer = null;
		this.introStartedAt = null;
		this.setLogoFrame(null);
	}

	/** Drops the intro timer on teardown; unlike `stopLogoIntro`, it repaints nothing. */
	dispose(): void {
		this.disposed = true;
		this.logoWinking = false;
		if (this.logoTimer !== null) {
			clearTimeout(this.logoTimer);
			this.logoTimer = null;
		}
	}

	/**
	 * The ride-in strip: the bird pedals toward the right while the STEP CODE
	 * block letters follow with a transparent gap.
	 * Settles to bird-right / word-left once the ride window elapses.
	 */
	private buildStrip(innerWidth: number): string[] {
		const logoTheme = createStepLogoTheme();
		const animating = this.logoFrame !== null;
		const elapsed = this.introStartedAt === null ? Number.POSITIVE_INFINITY : Date.now() - this.introStartedAt;
		const ride = Math.min(1, elapsed / STRIP_RIDE_MS);
		const progress = easeOutCubic(ride);

		const wordW = STEP_WORDMARK_COLUMNS;
		// Center the settled composition; the ride-in targets that spot.
		const compositionX = Math.max(0, Math.floor((innerWidth - stripCompositionWidth()) / 2));
		const stopBirdX = compositionX + wordW + STRIP_GAP_CELLS;
		const birdX = Math.round(-BIRD_COLUMNS - 2 + (stopBirdX + BIRD_COLUMNS + 2) * progress);
		const lettersRight = birdX - STRIP_GAP_CELLS;
		const lettersX = lettersRight - wordW;

		type Cell = string | undefined;
		const grid: Cell[][] = Array.from({ length: STRIP_ROWS }, () => new Array<Cell>(innerWidth).fill(undefined));

		// The bird.
		const birdCells = animating
			? renderBirdFrameCells(logoTheme, this.logoFrame!)
			: renderBirdStaticCells(logoTheme, this.logoWinking);
		birdCells.forEach((row, r) => {
			row.forEach((cell, c) => {
				const x = birdX + c;
				if (cell !== undefined && x >= 0 && x < innerWidth) grid[r]![x] = cell;
			});
		});

		// The dragged wordmark: ANSI-shadow letterforms with per-letter
		// gradient ink and dim shadow strokes, riding rigidly behind the bird.
		renderStepWordmarkCells().forEach((row, r) => {
			row.forEach((cell, c) => {
				const x = lettersX + c;
				if (cell !== undefined && x >= 0 && x < innerWidth) grid[r]![x] = cell;
			});
		});

		// Wordmark cells are self-contained styled chars; plain join suffices.
		return grid.map((row) => row.map((cell) => cell ?? " ").join(""));
	}

	/** Component compatibility hook; rendering is cheap and uncached. */
	invalidate(): void {}

	render(width: number): string[] {
		if (!this.visible) return [];

		const safeWidth = Math.max(1, Math.floor(width));
		const innerWidth = Math.max(8, safeWidth - 4);
		const info = this.getInfo();
		const muted = (text: string) => theme.fg("muted", text);
		const brand = (text: string) => theme.fg("accent", text);

		// Keep the old bird -> CP437 mark -> STEP badge thresholds. The minimum
		// text column is intentionally fixed at 32 to avoid a cramped identity row.
		const birdFits = canRenderBird() && innerWidth - (BIRD_COLUMNS + WELCOME_MARK_GAP) >= WELCOME_MARK_MIN_TEXT_WIDTH;
		const markFits = innerWidth - (STEP_MARK_COLUMNS + WELCOME_MARK_GAP) >= WELCOME_MARK_MIN_TEXT_WIDTH;
		const markTier: "bird" | "mark" | "badge" = birdFits ? "bird" : markFits ? "mark" : "badge";
		const markColumns = markTier === "bird" ? BIRD_COLUMNS : STEP_MARK_COLUMNS;
		const stripFits = markTier === "bird" && innerWidth >= STRIP_MIN_INNER;
		const headerWidth = markTier === "badge" || stripFits ? innerWidth : innerWidth - markColumns - WELCOME_MARK_GAP;

		const version = info.version?.trim() ?? "";
		const badge = brand(paintStepBadge(" STEP "));
		const header: string[] = markTier === "badge" ? [badge, ""] : [];

		if (info !== undefined) {
			const sessionId = info.sessionId?.trim();
			const model = info.model?.trim() || "unknown model";
			const thinkingLevel = info.thinkingLevel?.trim();
			const modelValue =
				thinkingLevel === "off"
					? `${model} · reasoning: off`
					: thinkingLevel
						? `${model} · ${thinkingLevel}`
						: model;
			const facts: Array<{ label: string; value: string; highlight: boolean }> = [
				...(sessionId && !this.showFirstMessageHint
					? [{ label: "session", value: sessionId, highlight: true }]
					: []),
				{ label: "model", value: modelValue, highlight: true },
				{
					label: "cwd",
					value: formatCwdForFooter(info.workspaceRoot, process.env.HOME || process.env.USERPROFILE),
					highlight: false,
				},
			];
			const labelWidth = Math.max(...facts.map((fact) => fact.label.length));
			for (const fact of facts) {
				const valueLines = wrapMultiline(fact.value, headerWidth - labelWidth - 2);
				for (const line of valueLines) {
					const paintedValue = fact.highlight ? brand(line) : line;
					header.push(`${muted(fact.label.padEnd(labelWidth))}  ${paintedValue}`);
				}
			}
		}

		const borderInnerWidth = Math.max(1, safeWidth - 2);
		const versionLabel =
			version === "" || borderInnerWidth < 4
				? ""
				: truncateToWidth(` ${version.startsWith("v") ? version : `v${version}`} `, borderInnerWidth - 2);
		const top = versionLabel
			? [
					paintStepWordmarkBorder("╭─"),
					muted(versionLabel),
					paintStepWordmarkBorder(`${"─".repeat(borderInnerWidth - visibleWidth(versionLabel) - 1)}╮`),
				].join("")
			: paintStepWordmarkBorder(`╭${"─".repeat(borderInnerWidth)}╮`);
		const bottom = paintStepWordmarkBorder(`╰${"─".repeat(borderInnerWidth)}╯`);
		const frameRow = (row: string): string => {
			// Match the former TranscriptView: frame first, then clamp the complete
			// styled row to the terminal width. Clipping the body before adding the
			// rails changes where the ellipsis appears on narrow terminals.
			const padding = Math.max(0, innerWidth - visibleWidth(row));
			return `${paintStepWordmarkBorder("│ ")}${row}${" ".repeat(padding)}${paintStepWordmarkBorder(" │")}`;
		};
		const tips = ["", muted("Tips")];
		const prefixWidth = Math.max(...WELCOME_TIPS.map((tip) => visibleWidth(tip.command))) + 2;
		for (const tip of WELCOME_TIPS) {
			const prefix = tip.command + " ".repeat(prefixWidth - visibleWidth(tip.command));
			if (innerWidth - prefixWidth < 24) {
				tips.push(...wrapMultiline(tip.command, innerWidth).map(brand));
				tips.push(...wrapMultiline(tip.description, innerWidth - 2).map((line) => `  ${muted(line)}`));
				continue;
			}
			const descriptionLines = wrapMultiline(tip.description, innerWidth - prefixWidth);
			for (const [index, line] of descriptionLines.entries()) {
				tips.push(`${index === 0 ? brand(prefix) : " ".repeat(prefixWidth)}${muted(line)}`);
			}
		}
		const framedTips = tips.map(frameRow);

		let lines: string[];
		if (stripFits) {
			// Wide terminals: the ride-in strip sits above the framed info box.
			const framedHeader = header.map(frameRow);
			lines = [...this.buildStrip(innerWidth), "", top, ...framedHeader, ...framedTips, bottom, ""];
		} else {
			let rows: string[];
			if (markTier === "badge") {
				rows = header;
			} else {
				const logoTheme = createStepLogoTheme();
				const mark =
					markTier === "bird"
						? this.logoFrame === null
							? renderBirdStatic(logoTheme, this.logoWinking)
							: renderBirdFrame(logoTheme, this.logoFrame)
						: WELCOME_MARK;
				rows = alignMarkWithBody(mark, header, {
					gap: WELCOME_MARK_GAP,
					markColumns,
				});
			}
			const framed = rows.map(frameRow);
			lines = [top, ...framed, ...framedTips, bottom, ""];
		}
		if (this.showFirstMessageHint) {
			lines.push(muted(FIRST_SESSION_HINT), "");
		}
		// Pi's main renderer rejects over-wide lines. The old TranscriptView ran
		// the same clamp after composing this block; keep the guard local because
		// StepWelcome is mounted directly in InteractiveMode's document container.
		return lines.map((line) => (visibleWidth(line) > safeWidth ? truncateToWidth(line, safeWidth) : line));
	}
}

// Kept exported for consumers that want to display the expected intro duration
// alongside a launch indicator without duplicating the sprite table.
export { BIRD_ANIMATION_DURATION_MS };
