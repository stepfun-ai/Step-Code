/**
 * Adapted from pi-clm/src/context-document.ts.
 * Copyright 2026 Emanuel Casco. MIT licensed; see ./LICENSE.
 * Only deterministic hashing, framing, escaping, and parsing live here.
 */
import { createHash } from "node:crypto";

export const DOCUMENT_VERSION = 1;
const META_RE =
	/^\[\[LIVE_CONTEXT version=(\d+) revision=(\d+) document=([a-f0-9]{64}) baseline=([a-f0-9]{64})\]\](?:\r?\n|$)/;
// Include content markers and indentation, so quoted placeholders cannot become structure either.
const STRUCTURAL_LINE_RE = /^([ \t]*)(\\*)(\[\[(?:CTX_TURN|LIVE_CONTEXT|CTX_TEXT|CTX_IMAGE)(?=[\s\]]|$))/gm;

function normalizeJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeJson);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([, item]) => item !== undefined)
				// Code-unit ordering is independent of the host's locale.
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([key, item]) => [key, normalizeJson(item)]),
		);
	}
	return value;
}

export function canonicalJson(value: unknown): string {
	return JSON.stringify(normalizeJson(value));
}

export function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function digestCanonicalMessages(messages: readonly unknown[]): string {
	const hash = createHash("sha256");
	for (const message of messages) {
		hash.update(canonicalJson(message));
		hash.update("\n");
	}
	return hash.digest("hex");
}

export function documentId(revision: number, seed: string): string {
	return sha256(`pi-live-context:${DOCUMENT_VERSION}:${revision}:seed:${seed}`);
}

export function blockId(message: unknown, index: number): string {
	return `${index + 1}-${sha256(canonicalJson(message)).slice(0, 12)}`;
}

export function escapeStructuralLines(body: string): string {
	return body.replace(
		STRUCTURAL_LINE_RE,
		(_match, indent: string, slashes: string, start: string) => `${indent}\\${slashes}${start}`,
	);
}

export function unescapeStructuralLines(body: string): string {
	return body.replace(
		STRUCTURAL_LINE_RE,
		(_match, indent: string, slashes: string, start: string) =>
			`${indent}${slashes.length > 0 ? slashes.slice(1) : slashes}${start}`,
	);
}

export interface ParsedBlock {
	index: number;
	id: string;
	role: string;
	protected: boolean;
	body: string;
}

interface ParsedDocument {
	version: number;
	revision: number;
	documentId: string;
	baselineDigest: string;
	preamble: string;
	blocks: ParsedBlock[];
}

/** Parse structure only; the adapter checks every proposed change against the snapshot. */
export function parseDocument(text: string): { document: ParsedDocument } | { reason: string } {
	const metadata = META_RE.exec(text);
	if (!metadata) {
		return {
			reason: "Empty or headerless context: the first line must be the original [[LIVE_CONTEXT ...]] metadata.",
		};
	}
	const blockRe =
		/^\[\[CTX_TURN document=([a-f0-9]{64}) index=(\d+) role=([A-Za-z][A-Za-z0-9_-]*) id=([a-zA-Z0-9-]+) protected=(true|false)\]\][ \t]*\r?$/gm;
	const matches = [...text.matchAll(blockRe)];
	const validLines = new Set(matches.map((match) => match[0].replace(/\r$/, "")));
	for (const [index, line] of text.split(/\r?\n/).entries()) {
		if (index === 0 || !/^[ \t]*\[\[(?:CTX_TURN|LIVE_CONTEXT)(?=[\s\]]|$)/.test(line)) continue;
		if (!validLines.has(line)) {
			return {
				reason: `Malformed or unescaped structural header on line ${index + 1}. Keep headers intact; prefix quoted structural lines with a backslash.`,
			};
		}
	}

	const seen = new Set<string>();
	const blocks: ParsedBlock[] = [];
	for (const [index, match] of matches.entries()) {
		if (match[1] !== metadata[3]) return { reason: `Block ${match[4]} has a header for a different document.` };
		const ordinal = Number(match[2]);
		if (!Number.isSafeInteger(ordinal)) return { reason: `Invalid header index for block ${match[4]}.` };
		const id = match[4];
		if (seen.has(id)) return { reason: `Duplicate block ID ${id}. Each CTX_TURN ID must appear exactly once.` };
		seen.add(id);
		const headerEnd = match.index + match[0].length;
		const bodyStart = headerEnd + (text[headerEnd] === "\n" ? 1 : 0);
		const next = matches[index + 1];
		let body = text.slice(bodyStart, next?.index ?? text.length);
		// Remove only the framing separator, never significant body whitespace.
		if (next) {
			if (body.endsWith("\r\n\r\n")) body = body.slice(0, -4);
			else if (body.endsWith("\n\n")) body = body.slice(0, -2);
			else if (body.endsWith("\r\n")) body = body.slice(0, -2);
			else if (body.endsWith("\n")) body = body.slice(0, -1);
		}
		blocks.push({ index: ordinal - 1, id, role: match[3], protected: match[5] === "true", body });
	}
	return {
		document: {
			version: Number(metadata[1]),
			revision: Number(metadata[2]),
			documentId: metadata[3],
			baselineDigest: metadata[4],
			preamble: text.slice(metadata[0].length, matches[0]?.index ?? text.length).trim(),
			blocks,
		},
	};
}
