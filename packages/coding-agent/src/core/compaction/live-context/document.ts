/** Pure, snapshot-based editing of the live context. No session, filesystem, or clock dependencies. */
import type { AgentMessage } from "@step-harness/agent-core";
import type { ImageContent, TextContent, ThinkingContent, ToolCall } from "@step-harness/providers";
import { createTwoFilesPatch } from "diff";
import type { CustomMessage } from "../../messages.ts";
import {
	blockId,
	canonicalJson,
	DOCUMENT_VERSION,
	digestCanonicalMessages,
	documentId,
	escapeStructuralLines,
	parseDocument,
	sha256,
	unescapeStructuralLines,
} from "./pi-clm/framing.ts";

const INSTRUCTIONS = [
	"# Edit text bodies or delete complete old CTX_TURN groups. Keep metadata and existing headers intact.",
	"# Protected turns cannot be changed or removed. Keep retained turns in their original order.",
	"# Assistants with tool calls or thinking are immutable; remove them only with their entire old tool group.",
	"# Keep CTX_IMAGE and CTX_TEXT markers intact. Only text between content markers is editable.",
	"# Add notes using a CTX_TURN header with the same document, index=0, role=notes, id=new-<unique>, protected=false.",
	"# Put new notes outside tool call/result sequences. Escape quoted structural lines with a leading backslash.",
].join("\n");

interface LiveContextBlock {
	/** Original zero-based message index; never renumber retained headers while editing. */
	index: number;
	id: string;
	role: string;
	protected: boolean;
	header: string;
	body: string;
	source: AgentMessage;
}

export interface LiveContextDocument {
	text: string;
	messages: AgentMessage[];
	revision: number;
	version: 1;
	/** Session/revision nonce, stable even when messages are appended. */
	documentId: string;
	/** Exact input baseline, including metadata that is not shown in the document. */
	baselineDigest: string;
	blocks: LiveContextBlock[];
}

export interface ApplyLiveContextResult {
	accepted: boolean;
	/** True only when an edit was accepted and the resulting messages changed. */
	changed: boolean;
	messages: AgentMessage[];
	/** One per output message: index in snapshot.messages, or null for a new note. */
	sourceIndexes: Array<number | null>;
	reason?: string;
	/** Unified diff of an accepted edit; empty for rejections and no-ops. */
	diff: string;
}

type ContentPart = TextContent | ImageContent | ThinkingContent | ToolCall;
type MessageOrigin = { message: AgentMessage; sourceIndex?: number };

/** Stable canonical JSON hash, including message order, content, and all serializable metadata. */
export function digestMessages(messages: readonly AgentMessage[]): string {
	return digestCanonicalMessages(messages);
}

export function isLiveContextNote(message: AgentMessage): boolean {
	return message.role === "custom" && message.customType === "live-context-note";
}

function contentMarker(part: TextContent | ImageContent, index: number, id: string, nonce: string): string {
	const prefix = `document=${nonce} id=${id} part=${index + 1}`;
	return part.type === "image"
		? `[[CTX_IMAGE ${prefix} mime=${encodeURIComponent(part.mimeType)} digest=${sha256(canonicalJson(part))}]]`
		: `[[CTX_TEXT ${prefix}]]`;
}

function renderContent(content: string | ContentPart[], id: string, nonce: string): string {
	if (typeof content === "string") return escapeStructuralLines(content);
	return content
		.map((part, index) => {
			switch (part.type) {
				case "text": {
					const body = escapeStructuralLines(part.text);
					return content.length > 1 ? `${contentMarker(part, index, id, nonce)}\n${body}` : body;
				}
				case "image":
					return contentMarker(part, index, id, nonce);
				case "thinking":
					return escapeStructuralLines(`[thinking${part.redacted ? " redacted" : ""}]\n${part.thinking}`);
				case "toolCall":
					return escapeStructuralLines(
						`[tool call: ${part.name} id=${part.id}]\n${canonicalJson(part.arguments)}`,
					);
				default:
					return escapeStructuralLines(canonicalJson(part));
			}
		})
		.join("\n");
}

function renderMessage(message: AgentMessage, id: string, nonce: string): string {
	switch (message.role) {
		case "user":
		case "assistant":
		case "toolResult":
		case "custom":
			return renderContent(message.content, id, nonce);
		case "compactionSummary":
		case "branchSummary":
			return escapeStructuralLines(message.summary);
		case "bashExecution":
			return escapeStructuralLines(`[command]\n${message.command}\n\n[output]\n${message.output}`);
		default:
			return escapeStructuralLines(canonicalJson(message));
	}
}

export function renderLiveContext(
	messages: AgentMessage[],
	revision: number,
	documentSeed: string,
): LiveContextDocument {
	if (!Number.isSafeInteger(revision) || revision < 0)
		throw new Error("Live context revision must be a nonnegative safe integer.");
	const nonce = documentId(revision, documentSeed);
	const baselineDigest = digestMessages(messages);
	let latestAssistant = messages.length;
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index].role === "assistant") {
			latestAssistant = index;
			break;
		}
	}
	const blocks = messages.map((source, index): LiveContextBlock => {
		const id = blockId(source, index);
		const role = isLiveContextNote(source) ? "notes" : source.role;
		// Unknown app/control roles are protected by default, including shell execution records.
		const protectedBlock =
			index >= latestAssistant ||
			(source.role !== "assistant" && source.role !== "toolResult" && !isLiveContextNote(source));
		return {
			index,
			id,
			role,
			protected: protectedBlock,
			header: `[[CTX_TURN document=${nonce} index=${index + 1} role=${role} id=${id} protected=${protectedBlock}]]`,
			body: renderMessage(source, id, nonce),
			source,
		};
	});
	return {
		text: [
			`[[LIVE_CONTEXT version=${DOCUMENT_VERSION} revision=${revision} document=${nonce} baseline=${baselineDigest}]]`,
			INSTRUCTIONS,
			...blocks.map((block) => `${block.header}\n${block.body}`),
		].join("\n\n"),
		messages: [...messages],
		revision,
		version: DOCUMENT_VERSION,
		documentId: nonce,
		baselineDigest,
		blocks,
	};
}

/** A bounded inspection entry point. The full transcript must not be echoed just to locate editable text. */
export function renderLiveContextIndex(document: LiveContextDocument, path: string): string {
	const headerLines = new Map(document.text.split("\n").map((line, index) => [line, index + 1]));
	const candidates = document.blocks.filter(isEditableLiveContextBlock);
	const largest = [...candidates].sort((a, b) => b.body.length - a.body.length).slice(0, 32);
	const escapedPath = JSON.stringify(path);
	const location =
		escapedPath.length <= 1024
			? escapedPath
			: "LIVE_CONTEXT.md next to this index (full path is in the working-context instructions)";
	const lines = [
		"# Working context index (read-only)",
		`Editable file: ${location}`,
		`Revision: ${document.revision}; document: ${document.documentId}`,
		`Total messages: ${document.blocks.length}; editable plain-text blocks: ${candidates.length}.`,
		"This index lists the largest editable text bodies. Other blocks, including user/control text and current tool groups, must stay intact.",
		"Use the IDs below to select bodies. Read the full file locally and perform one read-modify-write operation in the same tool call; do not print the full file or copy it into a tool result.",
		"Keep the current metadata and every retained header unchanged. Replace selected text bodies with concise findings; preserve exact errors, decisions and useful values. Preview text is only a locator, not a complete summary.",
		"Read only a small selected body range if you need evidence beyond the conversation already in context.",
		"",
	];
	let length = lines.join("\n").length;
	for (const block of largest) {
		const preview = block.body.replace(/\s+/g, " ").slice(0, 96);
		const line = `- id=${block.id} role=${block.role} chars=${block.body.length}; body starts at line ${(headerLines.get(block.header) ?? 0) + 1}, ${block.body.split("\n").length} lines; preview=${JSON.stringify(preview)}`;
		if (length + line.length + 1 > 5900) break;
		lines.push(line);
		length += line.length + 1;
	}
	if (candidates.length === 0) lines.push("No editable plain-text bodies. No context edit is needed.");
	return lines.join("\n");
}

export interface LiveContextReplacement {
	id: string;
	text: string;
}

/** Shared by the index, automatic budget gate, and request-local edit validator. */
export function isEditableLiveContextBlock(block: LiveContextBlock): boolean {
	if (block.protected || immutableAssistant(block.source) || !("content" in block.source)) return false;
	const content = block.source.content;
	return typeof content === "string" || (content.length === 1 && content[0].type === "text");
}

/** Request-local tool output becomes a draft through the same protected document validator. */
export function replaceLiveContextBodies(
	snapshot: LiveContextDocument,
	replacements: unknown,
): { text: string } | { reason: string } {
	if (!Array.isArray(replacements) || replacements.length === 0 || replacements.length > 32)
		return { reason: "Select between one and 32 old plain-text blocks." };
	const byId = new Map(snapshot.blocks.map((block) => [block.id, block]));
	const edits = new Map<string, string>();
	for (const replacement of replacements) {
		if (
			!replacement ||
			typeof replacement !== "object" ||
			typeof replacement.id !== "string" ||
			typeof replacement.text !== "string"
		)
			return { reason: "Each replacement needs a current block id and text." };
		const block = byId.get(replacement.id);
		if (!block || !isEditableLiveContextBlock(block))
			return { reason: `Block ${replacement.id} is unknown, protected, or immutable.` };
		if (edits.has(replacement.id)) return { reason: `Duplicate replacement ${replacement.id}.` };
		edits.set(replacement.id, escapeStructuralLines(replacement.text));
	}
	const firstHeader = snapshot.blocks[0]?.header;
	if (!firstHeader) return { reason: "No context blocks to edit." };
	const preamble = snapshot.text.slice(0, snapshot.text.indexOf(firstHeader));
	return {
		text:
			preamble +
			snapshot.blocks.map((block) => `${block.header}\n${edits.get(block.id) ?? block.body}`).join("\n\n"),
	};
}

function immutableAssistant(message: AgentMessage): boolean {
	if (message.role !== "assistant") return false;
	if (message.content.some((part) => part.type !== "text")) return true;
	// Preserve replay data on legacy/provider-extended assistant records as well.
	const record = message as unknown as Record<string, unknown>;
	return ["tool_calls", "reasoning", "reasoning_content", "thinking", "thinkingSignature"].some(
		(key) => record[key] !== undefined && record[key] !== null,
	);
}

/** Replace text only; all message metadata and all non-text blocks stay with their original objects. */
function editedContent(
	content: string | ContentPart[],
	body: string,
	block: LiveContextBlock,
	nonce: string,
): { content: string | (TextContent | ImageContent)[] } | { reason: string } {
	const markers = [...body.matchAll(/^[ \t]*\[\[(?:CTX_TEXT|CTX_IMAGE)(?=[\s\]]|$).*$/gm)];
	if (typeof content === "string" || content.length === 0 || (content.length === 1 && content[0].type === "text")) {
		if (markers.length > 0)
			return {
				reason: `Unexpected image/content placeholder in ${block.id}. Escape quoted markers with a backslash.`,
			};
		const text = unescapeStructuralLines(body);
		if (typeof content === "string") return { content: text };
		return { content: [{ ...content[0], type: "text", text }] };
	}
	if (content.some((part) => part.type !== "text" && part.type !== "image")) {
		return { reason: `Content in ${block.id} is immutable; only existing text blocks can be edited.` };
	}
	const parts = content as (TextContent | ImageContent)[];
	if (
		markers.length !== parts.length ||
		markers[0]?.index !== 0 ||
		markers.some((marker, index) => marker[0] !== contentMarker(parts[index], index, block.id, nonce))
	) {
		return {
			reason: `Image placeholders/content markers in ${block.id} were changed, removed, duplicated, or reordered. Restore every marker verbatim.`,
		};
	}
	const nextParts: (TextContent | ImageContent)[] = [];
	for (const [index, part] of parts.entries()) {
		const marker = markers[index];
		const next = markers[index + 1];
		let section = body.slice(marker.index + marker[0].length, next?.index ?? body.length);
		if (next) section = section.slice(0, -1); // Exactly one newline separates content parts.
		if (part.type === "image") {
			if (section !== "") return { reason: `Image placeholder in ${block.id} cannot be edited or given a body.` };
			nextParts.push(part);
		} else {
			if (!section.startsWith("\n"))
				return { reason: `Missing newline after the text content marker in ${block.id}.` };
			const text = unescapeStructuralLines(section.slice(1));
			nextParts.push(text === part.text ? part : { ...part, text });
		}
	}
	return { content: nextParts };
}

/** Match parallel calls by ID and name, never by result count or call order. */
function toolGroups(origins: MessageOrigin[]): { groups: number[][] } | { reason: string } {
	const groups: number[][] = [];
	const pending = new Map<string, string>();
	let group: number[] = [];
	for (const [index, origin] of origins.entries()) {
		const message = origin.message;
		if (message.role === "assistant") {
			if (pending.size > 0)
				return {
					reason: `Incomplete tool group before assistant: missing results for ${[...pending.keys()].join(", ")}.`,
				};
			// Failed streams never execute their partial calls and are skipped in provider replay.
			// Ignore those calls only; real results still require a successful caller.
			if (message.stopReason === "error" || message.stopReason === "aborted") continue;
			for (const part of message.content) {
				if (part.type !== "toolCall") continue;
				if (!part.id || pending.has(part.id))
					return { reason: `Duplicate or empty tool call ID ${part.id} in an assistant.` };
				pending.set(part.id, part.name);
			}
			if (pending.size > 0) group = [index];
		} else if (message.role === "toolResult") {
			if (!pending.has(message.toolCallId))
				return {
					reason: `Orphan or duplicate tool result ${message.toolCallId}; retain exactly one result for each original call.`,
				};
			if (pending.get(message.toolCallId) !== message.toolName)
				return {
					reason: `Tool result ${message.toolCallId} has tool name ${message.toolName}; expected ${pending.get(message.toolCallId)}.`,
				};
			pending.delete(message.toolCallId);
			group.push(index);
			if (pending.size === 0) groups.push(group);
		} else if (pending.size > 0 && origin.sourceIndex === undefined) {
			return {
				reason: `A new note interrupts a tool call/result group. Place it before the assistant or after all results (${[...pending.keys()].join(", ")}).`,
			};
		}
	}
	if (pending.size > 0)
		return {
			reason: `Incomplete tool group: missing results for ${[...pending.keys()].join(", ")}. Keep or delete the complete old group.`,
		};
	return { groups };
}

export function applyLiveContext(text: string, snapshot: LiveContextDocument): ApplyLiveContextResult {
	const identityIndexes = snapshot.messages.map((_, index) => index);
	const reject = (reason: string): ApplyLiveContextResult => ({
		accepted: false,
		changed: false,
		messages: [...snapshot.messages],
		sourceIndexes: identityIndexes,
		reason,
		diff: "",
	});
	if (digestMessages(snapshot.messages) !== snapshot.baselineDigest) {
		return reject(
			"The snapshot baseline has changed since rendering. Render and read the current live context before editing.",
		);
	}
	const parsed = parseDocument(text);
	if ("reason" in parsed) return reject(parsed.reason);
	const document = parsed.document;
	if (
		document.version !== snapshot.version ||
		document.revision !== snapshot.revision ||
		document.documentId !== snapshot.documentId ||
		document.baselineDigest !== snapshot.baselineDigest
	) {
		return reject(
			`Stale live context metadata: expected revision ${snapshot.revision}, document ${snapshot.documentId}, baseline ${snapshot.baselineDigest}. Read the current document and reapply the edit.`,
		);
	}
	if (document.preamble !== INSTRUCTIONS)
		return reject(
			"Text outside CTX_TURN blocks or modified document instructions. Restore the preamble; add text using role=notes id=new-* blocks.",
		);
	if (document.blocks.length === 0 && snapshot.messages.length > 0)
		return reject(
			"Empty context document: retain protected CTX_TURN blocks; a headerless summary cannot replace the conversation.",
		);

	const sourceById = new Map(snapshot.blocks.map((block) => [block.id, block]));
	const retained = new Set<number>();
	let previousIndex = -1;
	for (const block of document.blocks) {
		const source = sourceById.get(block.id);
		if (!source) {
			if (!/^new-[a-zA-Z0-9-]+$/.test(block.id))
				return reject(
					`Unknown block ID ${block.id}. Use current IDs, or role=notes with a unique id=new-* for a new note.`,
				);
			if (block.role !== "notes" || block.protected)
				return reject(
					`New block ${block.id} must use role=notes and protected=false; user, system, assistant, and tool roles cannot be synthesized.`,
				);
			continue;
		}
		if (block.role !== source.role || block.index !== source.index || block.protected !== source.protected)
			return reject(`Header for ${source.id} was changed. Preserve its role, index, and protected flag exactly.`);
		if (source.index <= previousIndex)
			return reject(
				`Retained block ${source.id} is out of order. Preserve the original order of all existing messages, including protected turns.`,
			);
		previousIndex = source.index;
		retained.add(source.index);
		if (source.protected && block.body !== source.body)
			return reject(`Protected ${source.role} block ${source.id} cannot be changed. Restore its original body.`);
	}
	for (const source of snapshot.blocks) {
		if (source.protected && !retained.has(source.index))
			return reject(`Protected ${source.role} block ${source.id} cannot be removed. Restore the complete block.`);
	}

	const baselineGroups = toolGroups(snapshot.messages.map((message, sourceIndex) => ({ message, sourceIndex })));
	if ("reason" in baselineGroups) return reject(baselineGroups.reason);
	for (const group of baselineGroups.groups) {
		const kept = group.filter((index) => retained.has(index)).length;
		if (kept !== 0 && kept !== group.length)
			return reject(
				`Partial tool group deletion at ${snapshot.blocks[group[0]].id}. Keep the assistant and every result, or delete the complete old group.`,
			);
	}

	const candidate: MessageOrigin[] = [];
	for (const block of document.blocks) {
		const source = sourceById.get(block.id);
		if (!source) {
			if (!block.body.trim()) return reject(`New note ${block.id} is empty. Add text or remove the block.`);
			if (/^[ \t]*\[\[(?:CTX_TEXT|CTX_IMAGE)(?=[\s\]]|$)/m.test(block.body))
				return reject(
					`New note ${block.id} contains an image/content placeholder. Escape quoted markers; images cannot be synthesized.`,
				);
			const message: CustomMessage = {
				role: "custom",
				customType: "live-context-note",
				display: false,
				content: unescapeStructuralLines(block.body),
				// Deterministic provenance time; applying a document never reads a clock.
				timestamp: snapshot.messages.at(-1)?.timestamp ?? 0,
			};
			candidate.push({ message });
		} else if (block.body === source.body) {
			candidate.push({ message: source.source, sourceIndex: source.index });
		} else {
			const message = source.source;
			if (immutableAssistant(message))
				return reject(
					`Assistant block ${source.id} contains immutable tool calls or reasoning. Keep it intact or delete its complete old group.`,
				);
			if (message.role !== "assistant" && message.role !== "toolResult" && !isLiveContextNote(message))
				return reject(`Protected block ${source.id} cannot be rewritten.`);
			if (!("content" in message)) return reject(`Block ${source.id} has no editable text content.`);
			const edited = editedContent(message.content, block.body, source, snapshot.documentId);
			if ("reason" in edited) return reject(edited.reason);
			// The role checks above constrain this to an assistant, real tool result, or our own note.
			candidate.push({
				message: { ...message, content: edited.content } as AgentMessage,
				sourceIndex: source.index,
			});
		}
	}
	const validatedGroups = toolGroups(candidate);
	if ("reason" in validatedGroups) return reject(validatedGroups.reason);
	const messages = candidate.map(({ message }) => message);
	const changed = digestMessages(messages) !== snapshot.baselineDigest;
	return {
		accepted: true,
		changed,
		messages: changed ? messages : [...snapshot.messages],
		sourceIndexes: changed ? candidate.map(({ sourceIndex }) => sourceIndex ?? null) : identityIndexes,
		diff: changed
			? createTwoFilesPatch("LIVE_CONTEXT.md", "LIVE_CONTEXT.md", snapshot.text, text, undefined, undefined, {
					context: 3,
				})
			: "",
	};
}
