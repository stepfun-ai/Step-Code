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

	/**
	 * Markdown instances reused across streaming updates, in the order the visible
	 * content blocks produce them.
	 *
	 * Rebuilding them per delta throws away every render cache inside `Markdown`, which
	 * is what made a long streamed reply repaint its whole transcript on every token.
	 * Instances are kept only while the surrounding inputs are unchanged; the pool key
	 * below covers the state that changes their rendering.
	 */
	private markdownPool: Markdown[] = [];
	private poolCursor = 0;
	/** Shape of the visible content plus the settings that affect a pooled instance. */
	private poolKey = "";

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
		// A full invalidation means the theme or settings changed, so pooled instances may
		// hold rows rendered with the previous styling.
		this.markdownPool = [];
		this.poolKey = "";
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

	/**
	 * Signature of everything that would make a pooled instance render differently.
	 *
	 * `isStreaming` is included because the transform closure captures it, and the
	 * output padding because it is a constructor argument. A changed signature drops the
	 * pool rather than trying to patch instances in place.
	 */
	private poolSignature(message: AssistantMessage, isStreaming: boolean): string {
		const shape = message.content
			.map((content) =>
				content.type === "text"
					? content.text.trim()
						? "t"
						: ""
					: content.type === "thinking"
						? content.thinking.trim()
							? "h"
							: ""
						: "",
			)
			.join("");
		return `${shape}|${isStreaming ? 1 : 0}|${this.outputPad}|${this.hideThinkingBlock ? 1 : 0}|${this.markdownTransformers.length}`;
	}

	/** Next reusable instance for this position, or a freshly built one. */
	private takeMarkdown(create: () => Markdown): Markdown {
		const index = this.poolCursor++;
		const existing = this.markdownPool[index];
		if (existing) return existing;
		const created = create();
		this.markdownPool[index] = created;
		return created;
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		this.lastMessage = message;
		this.isStreaming = isStreaming;

		const signature = this.poolSignature(message, isStreaming);
		if (signature !== this.poolKey) {
			this.poolKey = signature;
			this.markdownPool = [];
		}
		this.poolCursor = 0;

		// Clear content container
		this.contentContainer.clear();

		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Render content in order
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				const text = content.text.trim();
				const instance = this.takeMarkdown(
					() =>
						new Markdown(text, this.outputPad, 0, this.markdownTheme, undefined, {
							transform: createMarkdownTransform("assistant", this.isStreaming, this.markdownTransformers),
						}),
				);
				instance.setText(text);
				this.contentContainer.addChild(instance);
			} else if (content.type === "thinking") {
				const thinkingBlocks: string[] = [];
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
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
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				if (this.hideThinkingBlock) {
					// Show one static label for each run of thinking blocks when hidden.
					this.contentContainer.addChild(
						new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), this.outputPad, 0),
					);
				} else {
					// Render each run of thinking blocks as one Markdown section.
					const thinkingText = thinkingBlocks.join("\n\n");
					const thinkingInstance = this.takeMarkdown(
						() =>
							new Markdown(
								thinkingText,
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
					thinkingInstance.setText(thinkingText);
					this.contentContainer.addChild(thinkingInstance);
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
