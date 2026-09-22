/**
 * Head + tail + salient-line text cutting used by the projection rules.
 *
 * A cut keeps the head and tail of an oversized text plus a bounded number of
 * "salient" middle lines (errors, test output, paths, diff hunks) so the model
 * retains the actionable parts of the omitted region.
 */

import { normalizeForHash, PROJECTION_CUT_MARKER_PREFIX } from "./projection-content.ts";

/**
 * Salient-line pattern: error/test/path/diff keywords plus stack-frame shapes
 * (`File "x.py"`, Rust `-->`, and `path.ext:12` / `path.ext(12` references).
 */
export const SALIENT_LINE_REGEX = /error|fail|test|exit|path|diff|warning|traceback|File "|-->|\S+\.\w+[:(]\d+/i;

/** Additional salient shapes for code/patch/JSON payloads (large-code rule). */
export const CODE_SALIENT_LINE_REGEX =
	/^diff --git |^@@ |^[+-]{3} |^Index: |^\s*at |SyntaxError|ParseError|Unexpected token|error TS\d+|expected|unterminated|unclosed/i;

/** Minimum characters a cut must save before it is applied. */
const MIN_CUT_GAIN_CHARS = 500;
/** Maximum characters for a single preserved salient line. */
const MAX_SALIENT_LINE_CHARS = 400;

/** Outcome of one head+tail+salient cut. */
export interface CutResult {
	text: string;
	salientLines: number;
}

function takeHeadLines(lines: readonly string[], budget: number): string[] {
	const collectedLines: string[] = [];
	let usedChars = 0;
	for (const line of lines) {
		if (collectedLines.length === 0 && line.length > budget) {
			collectedLines.push(`${line.slice(0, budget)}…`);
			return collectedLines;
		}
		if (usedChars + line.length + 1 > budget && collectedLines.length > 0) break;
		collectedLines.push(line);
		usedChars += line.length + 1;
		if (usedChars >= budget) break;
	}
	return collectedLines;
}

function takeTailLines(lines: readonly string[], budget: number): string[] {
	const collectedLines: string[] = [];
	let usedChars = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (collectedLines.length === 0 && line.length > budget) {
			collectedLines.unshift(`…${line.slice(line.length - budget)}`);
			return collectedLines;
		}
		if (usedChars + line.length + 1 > budget && collectedLines.length > 0) break;
		collectedLines.unshift(line);
		usedChars += line.length + 1;
		if (usedChars >= budget) break;
	}
	return collectedLines;
}

/** Collect up to `maxSalientLines` deduplicated salient lines from the omitted middle. */
function collectSalientMiddleLines(
	lines: readonly string[],
	headCount: number,
	tailCount: number,
	maxSalientLines: number,
	salientRegex: RegExp,
): string[] {
	const salientLines: string[] = [];
	const seenLineKeys = new Set<string>();
	for (let i = headCount; i < lines.length - tailCount && salientLines.length < maxSalientLines; i++) {
		const line = lines[i];
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		if (!salientRegex.test(line) && !SALIENT_LINE_REGEX.test(line)) continue;
		const lineKey = normalizeForHash(trimmed);
		if (seenLineKeys.has(lineKey)) continue;
		seenLineKeys.add(lineKey);
		salientLines.push(
			trimmed.length > MAX_SALIENT_LINE_CHARS ? `${trimmed.slice(0, MAX_SALIENT_LINE_CHARS)}…` : trimmed,
		);
	}
	return salientLines;
}

/**
 * Cut `text` to head + tail plus up to `maxSalientLines` deduplicated salient
 * lines from the omitted middle. Returns undefined when cutting would not
 * save at least `MIN_CUT_GAIN_CHARS`.
 */
export function cutTextWithSalientLines(
	text: string,
	headChars: number,
	tailChars: number,
	maxSalientLines: number,
	salientRegex: RegExp,
): CutResult | undefined {
	if (text.length <= headChars + tailChars + MIN_CUT_GAIN_CHARS) return undefined;

	const lines = text.split("\n");
	const headLines = takeHeadLines(lines, headChars);
	const tailLines = takeTailLines(lines, tailChars);
	if (headLines.length + tailLines.length >= lines.length) return undefined;

	const salientLines = collectSalientMiddleLines(
		lines,
		headLines.length,
		tailLines.length,
		maxSalientLines,
		salientRegex,
	);

	const headText = headLines.join("\n");
	const tailText = tailLines.join("\n");
	const salientText = salientLines.join("\n");
	const retainedChars = headText.length + salientText.length + tailText.length;
	const omittedChars = Math.max(0, text.length - retainedChars);
	const marker = `${PROJECTION_CUT_MARKER_PREFIX} original_chars=${text.length} retained_chars=${retainedChars} omitted_chars=${omittedChars}; salient_lines=${salientLines.length}]`;

	const cutSections: string[] = [headText, marker];
	if (salientLines.length > 0) cutSections.push(salientText, "[...]");
	cutSections.push(tailText);
	const cutText = cutSections.join("\n");

	if (cutText.length >= text.length - MIN_CUT_GAIN_CHARS) return undefined;
	return { text: cutText, salientLines: salientLines.length };
}
