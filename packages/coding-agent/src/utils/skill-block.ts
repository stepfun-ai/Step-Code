import { createHash } from "node:crypto";
import type { SkillInvocation } from "@step-harness/providers";

/** Parsed skill block from a user message */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
	/** Whether the block declared `encoding="xml"`; its fields are already decoded. */
	encoded: boolean;
}

/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 *
 * A block marked ` encoding="xml"` has its name, location and body decoded once
 * from the four entities its writer escapes (`&amp;`, `&lt;`, `&gt;`, `&quot;`).
 * Unmarked blocks keep their literal text.
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const match = text.match(
		/^<skill name="([^"]+)" location="([^"]+)"( encoding="xml")?>\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/,
	);
	if (!match) return null;
	const encoded = match[3] !== undefined;
	const decode = (value: string) =>
		encoded
			? value.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")
			: value;
	return {
		name: decode(match[1]),
		location: decode(match[2]),
		content: decode(match[4]),
		userMessage: match[5]?.trim() || undefined,
		encoded,
	};
}

/**
 * Most skills one message may load. A prompt that names more keeps the extra
 * commands as text, and the catalog in the system prompt still lists those
 * skills, so the model can read them when the task needs them.
 */
export const MAX_SKILL_COMMANDS = 5;

/** A `/skill:<name>` command at the start of the text, with the separator that completes it. */
const LEADING_SKILL_COMMAND = /^\/skill:([^\s/]+)(\s+|$)/u;

export interface LeadingSkillCommands {
	/** Skill names to load, in the order the user named them, without repeats. */
	names: string[];
	/** Names that appeared again after their first command; they load once. */
	duplicates: string[];
	/** Names past {@link MAX_SKILL_COMMANDS}; they stay in the text. */
	overflow: string[];
	/** The request, with commands that stay as text kept ahead of it. */
	rest: string;
}

/**
 * Read the `/skill:<name>` commands that lead `text`.
 *
 * Only the commands before any other word count: a `/skill:` further into the
 * sentence is prose the user wrote. Every command this function reads is
 * removed from `rest`; a command it declines to load (a repeat, or one past the
 * cap) is put back in front of `rest` verbatim so no typed word disappears.
 */
export function takeLeadingSkillCommands(text: string): LeadingSkillCommands {
	const names: string[] = [];
	const duplicates: string[] = [];
	const overflow: string[] = [];
	const kept: string[] = [];
	let rest = text;
	for (;;) {
		const match = LEADING_SKILL_COMMAND.exec(rest);
		if (!match) break;
		const name = match[1] ?? "";
		// The separator the user wrote stays with a command this call declines, so
		// nothing they typed moves or changes shape.
		const separator = match[2] ?? "";
		rest = rest.slice(match[0].length);
		if (names.includes(name)) {
			duplicates.push(name);
			kept.push(`/skill:${name}${separator}`);
			continue;
		}
		if (names.length >= MAX_SKILL_COMMANDS) {
			overflow.push(name);
			kept.push(`/skill:${name}${separator}`);
			continue;
		}
		names.push(name);
	}
	return { names, duplicates, overflow, rest: `${kept.join("")}${rest}` };
}

/** One skill whose instructions a message carries. */
export interface SkillInstructionsInput {
	name: string;
	/** Absolute path of the skill file, as the model should cite it. */
	location: string;
	/** Directory relative references resolve against. */
	baseDir: string;
	/** Instruction body, already stripped of frontmatter. */
	body: string;
}

export interface RenderedSkillInstructions {
	/**
	 * The text recorded on the message: instructions, then the request. This is
	 * the bytes the model reads, and they never change after this call.
	 */
	text: string;
	/** Where each instruction body sits inside `text`. */
	skills: SkillInvocation[];
}

/** SHA-256 of an instruction body, so a later change to the skill file is detectable. */
export function skillBodyDigest(body: string): string {
	return createHash("sha256").update(body, "utf8").digest("hex");
}

/**
 * Render the leading skill instructions of one user message.
 *
 * The `<skill>` wrapper is deliberately unencoded here: an instruction body is
 * markdown that may contain `<`, `&`, and code fences, and escaping it would
 * change what the model reads. Readers that need the body use the returned
 * spans instead of re-parsing the wrapper, so an instruction body containing
 * `</skill>` cannot truncate a later reader's view.
 */
export function renderSkillInstructions(
	entries: readonly SkillInstructionsInput[],
	request: string,
): RenderedSkillInstructions {
	const parts: string[] = [];
	const skills: SkillInvocation[] = [];
	let length = 0;
	for (const entry of entries) {
		if (parts.length > 0) {
			parts.push("\n\n");
			length += 2;
		}
		const header = `<skill name="${entry.name}" location="${entry.location}">\n`;
		parts.push(header);
		length += header.length;
		// The span covers the whole block body, references line included, so it reads
		// exactly like the `content` a legacy block parse returns.
		const start = length;
		const content = `References are relative to ${entry.baseDir}.\n\n${entry.body}`;
		parts.push(content);
		length += content.length;
		parts.push("\n</skill>");
		length += "\n</skill>".length;
		skills.push({
			name: entry.name,
			location: entry.location,
			start,
			end: length - "\n</skill>".length,
			digest: skillBodyDigest(content),
		});
	}
	const trimmed = request.trim();
	if (trimmed) parts.push(parts.length > 0 ? `\n\n${trimmed}` : trimmed);
	return { text: parts.join(""), skills };
}

/** The instructions one recorded skill contributed, sliced from its message text. */
export function skillInstructionBody(text: string, skill: SkillInvocation): string {
	return text.slice(skill.start, skill.end);
}

/** Text and double-quoted XML attributes share the same escaping. */
function escapeXml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/**
 * Leading instruction blocks for a message the host assembles itself, such as a
 * goal continuation or a scheduled execution.
 *
 * These blocks declare `encoding="xml"` and escape their text, so a body that
 * contains `<skill>` or `</skill>` can never be mistaken for another block. The
 * marker is also what lets instruction retention read several blocks from one
 * message: only an encoded block chains into the text after it, because text
 * after an unencoded block is the user's own.
 */
export function renderLeadingSkillBlocks(entries: readonly SkillInstructionsInput[]): string {
	return entries
		.map(
			(entry) =>
				`<skill name="${escapeXml(entry.name)}" location="${escapeXml(entry.location)}" encoding="xml">\nReferences are relative to ${escapeXml(entry.baseDir)}.\n\n${escapeXml(entry.body)}\n</skill>`,
		)
		.join("\n\n");
}

export interface MessageSkillInvocations {
	/** Instruction bodies the message carried, in the order it loaded them. */
	skills: SkillInstructionView[];
	/** What the user asked after the instructions; absent when the message carried only skills. */
	request: string | undefined;
}

/** One skill instruction a transcript row renders. */
export interface SkillInstructionView {
	name: string;
	content: string;
}

/**
 * The skill instructions a user message shows, from its structured spans when
 * it has them and from its legacy `<skill>` wrapper otherwise. Null when the
 * message carries no skill instructions.
 */
export function messageSkillInvocations(
	text: string,
	skills?: readonly SkillInvocation[],
): MessageSkillInvocations | null {
	if (skills?.length) {
		// The request starts after the closing marker of the last recorded body, so a
		// request that itself contains `</skill>` is not truncated.
		const closeAt = text.indexOf("</skill>", skills[skills.length - 1]!.end);
		const request = (closeAt === -1 ? text : text.slice(closeAt + "</skill>".length)).trim();
		return {
			skills: skills.map((skill) => ({ name: skill.name, content: skillInstructionBody(text, skill) })),
			request: request || undefined,
		};
	}
	const block = parseSkillBlock(text);
	return block ? { skills: [{ name: block.name, content: block.content }], request: block.userMessage } : null;
}
