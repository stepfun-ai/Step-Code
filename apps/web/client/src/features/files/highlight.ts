/**
 * Source colouring for the file preview (legacy app.js 1580-1709).
 *
 * One regex per language family, with a class per capture group. This is a
 * colouring aid, not a parser: it knows comments, strings, numbers and a shared
 * keyword list, which is enough to make a file scannable without shipping a
 * grammar per language.
 */

import { basename } from "../../lib/format";
import { escapeHtml } from "../../lib/markdown";

/** Above this many characters a file is shown without highlighting. */
export const HIGHLIGHT_LIMIT = 300_000;
/** Above this many lines only the head of the file is rendered. */
export const PREVIEW_LINE_LIMIT = 10_000;

const KEYWORDS = new Set(
	"abstract and as assert async await break case catch class const continue def default defer del delete do elif else enum except export extends false final finally fn for from func function global go if impl implements import in instanceof interface is lambda let match mod module mut new nil none not null of or package pass private protected pub public raise readonly return self static struct super switch then this throw trait true try type typeof undefined use var void while with yield None True False fi esac done echo local select where insert update create table".split(
		" ",
	),
);

const STRING_RULE = `"(?:\\\\.|[^"\\\\\\n])*"?|'(?:\\\\.|[^'\\\\\\n])*'?`;
const NUMBER_RULE = "\\b(?:0[xX][\\da-fA-F_]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b";
const WORD_RULE = "[A-Za-z_$][\\w$]*";
const wordClass = (text: string): string => (KEYWORDS.has(text) ? "keyword" : "");

type TokenRule = string | ((text: string) => string);

export interface HighlightFamily {
	readonly pattern: RegExp;
	readonly classes: readonly TokenRule[];
}

export const HIGHLIGHT_FAMILIES = {
	clike: {
		pattern: new RegExp(
			`(//[^\\n]*|/\\*[\\s\\S]*?(?:\\*/|$))|(${STRING_RULE}|\`(?:\\\\[\\s\\S]|[^\`\\\\])*\`?)|(${NUMBER_RULE})|(${WORD_RULE})`,
			"g",
		),
		classes: ["comment", "string", "number", wordClass],
	},
	hash: {
		pattern: new RegExp(
			`(#[^\\n]*)|("""[\\s\\S]*?(?:"""|$)|'''[\\s\\S]*?(?:'''|$)|${STRING_RULE})|(${NUMBER_RULE})|(${WORD_RULE})`,
			"g",
		),
		classes: ["comment", "string", "number", wordClass],
	},
	sql: {
		pattern: new RegExp(`(--[^\\n]*|/\\*[\\s\\S]*?(?:\\*/|$))|(${STRING_RULE})|(${NUMBER_RULE})|(${WORD_RULE})`, "g"),
		classes: ["comment", "string", "number", (text: string) => wordClass(text.toLowerCase())],
	},
	json: {
		pattern:
			/("(?:\\.|[^"\\\n])*"(?=\s*:))|("(?:\\.|[^"\\\n])*"?)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g,
		classes: ["key", "string", "number", "keyword"],
	},
	markup: {
		pattern: /(<!--[\s\S]*?(?:-->|$))|(<\/?[A-Za-z][\w:.-]*|\/?>)|("[^"\n]*"|'[^'\n]*')/g,
		classes: ["comment", "tag", "string"],
	},
	markdown: {
		pattern: /(^```[^\n]*\n[\s\S]*?(?:^```[^\n]*$|(?![\s\S])))|(^#{1,6} [^\n]*$)|(`[^`\n]+`)/gm,
		classes: ["string", "keyword", "string"],
	},
} as const satisfies Record<string, HighlightFamily>;

type FamilyName = keyof typeof HIGHLIGHT_FAMILIES;

const LANGUAGE_FAMILIES: Readonly<Record<FamilyName, string>> = {
	clike: "js jsx mjs cjs ts tsx mts cts java c h cc cpp hpp cs go rs swift kt kts scala php dart css scss less proto groovy gradle",
	hash: "py rb sh bash zsh fish yaml yml toml ini conf env properties pl r tf dockerfile makefile mk gitignore npmrc editorconfig",
	sql: "sql",
	json: "json jsonc json5 jsonl map webmanifest",
	markup: "html htm xml svg vue svelte plist",
	markdown: "md markdown mdx",
};

/** The display language of a path: its extension, or its name for dotfiles. */
export function fileLanguage(path: string): string {
	const name = basename(path).toLowerCase();
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1) : name.replace(/^\./, "");
}

export function highlightFamily(language: string): HighlightFamily | undefined {
	for (const [family, languages] of Object.entries(LANGUAGE_FAMILIES) as Array<[FamilyName, string]>) {
		if (languages.split(" ").includes(language)) return HIGHLIGHT_FAMILIES[family];
	}
	return undefined;
}

/** True when `path` is shown with the Markdown family (and so can be rendered). */
export function isMarkdownPath(path: string): boolean {
	return highlightFamily(fileLanguage(path)) === HIGHLIGHT_FAMILIES.markdown;
}

/** Split `content` into escaped HTML lines, coloured when a family matches. */
export function highlightLines(content: string, language: string): string[] {
	const lines = [""];
	const push = (text: string, className: string) => {
		text.split("\n").forEach((part, index) => {
			if (index) lines.push("");
			if (!part) return;
			const escaped = escapeHtml(part);
			lines[lines.length - 1] += className ? `<span class="tok-${className}">${escaped}</span>` : escaped;
		});
	};
	const family = content.length <= HIGHLIGHT_LIMIT ? highlightFamily(language) : undefined;
	if (!family) {
		push(content, "");
		return lines;
	}
	let cursor = 0;
	for (const match of content.matchAll(family.pattern)) {
		if (!match[0]) continue;
		const start = match.index ?? 0;
		push(content.slice(cursor, start), "");
		const group = match.findIndex((value, index) => index > 0 && value !== undefined) - 1;
		const rule = family.classes[group] ?? "";
		push(match[0], typeof rule === "function" ? rule(match[0]) : rule);
		cursor = start + match[0].length;
	}
	push(content.slice(cursor), "");
	return lines;
}

export interface CodeViewHtml {
	/** `.code-line` rows (plus the truncation notice), for the `.code-view` element. */
	readonly html: string;
	/** Digits of the last line number (`--line-digits`). */
	readonly digits: number;
}

/**
 * Inner HTML of a `.code-view` (legacy `buildCodeView`, 1778-1795). Built as one
 * string because a preview can hold 10 000 lines.
 */
export function codeViewHtml(content: string, path: string, truncatedNotice: string): CodeViewHtml {
	const lines = highlightLines(content, fileLanguage(path));
	// A trailing newline is the end of the last line, not an extra empty one.
	if (lines.length > 1 && lines.at(-1) === "") lines.pop();
	const shown = lines.slice(0, PREVIEW_LINE_LIMIT);
	let html = shown.map((line) => `<div class="code-line">${line || " "}</div>`).join("");
	if (lines.length > shown.length) html += `<div class="preview-message">${escapeHtml(truncatedNotice)}</div>`;
	return { html, digits: String(shown.length).length };
}
