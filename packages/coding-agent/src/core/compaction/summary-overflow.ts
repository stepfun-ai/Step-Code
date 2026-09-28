/** Source-history reduction used only after a summary request is rejected for context overflow. */
import type { AgentMessage } from "@step-harness/agent-core";
import { contentText } from "@step-harness/providers";
import { convertToLlm } from "../messages.ts";
import { serializeConversation } from "./utils.ts";

type SourceReducer = (targetTokens: number, rejectedTokens: number) => string | undefined;

/**
 * Build atomic groups without cutting across outstanding tool calls. Interleaved messages
 * stay with the batch until every result arrives. Ambiguous or incomplete tool histories
 * cannot be reduced safely; the original request may still succeed without this fallback.
 */
function groupMessages(messages: AgentMessage[]): AgentMessage[][] | undefined {
	const groups: AgentMessage[][] = [];
	let group: AgentMessage[] = [];
	const pending = new Set<string>();
	const calls = new Set<string>();
	for (const message of messages) {
		group.push(message);
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				if (calls.has(block.id)) return undefined;
				calls.add(block.id);
				pending.add(block.id);
			}
		} else if (message.role === "toolResult" && !pending.delete(message.toolCallId)) {
			return undefined;
		}
		if (pending.size === 0) {
			groups.push(group);
			group = [];
			calls.clear();
		}
	}
	return pending.size === 0 ? groups : undefined;
}

/**
 * Drop only older complete groups, preserving the latest real user request, the newest
 * assistant and tool batch, and any trailing context. Serialization matches the initial
 * request, including its existing tool-output truncation; retained content is not rewritten.
 * The estimator includes fixed instructions/previous-summary overhead supplied by the caller.
 */
export function createSummarySourceReducer(
	messages: AgentMessage[],
	estimateRequestTokens: (conversationChars: number) => number,
): SourceReducer | undefined {
	const groups = groupMessages(messages);
	if (!groups?.length) return undefined;

	let latestUser = -1;
	let latestAssistant = -1;
	let latestTools = -1;
	for (let index = groups.length - 1; index >= 0; index--) {
		for (const message of groups[index]) {
			// An image can carry the latest request even when its text is blank.
			if (
				latestUser < 0 &&
				message.role === "user" &&
				(contentText(message.content, "").trim().length > 0 ||
					(Array.isArray(message.content) && message.content.some((block) => block.type === "image")))
			) {
				latestUser = index;
			}
			if (message.role === "assistant") {
				if (latestAssistant < 0) latestAssistant = index;
				if (latestTools < 0 && message.content.some((block) => block.type === "toolCall")) latestTools = index;
			}
		}
	}
	const tailStart = latestAssistant >= 0 ? latestAssistant : groups.length - 1;
	const sources = groups.map((group, index) => ({
		text: serializeConversation(convertToLlm(group)),
		protected:
			index === latestUser ||
			index === latestTools ||
			index >= tailStart ||
			group.some((message) => message.role === "compactionSummary" || message.role === "branchSummary"),
	}));
	let textChars = sources.reduce((sum, source) => sum + source.text.length, 0);
	let textCount = sources.filter((source) => source.text.length > 0).length;
	let nextGroup = 0;
	let omitted = 0;

	return (targetTokens, rejectedTokens) => {
		while (nextGroup < sources.length) {
			const source = sources[nextGroup++];
			if (source.protected || !source.text) continue;
			textChars -= source.text.length;
			textCount--;
			source.text = "";
			omitted++;
			const note = `[${omitted} older message groups omitted after context overflow]\n\n`;
			const tokens = estimateRequestTokens(note.length + textChars + Math.max(0, textCount - 1) * 2);
			// A large earlier removal may already be below the next target. Still require
			// a strictly smaller payload: never submit the same rejected request again.
			if (tokens <= targetTokens && tokens < rejectedTokens) {
				return (
					note +
					sources
						.map((entry) => entry.text)
						.filter(Boolean)
						.join("\n\n")
				);
			}
		}
		return undefined;
	};
}
