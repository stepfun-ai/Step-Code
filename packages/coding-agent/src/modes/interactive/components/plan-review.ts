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
		this.input = new Input({ prompt: `${PLAN_REVIEW_FEEDBACK_LABEL}: ` });
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		// Only the feedback row owns a caret; the approve row must not show one.
		this.input.focused = value && this.selectedIndex === 1;
	}

	private get onFeedbackRow(): boolean {
		return this.selectedIndex === 1;
	}

	private moveSelection(next: number): void {
		const clamped = Math.max(0, Math.min(1, next));
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

		rows.push(this.renderOptionRow(0, "Execute the plan", contentWidth));
		rows.push(this.renderOptionRow(1, PLAN_REVIEW_FEEDBACK_LABEL, contentWidth));
		rows.push("");
		rows.push(` ${fg("muted", this.renderHint())}`);
		// pi-tui rejects a rendered row wider than the viewport, and the hint and the
		// option labels are fixed strings that can outgrow a narrow terminal.
		return rows.map((row) => (visibleWidth(row) > safeWidth ? truncateToWidth(row, safeWidth, "", false) : row));
	}

	private renderOptionRow(index: number, label: string, contentWidth: number): string {
		const selected = this.selectedIndex === index;
		const marker = selected ? this.theme.fg("accent", "▸") : " ";
		if (index === 1 && selected) {
			// The row is the input: Input draws the label as its prompt so the caret
			// lands after it without a second focusable component.
			const line = this.input.render(Math.max(1, contentWidth - 1))[0] ?? label;
			return `${marker} ${line}`;
		}
		const text = selected ? this.theme.fg("accent", label) : this.theme.fg("muted", label);
		return `${marker} ${text}`;
	}

	private renderHint(): string {
		const navigate = "↑↓ navigate";
		const confirm = `${keyLabel("tui.select.confirm", "enter")} ${this.onFeedbackRow ? "send" : "select"}`;
		const cancel = `${keyLabel("tui.select.cancel", "esc")} cancel`;
		return `${navigate}  ${confirm}  ${cancel}`;
	}

	/** Visible width of the widest rendered row, for callers that size a container. */
	measure(width: number): number {
		return this.render(width).reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
	}
}
