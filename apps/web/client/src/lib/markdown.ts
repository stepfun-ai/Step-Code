/**
 * Text helpers around Markdown: HTML escaping for the non-Markdown views that
 * build markup, message text extraction, file-reference recognition and the
 * invocation forms a user message can take. Rendering lives in ui/MarkdownView.
 */

import type { Nodes, PhrasingContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { localFileReference } from "./file-references";

const HTML_ESCAPES: Readonly<Record<string, string>> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

export function escapeHtml(value: unknown): string {
	return String(value).replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

/** Text of a message `content` value: a string, or the text parts of a content array. */
export function contentText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value
		.filter((part): part is { type: "text"; text: string } => part?.type === "text")
		.map((part) => part.text)
		.join("");
}

export interface MarkdownFileReference {
	/** The destination as written in the Markdown; `localFileReference` decodes it. */
	readonly path: string;
	readonly label: string;
	readonly inlineCode: boolean;
}

const MAX_REFERENCE_SOURCE = 200_000;
const MAX_REFERENCES = 128;

function textContent(nodes: readonly PhrasingContent[]): string {
	return nodes
		.map((node) => ("value" in node ? node.value : "children" in node ? textContent(node.children) : ""))
		.join("");
}

/**
 * Local file references a reply names, in reading order: link and image
 * destinations (inline or by reference) and inline code spans that read as a
 * path. Code blocks are excluded. Parses with the same GFM grammar as the renderer.
 */
export function markdownFileReferences(text: string): MarkdownFileReference[] {
	if (text.length > MAX_REFERENCE_SOURCE) return [];
	const tree = fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
	const definitions = new Map<string, string>();
	const collectDefinitions = (node: Nodes): void => {
		if (node.type === "definition") definitions.set(node.identifier, node.url);
		else if ("children" in node) for (const child of node.children) collectDefinitions(child);
	};
	collectDefinitions(tree);
	const references: MarkdownFileReference[] = [];
	const add = (path: string | undefined, label: string, inlineCode: boolean): void => {
		if (path && references.length < MAX_REFERENCES && localFileReference(path)) {
			references.push({ path, label, inlineCode });
		}
	};
	const visit = (node: Nodes): void => {
		switch (node.type) {
			case "code":
				return;
			case "inlineCode":
				add(node.value, node.value, true);
				return;
			case "link":
				add(node.url, textContent(node.children), false);
				return;
			case "linkReference":
				add(definitions.get(node.identifier), textContent(node.children), false);
				return;
			case "image":
				add(node.url, node.alt ?? node.url, false);
				return;
			case "imageReference":
				add(definitions.get(node.identifier), node.alt ?? "", false);
				return;
			default:
				if ("children" in node) for (const child of node.children) visit(child);
		}
	};
	visit(tree);
	return references;
}

/** A user message that invoked a skill: the skill's name and what the user asked with it. */
export interface SkillInvocation {
	readonly name: string;
	readonly request: string;
}

/**
 * The kernel replaces `/skill:<name> request` with the skill's instructions in
 * a `<skill name location>` block followed by the request (coding-agent
 * `parseSkillBlock`); a message not yet sent still has the slash form.
 */
export function skillInvocation(text: string): SkillInvocation | null {
	const block = /^<skill name="([^"]+)" location="[^"]+">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/.exec(text);
	if (block) return { name: block[1], request: block[2]?.trim() ?? "" };
	const command = /^\/skill:(\S+)(?:\s+([\s\S]*))?$/.exec(text);
	return command ? { name: command[1], request: command[2]?.trim() ?? "" } : null;
}

/** A quoted other-session context: the source session's name and its capped transcript. */
export interface SessionContextQuote {
	readonly title: string;
	readonly transcript: string;
}

/**
 * A quoted other-session context (`packageSessionContext`) rides at the tail of
 * the message it was sent with: a heading naming the source session followed by
 * a fenced transcript. Split it off so the bubble shows the user's own words
 * and the quote collapses into one row.
 */
export function sessionContextOf(text: string): { readonly body: string; readonly quote: SessionContextQuote } | null {
	const match = /\n*# 引用会话「([^」]+)」的上下文\n```session-context\n([\s\S]*?)\n```[ \t]*$/.exec(text);
	if (!match) return null;
	return {
		body: text.slice(0, match.index).trim(),
		quote: { title: match[1], transcript: match[2] },
	};
}

/**
 * A user message that opted its turn into the ultraloop workflow through the
 * keyword form (`ultracode: request`): the request the user typed after it.
 */
export function ultraloopInvocation(text: string): { readonly request: string } | null {
	const match = /^ultracode:[ \t]*([\s\S]+)$/.exec(text);
	return match ? { request: match[1].trim() } : null;
}

/** A plugin install sent from the composer's pick chip: `/plugin install <name>`. */
export function pluginInstallInvocation(text: string): SkillInvocation | null {
	const command = /^\/plugin install (\S+)(?:\s+([\s\S]*))?$/.exec(text);
	return command ? { name: command[1], request: command[2]?.trim() ?? "" } : null;
}
