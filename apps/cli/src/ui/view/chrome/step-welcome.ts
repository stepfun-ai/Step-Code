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
	renderBirdStatic,
	renderStepMark,
	STEP_MARK_COLUMNS,
} from "./step-logo.ts";

/** Live facts shown in the Step session welcome block. */
export interface StepWelcomeInfo {
	version?: string;
	model?: string;
	/** Current reasoning level; omitted when the model does not support reasoning. */
	thinkingLevel?: string;
	workspaceRoot: string;
	sessionId?: string;
}

const WELCOME_TITLE = "Step CLI";
const WELCOME_MARK = renderStepMark();
const WELCOME_MARK_GAP = 3;
/** Total intro run: the pedal cycle loops until this window elapses. */
const LOGO_INTRO_TOTAL_MS = 5000;
const WELCOME_MARK_MIN_TEXT_WIDTH = 32;
const FIRST_SESSION_HINT = "Your first message will start a new session.";
const ansiBold = (text: string): string => `\x1b[1m${text}\x1b[22m`;

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
	private visible = true;
	private showFirstMessageHint = false;
	private logoFrame: number | null = null;
	private logoIntroPlayed = false;
	private disposed = false;
	private logoTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(getInfo: () => StepWelcomeInfo, options: (() => void) | { requestRender?: () => void } = {}) {
		this.getInfo = getInfo;
		this.requestRenderCallback = typeof options === "function" ? options : (options.requestRender ?? (() => {}));
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
	setLogoFrame(frame: number | null): void {
		if (this.logoFrame === frame) return;
		this.logoFrame = frame;
		this.requestRenderCallback();
	}

	/**
	 * Plays the one-shot riding-bird intro: the pedal cycle loops until
	 * LOGO_INTRO_TOTAL_MS (~5s, several wheel turns) elapses, then settles on
	 * the static frame. Callers should call `dispose()` when the interactive
	 * mode is torn down.
	 */
	playLogoIntro(): void {
		if (this.disposed || this.logoIntroPlayed || BIRD_FRAME_COUNT === 0) return;
		this.logoIntroPlayed = true;
		const endsAt = Date.now() + LOGO_INTRO_TOTAL_MS;
		let frame = 0;
		this.setLogoFrame(frame);
		const advance = (): void => {
			frame = (frame + 1) % BIRD_FRAME_COUNT;
			if (Date.now() >= endsAt) {
				this.logoTimer = null;
				this.setLogoFrame(null);
				return;
			}
			this.setLogoFrame(frame);
			this.logoTimer = setTimeout(advance, BIRD_FRAME_DURATIONS_MS[frame] ?? 80);
		};
		this.logoTimer = setTimeout(advance, BIRD_FRAME_DURATIONS_MS[0] ?? 80);
	}

	/** Ends an in-flight intro early, settling on the static logo. */
	stopLogoIntro(): void {
		if (this.logoTimer === null) return;
		clearTimeout(this.logoTimer);
		this.logoTimer = null;
		this.setLogoFrame(null);
	}

	/** Drops the intro timer on teardown; unlike `stopLogoIntro`, it repaints nothing. */
	dispose(): void {
		this.disposed = true;
		if (this.logoTimer !== null) {
			clearTimeout(this.logoTimer);
			this.logoTimer = null;
		}
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
		const headerWidth = markTier === "badge" ? innerWidth : innerWidth - markColumns - WELCOME_MARK_GAP;

		const version = info.version?.trim() ?? "";
		const versionSuffix = version === "" ? "" : ` ${muted(`/ ${version.startsWith("v") ? version : `v${version}`}`)}`;
		// The old Step renderer emitted bold explicitly (rather than delegating to
		// Chalk, which disables attributes for captured/non-TTY output).
		const title = `${ansiBold(WELCOME_TITLE)}${versionSuffix}`;
		const badge = brand(paintStepBadge(" STEP "));
		const header: string[] = [markTier === "badge" ? `${badge} ${title}` : title];

		if (info !== undefined) {
			header.push("");
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

		let rows: string[];
		if (markTier === "badge") {
			rows = header;
		} else {
			const logoTheme = createStepLogoTheme();
			const mark =
				markTier === "bird"
					? this.logoFrame === null
						? renderBirdStatic(logoTheme)
						: renderBirdFrame(logoTheme, this.logoFrame)
					: WELCOME_MARK;
			rows = alignMarkWithBody(mark, header, {
				gap: WELCOME_MARK_GAP,
				markColumns,
			});
		}

		const borderInnerWidth = Math.max(1, safeWidth - 2);
		const top = brand(`╭${"─".repeat(borderInnerWidth)}╮`);
		const bottom = brand(`╰${"─".repeat(borderInnerWidth)}╯`);
		const framed = rows.map((row) => {
			// Match the former TranscriptView: frame first, then clamp the complete
			// styled row to the terminal width. Clipping the body before adding the
			// rails changes where the ellipsis appears on narrow terminals.
			const padding = Math.max(0, innerWidth - visibleWidth(row));
			return `${brand("│ ")}${row}${" ".repeat(padding)}${brand(" │")}`;
		});

		const lines = [top, ...framed, bottom, ""];
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
