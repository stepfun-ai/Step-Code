import { dirname } from "node:path";
import { contentText, type Message, type ToolResultMessage } from "@step-harness/providers";
import { resolvePath } from "../../utils/paths.ts";
import { parseSkillBlock } from "../../utils/skill-block.ts";

/** Instructions actually loaded in a conversation, including partial reads. */
export interface SkillInstruction {
	location: string;
	content: string;
	/** Read range, omitted for full-file reads and explicit invocations. */
	range?: string;
}

export interface SkillInstructionContext {
	cwd?: string;
	/** Includes single-file skills whose filename is not SKILL.md. */
	skills?: readonly { filePath: string }[];
}

interface SkillRead {
	location: string;
	toolName: string;
	range?: string;
}

/** Identify read results by their call IDs, not by text that resembles a skill. */
export function collectSkillReadResults(
	messages: readonly Message[],
	context: SkillInstructionContext = {},
): Map<ToolResultMessage, SkillRead> {
	const knownPaths = new Set(context.skills?.map((skill) => resolvePath(skill.filePath, context.cwd)));
	const pending = new Map<string, SkillRead>();
	const reads = new Map<ToolResultMessage, SkillRead>();
	for (const message of messages) {
		if (message.role === "toolResult") {
			const call = pending.get(message.toolCallId);
			pending.delete(message.toolCallId);
			if (call && call.toolName === message.toolName && !message.isError) reads.set(message, call);
			continue;
		}
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const call of message.content) {
			if (call.type !== "toolCall") continue;
			pending.delete(call.id);
			if (call.name !== "read" && call.name !== "read_file") continue;
			const path = call.arguments?.path;
			if (typeof path !== "string") continue;
			const location = resolvePath(path, context.cwd);
			if (!/(?:^|[/\\])SKILL\.md$/.test(path) && !knownPaths.has(location)) continue;
			const { offset, limit, start_line, end_line } = call.arguments;
			const start = offset ?? start_line ?? 1;
			const range =
				start <= 1 && limit === undefined && end_line === undefined
					? undefined
					: JSON.stringify({ offset, limit, start_line, end_line });
			pending.set(call.id, { location, toolName: call.name, ...(range ? { range } : {}) });
		}
	}
	return reads;
}

/** Read optional metadata from older or extension-written session files safely. */
export function readSavedSkillInstructions(details: unknown): SkillInstruction[] {
	if (
		!details ||
		typeof details !== "object" ||
		!("activeSkills" in details) ||
		!Array.isArray(details.activeSkills)
	) {
		return [];
	}
	return details.activeSkills.filter(
		(value): value is SkillInstruction =>
			value !== null &&
			typeof value === "object" &&
			typeof value.location === "string" &&
			typeof value.content === "string" &&
			(value.range === undefined || typeof value.range === "string"),
	);
}

/** Preserve loaded content without reading any additional files from disk. */
export function collectSkillInstructions(
	messages: readonly Message[],
	previous: readonly SkillInstruction[] = [],
	context: SkillInstructionContext = {},
): SkillInstruction[] {
	const key = (skill: SkillInstruction) => JSON.stringify([skill.location, skill.range]);
	const instructions = new Map(previous.map((skill) => [key(skill), skill]));
	const reads = collectSkillReadResults(messages, context);
	const remember = (skill: SkillInstruction) => {
		// A fresh full read replaces old instructions, including any old ranges.
		if (!skill.range) {
			for (const [id, existing] of instructions) {
				if (existing.location === skill.location) instructions.delete(id);
			}
		}
		instructions.set(key(skill), skill);
	};

	for (const message of messages) {
		if (message.role === "user") {
			const block = parseSkillBlock(contentText(message.content, ""));
			if (block) remember({ location: resolvePath(block.location, context.cwd), content: block.content });
		} else if (message.role === "toolResult" && !message.isError) {
			const call = reads.get(message);
			if (!call || call.toolName !== message.toolName) continue;
			const content = contentText(message.content, "");
			if (!content) continue;
			remember({ location: call.location, content, ...(call.range ? { range: call.range } : {}) });
		}
	}
	return [...instructions.values()];
}

function escapeAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatSkillInstructions(skills: readonly SkillInstruction[]): string {
	if (skills.length === 0) return "";
	const blocks = skills.map(
		(skill) =>
			`<skill location="${escapeAttribute(skill.location)}"${skill.range ? ` range="${escapeAttribute(skill.range)}"` : ""}>\nReferences are relative to ${dirname(skill.location)}.\n\n${skill.content}\n</skill>`,
	);
	return `\n\n<active_skill_instructions>\nPreviously loaded skill instructions, preserved verbatim:\n\n${blocks.join("\n\n")}\n</active_skill_instructions>`;
}

/** Keep durable instructions outside the next model-generated summary. */
export function stripSkillInstructions(summary: string, skills: readonly SkillInstruction[]): string {
	const suffix = formatSkillInstructions(skills);
	return suffix && summary.endsWith(suffix) ? summary.slice(0, -suffix.length) : summary;
}
