/**
 * Tool discovery: a BM25 ranker over tool metadata for the model-facing tool finder.
 *
 * The finder ranks the tools that are registered but not declared to the model and activates the
 * matches, so the next model call declares them. Activation goes through the active tool set, so
 * it is recorded in the transcript like any other tool change and survives resume and fork.
 */
import type { ToolInfo } from "../extensions/types.ts";

export const DEFAULT_TOOL_SEARCH_LIMIT = 8;

/** The part of the host tool set the finder needs, kept narrow so it is testable without a session. */
export interface ToolSearchCatalog {
	getActiveTools(): string[];
	getAllTools(): ToolInfo[];
	setActiveTools(toolNames: string[]): void;
}

export interface ToolSearchResult {
	name: string;
	description: string;
}

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

const STOP_WORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"by",
	"for",
	"from",
	"in",
	"is",
	"it",
	"of",
	"on",
	"or",
	"that",
	"the",
	"this",
	"to",
	"with",
]);

/** Naive singular form, so `issues` matches `issue` and `searches` matches `search`. */
function stem(term: string): string {
	if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
	if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2);
	if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
	return term;
}

/** Unicode word segmentation with identifier boundaries, English stop words, and singular forms. */
export function tokenize(text: string): string[] {
	const normalized = text
		.normalize("NFC")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.toLowerCase()
		.replace(/[^\p{L}\p{M}\p{N}]+/gu, " ");
	// The segmenter costs about 15 times a split. Plain ASCII splits into the same words at spaces, so only other
	// text, such as Chinese written without spaces, goes through it.
	const words = /^[a-z0-9 ]*$/.test(normalized)
		? normalized.split(" ")
		: Array.from(wordSegmenter.segment(normalized), (segment) => (segment.isWordLike ? segment.segment : ""));
	return words
		.filter((word) => word.length > 0 && !STOP_WORDS.has(word))
		.map((word) => (/^[a-z0-9]+$/.test(word) ? stem(word) : word));
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Schema descriptions and property names, recursively. */
function schemaText(schema: unknown, parts: string[]): void {
	if (!isObject(schema)) return;
	if (typeof schema.description === "string") parts.push(schema.description);
	if (isObject(schema.properties)) {
		for (const [name, property] of Object.entries(schema.properties)) {
			parts.push(name);
			schemaText(property, parts);
		}
	}
	schemaText(schema.items, parts);
	for (const key of ["anyOf", "oneOf", "allOf"]) {
		const variants = schema[key];
		if (Array.isArray(variants)) for (const variant of variants) schemaText(variant, parts);
	}
}

/** Search text of a tool: its description and its schema descriptions and property names. */
export function createToolSearchDocument(tool: Pick<ToolInfo, "name" | "description" | "parameters">): {
	name: string;
	text: string;
} {
	const parts = [tool.description];
	schemaText(tool.parameters, parts);
	return { name: tool.name, text: parts.filter((part) => part.trim()).join(" ") };
}

/** Lowercase with characters invalid in script identifiers as `_`, so `dev-radius` matches `dev_radius`. */
function normalizeName(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_$]/g, "_");
}

/**
 * Whether the whole query is the tool's name: its full name or a suffix after a `__` separator, so
 * `thread_read` and `app__thread_read` both name `mcp__app__thread_read`.
 */
function isExactNameQuery(query: string, name: string): boolean {
	const normalized = normalizeName(name);
	return normalized === query || normalized.endsWith(`__${query}`);
}

interface IndexedDocument {
	name: string;
	nameTerms: Set<string>;
	localNameTerms: string[];
	textCounts: Map<string, number>;
	textLength: number;
}

function indexDocument(document: { name: string; text: string }): IndexedDocument {
	const textCounts = new Map<string, number>();
	for (const term of tokenize(document.text)) textCounts.set(term, (textCounts.get(term) ?? 0) + 1);
	const segments = document.name.split("__");
	return {
		name: document.name,
		nameTerms: new Set(tokenize(document.name)),
		localNameTerms: [...new Set(tokenize(segments[segments.length - 1]))],
		textCounts,
		textLength: [...textCounts.values()].reduce((sum, count) => sum + count, 0),
	};
}

/**
 * A query term in the name counts this many times its IDF. The text part of a term is at most
 * `k1 + 1` (2.2) times its IDF and about 1 for a single mention, so a name match beats any number of
 * mentions in the description.
 */
const NAME_WEIGHT = 3;

export interface ScoredDocument {
	name: string;
	score: number;
}

/**
 * Okapi BM25 over the description, with the name as a separate field:
 * - a tool that matches more of the query's terms, in any field, ranks above one that matches
 *   fewer, whatever their scores: for `screenshot window`, a tool whose description has both words
 *   beats `window`, whose name has one;
 * - a query term in the name scores more than any number of mentions in the description;
 * - a tool whose whole local name is in the query (`app` in `peekaboo app` for
 *   `mcp__peekaboo__app`) gets a bonus worth one more match of every query term, so among tools
 *   matching as many terms it mostly wins over tools that only mention the words;
 * - a query that is exactly a tool's name ranks that tool first, before coverage.
 *
 * The description alone is length-normalized, so a long name does not lower a tool's score. Ties
 * keep document order.
 */
export class Bm25Ranker {
	private readonly k1: number;
	private readonly b: number;

	constructor(options: { k1?: number; b?: number } = {}) {
		this.k1 = options.k1 ?? 1.2;
		this.b = options.b ?? 0.75;
	}

	rank(query: string, documents: readonly { name: string; text: string }[], limit: number): ScoredDocument[] {
		const queryTerms = new Set(tokenize(query));
		if (queryTerms.size === 0 || documents.length === 0 || limit <= 0) return [];
		const indexed = documents.map(indexDocument);
		const averageLength = indexed.reduce((sum, document) => sum + document.textLength, 0) / indexed.length || 1;
		const idf = new Map(
			[...queryTerms].map((term) => {
				const frequency = indexed.filter(
					(document) => document.nameTerms.has(term) || document.textCounts.has(term),
				).length;
				return [term, Math.log(1 + (indexed.length - frequency + 0.5) / (frequency + 0.5))];
			}),
		);
		const fullNameBonus = [...idf.values()].reduce((sum, value) => sum + value, 0);
		const exactQuery = normalizeName(query);
		const matches: { name: string; score: number; covered: number; exact: boolean }[] = [];
		for (const document of indexed) {
			const norm = this.k1 * (1 - this.b + (this.b * document.textLength) / averageLength);
			let score = 0;
			let covered = 0;
			for (const term of queryTerms) {
				const count = document.textCounts.get(term) ?? 0;
				const weight = (document.nameTerms.has(term) ? NAME_WEIGHT : 0) + (count * (this.k1 + 1)) / (count + norm);
				if (weight > 0) covered++;
				score += (idf.get(term) ?? 0) * weight;
			}
			if (score === 0) continue;
			const local = document.localNameTerms;
			if (local.length > 0 && local.every((term) => queryTerms.has(term))) score += fullNameBonus;
			matches.push({ name: document.name, score, covered, exact: isExactNameQuery(exactQuery, document.name) });
		}
		return matches
			.sort((a, b) => Number(b.exact) - Number(a.exact) || b.covered - a.covered || b.score - a.score)
			.slice(0, limit)
			.map(({ name, score }) => ({ name, score }));
	}
}

/**
 * Rank the deferred tools that are not declared yet, and activate the matches. Hidden tools and
 * tools that are already active are never candidates.
 */
export function searchAndLoad(catalog: ToolSearchCatalog, query: string, limit: number): ToolInfo[] {
	const active = catalog.getActiveTools();
	const declared = new Set(active);
	const candidates = catalog.getAllTools().filter((tool) => tool.exposure === "deferred" && !declared.has(tool.name));
	const matches = new Bm25Ranker().rank(query, candidates.map(createToolSearchDocument), limit);
	if (matches.length === 0) return [];
	catalog.setActiveTools([...active, ...matches.map((match) => match.name)]);
	const byName = new Map(candidates.map((tool) => [tool.name, tool]));
	return matches.map((match) => byName.get(match.name)!).filter(Boolean);
}
