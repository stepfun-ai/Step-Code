/**
 * Answering "which models can this endpoint serve?" for a configuration
 * surface's "fetch available models" action.
 *
 * A provider declared in `models.json` is hand-written or created by a settings
 * page, and either way the user has to fill in a catalog. For an endpoint that
 * advertises its models, asking it beats typing ids by hand.
 *
 * This is a **probe**, not a catalog refresh: the request carries a declaration
 * the user is still editing, nothing is stored, and the reply is candidate
 * metadata the surface offers for adoption. `models.json` stays the only thing
 * that decides what a provider serves.
 *
 * OpenAI-compatible and Anthropic Messages endpoints are read through their
 * native model-listing routes. Every other protocol reports that it cannot be
 * read, so the surface falls back to hand-entry rather than guessing at response
 * fields it has never seen.
 *
 * Nothing here dispatches on a provider's name: the protocol is `api`, which is
 * also the key the adapters themselves dispatch on.
 */

import type { Api } from "./types.ts";

/** Why a probe could not answer. The caller maps these to its own status codes. */
export type ModelDiscoveryCode =
	| "unsupported-api"
	| "invalid-base-url"
	| "unreachable"
	| "aborted"
	| "http"
	| "not-json"
	| "too-large"
	| "no-listing";

export class ModelDiscoveryError extends Error {
	readonly code: ModelDiscoveryCode;
	/** HTTP status when the endpoint itself refused, for a more specific report. */
	readonly status?: number;

	constructor(code: ModelDiscoveryCode, message: string, options: { status?: number; cause?: unknown } = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "ModelDiscoveryError";
		this.code = code;
		if (options.status !== undefined) this.status = options.status;
	}
}

/**
 * Protocols whose model listing this module can read.
 *
 * OpenAI-shaped endpoints list at `GET {base}/models` with bearer auth.
 * Anthropic Messages lists with `x-api-key` and a version header at its own
 * `GET /v1/models`. A protocol absent here is absent on purpose: guessing at an
 * authentication scheme would report a credentials failure as "no models".
 */
const LISTABLE_APIS: ReadonlySet<string> = new Set(["openai-completions", "openai-responses", "anthropic-messages"]);

/** The API assumed when a declaration names none, matching the composer's default. */
export const DEFAULT_DISCOVERY_API = "openai-completions";

/** Stable API version Anthropic's listing route requires. */
const ANTHROPIC_VERSION = "2023-06-01";
/** Largest listing page that route accepts; one page is read, `has_more` is not followed. */
const ANTHROPIC_MODEL_LIMIT = 1000;

/**
 * A reply larger than this is refused rather than truncated: the URL is whatever
 * the user typed, and half a model listing does not parse. Enforced on the bytes
 * actually read, because a server that under-declares its length tells us
 * nothing up front.
 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface DiscoverModelsRequest {
	/** Protocol of the declaration being edited. Defaults to OpenAI Chat Completions. */
	api?: Api | undefined;
	/** Endpoint from the declaration. */
	baseUrl: string;
	/** One-shot credential. When absent the caller may pass a stored key, or none for a keyless endpoint. */
	apiKey?: string | undefined;
	/** Extra headers from the declaration, applied before the auth headers. */
	headers?: Readonly<Record<string, string>> | undefined;
	signal?: AbortSignal | undefined;
	/** Injected for tests; defaults to the global `fetch`. */
	fetch?: typeof fetch | undefined;
}

/** One model the endpoint advertises. */
export interface DiscoveredModel {
	readonly id: string;
	readonly name: string;
	readonly contextWindow?: number;
	readonly maxTokens?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** A positive integer field of a listing entry, or `undefined` when absent or unusable. */
function capacity(...candidates: unknown[]): number | undefined {
	for (const candidate of candidates) {
		if (typeof candidate === "number" && Number.isInteger(candidate) && candidate > 0) return candidate;
	}
	return undefined;
}

/** A non-empty string field of a listing entry, or `undefined`. */
function label(...candidates: unknown[]): string | undefined {
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.length > 0) return candidate;
	}
	return undefined;
}

function nested(value: unknown, key: string): unknown {
	return isRecord(value) ? value[key] : undefined;
}

/**
 * The `baseUrl` a protocol's SDK needs, from the address a user typed.
 *
 * The SDKs append different paths: the OpenAI client requests
 * `{baseUrl}/chat/completions` or `{baseUrl}/responses`, while the Anthropic
 * client requests `{baseUrl}/v1/messages`. Gateway documentation publishes the
 * same service as `https://gw.example` and as `https://gw.example/v1`, so one
 * spelling 404s under each protocol. This maps both spellings to the one the
 * protocol's client expects:
 *
 * - OpenAI protocols: an address with no path gets `/v1`. An address that already
 *   has a path (`/openai/v1`, `/api/v3`, `/api/paas/v4`) names a deployment only
 *   its owner knows and is kept as typed.
 * - Anthropic Messages: one trailing `/v1` is removed, since the client adds it.
 *
 * Trailing slashes are dropped; query and fragment are not expected in a base
 * address and are kept as typed. A value that is not a URL is returned trimmed,
 * for the caller's own validation to reject.
 *
 * This is applied where an address is entered (a settings form saving a
 * declaration, a discovery probe), not on every request: a hand-written
 * `models.json` keeps meaning exactly what it says.
 */
export function normalizeProviderBaseUrl(baseUrl: string, api: string): string {
	const trimmed = baseUrl.trim();
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return trimmed;
	}
	let path = parsed.pathname.replace(/\/+$/u, "");
	if (api === "anthropic-messages") {
		if (path.endsWith("/v1")) path = path.slice(0, -3);
	} else if (path === "") {
		path = "/v1";
	}
	return `${parsed.origin}${path}${parsed.search}${parsed.hash}`;
}

/**
 * Join the configured endpoint with the protocol's listing path.
 *
 * The base is first normalized by {@link normalizeProviderBaseUrl}, then treated
 * as a prefix rather than a URL to resolve against, so a deployment path such as
 * `https://gateway.example/openai/v1` keeps its segments instead of losing them
 * to URL resolution. OpenAI protocols list at `{base}/models`; Anthropic lists at
 * `{base}/v1/models`, the same prefix its client puts before `/messages`.
 */
export function modelListingUrl(baseUrl: string, api: string): string {
	const base = normalizeProviderBaseUrl(baseUrl, api);
	if (api !== "anthropic-messages") return `${base}/models`;
	return `${base}/v1/models?limit=${ANTHROPIC_MODEL_LIMIT}`;
}

/** Read a reply body, refusing one that outgrows {@link MAX_RESPONSE_BYTES}. */
async function readBounded(response: Response, url: string): Promise<string> {
	const oversized = () =>
		new ModelDiscoveryError("too-large", `${url} answered with more than ${MAX_RESPONSE_BYTES} bytes`);
	const declared = Number(response.headers.get("content-length") ?? Number.NaN);
	if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
		await response.body?.cancel().catch(() => {});
		throw oversized();
	}
	if (response.body === null) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_RESPONSE_BYTES) throw oversized();
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(body);
}

/**
 * Read one listing reply.
 *
 * The standard `data` array wins when both supported shapes are present. An
 * enriched `models` map uses each property key as the id the endpoint accepts on
 * requests; its nested `id` is only a fallback for an empty key, because a
 * gateway may put a canonical model identity there instead of the alias. Only
 * object-valued map entries are models — primitive properties are directory
 * metadata.
 *
 * An entry with no usable id is skipped rather than failing the whole reply: one
 * malformed row should not deny the user a working endpoint's catalog. A missing
 * name falls back to the id so every row is displayable.
 */
export function readModelListing(body: unknown): DiscoveredModel[] {
	if (!isRecord(body)) {
		throw new ModelDiscoveryError(
			"no-listing",
			'the reply is not an object with a "data" array or a "models" object; enter this provider\'s models by hand',
		);
	}
	const data = body.data;
	let listed: ReadonlyArray<{ key?: string; raw: unknown }>;
	if (Array.isArray(data)) {
		listed = data.map((raw) => ({ raw }));
	} else if (isRecord(body.models)) {
		listed = Object.entries(body.models)
			.filter(([, raw]) => isRecord(raw))
			.map(([key, raw]) => ({ key, raw }));
	} else {
		throw new ModelDiscoveryError(
			"no-listing",
			'the reply has neither a "data" array nor a "models" object; enter this provider\'s models by hand',
		);
	}
	const models: DiscoveredModel[] = [];
	for (const { key, raw } of listed) {
		const entry = isRecord(raw) ? raw : {};
		const id = label(key, entry.id);
		if (id === undefined) continue;
		const name = label(entry.name, entry.display_name, entry.displayName) ?? id;
		const contextWindow = capacity(
			entry.contextWindow,
			entry.context_window,
			entry.context_length,
			entry.max_input_tokens,
			nested(entry.limit, "context"),
		);
		const maxTokens = capacity(
			entry.maxOutputTokens,
			entry.max_output_tokens,
			entry.maxTokens,
			entry.max_tokens,
			nested(entry.limit, "output"),
			nested(entry.top_provider, "max_completion_tokens"),
		);
		models.push({
			id,
			name,
			...(contextWindow === undefined ? {} : { contextWindow }),
			...(maxTokens === undefined ? {} : { maxTokens }),
		});
	}
	return models;
}

/**
 * Interrogate one endpoint for the models it advertises.
 *
 * @returns the advertised models, in endpoint order.
 * @throws ModelDiscoveryError when the protocol has no readable listing, the URL
 *   is unusable, the endpoint refuses or cannot be reached, or the reply is not
 *   a model listing.
 */
export async function discoverModels(request: DiscoverModelsRequest): Promise<DiscoveredModel[]> {
	const api = request.api ?? DEFAULT_DISCOVERY_API;
	if (!LISTABLE_APIS.has(api)) {
		throw new ModelDiscoveryError(
			"unsupported-api",
			`protocol "${api}" has no model listing this build can read; enter this provider's models by hand`,
		);
	}
	const baseUrl = request.baseUrl.trim();
	if (!baseUrl) throw new ModelDiscoveryError("invalid-base-url", "the API address is required to fetch models");
	let parsed: URL;
	try {
		parsed = new URL(baseUrl);
	} catch {
		throw new ModelDiscoveryError("invalid-base-url", `${baseUrl} is not a valid URL`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new ModelDiscoveryError("invalid-base-url", `${baseUrl} is not an http(s) address`);
	}

	const url = modelListingUrl(baseUrl, api);
	const headers = new Headers(request.headers === undefined ? undefined : Object.entries(request.headers));
	headers.set("accept", "application/json");
	const apiKey = request.apiKey?.trim();
	if (api === "anthropic-messages") {
		headers.set("anthropic-version", ANTHROPIC_VERSION);
		if (apiKey) {
			headers.set("x-api-key", apiKey);
			// Anthropic-compatible gateways (e.g. StepFun) accept `x-api-key` on
			// /messages but only Bearer on /models, so send both schemes.
			if (!headers.has("authorization")) headers.set("authorization", `Bearer ${apiKey}`);
		}
	} else if (apiKey) {
		headers.set("authorization", `Bearer ${apiKey}`);
	}

	const fetchFn = request.fetch ?? fetch;
	let response: Response;
	try {
		response = await fetchFn(url, {
			method: "GET",
			headers,
			...(request.signal === undefined ? {} : { signal: request.signal }),
		});
	} catch (error) {
		if (request.signal?.aborted) {
			throw new ModelDiscoveryError("aborted", "model discovery was cancelled", { cause: error });
		}
		throw new ModelDiscoveryError("unreachable", `could not reach ${url}`, { cause: error });
	}
	if (!response.ok) {
		const hint = response.status === 401 || response.status === 403 ? "; check the API key" : "";
		throw new ModelDiscoveryError("http", `${url} answered ${response.status}${hint}`, { status: response.status });
	}

	let text: string;
	try {
		text = await readBounded(response, url);
	} catch (error) {
		if (request.signal?.aborted) {
			throw new ModelDiscoveryError("aborted", "model discovery was cancelled", { cause: error });
		}
		throw error;
	}
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch (error) {
		throw new ModelDiscoveryError("not-json", `${url} did not answer with JSON`, { cause: error });
	}
	return readModelListing(body);
}
