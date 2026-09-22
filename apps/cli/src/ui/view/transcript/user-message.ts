import type { MarkdownTransformer } from "@step-harness/coding-agent";
import { getMarkdownTheme, theme } from "@step-harness/coding-agent";
import { Box, Container, isIncrementalRenderDisabled, Markdown, type MarkdownTheme } from "@step-harness/pi-tui";
import { createMarkdownTransform } from "./markdown-transform.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/** Cached zone-marked output, keyed by the child lines it was derived from. */
type ZoneCache = { width: number; native: string[]; lines: string[] };

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	private text: string;
	private markdownTheme: MarkdownTheme;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private zoneCache?: ZoneCache;

	constructor(
		text: string,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		super();
		this.text = text;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.rebuild();
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		const contentBox = new Box(this.outputPad, 1, (content: string) => theme.bg("userMessageBg", content));
		contentBox.addChild(
			new Markdown(
				this.text,
				0,
				0,
				this.markdownTheme,
				{
					color: (content: string) => theme.fg("userMessageText", content),
				},
				{
					preserveOrderedListMarkers: true,
					preserveBackslashEscapes: true,
					transform: createMarkdownTransform("user", false, this.markdownTransformers),
				},
			),
		);
		this.addChild(contentBox);
	}

	override render(width: number): string[] {
		// super.render() hands back an array Container reuses while nothing changed, so
		// the zone markers must go into a new array instead of being written in place.
		const native = super.render(width);
		if (native.length === 0) {
			return native;
		}

		const cached = this.zoneCache;
		if (
			!isIncrementalRenderDisabled() &&
			cached !== undefined &&
			cached.width === width &&
			cached.native === native
		) {
			return cached.lines;
		}

		const lines = [...native];
		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		this.zoneCache = { width, native, lines };
		return lines;
	}
}
