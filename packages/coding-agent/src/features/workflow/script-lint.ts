/**
 * Pre-run checks on workflow script source. They reject misuse that the VM
 * would otherwise accept silently, before a journal or child process exists.
 */

/** Message shared by the static check and the VM's runtime guard. */
export const PHASE_USAGE_MESSAGE =
	"phase(title) takes one string and only labels a milestone; it runs no callback. Call agent(), parallel(), or pipeline() as separate statements after it.";

/** Throw when any `phase(...)` call passes more than one argument. */
export function assertWorkflowScriptUsage(script: string): void {
	const line = findMultiArgumentPhaseCall(script);
	if (line !== undefined) throw new Error(`Workflow script line ${line}: ${PHASE_USAGE_MESSAGE}`);
}

/**
 * Line (1-based) of the first `phase(...)` call with a top-level comma, or
 * undefined. A lexical scan, not a parser: it skips comments, strings, and
 * templates, ignores `obj.phase(`, `function phase(`, and method definitions,
 * and accepts a trailing comma after a single argument.
 */
export function findMultiArgumentPhaseCall(source: string): number | undefined {
	let index = 0;
	let previousWord = "";
	let previousChar = "";
	while (index < source.length) {
		const skipped = skipNonCode(source, index);
		if (skipped !== index) {
			index = skipped;
			continue;
		}
		const char = source[index] ?? "";
		if (/[A-Za-z_$]/u.test(char)) {
			let end = index + 1;
			while (end < source.length && /[\w$]/u.test(source[end] ?? "")) end += 1;
			const word = source.slice(index, end);
			if (word === "phase" && previousChar !== "." && previousWord !== "function") {
				const open = skipWhitespace(source, end);
				if (source[open] === "(") {
					const call = scanArguments(source, open);
					const after = skipWhitespace(source, call.close + 1);
					if (call.multiple && source[after] !== "{") return lineAt(source, index);
				}
			}
			previousWord = word;
			previousChar = "";
			index = end;
			continue;
		}
		if (!/\s/u.test(char)) {
			previousChar = char;
			previousWord = "";
		}
		index += 1;
	}
	return undefined;
}

function scanArguments(source: string, open: number): { close: number; multiple: boolean } {
	let depth = 0;
	let commaAt = -1;
	let index = open;
	while (index < source.length) {
		const skipped = skipNonCode(source, index);
		if (skipped !== index) {
			index = skipped;
			continue;
		}
		const char = source[index];
		if (char === "(" || char === "[" || char === "{") depth += 1;
		else if (char === ")" || char === "]" || char === "}") {
			depth -= 1;
			if (depth === 0) {
				// `phase("a",)` is one argument; anything after the comma is a second.
				const multiple = commaAt >= 0 && source.slice(commaAt + 1, index).trim() !== "";
				return { close: index, multiple };
			}
		} else if (char === "," && depth === 1 && commaAt < 0) commaAt = index;
		index += 1;
	}
	return { close: source.length, multiple: false };
}

/** Index after a comment, string, or template starting at `index`; `index` itself otherwise. */
function skipNonCode(source: string, index: number): number {
	const char = source[index];
	const next = source[index + 1];
	if (char === "/" && next === "/") {
		const end = source.indexOf("\n", index);
		return end < 0 ? source.length : end;
	}
	if (char === "/" && next === "*") {
		const end = source.indexOf("*/", index + 2);
		return end < 0 ? source.length : end + 2;
	}
	if (char === '"' || char === "'") {
		let cursor = index + 1;
		while (cursor < source.length && source[cursor] !== char && source[cursor] !== "\n") {
			cursor += source[cursor] === "\\" ? 2 : 1;
		}
		return cursor + 1;
	}
	if (char === "`") return skipTemplate(source, index + 1);
	return index;
}

function skipTemplate(source: string, start: number): number {
	let cursor = start;
	while (cursor < source.length) {
		const char = source[cursor];
		if (char === "\\") cursor += 2;
		else if (char === "`") return cursor + 1;
		else if (char === "$" && source[cursor + 1] === "{") cursor = skipBraces(source, cursor + 1);
		else cursor += 1;
	}
	return source.length;
}

/** Index after the `}` matching the `{` at `open`, skipping nested non-code. */
function skipBraces(source: string, open: number): number {
	let depth = 0;
	let cursor = open;
	while (cursor < source.length) {
		const skipped = skipNonCode(source, cursor);
		if (skipped !== cursor) {
			cursor = skipped;
			continue;
		}
		if (source[cursor] === "{") depth += 1;
		else if (source[cursor] === "}") {
			depth -= 1;
			if (depth === 0) return cursor + 1;
		}
		cursor += 1;
	}
	return source.length;
}

function skipWhitespace(source: string, index: number): number {
	let cursor = index;
	while (cursor < source.length && /\s/u.test(source[cursor] ?? "")) cursor += 1;
	return cursor;
}

function lineAt(source: string, index: number): number {
	let line = 1;
	for (let cursor = 0; cursor < index; cursor++) if (source[cursor] === "\n") line += 1;
	return line;
}
