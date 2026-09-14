/**
 * Plan review dialog.
 *
 * The generic extension selector cannot express "one of the options is an input
 * row", so the plan review owns its own component. That also keeps its
 * deliberately frameless look off every other Step dialog.
 *
 * Theme and keybindings are injected rather than imported so the module stays
 * safe to load from the plan extension, which also runs headless.
 */

import {
	type Component,
	type Focusable,
	getKeybindings,
	Input,
	type Keybinding,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Theme } from "../theme/theme.ts";
import { formatKeyText } from "./keybinding-hints.ts";

/** What the user decided in the review dialog. */
export type PlanReviewResult =
	| { action: "execute" }
	| { action: "feedback"; text: string }
	/** Escaped out; plan mode stays on and the model gets no notes. */
	| { action: "dismissed" };

export const PLAN_REVIEW_FEEDBACK_LABEL = "Tell Step what to change";
/** The question under the divider; the rows below it are the answers. */
export const PLAN_REVIEW_PROMPT = "Step has written up a plan and is ready to execute. Would you like to proceed?";

const EXECUTE_INDEX = 0;
const FEEDBACK_INDEX = 1;
const OPTION_LABELS = ["Execute the plan", PLAN_REVIEW_FEEDBACK_LABEL] as const;

export interface PlanReviewOptions {
	planFilePath: string;
	planContents: string;
	theme: Theme;
	onResult: (result: PlanReviewResult) => void;
	/** Called whenever the rendered content changes so the host can repaint. */
	onChange?: () => void;
}

function keyLabel(action: Keybinding, fallback: string): string {
	const first = getKeybindings().getKeys(action)[0];
	return first ? formatKeyText(first) : fallback;
}

export class PlanReviewComponent implements Component, Focusable {
	private readonly planFilePath: string;
	private readonly planContents: string;
	private readonly theme: Theme;
	private readonly onResult: (result: PlanReviewResult) => void;
	private readonly onChange: (() => void) | undefined;
	private readonly input: Input;
	/** 0 = approve row, 1 = feedback row. */
	private selectedIndex = 0;
	private _focused = false;

	constructor(options: PlanReviewOptions) {
		this.planFilePath = options.planFilePath;
		this.planContents = options.planContents;
		this.theme = options.theme;
		this.onResult = options.onResult;
		this.onChange = options.onChange;
		// The row's numbered head is drawn by renderOptionRow; the label is a
		// placeholder that disappears once the user types, not part of the value.
		this.input = new Input({ prompt: "" });
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		// Only the feedback row owns a caret; the approve row must not show one.
		this.input.focused = value && this.selectedIndex === FEEDBACK_INDEX;
	}

	private get onFeedbackRow(): boolean {
		return this.selectedIndex === FEEDBACK_INDEX;
	}

	private moveSelection(next: number): void {
		const clamped = Math.max(EXECUTE_INDEX, Math.min(FEEDBACK_INDEX, next));
		if (clamped === this.selectedIndex) return;
		this.selectedIndex = clamped;
		this.input.focused = this._focused && this.onFeedbackRow;
		this.onChange?.();
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.onResult({ action: "dismissed" });
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			this.moveSelection(this.selectedIndex - 1);
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.moveSelection(this.selectedIndex + 1);
			return;
		}
		if (kb.matches(data, "tui.select.confirm") || data === "\n") {
			if (!this.onFeedbackRow) {
				this.onResult({ action: "execute" });
				return;
			}
			const text = this.input.getValue().trim();
			// Sending an empty note would read to the model as "no comment", which
			// is the choice this dialog deliberately dropped. Hold the row instead.
			if (text.length === 0) return;
			this.onResult({ action: "feedback", text });
			return;
		}
		// Number shortcuts, matching the row labels. "1" is the whole decision;
		// "2" only lands on the input because a note still has to be typed. Once
		// the feedback row is selected, digits are text, so the shortcuts stop.
		if (!this.onFeedbackRow) {
			if (data === "1") {
				this.onResult({ action: "execute" });
				return;
			}
			if (data === "2") {
				this.moveSelection(FEEDBACK_INDEX);
				return;
			}
		}
		if (this.onFeedbackRow) {
			this.input.handleInput(data);
			this.onChange?.();
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const contentWidth = Math.max(1, safeWidth - 2);
		const fg = (color: Parameters<Theme["fg"]>[0], text: string): string => this.theme.fg(color, text);
		const rows: string[] = [];

		const heading = `● Plan ready for review (${this.planFilePath}):`;
		for (const line of wrapTextWithAnsi(heading, contentWidth)) {
			rows.push(` ${fg("accent", this.theme.bold(line))}`);
		}
		// The plan is shown whole, with its blank lines and indentation: this is the
		// text the user is being asked to approve.
		for (const line of this.planContents.replace(/\s+$/u, "").split(/\r\n|\r|\n/u)) {
			if (line.trim().length === 0) {
				rows.push("");
				continue;
			}
			for (const wrapped of wrapTextWithAnsi(line.trimEnd(), contentWidth)) rows.push(` ${fg("muted", wrapped)}`);
		}

		rows.push("");
		rows.push(fg("borderAccent", "─".repeat(safeWidth)));
		for (const line of wrapTextWithAnsi(PLAN_REVIEW_PROMPT, contentWidth)) rows.push(` ${fg("text", line)}`);
		rows.push("");

		for (const [index, label] of OPTION_LABELS.entries()) rows.push(this.renderOptionRow(index, label, contentWidth));
		rows.push("");
		rows.push(` ${fg("muted", this.renderHint())}`);
		// pi-tui rejects a rendered row wider than the viewport, and the hint and the
		// option labels are fixed strings that can outgrow a narrow terminal.
		return rows.map((row) => (visibleWidth(row) > safeWidth ? truncateToWidth(row, safeWidth, "", false) : row));
	}

	private renderOptionRow(index: number, label: string, contentWidth: number): string {
		const selected = this.selectedIndex === index;
		const color = selected ? "accent" : "muted";
		const marker = selected ? this.theme.fg("accent", "▸") : " ";
		// "▸ 1. " — the head is the same width on every row so the labels line up.
		const head = `${marker} ${this.theme.fg(color, `${index + 1}.`)} `;
		if (index !== FEEDBACK_INDEX || !selected) {
			return `${head}${this.theme.fg(color, label)}`;
		}
		// The row is the input, drawn right after the head. Input pads its line
		// to the full width; drop that so the placeholder can sit at the caret.
		const line = (this.input.render(Math.max(1, contentWidth - 3))[0] ?? "").replace(/ +$/u, "");
		if (this.input.getValue().length > 0) return `${head}${line}`;
		return `${head}${line}${this.theme.fg("dim", label)}`;
	}

	private renderHint(): string {
		const parts = ["↑↓ navigate"];
		// Digits type into the feedback row, so only advertise them elsewhere.
		if (!this.onFeedbackRow) parts.push("1-2 select");
		parts.push(`${keyLabel("tui.select.confirm", "enter")} ${this.onFeedbackRow ? "send" : "select"}`);
		parts.push(`${keyLabel("tui.select.cancel", "esc")} cancel`);
		return parts.join("  ");
	}

	/** Visible width of the widest rendered row, for callers that size a container. */
	measure(width: number): number {
		return this.render(width).reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
	}
}
