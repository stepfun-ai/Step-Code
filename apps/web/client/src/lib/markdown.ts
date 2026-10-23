/**
 * Minimal Markdown renderer and text helpers (legacy app.js `escapeHtml`,
 * `contentText`, `renderMarkdown`).
 *
 * The renderer is deliberately tiny: fenced code blocks, `#`/`##`/`###`
 * headings, `-` / `*` bullets, GFM pipe tables, links, `**bold**`, inline code,
 * line breaks and paragraph gaps. Everything else is
 * escaped. Its output is an HTML string meant for `dangerouslySetInnerHTML`
 * (see ui/MarkdownView, which also wires the `.copy-code` buttons).
 */

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

export interface MarkdownLabels {
	/** Header label of a fenced block without a language (legacy `t("code")`). */
	readonly code: string;
	/** Text of the copy button in each code block header (legacy `t("copy")`). */
	readonly copy: string;
	/** Accessible name of a horizontally scrollable Markdown table. */
	readonly table: string;
}

export interface MarkdownFileReference {
	readonly path: string;
	readonly label: string;
	readonly inlineCode: boolean;
}

export interface MarkdownOptions {
	readonly localFiles?: boolean;
	readonly onFileReference?: (reference: MarkdownFileReference) => void;
	/** Colours a fenced block; returns escaped HTML. Without it code is plain escaped text. */
	readonly highlightCode?: (code: string, language: string) => string;
}

function renderInline(value: string): string {
	return escapeHtml(value).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

/** Inline code/links are already protected; escaped pipes are cell content. */
function tableCells(line: string): string[] | null {
	if (/^(?: {4}|\t)/.test(line)) return null;
	const text = line.trim();
	const cells: string[] = [];
	let cell = "";
	let lastPipe = -1;
	for (let index = 0; index < text.length; index += 1) {
		const character = text[index];
		if (character === "\\" && (text[index + 1] === "\\" || text[index + 1] === "|")) {
			cell += text[index + 1] === "|" ? "|" : "\\\\";
			index += 1;
		} else if (character === "|") {
			cells.push(cell.trim());
			cell = "";
			lastPipe = index;
		} else {
			cell += character;
		}
	}
	if (lastPipe < 0) return null;
	cells.push(cell.trim());
	if (text.startsWith("|")) cells.shift();
	if (lastPipe === text.length - 1) cells.pop();
	return cells.length ? cells : null;
}

/** Tables become protected block tokens before ordinary line-break formatting. */
function protectTables(source: string, blocks: string[], labels: MarkdownLabels): string {
	const lines = source.split("\n");
	const output: string[] = [];
	let fence: string | undefined;
	for (let index = 0; index < lines.length; index += 1) {
		// An unfinished fence must not turn its literal table example into a table.
		const marker = /^ {0,3}(`{3,}|~{3,})/.exec(lines[index])?.[1];
		if (marker) {
			if (!fence) fence = marker;
			else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
			output.push(lines[index]);
			continue;
		}
		const header = !fence ? tableCells(lines[index]) : null;
		const delimiter = header && index + 1 < lines.length ? tableCells(lines[index + 1]) : null;
		if (
			!header ||
			!delimiter ||
			header.length !== delimiter.length ||
			!delimiter.every((cell) => /^:?-+:?$/.test(cell))
		) {
			output.push(lines[index]);
			continue;
		}
		const alignments = delimiter.map((cell) =>
			cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : "left",
		);
		const row = (cells: string[], heading: boolean) => {
			const tag = heading ? "th" : "td";
			return `<tr>${header
				.map(
					(_cell, column) =>
						`<${tag}${heading ? ' scope="col"' : ""} class="md-align-${alignments[column]}">${renderInline(cells[column] ?? "")}</${tag}>`,
				)
				.join("")}</tr>`;
		};
		index += 1;
		const rows: string[] = [];
		while (index + 1 < lines.length) {
			const next = lines[index + 1];
			if (/^\s*(?:#{1,6}\s|[-*+]\s|>\s|`{3,}|~{3,}|\u0000)/.test(next)) break;
			const cells = tableCells(next);
			if (!cells) break;
			rows.push(row(cells, false));
			index += 1;
		}
		const html = `<div class="md-table-scroll md-table-wrap" role="region" tabindex="0" aria-label="${escapeHtml(labels.table)}"><table class="md-table"><thead>${row(header, true)}</thead><tbody>${rows.join("")}</tbody></table></div>`;
		output.push(`\u0000${blocks.push(html) - 1}\u0000`);
	}
	return output.join("\n");
}

/** Local references are buttons, never browser navigation to a file URL. */
function renderLink(label: string, destination: string, options: MarkdownOptions): string {
	const local = localFileReference(destination);
	if (local) {
		options.onFileReference?.({ path: destination, label, inlineCode: false });
		if (options.localFiles)
			return `<button type="button" class="md-file-reference" data-file-path="${escapeHtml(destination)}">${escapeHtml(label)}</button>`;
		return escapeHtml(label);
	}
	try {
		const url = new URL(destination);
		if (["http:", "https:", "mailto:"].includes(url.protocol)) {
			return `<a href="${escapeHtml(destination)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
		}
	} catch {
		// Incomplete streaming links and invalid URLs remain readable text.
	}
	return escapeHtml(label);
}

export function renderMarkdown(value: unknown, labels: MarkdownLabels, options: MarkdownOptions = {}): string {
	const blocks: string[] = [];
	const inlines: string[] = [];
	const definitions = new Map<string, string>();
	const fenceHtml = (code: string, language: string): string =>
		options.highlightCode ? options.highlightCode(code, language.toLowerCase()) : escapeHtml(code);
	const source = String(value)
		.replace(/[\u0000\u0001]/g, "")
		.replace(/\r\n?/g, "\n")
		.replace(
			/^ {0,3}(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)(?:^ {0,3}\1[ \t]*(?:\n|$)|(?![\s\S]))/gm,
			(_match, _fence: string, language: string, code: string) => {
				const label = language.trim() || labels.code;
				const index =
					blocks.push(
						`<div class="code-block"><div class="code-block-header"><span>${escapeHtml(label)}</span><button class="copy-code" type="button">${escapeHtml(labels.copy)}</button></div><pre><code>${fenceHtml(code.replace(/\n$/, ""), language.trim().split(/\s+/)[0] ?? "")}</code></pre></div>`,
					) - 1;
				return `\u0000${index}\u0000`;
			},
		)
		.replace(
			/^ {0,3}\[([^\]\n]+)\]:[ \t]*(<[^<>\n]+>|\S+)[ \t]*$/gm,
			(_match, identifier: string, destination: string) => {
				definitions.set(identifier.toLowerCase(), destination.replace(/^<(.*)>$/, "$1"));
				return "";
			},
		);
	// Protect inline code and links before formatting so URL punctuation and HTML
	// attributes cannot be interpreted as Markdown. Fenced code is already protected.
	const inlineSource = source.replace(
		/`([^`]+)`|\[([^\]\n]+)\]\([ \t]*(<[^<>\n]+>|(?:[^\s()<>]|\([^()\n]*\))+)[ \t]*\)|\[([^\]\n]+)\]\[([^\]\n]*)\]|https?:\/\/[^\s<>\u0000\u0001\u0002，。、；：！？）」』】》]+/g,
		(
			match,
			code: string | undefined,
			label: string | undefined,
			destination: string | undefined,
			referenceLabel: string | undefined,
			identifier: string | undefined,
		) => {
			let html: string;
			let suffix = "";
			if (code !== undefined) {
				const local = localFileReference(code);
				if (local) options.onFileReference?.({ path: code, label: code, inlineCode: true });
				html = `<code>${escapeHtml(code)}</code>`;
			} else if (label !== undefined && destination !== undefined) {
				html = renderLink(label, destination.replace(/^<(.*)>$/, "$1"), options);
			} else if (referenceLabel !== undefined && identifier !== undefined) {
				const destination = definitions.get((identifier || referenceLabel).toLowerCase());
				html = destination ? renderLink(referenceLabel, destination, options) : escapeHtml(match);
			} else {
				let url = match.replace(/[.,!?;:，。！？；：、]+$/, "");
				// A CJK path segment is part of the address, but CJK after the query starts is the sentence
				// resuming (`?ref=main这个分支`): real query values arrive percent-encoded.
				const query = url.indexOf("?");
				const prose = query < 0 ? -1 : url.slice(query).search(/[\u3000-\u9fff\uff00-\uffef]/);
				if (prose > 0) url = url.slice(0, query + prose);
				while (url.endsWith(")") && url.split(")").length > url.split("(").length) url = url.slice(0, -1);
				suffix = match.slice(url.length);
				html = renderLink(url, url, options);
			}
			return `\u0001${inlines.push(html) - 1}\u0001${suffix}`;
		},
	);
	// Blockquotes are extracted after inline protection and rendered as their own
	// block: a quoted line is prose with inline formatting, not a stray ">".
	const quotes: string[] = [];
	const withoutQuotes = inlineSource.replace(/(?:^ {0,3}>[ \t]?.*(?:\n|$))+/gm, (block) => {
		const inner = block.replace(/^ {0,3}>[ \t]?/gm, "").replace(/\n+$/, "");
		return `\u0003${quotes.push(inner) - 1}\u0003`;
	});
	const html = renderInline(protectTables(withoutQuotes, blocks, labels).replace(/\n{3,}/g, "\n\n"))
		.replace(/^### (.+)$/gm, "<h4>$1</h4>")
		.replace(/^## (.+)$/gm, "<h3>$1</h3>")
		.replace(/^# (.+)$/gm, "<h2>$1</h2>")
		// A line of only -, * or _ is a rule, never a list item or emphasis.
		.replace(/^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/gm, "<hr>")
		// An indented item is nested; a numbered item keeps the number the model wrote.
		.replace(/^(\s{2,})[-*] (.+)$/gm, '<span class="md-li md-li-nested">$2</span>')
		.replace(
			/^([ \t]*)(\d+)\. (.+)$/gm,
			(_match, indent: string, number: string, body: string) =>
				`<span class="md-li md-oli${indent.length >= 2 ? " md-li-nested" : ""}" data-n="${number}">${body}</span>`,
		)
		.replace(/^[-*] (.+)$/gm, '<span class="md-li">$1</span>')
		// Headings and code blocks are blocks: the line breaks around them would only add empty lines.
		.replace(/\n*(<h[234]>.*?<\/h[234]>|<hr>|\u0000\d+\u0000)\n*/g, "$1")
		// List items are blocks too; only the line break after each one goes.
		.replace(/(<span class="md-li[^>]*>.*?<\/span>)\n(?!\n)/g, "$1")
		// A blank line separates paragraphs with a small gap rather than a whole empty line.
		.replace(/\n\n/g, '<span class="md-gap"></span>')
		.replace(/\n/g, "<br>");
	return html
		.replace(
			/\u0003(\d+)\u0003/g,
			(_match, index: string) =>
				`<blockquote>${renderInline(quotes[Number(index)] ?? "").replace(/\n/g, "<br>")}</blockquote>`,
		)
		.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => blocks[Number(index)] ?? "")
		.replace(/\u0001(\d+)\u0001/g, (_match, index: string) => inlines[Number(index)] ?? "");
}

/** Share the renderer's grammar, exclusions and escaping with delivery recognition. */
export function markdownFileReferences(text: string): MarkdownFileReference[] {
	if (text.length > 200_000) return [];
	const references: MarkdownFileReference[] = [];
	renderMarkdown(
		text,
		{ code: "", copy: "", table: "" },
		{
			onFileReference: (reference) => {
				if (references.length < 128) references.push(reference);
			},
		},
	);
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
