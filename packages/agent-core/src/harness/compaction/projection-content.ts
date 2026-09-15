/**
 * Content measurement, hashing, marker, and classification helpers shared by
 * the projection modules. Everything here is pure and depends only on
 * `@step-harness/providers` message types.
 */

import type { ImageContent, Message, TextContent, ToolResultMessage, UserMessage } from "@step-harness/providers";

// ============================================================================
// Rewrite markers
// ============================================================================

/** Machine-readable marker prefix for cut content. */
export const PROJECTION_CUT_MARKER_PREFIX = "[context-compacted:";
/** Marker prefix for folded duplicate outputs. */
export const PROJECTION_REPEAT_MARKER_PREFIX = "[repeated:";
/** Marker prefix for deduplicated older summaries. */
export const PROJECTION_SUMMARY_MARKER_PREFIX = "[superseded-summary:";

/** True when `text` already carries a projection marker (never rewrite twice). */
export function containsProjectionMarker(text: string): boolean {
	return (
		text.includes(PROJECTION_CUT_MARKER_PREFIX) ||
		text.startsWith(PROJECTION_REPEAT_MARKER_PREFIX) ||
		text.startsWith(PROJECTION_SUMMARY_MARKER_PREFIX)
	);
}

// ============================================================================
// Content sizing
// ============================================================================

const CHARS_PER_TOKEN = 4;
const ESTIMATED_IMAGE_CHARS = 4800;

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

export function messageContentChars(message: Message): number {
	if (message.role === "user" || message.role === "toolResult") {
		const content = message.content;
		if (typeof content === "string") return content.length;
		let chars = 0;
		for (const block of content) chars += block.type === "text" ? block.text.length : ESTIMATED_IMAGE_CHARS;
		return chars;
	}
	let chars = 0;
	for (const block of message.content) {
		if (block.type === "text") chars += block.text.length;
		else if (block.type === "thinking") chars += block.thinking.length;
		else chars += block.name.length + safeJsonStringify(block.arguments).length;
	}
	return chars;
}

export function totalContentChars(messages: readonly Message[]): number {
	let chars = 0;
	for (const message of messages) chars += messageContentChars(message);
	return chars;
}

/** chars/4 estimate, deliberately simple and deterministic. */
export function estimateProjectionTokens(messages: readonly Message[]): number {
	return Math.ceil(totalContentChars(messages) / CHARS_PER_TOKEN);
}

/** chars/4 estimate for a single message. */
export function estimateMessageTokens(message: Message): number {
	return Math.ceil(messageContentChars(message) / CHARS_PER_TOKEN);
}

// ============================================================================
// Content hashing
// ============================================================================

function hash32(text: string, seed: number): number {
	let hash = seed >>> 0;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 16777619) >>> 0;
	}
	return hash >>> 0;
}

/** Deterministic 16-hex-char content hash (double 32-bit FNV-1a). */
export function shortContentHash(text: string): string {
	const primaryHash = hash32(text, 0x811c9dc5);
	const secondaryHash = hash32(text, (0x811c9dc5 ^ 0x9e3779b9) >>> 0);
	return primaryHash.toString(16).padStart(8, "0") + secondaryHash.toString(16).padStart(8, "0");
}

/** Whitespace-insensitive normalization applied before hashing/deduplication. */
export function normalizeForHash(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

// ============================================================================
// User / toolResult content access
// ============================================================================

/** The content shape shared by `UserMessage` and `ToolResultMessage`. */
export type UserOrToolContent = string | (TextContent | ImageContent)[];

export function textOfUserOrToolContent(content: UserOrToolContent): string {
	if (typeof content === "string") return content;
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export function contentHasImage(content: UserOrToolContent): boolean {
	return typeof content !== "string" && content.some((block) => block.type === "image");
}

/**
 * Apply `rewriteText` to every text block of at least `minChars` characters.
 * Non-text blocks and blocks the callback declines (returns undefined for)
 * are kept as-is.
 */
export function replaceTextBlocks(
	content: UserOrToolContent,
	minChars: number,
	rewriteText: (text: string) => string | undefined,
): { content: UserOrToolContent; cuts: number } {
	if (typeof content === "string") {
		if (content.length < minChars) return { content, cuts: 0 };
		const rewritten = rewriteText(content);
		return rewritten !== undefined ? { content: rewritten, cuts: 1 } : { content, cuts: 0 };
	}
	let cuts = 0;
	const rewrittenBlocks = content.map((block) => {
		if (block.type !== "text" || block.text.length < minChars) return block;
		const rewritten = rewriteText(block.text);
		if (rewritten === undefined) return block;
		cuts += 1;
		return { ...block, text: rewritten };
	});
	return cuts > 0 ? { content: rewrittenBlocks, cuts } : { content, cuts: 0 };
}

/**
 * Rebuild a user/toolResult message with replaced content. Callers preserve
 * the content shape by construction (string content stays a string, block
 * content stays blocks), which a spread over the message union cannot prove
 * to the type checker -- hence this single localized assertion.
 */
export function withUserOrToolContent(message: ToolResultMessage | UserMessage, content: UserOrToolContent): Message {
	return { ...message, content } as Message;
}

// ============================================================================
// Message classification
// ============================================================================

/** `bashExecutionToText` conversions start with this shape ("Ran `cmd`"). */
const BASH_EXECUTION_TEXT_REGEX = /^Ran `[^`\n]*`\n/;

/** Literal prefixes used by compaction/branch summary user messages. */
const COMPACTION_SUMMARY_TEXT_START =
	"The conversation history before this point was compacted into the following summary:";
const BRANCH_SUMMARY_TEXT_START = "The following is a summary of a branch that this conversation came back from:";

export function isBashExecutionUserMessage(message: Message): message is UserMessage {
	return message.role === "user" && BASH_EXECUTION_TEXT_REGEX.test(textOfUserOrToolContent(message.content));
}

export function isSummaryUserMessage(message: Message): message is UserMessage {
	if (message.role !== "user") return false;
	const text = textOfUserOrToolContent(message.content);
	return text.startsWith(COMPACTION_SUMMARY_TEXT_START) || text.startsWith(BRANCH_SUMMARY_TEXT_START);
}

/** Tool results and converted bash executions: the outputs rules a/b operate on. */
export function isToolOutputMessage(message: Message): message is ToolResultMessage | UserMessage {
	return message.role === "toolResult" || isBashExecutionUserMessage(message);
}
