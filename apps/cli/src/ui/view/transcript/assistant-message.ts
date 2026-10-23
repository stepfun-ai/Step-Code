import type { MarkdownTransformer } from "@step-harness/coding-agent";
import { getMarkdownTheme, theme } from "@step-harness/coding-agent";
import {
	Container,
	isIncrementalRenderDisabled,
	Markdown,
	type MarkdownTheme,
	Spacer,
	Text,
} from "@step-harness/pi-tui";
import type { AssistantMessage } from "@step-harness/providers";
import { createMarkdownTransform } from "./markdown-transform.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/** Cached zone-marked output, keyed by the child lines it was derived from. */
type ZoneCache = { width: number; native: string[]; lines: string[] };

/**
 * Normalize a provider-assembled content array so that thinking blocks always
 * render before the answer. Most models emit the reasoning stream first, but
 * some turns flush it only after the answer text, which would otherwise paint
 * the thinking block below the answer in those turns and above it in every
 * other turn of the same conversation.
 *
 * Only the degenerate shape is rewritten: when no thinking block precedes the
 * first answer block, every thinking block is hoisted ahead of the answer
 * (stable within each group). Alternating runs (thinking, answer, thinking,
 * answer) already lead with thinking and are returned untouched, preserving
 * segmented reasoning where each answer follows its own thinking.
 */
export function withThinkingBeforeAnswer(content: AssistantMessage["content"]): AssistantMessage["content"] {
	let firstText = -1;
	let firstThinking = -1;
	for (let i = 0; i < content.length; i++) {
		const block = content[i];
		if (block === undefined) continue;
		if (firstText === -1 && block.type === "text" && block.text.trim().length > 0) firstText = i;
		if (firstThinking === -1 && block.type === "thinking" && block.thinking.trim().length > 0) firstThinking = i;
	}
	if (firstText === -1 || firstThinking < firstText) {
		return content;
	}
	return [
		...content.filter((block) => block.type === "thinking"),
		...content.filter((block) => block.type !== "thinking"),
	];
}

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private isStreaming = false;
	private zoneCache?: ZoneCache;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	override render(width: number): string[] {
		// super.render() hands back an array Container reuses while nothing changed, so
		// the zone markers must go into a new array instead of being written in place.
		const native = super.render(width);
		const cached = this.zoneCache;
		if (
			!isIncrementalRenderDisabled() &&
			cached !== undefined &&
			cached.width === width &&
			cached.native === native
		) {
			return cached.lines;
		}

		if (this.hasToolCalls || native.length === 0) {
			// Never hand the parent the array the base Container owns: a caller that
			// reuses its cached prefix must be able to treat render() as read-only.
			// The copy is memoized, so the ref stays stable while nothing changed.
			this.zoneCache = { width, native, lines: [...native] };
			return this.zoneCache.lines;
		}

		const lines = [...native];
		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		this.zoneCache = { width, native, lines };
		return lines;
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		this.lastMessage = message;
		this.isStreaming = isStreaming;

		// Clear content container
		this.contentContainer.clear();

		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		const orderedContent = withThinkingBeforeAnswer(message.content);

		// Render content in order
		for (let i = 0; i < orderedContent.length; i++) {
			const content = orderedContent[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				this.contentContainer.addChild(
					new Markdown(content.text.trim(), this.outputPad, 0, this.markdownTheme, undefined, {
						transform: createMarkdownTransform("assistant", this.isStreaming, this.markdownTransformers),
					}),
				);
			} else if (content.type === "thinking") {
				const thinkingBlocks: string[] = [];
				for (; i < orderedContent.length; i++) {
					const thinkingContent = orderedContent[i];
					if (thinkingContent.type !== "thinking") {
						break;
					}
					const thinking = thinkingContent.thinking.trim();
					if (thinking) {
						thinkingBlocks.push(thinking);
					}
				}
				i--;

				if (thinkingBlocks.length === 0) {
					continue;
				}

				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = orderedContent
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				if (this.hideThinkingBlock) {
					// Show one static label for each run of thinking blocks when hidden.
					this.contentContainer.addChild(
						new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), this.outputPad, 0),
					);
				} else {
					// Render each run of thinking blocks as one Markdown section.
					this.contentContainer.addChild(
						new Markdown(
							thinkingBlocks.join("\n\n"),
							this.outputPad,
							0,
							{ ...this.markdownTheme, code: (text: string) => theme.fg("muted", text) },
							{
								color: (text: string) => theme.fg("thinkingText", text),
								italic: true,
							},
							{
								transform: createMarkdownTransform(
									"assistant-thinking",
									this.isStreaming,
									this.markdownTransformers,
								),
							},
						),
					);
				}
				if (hasVisibleContentAfter) {
					this.contentContainer.addChild(new Spacer(1));
				}
			}
		}

		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "length") {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(theme.fg("error", "Response was truncated before completion."), this.outputPad, 0),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));
			}
		}
	}
}
