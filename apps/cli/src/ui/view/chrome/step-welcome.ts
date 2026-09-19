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
	stepLogoColorOpen,
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
/** Ride-in phase of the intro: the bird races in while the word trails behind. */
const STRIP_RIDE_MS = 1600;

/**
 * 7-wide 8-row letterforms dragged behind the bird. Each glyph pixel renders
 * as one solid cell; row 8 stays empty so the drop shadow fits inside the
 * strip.
 */
const STRIP_WORD = "STEP CLI";
/**
 * Upright squared letterforms for the dragged word (7 wide, 8 rows). The
 * renderer shears them into an italic slant and adds bevel highlights.
 */
const STRIP_BASE_FONT: Record<string, string[]> = {
	S: ["#######", "##     ", "##     ", "#######", "     ##", "     ##", "#######", "       "],
	T: ["#######", "   ##  ", "   ##  ", "   ##  ", "   ##  ", "   ##  ", "   ##  ", "       "],
	E: ["#######", "##     ", "##     ", "#######", "##     ", "##     ", "#######", "       "],
	P: ["#######", "##    ##", "##    ##", "#######", "##     ", "##     ", "##     ", "        "],
	C: ["#######", "##     ", "##     ", "##     ", "##     ", "##     ", "#######", "       "],
	L: ["##     ", "##     ", "##     ", "##     ", "##     ", "##     ", "#######", "       "],
	I: ["###", " # ", " # ", " # ", " # ", " # ", "###", "   "],
	" ": ["   ", "   ", "   ", "   ", "   ", "   ", "   ", "   "],
};

/** Italic shear: each row from the top shifts right by up to 3 cells. */
function glyphShear(glyphRows: number): number[] {
	return Array.from({ length: glyphRows }, (_, gy) => Math.round((glyphRows - 1 - gy) / 2.6));
}
/** Rope length between the word's last letter and the bird's tail, in cells. */
const STRIP_ROPE_CELLS = 5;

/** Visible width of the dragged word, in cells. */
function stripWordWidth(): number {
	let w = 0;
	for (const ch of STRIP_WORD) w += STRIP_BASE_FONT[ch]![0]!.length + 3;
	return w - 1; // no trailing letter gap
}

const STRIP_ROWS = 9;
/** Whole composition width: word + rope + bird, centered in the strip. */
function stripCompositionWidth(): number {
	return stripWordWidth() + STRIP_ROPE_CELLS + BIRD_COLUMNS;
}
/** Strip needs the composition plus a little margin to be worth it. */
const STRIP_MIN_INNER = stripCompositionWidth() + 4;

const easeOutCubic = (p: number): number => 1 - (1 - p) ** 3;

/** Dim SGR open for the letter shadow runs. */
function stepLogoDimOpen(): string {
	const dim = theme.fg("dim", "\u2588");
	const open = dim.slice(0, dim.lastIndexOf("\u2588"));
	return open;
}

/** Hex color mixed from violet to gold, for the word's letter gradient. */
function mixVioletToGold(t: number): string {
	const from = [0xaa, 0x91, 0xf0];
	const to = [0xf4, 0xd5, 0x6b];
	const channel = (a: number, b: number): string =>
		Math.round(a + (b - a) * Math.min(1, Math.max(0, t)))
			.toString(16)
			.padStart(2, "0");
	return `#${channel(from[0]!, to[0]!)}${channel(from[1]!, to[1]!)}${channel(from[2]!, to[2]!)}`;
}
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
	private readonly requestForceRenderCallback: (() => void) | undefined;
	private visible = true;
	private showFirstMessageHint = false;
	private logoFrame: number | null = null;
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
	setLogoFrame(frame: number | null): void {
		if (this.logoFrame === frame) return;
		this.logoFrame = frame;
		// Intro frames repaint whole: the strip's per-cell styling (hundreds of
		// SGR switches per row) trips the incremental diff renderer, leaving a
		// corrupted mix of stale ride frames on screen.
		(this.requestForceRenderCallback ?? this.requestRenderCallback)();
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
		this.introStartedAt = Date.now();
		const endsAt = Date.now() + LOGO_INTRO_TOTAL_MS;
		let frame = 0;
		this.setLogoFrame(frame);
		const advance = (): void => {
			frame = (frame + 1) % BIRD_FRAME_COUNT;
			if (Date.now() >= endsAt) {
				this.logoTimer = null;
				this.introStartedAt = null;
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
		this.introStartedAt = null;
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

	/**
	 * The ride-in strip: the bird pedals toward the right while the STEP CLI
	 * block letters trail behind on a dashed rope, waving in the slipstream.
	 * Settles to bird-right / word-left once the ride window elapses.
	 */
	private buildStrip(innerWidth: number): string[] {
		const logoTheme = createStepLogoTheme();
		const animating = this.logoFrame !== null;
		const elapsed = this.introStartedAt === null ? Number.POSITIVE_INFINITY : Date.now() - this.introStartedAt;
		const ride = Math.min(1, elapsed / STRIP_RIDE_MS);
		const progress = easeOutCubic(ride);

		const wordW = stripWordWidth();
		// Center the settled composition; the ride-in targets that spot.
		const compositionX = Math.max(0, Math.floor((innerWidth - stripCompositionWidth()) / 2));
		const stopBirdX = compositionX + wordW + STRIP_ROPE_CELLS;
		const birdX = Math.round(-BIRD_COLUMNS - 2 + (stopBirdX + BIRD_COLUMNS + 2) * progress);
		const lettersRight = birdX - STRIP_ROPE_CELLS;
		const lettersX = lettersRight - wordW;

		type Cell = string | { open: string; ch: string } | undefined;
		const grid: Cell[][] = Array.from({ length: STRIP_ROWS }, () => new Array<Cell>(innerWidth).fill(undefined));

		// The bird.
		const birdCells = animating ? renderBirdFrameCells(logoTheme, this.logoFrame!) : renderBirdStaticCells(logoTheme);
		birdCells.forEach((row, r) => {
			row.forEach((cell, c) => {
				const x = birdX + c;
				if (cell !== undefined && x >= 0 && x < innerWidth) grid[r]![x] = cell;
			});
		});

		// The dragged word: italic solid letters in a violet→gold gradient.
		// Each glyph row shifts right toward the top (shear); the right/bottom
		// edges carry a dim shadow and the top-left bevel a light highlight, so
		// the block letters read as beveled 3D slabs.
		const shadowRun = { open: stepLogoDimOpen(), ch: "\u2588" };
		const letters = STRIP_WORD.split("");
		const colored = letters.filter((ch) => ch !== " ");
		const shears = glyphShear(8);
		let cx = lettersX;
		let seen = 0;
		letters.forEach((ch) => {
			const glyph = STRIP_BASE_FONT[ch]!;
			const inkRun = { open: stepLogoColorOpen(mixVioletToGold(seen / (colored.length - 1))), ch: "\u2588" };
			for (let gy = 0; gy < glyph.length; gy += 1) {
				const shear = shears[gy]!;
				for (let gx = 0; gx < glyph[gy]!.length; gx += 1) {
					if (glyph[gy]![gx] !== "#") continue;
					const x = cx + gx + shear;
					const y = gy;
					// Bottom shadow straight below for the beveled-slab depth.
					if (x >= 0 && x < innerWidth && y + 1 < STRIP_ROWS) grid[y + 1]![x] = shadowRun;
					if (x >= 0 && x < innerWidth) grid[y]![x] = inkRun;
				}
			}
			if (ch !== " ") seen += 1;
			cx += glyph[0]!.length + 3;
		});

		// The rope: a dashed line from the bird's tail to the word's last letter,
		// sagging one row in the middle.
		const ropeDot = theme.fg("muted", "·");
		for (let x = lettersRight + 1; x < birdX; x += 2) {
			if (x < 0 || x >= innerWidth) continue;
			const sag = x > lettersRight + 1 && x < birdX - 1 && (x - lettersRight) % 4 === 0 ? 1 : 0;
			grid[3 + sag]![x] = ropeDot;
		}

		// Run-length on output: consecutive cells sharing one SGR open merge
		// into a single escape run, several-fold smaller per animation frame.
		const joinRow = (row: Cell[]): string => {
			let line = "";
			let index = 0;
			while (index < row.length) {
				const cell = row[index]!;
				if (typeof cell === "string") {
					line += cell;
					index += 1;
					continue;
				}
				if (cell === undefined) {
					let blanks = 0;
					while (index + blanks < row.length && row[index + blanks] === undefined) blanks += 1;
					line += " ".repeat(blanks);
					index += blanks;
					continue;
				}
				let run = 0;
				while (index + run < row.length && row[index + run] === cell) run += 1;
				line += `${cell.open}${cell.ch.repeat(run)}${cell.open === "" ? "" : "\x1b[39m"}`;
				index += run;
			}
			return line;
		};
		return grid.map(joinRow);
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

		const borderInnerWidth = Math.max(1, safeWidth - 2);
		const top = brand(`╭${"─".repeat(borderInnerWidth)}╮`);
		const bottom = brand(`╰${"─".repeat(borderInnerWidth)}╯`);
		const frameRow = (row: string): string => {
			// Match the former TranscriptView: frame first, then clamp the complete
			// styled row to the terminal width. Clipping the body before adding the
			// rails changes where the ellipsis appears on narrow terminals.
			const padding = Math.max(0, innerWidth - visibleWidth(row));
			return `${brand("│ ")}${row}${" ".repeat(padding)}${brand(" │")}`;
		};

		let lines: string[];
		if (stripFits) {
			// Wide terminals: the ride-in strip sits above the info block. The
			// block has no outline — like the letters, it floats over a dim
			// shadow band one row below.
			const shadowRow = `${" ".repeat(2)}${theme.fg("dim", "\u2584".repeat(Math.max(0, innerWidth - 3)))}`;
			lines = [...this.buildStrip(innerWidth), "", ...header.map((row) => ` ${row}`), shadowRow, ""];
		} else {
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
			const framed = rows.map(frameRow);
			lines = [top, ...framed, bottom, ""];
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
