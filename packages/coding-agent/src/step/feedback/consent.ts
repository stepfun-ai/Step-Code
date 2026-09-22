import {
	type Component,
	type Focusable,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@step-harness/pi-tui";
import type { ExtensionCommandContext } from "../../core/extensions/types.ts";
import type { Keybinding, KeybindingsManager } from "../../core/keybindings.ts";
import { formatKeyText } from "../../render/keybinding-hints.ts";
import type { Theme } from "../../theme/theme.ts";
import { describeFeedbackBundle } from "./bundle.ts";
import type { FeedbackBundle, FeedbackSubmission } from "./types.ts";

const FRAME_FIXED_ROWS = 6;
const MIN_REVIEW_ROWS = FRAME_FIXED_ROWS + 1;
const MIN_REVIEW_COLUMNS = 20;

export interface FeedbackConsentPreviewInput {
	submission: FeedbackSubmission;
	diagnosticsDisplayPath?: string;
	bundle?: FeedbackBundle;
}

/**
 * Builds the exact consent text from the held submission and bundle, then
 * neutralizes terminal controls only in this display copy. The wire values are
 * never rewritten here.
 */
export function formatFeedbackConsentPreview(input: FeedbackConsentPreviewInput): string {
	const sections = [
		`Category: ${input.submission.category ?? "none"}`,
		`Comment:\n${input.submission.comment || "(empty comment)"}`,
		[
			"Identity sent with this feedback:",
			...(["deviceId", "uid", "username", "channel", "version", "platform", "commit"] as const).map(
				(field) => `${field}: ${neutralizeFeedbackConsentMetadata(input.submission.context[field] ?? "(not set)")}`,
			),
		].join("\n"),
	];
	const diagnostics = input.submission.diagnostics;
	if (diagnostics && input.diagnosticsDisplayPath) {
		const content = diagnostics.lines.join("\n");
		const displayPath = neutralizeFeedbackConsentMetadata(input.diagnosticsDisplayPath);
		sections.push(
			[
				`Diagnostics: ${displayPath}`,
				`${Buffer.byteLength(content, "utf8")} bytes, ${diagnostics.lines.length} lines, truncated: ${diagnostics.truncated ? "yes" : "no"}`,
				"--- diagnostics begin ---",
				content,
				"--- diagnostics end ---",
			].join("\n"),
		);
	}
	if (input.bundle) {
		const displayBundle: FeedbackBundle = {
			...input.bundle,
			files: input.bundle.files.map((file) => ({
				...file,
				name: neutralizeFeedbackConsentMetadata(file.name),
				...(file.note ? { note: neutralizeFeedbackConsentMetadata(file.note) } : {}),
			})),
			sessionId: neutralizeFeedbackConsentMetadata(input.bundle.sessionId),
		};
		sections.push(
			`Session bundle (${input.bundle.data.byteLength} compressed bytes):\n${describeFeedbackBundle(displayBundle)}`,
		);
	}
	return neutralizeFeedbackConsentText(sections.join("\n\n"));
}

/** Turn C0/C1/DEL bytes into visible text before any theme ANSI is applied. */
export function neutralizeFeedbackConsentText(value: string): string {
	let output = "";
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (character === "\n") {
			output += character;
			continue;
		}
		if (codePoint < 0x20 || codePoint === 0x7f || (codePoint >= 0x80 && codePoint <= 0x9f)) {
			if (character === "\t") output += "\\t";
			else if (character === "\r") output += "\\r";
			else if (character === "\b") output += "\\b";
			else if (codePoint === 0x1b) output += "\\x1b";
			else output += `\\x${codePoint.toString(16).padStart(2, "0")}`;
			continue;
		}
		output += character;
	}
	return output;
}

/** Metadata occupies one consent line even when a filesystem name contains a newline. */
export function neutralizeFeedbackConsentMetadata(value: string): string {
	return neutralizeFeedbackConsentText(value).replaceAll("\n", "\\n");
}

export async function confirmFeedbackSubmission(
	ctx: Pick<ExtensionCommandContext, "mode" | "ui">,
	input: FeedbackConsentPreviewInput,
): Promise<boolean> {
	const preview = formatFeedbackConsentPreview(input);
	if (ctx.mode !== "tui") return ctx.ui.confirm("Submit feedback?", preview);

	return ctx.ui.custom<boolean>(
		(tui, theme, keybindings, done) => new ScrollableConsentComponent(tui, theme, keybindings, preview, done),
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "100%",
				maxHeight: "100%",
			},
		},
	);
}

/** Full-terminal consent surface whose preview scrolls independently of the transcript. */
export class ScrollableConsentComponent implements Component, Focusable {
	focused = false;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly preview: string;
	private readonly done: (confirmed: boolean) => void;
	private selectedIndex = 0;
	private scrollOffset = 0;
	private viewportRows = 1;
	private renderedWidth: number | undefined;
	private previewLines: string[] = [];
	private settled = false;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		preview: string,
		done: (confirmed: boolean) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.preview = preview;
		this.done = done;
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.finish(false);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.scrollByPage(-1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.scrollByPage(1);
			return;
		}
		if (this.tui.terminal.rows < MIN_REVIEW_ROWS || this.tui.terminal.columns < MIN_REVIEW_COLUMNS) {
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.selectedIndex = 0;
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.selectedIndex = 1;
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.finish(this.selectedIndex === 0);
		}
	}

	render(width: number): string[] {
		const renderWidth = Math.max(1, Math.floor(width));
		const terminalRows = Math.max(1, Math.floor(this.tui.terminal.rows));
		const innerWidth = Math.max(1, renderWidth - 2);
		const reviewAvailable = terminalRows >= MIN_REVIEW_ROWS && renderWidth >= MIN_REVIEW_COLUMNS;
		if (this.renderedWidth !== innerWidth) {
			this.renderedWidth = innerWidth;
			this.previewLines = wrapTextWithAnsi(this.preview, innerWidth);
		}

		if (!reviewAvailable) {
			this.viewportRows = 1;
			this.clampScrollOffset();
			const compact = [
				this.theme.fg("warning", "Resize the terminal to review and submit feedback."),
				this.theme.fg("text", this.previewLines[this.scrollOffset] ?? ""),
				this.theme.fg(
					"dim",
					`${this.keyLabel("tui.select.pageUp", "PageUp")}/${this.keyLabel("tui.select.pageDown", "PageDown")} scroll · ${this.keyLabel("tui.select.cancel", "Esc")} cancel`,
				),
			];
			return compact.slice(0, terminalRows).map((line) => this.fitLine(line, renderWidth));
		}

		this.viewportRows = terminalRows - FRAME_FIXED_ROWS;
		this.clampScrollOffset();
		const totalLines = this.previewLines.length;
		const visibleEnd = Math.min(totalLines, this.scrollOffset + this.viewportRows);
		const progress = `Preview ${this.scrollOffset + 1}-${Math.max(this.scrollOffset + 1, visibleEnd)} of ${totalLines}`;
		const header = `${this.theme.fg("accent", this.theme.bold("Submit feedback?"))}  ${this.theme.fg("dim", progress)}`;
		const lines = [this.rule("╭", "╮", renderWidth), this.frameLine(header, innerWidth)];
		for (let index = 0; index < this.viewportRows; index += 1) {
			const line = this.previewLines[this.scrollOffset + index] ?? "";
			lines.push(this.frameLine(this.theme.fg("text", line), innerWidth));
		}
		lines.push(this.rule("├", "┤", renderWidth));
		lines.push(this.frameLine(this.renderDecisionLine(innerWidth), innerWidth));
		lines.push(this.frameLine(this.theme.fg("dim", this.renderHint()), innerWidth));
		lines.push(this.rule("╰", "╯", renderWidth));
		return lines;
	}

	invalidate(): void {
		this.renderedWidth = undefined;
		this.previewLines = [];
	}

	private finish(confirmed: boolean): void {
		if (this.settled) return;
		this.settled = true;
		this.done(confirmed);
	}

	private scrollByPage(direction: -1 | 1): void {
		const step = Math.max(1, this.viewportRows - 1);
		this.scrollOffset += direction * step;
		this.clampScrollOffset();
		this.tui.requestRender();
	}

	private clampScrollOffset(): void {
		const maxOffset = Math.max(0, this.previewLines.length - this.viewportRows);
		this.scrollOffset = Math.max(0, Math.min(maxOffset, this.scrollOffset));
	}

	private renderDecisionLine(innerWidth: number): string {
		const yes = this.selectedIndex === 0 ? this.selectedChoice("Yes") : this.theme.fg("text", "  Yes  ");
		const no = this.selectedIndex === 1 ? this.selectedChoice("No") : this.theme.fg("text", "  No  ");
		return this.fitLine(`${yes}   ${no}`, innerWidth);
	}

	private selectedChoice(label: string): string {
		return this.theme.bg("selectedBg", this.theme.fg("text", `> ${label} `));
	}

	private renderHint(): string {
		return [
			`${this.keyLabel("tui.select.pageUp", "PageUp")}/${this.keyLabel("tui.select.pageDown", "PageDown")} scroll`,
			`${this.keyLabel("tui.select.up", "Up")}/${this.keyLabel("tui.select.down", "Down")} choose`,
			`${this.keyLabel("tui.select.confirm", "Enter")} confirm`,
			`${this.keyLabel("tui.select.cancel", "Esc")} cancel`,
		].join(" · ");
	}

	private keyLabel(keybinding: Keybinding, fallback: string): string {
		const keys = this.keybindings.getKeys(keybinding);
		return keys.length > 0 ? formatKeyText(keys.join("/"), { capitalize: true }) : fallback;
	}

	private frameLine(content: string, innerWidth: number): string {
		return `${this.theme.fg("accent", "│")}${this.fitLine(content, innerWidth)}${this.theme.fg("accent", "│")}`;
	}

	private rule(left: string, right: string, width: number): string {
		if (width === 1) return this.theme.fg("accent", left);
		return this.theme.fg("accent", `${left}${"─".repeat(Math.max(0, width - 2))}${right}`);
	}

	private fitLine(content: string, width: number): string {
		const truncated = visibleWidth(content) > width ? truncateToWidth(content, width, "") : content;
		return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
	}
}
