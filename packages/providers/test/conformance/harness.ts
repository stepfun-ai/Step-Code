// Shared scaffolding for the S5-5 dialect conformance fixtures (design §5.13 /
// acceptance condition 6).
//
// The whole point of these fixtures is to prove that a request is dispatched by
// its wire *dialect* (`model.api`) and never by provider identity. So every
// fixture resolves the adapter under test THROUGH the dialect registry
// (`createDialectRegistry` over the live `getApiProvider` lookup) rather than
// importing each adapter's `stream` directly. `getApiProvider` is populated by
// `registerBuiltInApiProviders()`, which runs at compat.ts module load, so
// simply importing from compat here is enough to make the builtins resolvable.
//
// This file is a helper, NOT a `*.test.ts` — it holds no `it()` blocks.

import { expect } from "vitest";
import { getApiProvider } from "../../src/compat.ts";
import { createDialectRegistry, type DialectRegistry } from "../../src/dialect/registry.ts";
import type { ModelApiDialect } from "../../src/dialect/types.ts";
import type { ProviderStreams } from "../../src/types.ts";
import type { AssistantMessageEventStream } from "../../src/utils/event-stream.ts";

/**
 * The adapter shape the fixtures use — the dialect it self-reports plus the
 * stream entry points. Declared explicitly (rather than derived from
 * `getApiProvider`'s return) so this exported helper never leaks compat's
 * internal `ApiProviderInternal` type into its emitted declarations (TS4023).
 */
export interface ConformanceAdapter {
	readonly api: ModelApiDialect;
	readonly stream: ProviderStreams["stream"];
	readonly streamSimple: ProviderStreams["streamSimple"];
}

/**
 * A dialect-keyed registry sourced from the LIVE api -> adapter lookup that
 * already drives dispatch (`compat.ts#getApiProvider`, itself the `byApi` map).
 * `get(api)` therefore selects strictly by `model.api` — never by provider.
 */
export const conformanceRegistry: DialectRegistry<ConformanceAdapter> = createDialectRegistry<ConformanceAdapter>(
	(api) => getApiProvider(api) as unknown as ConformanceAdapter | undefined,
);

/**
 * Resolve the adapter for a dialect through the shared registry, asserting the
 * lookup succeeded AND that the resolved adapter's own declared `api` matches
 * the dispatch key. Returns the adapter so callers can invoke `.stream` /
 * `.streamSimple` exactly as the runtime does.
 */
export function resolveAdapter(api: ModelApiDialect): ConformanceAdapter {
	const adapter = conformanceRegistry.get(api);
	expect(adapter, `no adapter registered for dialect ${api}`).toBeDefined();
	// The resolved adapter must self-report the same dialect it was keyed by:
	// dispatch is by wire protocol, not provider.
	expect((adapter as ConformanceAdapter).api).toBe(api);
	return adapter as ConformanceAdapter;
}

/**
 * Prove protocol dispatch is provider-independent: two models that share a
 * dialect resolve to the *identical* adapter instance regardless of their
 * provider id / baseUrl.
 */
export function expectSharedDispatch(
	a: { api: ModelApiDialect; provider: string; baseUrl?: string },
	b: { api: ModelApiDialect; provider: string; baseUrl?: string },
): ConformanceAdapter {
	expect(a.api).toBe(b.api);
	const adapterA = resolveAdapter(a.api);
	const adapterB = resolveAdapter(b.api);
	// Same object reference from the api-keyed lookup — identity never enters it.
	expect(adapterA).toBe(adapterB);
	return adapterA;
}

/** Drain a stream, returning the canonical event `type`s in emission order. */
export async function collectEventTypes(stream: AssistantMessageEventStream): Promise<string[]> {
	const types: string[] = [];
	for await (const event of stream) {
		types.push(event.type);
	}
	return types;
}

/** Build a `text/event-stream` Response body from raw pre-formatted SSE blocks. */
export function sseResponse(body: string, init?: { status?: number }): Response {
	return new Response(body, {
		status: init?.status ?? 200,
		headers: { "content-type": "text/event-stream" },
	});
}

/**
 * Assemble OpenAI-style `data: <json>\n\n` SSE from a list of event objects.
 * (OpenAI Responses streams carry the discriminant in the JSON `type` field and
 * need no `event:` line — mirrors the existing openai-responses-compat tests.)
 */
export function openAiDataSse(events: unknown[]): string {
	return `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
}

/**
 * Assemble Anthropic-style `event: <name>\ndata: <json>\n` SSE, matching
 * `iterateSseMessages` in anthropic-messages.ts and the existing
 * anthropic-sse-parsing tests.
 */
export function anthropicEventSse(events: Array<{ event: string; data: unknown }>): string {
	return events
		.map(({ event, data }) => `event: ${event}\ndata: ${typeof data === "string" ? data : JSON.stringify(data)}\n`)
		.join("\n");
}

/** A provider JSON error Response (for wire error-normalization fixtures). */
export function jsonErrorResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}
