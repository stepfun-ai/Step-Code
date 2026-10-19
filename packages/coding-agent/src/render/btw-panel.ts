/**
 * Side-question panel and history (`/btw`).
 *
 * Mirrors Claude Code's side question: the exchange never joins the main
 * conversation. Claude Code forks the message list, runs one turn with
 * `skipTranscript`, discards the returned messages, and keeps the answer in an
 * in-memory `btwHistory` that only the next side question reads. Step's
 * equivalent of that fork is `ctx.modelRegistry.complete()`, which talks to the
 * same provider with the same credentials but owns no agent and no session, so
 * nothing is appended anywhere. This module owns the panel and that history.
 */

import type { Component, KeybindingsManager, TUI } from "@step-harness/pi-tui";
import {
	getKeybindings,
	Loader,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@step-harness/pi-tui";
import type { AssistantMessage, Message } from "@step-harness/providers";
import type { Theme } from "../theme/theme.ts";

/** Marks the side question in telemetry and in the prompt; never a session entry. */
export const BTW_QUERY_SOURCE = "side_question";
export const BTW_PENDING_LABEL = "Answering…";
export const BTW_IDLE_LABEL = "Waiting for the current turn…";
export const BTW_NO_ANSWER = "No answer available for this side question. Try again, or ask in the main conversation.";
export const BTW_CANCELLED = "Side question cancelled";

/** Claude Code keeps the last 20 exchanges; match it so the prompt cost is bounded. */
const BTW_HISTORY_LIMIT = 20;

export interface BtwExchange {
	question: string;
	response: string;
	/** The provider's own message, replayed verbatim into the next side question. */
	message: AssistantMessage;
}

/**
 * Side-question history, in memory only.
 *
 * Read by the next `/btw` so follow-ups have context, and never by a main turn.
 * It dies with the process: persisting it would put the exchanges back into the
 * session the whole feature exists to keep them out of.
 */
export class BtwHistory {
	private exchanges: BtwExchange[] = [];

	append(question: string, message: AssistantMessage): void {
		const response = assistantText(message);
		this.exchanges = [...this.exchanges, { question, response, message }].slice(-BTW_HISTORY_LIMIT);
	}

	get size(): number {
		return this.exchanges.length;
	}

	list(): readonly BtwExchange[] {
		return this.exchanges;
	}

	clear(): void {
		this.exchanges = [];
	}

	/** Prior exchanges as alternating user/assistant turns, for the next side question. */
	toMessages(): Message[] {
		return this.exchanges.flatMap((exchange): Message[] => [
			{ role: "user", content: [{ type: "text", text: exchange.question }], timestamp: exchange.message.timestamp },
			exchange.message,
		]);
	}
}

/** Concatenated text blocks of an assistant message; thinking and tool calls dropped. */
export function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("");
}

export type BtwPanelOutcome = "closed";

export interface BtwPanelOptions {
	question: string;
	theme: Theme;
	/** Earlier exchanges, newest last; browsed with shift+left/right. */
	history: readonly BtwExchange[];
	/**
	 * Host TUI, used to animate the waiting spinner. Omit (tests, headless) and
	 * the panel renders the label with a static frame instead.
	 */
	tui?: TUI;
	onClose: (outcome: BtwPanelOutcome) => void;
	/** Copy the shown answer. Returns false when there is nothing to copy. */
	onCopy?: (text: string) => void;
	onClearHistory?: () => void;
	/** Repaint hook, supplied by the overlay host. */
	onChange?: () => void;
}

/**
 * The floating panel: question, answer, and the chords Claude Code offers.
 *
 * Index 0 is the live exchange; 1..n browse back through `history` newest
 * first. Browsing a past exchange is read-only, so the live answer keeps
 * updating underneath and is still there when the user comes back to it.
 */
export class BtwPanel implements Component {
	private readonly options: BtwPanelOptions;
	private readonly keybindings: KeybindingsManager;
	private answer = "";
	private loading = true;
	private loadingLabel = BTW_PENDING_LABEL;
	private history: readonly BtwExchange[];
	private browseIndex = 0;
	private scroll = 0;
	private lastBodyHeight = 1;
	private notice: string | undefined;
	/**
	 * Spinner shown while waiting. `Loader` is used for its frame clock only: the
	 * panel builds its own rows, so the frame is captured out of the paint
	 * callback the same way the bash card does, and `Loader`'s own `requestRender`
	 * drives the repaint.
	 */
	private readonly loader: Loader | undefined;
	private frame = "⠋";

	constructor(options: BtwPanelOptions, keybindings: KeybindingsManager = getKeybindings()) {
		this.options = options;
		this.keybindings = keybindings;
		this.history = options.history;
		this.loader = options.tui
			? new Loader(
					options.tui,
					(frame) => {
						this.frame = frame || "⠋";
						return frame;
					},
					(text) => text,
					"",
				)
			: undefined;
	}

	/** Called by the overlay host on close; stops the spinner's interval. */
	dispose(): void {
		this.loader?.stop();
	}

	setAnswer(text: string): void {
		this.answer = text;
		this.options.onChange?.();
	}

	setLoadingLabel(label: string): void {
		this.loadingLabel = label;
		this.options.onChange?.();
	}

	finish(): void {
		this.loading = false;
		this.loader?.stop();
		this.options.onChange?.();
	}

	/** Expose what the panel is showing, so tests and `c` agree on one string. */
	get shownAnswer(): string {
		if (this.browseIndex === 0) return this.answer;
		return this.history[this.history.length - this.browseIndex]?.response ?? "";
	}

	private get shownQuestion(): string {
		if (this.browseIndex === 0) return this.options.question;
		return this.history[this.history.length - this.browseIndex]?.question ?? "";
	}

	handleInput(data: string): void {
		const kb = this.keybindings;
		if (kb.matches(data, "tui.select.cancel") || data === "\u0003") {
			this.options.onClose("closed");
			return;
		}
		// Shift+arrows browse; plain arrows scroll. Checked first so a terminal that
		// reports shift+left as a distinct sequence is not read as a bare left.
		if (matchesKey(data, "shift+left")) {
			this.browse(this.browseIndex + 1);
			return;
		}
		if (matchesKey(data, "shift+right")) {
			this.browse(this.browseIndex - 1);
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			this.scrollBy(-1);
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.scrollBy(1);
			return;
		}
		if (data === "c") {
			const text = this.shownAnswer.trim();
			this.notice = text.length === 0 ? "Nothing to copy" : "Copied";
			if (text.length > 0) this.options.onCopy?.(text);
			this.options.onChange?.();
			return;
		}
		if (data === "x") {
			this.history = [];
			this.browseIndex = 0;
			this.scroll = 0;
			this.notice = "History cleared";
			this.options.onClearHistory?.();
			this.options.onChange?.();
		}
	}

	private browse(next: number): void {
		const clamped = Math.max(0, Math.min(this.history.length, next));
		if (clamped === this.browseIndex) return;
		this.browseIndex = clamped;
		this.scroll = 0;
		this.notice = undefined;
		this.options.onChange?.();
	}

	private scrollBy(delta: number): void {
		const next = Math.max(0, this.scroll + delta);
		if (next === this.scroll) return;
		this.scroll = next;
		this.options.onChange?.();
	}

	invalidate(): void {}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const contentWidth = Math.max(1, safeWidth - 2);
		const theme = this.options.theme;
		const fg = (color: Parameters<Theme["fg"]>[0], text: string): string => theme.fg(color, text);
		const rows: string[] = [];

		const heading = `/btw ${this.shownQuestion}`;
		for (const line of wrapTextWithAnsi(heading, contentWidth)) {
			rows.push(` ${fg("accent", theme.bold(line))}`);
		}
		if (this.history.length > 0) {
			const label =
				this.browseIndex === 0
					? `(+${this.history.length} earlier /btw)`
					: `(${this.browseIndex} of ${this.history.length} back)`;
			rows.push(` ${fg("dim", label)}`);
		}
		rows.push("");

		const body = this.bodyRows(contentWidth, fg);
		// Clamp the scroll against the body actually produced, so a shrinking
		// answer cannot leave the view parked past its end.
		this.lastBodyHeight = body.length;
		const maxScroll = Math.max(0, body.length - 1);
		if (this.scroll > maxScroll) this.scroll = maxScroll;
		for (const line of body.slice(this.scroll)) rows.push(line);

		rows.push("");
		rows.push(` ${fg("muted", this.renderHint())}`);
		return rows.map((row) => (visibleWidth(row) > safeWidth ? truncateToWidth(row, safeWidth, "", false) : row));
	}

	private bodyRows(contentWidth: number, fg: (color: Parameters<Theme["fg"]>[0], text: string) => string): string[] {
		const live = this.browseIndex === 0;
		if (live && this.loading) {
			const spinner = fg("accent", this.frame);
			return wrapTextWithAnsi(this.loadingLabel, Math.max(1, contentWidth - 2)).map(
				(line, index) => ` ${index === 0 ? spinner : " "} ${fg("muted", line)}`,
			);
		}
		const text = this.shownAnswer.replace(/\s+$/u, "");
		if (text.length === 0) {
			return wrapTextWithAnsi(BTW_NO_ANSWER, contentWidth).map((line) => ` ${fg("muted", line)}`);
		}
		// Plain rows, not Markdown: a re-parsed Markdown tree per repaint flickers
		// on code fences, and the answer is one short response by construction.
		const rows: string[] = [];
		for (const line of text.split("\n")) {
			for (const wrapped of wrapTextWithAnsi(line, contentWidth)) rows.push(` ${fg("text", wrapped)}`);
		}
		return rows;
	}

	private renderHint(): string {
		if (this.notice) return this.notice;
		const parts = ["esc close", "c copy"];
		if (this.history.length > 0) parts.push("shift+←→ browse", "x clear history");
		if (this.lastBodyHeight > 1) parts.push("↑↓ scroll");
		return parts.join("  ");
	}
}

/** Build the overlay component for `ctx.ui.custom`; `onChange` repaints the host TUI. */
export function createBtwPanel(options: BtwPanelOptions): BtwPanel {
	return new BtwPanel(options, getKeybindings());
}
