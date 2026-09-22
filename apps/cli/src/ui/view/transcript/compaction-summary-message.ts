import type { CompactionSummaryMessage } from "@step-harness/coding-agent";
import { getMarkdownTheme, keyText, theme } from "@step-harness/coding-agent";
import { Box, isIncrementalRenderDisabled, Markdown, type MarkdownTheme, Spacer, Text } from "@step-harness/pi-tui";
import { renderStepDialogFrame } from "../dialogs/step-dialog.ts";
import { RenderLineCache } from "./render-line-cache.ts";

/**
 * Component that renders a compaction message with collapsed/expanded state.
 * Uses same background color as custom messages for visual consistency.
 */
export class CompactionSummaryMessageComponent extends Box {
	private expanded = false;
	private message: CompactionSummaryMessage;
	private markdownTheme: MarkdownTheme;
	private readonly presentation: "native" | "step";
	private readonly stepCache = new RenderLineCache();
	/** Bumped by every state change so the Step frame is only rebuilt when it must be. */
	private contentVersion = 0;

	constructor(
		message: CompactionSummaryMessage,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		options: { presentation?: "native" | "step" } = {},
	) {
		super(1, 1, (t) => theme.bg("customMessageBg", t));
		this.message = message;
		this.markdownTheme = markdownTheme;
		this.presentation = options.presentation ?? "native";
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.contentVersion += 1;
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.contentVersion += 1;
		this.clear();

		const tokenStr = this.message.tokensBefore.toLocaleString();
		const label = theme.fg("customMessageLabel", `\x1b[1m[compaction]\x1b[22m`);
		this.addChild(new Text(label, 0, 0));
		this.addChild(new Spacer(1));

		if (this.expanded) {
			const header = `**Compacted from ${tokenStr} tokens**\n\n`;
			this.addChild(
				new Markdown(header + this.message.summary, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			this.addChild(
				new Text(
					theme.fg("customMessageText", `Compacted from ${tokenStr} tokens (`) +
						theme.fg("dim", keyText("app.tools.expand")) +
						theme.fg("customMessageText", " to expand)"),
					0,
					0,
				),
			);
		}
	}

	override render(width: number): string[] {
		if (this.presentation !== "step") return super.render(width);
		const safeWidth = Math.max(1, Math.floor(width));
		if (safeWidth < 8) return super.render(safeWidth);
		if (!isIncrementalRenderDisabled() && this.stepCache.matches(safeWidth, this.contentVersion)) {
			return this.stepCache.get();
		}
		const contentWidth = Math.max(1, safeWidth - 4);
		const tokenStr = this.message.tokensBefore.toLocaleString();
		const rows: string[] = [theme.fg("accent", theme.bold(`● Compaction · ${tokenStr} tokens`))];
		if (this.expanded) {
			const markdown = this.children[this.children.length - 1];
			if (markdown) rows.push(...trimRows(markdown.render(contentWidth)));
		} else {
			rows.push(theme.fg("muted", `Compacted from ${tokenStr} tokens (${keyText("app.tools.expand")} to expand)`));
		}
		return this.stepCache.store(safeWidth, this.contentVersion, renderStepDialogFrame(rows, safeWidth));
	}
}

function trimRows(rows: string[]): string[] {
	let start = 0;
	while (start < rows.length && rows[start]?.trim() === "") start += 1;
	let end = rows.length;
	while (end > start && rows[end - 1]?.trim() === "") end -= 1;
	return rows.slice(start, end);
}
