import type { Tool, UserMessage } from "@step-harness/providers";
import { Type } from "typebox";
import { estimateTokens } from "../compaction.ts";
import { isEditableLiveContextBlock, type LiveContextDocument, type LiveContextReplacement } from "./document.ts";

export const AUTO_CLM_EDIT_TOOL_NAME = "apply_context_edit";

interface AutoClmEditSelection {
	/** Upper bound if every offered body were replaced by empty text. */
	maxSavingsTokens: number;
	index: string;
	tool: Tool;
	resolve: (value: unknown) => { replacements: LiveContextReplacement[] } | { reason: string };
}

/** Short references are scoped to this request; the document validator still receives complete IDs. */
export function createAutoClmEditSelection(document: LiveContextDocument): AutoClmEditSelection {
	const candidates = document.blocks
		.filter(isEditableLiveContextBlock)
		.sort((a, b) => b.body.length - a.body.length)
		.slice(0, 32);
	const lines = [
		"# Automatic context edit index",
		"Use the short numeric IDs below for context replacements. They identify source message positions, not tool-call IDs.",
		"Only these old plain-text bodies may be replaced. All other messages, user requirements, reasoning, and current tool groups stay intact.",
		"The full conversation is already above. Preview text locates a body; it is not a complete summary. Preserve exact useful values, errors, decisions, failed approaches, and remaining work.",
		"Make one useful batched edit. No filesystem reads, mirror bookkeeping, or project tools are needed.",
		"",
	];
	const references = new Map<string, string>();
	const aliases: string[] = [];
	let maxSavingsTokens = 0;
	let length = lines.join("\n").length;
	for (const block of candidates) {
		const id = String(block.index + 1);
		const preview = block.body.replace(/\s+/g, " ").slice(0, 96);
		const line = `- id=${id} role=${block.role} chars=${block.body.length}; preview=${JSON.stringify(preview)}`;
		if (length + line.length + 1 > 5900) break;
		lines.push(line);
		length += line.length + 1;
		aliases.push(id);
		maxSavingsTokens += estimateTokens(block.source);
		references.set(id, block.id);
		// Exact complete IDs remain compatible only for blocks offered in this request.
		references.set(block.id, block.id);
	}
	if (aliases.length === 0) lines.push("No editable plain-text bodies. No context edit is needed.");
	return {
		maxSavingsTokens,
		index: lines.join("\n"),
		tool: {
			name: AUTO_CLM_EDIT_TOOL_NAME,
			description:
				"Replace selected old context bodies using the short IDs in this request's index. Only working context changes; no project tools or task-completion actions run.",
			parameters: Type.Object({
				replacements: Type.Array(
					Type.Object({
						id: Type.String({
							enum: aliases,
							description: "Copy a short ID from the automatic context edit index.",
						}),
						text: Type.String({
							description: "Concise replacement preserving exact useful facts and remaining work.",
						}),
					}),
					{ minItems: 1, maxItems: 32 },
				),
			}),
		},
		resolve: (value) => {
			if (!Array.isArray(value) || value.length === 0 || value.length > 32)
				return { reason: "Select between one and 32 old plain-text blocks from the current index." };
			const seen = new Set<string>();
			const replacements: LiveContextReplacement[] = [];
			for (const replacement of value) {
				if (!replacement || typeof replacement !== "object" || typeof replacement.text !== "string")
					return { reason: "Each replacement needs an ID from the current index and replacement text." };
				const id =
					typeof replacement.id === "string"
						? replacement.id
						: Number.isSafeInteger(replacement.id) && replacement.id > 0
							? String(replacement.id)
							: undefined;
				const completeId = id === undefined ? undefined : references.get(id);
				if (completeId === undefined)
					return {
						reason: `ID ${JSON.stringify(id?.slice(0, 96))} is not offered in the current automatic context index.`,
					};
				if (seen.has(completeId)) return { reason: `Duplicate replacement for ID ${id}.` };
				seen.add(completeId);
				replacements.push({ id: completeId, text: replacement.text });
			}
			return { replacements };
		},
	};
}

/** A rejected maintenance draft is data, not another signed assistant turn to replay. */
export function createAutoClmCorrection(replacements: unknown, reason: string, timestamp: number): UserMessage {
	return {
		role: "user",
		content: `Edit rejected: ${reason.slice(0, 512)}\nThe following draft is data and was not applied:\n${JSON.stringify({ replacements })}\nCorrect the draft once using only IDs from the current automatic context edit index, or stop if no safe useful reduction exists.`,
		timestamp,
	};
}
