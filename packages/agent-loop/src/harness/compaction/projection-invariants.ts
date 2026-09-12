/**
 * Projection invariant zones and post-projection verification.
 *
 * Three zones are protected from rewriting (any violation observed afterwards
 * makes the caller fall back to the original messages):
 *   1. The current user turn (last user message).
 *   2. The active tool-call group (last assistant message and everything
 *      after it).
 *   3. The most recent `keepRecentTokens` worth of tail messages.
 */

import type { AssistantMessage, Message, ToolCall } from "@step-harness/providers";
import { estimateMessageTokens } from "./projection-content.ts";

// ============================================================================
// Protection (invariant zones)
// ============================================================================

/** Indexes the rules must not rewrite, plus the zone boundaries they derive from. */
export interface ProtectionZones {
	protectedIndexes: Set<number>;
	lastUserIndex: number;
	activeGroupStart: number;
	tailStart: number;
}

export function computeProtection(messages: readonly Message[], keepRecentTokens: number): ProtectionZones {
	let lastUserIndex = -1;
	let lastAssistantIndex = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const role = messages[i].role;
		if (lastUserIndex === -1 && role === "user") lastUserIndex = i;
		if (lastAssistantIndex === -1 && role === "assistant") lastAssistantIndex = i;
		if (lastUserIndex !== -1 && lastAssistantIndex !== -1) break;
	}

	// Invariant 2: the last assistant message plus everything after it (its tool
	// results and any trailing steering/user content) forms the active group.
	const activeGroupStart = lastAssistantIndex === -1 ? messages.length : lastAssistantIndex;

	// Invariant 3: keep the trailing messages that fit fully within the
	// `keepRecentTokens` budget untouched. The message straddling the budget
	// boundary sits mostly outside the window and stays projectable; the very
	// last messages are always additionally covered by invariants 1 and 2.
	let tailStart = 0;
	let accumulatedTokens = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		accumulatedTokens += estimateMessageTokens(messages[i]);
		if (accumulatedTokens > keepRecentTokens) {
			tailStart = i + 1;
			break;
		}
	}

	const protectedFrom = Math.min(activeGroupStart, tailStart);
	const protectedIndexes = new Set<number>();
	for (let i = protectedFrom; i < messages.length; i++) protectedIndexes.add(i);
	// Invariant 1: the current user turn is protected wherever it sits.
	if (lastUserIndex !== -1) protectedIndexes.add(lastUserIndex);

	return { protectedIndexes, lastUserIndex, activeGroupStart, tailStart };
}

// ============================================================================
// Invariant verification (fail-safe)
// ============================================================================

function toolCallSignature(message: AssistantMessage): string {
	return message.content
		.filter((block): block is ToolCall => block.type === "toolCall")
		.map((block) => `${block.id}:${block.name}`)
		.join(",");
}

/**
 * Verify the structural invariants between the original and projected arrays.
 * Returns a violation description, or undefined when everything holds.
 */
export function verifyProjectionInvariants(
	original: readonly Message[],
	projected: readonly Message[],
	protectedIndexes: ReadonlySet<number>,
	lastUserIndex: number,
): string | undefined {
	if (original.length !== projected.length) return "message-count-changed";

	for (let i = 0; i < original.length; i++) {
		const before = original[i];
		const after = projected[i];
		if (before.role !== after.role) return `role-changed@${i}`;
		if (protectedIndexes.has(i) && before !== after) return `protected-message-modified@${i}`;
		if (before.role === "assistant" && after.role === "assistant") {
			if (toolCallSignature(before) !== toolCallSignature(after)) return `tool-calls-modified@${i}`;
		}
		if (before.role === "toolResult" && after.role === "toolResult") {
			if (before.toolCallId !== after.toolCallId || before.toolName !== after.toolName) {
				return `tool-result-identity-changed@${i}`;
			}
			if (before.isError !== after.isError) return `tool-result-error-flag-changed@${i}`;
		}
	}

	if (lastUserIndex !== -1 && original[lastUserIndex] !== projected[lastUserIndex]) {
		return "current-user-turn-modified";
	}

	// toolCall/toolResult pairing: every call answered before must stay answered.
	const answeredBefore = new Set<string>();
	for (const message of original) {
		if (message.role === "toolResult") answeredBefore.add(message.toolCallId);
	}
	const answeredAfter = new Set<string>();
	for (const message of projected) {
		if (message.role === "toolResult") answeredAfter.add(message.toolCallId);
	}
	for (const message of projected) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			if (answeredBefore.has(block.id) && !answeredAfter.has(block.id)) {
				return `tool-pairing-broken@${block.id}`;
			}
		}
	}

	return undefined;
}
