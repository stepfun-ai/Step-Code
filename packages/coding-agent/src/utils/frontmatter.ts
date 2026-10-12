import { isMap, isScalar, parse, parseDocument } from "yaml";
import { stripBom } from "./text.ts";

type ParsedFrontmatter<T extends Record<string, unknown>> = {
	frontmatter: T;
	body: string;
};

/** Location and reason of a frontmatter syntax error, flattened onto a single line. */
export interface FrontmatterErrorDetails {
	/** 1-based line in the file, when the parser reports one. */
	line?: number;
	/** 1-based column in the file, when the parser reports one. */
	column?: number;
	/** Parser reason, without the quoted source line or caret. */
	reason: string;
}

const normalizeNewlines = (value: string): string => value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

const extractFrontmatter = (content: string): { yamlString: string | null; body: string } => {
	const normalized = normalizeNewlines(stripBom(content));

	if (!normalized.startsWith("---")) {
		return { yamlString: null, body: normalized };
	}

	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) {
		return { yamlString: null, body: normalized };
	}

	return {
		yamlString: normalized.slice(4, endIndex),
		body: normalized.slice(endIndex + 4).trim(),
	};
};

export const parseFrontmatter = <T extends Record<string, unknown> = Record<string, unknown>>(
	content: string,
): ParsedFrontmatter<T> => {
	const { yamlString, body } = extractFrontmatter(content);
	if (!yamlString) {
		return { frontmatter: {} as T, body };
	}
	const parsed = parse(yamlString);
	return { frontmatter: (parsed ?? {}) as T, body };
};

export const stripFrontmatter = (content: string): string => parseFrontmatter(content).body;

/**
 * The YAML block always starts on file line 2 (right after the opening `---`), so parser line
 * numbers are shifted to point at the line a user actually edits.
 */
const YAML_TO_FILE_LINE_OFFSET = 1;

/**
 * Flatten a `yaml` parse error into a single line.
 *
 * The `yaml` package appends a quoted (and possibly truncated) source line plus a caret to its
 * messages, which wraps into an unreadable block inside the diagnostics list.
 */
export function describeFrontmatterError(error: unknown): FrontmatterErrorDetails {
	const message = error instanceof Error ? error.message : String(error);
	const headline = (message.split("\n")[0] ?? "").replace(
		/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g,
		(character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
	const location = /^(.*?)\s+at line (\d+), column (\d+)/.exec(headline ?? "");
	const position = (error as { linePos?: Array<{ line?: number; col?: number }> })?.linePos?.[0];
	const line = position?.line ?? (location ? Number(location[2]) : undefined);
	const column = position?.col ?? (location ? Number(location[3]) : undefined);
	const reason = (location?.[1] ?? headline ?? "").trim() || "invalid YAML";

	return {
		line: line === undefined ? undefined : line + YAML_TO_FILE_LINE_OFFSET,
		column,
		reason,
	};
}

/** Detect a rejected compact mapping in the top-level description value. */
export function hasUnquotedColonInDescription(content: string): boolean {
	const { yamlString } = extractFrontmatter(content);
	if (!yamlString) return false;

	// Inspect the parser's recovered tree so comments, quoted strings and block scalar
	// contents cannot be mistaken for description keys.
	const document = parseDocument(yamlString);
	if (!isMap(document.contents)) return false;
	return document.contents.items.some(({ key, value }) => {
		if (!isScalar(key) || key.value !== "description" || !isMap(value)) return false;
		const start = value.range?.[0];
		const keyEnd = key.range?.[1];
		if (start === undefined || keyEnd === undefined) return false;
		// A normal nested mapping on the next line is not an unquoted description.
		if (yamlString.slice(keyEnd, start).includes("\n")) return false;
		return document.errors.some((error) => error.code === "BLOCK_AS_IMPLICIT_KEY" && error.pos[0] === start);
	});
}

/**
 * Build a single-line, actionable diagnostic for a frontmatter syntax error, e.g.
 * `/path/SKILL.md: invalid YAML frontmatter at line 3, column 14: Nested mappings are not allowed
 * in compact mappings — description contains an unquoted ":" — wrap the value in double quotes`.
 */
export function formatFrontmatterError(filePath: string, error: unknown, content: string): string {
	const { line, column, reason } = describeFrontmatterError(error);
	const at =
		line !== undefined && column !== undefined
			? ` at line ${line}, column ${column}`
			: line !== undefined
				? ` at line ${line}`
				: "";
	const hint = hasUnquotedColonInDescription(content)
		? ' — description contains an unquoted ":" — wrap the value in double quotes'
		: "";

	return `${filePath}: invalid YAML frontmatter${at}: ${reason}${hint}`;
}
