import type { AssistantMessage, Context, ImageContent, Message, TextContent, Tool, Usage } from "../types.ts";

export interface ContextUsageEstimate {
	/** Estimated total context tokens. */
	tokens: number;
	/** Tokens reported by the most recent applicable assistant usage block. */
	usageTokens: number;
	/** Estimated tokens after the most recent applicable assistant usage block. */
	trailingTokens: number;
	/** Index of the applicable message that provided usage, or null when none exists. */
	lastUsageIndex: number | null;
}

/**
 * UTF-8 bytes per token, the unit providers actually bill.
 *
 * English prose and code sit near four bytes per token. CJK does not: one han
 * character is three UTF-8 bytes but only ~0.75 token, while JavaScript's
 * `string.length` counts it as one character and the old `length / 4` estimate
 * therefore reported a quarter of its real cost. Counting bytes keeps English
 * estimates unchanged and stops CJK text from being undercounted by ~2.5x,
 * which is what let requests exceed the window while the host still believed
 * they fit.
 */
const BYTES_PER_TOKEN = 4;
const ESTIMATED_IMAGE_TOKENS = 1200;
const NON_ASCII = /[^\x00-\x7f]/;

/** UTF-8 byte length without allocating an encoded copy. */
export function textUtf8ByteLength(text: string): number {
	if (!NON_ASCII.test(text)) return text.length;
	let bytes = text.length;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code < 0x80) continue;
		if (code < 0x800) {
			bytes += 1;
		} else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
			// One astral character: two UTF-16 units already counted, four bytes in UTF-8.
			bytes += 2;
			i++;
		} else {
			bytes += 2;
		}
	}
	return bytes;
}

export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

export function estimateTextTokens(text: string): number {
	return Math.ceil(textUtf8ByteLength(text) / BYTES_PER_TOKEN);
}

export function estimateTextAndImageContentTokens(content: string | Array<TextContent | ImageContent>): number {
	if (typeof content === "string") return estimateTextTokens(content);

	let tokens = 0;
	for (const block of content) {
		tokens += block.type === "text" ? estimateTextTokens(block.text) : ESTIMATED_IMAGE_TOKENS;
	}
	return tokens;
}

export function estimateMessageTokens(message: Message): number {
	let tokens = 0;

	if (message.role === "user") return estimateTextAndImageContentTokens(message.content);
	if (message.role === "toolResult") return estimateTextAndImageContentTokens(message.content);

	for (const block of message.content) {
		if (block.type === "text") {
			tokens += estimateTextTokens(block.text);
		} else if (block.type === "thinking") {
			tokens += estimateTextTokens(block.thinking);
		} else {
			tokens += estimateTextTokens(block.name) + estimateTextTokens(safeJsonStringify(block.arguments));
		}
	}
	return tokens;
}

function getLastAssistantUsageInfo(messages: readonly Message[]): { usage: Usage; index: number } | undefined {
	let latestPrefixTimestamp = Number.NEGATIVE_INFINITY;
	let usageInfo: { usage: Usage; index: number } | undefined;

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message.role === "assistant") {
			const assistant = message as AssistantMessage;
			// A newer prefix message was inserted after this response (for example, a
			// compaction summary), so its usage cannot describe the current prefix.
			const usageAppliesToPrefix = assistant.timestamp >= latestPrefixTimestamp;
			if (
				usageAppliesToPrefix &&
				assistant.stopReason !== "aborted" &&
				assistant.stopReason !== "error" &&
				calculateContextTokens(assistant.usage) > 0
			) {
				usageInfo = { usage: assistant.usage, index: i };
			}
		}
		latestPrefixTimestamp = Math.max(latestPrefixTimestamp, message.timestamp);
	}

	return usageInfo;
}

function estimateMessages(messages: readonly Message[]): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages);
	if (usageInfo) {
		const usageTokens = calculateContextTokens(usageInfo.usage);
		let trailingTokens = 0;
		for (let i = usageInfo.index + 1; i < messages.length; i++) {
			trailingTokens += estimateMessageTokens(messages[i]);
		}
		return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex: usageInfo.index };
	}

	let tokens = 0;
	for (const message of messages) tokens += estimateMessageTokens(message);
	return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
}

function estimateToolsTokens(tools: readonly Tool[] | undefined): number {
	if (!tools || tools.length === 0) return 0;
	return estimateTextTokens(safeJsonStringify(tools));
}

function isMessageArray(value: Context | readonly Message[]): value is readonly Message[] {
	return Array.isArray(value);
}

export function estimateContextTokens(context: Context | readonly Message[]): ContextUsageEstimate {
	if (isMessageArray(context)) return estimateMessages(context);

	const estimatedInputTokens = context.estimatedInputTokens;
	if (typeof estimatedInputTokens === "number" && Number.isFinite(estimatedInputTokens) && estimatedInputTokens >= 0) {
		const tokens = Math.ceil(estimatedInputTokens);
		return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
	}

	const estimate = estimateMessages(context.messages);
	if (estimate.lastUsageIndex !== null) {
		const addedNames = new Set(
			context.messages
				.slice(estimate.lastUsageIndex + 1)
				.filter((message) => message.role === "toolResult")
				.flatMap((message) => message.addedToolNames ?? []),
		);
		const addedToolTokens = estimateToolsTokens(context.tools?.filter((tool) => addedNames.has(tool.name)));
		return {
			tokens: estimate.tokens + addedToolTokens,
			usageTokens: estimate.usageTokens,
			trailingTokens: estimate.trailingTokens + addedToolTokens,
			lastUsageIndex: estimate.lastUsageIndex,
		};
	}

	const prefixTokens =
		(context.systemPrompt ? estimateTextTokens(context.systemPrompt) : 0) + estimateToolsTokens(context.tools);

	return {
		tokens: estimate.tokens + prefixTokens,
		usageTokens: estimate.usageTokens,
		trailingTokens: estimate.trailingTokens + prefixTokens,
		lastUsageIndex: estimate.lastUsageIndex,
	};
}
