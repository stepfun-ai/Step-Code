import { invokeRemoteMcpTool, type RemoteMcpToolResult } from "../mcp-client.ts";
import { STEPCODE_VERSION } from "../version.ts";
import { classifyFailure, parseRetryAfter } from "./errors.ts";
import type { McpToolPayload, SearchAttempt, SearchFailure, SearchOutcome, SearchRequest } from "./types.ts";

/** Response bodies above this size are rejected instead of buffered in full. */
export const MAX_SEARCH_RESPONSE_BYTES = 1024 * 1024;

/** Time allowed for one candidate before the chain moves on. */
export const SEARCH_ATTEMPT_TIMEOUT_MS = 8_000;

/** Time allowed for the whole chain, including every fallback. */
export const SEARCH_TOTAL_BUDGET_MS = 25_000;

/**
 * Provider endpoints apply their own bot filtering, and at least one rejects
 * generic HTTP-library user agents outright. Identify the product on every call.
 */
function userAgent(): string {
	return `StepCode/${STEPCODE_VERSION.value}`;
}

function requestHeaders(request: SearchRequest): Record<string, string> {
	return {
		"User-Agent": userAgent(),
		Accept: "application/json, text/event-stream",
		"Content-Type": "application/json",
		...request.headers,
	};
}

type Fetched = { payload: unknown } | { failure: SearchFailure };

interface JsonRpcEnvelope {
	result?: McpToolPayload;
	error?: { code: number; message: string };
}

function parseJson(raw: string): unknown {
	const trimmed = raw.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return undefined;
	}
}

function asEnvelope(value: unknown): JsonRpcEnvelope | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.error === "object" && record.error !== null) {
		const detail = record.error as Record<string, unknown>;
		return {
			error: {
				code: typeof detail.code === "number" ? detail.code : -1,
				message: typeof detail.message === "string" ? detail.message : "unknown JSON-RPC error",
			},
		};
	}
	if (typeof record.result === "object" && record.result !== null) {
		return { result: record.result as McpToolPayload };
	}
	return undefined;
}

/**
 * Read a JSON-RPC envelope from either a plain JSON body or an SSE stream.
 * The stream form is what MCP servers negotiate by default, so both are needed.
 */
function readEnvelope(body: string, contentType: string | null): JsonRpcEnvelope | undefined {
	const direct = asEnvelope(parseJson(body));
	if (direct) return direct;
	if (contentType?.includes("text/event-stream") || body.includes("data: ")) {
		for (const line of body.split("\n")) {
			if (!line.startsWith("data: ")) continue;
			const parsed = asEnvelope(parseJson(line.slice(6)));
			if (parsed) return parsed;
		}
	}
	return undefined;
}

/**
 * Build the request body. MCP candidates need a JSON-RPC `tools/call` envelope;
 * sending the bare arguments is rejected as a parse error. Tavily is a plain
 * JSON endpoint and takes the arguments directly.
 */
function requestBody(request: SearchRequest): string {
	if (request.transport === "http") return JSON.stringify(request.args);
	return JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: { name: request.toolName, arguments: request.args },
	});
}

async function fetchOnce(
	request: SearchRequest,
	timeoutMs: number,
	callerSignal: AbortSignal | undefined,
): Promise<Fetched> {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
	const cancelled = () => callerSignal?.aborted === true;

	let response: Response;
	try {
		response = await fetch(request.endpoint, {
			method: "POST",
			headers: requestHeaders(request),
			body: requestBody(request),
			signal,
		});
	} catch (error) {
		return {
			failure: classifyFailure({
				networkError: error instanceof Error ? error.message : String(error),
				cancelled: cancelled(),
			}),
		};
	}

	const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
	let body: string;
	try {
		body = await response.text();
	} catch (error) {
		return {
			failure: classifyFailure({
				status: response.status,
				networkError: error instanceof Error ? error.message : String(error),
				cancelled: cancelled(),
			}),
		};
	}
	if (Buffer.byteLength(body, "utf8") > MAX_SEARCH_RESPONSE_BYTES) {
		return {
			failure: {
				kind: "parse",
				status: response.status,
				detail: `response exceeded ${MAX_SEARCH_RESPONSE_BYTES} bytes`,
			},
		};
	}

	if (request.transport === "http") {
		if (!response.ok) {
			return {
				failure: classifyFailure({ status: response.status, text: body, retryAfterMs }),
			};
		}
		const payload = parseJson(body);
		return payload === undefined
			? { failure: { kind: "parse", status: response.status, detail: body.slice(0, 500) || "empty response" } }
			: { payload };
	}

	const envelope = readEnvelope(body, response.headers.get("content-type"));
	if (!envelope) {
		return {
			failure: classifyFailure({
				status: response.status,
				text: body.slice(0, 500) || `HTTP ${response.status} without a JSON-RPC response`,
				retryAfterMs,
			}),
		};
	}
	if (envelope.error) {
		const failure = classifyFailure({
			status: response.status,
			jsonrpcError: envelope.error,
			text: envelope.error.message,
			retryAfterMs,
		});
		// Some servers refuse a stateless call and only answer after `initialize`.
		// That is a protocol mismatch, not a provider outage, so the caller may
		// retry the same candidate once with a handshake. An auth or quota failure
		// carrying the same envelope is a real answer: retrying it would only
		// double the latency.
		const retryable = failure.kind === "unsupported" || failure.kind === "unknown";
		return { failure: retryable ? { ...failure, handshakeFallback: true } : failure };
	}
	const payload = envelope.result ?? {};
	if (payload.isError === true) {
		const detail = payload.content?.find((block) => block.type === "text")?.text ?? "search request failed";
		// The provider's own verdict outranks the status it arrived with: several
		// answer 200 and report a quota or auth problem in the body. The status and
		// Retry-After still travel with the failure so a rate limiter that reports
		// through the body keeps its own backoff.
		return {
			failure: classifyFailure({ text: detail, isError: true, status: response.status, retryAfterMs }),
		};
	}
	return { payload };
}

/**
 * One search against one candidate.
 *
 * Free providers are called with a single stateless `tools/call`, skipping the
 * MCP handshake and catalog listing that the StepFun endpoint performs: those
 * two round trips were the bulk of a short search's latency. A provider that
 * refuses the stateless form is retried once through the SDK client.
 */
/**
 * The SDK client reports `content` as one joined string, while the adapters read
 * the MCP block list. Convert instead of handing over a shape they cannot read:
 * a string there would parse as "no results" and end the chain on a false empty
 * answer.
 */
function fromRemoteMcpResult(result: RemoteMcpToolResult): McpToolPayload {
	return {
		...(result.isError === true ? { isError: true } : {}),
		...(result.content ? { content: [{ type: "text", text: result.content }] } : {}),
		...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
	};
}

export async function callSearchProvider(input: {
	request: SearchRequest;
	parse: (payload: unknown) => SearchOutcome;
	timeoutMs: number;
	signal?: AbortSignal;
	allowHandshake: boolean;
	serverName: string;
}): Promise<SearchAttempt> {
	const { request, signal, timeoutMs } = input;
	signal?.throwIfAborted();

	const fetched = await fetchOnce(request, timeoutMs, signal);
	if ("payload" in fetched) {
		try {
			return { ok: true, outcome: input.parse(fetched.payload) };
		} catch (error) {
			return {
				ok: false,
				failure: {
					kind: "parse",
					detail: error instanceof Error ? error.message : String(error),
				},
			};
		}
	}

	if (!input.allowHandshake || fetched.failure.handshakeFallback !== true || signal?.aborted) {
		return { ok: false, failure: fetched.failure };
	}

	try {
		const result = await invokeRemoteMcpTool({
			serverName: input.serverName,
			serverUrl: request.endpoint,
			toolName: request.toolName,
			arguments: request.args,
			headers: request.headers,
			timeoutMs,
			signal,
		});
		if (result.isError) {
			return {
				ok: false,
				failure: classifyFailure({
					text: result.content ?? "search request failed",
					isError: true,
					cancelled: signal?.aborted === true,
				}),
			};
		}
		try {
			return { ok: true, outcome: input.parse(fromRemoteMcpResult(result)) };
		} catch (error) {
			return {
				ok: false,
				failure: { kind: "parse", detail: error instanceof Error ? error.message : String(error) },
			};
		}
	} catch (error) {
		return {
			ok: false,
			failure: classifyFailure({
				networkError: error instanceof Error ? error.message : String(error),
				cancelled: signal?.aborted === true,
			}),
		};
	}
}
