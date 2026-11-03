import { redactSecretString } from "../secret-redaction.ts";
import { redactDiagnosticPii } from "./redact-diagnostics.ts";
import {
	FEEDBACK_CATEGORIES,
	FEEDBACK_CATEGORY_CLI_SPELLINGS,
	FEEDBACK_COMMENT_MAX_RUNES,
	type FeedbackCategory,
	type FeedbackDiagnostics,
	type FeedbackDiagnosticsSource,
	FEEDBACK_DIAGNOSTICS_MAX_BYTES as MAX_BYTES,
	FEEDBACK_DIAGNOSTICS_MAX_LINE_CHARS as MAX_LINE_CHARS,
	FEEDBACK_DIAGNOSTICS_MAX_LINES as MAX_LINES,
} from "./types.ts";

export function normalizeFeedbackCategory(value: string): FeedbackCategory | undefined {
	const normalized = value.trim().toLowerCase();
	const collapsed = normalized.replace(/[-\s]+/gu, "_");
	if ((FEEDBACK_CATEGORIES as readonly string[]).includes(collapsed)) return collapsed as FeedbackCategory;
	return FEEDBACK_CATEGORIES.find((category) => FEEDBACK_CATEGORY_CLI_SPELLINGS[category] === normalized);
}

export function countFeedbackCommentRunes(value: string): number {
	return [...value].length;
}

export type FeedbackValidation =
	| { ok: true; category?: FeedbackCategory; comment: string }
	| { ok: false; error: string };

export function validateFeedbackInput(input: { category?: string; comment: string }): FeedbackValidation {
	const requested = input.category?.trim() ?? "";
	const category = requested ? normalizeFeedbackCategory(requested) : undefined;
	if (requested && !category) {
		return {
			ok: false,
			error: `Unknown feedback category '${requested}'. Expected one of: ${FEEDBACK_CATEGORIES.map((c) => FEEDBACK_CATEGORY_CLI_SPELLINGS[c]).join(", ")}.`,
		};
	}

	const comment = input.comment.trim();
	// Length is measured on the wire value (credential-redacted), not the raw
	// comment, so redaction that lengthens a fragment cannot push a submission
	// past the limit after the user was told it was fine.
	const wireLength = countFeedbackCommentRunes(redactSecretString(comment));
	if (wireLength > FEEDBACK_COMMENT_MAX_RUNES) {
		return {
			ok: false,
			error: `Feedback comment is ${wireLength} characters; the limit is ${FEEDBACK_COMMENT_MAX_RUNES}.`,
		};
	}
	return { ok: true, comment, ...(category ? { category } : {}) };
}

type TerminalSanitizerState = "text" | "escape" | "escape-intermediate" | "csi" | "string" | "string-escape";

/**
 * Removes terminal controls before an excerpt is displayed or submitted.
 * String controls (OSC/DCS/PM/APC) may span lines and are discarded through
 * their terminator; an unterminated control is discarded through EOF.
 */
export function sanitizeTerminalText(value: string): string {
	let state: TerminalSanitizerState = "text";
	let output = "";
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		switch (state) {
			case "text":
				if (character === "\n") {
					output += character;
				} else if (character === "\t") {
					output += " ";
				} else if (codePoint === 0x1b) {
					state = "escape";
				} else if (codePoint === 0x9b) {
					state = "csi";
				} else if (codePoint === 0x90 || codePoint === 0x9d || codePoint === 0x9e || codePoint === 0x9f) {
					state = "string";
				} else if (codePoint >= 0x20 && codePoint !== 0x7f && !(codePoint >= 0x80 && codePoint <= 0x9f)) {
					output += character;
				}
				break;
			case "escape":
				if (character === "[") {
					state = "csi";
				} else if (character === "]" || character === "P" || character === "^" || character === "_") {
					state = "string";
				} else if (codePoint >= 0x20 && codePoint <= 0x2f) {
					state = "escape-intermediate";
				} else if (codePoint === 0x1b) {
					state = "escape";
				} else if (character === "\n") {
					output += character;
					state = "text";
				} else {
					state = "text";
				}
				break;
			case "escape-intermediate":
				if (codePoint === 0x1b) {
					state = "escape";
				} else if (character === "\n") {
					output += character;
					state = "text";
				} else if (codePoint >= 0x30 && codePoint <= 0x7e) {
					state = "text";
				}
				break;
			case "csi":
				if (codePoint === 0x1b) {
					state = "escape";
				} else if (codePoint >= 0x40 && codePoint <= 0x7e) {
					state = "text";
				}
				break;
			case "string":
				if (codePoint === 0x07 || codePoint === 0x9c) {
					state = "text";
				} else if (codePoint === 0x1b) {
					state = "string-escape";
				}
				break;
			case "string-escape":
				if (character === "\\" || codePoint === 0x9c) {
					state = "text";
				} else if (codePoint !== 0x1b) {
					state = "string";
				}
				break;
		}
	}
	return output;
}

/**
 * A trace row the excerpt must not lose. An input trace is mostly per-keystroke
 * rows, and the whole diagnosis is in the handful of `note` rows among them
 * (`raw-without-dispatch` is the machine-detected "the terminal delivered bytes
 * and pi-tui dispatched none"). It is latched to fire once, so on a long trace
 * it sits far from the end and a tail-only bound would drop the one line the
 * excerpt exists to carry.
 */
function isTraceNote(line: string): boolean {
	return line.includes('"src":"note"');
}

export interface BoundedDiagnosticsLines {
	lines: string[];
	truncated: boolean;
}

/**
 * Spends the line/byte budget walking newest-first, keeping whatever `accept`
 * admits. Indices, not strings, so the two passes can be merged back into one
 * chronological excerpt without sorting on content.
 */
function boundLines(input: {
	lines: readonly string[];
	normalize: (line: string) => string;
	truncated: boolean;
	prioritize?: (line: string) => boolean;
}): BoundedDiagnosticsLines {
	let truncated = input.truncated;
	let remainingBytes = MAX_BYTES;
	const keptIndices: number[] = [];
	const normalizedByIndex = new Map<number, string>();

	const sweep = (accept: (line: string, index: number) => boolean): void => {
		for (let index = input.lines.length - 1; index >= 0; index -= 1) {
			if (normalizedByIndex.has(index)) continue;
			const normalized = input.normalize(input.lines[index] ?? "");
			// Blank after normalization carries no signal, and skipping it is not a
			// truncation: nothing was lost.
			if (normalized.trim().length === 0) continue;
			if (!accept(normalized, index)) continue;

			const codePoints = [...normalized];
			let line = normalized;
			if (codePoints.length > MAX_LINE_CHARS) {
				line = codePoints.slice(0, MAX_LINE_CHARS).join("");
				truncated = true;
			}

			const cost = Buffer.byteLength(line, "utf8") + 1;
			if (keptIndices.length >= MAX_LINES || cost > remainingBytes) {
				// Everything older stays behind: there was more than may leave the machine.
				truncated = true;
				break;
			}
			remainingBytes -= cost;
			keptIndices.push(index);
			normalizedByIndex.set(index, line);
		}
	};

	if (input.prioritize) {
		const prioritize = input.prioritize;
		sweep((line) => prioritize(line));
	}
	sweep(() => true);

	// Ascending index is chronological order, and the only thing that puts a
	// priority row back beside the rows it was recorded next to.
	keptIndices.sort((left, right) => left - right);
	return { lines: keptIndices.map((index) => normalizedByIndex.get(index) ?? ""), truncated };
}

/**
 * Re-applies the wire bounds to lines that are already sanitized and redacted.
 */
export function boundFeedbackDiagnosticsLines(lines: readonly string[]): BoundedDiagnosticsLines {
	return boundLines({ lines, normalize: (line) => line, truncated: false });
}

function sanitizeAndBoundFeedbackDiagnostics(input: {
	text: string;
	source: FeedbackDiagnosticsSource;
	truncated: boolean;
	dropFirstLine?: boolean;
	keepOnlyLineTail?: boolean;
}): BoundedDiagnosticsLines {
	const redacted = redactSecretString(sanitizeTerminalText(input.text));
	const lines = redacted.split("\n");
	if (input.dropFirstLine) lines.shift();
	if (input.keepOnlyLineTail && lines.length === 1) {
		lines[0] = [...(lines[0] ?? "")].slice(-MAX_LINE_CHARS).join("");
	}
	return boundLines({
		lines,
		normalize: redactDiagnosticPii,
		truncated: input.truncated,
		...(input.source === "input_trace" ? { prioritize: isTraceNote } : {}),
	});
}

/**
 * Builds a bounded, sanitized, path-redacted excerpt from raw file lines,
 * keeping the newest lines (the failure being reported is the last thing that
 * happened) and the trace `note` rows wherever they sit.
 */
export function excerptFeedbackDiagnostics(input: {
	lines: readonly string[];
	source: FeedbackDiagnosticsSource;
	startsMidStream: boolean;
}): BoundedDiagnosticsLines {
	const lines = [...input.lines];
	let dropFirstLine = false;
	let keepOnlyLineTail = false;
	if (input.startsMidStream && lines.length > 1) {
		// The window may have opened mid-line (and mid-UTF-8-sequence), so the first
		// element is the only place a fragment can appear. Sanitize and redact the
		// complete window first so a multiline control or credential beginning in
		// that fragment still protects later lines, then drop the fragment.
		dropFirstLine = true;
	} else if (input.startsMidStream && lines.length === 1) {
		// One line longer than the whole window: redact the complete fragment so a
		// label near its start can protect a repeated value near its end, then keep
		// the newest characters rather than nothing.
		keepOnlyLineTail = true;
	}
	return sanitizeAndBoundFeedbackDiagnostics({
		text: lines.join("\n"),
		source: input.source,
		truncated: input.startsMidStream,
		...(dropFirstLine ? { dropFirstLine } : {}),
		...(keepOnlyLineTail ? { keepOnlyLineTail } : {}),
	});
}

export function redactFeedbackDiagnostics(diagnostics: FeedbackDiagnostics): FeedbackDiagnostics {
	const bounded = sanitizeAndBoundFeedbackDiagnostics({
		text: diagnostics.lines.join("\n"),
		source: diagnostics.source,
		truncated: diagnostics.truncated,
	});
	return { source: diagnostics.source, lines: bounded.lines, truncated: bounded.truncated };
}
