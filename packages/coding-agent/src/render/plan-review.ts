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

import type { AgentToolResult } from "@step-harness/agent-core";
import {
	type Component,
	type Focusable,
	getKeybindings,
	Input,
	type Keybinding,
	Markdown,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@step-harness/pi-tui";
import type { ToolRenderResultOptions } from "../core/extensions/types.ts";
import { getMarkdownTheme, type Theme } from "../theme/theme.ts";
import { formatKeyText } from "./keybinding-hints.ts";

/** How the review ended, as recorded on the tool result for the transcript. */
export type PlanReviewOutcome = "approved" | "feedback" | "dismissed";

/**
 * Tool-result details for exit_plan_mode.
 *
 * The dialog is an inline component that is torn down the moment it closes, so
 * the plan it displayed leaves no trace on screen. Carrying the reviewed text
 * here lets the tool row render it back into the transcript.
 */
export interface PlanReviewDetails {
	planFilePath: string;
	planContents: string;
	outcome: PlanReviewOutcome;
	/** The note the user typed, for the "feedback" outcome. */
	feedback?: string;
}

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
	/** The plan, rendered as markdown rather than a flat wall of muted text. */
	private readonly plan: Markdown;
	/** 0 = approve row, 1 = feedback row. */
	private selectedIndex = 0;
	private _focused = false;

	constructor(options: PlanReviewOptions) {
		this.planFilePath = options.planFilePath;
		this.planContents = options.planContents;
		this.theme = options.theme;
		this.onResult = options.onResult;
		this.onChange = options.onChange;
		this.plan = new Markdown(trimTrailing(this.planContents), 0, 0, getMarkdownTheme(options.theme));
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
		// The plan is shown whole: this is the text the user is being asked to
		// approve. Markdown carries the structure — headings, emphasis, code, lists —
		// that a single muted colour flattens away.
		for (const line of this.plan.render(contentWidth)) rows.push(` ${line}`);

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

/** Drop trailing whitespace without touching the blank lines inside the plan. */
function trimTrailing(text: string): string {
	return text.replace(/\s+$/u, "");
}

function resultText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function isPlanReviewDetails(value: unknown): value is PlanReviewDetails {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<PlanReviewDetails>;
	return (
		typeof candidate.planFilePath === "string" &&
		typeof candidate.planContents === "string" &&
		(candidate.outcome === "approved" || candidate.outcome === "feedback" || candidate.outcome === "dismissed")
	);
}

const OUTCOME_SUMMARIES: Record<
	PlanReviewOutcome,
	{ marker: string; color: Parameters<Theme["fg"]>[0]; text: string }
> = {
	approved: { marker: "✓", color: "success", text: "Plan approved" },
	feedback: { marker: "✎", color: "warning", text: "Changes requested" },
	dismissed: { marker: "•", color: "muted", text: "Review dismissed — still planning" },
};

/**
 * Transcript rendering for an exit_plan_mode result: the outcome, then the plan
 * that was reviewed.
 *
 * Registered with `renderShell: "self"`, so this owns the card body below the
 * `exit_plan_mode` header. That is deliberate: the Step shell's default body
 * pass (tool-execution.ts) drops every blank row and clips the body to a
 * five-line budget behind ctrl+o, which would flatten the plan's paragraphs and
 * hide it — and the dialog that drew the plan is already torn down, so this row
 * is the only copy left on screen. `options.expanded` is ignored for the same
 * reason.
 */
export function renderPlanReviewResult(
	result: AgentToolResult<unknown>,
	_options: ToolRenderResultOptions,
	theme: Theme,
): Component {
	const details = result.details;
	if (isPlanReviewDetails(details)) return new PlanReviewCard(details, theme);
	// Guard results (not in plan mode, unreadable file, ...) are one line of text.
	const text = resultText(result) || "(no output)";
	return {
		render: (width) => gutter(wrapTextWithAnsi(text, Math.max(1, width - BODY_INDENT.length))),
		invalidate: () => {},
	};
}

/** The gutter the Step card draws down the left of a tool body. */
const BODY_CONNECTOR = "  \u2514 ";
const BODY_INDENT = "    ";

/** Hang rows off the header the way the default shell does; blank rows stay blank. */
function gutter(rows: string[]): string[] {
	return rows.map((row, index) => (row === "" ? "" : `${index === 0 ? BODY_CONNECTOR : BODY_INDENT}${row}`));
}

class PlanReviewCard implements Component {
	private readonly details: PlanReviewDetails;
	private readonly theme: Theme;
	private readonly plan: Markdown;

	constructor(details: PlanReviewDetails, theme: Theme) {
		this.details = details;
		this.theme = theme;
		this.plan = new Markdown(trimTrailing(details.planContents), 0, 0, getMarkdownTheme(theme));
	}

	render(width: number): string[] {
		const summary = OUTCOME_SUMMARIES[this.details.outcome];
		const rows = [
			`${this.theme.fg(summary.color, `${summary.marker} ${summary.text}`)} ${this.theme.fg("dim", this.details.planFilePath)}`,
		];
		if (this.details.outcome === "feedback" && this.details.feedback) {
			rows.push(this.theme.fg("toolOutput", `\u21b3 ${this.details.feedback}`));
		}
		// Blank separator, then the plan. Both survive here; the default body pass
		// would have stripped them.
		rows.push("", ...this.plan.render(Math.max(1, width - BODY_INDENT.length)));
		return gutter(rows);
	}

	invalidate(): void {
		this.plan.invalidate();
	}
}
