import type { SkillInstructionView } from "@step-harness/coding-agent";
import { getMarkdownTheme, keyText, theme } from "@step-harness/coding-agent";
import { Box, Markdown, type MarkdownTheme, Text } from "@step-harness/pi-tui";

/**
 * Component that renders one skill's instructions with collapsed/expanded state.
 * Uses same background color as custom messages for visual consistency.
 * Only renders the instructions themselves - the request is rendered separately.
 */
export class SkillInvocationMessageComponent extends Box {
	private expanded = false;
	private readonly skill: SkillInstructionView;
	private readonly markdownTheme: MarkdownTheme;

	constructor(skill: SkillInstructionView, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super(1, 1, (t) => theme.bg("customMessageBg", t));
		this.skill = skill;
		this.markdownTheme = markdownTheme;
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.clear();

		if (this.expanded) {
			// Expanded: label + skill name header + full content
			const label = theme.fg("customMessageLabel", `\x1b[1m[skill]\x1b[22m`);
			this.addChild(new Text(label, 0, 0));
			const header = `**${this.skill.name}**\n\n`;
			this.addChild(
				new Markdown(header + this.skill.content, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			// Collapsed: single line - [skill] name (hint to expand)
			const line =
				theme.fg("customMessageLabel", `\x1b[1m[skill]\x1b[22m `) +
				theme.fg("customMessageText", this.skill.name) +
				theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
			this.addChild(new Text(line, 0, 0));
		}
	}
}
