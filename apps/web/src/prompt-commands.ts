/**
 * Prompt commands: `/<name> args` lines the kernel expands from a prompt
 * template (a plugin's `commands/*.md`, the user's or the project's prompt
 * folders) before the model sees them.
 *
 * The kernel journals only the expansion, so a transcript would show a whole
 * template where the user typed one line. The host keeps that line beside the
 * transcript instead of changing what the model receives: before sending, it
 * expands the text the way the kernel will and appends a presentation-only
 * custom entry `{ text, digest }`. A later user message whose text has that
 * digest is the expansion of that line. Matching by content, not position,
 * keeps steered and queued messages (delivered after other entries) paired.
 */

import { createHash } from "node:crypto";
import { expandPromptTemplate, type PromptTemplate, type SessionEntry } from "@step-harness/coding-agent";

/** The custom entry recording one prompt-command line; never model context. */
export const PROMPT_COMMAND_TYPE = "stepcode-web.prompt-command";

/** A prompt command the composer offers as `/<name> `; the kernel expands it on send. */
export interface WebPromptCommand {
	readonly name: string;
	readonly description: string;
	/** What the template expects after its name, from its `argument-hint` frontmatter. */
	readonly argumentHint?: string;
}

/** What `recordPromptCommand` journals: the typed line and the digest of its expansion. */
export interface PromptCommandRecord {
	readonly text: string;
	readonly digest: string;
}

/** Digest of a user message's text; only equality matters. */
export function promptDigest(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

/**
 * The templates a composer can run, by name. A template named like a command
 * that runs first in the kernel (`isReserved`: an extension command, a Web
 * surface) would never expand, so it is not offered.
 */
export function webPromptCommands(
	templates: ReadonlyArray<Pick<PromptTemplate, "name" | "description" | "argumentHint">>,
	isReserved: (name: string) => boolean,
): WebPromptCommand[] {
	const seen = new Set<string>();
	const commands: WebPromptCommand[] = [];
	for (const template of templates) {
		if (!template.name || template.name.startsWith("skill:") || isReserved(template.name)) continue;
		// The kernel resolves the first template of a name; later ones never run.
		if (seen.has(template.name)) continue;
		seen.add(template.name);
		commands.push({
			name: template.name,
			description: template.description,
			...(template.argumentHint ? { argumentHint: template.argumentHint } : {}),
		});
	}
	return commands.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * The record for a prompt that is a prompt command, or null. `typed` is what
 * the user wrote (shown in the transcript); `sent` is the exact text handed to
 * the kernel (with attachments folded in), whose expansion becomes the message.
 */
export function promptCommandRecord(
	typed: string,
	sent: string,
	templates: readonly PromptTemplate[],
): PromptCommandRecord | null {
	if (!typed.startsWith("/") || typed.startsWith("/skill:")) return null;
	const expanded = expandPromptTemplate(sent, [...templates]);
	if (expanded === sent) return null;
	return { text: typed.trimEnd(), digest: promptDigest(expanded) };
}

/** The text the kernel journals for a prompt: its first text block. */
export function promptMessageText(message: unknown): string | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const { role, content } = message as { role?: unknown; content?: unknown };
	if (role !== "user") return undefined;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const first = content.find(
		(part): part is { type: "text"; text: string } =>
			typeof part === "object" && part !== null && part.type === "text" && typeof part.text === "string",
	);
	return first?.text;
}

/** A validated record from a prompt-command custom entry, or undefined for every other entry. */
export function promptCommandOf(entry: SessionEntry): PromptCommandRecord | undefined {
	if (entry.type !== "custom" || entry.customType !== PROMPT_COMMAND_TYPE) return undefined;
	const data = entry.data as { text?: unknown; digest?: unknown } | undefined;
	return typeof data?.text === "string" && data.text && typeof data.digest === "string" && data.digest
		? { text: data.text, digest: data.digest }
		: undefined;
}

/**
 * Pair each recorded line with the first later user message whose text has
 * its digest: entry id of the message -> the line the user typed. A record
 * whose message never came (the kernel ran an extension command, the send
 * failed) pairs with nothing.
 */
export function pairPromptCommands(entries: readonly SessionEntry[]): Map<string, string> {
	const pairs = new Map<string, string>();
	const waiting = new Map<string, string[]>();
	for (const entry of entries) {
		const record = promptCommandOf(entry);
		if (record) {
			const lines = waiting.get(record.digest);
			if (lines) lines.push(record.text);
			else waiting.set(record.digest, [record.text]);
			continue;
		}
		if (waiting.size === 0 || entry.type !== "message") continue;
		const text = promptMessageText(entry.message);
		if (text === undefined) continue;
		const digest = promptDigest(text);
		const lines = waiting.get(digest);
		const line = lines?.shift();
		if (line === undefined) continue;
		if (!lines?.length) waiting.delete(digest);
		pairs.set(entry.id, line);
	}
	return pairs;
}

/**
 * Lines sent but not yet seen as a user message, for the live `message_start`
 * event (the snapshot pairs from the journal). Bounded: a record whose message
 * never arrives must not grow the session's memory.
 */
export class LivePromptCommands {
	private readonly pending: PromptCommandRecord[] = [];
	private static readonly LIMIT = 32;

	add(record: PromptCommandRecord): void {
		this.pending.push(record);
		if (this.pending.length > LivePromptCommands.LIMIT) this.pending.shift();
	}

	/** The line whose expansion is `text`, consumed; undefined when none was sent. */
	take(text: string): string | undefined {
		if (this.pending.length === 0) return undefined;
		const digest = promptDigest(text);
		const index = this.pending.findIndex((record) => record.digest === digest);
		if (index < 0) return undefined;
		return this.pending.splice(index, 1)[0]?.text;
	}
}
