/**
 * Pasted rich text becomes Markdown source, so a copied paragraph keeps its
 * bold runs, headings, lists, code and links in the composer's plain text.
 *
 * The clipboard's HTML is parsed with DOMParser (inert: no scripts run, no
 * images load) and walked once. Only what the composer's renderer understands
 * is emitted — headings, emphasis, inline code, fenced blocks, lists, quotes,
 * rules, links and GFM tables; images keep their alt text. Buttons, scripts,
 * styles, icons and form controls are dropped, which also keeps the
 * conversation's own "copy" buttons out of a copied answer.
 */

/** A block ends the current line and starts a new one. */
const BLOCK_TAGS = new Set([
	"ADDRESS",
	"ARTICLE",
	"ASIDE",
	"BLOCKQUOTE",
	"DD",
	"DIV",
	"DL",
	"DT",
	"FIELDSET",
	"FIGCAPTION",
	"FIGURE",
	"FOOTER",
	"FORM",
	"H1",
	"H2",
	"H3",
	"H4",
	"H5",
	"H6",
	"HEADER",
	"HR",
	"LI",
	"MAIN",
	"NAV",
	"OL",
	"P",
	"PRE",
	"SECTION",
	"TABLE",
	"TBODY",
	"TD",
	"TFOOT",
	"TH",
	"THEAD",
	"TR",
	"UL",
]);

/** Page furniture a paste should not carry: controls, scripts and icons. */
const DROPPED_TAGS = new Set([
	"BUTTON",
	"EMBED",
	"FORM",
	"IFRAME",
	"INPUT",
	"NOSCRIPT",
	"OBJECT",
	"SCRIPT",
	"SELECT",
	"STYLE",
	"SVG",
	"TEMPLATE",
	"TEXTAREA",
]);

/** A pathological clipboard payload falls back to its plain-text alternative. */
const MAX_HTML = 200_000;

export function htmlToMarkdown(html: string): string | null {
	if (!html || html.length > MAX_HTML) return null;
	let body: HTMLElement;
	try {
		body = new DOMParser().parseFromString(html, "text/html").body;
	} catch {
		return null;
	}
	if (!body) return null;
	const markdown = normalize(contentOf(body));
	return markdown || null;
}

/**
 * Collapse the walk's generous spacing without touching fenced code: trailing
 * spaces and blank lines inside a fence are the code, not layout.
 */
function normalize(markdown: string): string {
	const lines = markdown.split("\n");
	const out: string[] = [];
	let fence: string | null = null;
	let blanks = 0;
	for (const line of lines) {
		const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (marker) {
			if (!fence) fence = marker;
			else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
			out.push(line);
			blanks = 0;
			continue;
		}
		if (fence) {
			out.push(line);
			continue;
		}
		const trimmed = line.replace(/[ \t]+$/, "");
		if (trimmed) {
			blanks = 0;
			out.push(trimmed);
		} else if (blanks === 0) {
			blanks = 1;
			out.push("");
		}
	}
	return out.join("\n").trim();
}

function dropped(element: HTMLElement): boolean {
	if (DROPPED_TAGS.has(element.tagName)) return true;
	if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") return true;
	return false;
}

function isBlock(element: HTMLElement): boolean {
	return (
		BLOCK_TAGS.has(element.tagName) ||
		element.classList.contains("md-li") ||
		element.classList.contains("md-oli") ||
		element.classList.contains("code-block")
	);
}

/** Inline and block children in document order; block children keep their own spacing. */
function contentOf(parent: Node): string {
	let out = "";
	for (const child of parent.childNodes) {
		if (child instanceof HTMLElement && isBlock(child)) out += blockElement(child);
		else out += inlineNode(child);
	}
	return out;
}

function inlineChildren(parent: Node): string {
	let out = "";
	for (const child of parent.childNodes) out += inlineNode(child);
	return out;
}

function inlineNode(node: Node): string {
	if (node instanceof Text) return node.data.replace(/\s+/g, " ");
	if (!(node instanceof HTMLElement) || dropped(node)) return "";
	// Our own renderer paints a paragraph gap with an empty span instead of a newline.
	if (node.classList.contains("md-gap")) return "\n\n";
	// A block nested in inline content still needs its own lines.
	if (isBlock(node)) return blockElement(node);
	const tag = node.tagName;
	if (tag === "BR") return "\n";
	if (tag === "IMG") return node.getAttribute("alt")?.trim() ?? "";
	// Code keeps its own spacing: the surrounding walk collapses prose whitespace only.
	if (tag === "CODE") return codeSpan(node.textContent ?? "");
	const inner = inlineChildren(node);
	const trimmed = inner.trim();
	switch (tag) {
		case "STRONG":
		case "B":
			return trimmed ? `**${trimmed}**` : inner;
		case "EM":
		case "I":
			return trimmed ? `*${trimmed}*` : inner;
		case "DEL":
		case "STRIKE":
		case "S":
			return trimmed ? `~~${trimmed}~~` : inner;
		case "A": {
			const href = safeHref(node.getAttribute("href"));
			return href && trimmed ? `[${trimmed}](${href})` : inner;
		}
		default:
			return inner;
	}
}

function blockElement(element: HTMLElement): string {
	if (dropped(element)) return "";
	// The conversation's own rendered Markdown: its list markers and code
	// blocks are CSS, so restore the source shape instead of copying chrome.
	if (element.classList.contains("code-block")) {
		const pre = element.querySelector("pre");
		return pre instanceof HTMLElement ? blockElement(pre) : "";
	}
	if (element.classList.contains("md-oli")) {
		return `\n${listIndent(element)}${element.dataset.n ?? "1"}. ${inlineChildren(element).trim()}\n`;
	}
	if (element.classList.contains("md-li")) {
		return `\n${listIndent(element)}- ${inlineChildren(element).trim()}\n`;
	}
	const tag = element.tagName;
	// A block the page laid out with `white-space: pre*` holds its indentation as content.
	if (tag !== "PRE") {
		const preserved = preformattedBlock(element);
		if (preserved) return `\n\n${preserved}\n\n`;
	}
	if (/^H[1-6]$/.test(tag)) {
		const level = Number(tag.slice(1));
		return `\n\n${"#".repeat(level)} ${inlineChildren(element).trim()}\n\n`;
	}
	switch (tag) {
		case "HR":
			return "\n\n---\n\n";
		case "PRE":
			return `\n\n${fencedCode(element)}\n\n`;
		case "BLOCKQUOTE": {
			const quoted = contentOf(element)
				.trim()
				.split("\n")
				.map((line) => (line ? `> ${line}` : ">"))
				.join("\n");
			return `\n\n${quoted}\n\n`;
		}
		case "UL":
		case "OL":
			return `\n\n${listLines(element, 0)}\n\n`;
		case "TABLE":
			return `\n\n${table(element)}\n\n`;
		default:
			return `\n\n${contentOf(element).trim()}\n\n`;
	}
}

/** A nested item (`md-li-nested`) is one level in; the source only records that it is indented. */
function listIndent(element: HTMLElement): string {
	return element.classList.contains("md-li-nested") ? "  " : "";
}

/**
 * A block the page laid out with `white-space: pre*`: its indentation is content,
 * so it becomes a fenced block instead of losing its spaces to prose collapsing.
 * A single line without runs of spaces carries nothing a paragraph would not, and
 * stays prose.
 */
function preformattedBlock(element: HTMLElement): string | null {
	const whiteSpace = element.style.whiteSpace;
	if (whiteSpace !== "pre" && whiteSpace !== "pre-wrap" && whiteSpace !== "break-spaces") return null;
	const text = preformattedText(element).replace(/^\n+/, "").replace(/\s+$/, "");
	if (!text || !/(\n|\t| {2})/.test(text)) return null;
	return fenced(text, "");
}

/** Text of a whitespace-preserving block, with its block children on their own lines. */
function preformattedText(element: HTMLElement): string {
	let out = "";
	const walk = (parent: Node) => {
		for (const child of parent.childNodes) {
			if (child instanceof Text) {
				out += child.data;
				continue;
			}
			if (!(child instanceof HTMLElement) || dropped(child)) continue;
			if (child.tagName === "BR") {
				out += "\n";
				continue;
			}
			if (isBlock(child)) {
				if (out && !out.endsWith("\n")) out += "\n";
				walk(child);
				if (!out.endsWith("\n")) out += "\n";
				continue;
			}
			walk(child);
		}
	};
	walk(element);
	return out;
}

function fenced(code: string, language: string): string {
	const longest = Math.max(0, ...[...code.matchAll(/`+/g)].map((match) => match[0].length));
	const marker = "`".repeat(Math.max(3, longest + 1));
	return `${marker}${language}\n${code.replace(/\n$/, "")}\n${marker}`;
}

function listLines(list: HTMLElement, depth: number): string {
	const ordered = list.tagName === "OL";
	let index = Number(list.getAttribute("start") ?? "1") || 1;
	const lines: string[] = [];
	const indent = "  ".repeat(depth);
	// Code inside an item is a block of its own; keep its bytes and append it after the list.
	const blocks: string[] = [];
	for (const item of list.children) {
		const marker = ordered ? `${index++}. ` : "- ";
		let inline = "";
		let nested = "";
		for (const node of item.childNodes) {
			if (node instanceof HTMLElement && (node.tagName === "UL" || node.tagName === "OL")) {
				nested += listLines(node, depth + 1);
			} else if (node instanceof HTMLElement && node.tagName === "PRE") {
				blocks.push(fencedCode(node));
			} else if (node instanceof HTMLElement && isBlock(node)) {
				inline += ` ${contentOf(node).trim()} `;
			} else {
				inline += inlineNode(node);
			}
		}
		const body = inline.replace(/\s+/g, " ").trim();
		if (body || !blocks.length) lines.push(`${indent}${marker}${body}`.trimEnd());
		if (nested.trim()) lines.push(nested.trimEnd());
	}
	if (blocks.length) lines.push("", ...blocks, "");
	return lines.join("\n");
}

function table(element: HTMLElement): string {
	const rows = [...element.querySelectorAll("tr")].map((row) =>
		[...row.querySelectorAll("th, td")].map((cell) =>
			contentOf(cell).replace(/\s+/g, " ").trim().replace(/\|/g, "\\|"),
		),
	);
	if (!rows.length || !rows[0].length) return "";
	// GFM needs a header row and a delimiter row; pad every row to the widest one.
	const width = Math.max(...rows.map((row) => row.length));
	const line = (cells: string[]) =>
		`| ${Array.from({ length: width }, (_value, index) => cells[index] ?? "").join(" | ")} |`;
	return [line(rows[0]), line(Array.from({ length: width }, () => "---")), ...rows.slice(1).map(line)].join("\n");
}

function fencedCode(pre: HTMLElement): string {
	const code = pre.textContent ?? "";
	const language = /(?:language|lang)-([\w-]+)/.exec(pre.querySelector("code")?.className ?? "")?.[1] ?? "";
	return fenced(code, language);
}

function codeSpan(value: string): string {
	// Line breaks become spaces (CommonMark); runs of spaces inside code are content.
	const text = value.replace(/[\r\n\t]+/g, " ");
	if (!text.trim()) return "";
	const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
	const marker = "`".repeat(longest + 1);
	// A span that starts or ends with a backtick needs padding, per CommonMark.
	const padding = text.startsWith("`") || text.endsWith("`") ? " " : "";
	return `${marker}${padding}${text}${padding}${marker}`;
}

/** Absolute web/mail links only: a copied relative href is meaningless in a prompt. */
function safeHref(value: string | null): string | null {
	if (!value) return null;
	return /^(?:https?:|mailto:)/i.test(value.trim()) ? value.trim() : null;
}

/**
 * Whether converted source carries Markdown a plain-text paste would not: block
 * markers, a paragraph gap, emphasis, code or a link. Prose with none of these
 * stays in the editor — a preview would show nothing the text does not.
 */
export function hasMarkdownSyntax(markdown: string): boolean {
	// Emphasis is matched after removing the spans that are already proven, so `**bold**`
	// is never mistaken for italic and arithmetic keeps its asterisks.
	const withoutEmphasis = markdown
		.replace(/\*\*[^*\n]+\*\*/g, "")
		.replace(/~~[^~\n]+~~/g, "")
		.replace(/`[^`\n]+`/g, "");
	return (
		/(^|\n)[ \t]{0,3}(?:#{1,6}[ \t]|[-*+][ \t]|\d{1,9}[.)][ \t]|>[ \t]?|`{3,}|~{3,}|\|)/.test(markdown) ||
		/\*\*[^*\n]+\*\*|~~[^~\n]+~~|`[^`\n]+`|\[[^\]\n]+\]\([^)\n]+\)/.test(markdown) ||
		/(^|[^*\w])\*(?=\S)([^*\n]*\S)\*(?![*\w])/.test(withoutEmphasis) ||
		/\n{2,}/.test(markdown)
	);
}
