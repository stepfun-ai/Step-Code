import type { MarkdownTransformer } from "@step-harness/coding-agent";
import { getMarkdownTheme, theme } from "@step-harness/coding-agent";
import { type MarkdownTheme, stripTerminalSequences, truncateToWidth, visibleWidth } from "@step-harness/pi-tui";
import type { AssistantMessage } from "@step-harness/providers";
import { estimateTokens, formatElapsedTime, formatTokens } from "../chrome/footer.ts";
import { AssistantMessageComponent } from "./assistant-message.ts";
import { UserMessageComponent } from "./user-message.ts";

/** OSC 133 prompt-zone markers emitted by pi's message components. */
const OSC_133 = /\x1b\]133;[ABC](?:\x07|\x1b\\)/g;

type TerminalSequence = {
	end: number;
	kind: "csi" | "osc" | "osc8-open";
};

/**
 * Consume exactly one terminal control sequence.
 *
 * A greedy `\x1b\][^\x07]*` expression is tempting here, but it swallows an
 * OSC-8 opener, the linked text, and its closing sequence in one match when
 * the hyperlink uses the ST terminator (`ESC \\`).  Prefixes inserted after
 * that match end up inside the hyperlink.  Scanning for the first BEL/ST
 * terminator keeps control sequences and visible text addressable separately.
 */
function consumeTerminalSequence(line: string, start: number): TerminalSequence | undefined {
	if (line[start] !== "\x1b") return undefined;

	if (line[start + 1] === "[") {
		let index = start + 2;
		while (index < line.length) {
			const code = line.charCodeAt(index);
			// CSI final bytes are in the range 0x40-0x7e.
			if (code >= 0x40 && code <= 0x7e) {
				return { end: index + 1, kind: "csi" };
			}
			index += 1;
		}
		return undefined;
	}

	if (line[start + 1] !== "]") return undefined;
	let index = start + 2;
	while (index < line.length) {
		if (line[index] === "\x07") {
			const sequence = line.slice(start, index + 1);
			return {
				end: index + 1,
				kind:
					sequence.startsWith("\x1b]8;;") && !/^\x1b\]8;;(?:\x07|\x1b\\)$/u.test(sequence) ? "osc8-open" : "osc",
			};
		}
		if (line[index] === "\x1b" && line[index + 1] === "\\") {
			const sequence = line.slice(start, index + 2);
			return {
				end: index + 2,
				kind: sequence.startsWith("\x1b]8;;") && !/^\x1b\]8;;\x1b\\$/u.test(sequence) ? "osc8-open" : "osc",
			};
		}
		index += 1;
	}
	return undefined;
}

type Fence = {
	marker: "`" | "~";
	length: number;
	info: string;
};

type PreparedRow = {
	markers: string;
	body: string;
	blank: boolean;
};

type VisibleAssistantContent = Extract<AssistantMessage["content"][number], { type: "thinking" | "text" }>;

type AssistantContentRun = {
	kind: "thinking" | "text";
	content: VisibleAssistantContent[];
	source: string;
};

type NativeAssistantRun = AssistantContentRun & {
	component: AssistantMessageComponent;
	streaming: boolean;
};

/**
 * Step's message components deliberately delegate all content construction to
 * pi.  These helpers only reshape already-rendered rows, which keeps Markdown
 * transforms, streaming updates, OSC markers, and tool-call boundaries on the
 * native path.
 */

/**
 * Partition the assistant payload before rendering it. Pi's renderer accepts
 * the complete message, but its row output intentionally does not expose
 * which line came from which content block. Keeping the semantic runs here
 * makes the Step thinking/answer boundary deterministic (and handles a
 * thinking block that arrives after an answer) without reimplementing Markdown.
 * Tool calls act as a boundary because their own native component is rendered
 * by InteractiveMode between assistant rows.
 */
function partitionAssistantContent(message: AssistantMessage): AssistantContentRun[] {
	const runs: AssistantContentRun[] = [];
	let previousKind: AssistantContentRun["kind"] | undefined;

	for (const content of message.content) {
		if (content.type !== "thinking" && content.type !== "text") {
			previousKind = undefined;
			continue;
		}

		const source = content.type === "thinking" ? content.thinking : content.text;
		if (source.trim().length === 0) continue;

		if (previousKind === content.type) {
			const previous = runs[runs.length - 1];
			if (previous?.kind === content.type) {
				previous.content.push(content);
				previous.source += `\n${source}`;
				continue;
			}
		}

		runs.push({ kind: content.type, content: [content], source });
		previousKind = content.type;
	}

	return runs;
}

function makeNativeRunMessage(message: AssistantMessage, content: VisibleAssistantContent[]): AssistantMessage {
	return {
		...message,
		content: content as AssistantMessage["content"],
		// Status text belongs to the complete message, not to a content run.
		// Keeping a successful stop reason prevents a synthetic run from adding
		// an extra error/length row of its own.
		stopReason: "stop",
		errorMessage: undefined,
	};
}

function isBlankRow(line: string): boolean {
	return stripTerminalSequences(line).trim().length === 0;
}

function splitMarkers(line: string): { markers: string; body: string } {
	const markers = line.match(OSC_133)?.join("") ?? "";
	return { markers, body: line.replace(OSC_133, "") };
}

/** Parse a fence-looking row after removing styles and renderer padding. */
function parseFenceRow(line: string): Fence | undefined {
	const plain = stripTerminalSequences(line).trim();
	const match = /^(`{3,}|~{3,})(.*)$/u.exec(plain);
	if (!match) return undefined;
	return {
		marker: match[1]![0] as "`" | "~",
		length: match[1]!.length,
		info: match[2]!.trim(),
	};
}

/**
 * Return the ordinals of source fences that have a real matching close. Pi's
 * Markdown parser intentionally renders an unfinished fence as a code block
 * too; keeping this source-side fact lets the Step skin hide only complete
 * fences and leave streamed/incomplete text untouched.
 */
function completeFenceOrdinals(text: string): Set<number> {
	const complete = new Set<number>();
	let open: { marker: "`" | "~"; length: number; ordinal: number } | undefined;
	let ordinal = 0;
	for (const rawLine of text.replace(/\r\n?/g, "\n").split("\n")) {
		const match = /^[ ]{0,3}(`{3,}|~{3,})(.*)$/u.exec(rawLine);
		if (!match) continue;
		const fence = match[1]!;
		const marker = fence[0] as "`" | "~";
		const info = match[2]!.trim();
		if (open === undefined) {
			open = { marker, length: fence.length, ordinal };
			ordinal += 1;
			continue;
		}
		if (marker === open.marker && fence.length >= open.length && info === "") {
			complete.add(open.ordinal);
			open = undefined;
		}
	}
	return complete;
}

/** Replace only the visible fence payload, preserving Pi's ANSI/background runs. */
function replaceFencePayload(line: string, replacement: string): string {
	const { markers, body } = splitMarkers(line);
	// The fence payload runs to the end of the row and may interleave SGR
	// segments — the theme paints the backticks and the language tag in
	// different colors. Consuming only the first plain run would leave the
	// language suffix behind and print it twice (feedback acceptance F-2).
	const match = /(`{3,}|~{3,})(?:\x1b\[[0-9;]*m|[^\x1b])*$/u.exec(body);
	if (!match) return line;
	const padding = " ".repeat(Math.max(0, visibleWidth(match[0]) - visibleWidth(replacement)));
	return `${markers}${body.slice(0, match.index)}${replacement}${padding}`;
}

/**
 * Hide complete Markdown fences in already-rendered Pi rows. Opening fences
 * with a language become the compact language label used by the old Step UI;
 * unlabeled openings and all matching closings become blank rows. Blank rows
 * are retained so OSC markers and Markdown paragraph spacing can still be
 * carried by the normal wrapper below.
 */
function hideCompleteFences(lines: string[], source: string): string[] {
	const complete = completeFenceOrdinals(source);
	if (complete.size === 0) return lines;

	let ordinal = 0;
	let active: { fence: Fence; hide: boolean } | undefined;
	return lines.map((line) => {
		const fence = parseFenceRow(line);
		if (fence === undefined) return line;

		if (active === undefined) {
			const hide = complete.has(ordinal);
			ordinal += 1;
			active = { fence, hide };
			if (!hide) return line;
			const language = fence.info.split(/\s+/u)[0] ?? "";
			return replaceFencePayload(line, language);
		}

		const closes = fence.marker === active.fence.marker && fence.length >= active.fence.length && fence.info === "";
		if (!closes) return line;
		const hide = active.hide;
		active = undefined;
		return hide ? replaceFencePayload(line, "") : line;
	});
}

function prepareRow(line: string, outputPadding: number, trimEnd: boolean): PreparedRow {
	const { markers, body } = splitMarkers(line);
	const unpadded = removeLeadingVisibleSpaces(body, outputPadding);
	const normalized = trimEnd ? trimVisibleEnd(unpadded) : unpadded;
	return {
		markers,
		body: normalized,
		blank: isBlankRow(normalized),
	};
}

function collapseAdjacentBlankRows(rows: PreparedRow[]): PreparedRow[] {
	const collapsed: PreparedRow[] = [];
	for (const row of rows) {
		const previous = collapsed[collapsed.length - 1];
		if (row.blank && previous?.blank) {
			previous.markers += row.markers;
			continue;
		}
		collapsed.push({ ...row });
	}
	return collapsed;
}

/** Remove renderer padding while retaining ANSI styling and hyperlinks. */
function trimVisibleEnd(line: string): string {
	const plain = stripTerminalSequences(line).replace(/\s+$/u, "");
	return truncateToWidth(line, visibleWidth(plain), "", false);
}

/** Remove up to `count` literal spaces at the first visible position. */
function removeLeadingVisibleSpaces(line: string, count: number): string {
	if (count <= 0) return line;
	let remaining = count;
	let output = "";
	let index = 0;
	while (index < line.length) {
		const sequence = consumeTerminalSequence(line, index);
		if (sequence) {
			output += line.slice(index, sequence.end);
			index = sequence.end;
			continue;
		}
		if (remaining > 0 && line[index] === " ") {
			remaining -= 1;
			index += 1;
			continue;
		}
		output += line.slice(index);
		break;
	}
	return output;
}

/**
 * Insert a prefix after leading terminal sequences while keeping OSC-8 links
 * around the linked text only.  A prefix before an OSC-8 opener is outside the
 * clickable region; inserting it after the opener makes the gutter clickable
 * and can leave terminals with an unbalanced hyperlink when rows are clipped.
 */
export function prependAfterTerminalSequences(line: string, prefix: string): string {
	let index = 0;
	while (index < line.length) {
		const sequence = consumeTerminalSequence(line, index);
		if (!sequence) break;
		if (sequence.kind === "osc8-open") {
			return `${line.slice(0, index)}${prefix}${line.slice(index)}`;
		}
		index = sequence.end;
	}
	return `${line.slice(0, index)}${prefix}${line.slice(index)}`;
}

function clampRow(line: string, width: number): string {
	return visibleWidth(line) <= width ? line : truncateToWidth(line, width, "", false);
}

function normalizeOutputPadding(padding: number): number {
	return Number.isFinite(padding) ? Math.max(0, Math.floor(padding)) : 0;
}

function trimOuterRows(lines: string[]): {
	lines: string[];
	leadingMarkers: string;
	trailingMarkers: string;
} {
	const firstContent = lines.findIndex((line) => !isBlankRow(line));
	if (firstContent < 0) {
		return { lines: [], leadingMarkers: "", trailingMarkers: "" };
	}
	let lastContent = lines.length - 1;
	while (lastContent > firstContent && isBlankRow(lines[lastContent] ?? "")) {
		lastContent -= 1;
	}

	const leadingMarkers = lines
		.slice(0, firstContent)
		.map((line) => splitMarkers(line).markers)
		.join("");
	const trailingMarkers = lines
		.slice(lastContent + 1)
		.map((line) => splitMarkers(line).markers)
		.join("");
	return {
		lines: lines.slice(firstContent, lastContent + 1),
		leadingMarkers,
		trailingMarkers,
	};
}

function addMarkerToFirst(rows: Array<{ markers: string; body: string }>, markers: string): void {
	if (rows.length > 0 && markers.length > 0) rows[0]!.markers = markers + rows[0]!.markers;
}

function addMarkerToLast(rows: Array<{ markers: string; body: string }>, markers: string): void {
	if (rows.length > 0 && markers.length > 0) rows[rows.length - 1]!.markers += markers;
}

// Cache key: the rows pi produced, the way Box keys on its child lines.  What
// render() reads past those rows - the run sources behind hideCompleteFences, the
// message behind the prompt-zone markers - only moves in updateContent(), which
// drops the cache the way Markdown's setText does.
type RenderCache = {
	nativeRows: string[];
	width: number;
	lines: string[];
};

function matchesRenderCache(cache: RenderCache | undefined, nativeRows: string[], width: number): boolean {
	return (
		!!cache &&
		cache.width === width &&
		cache.nativeRows.length === nativeRows.length &&
		cache.nativeRows.every((line, i) => line === nativeRows[i])
	);
}

/**
 * Pi's user message already owns the background and Markdown renderer.  Step
 * only changes the gutter and removes the extra top/bottom Box padding.
 */
export class StepUserMessageComponent extends UserMessageComponent {
	private outputPadding: number;
	private readonly sourceText: string;

	// Cache for rendered output
	private cache?: RenderCache;

	constructor(
		text: string,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		super(text, markdownTheme, normalizeOutputPadding(outputPad), markdownTransformers);
		this.outputPadding = normalizeOutputPadding(outputPad);
		this.sourceText = text;
	}

	override setOutputPad(padding: number): void {
		this.outputPadding = normalizeOutputPadding(padding);
		super.setOutputPad(this.outputPadding);
	}

	override invalidate(): void {
		this.cache = undefined;
		super.invalidate();
	}

	override render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const nativeRows = super.render(safeWidth);
		// The reflow below returns a differently-shaped array than the one
		// Container.render just indexed, so the inherited dirty start no longer
		// describes what is handed back. Reset it: the message is small, so
		// re-diffing all of its lines is cheap and always correct.
		this.renderDirtyStart = 0;
		// Check cache
		if (matchesRenderCache(this.cache, nativeRows, safeWidth)) {
			return this.cache!.lines;
		}

		const raw = hideCompleteFences(nativeRows, this.sourceText);
		const trimmed = trimOuterRows(raw);
		if (trimmed.lines.length === 0) {
			// Update cache
			this.cache = { nativeRows, width: safeWidth, lines: [] };
			return this.cache.lines;
		}

		const prepared = collapseAdjacentBlankRows(
			trimmed.lines.map((line) => prepareRow(line, this.outputPadding, false)),
		);
		const rows: Array<{ markers: string; body: string }> = [];
		const firstBodyIndex = prepared.findIndex((row) => !row.blank);
		for (let index = 0; index < prepared.length; index += 1) {
			const row = prepared[index]!;
			// The native row already starts with userMessageText. Styling the gutter
			// again inserts a foreground reset immediately before the message body,
			// which makes it fall back to the terminal foreground on the light bar.
			const prefix = index === firstBodyIndex ? "› " : "  ";
			const body = prependAfterTerminalSequences(row.body, prefix);
			rows.push({ markers: row.markers, body });
		}

		addMarkerToFirst(rows, trimmed.leadingMarkers);
		addMarkerToLast(rows, trimmed.trailingMarkers);
		// Update cache
		const lines = [...rows.map((row) => clampRow(`${row.markers}${row.body}`, safeWidth)), ""];
		this.cache = { nativeRows, width: safeWidth, lines };
		return lines;
	}
}

/**
 * Pi's assistant component remains the source of truth for thinking blocks,
 * Markdown, error states, and streaming.  Step adds only the compact `• `
 * gutter and trims renderer-only padding/leading blank rows.
 */
export class StepAssistantMessageComponent extends AssistantMessageComponent {
	private static readonly REASONING_COLLAPSED_LINES = 3;

	private outputPadding: number;
	private expanded = false;
	private hideThinking: boolean;
	private latestMessage?: AssistantMessage;
	private latestStreaming = false;
	// Thinking 摘要数据：时长按内容增量在流式期间起止计时（updateContent 每个增量
	// 都会调用），token 优先取 usage.reasoning，缺省用字符数估算（与状态行同法）。
	private thinkingChars = 0;
	private thinkingTotalMs = 0;
	private thinkingRunStartMs: number | undefined;
	private stepMarkdownTheme: MarkdownTheme;
	private stepMarkdownTransformers: readonly MarkdownTransformer[];
	private nativeRuns: NativeAssistantRun[] = [];
	private nativeStatusComponent?: AssistantMessageComponent;
	private nativeComponentsReady = false;

	// Cache for rendered output
	private cache?: RenderCache;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		super(
			message,
			hideThinkingBlock,
			markdownTheme,
			hiddenThinkingLabel,
			normalizeOutputPadding(outputPad),
			markdownTransformers,
		);
		this.outputPadding = normalizeOutputPadding(outputPad);
		this.hideThinking = hideThinkingBlock;
		this.latestMessage = message;
		this.latestStreaming = false;
		this.stepMarkdownTheme = markdownTheme;
		this.stepMarkdownTransformers = markdownTransformers;
		this.nativeComponentsReady = true;
		if (message) this.trackThinkingTiming(message, false);
		this.rebuildNativeComponents();
	}

	override updateContent(message: AssistantMessage, isStreaming = this.latestStreaming): void {
		// Not invalidate(): that re-pads and invalidates every run, rebuilding the
		// Markdown trees rebuildNativeComponents() reuses.  render() reads the message
		// for the prompt-zone markers, so the rendered rows still have to go.
		this.cache = undefined;
		this.latestMessage = message;
		this.latestStreaming = isStreaming ?? false;
		this.trackThinkingTiming(message, this.latestStreaming);
		if (this.nativeComponentsReady) {
			this.rebuildNativeComponents();
		}
	}

	/**
	 * 流式期间内容每次增长都会走到这里，恰好是 thinking 起止的可靠信号：
	 * 思考字符首次增长=一段思考开始；其后出现非思考内容或消息完成=这段思考结束。
	 * 非流式路径（会话回放）拿不到起止时刻，只累计字符数——摘要降级为不带时长。
	 */
	private trackThinkingTiming(message: AssistantMessage, isStreaming: boolean): void {
		const chars = message.content.reduce(
			(total, block) => total + (block.type === "thinking" ? block.thinking.trim().length : 0),
			0,
		);
		const grew = chars > this.thinkingChars;
		const hasNonThinking = message.content.some(
			(block) => (block.type === "text" && block.text.trim().length > 0) || block.type === "toolCall",
		);
		if (grew && isStreaming && this.thinkingRunStartMs === undefined) {
			this.thinkingRunStartMs = Date.now();
		}
		if (this.thinkingRunStartMs !== undefined && hasNonThinking && !grew) {
			this.thinkingTotalMs += Date.now() - this.thinkingRunStartMs;
			this.thinkingRunStartMs = undefined;
		}
		if (!isStreaming && this.thinkingRunStartMs !== undefined) {
			this.thinkingTotalMs += Date.now() - this.thinkingRunStartMs;
			this.thinkingRunStartMs = undefined;
		}
		this.thinkingChars = chars;
	}

	/**
	 * 完成态 thinking 摘要行（hideThinking 时的信息流锚点）：
	 * `• Thought for 12s · ↓ 1.2k tokens`——数据说话，代替无信息量的
	 * "Thinking..." 死标签。无 thinking 内容时返回 undefined（不占行）。
	 */
	private thinkingSummaryLabel(): string | undefined {
		if (this.thinkingChars === 0) return undefined;
		const reasoning = this.latestMessage?.usage.reasoning ?? 0;
		const tokens = reasoning > 0 ? reasoning : estimateTokens(this.thinkingChars);
		const seconds = Math.ceil(this.thinkingTotalMs / 1000);
		const duration = seconds > 0 ? ` for ${formatElapsedTime(seconds)}` : "";
		return (
			`${theme.italic(theme.fg("thinkingText", `Thought${duration}`))}` +
			theme.fg("muted", ` · ↓ ${formatTokens(tokens)} tokens`)
		);
	}

	override setHideThinkingBlock(hide: boolean): void {
		this.hideThinking = hide;
		this.invalidate();
	}

	override setHiddenThinkingLabel(_label: string): void {
		// step 皮肤隐藏 thinking 时显示的是数据摘要行，不是可配置 label；
		// 保留 override 只为让主题/标签热切换走 invalidate 重渲染。
		this.invalidate();
	}

	override setOutputPad(padding: number): void {
		this.outputPadding = normalizeOutputPadding(padding);
		this.invalidate();
	}

	override invalidate(): void {
		this.cache = undefined;
		for (const run of this.nativeRuns) {
			run.component.setOutputPad(this.outputPadding);
			run.component.invalidate();
		}
		if (this.nativeStatusComponent) {
			this.nativeStatusComponent.setOutputPad(this.outputPadding);
			this.nativeStatusComponent.invalidate();
		}
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.invalidate();
	}

	override render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		// Step reshapes pi's rows into a different-length array, so the dirty start
		// has to describe the rows returned here rather than anything an inherited
		// render() may have indexed. Reset it before every return below.
		this.renderDirtyStart = 0;
		// Reserve the two-cell Step gutter before asking pi to wrap Markdown. This
		// guarantees that adding a prefix can never violate pi-tui's width guard.
		const contentWidth = Math.max(1, safeWidth - 2);

		const runRows = this.nativeRuns.map((run) => run.component.render(contentWidth));
		const statusRows = this.nativeStatusComponent?.render(contentWidth) ?? [];
		const nativeRows = [...runRows.flat(), ...statusRows];
		// Check cache
		if (matchesRenderCache(this.cache, nativeRows, safeWidth)) {
			return this.cache!.lines;
		}

		const rows: Array<{ markers: string; body: string }> = [];
		for (const [index, run] of this.nativeRuns.entries()) {
			const prepared = this.renderNativeRun(runRows[index]!, run.kind === "text" ? run.source : undefined);
			if (prepared.length === 0) continue;

			if (rows.length > 0 && rows[rows.length - 1]?.body !== "") {
				rows.push({ markers: "", body: "" });
			}
			const rendered = run.kind === "thinking" ? this.renderThinkingRows(prepared) : this.renderAnswerRows(prepared);
			rows.push(...rendered);
		}

		const statusPrepared = this.renderNativeRun(statusRows);
		if (statusPrepared.length > 0) {
			if (rows.length > 0 && rows[rows.length - 1]?.body !== "") {
				rows.push({ markers: "", body: "" });
			}
			rows.push(...this.renderAnswerRows(statusPrepared));
		}

		while (rows.length > 0 && rows[rows.length - 1]?.body === "") rows.pop();
		if (rows.length === 0) {
			// Update cache
			this.cache = { nativeRows, width: safeWidth, lines: [] };
			return this.cache.lines;
		}

		// Pi emits prompt-zone markers around a complete assistant message. The
		// synthetic per-run components each emit their own markers, so normalize
		// them to one pair at the message boundary instead of leaking markers into
		// the middle of a Step section.
		for (const row of rows) row.markers = "";
		const hasToolCalls = this.latestMessage?.content.some((content) => content.type === "toolCall") ?? false;
		if (!hasToolCalls) {
			addMarkerToFirst(rows, "\x1b]133;A\x07");
			addMarkerToLast(rows, "\x1b]133;B\x07\x1b]133;C\x07");
		}

		// Update cache
		const lines = [...rows.map((row) => clampRow(`${row.markers}${row.body}`, safeWidth)), ""];
		this.cache = { nativeRows, width: safeWidth, lines };
		return lines;
	}

	private rebuildNativeComponents(): void {
		const message = this.latestMessage;
		if (!message || !this.nativeComponentsReady) return;

		const previousRuns = this.nativeRuns;
		this.nativeRuns = partitionAssistantContent(message).map((run, index) => {
			// Adjacent thinking deltas are one logical reasoning section. Joining
			// them into a single native block avoids Markdown inserting a paragraph
			// spacer between transport chunks while retaining Pi's styling/parser.
			const nativeContent =
				run.kind === "thinking"
					? ([{ type: "thinking", thinking: run.source }] as VisibleAssistantContent[])
					: run.content;
			const nativeMessage = makeNativeRunMessage(message, nativeContent);
			const previous = previousRuns[index];
			// During streaming, only the tail content run changes. Reusing an
			// unchanged Pi component avoids rebuilding its Markdown tree on every
			// delta while preserving Pi's own invalidation path when the run does
			// change or streaming transitions to its settled state.
			if (
				previous?.kind === run.kind &&
				previous.source === run.source &&
				previous.streaming === this.latestStreaming
			) {
				return previous;
			}
			const component =
				previous?.kind === run.kind
					? previous.component
					: new AssistantMessageComponent(
							nativeMessage,
							false,
							this.stepMarkdownTheme,
							undefined,
							this.outputPadding,
							this.stepMarkdownTransformers,
						);
			if (previous?.kind === run.kind) component.updateContent(nativeMessage, this.latestStreaming);
			return { ...run, component, streaming: this.latestStreaming };
		});

		const hasToolCalls = message.content.some((content) => content.type === "toolCall");
		const needsStatus =
			message.stopReason === "length" ||
			(!hasToolCalls && (message.stopReason === "aborted" || message.stopReason === "error"));
		if (!needsStatus) {
			this.nativeStatusComponent = undefined;
			return;
		}

		const statusMessage = makeNativeRunMessage(message, []);
		statusMessage.stopReason = message.stopReason;
		statusMessage.errorMessage = message.errorMessage;
		if (!this.nativeStatusComponent) {
			this.nativeStatusComponent = new AssistantMessageComponent(
				statusMessage,
				false,
				this.stepMarkdownTheme,
				undefined,
				this.outputPadding,
				this.stepMarkdownTransformers,
			);
		} else {
			this.nativeStatusComponent.updateContent(statusMessage, this.latestStreaming);
		}
	}

	private renderNativeRun(raw: string[], source?: string): PreparedRow[] {
		const rendered = source === undefined ? raw : hideCompleteFences(raw, source);
		const trimmed = trimOuterRows(rendered);
		if (trimmed.lines.length === 0) return [];
		return collapseAdjacentBlankRows(trimmed.lines.map((line) => prepareRow(line, this.outputPadding, true))).map(
			(row) => ({
				...row,
				// Prompt-zone markers are normalized once in render().
				markers: "",
			}),
		);
	}

	private renderThinkingRows(rows: PreparedRow[]): Array<{ markers: string; body: string }> {
		const reasoning = rows.map((row) => ({ ...row }));
		while (reasoning.length > 0 && reasoning[reasoning.length - 1]!.blank) reasoning.pop();
		while (reasoning.length > 0 && reasoning[0]!.blank) reasoning.shift();
		if (reasoning.length === 0) return [];

		if (this.hideThinking) {
			// 流式期间不占行：瞬时状态由底部状态行承担（Thinking... + 耗时 + token）。
			// 完成后留一行带数据的摘要锚点，回看历史时它要能回答"想了多久、花了多少"。
			if (this.latestStreaming) return [];
			const summary = this.thinkingSummaryLabel();
			if (!summary) return [];
			return [
				{
					markers: "",
					body: `${theme.fg("muted", "•")} ${summary}`,
				},
			];
		}

		const visible = this.expanded
			? reasoning
			: reasoning.slice(0, StepAssistantMessageComponent.REASONING_COLLAPSED_LINES);
		const rendered: Array<{ markers: string; body: string }> = [
			{
				markers: "",
				body: `${theme.fg("muted", "•")} ${theme.italic(theme.fg("thinkingText", "thinking"))}`,
			},
		];
		for (const row of visible) {
			rendered.push({
				markers: "",
				body: row.blank ? "" : prependAfterTerminalSequences(row.body, "  "),
			});
		}

		const hiddenCount = reasoning.length - visible.length;
		if (hiddenCount > 0) {
			rendered.push({
				markers: "",
				body: `  ${theme.fg(
					"muted",
					`… +${hiddenCount} ${hiddenCount === 1 ? "line" : "lines"} (ctrl+o to expand)`,
				)}`,
			});
		}
		return rendered;
	}

	private renderAnswerRows(rows: PreparedRow[]): Array<{ markers: string; body: string }> {
		const rendered: Array<{ markers: string; body: string }> = [];
		let hasAnswer = false;
		for (const row of rows) {
			if (row.blank) {
				rendered.push({ markers: row.markers, body: "" });
				continue;
			}
			const prefix = hasAnswer ? "  " : `${theme.fg("accent", "•")} `;
			rendered.push({
				markers: row.markers,
				body: prependAfterTerminalSequences(row.body, prefix),
			});
			hasAnswer = true;
		}
		return rendered;
	}
}
