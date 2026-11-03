import { DynamicBorder, theme } from "@step-harness/coding-agent";
import { Container, getKeybindings, Spacer, Text } from "@step-harness/pi-tui";

/** One warning the session recorded for the footer badge. */
export interface SessionWarning {
	readonly message: string;
	readonly at: number;
}

export interface WarningListOptions {
	/** Read on every render, so a warning that arrives while the list is open appears in it. */
	readonly getWarnings: () => readonly SessionWarning[];
	/** Warnings shown at once; see warningListCapacity. */
	readonly maxVisible: number;
	readonly onClose: () => void;
	/** Clear the session's warnings; the owner closes the list. */
	readonly onClear: () => void;
}

/** Upper bound on warnings shown at once, however tall the terminal is. */
const MAX_VISIBLE = 6;
/** Rows the dialog spends on its frame, header, hint and scroll position. */
const CHROME_ROWS = 10;
/** A warning row is a spacer plus, typically, up to two wrapped lines. */
const ROWS_PER_WARNING = 3;

/** How many warnings fit a terminal `rows` tall without pushing the dialog off screen. */
export function warningListCapacity(rows: number): number {
	return Math.max(1, Math.min(MAX_VISIBLE, Math.floor((rows - CHROME_ROWS) / ROWS_PER_WARNING)));
}

/**
 * The scrollable list behind the footer's warning badge.
 *
 * Step keeps ambient warnings out of the transcript, so this dialog is where
 * their text lives. Newest first: the warning that just arrived is the one the
 * reader is most likely opening the list for.
 */
export class WarningListComponent extends Container {
	private readonly options: WarningListOptions;
	private newestFirst: readonly SessionWarning[] = [];
	/** Identifies the list last built, so a render rebuilds only when warnings changed. */
	private shownKey = "";
	/** Index into the newest-first list of the first visible row. */
	private start = 0;

	constructor(options: WarningListOptions) {
		super();
		this.options = options;
		this.sync();
	}

	override render(width: number): string[] {
		this.sync();
		return super.render(width);
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up")) {
			if (this.start > 0) {
				this.start -= 1;
				this.rebuild();
			}
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			if (this.start + this.options.maxVisible < this.newestFirst.length) {
				this.start += 1;
				this.rebuild();
			}
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.options.onClose();
			return;
		}
		if (data === "c") {
			this.options.onClear();
		}
	}

	private sync(): void {
		const warnings = this.options.getWarnings();
		const key = `${warnings.length}:${warnings[0]?.at ?? 0}:${warnings.at(-1)?.at ?? 0}`;
		if (key === this.shownKey) return;
		const grew = warnings.length - this.newestFirst.length;
		this.shownKey = key;
		this.newestFirst = [...warnings].reverse();
		// New warnings land at the top; keep the rows the reader scrolled to in place.
		if (this.start > 0 && grew > 0) this.start += grew;
		this.start = Math.max(0, Math.min(this.start, this.newestFirst.length - this.options.maxVisible));
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		const total = this.newestFirst.length;
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold(`Warnings (${total})`), 1, 0));
		this.addChild(new Text(theme.fg("muted", "↑↓ scroll · c clears · Esc closes"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		const visible = this.newestFirst.slice(this.start, this.start + this.options.maxVisible);
		for (const warning of visible) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("warning", "⚠ ") + warning.message, 1, 0));
		}

		if (total > visible.length) {
			this.addChild(new Spacer(1));
			this.addChild(
				new Text(theme.fg("muted", `  ${this.start + 1}-${this.start + visible.length} of ${total}`), 1, 0),
			);
		}
	}
}
