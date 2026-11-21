import type { McpToolPayload, SearchHit, SearchOutcome, SearchRequest } from "./types.ts";

/** Result count requested from every provider and also the render cap. */
export const SEARCH_RESULT_LIMIT = 10;

export interface SearchAdapter {
	readonly id: string;
	readonly label: string;
	readonly endpoint: string;
	readonly toolName: string;
	readonly transport: "mcp" | "http";
	/** Fixed request headers. None of these providers receive a credential. */
	readonly headers?: Record<string, string>;
	buildRequest(query: string): SearchRequest;
	/** Map a successful payload to normalized hits. Throws only on malformed data. */
	parse(payload: unknown): SearchOutcome;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveNumber(value: unknown): number | undefined {
	const parsed = typeof value === "string" ? Date.parse(value) : typeof value === "number" ? value : Number.NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function hit(record: Record<string, unknown>, snippetKeys: readonly string[]): SearchHit | undefined {
	const url = text(record.url);
	if (!url) return undefined;
	const snippet = snippetKeys.map((key) => text(record[key])).find((value) => value !== undefined);
	const title = text(record.title);
	return {
		url,
		...(title ? { title } : {}),
		...(snippet ? { snippet } : {}),
	};
}

function hitsFrom(records: unknown, snippetKeys: readonly string[]): SearchHit[] {
	if (!Array.isArray(records)) return [];
	const hits: SearchHit[] = [];
	for (const record of records) {
		if (!isRecord(record)) continue;
		const normalized = hit(record, snippetKeys);
		if (normalized) hits.push(normalized);
		if (hits.length >= SEARCH_RESULT_LIMIT) break;
	}
	return hits;
}

/** First text block of a stateless MCP payload. */
function contentText(payload: unknown): string | undefined {
	if (!isRecord(payload)) return undefined;
	const blocks = payload.content;
	if (!Array.isArray(blocks)) return undefined;
	for (const block of blocks) {
		if (isRecord(block) && block.type === "text") {
			const value = text(block.text);
			if (value) return value;
		}
	}
	return undefined;
}

function structured(payload: unknown): unknown {
	return isRecord(payload) ? payload.structuredContent : undefined;
}

function parseJson(value: string | undefined): unknown {
	if (!value) return undefined;
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return undefined;
	}
}

/** Firecrawl: `data.web[]` in structured content, falling back to the JSON text block. */
const firecrawl: SearchAdapter = {
	id: "firecrawl",
	label: "Firecrawl",
	endpoint: "https://mcp.firecrawl.dev/v2/mcp",
	toolName: "firecrawl_search",
	transport: "mcp",
	buildRequest(query) {
		return {
			endpoint: this.endpoint,
			toolName: this.toolName,
			transport: "mcp",
			args: { query, limit: SEARCH_RESULT_LIMIT },
		};
	},
	parse(payload) {
		const fromStructured = readWeb(structured(payload));
		if (fromStructured.length) return { hits: fromStructured };
		const parsed = parseJson(contentText(payload));
		const hits = readWeb(parsed);
		if (hits.length) return { hits };
		const raw = contentText(payload);
		return raw ? { hits: [], text: raw } : { hits: [] };
	},
};

function readWeb(value: unknown): SearchHit[] {
	if (!isRecord(value)) return [];
	const data = isRecord(value.data) ? value.data : undefined;
	return hitsFrom(data?.web, ["description", "content", "snippet"]);
}

/**
 * Exa answers with one text block per result:
 *
 *     Title: ...
 *     URL: https://...
 *     Published: N/A
 *     Highlights:
 *     ...
 *
 * Blocks are separated by a `---` rule. `Published: N/A` means the field is
 * simply absent, not an error.
 */
const exa: SearchAdapter = {
	id: "exa",
	label: "Exa",
	endpoint: "https://mcp.exa.ai/mcp",
	toolName: "web_search_exa",
	transport: "mcp",
	buildRequest(query) {
		return {
			endpoint: this.endpoint,
			toolName: this.toolName,
			transport: "mcp",
			args: { query, numResults: SEARCH_RESULT_LIMIT },
		};
	},
	parse(payload) {
		const raw = contentText(payload);
		if (!raw) return { hits: [] };
		const hits: SearchHit[] = [];
		for (const block of raw.split(/\n\s*---\s*\n/u)) {
			const url = block.match(/^URL:\s*(.+)$/mu)?.[1]?.trim();
			if (!url || url === "N/A") continue;
			const title = block.match(/^Title:\s*(.+)$/mu)?.[1]?.trim();
			const published = block.match(/^Published:\s*(.+)$/mu)?.[1]?.trim();
			const body = block.match(/^(?:Highlights|Text|Summary):\s*\n?([\s\S]*)$/mu)?.[1]?.trim();
			hits.push({
				url,
				...(title && title !== "N/A" ? { title } : {}),
				...(body ? { snippet: body } : {}),
				...(published && published !== "N/A" ? publishedAt(published) : {}),
			});
			if (hits.length >= SEARCH_RESULT_LIMIT) break;
		}
		return hits.length ? { hits } : { hits: [], text: raw };
	},
};

function publishedAt(value: string): { publishedAtMs?: number } {
	const parsed = positiveNumber(value);
	return parsed === undefined ? {} : { publishedAtMs: parsed };
}

/** Parallel: `results[]` in structured content, with excerpts as the snippet. */
const parallel: SearchAdapter = {
	id: "parallel",
	label: "Parallel",
	endpoint: "https://search.parallel.ai/mcp",
	toolName: "web_search",
	transport: "mcp",
	buildRequest(query) {
		return {
			endpoint: this.endpoint,
			toolName: this.toolName,
			transport: "mcp",
			args: { objective: query, search_queries: [query] },
		};
	},
	parse(payload) {
		const fromStructured = readParallel(structured(payload));
		if (fromStructured.length) return { hits: fromStructured };
		const parsed = parseJson(contentText(payload));
		const hits = readParallel(parsed);
		if (hits.length) return { hits };
		const raw = contentText(payload);
		return raw ? { hits: [], text: raw } : { hits: [] };
	},
};

function readParallel(value: unknown): SearchHit[] {
	if (!isRecord(value) || !Array.isArray(value.results)) return [];
	const hits: SearchHit[] = [];
	for (const entry of value.results) {
		if (!isRecord(entry)) continue;
		const url = text(entry.url);
		if (!url) continue;
		const title = text(entry.title);
		const excerpts = Array.isArray(entry.excerpts)
			? entry.excerpts.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
			: [];
		hits.push({
			url,
			...(title ? { title } : {}),
			...(excerpts.length ? { snippet: excerpts.join("\n\n") } : {}),
			...(entry.publish_date ? publishedAt(String(entry.publish_date)) : {}),
		});
		if (hits.length >= SEARCH_RESULT_LIMIT) break;
	}
	return hits;
}

/** TinyFish: JSON inside the text block; the keyless mode needs only the access-mode header. */
const tinyfish: SearchAdapter = {
	id: "tinyfish",
	label: "TinyFish",
	endpoint: "https://agent.tinyfish.ai/mcp",
	toolName: "search",
	transport: "mcp",
	headers: { "X-TinyFish-Access-Mode": "keyless" },
	buildRequest(query) {
		return {
			endpoint: this.endpoint,
			toolName: this.toolName,
			transport: "mcp",
			args: { query },
			headers: this.headers,
		};
	},
	parse(payload) {
		const parsed = parseJson(contentText(payload));
		if (isRecord(parsed)) {
			const hits = hitsFrom(parsed.results, ["snippet", "content", "description"]);
			if (hits.length) return { hits };
		}
		const raw = contentText(payload);
		return raw ? { hits: [], text: raw } : { hits: [] };
	},
};

/** Tavily is a plain JSON endpoint, not MCP. */
const tavily: SearchAdapter = {
	id: "tavily",
	label: "Tavily",
	endpoint: "https://api.tavily.com/search",
	toolName: "search",
	transport: "http",
	headers: { "X-Tavily-Access-Mode": "keyless" },
	buildRequest(query) {
		return {
			endpoint: this.endpoint,
			toolName: this.toolName,
			transport: "http",
			args: {
				query,
				search_depth: "basic",
				chunks_per_source: 3,
				max_results: SEARCH_RESULT_LIMIT,
			},
			headers: this.headers,
		};
	},
	parse(payload) {
		if (!isRecord(payload)) return { hits: [] };
		return { hits: hitsFrom(payload.results, ["content", "snippet", "description"]) };
	},
};

/**
 * Free, credential-less providers. The order here is only the declaration order;
 * `buildSearchChain` shuffles it per call so traffic is spread across providers
 * instead of always consuming the first one's daily allowance.
 */
export const KEYLESS_ADAPTERS: readonly SearchAdapter[] = [exa, firecrawl, tavily, parallel, tinyfish];

export const ADAPTERS: readonly SearchAdapter[] = KEYLESS_ADAPTERS;

/** Look up an adapter by the provider id used in configuration. */
export function findAdapter(id: string): SearchAdapter | undefined {
	return ADAPTERS.find((adapter) => adapter.id === id);
}

export type { McpToolPayload };
