/**
 * The five projection rewrite rules. Each rule only rewrites message
 * *content* in place inside the working copy -- never structure, roles, or
 * tool-call blocks -- and always skips the protected indexes computed by
 * `computeProtection`.
 */

import type { AssistantMessage, Message, TextContent, ThinkingContent, ToolCall } from "@step-harness/providers";
import {
	containsProjectionMarker,
	contentHasImage,
	isBashExecutionUserMessage,
	isSummaryUserMessage,
	isToolOutputMessage,
	normalizeForHash,
	PROJECTION_CUT_MARKER_PREFIX,
	PROJECTION_REPEAT_MARKER_PREFIX,
	PROJECTION_SUMMARY_MARKER_PREFIX,
	replaceTextBlocks,
	shortContentHash,
	textOfUserOrToolContent,
	type UserOrToolContent,
	withUserOrToolContent,
} from "./projection-content.ts";
import type { ProtectionZones } from "./projection-invariants.ts";
import type { ProjectionByRuleStats, ProjectionKnobs } from "./projection-options.ts";
import { CODE_SALIENT_LINE_REGEX, cutTextWithSalientLines, SALIENT_LINE_REGEX } from "./projection-salient.ts";

/** Minimum size for a result to participate in repeated-output folding. */
const REPEAT_MIN_CHARS = 200;

// ============================================================================
// Rule a: large toolResult / bashExecution outputs
// ============================================================================

function applyLargeToolResultRule(
	projectedMessages: Message[],
	protection: ProtectionZones,
	knobs: ProjectionKnobs,
	byRule: ProjectionByRuleStats,
): number {
	let rewrites = 0;
	for (let i = 0; i < projectedMessages.length; i++) {
		if (protection.protectedIndexes.has(i)) continue;
		const message = projectedMessages[i];
		if (!isToolOutputMessage(message)) continue;
		const text = textOfUserOrToolContent(message.content);
		if (text.length < knobs.largeMinChars || containsProjectionMarker(text)) continue;
		const { content, cuts } = replaceTextBlocks(
			message.content,
			knobs.largeMinChars,
			(blockText) =>
				cutTextWithSalientLines(
					blockText,
					knobs.headChars,
					knobs.tailChars,
					knobs.maxSalientLines,
					SALIENT_LINE_REGEX,
				)?.text,
		);
		if (cuts === 0) continue;
		projectedMessages[i] = withUserOrToolContent(message, content);
		byRule.tool_result_cuts += 1;
		rewrites += 1;
	}
	return rewrites;
}

// ============================================================================
// Rule b: repeated tool/bash outputs
// ============================================================================

/** Fold repeated outputs, preserving the first and most recent occurrences. */
function applyRepeatedOutputRule(
	projectedMessages: Message[],
	protection: ProtectionZones,
	byRule: ProjectionByRuleStats,
): number {
	const duplicateIndexesByKey = new Map<string, number[]>();
	for (let i = 0; i < projectedMessages.length; i++) {
		const message = projectedMessages[i];
		if (!isToolOutputMessage(message)) continue;
		if (contentHasImage(message.content)) continue;
		const text = textOfUserOrToolContent(message.content);
		if (text.length < REPEAT_MIN_CHARS || containsProjectionMarker(text)) continue;
		const identityKey =
			message.role === "toolResult" ? `toolResult|${message.toolName}|${message.isError ? 1 : 0}` : "user-bash|_|0";
		const groupKey = `${identityKey}|${shortContentHash(normalizeForHash(text))}`;
		const duplicateIndexes = duplicateIndexesByKey.get(groupKey);
		if (duplicateIndexes) duplicateIndexes.push(i);
		else duplicateIndexesByKey.set(groupKey, [i]);
	}

	let rewrites = 0;
	for (const [groupKey, duplicateIndexes] of duplicateIndexesByKey) {
		if (duplicateIndexes.length < 3) continue; // first + most recent stay full; only middles fold
		const firstIndex = duplicateIndexes[0];
		const lastIndex = duplicateIndexes[duplicateIndexes.length - 1];
		const contentHash = groupKey.slice(groupKey.lastIndexOf("|") + 1);
		for (const duplicateIndex of duplicateIndexes) {
			if (duplicateIndex === firstIndex || duplicateIndex === lastIndex) continue;
			if (protection.protectedIndexes.has(duplicateIndex)) continue;
			const message = projectedMessages[duplicateIndex];
			if (!isToolOutputMessage(message)) continue;
			const originalChars = textOfUserOrToolContent(message.content).length;
			const marker = `${PROJECTION_REPEAT_MARKER_PREFIX} last full output at index ${lastIndex}; first at index ${firstIndex}; hash=${contentHash}; original_chars=${originalChars}]`;
			const markerContent: UserOrToolContent =
				typeof message.content === "string" ? marker : [{ type: "text", text: marker }];
			projectedMessages[duplicateIndex] = withUserOrToolContent(message, markerContent);
			byRule.dedup_folds += 1;
			rewrites += 1;
		}
	}
	return rewrites;
}

// ============================================================================
// Rule c: historical assistant thinking
// ============================================================================

interface ThinkingStripOutcome {
	content: (TextContent | ThinkingContent | ToolCall)[];
	droppedBlocks: number;
}

/**
 * Strip all thinking blocks from an assistant message, leaving one elision
 * marker (with the total dropped chars) at the first block's position.
 * Returns undefined when the message carries no thinking.
 */
function stripThinkingBlocks(message: AssistantMessage): ThinkingStripOutcome | undefined {
	let droppedBlocks = 0;
	let droppedChars = 0;
	let markerIndex = -1;
	const content: (TextContent | ThinkingContent | ToolCall)[] = [];
	for (const block of message.content) {
		if (block.type === "thinking") {
			if (droppedBlocks === 0) {
				markerIndex = content.length;
				content.push({ type: "text", text: "" });
			}
			droppedBlocks += 1;
			droppedChars += block.thinking.length;
			continue;
		}
		content.push(block);
	}
	if (droppedBlocks === 0) return undefined;
	content[markerIndex] = {
		type: "text",
		text: `${PROJECTION_CUT_MARKER_PREFIX} thinking elided (${droppedChars} chars)]`,
	};
	return { content, droppedBlocks };
}

/** Drop historical assistant thinking, keeping the most recent blocks. */
function applyThinkingDropRule(
	projectedMessages: Message[],
	protection: ProtectionZones,
	knobs: ProjectionKnobs,
	byRule: ProjectionByRuleStats,
): number {
	const thinkingBearing: { index: number; message: AssistantMessage }[] = [];
	for (let i = 0; i < projectedMessages.length; i++) {
		const message = projectedMessages[i];
		if (message.role !== "assistant") continue;
		if (message.content.some((block) => block.type === "thinking")) thinkingBearing.push({ index: i, message });
	}
	if (thinkingBearing.length <= knobs.keepThinkingBlocks) return 0;

	const keptEntries = new Set(thinkingBearing.slice(thinkingBearing.length - knobs.keepThinkingBlocks));
	let rewrites = 0;
	for (const thinkingEntry of thinkingBearing) {
		if (keptEntries.has(thinkingEntry) || protection.protectedIndexes.has(thinkingEntry.index)) continue;
		const stripped = stripThinkingBlocks(thinkingEntry.message);
		if (!stripped) continue;
		projectedMessages[thinkingEntry.index] = { ...thinkingEntry.message, content: stripped.content };
		byRule.thinking_drops += stripped.droppedBlocks;
		rewrites += 1;
	}
	return rewrites;
}

// ============================================================================
// Rule d: repeated branch/compaction summaries
// ============================================================================

/** Deduplicate repeated summaries, keeping only the newest copy. */
function applySummaryDedupRule(
	projectedMessages: Message[],
	protection: ProtectionZones,
	byRule: ProjectionByRuleStats,
): number {
	const duplicateIndexesByHash = new Map<string, number[]>();
	for (let i = 0; i < projectedMessages.length; i++) {
		const message = projectedMessages[i];
		if (!isSummaryUserMessage(message)) continue;
		const contentHash = shortContentHash(normalizeForHash(textOfUserOrToolContent(message.content)));
		const duplicateIndexes = duplicateIndexesByHash.get(contentHash);
		if (duplicateIndexes) duplicateIndexes.push(i);
		else duplicateIndexesByHash.set(contentHash, [i]);
	}

	let rewrites = 0;
	for (const [contentHash, duplicateIndexes] of duplicateIndexesByHash) {
		if (duplicateIndexes.length < 2) continue;
		const newestIndex = duplicateIndexes[duplicateIndexes.length - 1];
		for (const duplicateIndex of duplicateIndexes) {
			if (duplicateIndex === newestIndex) continue;
			if (protection.protectedIndexes.has(duplicateIndex)) continue;
			const message = projectedMessages[duplicateIndex];
			if (!isSummaryUserMessage(message)) continue;
			const marker = `${PROJECTION_SUMMARY_MARKER_PREFIX} identical summary retained at index ${newestIndex}; hash=${contentHash}]`;
			const markerContent: UserOrToolContent =
				typeof message.content === "string" ? marker : [{ type: "text", text: marker }];
			projectedMessages[duplicateIndex] = withUserOrToolContent(message, markerContent);
			byRule.summary_dedups += 1;
			rewrites += 1;
		}
	}
	return rewrites;
}

// ============================================================================
// Rule e: large code / patch / JSON payloads
// ============================================================================

const FENCED_CODE_BLOCK_MARKER = "```";
const DIFF_HEADER_REGEX = /^diff --git /m;
const DIFF_HUNK_HEADER_REGEX = /^@@ -\d/m;

function looksLikeCodeOrData(text: string): boolean {
	if (text.includes(FENCED_CODE_BLOCK_MARKER)) return true;
	if (DIFF_HEADER_REGEX.test(text) || DIFF_HUNK_HEADER_REGEX.test(text)) return true;
	const firstChar = text.trimStart()[0];
	return firstChar === "{" || firstChar === "[";
}

/** Line-boundary truncation of large code / patch / JSON payloads. */
function applyLargeCodeRule(
	projectedMessages: Message[],
	protection: ProtectionZones,
	knobs: ProjectionKnobs,
	byRule: ProjectionByRuleStats,
): number {
	let rewrites = 0;
	for (let i = 0; i < projectedMessages.length; i++) {
		if (protection.protectedIndexes.has(i)) continue;
		const message = projectedMessages[i];
		if (message.role !== "user" && message.role !== "toolResult") continue;
		if (isBashExecutionUserMessage(message) || isSummaryUserMessage(message)) continue;
		const text = textOfUserOrToolContent(message.content);
		if (text.length < knobs.largeMinChars || containsProjectionMarker(text)) continue;
		if (!looksLikeCodeOrData(text)) continue;
		const { content, cuts } = replaceTextBlocks(
			message.content,
			knobs.largeMinChars,
			(blockText) =>
				cutTextWithSalientLines(
					blockText,
					knobs.headChars,
					knobs.tailChars,
					knobs.maxSalientLines,
					CODE_SALIENT_LINE_REGEX,
				)?.text,
		);
		if (cuts === 0) continue;
		projectedMessages[i] = withUserOrToolContent(message, content);
		byRule.code_cuts += 1;
		rewrites += 1;
	}
	return rewrites;
}

// ============================================================================
// Orchestration
// ============================================================================

/** Apply all five rules to the working copy; returns the number of rewritten messages. */
export function applyProjectionRules(
	projectedMessages: Message[],
	protection: ProtectionZones,
	knobs: ProjectionKnobs,
	byRule: ProjectionByRuleStats,
): number {
	let rewrites = 0;
	rewrites += applySummaryDedupRule(projectedMessages, protection, byRule);
	rewrites += applyRepeatedOutputRule(projectedMessages, protection, byRule);
	rewrites += applyLargeToolResultRule(projectedMessages, protection, knobs, byRule);
	rewrites += applyLargeCodeRule(projectedMessages, protection, knobs, byRule);
	rewrites += applyThinkingDropRule(projectedMessages, protection, knobs, byRule);
	return rewrites;
}
